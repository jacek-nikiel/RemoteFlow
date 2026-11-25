import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  KeyRound,
  Download,
  ShieldCheck,
  Volume2,
  Check,
  RefreshCw,
  Maximize2,
  Minimize2,
  Loader2,
  ZoomIn,
  Tv,
  FolderSync,
  FileUp,
  X,
  Activity,
} from 'lucide-react';
import '@devolutions/iron-remote-desktop';
import { ConfigBuilder, UserInteraction } from '@devolutions/iron-remote-desktop';
import {
  Backend,
  enableCredssp,
  displayControl,
  RdpFileTransferProvider,
  DroppedFile,
  FileInfo,
} from '@devolutions/iron-remote-desktop-rdp';
import { SessionInfo } from '../../types';
import { api, isTauri, isWindowsHost } from '../../services/api';
import { formatBytes } from '../../utils/formatBytes';
import { listen } from '@tauri-apps/api/event';
import { useT } from '../../i18n';
import { rdpPixelRatio, rdpScaleFactor, screenScale } from '../../utils/rdpDisplay';
import { numLockFromEvent, trackNumLock } from '../../utils/rdpLockKeys';
import { RdpStatsPanel } from './RdpStatsPanel';
import { ensureRdpInitialized, hostPort } from './rdp/engine';
import { FilesClipboardDrawer } from './rdp/FilesClipboardDrawer';
import { KeySequenceMenu } from './rdp/KeySequenceMenu';
import { RdpConnectingOverlay, RdpErrorOverlay } from './rdp/RdpOverlays';
import {
  applyCanvasStyle,
  applyShadowRootScalingOverrides,
  getDimensionsForPreset,
  RemoteSize,
  RESOLUTION_PRESETS,
  noteRequestedSize,
  remoteDesktopSize,
  sendRemoteSize,
  autoSizeFromArea,
} from './rdp/layout';

/** Remote -> local clipboard copies above this size are not downloaded automatically. */
const REMOTE_CLIP_AUTO_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GiB


interface Props {
  session: SessionInfo;
  isActive: boolean;
}

export const RdpViewer: React.FC<Props> = ({ session, isActive }) => {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  const userInteractionRef = useRef<UserInteraction | null>(null);
  const rdpWasmSessionRef = useRef<any>(null);
  const fileTransferProviderRef = useRef<RdpFileTransferProvider | null>(null);
  const lastSyncedTextRef = useRef<string>('');
  const lastSyncedFilesKeyRef = useRef<string>('');
  const hasStagedUploadRef = useRef<boolean>(false);
  const stagedDroppedFilesRef = useRef<DroppedFile[]>([]);
  const lastAppliedResRef = useRef<RemoteSize | null>(null);
  // Throttling of focus-triggered clipboard sync (each sync may reach the OS clipboard)
  const clipboardSyncInFlightRef = useRef<boolean>(false);
  // "Clipboard" in the connection's RDP settings: when off, nothing is exchanged with the remote
  // clipboard (text or files) in either direction.
  const clipboardAllowed = session.rdpSettings?.clipboard !== false;
  const clipboardAllowedRef = useRef(clipboardAllowed);
  clipboardAllowedRef.current = clipboardAllowed;
  const clipboardSyncPendingRef = useRef<boolean>(false);
  const lastClipboardSyncAtRef = useRef<number>(0);
  // Last error reported by the local Rust RDP proxy (more precise than the WASM client's error)
  const lastProxyErrorRef = useRef<string | null>(null);
  // Windows: local clipboard sequence number seen at the last sync (detects every new copy,
  // even of identical content, and ignores changes made by RemoteFlow itself)
  const lastLocalClipSeqRef = useRef<number | null>(null);
  const markOwnLocalClipboardWrite = useCallback(async () => {
    const seq = await api.clipboardSequence();
    if (seq != null) lastLocalClipSeqRef.current = seq;
  }, []);

  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');
  const [statusMessage, setStatusMessage] = useState<string>(t('Nawiązywanie połączenia RDP...'));
  // Login exactly as sent to the server (user name and domain are normalised by the backend)
  const rdpLogin = session.rdpDomain ? `${session.rdpDomain}\\${session.username}` : session.username;
  const [copiedPassword, setCopiedPassword] = useState(false);
  const [clipboardFeedback, setClipboardFeedback] = useState<string | null>(null);
  const [isLaunchingExternal, setIsLaunchingExternal] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [scaleMode, setScaleMode] = useState<'fit' | 'real'>('fit');
  const scaleModeRef = useRef(scaleMode);
  scaleModeRef.current = scaleMode;
  const canvasObserverRef = useRef<MutationObserver | null>(null);
  /** Re-applies the pixel-exact canvas size (high-DPI) after any change of sizes or mode. */
  const refreshCanvasStyle = useCallback(() => {
    applyCanvasStyle(elementRef.current?.shadowRoot, containerRef.current?.getBoundingClientRect(), scaleModeRef.current);
  }, []);
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  const [isStatsOpen, setIsStatsOpen] = useState(false);

  // Unified Clipboard & File Transfer Drawer
  const [isClipboardDrawerOpen, setIsClipboardDrawerOpen] = useState(false);
  const [clipboardDraft, setClipboardDraft] = useState('');
  const [remoteClipboardText, setRemoteClipboardText] = useState<string>('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSavingFiles, setIsSavingFiles] = useState(false);

  // Native RDP File Transfer states (CLIPRDR)
  const [stagedUploadNames, setStagedUploadNames] = useState<string[]>([]);
  const [uploadProgressText, setUploadProgressText] = useState<string | null>(null);
  const [remoteAvailableFiles, setRemoteAvailableFiles] = useState<FileInfo[]>([]);
  const [isDownloadingRemoteFiles, setIsDownloadingRemoteFiles] = useState(false);

  // Local folder/file browser inside RDP drawer for 1-click recursive folder sending
  const [isLocalBrowserOpen, setIsLocalBrowserOpen] = useState(false);
  const localPathRef = useRef('');

  const showToast = useCallback((msg: string, duration = 3000) => {
    setClipboardFeedback(msg);
    setTimeout(() => setClipboardFeedback(null), duration);
  }, []);

  const focusRdpCanvas = useCallback(() => {
    try {
      const canvas = elementRef.current?.shadowRoot?.querySelector('canvas#renderer') as HTMLElement | null;
      if (canvas) {
        canvas.focus({ preventScroll: true });
      }
    } catch {}
  }, []);

  // Send text directly to WASM RDP Session clipboard (bypasses broken browser navigator.clipboard.read)
  const handleSendCustomTextToRemote = useCallback(async (text: string, notify = true) => {
    if (!text) return false;
    try {
      const wasmSession = rdpWasmSessionRef.current;
      if (wasmSession && typeof wasmSession.onClipboardPaste === 'function') {
        const clipData = new Backend.ClipboardData();
        clipData.addText('text/plain', text);
        await wasmSession.onClipboardPaste(clipData);
        lastSyncedTextRef.current = text;
        hasStagedUploadRef.current = false;
        stagedDroppedFilesRef.current = [];
        setStagedUploadNames([]);
        if (notify) {
          showToast(t('Wysłano tekst do schowka Windows RDP'));
        }
        return true;
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd wysyłania tekstu do sesji RDP:', err);
    }
    return false;
  }, [showToast]);

  // Clear clipboard content, staged files, and draft text
  const handleClearClipboard = useCallback(async () => {
    setClipboardDraft('');
    setRemoteClipboardText('');
    lastSyncedTextRef.current = '';
    hasStagedUploadRef.current = false;
    stagedDroppedFilesRef.current = [];
    setStagedUploadNames([]);
    setRemoteAvailableFiles([]);

    const provider = fileTransferProviderRef.current;
    if (provider) {
      try {
        (provider as any).uploadState = undefined;
        (provider as any).retainedFiles = undefined;
      } catch {}
    }

    try {
      await api.clipboardWriteText('');
      await markOwnLocalClipboardWrite();
      const wasmSession = rdpWasmSessionRef.current;
      if (wasmSession && typeof wasmSession.onClipboardPaste === 'function') {
        await wasmSession.onClipboardPaste(new Backend.ClipboardData());
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd czyszczenia schowka:', err);
    }
    showToast(t('Wyczyszczono schowek RDP i listę plików'));
  }, [showToast]);

  // Stage DroppedFile[] into Windows RDP Clipboard via RdpFileTransferProvider
  const stageDroppedFilesToRdpClipboard = useCallback(async (droppedFiles: DroppedFile[]) => {
    if (!droppedFiles || droppedFiles.length === 0) return;
    const provider = fileTransferProviderRef.current;
    if (!provider) {
      showToast(t('Sesja RDP nie jest jeszcze gotowa do transferu plików'));
      return;
    }

    try {
      // Remember the local text present while staging, so the next focus-sync does not replace
      // the staged files with that (old) text.
      try {
        const currentText = await api.clipboardReadText();
        if (currentText) lastSyncedTextRef.current = currentText;
      } catch {}

      // Clear any previous unfinished upload state so re-staging never throws "Upload already in progress"
      (provider as any).uploadState = undefined;
      hasStagedUploadRef.current = true;
      stagedDroppedFilesRef.current = droppedFiles;

      const rootNames = Array.from(
        new Set(
          droppedFiles.map((df) => (df.path ? df.path.split('\\')[0] : df.name))
        )
      );
      setStagedUploadNames(rootNames);

      const { completion } = provider.uploadFiles(droppedFiles);
      focusRdpCanvas();
      showToast(
        t('Gotowe! Wciśnij Ctrl+V (lub prawy przycisk -> Wklej) w Windows, aby wkleić: {p0}', { p0: rootNames.slice(0, 2).join(', ') }),
        5500
      );

      completion
        .then(() => {
          setUploadProgressText(null);
          showToast(t('Zakończono wklejanie plików w systemie Windows!'), 3500);
        })
        .catch((err) => {
          console.warn('[RemoteFlow RDP] Upload completion warning:', err);
          setUploadProgressText(null);
        });
    } catch (err: any) {
      console.error('[RemoteFlow RDP] Błąd przygotowania plików w schowku RDP:', err);
      showToast(t('Błąd transferu: {p0}', { p0: err?.message || err }));
    }
  }, [focusRdpCanvas, showToast]);

  // Read local paths (files or entire folders recursively) via Rust and stage them into Windows RDP Clipboard + ~/RemoteFlow_Shared
  const stageLocalPathsToRdpClipboard = useCallback(async (localPaths: string[]) => {
    if (!localPaths || localPaths.length === 0) return;
    setIsSavingFiles(true);
    try {
      const entries = await api.readLocalPathsForRdpClipboard(localPaths);
      if (entries.length === 0) {
        showToast(t('Nie znaleziono plików do przesłania'));
        return;
      }

      const droppedFiles: DroppedFile[] = entries.map((ent) => {
        if (ent.isDirectory || !ent.contentBase64) {
          return {
            file: null,
            name: ent.name,
            size: 0,
            lastModified: ent.lastModified || Date.now(),
            path: ent.path || undefined,
            isDirectory: true,
          };
        }
        const binaryString = atob(ent.contentBase64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const fileObj = new window.File([bytes], ent.name, {
          lastModified: ent.lastModified || Date.now(),
        });
        return {
          file: fileObj,
          name: ent.name,
          size: ent.size,
          lastModified: ent.lastModified || Date.now(),
          path: ent.path || undefined,
          isDirectory: false,
        };
      });

      await stageDroppedFilesToRdpClipboard(droppedFiles);
      setIsLocalBrowserOpen(false);
    } catch (err: any) {
      console.error('[RemoteFlow RDP] Błąd odczytu ścieżek lokalnych:', err);
      showToast(t('Błąd odczytu plików: {p0}', { p0: err?.message || err }));
    } finally {
      setIsSavingFiles(false);
    }
  }, [stageDroppedFilesToRdpClipboard, showToast]);

  // Download files copied in Windows (Ctrl+C in Windows Explorer) to local shared/download folder (same as SSH & SFTP)
  const handleDownloadRemoteFiles = async () => {
    const provider = fileTransferProviderRef.current;
    if (!provider || remoteAvailableFiles.length === 0) return;

    setIsDownloadingRemoteFiles(true);
    let savedCount = 0;
    try {
      // Determine target exchange directory (matching SSH/SFTP and global settings)
      let exchangeDir: string | undefined = undefined;
      try {
        const vault = await api.getVaultData();
        const conn = vault.connections.find((c) => c.id === session.connectionId);
        if (conn?.defaultDownloadDir) {
          exchangeDir = conn.defaultDownloadDir;
        }
      } catch (err) {
        console.warn('Nie udało się pobrać konfiguracji katalogu wymiany:', err);
      }

      for (let i = 0; i < remoteAvailableFiles.length; i++) {
        const fileInfo = remoteAvailableFiles[i];
        if (fileInfo.isDirectory) continue;

        const { completion } = provider.downloadFile(fileInfo, i);
        const blob = await completion;
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let j = 0; j < bytes.byteLength; j++) {
          binary += String.fromCharCode(bytes[j]);
        }
        const b64 = btoa(binary);
        const relName = fileInfo.path ? `${fileInfo.path}\\${fileInfo.name}` : fileInfo.name;
        await api.saveDroppedFileToShared(relName, b64, session.connectionId);
        savedCount++;
      }

      const destLabel = exchangeDir || t('katalogu pobierania');
      showToast(t('Pobrano z Windows plików: {n}, zapisano w: {dest}', { n: savedCount, dest: destLabel }), 4500);
      setRemoteAvailableFiles([]);
    } catch (err: any) {
      console.error('[RemoteFlow RDP] Błąd pobierania plików z Windows:', err);
      showToast(t('Błąd pobierania plików z Windows: {p0}', { p0: err?.message || err }));
    } finally {
      setIsDownloadingRemoteFiles(false);
    }
  };

  // Open shared exchange folder locally
  const handleOpenSharedFolder = async () => {
    try {
      let exchangeDir: string | undefined = undefined;
      try {
        const vault = await api.getVaultData();
        const conn = vault.connections.find((c) => c.id === session.connectionId);
        exchangeDir = conn?.defaultDownloadDir || undefined;
      } catch {}
      const path = await api.openSharedFolder(exchangeDir);
      showToast(t('Otwarto folder lokalny: {path}', { path }), 3500);
    } catch (err: any) {
      console.error('Błąd otwierania folderu wymiany:', err);
    }
  };

  // Drag and Drop files or directories onto RDP viewer
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    // 1. Check if local file/directory URIs were dropped from Linux file manager
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      const paths = uriList
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('file://'))
        .map((l) => decodeURIComponent(l.replace('file://', '')));
      if (paths.length > 0) {
        await stageLocalPathsToRdpClipboard(paths);
        return;
      }
    }

    // 2. Use RdpFileTransferProvider.handleDrop (supports webkitGetAsEntry recursive folders)
    const provider = fileTransferProviderRef.current;
    if (provider) {
      setIsSavingFiles(true);
      try {
        const dropped = await provider.handleDrop(e.nativeEvent);
        if (dropped.length > 0) {
          for (const df of dropped) {
            if (!df.isDirectory && df.file) {
              try {
                const buf = await df.file.arrayBuffer();
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let j = 0; j < bytes.byteLength; j++) {
                  binary += String.fromCharCode(bytes[j]);
                }
                const rel = df.path ? `${df.path}\\${df.name}` : df.name;
                await api.saveDroppedFileToShared(rel, btoa(binary));
              } catch {}
            }
          }
          await stageDroppedFilesToRdpClipboard(dropped);
          setIsSavingFiles(false);
          return;
        }
      } catch (err) {
        console.warn('[RemoteFlow RDP] provider.handleDrop fallback:', err);
      } finally {
        setIsSavingFiles(false);
      }
    }
  };

  // Resolution always starts in "Auto" mode (fit to the tab); a fixed preset can still be chosen manually.
  const [selectedResolution, setSelectedResolution] = useState<string>('auto');

  // Synchronize local Linux clipboard -> Remote Windows session
  const syncLocalClipboardToRemote = useCallback(async (force = false) => {
    if (!clipboardAllowedRef.current) return;
    if (!force) {
      if (clipboardSyncInFlightRef.current) {
        // A sync is running – run once more afterwards so a copy made meanwhile is not missed.
        clipboardSyncPendingRef.current = true;
        return;
      }
      const now = Date.now();
      if (now - lastClipboardSyncAtRef.current < 300) return;
      lastClipboardSyncAtRef.current = now;
    }
    clipboardSyncInFlightRef.current = true;
    try {
      // 0. Windows: nothing new was copied locally since the last sync -> keep the remote clipboard
      //    as it is (e.g. files/text copied inside the remote session must not be overwritten).
      let localChanged = false;
      const seq = await api.clipboardSequence();
      if (seq != null) {
        if (!force && seq === lastLocalClipSeqRef.current) return;
        localChanged = seq !== lastLocalClipSeqRef.current;
        lastLocalClipSeqRef.current = seq;
      }

      // 1. Files/folders copied in the local file manager (Explorer / Dolphin / Nautilus)
      const clipFiles = await api.clipboardReadFiles();
      if (clipFiles.length > 0) {
        const filesKey = clipFiles.join('|');
        if (force || localChanged || filesKey !== lastSyncedFilesKeyRef.current) {
          lastSyncedFilesKeyRef.current = filesKey;
          await stageLocalPathsToRdpClipboard(clipFiles);
          // the local clipboard holds no text now – a later copy of any text must be sent
          lastSyncedTextRef.current = '';
        }
        // Same files as last time (already staged, or files we downloaded from Windows ourselves)
        return;
      }
      // No files on the local clipboard any more – copying the same files again later must re-stage them.
      lastSyncedFilesKeyRef.current = '';

      // 2. Text. Only a CHANGED local text replaces the remote clipboard, so a passive focus
      //    change never overwrites files staged via drag & drop, while newly copied text always wins.
      const text = await api.clipboardReadText();
      if (!text) return;

      if (force || localChanged || text !== lastSyncedTextRef.current) {
        await handleSendCustomTextToRemote(text, force);
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd synchronizacji schowka:', err);
    } finally {
      clipboardSyncInFlightRef.current = false;
      if (clipboardSyncPendingRef.current) {
        clipboardSyncPendingRef.current = false;
        setTimeout(() => syncLocalClipboardToRemoteRef.current(false), 0);
      }
    }
  }, [handleSendCustomTextToRemote, stageLocalPathsToRdpClipboard]);
  const syncLocalClipboardToRemoteRef = useRef(syncLocalClipboardToRemote);
  syncLocalClipboardToRemoteRef.current = syncLocalClipboardToRemote;

  // ---------------------------------------------------------------------------------------------
  // Remote -> local FILE clipboard (Windows host only)
  // Files copied in the remote session are downloaded over CLIPRDR right away into a private temp
  // folder and put on the local Windows clipboard, so Ctrl+V in Explorer pastes them.
  // ---------------------------------------------------------------------------------------------
  const remoteClipJobRef = useRef(0);
  const stageRemoteFilesToLocalClipboard = useCallback(
    async (provider: RdpFileTransferProvider, files: FileInfo[]) => {
      const job = ++remoteClipJobRef.current; // a newer copy in Windows cancels this one
      const totalBytes = files.reduce((sum, f) => sum + (f.isDirectory ? 0 : f.size || 0), 0);
      if (totalBytes > REMOTE_CLIP_AUTO_LIMIT) {
        showToast(
          t('Skopiowano w Windows {p0} – to za dużo na schowek. Użyj „Pobierz na komputer”.', { p0: formatBytes(totalBytes) }),
          6000
        );
        return;
      }

      const fileCount = files.filter((f) => !f.isDirectory).length;
      try {
        const stageDir = await api.rdpClipStageBegin();
        const topLevel = new Set<string>();
        let done = 0;

        for (let i = 0; i < files.length; i++) {
          if (job !== remoteClipJobRef.current) return;
          const f = files[i];
          const parent = (f.path || '').replace(/\//g, '\\');
          const rel = parent ? `${parent}\\${f.name}` : f.name;
          topLevel.add(rel.split('\\')[0]);

          if (f.isDirectory) {
            await api.rdpClipStageDir(stageDir, rel);
            continue;
          }
          setUploadProgressText(t('Kopiowanie z Windows do schowka: {name} ({p1}/{fileCount})', { name: f.name, p1: done + 1, fileCount }));
          const blob = await provider.downloadFile(f, i).completion;
          if (job !== remoteClipJobRef.current) return;
          await api.rdpClipStageFile(stageDir, rel, new Uint8Array(await blob.arrayBuffer()));
          done++;
        }

        if (job !== remoteClipJobRef.current) return;
        const localPaths = await api.rdpClipStageCommit(stageDir, Array.from(topLevel));
        // These files are now on the local clipboard – do not send them back to Windows on focus.
        lastSyncedFilesKeyRef.current = localPaths.join('|');
        lastSyncedTextRef.current = '';
        await markOwnLocalClipboardWrite();
        setUploadProgressText(null);
        showToast(
          t('Skopiowano z Windows do schowka plików: {n} – wklej Ctrl+V w Eksploratorze', { n: done }),
          4500
        );
      } catch (err: any) {
        if (job !== remoteClipJobRef.current) return;
        console.warn('[RemoteFlow RDP] Błąd kopiowania plików z Windows do schowka:', err);
        setUploadProgressText(null);
        showToast(t('Nie udało się skopiować plików z Windows: {p0}. Użyj „Pobierz na komputer”.', { p0: err?.message || err }), 6000);
      }
    },
    [showToast, markOwnLocalClipboardWrite]
  );
  const markOwnLocalClipboardWriteRef = useRef(markOwnLocalClipboardWrite);
  markOwnLocalClipboardWriteRef.current = markOwnLocalClipboardWrite;
  const stageRemoteFilesToLocalClipboardRef = useRef(stageRemoteFilesToLocalClipboard);
  stageRemoteFilesToLocalClipboardRef.current = stageRemoteFilesToLocalClipboard;

  // Errors reported by the local RDP proxy (connection refused, TLS failure, certificate change...)
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>(`rdp-proxy-error-${session.sessionId}`, (event) => {
      lastProxyErrorRef.current = event.payload;
      setStatus('error');
      setStatusMessage(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [session.sessionId]);

  // Dynamic resolution application (Display Control PDU)
  const applyResolution = useCallback((resPreset: string) => {
    setSelectedResolution(resPreset);
    if (resPreset === 'auto') {
      // No "Fit / 100%" switch in Auto (the desktop has the size of the area)
      scaleModeRef.current = 'fit';
      setScaleMode('fit');
    }
    const ui = userInteractionRef.current;
    if (!ui) return;

    const target = remoteDesktopSize(resPreset, containerRef.current, session.rdpSettings);
    lastAppliedResRef.current = target;
    try {
      sendRemoteSize(ui, target);
      refreshCanvasStyle();
      showToast(
        target.ratio > 1
          ? t('Rozdzielczość: {width} × {height}, skalowanie {scale}%', { width: target.width, height: target.height, scale: rdpScaleFactor(target.ratio) })
          : t('Rozdzielczość: {width} × {height}', { width: target.width, height: target.height }),
        2000
      );
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 100);
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd dynamicznej zmiany rozdzielczości:', err);
    }
  }, [session.rdpSettings, showToast, refreshCanvasStyle]);

  // Initialize and mount the embedded IronRDP WebAssembly Canvas client
  useEffect(() => {
    let isSubscribed = true;
    let localEl: any = null;
    let localHandleReady: ((evt: any) => void) | null = null;
    const container = containerRef.current;
    if (!container) return;

    if (!session.rdpProxyPort) {
      setStatus('connecting');
      setStatusMessage(t('Oczekiwanie na inicjalizację lokalnego proxy RDP...'));
      return;
    }

    setStatus('connecting');
    setStatusMessage(t('Uruchamianie silnika RDP WebAssembly...'));
    lastProxyErrorRef.current = null;

    (async () => {
      try {
        await ensureRdpInitialized();
      } catch (err: any) {
        console.error('Błąd inicjalizacji WebAssembly IronRDP:', err);
        if (isSubscribed) {
          setStatus('error');
          setStatusMessage(t('Błąd inicjalizacji modułu WebAssembly RDP: ') + (err?.message || err));
        }
        return;
      }

      if (!isSubscribed || !containerRef.current) return;

      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
      if (userInteractionRef.current) {
        try {
          userInteractionRef.current.shutdown();
        } catch (e) {
          console.warn('Error during previous session shutdown:', e);
        }
        userInteractionRef.current = null;
      }
      rdpWasmSessionRef.current = null;
      fileTransferProviderRef.current = null;

      // Respond to MS-RDPECLIP Monitor Ready PDU (forceClipboardUpdateCallback):
      // Must ALWAYS call wasmSession.onClipboardPaste(clipData) (even if empty) so CliprdrClient transitions from Initialization -> Ready!
      const handleForceClipboardUpdate = async () => {
        try {
          let wasmSession = rdpWasmSessionRef.current;
          for (let i = 0; i < 20 && !wasmSession && isSubscribed; i++) {
            await new Promise((r) => setTimeout(r, 50));
            wasmSession = rdpWasmSessionRef.current;
          }
          if (!wasmSession || !isSubscribed) return;

          const text = await api.clipboardReadText();
          const clipData = new Backend.ClipboardData();
          if (text && text.length > 0 && !hasStagedUploadRef.current) {
            clipData.addText('text/plain', text);
            lastSyncedTextRef.current = text;
          }

          await wasmSession.onClipboardPaste(clipData);

          // If files were staged before or during clipboard reset, re-advertise them once Cliprdr is in Ready state
          if (hasStagedUploadRef.current && stagedDroppedFilesRef.current.length > 0) {
            setTimeout(() => {
              const prov = fileTransferProviderRef.current;
              if (prov && isSubscribed) {
                (prov as any).uploadState = undefined;
                prov.uploadFiles(stagedDroppedFilesRef.current);
              }
            }, 150);
          }
        } catch (err) {
          console.warn('[RemoteFlow RDP] Błąd inicjalizacji kanału CLIPRDR:', err);
        }
      };

      // Custom SessionBuilder wrapper: guarantees CLIPRDR callbacks are registered BEFORE super.connect()
      const CustomSessionBuilder = class extends Backend.SessionBuilder {
        private _clipCallbacksRegistered = false;

        private _ensureClipCallbacks() {
          if (this._clipCallbacksRegistered) return;
          this._clipCallbacksRegistered = true;
          // Clipboard disabled for this connection: no CLIPRDR callbacks at all
          if (!clipboardAllowedRef.current) return;

          super.remoteClipboardChangedCallback((clipData: any) => {
            if (!isSubscribed) return;
            try {
              if (clipData && typeof clipData.items === 'function') {
                for (const item of clipData.items()) {
                  const mime = item.mimeType?.() || '';
                  if (mime.startsWith('text/')) {
                    const val = item.value?.();
                    if (val != null) {
                      const textVal = typeof val === 'string' ? val : new TextDecoder().decode(val);
                      if (textVal) {
                        lastSyncedTextRef.current = textVal;
                        api.clipboardWriteText(textVal).then(markOwnLocalClipboardWriteRef.current);
                        setRemoteClipboardText(textVal);
                        setClipboardDraft(textVal);
                        showToast(t('Skopiowano tekst z Windows do schowka'), 2500);
                        break;
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.warn('[RemoteFlow RDP] Błąd odbioru schowka z Windows:', e);
            }
          });

          super.forceClipboardUpdateCallback(() => {
            if (!isSubscribed) return;
            handleForceClipboardUpdate();
          });
        }

        override remoteClipboardChangedCallback(_cb: Function) {
          this._ensureClipCallbacks();
          return this;
        }

        override forceClipboardUpdateCallback(_cb: Function) {
          this._ensureClipCallbacks();
          return this;
        }

        override async connect() {
          this._ensureClipCallbacks();
          const wasmSession = await super.connect();
          rdpWasmSessionRef.current = wasmSession;
          return wasmSession;
        }
      };

      const customModule = {
        ...Backend,
        SessionBuilder: CustomSessionBuilder,
      };

      // Create the custom Web Component element with our enhanced WASM Backend
      const el = document.createElement('iron-remote-desktop') as any;
      el.module = customModule;
      el.scale = 'fit'; // both modes: applyCanvasStyle
      el.flexcenter = 'true';
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.display = 'block';
      elementRef.current = el;
      localEl = el;

      const handleReady = async (evt: any) => {
        if (!isSubscribed) return;
        const ui: UserInteraction = evt.detail?.irgUserInteraction;
        userInteractionRef.current = ui;

        // Apply ShadowRoot scaling fixes once on component ready (safe, idempotent)
        applyShadowRootScalingOverrides(el.shadowRoot);
        // The canvas size follows the server (initial size, every resize): keep it pixel-exact
        if (el.shadowRoot) {
          canvasObserverRef.current?.disconnect();
          // Our own <style> changes are ignored (no feedback loop)
          canvasObserverRef.current = new MutationObserver((mutations) => {
            if (mutations.some((m) => !(m.target instanceof HTMLStyleElement) && m.target.parentNode?.nodeName !== 'STYLE')) {
              refreshCanvasStyle();
            }
          });
          canvasObserverRef.current.observe(el.shadowRoot, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['width', 'height'],
          });
        }

        // Enable clipboard, disable IronRDP's buggy browser-polling loop in favor of our native GTK/Wayland sync
        try {
          ui.setEnableClipboard(clipboardAllowedRef.current);
          ui.setEnableAutoClipboard(false);
        } catch (clipErr) {
          console.warn('[RemoteFlow RDP] Błąd konfiguracji schowka:', clipErr);
        }

        // Enable Native RDP File & Directory Transfer (CLIPRDR) – only with the clipboard enabled
        if (clipboardAllowedRef.current) try {
          const ftProvider = new RdpFileTransferProvider({ chunkSize: 64 * 1024 });
          const origSetSession = ftProvider.setSession.bind(ftProvider);
          ftProvider.setSession = (wasmSess: any) => {
            rdpWasmSessionRef.current = wasmSess;
            origSetSession(wasmSess);
          };

          ftProvider.on('files-available', (files) => {
            if (!isSubscribed) return;
            setRemoteAvailableFiles(files);
            if (files.length === 0) return;
            if (isTauri() && isWindowsHost()) {
              // Windows: copy straight into the local clipboard (paste with Ctrl+V in Explorer)
              stageRemoteFilesToLocalClipboardRef.current(ftProvider, files);
            } else {
              showToast(
                t('Wykryto skopiowane pliki w Windows ({length})! Kliknij „Pobierz na komputer”, aby je zapisać.', { length: files.length }),
                5000
              );
            }
          });

          ftProvider.on('upload-progress', (prog) => {
            if (!isSubscribed) return;
            setUploadProgressText(t('Wklejanie do Windows: {fileName} ({p1}%)', { fileName: prog.fileName, p1: Math.round(prog.percentage) }));
          });

          ftProvider.on('upload-complete', (file) => {
            if (!isSubscribed) return;
            setUploadProgressText(t('Przesłano do Windows: {name}', { name: file.name }));
            setTimeout(() => setUploadProgressText(null), 2500);
          });

          ftProvider.on('error', (err) => {
            console.warn('[RemoteFlow RDP FileTransfer] Ostrzeżenie:', err);
          });

          ui.enableFileTransfer(ftProvider as any);
          fileTransferProviderRef.current = ftProvider;
        } catch (ftErr) {
          console.warn('[RemoteFlow RDP] Błąd inicjalizacji RdpFileTransferProvider:', ftErr);
        }

        setStatus('connecting');
        setStatusMessage(t('Negocjowanie parametrów NLA / TLS z serwerem...'));

        const proxyPort = session.rdpProxyPort;
        if (!proxyPort) {
          setStatus('error');
          setStatusMessage(t('Brak aktywnego mostka WebSocket-to-TCP dla sesji RDP'));
          return;
        }

        try {
          // Read from the vault only now – the password is not kept in the session data
          const rdpPassword = await api.getRdpSessionPassword(session.sessionId, session.connectionId);
          if (!isSubscribed) return;
          const targetDimensions = remoteDesktopSize(selectedResolution, containerRef.current, session.rdpSettings);
          noteRequestedSize(targetDimensions);

          const configBuilder = new ConfigBuilder()
            .withDestination(hostPort(session.host, session.port))
            .withProxyAddress(`ws://127.0.0.1:${proxyPort}`)
            .withAuthToken(session.rdpProxyToken || '')
            .withUsername(session.username || '')
            .withPassword(rdpPassword)
            .withServerDomain(session.rdpDomain || '')
            .withDesktopSize({ width: targetDimensions.width, height: targetDimensions.height });

          try {
            configBuilder.withExtension(enableCredssp(true));
            configBuilder.withExtension(displayControl(true));
          } catch (extErr) {
            console.warn('[RemoteFlow RDP] Ostrzeżenie przy dodawaniu rozszerzenia:', extErr);
          }

          const config = configBuilder.build();

          setStatusMessage(
            t('Autoryzacja (CredSSP / NLA) i inicjalizacja pulpitu {width}x{height}...', { width: targetDimensions.width, height: targetDimensions.height })
          );

          const connectPromise = ui.connect(config);
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    t('Przekroczono limit czasu odpowiedzi serwera RDP (15s). Sprawdź czy host jest osiągalny, czy poświadczenia są poprawne lub skorzystaj z przycisku FreeRDP poniżej.')
                  )
                ),
              15000
            );
          });

          const newSession = await Promise.race([connectPromise, timeoutPromise]);
          if (!isSubscribed) return;

          ui.setVisibility(true);
          setStatus('connected');
          lastAppliedResRef.current = targetDimensions;
          refreshCanvasStyle();
          setStatusMessage(
            targetDimensions.ratio > 1
              ? t('Sesja RDP aktywna ({width} × {height}, skalowanie {scale}%)', {
                  width: targetDimensions.width,
                  height: targetDimensions.height,
                  scale: rdpScaleFactor(targetDimensions.ratio),
                })
              : t('Sesja RDP aktywna ({width} × {height})', { width: targetDimensions.width, height: targetDimensions.height })
          );
          // The connection itself cannot carry the scale factor (the web client has no such
          // option), so it follows over Display Control once the channel is up. Sent twice: a
          // request made before the server opened the channel is dropped; the same layout again
          // changes nothing.
          if (targetDimensions.ratio > 1) {
            for (const delay of [1000, 3000]) {
              setTimeout(() => {
                const current = lastAppliedResRef.current;
                if (isSubscribed && userInteractionRef.current && current === targetDimensions) {
                  try {
                    sendRemoteSize(userInteractionRef.current, current);
                  } catch (err) {
                    console.warn('[RemoteFlow RDP] Scale factor not applied:', err);
                  }
                }
              }, delay);
            }
          }

          setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            focusRdpCanvas();
          }, 150);

          const termInfo = await newSession.run();
          if (!isSubscribed) return;

          setStatus('disconnected');
          setStatusMessage(t('Sesja RDP została zakończona: {reason}', { reason: termInfo?.reason() || t('Rozłączono przez serwer') }));
        } catch (err: any) {
          if (!isSubscribed) return;
          console.error('[RemoteFlow RDP] Błąd nawiązywania połączenia:', err);
          setStatus('error');
          let msg = err?.message;
          if (!msg && typeof err?.backtrace === 'function') {
            msg = err.backtrace();
          }
          if (!msg && err) {
            msg = err.toString();
            if (msg === '[object Object]') {
              msg = t('Błąd silnika RDP: odmowa autoryzacji (CredSSP / NLA) lub rozłączenie przez serwer');
            }
          }
          setStatusMessage(
            lastProxyErrorRef.current || msg || t('Błąd połączenia RDP (sprawdź poświadczenia lub NLA)')
          );
        }
      };

      localHandleReady = handleReady;
      el.addEventListener('ready', handleReady);
      container.appendChild(el);
    })();

    return () => {
      isSubscribed = false;
      if (localEl && localHandleReady) {
        localEl.removeEventListener('ready', localHandleReady);
      }
      if (userInteractionRef.current) {
        try {
          userInteractionRef.current.shutdown();
        } catch (e) {
          console.warn('Error during RDP shutdown:', e);
        }
        userInteractionRef.current = null;
      }
      rdpWasmSessionRef.current = null;
      fileTransferProviderRef.current = null;
      canvasObserverRef.current?.disconnect();
      canvasObserverRef.current = null;
      if (localEl && localEl.parentNode) {
        localEl.parentNode.removeChild(localEl);
      }
      elementRef.current = null;
    };
  }, [session.sessionId, session.rdpProxyPort, connectionAttempts]);

  // Adjust scale when toggled ('fit' vs 'real')
  const handleSetScale = (nextMode: 'fit' | 'real') => {
    if (nextMode === scaleMode) return;
    setScaleMode(nextMode);
    // Both modes are done by applyCanvasStyle; the component always stays in "fit"
    if (elementRef.current) {
      (elementRef.current as any).scale = 'fit';
    }
    if (userInteractionRef.current) {
      userInteractionRef.current.setScale(1);
    }
    scaleModeRef.current = nextMode;
    setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      refreshCanvasStyle();
    }, 50);
  };

  // Debounced ResizeObserver for 'auto' resolution mode
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timeoutId: any = null;
    const applyAutoSize = (width: number, height: number) => {
      if (selectedResolution !== 'auto' || !userInteractionRef.current || status !== 'connected') return;
      const ratio = rdpPixelRatio();
      const size = autoSizeFromArea(width, height, ratio);
      if (!size) return;
      const last = lastAppliedResRef.current;
      if (last?.width === size.width && last?.height === size.height && last.ratio === ratio) return;
      const next: RemoteSize = { ...size, ratio };
      lastAppliedResRef.current = next;
      sendRemoteSize(userInteractionRef.current, next);
      refreshCanvasStyle();
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // At once: a canvas that no longer fits must go back to scale-to-fit until the server resizes
        refreshCanvasStyle();
        if (width > 300 && height > 200) {
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => applyAutoSize(width, height), 200);
        }
      }
    });
    observer.observe(container);

    // The screen scaling changed (window moved to another monitor, Windows setting changed):
    // same size in CSS pixels, different size in device pixels.
    const reapply = () => {
      refreshCanvasStyle();
      const rect = container.getBoundingClientRect();
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => applyAutoSize(rect.width, rect.height), 200);
    };
    let scaleQuery: MediaQueryList | null = null;
    const onScaleChange = () => {
      watchScale();
      reapply();
    };
    const watchScale = () => {
      scaleQuery?.removeEventListener('change', onScaleChange);
      scaleQuery = window.matchMedia(`(resolution: ${screenScale()}dppx)`);
      scaleQuery.addEventListener('change', onScaleChange);
    };
    watchScale();

    return () => {
      observer.disconnect();
      clearTimeout(timeoutId);
      scaleQuery?.removeEventListener('change', onScaleChange);
    };
  }, [selectedResolution, status, refreshCanvasStyle]);

  // Synchronize clipboard when window regains focus or tab is activated
  useEffect(() => {
    if (!isActive) return;

    const handleFocus = () => {
      syncLocalClipboardToRemote(false);
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [isActive, syncLocalClipboardToRemote]);


  // Send arbitrary key combination to remote Windows RDP
  const sendKeyCombination = useCallback(
    (scancodes: number[], label?: string, useSpecial?: 'ctrlAltDel' | 'metaKey') => {
      try {
        if (useSpecial === 'ctrlAltDel' && userInteractionRef.current?.ctrlAltDel) {
          userInteractionRef.current.ctrlAltDel();
          if (label) showToast(t('Wysłano: {label}', { label }), 2000);
          focusRdpCanvas();
          return true;
        }

        if (useSpecial === 'metaKey' && userInteractionRef.current?.metaKey) {
          userInteractionRef.current.metaKey();
          if (label) showToast(t('Wysłano: {label}', { label }), 2000);
          focusRdpCanvas();
          return true;
        }

        const wasmSess = rdpWasmSessionRef.current;
        if (wasmSess && Backend?.InputTransaction && Backend?.DeviceEvent) {
          const tx = new Backend.InputTransaction();
          for (const code of scancodes) {
            tx.addEvent(Backend.DeviceEvent.keyPressed(code));
          }
          for (let i = scancodes.length - 1; i >= 0; i--) {
            tx.addEvent(Backend.DeviceEvent.keyReleased(scancodes[i]));
          }
          wasmSess.applyInputs(tx);
          if (label) showToast(t('Wysłano: {label}', { label }), 2000);
          focusRdpCanvas();
          return true;
        }
      } catch (err: any) {
        console.error('[RemoteFlow RDP] Błąd przesyłania kombinacji klawiszy:', err);
        showToast(t('Błąd: {p0}', { p0: err?.message || err }), 3000);
      }
      return false;
    },
    [showToast, focusRdpCanvas]
  );

  // Send raw text as simulated unicode keystrokes
  const sendTextSequence = useCallback(
    (text: string) => {
      if (!text) return;
      try {
        const wasmSess = rdpWasmSessionRef.current;
        if (wasmSess && Backend?.InputTransaction && Backend?.DeviceEvent) {
          const tx = new Backend.InputTransaction();
          for (const char of text) {
            tx.addEvent(Backend.DeviceEvent.unicodePressed(char));
            tx.addEvent(Backend.DeviceEvent.unicodeReleased(char));
          }
          wasmSess.applyInputs(tx);
          showToast(t('Wysłano tekst do Windows ({length} zn.)', { length: text.length }), 2000);
          focusRdpCanvas();
          return true;
        }
      } catch (err: any) {
        console.error('[RemoteFlow RDP] Błąd przesyłania tekstu:', err);
        showToast(t('Błąd tekstu: {p0}', { p0: err?.message || err }), 3000);
      }
      return false;
    },
    [showToast, focusRdpCanvas]
  );

  // Copy session password to clipboard & RDP
  const handleCopyPassword = async () => {
    try {
      const pwd = await api.revealPassword(session.connectionId);
      if (pwd) {
        await api.clipboardWriteSecret(pwd);
        await handleSendCustomTextToRemote(pwd, false);
        setCopiedPassword(true);
        showToast(t('Skopiowano hasło do schowka – zniknie z niego za 30 s.'), 2500);
        setTimeout(() => setCopiedPassword(false), 2000);
      } else {
        showToast(t('Brak zapisanego hasła dla tej sesji'), 2500);
      }
    } catch (err) {
      console.error('Błąd kopiowania hasła:', err);
      showToast(t('Nie udało się skopiować hasła'), 2500);
    }
  };

  // Pop-out / Launch native FreeRDP window
  const handleLaunchExternal = async () => {
    setIsLaunchingExternal(true);
    try {
      await api.launchExternalRdp(session);
      showToast(t('Uruchomiono zewnętrzne okno FreeRDP (z dyskiem Ten komputer -> RemoteFlow)'), 4000);
    } catch (err: any) {
      console.error('Błąd uruchamiania FreeRDP:', err);
      showToast(t('Błąd FreeRDP: {p0}', { p0: err?.message || err }));
    } finally {
      setIsLaunchingExternal(false);
    }
  };

  // Fullscreen container toggle
  const handleToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.parentElement?.requestFullscreen().then(() => {
        setIsFullscreen(true);
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 150);
      }).catch(console.error);
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 150);
      }).catch(console.error);
    }
  };

  // Download standard Microsoft .rdp file
  const handleDownloadRdp = () => {
    const dim = getDimensionsForPreset(selectedResolution, containerRef.current, session.rdpSettings);
    // Values come from the vault (possibly from an imported file): a line break would add
    // settings of its own to the .rdp file (e.g. drive redirection), so it is removed
    const clean = (v: string | undefined) => (v ?? '').replace(/[\r\n]/g, '');
    const login = session.rdpDomain ? `${clean(session.rdpDomain)}\\${clean(session.username)}` : clean(session.username);
    const rdpContent = [
      // IPv6 in brackets: [::1]:3389
      `full address:s:${hostPort(clean(session.host), session.port)}`,
      `username:s:${login}`,
      `screen mode id:i:2`,
      `use multimon:i:1`,
      `desktopwidth:i:${dim.width}`,
      `desktopheight:i:${dim.height}`,
      `session bpp:i:32`,
      `compression:i:1`,
      `keyboardhook:i:2`,
      `audiomode:i:${session.rdpSettings?.sound ? 0 : 2}`,
      `redirectclipboard:i:${clipboardAllowed ? 1 : 0}`,
      // Local drives are never shared with the server (it would get access to all local files)
      `redirectdrives:i:0`,
      `drivestoredirect:s:`,
      `redirectprinters:i:0`,
      `displayconnectionbar:i:1`,
      `autoreconnection enabled:i:1`,
      `authentication level:i:2`,
      `negotiate security layer:i:1`,
      `prompt for credentials:i:0`,
    ].join('\r\n');

    api
      .saveFileAs(`${session.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.rdp`, rdpContent, t('Plik połączenia pulpitu zdalnego'), 'rdp')
      .then((path) => {
        if (path) showToast(t('Zapisano plik .rdp: {path}', { path }), 4000);
      })
      .catch((err: any) => showToast(t('Nie udało się zapisać pliku .rdp: {p0}', { p0: err?.message || err }), 5000));
  };

  // Handle tab visibility changes without unmounting
  useEffect(() => {
    if (!isActive) {
      // Do not keep keyboard focus (and IronRDP key capture) in a hidden session
      const host = elementRef.current as HTMLElement | null;
      if (host && (document.activeElement === host || host.contains(document.activeElement))) {
        host.blur();
      }
    }
    if (userInteractionRef.current) {
      userInteractionRef.current.setVisibility(isActive);
      if (isActive) {
        userInteractionRef.current.setScale(1); // both modes: applyCanvasStyle
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
          refreshCanvasStyle();
          focusRdpCanvas();
        }, 50);
        setTimeout(() => {
          window.dispatchEvent(new Event('resize'));
        }, 150);
      }
    }
  }, [isActive, scaleMode, focusRdpCanvas, refreshCanvasStyle]);

  // Send F5 refresh key (scancode 0x003F) directly to remote Windows session
  const sendF5ToRemote = useCallback(() => {
    try {
      const wasmSess = rdpWasmSessionRef.current;
      if (wasmSess && Backend?.InputTransaction && Backend?.DeviceEvent) {
        const tx = new Backend.InputTransaction();
        const f5Scancode = 0x003f;
        tx.addEvent(Backend.DeviceEvent.keyPressed(f5Scancode));
        tx.addEvent(Backend.DeviceEvent.keyReleased(f5Scancode));
        wasmSess.applyInputs(tx);
        showToast(t('Wysłano F5 (odświeżenie) do Windows'), 1500);
        return true;
      }
    } catch (err) {
      console.warn('[RemoteFlow RDP] Błąd przesyłania F5 do sesji zdalnej:', err);
    }
    return false;
  }, [showToast]);

  // NumLock: before a keypad key reaches the server, bring the server's NumLock to the state the
  // key event shows (see utils/rdpLockKeys). The server's state is unknown after connecting, so
  // the first keypad key always synchronises.
  const serverNumLockRef = useRef<boolean | null>(null);
  useEffect(() => {
    serverNumLockRef.current = null;
  }, [status]);
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      trackNumLock(e);
      if (e.type !== 'keydown' || status !== 'connected') return;
      if (e.code === 'NumLock' || e.code === 'CapsLock' || e.code === 'ScrollLock') {
        // IronRDP synchronises all lock keys on these – with the (fixed) NumLock state
        serverNumLockRef.current = null;
        return;
      }
      const wanted = numLockFromEvent(e);
      if (wanted === null || wanted === serverNumLockRef.current) return;
      const session = rdpWasmSessionRef.current as any;
      if (!session?.synchronizeLockKeys) return;
      try {
        session.synchronizeLockKeys(false, wanted, e.getModifierState('CapsLock'), false);
        serverNumLockRef.current = wanted;
      } catch (err) {
        console.warn('[RemoteFlow RDP] Synchronizacja NumLock nie powiodła się:', err);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('keyup', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('keyup', onKey, { capture: true });
    };
  }, [isActive, status]);

  // Intercept F5 and Ctrl+R to prevent app reload, and send F5 to remote desktop if active
  useEffect(() => {
    if (!isActive) return;

    const handleRdpKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        e.stopPropagation();
        if (status === 'connected') {
          sendF5ToRemote();
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
        // Prevent accidental page reload
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleRdpKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleRdpKeyDown, { capture: true });
    };
  }, [isActive, status, sendF5ToRemote]);

  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';
  const isError = status === 'error';

  return (
    <div
      // Always laid out (visibility of inactive tabs is controlled by the Workspace pane):
      // display:none would discard the canvas contents on WebKitGTK and trigger remote resizes.
      className="flex h-full w-full flex-col bg-slate-950 select-none overflow-hidden font-sans"
    >
      {/* Top Action Toolbar */}
      <div className="flex h-11 items-center justify-between border-b border-slate-800 bg-slate-900/95 px-3 text-xs shrink-0 z-20 shadow-md">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 text-blue-400 font-semibold shrink-0">
            <Monitor className="h-4 w-4 shrink-0" />
            <span className="truncate max-w-[130px]">{session.title}</span>
          </div>
          <span className="text-slate-600">|</span>
          <span className="font-mono text-slate-300 text-[11px] truncate max-w-[160px]">
            {session.username}@{session.host}:{session.port}
          </span>
          <div className="flex items-center gap-1.5 ml-1 shrink-0">
            <span
              className={`h-2 w-2 rounded-full shrink-0 ${
                isConnected
                  ? 'bg-emerald-400 shadow-xs shadow-emerald-400/50'
                  : isConnecting
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-red-400'
              }`}
            />
            <span
              className={`text-[11px] font-medium hidden sm:inline ${
                isConnected
                  ? 'text-emerald-400'
                  : isConnecting
                  ? 'text-amber-400'
                  : 'text-red-400'
              }`}
            >
              {isConnected
                ? t('Aktywny')
                : isConnecting
                ? t('Łączenie...')
                : isError
                ? t('Błąd połączenia')
                : t('Rozłączono')}
            </span>
          </div>

          <div className="hidden lg:flex items-center gap-1.5 ml-2 border-l border-slate-800 pl-2 text-[10px] text-slate-400 shrink-0">
            <span className="flex items-center gap-1 text-emerald-400" title={t('Szyfrowanie TLS / NLA aktywne')}>
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>TLS</span>
            </span>
            {session.rdpSettings?.sound && (
              <span className="flex items-center gap-1 text-purple-400" title={t('Dźwięk zdalny włączony')}>
                <Volume2 className="h-3.5 w-3.5" />
              </span>
            )}
          </div>

          {/* Plik/katalog gotowy do wklejenia na pasku informacyjnym RDP obok TLS */}
          {stagedUploadNames.length > 0 && isConnected && (
            <div className="flex items-center gap-1.5 ml-2 rounded-full bg-emerald-950/90 border border-emerald-500/60 px-2.5 py-0.5 text-[10px] text-emerald-200 font-medium shadow-xs shrink-0 animate-in fade-in duration-150">
              <FileUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span className="truncate max-w-[180px] sm:max-w-[260px]">
                Gotowe: <strong className="text-white">{stagedUploadNames.join(', ')}</strong>
              </span>
              <button
                onClick={() => {
                  focusRdpCanvas();
                  userInteractionRef.current?.ctrlV();
                }}
                title={t('Wklej w sesji Windows (Ctrl+V)')}
                className="ml-1 rounded bg-emerald-600 hover:bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white transition-colors"
              >
                Ctrl+V
              </button>
              <button
                onClick={() => {
                  hasStagedUploadRef.current = false;
                  stagedDroppedFilesRef.current = [];
                  setStagedUploadNames([]);
                }}
                title={t('Anuluj')}
                className="text-emerald-300 hover:text-white p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Informacja o skopiowanych plikach w Windows na głównym pasku połączenia */}
          {remoteAvailableFiles.length > 0 && isConnected && (
            <div
              onClick={() => {
                if (!isDownloadingRemoteFiles) {
                  handleDownloadRemoteFiles();
                }
              }}
              title={t('Skopiowano pliki w sesji Windows. Kliknij, aby pobrać je od razu na komputer (do wspólnego katalogu wymiany).')}
              className="flex items-center gap-1.5 ml-2 rounded-full bg-cyan-950/90 border border-cyan-500/60 px-2.5 py-0.5 text-[10px] text-cyan-200 font-medium shadow-xs shrink-0 cursor-pointer hover:bg-cyan-900/90 hover:border-cyan-400 transition-all animate-in fade-in duration-150"
            >
              {isDownloadingRemoteFiles ? (
                <Loader2 className="h-3.5 w-3.5 text-cyan-400 animate-spin shrink-0" />
              ) : (
                <Download className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
              )}
              <span className="truncate max-w-[170px] sm:max-w-[260px]">
                {isDownloadingRemoteFiles ? (
                  <span>{t('Pobieranie plików na komputer...')}</span>
                ) : (
                  <>
                    {t('Pobierz z Windows ({n}):', { n: remoteAvailableFiles.length })}{' '}
                    <strong className="text-white">
                      {remoteAvailableFiles.slice(0, 2).map((f) => f.name).join(', ')}
                      {remoteAvailableFiles.length > 2 ? ` (+${remoteAvailableFiles.length - 2})` : ''}
                    </strong>
                  </>
                )}
              </span>
              {!isDownloadingRemoteFiles && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemoteAvailableFiles([]);
                  }}
                  title={t('Odrzuć powiadomienie')}
                  className="text-cyan-300 hover:text-white p-0.5 ml-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          )}

          {/* Real-time Feedback Toast Badge */}
          {(clipboardFeedback || uploadProgressText) && (
            <div className="flex items-center gap-1 ml-2 rounded-full bg-cyan-950/90 border border-cyan-500/60 px-2.5 py-0.5 text-[10px] text-cyan-200 font-medium shadow-xs truncate max-w-[340px]">
              <Check className="h-3 w-3 text-cyan-400 shrink-0" />
              <span className="truncate">{uploadProgressText || clipboardFeedback}</span>
            </div>
          )}

          {/* Saving Files indicator */}
          {isSavingFiles && (
            <div className="flex items-center gap-1 ml-2 rounded-full bg-amber-950/90 border border-amber-500/60 px-2 py-0.5 text-[10px] text-amber-300 font-medium shadow-xs shrink-0">
              <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
              <span>{t('Przygotowywanie plików...')}</span>
            </div>
          )}
        </div>

        {/* Quick Toolbar Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Resolution Selector Dropdown */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-slate-200 hover:border-slate-600">
            <Tv className="h-3 w-3 text-cyan-400 shrink-0" />
            <select
              value={selectedResolution}
              onChange={(e) => applyResolution(e.target.value)}
              disabled={!isConnected}
              title={t('Zmień rozdzielczość pulpitu zdalnego w czasie rzeczywistym')}
              className="bg-transparent text-[11px] font-medium text-slate-200 outline-hidden cursor-pointer disabled:opacity-50"
            >
              {RESOLUTION_PRESETS.map((p) => (
                <option key={p.value} value={p.value} className="bg-slate-900 text-slate-200">
                  {t(p.label)}
                </option>
              ))}
            </select>
          </div>

          {/* Performance statistics of the embedded client */}
          <button
            onClick={() => setIsStatsOpen((v) => !v)}
            title={t('Statystyki wydajności RDP (dane, rysowanie, obciążenie)')}
            className={`flex items-center rounded-lg border px-2 py-1 text-xs transition-colors ${
              isStatsOpen
                ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-200 hover:bg-cyan-900/50'
                : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <Activity className="h-3 w-3 text-cyan-400" />
          </button>

          {/* Scale Switcher: Fit vs Real (100% 1:1) – only for a fixed resolution: in Auto the
              desktop always has the size of the area, so both would look the same */}
          {selectedResolution !== 'auto' && (
            <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800/60 p-0.5" role="group">
              <ZoomIn className="mx-1 h-3 w-3 text-amber-400" />
              {(
                [
                  ['fit', t('Dopasuj'), t('Dopasuj do okna')],
                  ['real', '100%', t('100% oryginał (1:1)')],
                ] as const
              ).map(([mode, label, title]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleSetScale(mode)}
                  title={title}
                  aria-pressed={scaleMode === mode}
                  className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                    scaleMode === mode ? 'bg-cyan-600 text-white' : 'text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* Toggle Unified Files & Clipboard Drawer */}
          <button
            onClick={() => setIsClipboardDrawerOpen((v) => !v)}
            disabled={!clipboardAllowed}
            title={clipboardAllowed ? t('Transfer plików, katalogów i menedżer schowka RDP') : t('Schowek jest wyłączony w ustawieniach tego połączenia')}
            className={`relative flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              isClipboardDrawerOpen
                ? 'border-emerald-500 bg-emerald-950/60 text-emerald-200 shadow-xs'
                : remoteAvailableFiles.length > 0 || stagedUploadNames.length > 0
                ? 'border-cyan-500 bg-cyan-950/50 text-cyan-200'
                : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white'
            } disabled:cursor-default disabled:opacity-40`}
          >
            <FolderSync className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-[11px] font-medium hidden sm:inline">{t('Pliki i Schowek')}</span>
            {(remoteAvailableFiles.length > 0 || stagedUploadNames.length > 0) && (
              <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[9px] font-bold text-slate-950">
                {remoteAvailableFiles.length || stagedUploadNames.length}
              </span>
            )}
          </button>

          {/* Wyślij sekwencję klawiszy do Windows */}
          <KeySequenceMenu
            isConnected={isConnected}
            sendKeyCombination={sendKeyCombination}
            sendTextSequence={sendTextSequence}
            sendF5ToRemote={sendF5ToRemote}
            showToast={showToast}
          />

          {/* Send F5 (Odśwież) to Windows */}
          <button
            onClick={sendF5ToRemote}
            disabled={!isConnected}
            title={t('Wyślij klawisz F5 (Odśwież w systemie Windows) [F5]')}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            <span className="text-[11px] font-semibold text-amber-400">F5</span>
            <span className="text-[11px] hidden lg:inline text-slate-300">{t('Odśwież')}</span>
          </button>

          {/* Copy Password Button */}
          <button
            onClick={handleCopyPassword}
            title={t('Kopiuj hasło sesji do schowka (lokalnego i RDP)')}
            className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
          >
            {copiedPassword ? (
              <Check className="h-3 w-3 text-emerald-400" />
            ) : (
              <KeyRound className="h-3 w-3 text-cyan-400" />
            )}
            <span className="text-[11px] hidden md:inline">{copiedPassword ? t('Skopiowano!') : t('Hasło')}</span>
          </button>

          {/* Fullscreen Toggle */}
          <button
            onClick={handleToggleFullscreen}
            title={isFullscreen ? t('Opuść pełny ekran') : t('Pełny ekran')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5 text-cyan-400" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5 text-slate-400" />
            )}
          </button>

          {/* Reconnect Button */}
          <button
            onClick={() => setConnectionAttempts((c) => c + 1)}
            title={t('Połącz ponownie')}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5 text-slate-400" />
          </button>
        </div>
      </div>

      {/* Main Canvas Container for IronRDP WebAssembly */}
      <div
        onMouseEnter={() => syncLocalClipboardToRemote(false)}
        onPointerDown={() => focusRdpCanvas()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative flex-1 min-h-0 min-w-0 w-full bg-rdp-bg flex items-center justify-center ${
          scaleMode === 'real' ? 'overflow-auto' : 'overflow-hidden'
        }`}
      >
        {/* Web Component mount point */}
        <div
          ref={containerRef}
          className="w-full h-full flex items-center justify-center overflow-hidden"
        />

        {/* Drag & Drop Files Overlay */}
        {isDragOver && (
          <div className="absolute inset-0 bg-cyan-950/85 border-2 border-dashed border-cyan-400 backdrop-blur-xs flex flex-col items-center justify-center z-30 pointer-events-none p-6 text-center animate-fadeIn">
            <FileUp className="h-12 w-12 text-cyan-400 mb-3 animate-bounce" />
            <h3 className="text-base font-bold text-white">{t('Upuść pliki lub katalogi do sesji Windows RDP')}</h3>
            <p className="text-xs text-cyan-200/90 mt-1 max-w-md">
              {t('Zostaną umieszczone bezpośrednio w schowku Windows RDP (wystarczy nacisnąć Ctrl+V lub wybrać „Wklej” w dowolnym folderze Windows) oraz zapisane w ~/RemoteFlow_Shared.')}
            </p>
          </div>
        )}

        {/* Unified Files & Clipboard Manager Drawer */}
        {isClipboardDrawerOpen && (
          <FilesClipboardDrawer
            onClose={() => {
              setIsClipboardDrawerOpen(false);
              focusRdpCanvas();
            }}
            handleClearClipboard={handleClearClipboard}
            isConnected={isConnected}
            isSavingFiles={isSavingFiles}
            stageDroppedFilesToRdpClipboard={stageDroppedFilesToRdpClipboard}
            stageLocalPathsToRdpClipboard={stageLocalPathsToRdpClipboard}
            isLocalBrowserOpen={isLocalBrowserOpen}
            setIsLocalBrowserOpen={setIsLocalBrowserOpen}
            localPathRef={localPathRef}
            remoteAvailableFiles={remoteAvailableFiles}
            setRemoteAvailableFiles={setRemoteAvailableFiles}
            handleDownloadRemoteFiles={handleDownloadRemoteFiles}
            isDownloadingRemoteFiles={isDownloadingRemoteFiles}
            clipboardDraft={clipboardDraft}
            setClipboardDraft={setClipboardDraft}
            handleSendCustomTextToRemote={handleSendCustomTextToRemote}
            pasteToRemote={() => userInteractionRef.current?.ctrlV()}
            remoteClipboardText={remoteClipboardText}
            handleOpenSharedFolder={handleOpenSharedFolder}
            showToast={showToast}
          />
        )}

        {isStatsOpen && isConnected && <RdpStatsPanel onClose={() => setIsStatsOpen(false)} />}

        {/* Loading / Connecting Overlay */}
        {isConnecting && <RdpConnectingOverlay session={session} rdpLogin={rdpLogin} statusMessage={statusMessage} />}

        {/* Error / Disconnected Overlay */}
        {(isError || status === 'disconnected') && (
          <RdpErrorOverlay
            isError={isError}
            statusMessage={statusMessage}
            rdpLogin={rdpLogin}
            onReconnect={() => setConnectionAttempts((c) => c + 1)}
            handleLaunchExternal={handleLaunchExternal}
            isLaunchingExternal={isLaunchingExternal}
            handleDownloadRdp={handleDownloadRdp}
          />
        )}
      </div>
    </div>
  );
};
