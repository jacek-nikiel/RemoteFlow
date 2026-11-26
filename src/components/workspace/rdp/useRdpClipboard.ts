/**
 * Clipboard and file exchange of the RDP viewer (CLIPRDR): text both ways, files and folders
 * sent to Windows (picked, dropped, from the local clipboard), files copied in Windows
 * downloaded or put on the local clipboard, and the focus-triggered clipboard sync. Moved out of
 * RdpViewer.tsx as is; the viewer wires the returned callbacks and refs into the IronRDP session.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Backend, DroppedFile, FileInfo, RdpFileTransferProvider } from '@devolutions/iron-remote-desktop-rdp';
import { SessionInfo } from '../../../types';
import { api } from '../../../services/api';
import { formatBytes } from '../../../utils/formatBytes';
import { useT } from '../../../i18n';

/** Remote -> local clipboard copies above this size are not downloaded automatically. */
const REMOTE_CLIP_AUTO_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GiB

interface Params {
  session: SessionInfo;
  showToast: (msg: string, duration?: number) => void;
  rdpWasmSessionRef: React.MutableRefObject<any>;
  fileTransferProviderRef: React.MutableRefObject<RdpFileTransferProvider | null>;
  focusRdpCanvas: () => void;
}

export function useRdpClipboard({ session, showToast, focusRdpCanvas, rdpWasmSessionRef, fileTransferProviderRef }: Params) {
  const t = useT();
  const lastSyncedTextRef = useRef<string>('');
  const lastSyncedFilesKeyRef = useRef<string>('');
  const hasStagedUploadRef = useRef<boolean>(false);
  const stagedDroppedFilesRef = useRef<DroppedFile[]>([]);
  // Throttling of focus-triggered clipboard sync (each sync may reach the OS clipboard)
  const clipboardSyncInFlightRef = useRef<boolean>(false);
  // "Clipboard" in the connection's RDP settings: when off, nothing is exchanged with the remote
  // clipboard (text or files) in either direction.
  const clipboardAllowed = session.rdpSettings?.clipboard !== false;
  const clipboardAllowedRef = useRef(clipboardAllowed);
  clipboardAllowedRef.current = clipboardAllowed;
  const clipboardSyncPendingRef = useRef<boolean>(false);
  const lastClipboardSyncAtRef = useRef<number>(0);
  // Windows: local clipboard sequence number seen at the last sync (detects every new copy,
  // even of identical content, and ignores changes made by RemoteFlow itself)
  const lastLocalClipSeqRef = useRef<number | null>(null);
  const markOwnLocalClipboardWrite = useCallback(async () => {
    const seq = await api.clipboardSequence();
    if (seq != null) lastLocalClipSeqRef.current = seq;
  }, []);

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
      const { entries, skippedLarge, truncated } = await api.readLocalPathsForRdpClipboard(localPaths);
      if (entries.length === 0) {
        showToast(t('Nie znaleziono plików do przesłania'));
        return;
      }
      if (skippedLarge > 0 || truncated) {
        showToast(
          [
            skippedLarge > 0 ? t('Pominięto plików większych niż 1 GB: {n}', { n: skippedLarge }) : '',
            truncated ? t('Za dużo plików naraz – dodano pierwsze 5000 elementów.') : '',
          ]
            .filter(Boolean)
            .join(' '),
          6000
        );
      }

      // Content read as raw bytes (it came as Base64 in JSON before: ~2.7x the size and a
      // character-by-character conversion on the UI thread)
      const droppedFiles: DroppedFile[] = [];
      for (const ent of entries) {
        if (ent.isDirectory || !ent.localPath) {
          droppedFiles.push({
            file: null,
            name: ent.name,
            size: 0,
            lastModified: ent.lastModified || Date.now(),
            path: ent.path || undefined,
            isDirectory: true,
          });
          continue;
        }
        const bytes = await api.readLocalFileBytes(ent.localPath);
        const fileObj = new window.File([bytes], ent.name, {
          lastModified: ent.lastModified || Date.now(),
        });
        droppedFiles.push({
          file: fileObj,
          name: ent.name,
          size: fileObj.size,
          lastModified: ent.lastModified || Date.now(),
          path: ent.path || undefined,
          isDirectory: false,
        });
      }

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
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const relName = fileInfo.path ? `${fileInfo.path}\\${fileInfo.name}` : fileInfo.name;
        await api.saveDroppedFileToShared(relName, bytes, session.connectionId);
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
                const bytes = new Uint8Array(await df.file.arrayBuffer());
                const rel = df.path ? `${df.path}\\${df.name}` : df.name;
                await api.saveDroppedFileToShared(rel, bytes);
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


  return {
    lastSyncedTextRef,
    hasStagedUploadRef,
    stagedDroppedFilesRef,
    clipboardAllowed,
    clipboardAllowedRef,
    clipboardDraft,
    setClipboardDraft,
    remoteClipboardText,
    setRemoteClipboardText,
    isDragOver,
    setIsDragOver,
    isSavingFiles,
    stagedUploadNames,
    setStagedUploadNames,
    uploadProgressText,
    setUploadProgressText,
    remoteAvailableFiles,
    setRemoteAvailableFiles,
    isDownloadingRemoteFiles,
    isLocalBrowserOpen,
    setIsLocalBrowserOpen,
    localPathRef,
    handleSendCustomTextToRemote,
    handleClearClipboard,
    stageDroppedFilesToRdpClipboard,
    stageLocalPathsToRdpClipboard,
    handleDownloadRemoteFiles,
    handleOpenSharedFolder,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    syncLocalClipboardToRemote,
    markOwnLocalClipboardWriteRef,
    stageRemoteFilesToLocalClipboardRef,
  };
}
