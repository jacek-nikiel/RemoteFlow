import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ClipboardPaste,
  HardDrive,
  Loader2,
  Pin,
  PinOff,
  Server,
  X,
  CircleStop,
  } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getOscCwd } from '../../utils/terminalCwd';
import { api, isTauri } from '../../services/api';
import { TransferProgress, TransferSummary } from '../../types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
// Loaded on first use (CodeMirror is a large part of the bundle)
const FilePreview = React.lazy(() => import('./FilePreview').then((m) => ({ default: m.FilePreview })));
import { tn, useT } from '../../i18n';
import { formatBytes } from '../../utils/formatBytes';

import { Side, PaneState, emptyPane, baseName, remoteParent, DragInfo } from './sftp/sftpTypes';
import { FilePane } from './sftp/FilePane';
import { ChmodDialog, MoveDialog } from './sftp/SftpDialogs';
import { SftpFileEntry } from '../../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  connectionTitle: string;
  /** SSH terminal tab the manager was opened from – "directory from the terminal" */
  terminalSessionId?: string;
  onNotify?: (msg: string) => void;
  /** true = split workspace: use the whole pane; false = full-screen session: half of it. */
  fullWidth: boolean;
  /**
   * A transfer started / progressed / ended (null). It keeps running when the window is closed,
   * so the terminal shows it on its "Files (SFTP)" button.
   */
  onTransferChange?: (transfer: SftpTransferInfo | null) => void;
  /** A transfer ended: the summary shown in the status bar and whether it went fully well. */
  onTransferDone?: (text: string, ok: boolean) => void;
  /**
   * Upload asked for outside the window (files dropped on the terminal or pasted into it): runs
   * as a normal transfer – progress, Stop, the indicator on the terminal button – also while the
   * window is closed. A new `id` starts a new upload.
   */
  uploadRequest?: { id: number; paths: string[]; targetDir: string } | null;
}

/** Running transfer as shown outside the window. */
export interface SftpTransferInfo {
  label: string;
  files: number;
  current: string | null;
  bytes: number;
  cancelling: boolean;
}

export const SftpManager: React.FC<Props> = ({
  isOpen,
  onClose,
  connectionId,
  connectionTitle,
  terminalSessionId,
  onNotify,
  fullWidth,
  onTransferChange,
  onTransferDone,
  uploadRequest,
}) => {
  const t = useT();
  const [local, setLocal] = useState<PaneState>(emptyPane);
  const [remote, setRemote] = useState<PaneState>(emptyPane);
  const [busy, setBusy] = useState<string | null>(null); // transfer description
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [status, setStatus] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    label: string;
    run: () => void;
    info?: boolean;
  } | null>(null);
  // Set synchronously when a transfer starts, so drops arriving in the same moment are rejected too
  const busyRef = useRef<string | null>(null);
  const showBusyNotice = useCallback(() => {
    setConfirm({
      title: t('Trwa operacja SFTP'),
      message: t(
        'Aktualnie trwa operacja: {what}. Poczekaj na jej zakończenie.',
        { what: busyRef.current ?? 'transfer' }
      ),
      label: 'OK',
      info: true,
      run: () => {},
    });
  }, []);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  // File open in the preview / text editor
  const [preview, setPreview] = useState<{ side: Side; path: string; name: string; edit: boolean } | null>(null);
  const [osDropOver, setOsDropOver] = useState(false);
  const [moveDialog, setMoveDialog] = useState<{ side: Side; paths: string[] } | null>(null);
  const [chmodDialog, setChmodDialog] = useState<SftpFileEntry[] | null>(null);
  const transferIdRef = useRef<string>('');
  // Running upload/download that can be stopped, and whether "Przerwij" was clicked
  const [activeTransfer, setActiveTransfer] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const remotePaneRef = useRef<HTMLDivElement>(null);
  const localPaneRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  const panes = { local, remote };
  const localRef = useRef(local);
  localRef.current = local;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  const setters = { local: setLocal, remote: setRemote };

  const showStatus = useCallback((text: string, type: 'ok' | 'error' = 'ok') => {
    setStatus({ text, type });
    if (type === 'ok') setTimeout(() => setStatus((s) => (s?.text === text ? null : s)), 5000);
  }, []);

  // --- Loading ----------------------------------------------------------------------------------
  const loadLocal = useCallback(async (path: string): Promise<boolean> => {
    setLocal((p) => ({ ...p, loading: true, error: null }));
    try {
      const res = await api.localListDir(path);
      setLocal((p) => ({
        ...p,
        path: res.currentPath,
        parent: res.parentPath ?? null,
        entries: res.entries,
        loading: false,
        selected: res.currentPath === p.path ? p.selected.filter((s) => res.entries.some((e) => e.path === s)) : [],
        anchor: null,
        searchResults: null,
        filter: res.currentPath === p.path ? p.filter : '',
      }));
      return true;
    } catch (err: any) {
      setLocal((p) => ({ ...p, loading: false, error: String(err?.message || err) }));
      return false;
    }
  }, []);

  const loadRemote = useCallback(
    async (path: string): Promise<boolean> => {
      setRemote((p) => ({ ...p, loading: true, error: null }));
      try {
        const res = await api.sftpList(connectionId, path);
        setRemote((p) => ({
          ...p,
          path: res.currentPath,
          parent: remoteParent(res.currentPath),
          entries: res.entries,
          loading: false,
          selected: res.currentPath === p.path ? p.selected.filter((s) => res.entries.some((e) => e.path === s)) : [],
          anchor: null,
          searchResults: null,
          filter: res.currentPath === p.path ? p.filter : '',
        }));
        return true;
      } catch (err: any) {
        setRemote((p) => ({ ...p, loading: false, error: String(err?.message || err) }));
        return false;
      }
    },
    [connectionId]
  );

  const load = (side: Side, path: string) => (side === 'local' ? loadLocal(path) : loadRemote(path));

  // Server pane -> directory of the shell in the SSH terminal this window was opened from
  const goToTerminalDir = async () => {
    if (!terminalSessionId) return;
    let path: string | null = null;
    let note = '';
    try {
      const res = await api.terminalCwd(terminalSessionId);
      path = res.path;
      if (res.otherUserShell) {
        note = t(' (powłoka innego użytkownika, np. po sudo/su, jest niedostępna – użyto katalogu Twojej powłoki)');
      }
    } catch (err: any) {
      const msg = String(err?.message || err);
      path = getOscCwd(terminalSessionId);
      if (!path) {
        showStatus(
          msg === 'NO_PROC'
            ? t('Nie można odczytać katalogu terminala: serwer nie udostępnia /proc (obsługiwane są serwery Linux).')
            : msg,
          'error'
        );
        return;
      }
    }
    if (path && (await loadRemote(path))) {
      showStatus(t('Katalog z terminala: {path}', { path }) + note);
    }
  };

  // Start folders saved for this connection; nothing saved = home folders (local user / server user)
  const [savedDirs, setSavedDirs] = useState<{ local: string; remote: string }>({ local: '', remote: '' });
  useEffect(() => {
    if (!isOpen || initializedRef.current) return;
    initializedRef.current = true;
    (async () => {
      let localStart = '';
      let remoteStart = '';
      try {
        const vault = await api.getVaultData();
        const conn = vault.connections.find((c) => c.id === connectionId);
        // defaultDownloadDir = SFTP folder pinned in versions up to 1.1.3
        localStart = conn?.sftpLocalDir || conn?.defaultDownloadDir || '';
        remoteStart = conn?.sftpRemoteDir || '';
        setSavedDirs({ local: localStart, remote: remoteStart });
      } catch {}
      // A saved folder that no longer exists falls back to the home folder
      if (!(await loadLocal(localStart)) && localStart) loadLocal('');
      if (!(await loadRemote(remoteStart)) && remoteStart) loadRemote('');
    })();
  }, [isOpen, connectionId, loadLocal, loadRemote]);

  // Reopened window: the panes keep their last folders, but their contents are read again –
  // files may have changed meanwhile (e.g. in the terminal). Previously the list from the first
  // opening was shown until a manual refresh.
  const pathsRef = useRef({ local: '', remote: '' });
  pathsRef.current = { local: local.path, remote: remote.path };
  const wasOpenRef = useRef(isOpen);
  useEffect(() => {
    const reopened = isOpen && !wasOpenRef.current && initializedRef.current;
    wasOpenRef.current = isOpen;
    if (!reopened) return;
    const { local: localPath, remote: remotePath } = pathsRef.current;
    (async () => {
      // A folder that no longer exists falls back to the home folder
      if (!(await loadLocal(localPath)) && localPath) loadLocal('');
      if (!(await loadRemote(remotePath)) && remotePath) loadRemote('');
    })();
  }, [isOpen, loadLocal, loadRemote]);

  // Release the cached SFTP session when the window is closed / the tab goes away
  useEffect(() => {
    if (isOpen) return;
    if (initializedRef.current) api.sftpRelease(connectionId).catch(() => {});
  }, [isOpen, connectionId]);
  useEffect(() => () => void api.sftpRelease(connectionId).catch(() => {}), [connectionId]);

  // Transfer progress events
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    let cancelled = false;
    listen<TransferProgress>('sftp-transfer-progress', (e) => {
      if (e.payload.transferId === transferIdRef.current) setProgress(e.payload);
    }).then((fn) => (cancelled ? fn() : (un = fn)));
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // Report the running transfer to the terminal (it keeps going when the window is closed)
  const onTransferChangeRef = useRef(onTransferChange);
  onTransferChangeRef.current = onTransferChange;
  const onTransferDoneRef = useRef(onTransferDone);
  onTransferDoneRef.current = onTransferDone;
  useEffect(() => {
    onTransferChangeRef.current?.(
      busy
        ? { label: busy, files: progress?.files ?? 0, current: progress?.current || null, bytes: progress?.bytes ?? 0, cancelling }
        : null
    );
  }, [busy, progress, cancelling]);
  useEffect(() => () => onTransferChangeRef.current?.(null), []);

  // --- Transfers --------------------------------------------------------------------------------
  const runTransfer = useCallback(
    async (from: Side, paths: string[], targetDir: string) => {
      if (paths.length === 0) return;
      if (busyRef.current) {
        showBusyNotice();
        return;
      }
      const transferId = Math.random().toString(36).slice(2);
      transferIdRef.current = transferId;
      setActiveTransfer(transferId);
      setCancelling(false);
      setProgress(null);
      const what = paths.length === 1 ? baseName(paths[0]) : tn(paths.length, ['{length} element', '{length} elementy', '{length} elementów'], { length: paths.length });
      const label = from === 'local' ? t('Wysyłanie {what} → {targetDir}', { what, targetDir }) : t('Pobieranie {what} → {targetDir}', { what, targetDir });
      busyRef.current = label;
      setBusy(label);
      setStatus(null);
      try {
        const sum: TransferSummary =
          from === 'local'
            ? await api.sftpTransferUpload(connectionId, paths, targetDir, transferId)
            : await api.sftpTransferDownload(connectionId, paths, targetDir, transferId);
        const verb = from === 'local' ? t('Wysłano') : t('Pobrano');
        const text =
          (sum.cancelled
            ? (from === 'local'
                ? t('Przerwano wysyłanie (niedokończony plik na serwerze usunięto). ')
                : t('Przerwano pobieranie (niedokończony plik nie został zapisany). '))
            : '') +
          tn(sum.files, ['{verb} {files} plik ({p2})', '{verb} {files} pliki ({p2})', '{verb} {files} plików ({p2})'], { verb, files: sum.files, p2: formatBytes(sum.bytes) }) +
          (sum.folders ? t(', katalogów: {folders}', { folders: sum.folders }) : '') +
          (sum.skippedLinks
            ? t(', pominięto dowiązań do katalogów: {n}', { n: sum.skippedLinks })
            : '') +
          (sum.failed ? t('. Błędy: {failed} – {p1}', { failed: sum.failed, p1: sum.errors.join('; ') }) : '');
        showStatus(text, sum.failed || sum.cancelled ? 'error' : 'ok');
        onNotify?.(text);
        onTransferDoneRef.current?.(text, !(sum.failed || sum.cancelled));
        if (from === 'local') loadRemote(remote.path === targetDir ? targetDir : remote.path);
        else loadLocal(local.path === targetDir ? targetDir : local.path);
        setters[from]((p) => ({ ...p, selected: [], anchor: null }));
      } catch (err: any) {
        const text = t('Błąd transferu: {p0}', { p0: err?.message || err });
        showStatus(text, 'error');
        onTransferDoneRef.current?.(text, false);
      } finally {
        busyRef.current = null;
        setBusy(null);
        setProgress(null);
        transferIdRef.current = '';
        setActiveTransfer(null);
        setCancelling(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionId, local.path, remote.path, loadLocal, loadRemote, onNotify, showStatus, showBusyNotice]
  );

  // Upload asked for by the terminal (drop / paste of files)
  const lastUploadRequestRef = useRef(0);
  useEffect(() => {
    if (!uploadRequest || uploadRequest.id === lastUploadRequestRef.current) return;
    lastUploadRequestRef.current = uploadRequest.id;
    if (busyRef.current) {
      onNotify?.(t('Aktualnie trwa operacja: {what}. Poczekaj na jej zakończenie.', { what: busyRef.current }));
      return;
    }
    void runTransfer('local', uploadRequest.paths, uploadRequest.targetDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadRequest]);

  /** Transfer to the other side; asks before overwriting items that already exist there. */
  const transfer = useCallback(
    (from: Side, paths: string[], targetDir?: string) => {
      if (paths.length === 0) return;
      if (busyRef.current) {
        showBusyNotice();
        return;
      }
      const other = from === 'local' ? remote : local;
      const dir = targetDir ?? other.path;
      const existing =
        dir === other.path
          ? paths.map(baseName).filter((n) => other.entries.some((e) => e.name === n))
          : [];
      if (existing.length > 0) {
        setConfirm({
          title: t('Zastąpić istniejące elementy?'),
          message:
            t('W katalogu docelowym istnieje już: {p0}', { p0: existing.slice(0, 6).join(', ') }) +
            (existing.length > 6 ? t(' i {p0} innych', { p0: existing.length - 6 }) : '') +
            t('. Pliki zostaną nadpisane, a zawartość katalogów połączona.'),
          label: t('Zastąp'),
          run: () => runTransfer(from, paths, dir),
        });
      } else {
        runTransfer(from, paths, dir);
      }
    },
    [local, remote, runTransfer, showBusyNotice]
  );

  // OS file drops (Explorer / Dolphin / Nautilus) onto the remote pane → upload with real paths
  useEffect(() => {
    if (!isOpen || !isTauri()) return;
    let un: (() => void) | null = null;
    let cancelled = false;
    const inRemotePane = (pos: { x: number; y: number }) => {
      const el = remotePaneRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'over' || p.type === 'enter') setOsDropOver(inRemotePane(p.position));
        else if (p.type === 'leave') setOsDropOver(false);
        else if (p.type === 'drop') {
          setOsDropOver(false);
          if (inRemotePane(p.position) && p.paths.length > 0) transfer('local', p.paths);
        }
      })
      .then((fn) => (cancelled ? fn() : (un = fn)))
      .catch(() => {});
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, [isOpen, transfer]);

  // --- In-app drag & drop between the panes (pointer based – works on every platform) ------------
  // --- Rename / move / permissions -----------------------------------------------------------
  const renameEntry = async (side: Side, entry: SftpFileEntry, newName: string): Promise<boolean> => {
    if (busyRef.current) {
      showBusyNotice();
      return false;
    }
    try {
      const path = side === 'local' ? await api.localRename(entry.path, newName) : await api.sftpRename(connectionId, entry.path, newName);
      showStatus(t('Zmieniono nazwę „{from}” na „{to}”', { from: entry.name, to: baseName(path) }));
      const pane = side === 'local' ? localRef.current : remoteRef.current;
      await load(side, pane.path);
      // Keep a running search in sync (the results are not re-run)
      setters[side]((p) => ({
        ...p,
        selected: [path],
        anchor: path,
        searchResults: p.searchResults?.map((r) => (r.path === entry.path ? { ...r, path, name: baseName(path) } : r)) ?? null,
      }));
      return true;
    } catch (err: any) {
      showStatus(t('Nie udało się zmienić nazwy: {p0}', { p0: err?.message || err }), 'error');
      return false;
    }
  };

  const moveTo = useCallback(
    async (side: Side, paths: string[], targetDir: string) => {
      if (paths.length === 0) return;
      if (busyRef.current) {
        showBusyNotice();
        return;
      }
      try {
        const n = side === 'local' ? await api.localMove(paths, targetDir) : await api.sftpMove(connectionId, paths, targetDir);
        showStatus(
          n === 0
            ? t('Elementy są już w katalogu „{dir}”', { dir: targetDir })
            : tn(n, ['Przeniesiono {n} element do „{dir}”', 'Przeniesiono {n} elementy do „{dir}”', 'Przeniesiono {n} elementów do „{dir}”'], { n, dir: targetDir })
        );
      } catch (err: any) {
        showStatus(t('Nie udało się przenieść: {p0}', { p0: err?.message || err }), 'error');
      } finally {
        const pane = side === 'local' ? localRef.current : remoteRef.current;
        load(side, pane.path);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionId, showStatus, showBusyNotice, t]
  );

  const applyChmod = async (entries: SftpFileEntry[], mode: number, recursive: boolean, scope: 'all' | 'files' | 'dirs') => {
    if (busyRef.current) {
      showBusyNotice();
      return;
    }
    const label = t('Zmiana uprawnień…');
    busyRef.current = label;
    setBusy(label);
    setStatus(null);
    setProgress(null);
    try {
      const n = await api.sftpChmod(connectionId, entries.map((e) => e.path), mode, recursive, scope);
      showStatus(
        tn(n, ['Zmieniono uprawnienia {n} elementu na {mode}', 'Zmieniono uprawnienia {n} elementów na {mode}', 'Zmieniono uprawnienia {n} elementów na {mode}'], {
          n,
          mode: mode.toString(8).padStart(3, '0'),
        })
      );
    } catch (err: any) {
      showStatus(t('Nie udało się zmienić uprawnień: {p0}', { p0: err?.message || err }), 'error');
    } finally {
      busyRef.current = null;
      setBusy(null);
      await loadRemote(remoteRef.current.path);
    }
  };

  const pendingDragRef = useRef<{ from: Side; path: string; x: number; y: number } | null>(null);
  const dragRef = useRef<DragInfo | null>(null);
  dragRef.current = drag;
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const pending = pendingDragRef.current;
      if (!pending) return;
      if (!dragRef.current) {
        if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 6) return;
        const pane = pending.from === 'local' ? local : remote;
        const paths = pane.selected.includes(pending.path) ? pane.selected : [pending.path];
        const label = paths.length === 1 ? baseName(paths[0]) : tn(paths.length, ['{length} element', '{length} elementy', '{length} elementów'], { length: paths.length });
        setDrag({ from: pending.from, paths, label, x: e.clientX, y: e.clientY, overSide: null, overFolder: null });
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const paneEl = el?.closest('[data-sftp-pane]') as HTMLElement | null;
      const dirEl = el?.closest('[data-sftp-dir]') as HTMLElement | null;
      const overSide = (paneEl?.dataset.sftpPane as Side) || null;
      setDrag((d) =>
        d
          ? {
              ...d,
              x: e.clientX,
              y: e.clientY,
              overSide,
              overFolder: dirEl && dirEl.dataset.sftpSide === overSide ? dirEl.dataset.sftpDir || null : null,
            }
          : d
      );
    };
    const onUp = () => {
      const d = dragRef.current;
      pendingDragRef.current = null;
      if (d) {
        suppressClickRef.current = true;
        setTimeout(() => (suppressClickRef.current = false), 0);
        setDrag(null);
        if (d.overSide && d.overSide !== d.from) {
          transfer(d.from, d.paths, d.overFolder ?? undefined);
        } else if (d.overSide === d.from && d.overFolder && !d.paths.includes(d.overFolder)) {
          moveTo(d.from, d.paths, d.overFolder);
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [local, remote, transfer, moveTo]);

  // --- Other actions ------------------------------------------------------------------------------
  const mkdir = async (side: Side, name: string) => {
    const pane = panes[side];
    try {
      if (side === 'local') await api.localMkdir(pane.path, name);
      else await api.sftpMkdir(connectionId, pane.path, name);
      showStatus(t('Utworzono katalog „{name}”', { name }));
      load(side, pane.path);
    } catch (err: any) {
      showStatus(t('Nie udało się utworzyć katalogu: {p0}', { p0: err?.message || err }), 'error');
    }
  };

  /** New empty file – created, selected in the list and opened in the editor. */
  const mkfile = async (side: Side, name: string) => {
    const pane = panes[side];
    try {
      const path = side === 'local' ? await api.localMkfile(pane.path, name) : await api.sftpMkfile(connectionId, pane.path, name);
      showStatus(t('Utworzono plik „{name}”', { name }));
      await load(side, pane.path);
      setters[side]((p) => ({ ...p, selected: [path], anchor: path }));
      setPreview({ side, path, name, edit: true });
    } catch (err: any) {
      showStatus(t('Nie udało się utworzyć pliku: {p0}', { p0: err?.message || err }), 'error');
    }
  };

  const search = async (side: Side, query: string) => {
    const pane = panes[side];
    if (!query.trim()) return;
    setters[side]((p) => ({ ...p, searching: true, selected: [], anchor: null }));
    try {
      const results =
        side === 'local'
          ? await api.localSearch(pane.path, query)
          : await api.sftpSearch(connectionId, pane.path, query);
      setters[side]((p) => ({ ...p, searching: false, searchResults: results, searchedFor: query }));
    } catch (err: any) {
      setters[side]((p) => ({ ...p, searching: false }));
      showStatus(t('Błąd wyszukiwania: {p0}', { p0: err?.message || err }), 'error');
    }
  };

  const deleteRemote = (paths: string[]) => {
    if (paths.length === 0) return;
    if (busyRef.current) { showBusyNotice(); return; }
    setConfirm({
      title: t('Usunąć z serwera?'),
      message:
        tn(paths.length, ['Zostanie trwale usunięty {length} element (katalogi razem z zawartością): ', 'Zostaną trwale usunięte {length} elementy (katalogi razem z zawartością): ', 'Zostanie trwale usuniętych {length} elementów (katalogi razem z zawartością): '], { length: paths.length }) +
        paths.slice(0, 6).map(baseName).join(', ') +
        (paths.length > 6 ? '…' : ''),
      label: t('Usuń'),
      run: async () => {
        if (busyRef.current) { showBusyNotice(); return; }
        let completed = 0;
        const label = t('Usuwanie z serwera: {current}/{total} — {path}', { current: 1, total: paths.length, path: paths[0] });
        busyRef.current = label;
        setBusy(label);
        setStatus(null);
        setProgress(null);
        try {
          for (const path of paths) {
            const current = t('Usuwanie z serwera: {current}/{total} — {path}', { current: completed + 1, total: paths.length, path });
            busyRef.current = current;
            setBusy(current);
            await api.sftpDeletePaths(connectionId, [path]);
            completed++;
          }
          const text = tn(completed, ['Usunięto {length} element', 'Usunięto {length} elementy', 'Usunięto {length} elementów'], { length: completed });
          showStatus(text);
          onNotify?.(text);
        } catch (err: any) {
          showStatus(t('Błąd usuwania po {completed}/{total} elementach: {error}', { completed, total: paths.length, error: err?.message || err }), 'error');
        } finally {
          await loadRemote(remote.path);
          busyRef.current = null;
          setBusy(null);
        }
      },
    });
  };

  /**
   * Local files go to the Recycle Bin / trash. When the trash is not available (e.g. a network
   * drive or a removable disk without one), a second question offers deleting them permanently.
   */
  const deleteLocal = (paths: string[], permanent = false) => {
    if (paths.length === 0) return;
    if (busyRef.current) { showBusyNotice(); return; }
    const names = paths.slice(0, 6).map(baseName).join(', ') + (paths.length > 6 ? '…' : '');
    setConfirm({
      title: permanent ? t('Usunąć trwale z tego komputera?') : t('Przenieść do kosza?'),
      message:
        (permanent
          ? tn(paths.length, ['Kosz jest niedostępny. Zostanie trwale usunięty {length} element (katalogi razem z zawartością) – bez możliwości przywrócenia: ', 'Kosz jest niedostępny. Zostaną trwale usunięte {length} elementy (katalogi razem z zawartością) – bez możliwości przywrócenia: ', 'Kosz jest niedostępny. Zostanie trwale usuniętych {length} elementów (katalogi razem z zawartością) – bez możliwości przywrócenia: '], { length: paths.length })
          : tn(paths.length, ['Do kosza zostanie przeniesiony {length} element z tego komputera: ', 'Do kosza zostaną przeniesione {length} elementy z tego komputera: ', 'Do kosza zostanie przeniesionych {length} elementów z tego komputera: '], { length: paths.length })) + names,
      label: permanent ? t('Usuń trwale') : t('Przenieś do kosza'),
      run: async () => {
        if (busyRef.current) { showBusyNotice(); return; }
        let completed = 0;
        busyRef.current = t('Usuwanie: {current}/{total} — {path}', { current: 1, total: paths.length, path: paths[0] });
        setBusy(busyRef.current);
        setStatus(null);
        setProgress(null);
        let trashUnavailable = false;
        try {
          for (const path of paths) {
            const current = t('Usuwanie: {current}/{total} — {path}', { current: completed + 1, total: paths.length, path });
            busyRef.current = current;
            setBusy(current);
            await api.localDeletePaths([path], permanent);
            completed++;
          }
          const text = permanent
            ? tn(completed, ['Usunięto {length} element', 'Usunięto {length} elementy', 'Usunięto {length} elementów'], { length: completed })
            : tn(completed, ['Przeniesiono do kosza {length} element', 'Przeniesiono do kosza {length} elementy', 'Przeniesiono do kosza {length} elementów'], { length: completed });
          showStatus(text);
          onNotify?.(text);
        } catch (err: any) {
          const msg = String(err?.message || err);
          trashUnavailable = msg.startsWith('TRASH_UNAVAILABLE:');
          showStatus(
            t('Błąd usuwania po {completed}/{total} elementach: {error}', {
              completed,
              total: paths.length,
              error: msg.replace(/^TRASH_UNAVAILABLE:/, ''),
            }),
            'error'
          );
        } finally {
          await loadLocal(local.path);
          busyRef.current = null;
          setBusy(null);
        }
        // Offer a permanent delete of what is left
        if (trashUnavailable) deleteLocal(paths.slice(completed), true);
      },
    });
  };

  const pasteFromClipboard = async () => {
    try {
      const paths = await api.clipboardReadFiles();
      if (paths.length > 0) transfer('local', paths);
      else showStatus(t('W schowku systemowym nie ma skopiowanych plików ani katalogów'), 'error');
    } catch (err: any) {
      showStatus(t('Błąd odczytu schowka: {p0}', { p0: err?.message || err }), 'error');
    }
  };

  const saveStartDirs = async () => {
    try {
      await api.setConnectionSftpDirs(connectionId, local.path, remote.path);
      setSavedDirs({ local: local.path, remote: remote.path });
      window.dispatchEvent(new Event('remoteflow-vault-changed'));
      showStatus(
        t('Zapamiętano katalogi dla tego połączenia: {local} ↔ {remote}', { local: local.path, remote: remote.path })
      );
    } catch (err: any) {
      showStatus(t('Nie udało się zapisać katalogów: {p0}', { p0: err?.message || err }), 'error');
    }
  };

  const clearStartDirs = async () => {
    try {
      await api.setConnectionSftpDirs(connectionId, null, null);
      setSavedDirs({ local: '', remote: '' });
      window.dispatchEvent(new Event('remoteflow-vault-changed'));
      showStatus(t('Usunięto zapamiętane katalogi – SFTP będzie otwierać katalogi domowe'));
    } catch (err: any) {
      showStatus(t('Nie udało się zapisać katalogów: {p0}', { p0: err?.message || err }), 'error');
    }
  };
  const hasSavedDirs = !!(savedDirs.local || savedDirs.remote);
  const canSaveDirs = !!(local.path && remote.path);

  if (!isOpen) return null;

  return (
    <div
      className="absolute top-0 right-0 bottom-0 z-40 flex flex-col border-l border-slate-700 bg-slate-950 shadow-2xl font-sans text-xs"
      style={{ width: fullWidth ? '100%' : 'max(50%, min(760px, 100%))' }}
      onContextMenu={(e) => {
        // The SFTP window lives inside the terminal element – keep the terminal menu out of it
        e.stopPropagation();
        if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !drag) {
          e.stopPropagation();
          onClose();
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'r') {
          // Ctrl+R: refresh the pane in use (both when the focus is outside the panes). Stops here,
          // so the global Ctrl+R (reconnect the session) does not run while working in SFTP.
          e.preventDefault();
          e.stopPropagation();
          const target = e.target as Node;
          const inLocal = localPaneRef.current?.contains(target);
          const inRemote = remotePaneRef.current?.contains(target);
          if (inLocal || !inRemote) loadLocal(local.path);
          if (inRemote || !inLocal) loadRemote(remote.path);
        }
      }}
    >
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-900 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ArrowDownUp className="h-4 w-4 shrink-0 text-cyan-400" />
          <span className="font-semibold text-white">{t('Menedżer plików SFTP')}</span>
          <span className="truncate font-mono text-[10px] text-slate-400">{connectionTitle}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={saveStartDirs}
            disabled={!canSaveDirs}
            title={
              hasSavedDirs
                ? t('Zapamiętane katalogi: {local} ↔ {remote}. Kliknij, aby zapisać bieżące.', {
                    local: savedDirs.local || '~',
                    remote: savedDirs.remote || '~',
                  })
                : t('Zapamiętaj bieżące katalogi (lokalny i na serwerze) dla tego połączenia')
            }
            className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] hover:bg-slate-800 disabled:opacity-40 ${
              hasSavedDirs ? 'text-cyan-300' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Pin className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('Zapamiętaj katalogi')}</span>
          </button>
          {hasSavedDirs && (
            <button
              onClick={clearStartDirs}
              title={t('Zapomnij zapamiętane katalogi (otwieraj katalogi domowe)')}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-300"
            >
              <PinOff className="h-3.5 w-3.5" />
            </button>
          )}
        <button
          onClick={onClose}
          title={t('Zamknij (Esc)')}
          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
        </div>
      </div>

      {/* Two panes */}
      <div className="flex min-h-0 flex-1">
        <FilePane
          side="local"
          title={t('Komputer lokalny')}
          icon={<HardDrive className="h-3.5 w-3.5 text-amber-400" />}
          pane={local}
          setPane={setLocal}
          busy={!!busy}
          drag={drag}
          suppressClickRef={suppressClickRef}
          paneRef={localPaneRef}
          onPointerStart={(path, x, y) => (pendingDragRef.current = { from: 'local', path, x, y })}
          onOpen={(p) => loadLocal(p)}
          onRefresh={() => loadLocal(local.path)}
          onHome={() => loadLocal('')}
          onMkdir={(n) => mkdir('local', n)}
          onMkfile={(n) => mkfile('local', n)}
          onSearch={(q) => search('local', q)}
          onTransfer={(paths) => transfer('local', paths)}
          onDelete={(paths) => deleteLocal(paths)}
          onPreview={(e, edit) => setPreview({ side: 'local', path: e.path, name: e.name, edit })}
          onRename={(e, n) => renameEntry('local', e, n)}
          onMove={(paths) => setMoveDialog({ side: 'local', paths })}
          transferLabel={t('Wyślij')}
          transferIcon={<ArrowRight className="h-3 w-3" />}
          onPin={canSaveDirs ? saveStartDirs : undefined}
        />
        <div className="w-px shrink-0 bg-slate-700" />
        <FilePane
          side="remote"
          title={t('Serwer')}
          icon={<Server className="h-3.5 w-3.5 text-cyan-400" />}
          pane={remote}
          setPane={setRemote}
          busy={!!busy}
          drag={drag}
          suppressClickRef={suppressClickRef}
          paneRef={remotePaneRef}
          osDropOver={osDropOver}
          onPointerStart={(path, x, y) => (pendingDragRef.current = { from: 'remote', path, x, y })}
          onOpen={(p) => loadRemote(p)}
          onRefresh={() => loadRemote(remote.path)}
          onHome={() => loadRemote('')}
          onTerminalDir={terminalSessionId ? goToTerminalDir : undefined}
          onMkdir={(n) => mkdir('remote', n)}
          onMkfile={(n) => mkfile('remote', n)}
          onSearch={(q) => search('remote', q)}
          onTransfer={(paths) => transfer('remote', paths)}
          onDelete={deleteRemote}
          onPreview={(e, edit) => setPreview({ side: 'remote', path: e.path, name: e.name, edit })}
          onRename={(e, n) => renameEntry('remote', e, n)}
          onMove={(paths) => setMoveDialog({ side: 'remote', paths })}
          onChmod={(entries) => entries.length && setChmodDialog(entries)}
          transferLabel={t('Pobierz')}
          transferIcon={<ArrowLeft className="h-3 w-3" />}
          onPasteFiles={pasteFromClipboard}
          onPin={canSaveDirs ? saveStartDirs : undefined}
          transferFirst
          extraTools={
            <button
              onClick={pasteFromClipboard}
              disabled={!!busy}
              title={t('Wyślij pliki i katalogi skopiowane w systemie (Ctrl+C w menedżerze plików)')}
              className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-emerald-400 hover:bg-slate-700 disabled:opacity-40"
            >
              <ClipboardPaste className="h-3 w-3" />
            </button>
          }
        />
      </div>

      {/* Status bar */}
      <div role="status" aria-live="polite" className="flex h-7 shrink-0 items-center gap-2 border-t border-slate-800 bg-slate-900 px-3 text-[11px]">
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-cyan-400" />
            <span className="min-w-0 flex-1 truncate text-cyan-200" title={busy}>
              {cancelling ? t('Przerywanie… ') : ''}
              {busy}
              {progress ? t(' — {files} gotowych, teraz: {current}', { files: progress.files, current: progress.current }) : ''}
              {progress?.bytes ? ` (${formatBytes(progress.bytes)})` : ''}
            </span>
            {activeTransfer && (
              <button
                type="button"
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true);
                  api.sftpTransferCancel(activeTransfer).catch(() => setCancelling(false));
                }}
                title={t('Przerwij przesyłanie (pliki już przesłane pozostają)')}
                className="ml-auto flex shrink-0 items-center gap-1 rounded border border-red-500/50 bg-red-950/40 px-2 py-0.5 text-[11px] font-medium text-red-200 hover:bg-red-900/60 disabled:cursor-default disabled:opacity-50"
              >
                <CircleStop className="h-3 w-3" />
                {t('Przerwij')}
              </button>
            )}
          </>
        ) : status ? (
          <span className={`truncate ${status.type === 'error' ? 'text-red-400' : 'text-emerald-300'}`} title={status.text}>
            {status.text}
          </span>
        ) : (
          <span className="truncate text-slate-500">
            {t('Przeciągnij pliki między panelami lub zaznacz je i użyj „Wyślij” / „Pobierz”. Dwuklik na pliku przenosi go na drugą stronę. Ctrl/Shift – zaznaczanie wielu, F2 – zmiana nazwy.')}
          </span>
        )}
      </div>

      {/* Drag ghost */}
      {drag && (
        <div
          className="pointer-events-none fixed z-[80] flex items-center gap-1.5 rounded-md border border-cyan-500/60 bg-slate-900/95 px-2 py-1 text-[11px] text-cyan-100 shadow-xl"
          style={{ left: drag.x + 14, top: drag.y + 10 }}
        >
          {drag.overSide === drag.from ? null : drag.from === 'local' ? <ArrowRight className="h-3 w-3" /> : <ArrowLeft className="h-3 w-3" />}
          {drag.label}
          {drag.overSide && drag.overSide !== drag.from && (
            <span className="text-slate-400">→ {drag.overFolder ? baseName(drag.overFolder) : t('bieżący katalog')}</span>
          )}
          {drag.overSide === drag.from && drag.overFolder && !drag.paths.includes(drag.overFolder) && (
            <span className="text-amber-300">{t('przenieś do „{dir}”', { dir: baseName(drag.overFolder) })}</span>
          )}
        </div>
      )}

      {preview && (
        <React.Suspense fallback={null}>
        <FilePreview
          key={`${preview.side}:${preview.path}`}
          side={preview.side}
          connectionId={connectionId}
          path={preview.path}
          name={preview.name}
          startEditing={preview.edit}
          onClose={() => {
            const side = preview.side;
            setPreview(null);
            // Back to the list, so the keyboard keeps working (arrows, F3, Delete…)
            requestAnimationFrame(() => (side === 'local' ? localPaneRef : remotePaneRef).current?.focus({ preventScroll: true }));
          }}
          onSaved={() => (preview.side === 'local' ? loadLocal(local.path) : loadRemote(remote.path))}
        />
        </React.Suspense>
      )}

      {moveDialog && (
        <MoveDialog
          paths={moveDialog.paths}
          initialDir={(moveDialog.side === 'local' ? local : remote).path}
          onCancel={() => setMoveDialog(null)}
          onMove={(dir) => {
            const d = moveDialog;
            setMoveDialog(null);
            moveTo(d.side, d.paths, dir);
          }}
        />
      )}
      {chmodDialog && (
        <ChmodDialog
          entries={chmodDialog}
          onCancel={() => setChmodDialog(null)}
          onApply={(mode, recursive, scope) => {
            const entries = chmodDialog;
            setChmodDialog(null);
            applyChmod(entries, mode, recursive, scope);
          }}
        />
      )}
      <ConfirmDialog
        isOpen={confirm !== null}
        title={confirm?.title || ''}
        message={confirm?.message || ''}
        confirmLabel={confirm?.label || 'OK'}
        contained
        variant={confirm?.info ? 'info' : 'danger'}
        hideCancel={!!confirm?.info}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          c?.run();
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
};

// =================================================================================================
// One pane (local or remote)
// =================================================================================================
