import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckSquare,
  ClipboardPaste,
  Copy,
  File,
  FileArchive,
  FileCode,
  FileImage,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDrive,
  Link2,
  Home,
  Loader2,
  MinusSquare,
  Pin,
  PinOff,
  SquareTerminal,
  RefreshCw,
  Search,
  Server,
  Square,
  Trash2,
  X,
  CircleStop,
  Eye,
  FilePlus,
  Pencil,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getOscCwd } from '../../utils/terminalCwd';
import { api, isTauri } from '../../services/api';
import { SftpFileEntry, TransferProgress, TransferSummary } from '../../types';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
// Loaded on first use (CodeMirror is a large part of the bundle)
const FilePreview = React.lazy(() => import('./FilePreview').then((m) => ({ default: m.FilePreview })));
import { locale, tn, useT } from '../../i18n';
import { formatBytes } from '../../utils/formatBytes';
import { useMenuPosition } from '../../utils/useMenuPosition';

type Side = 'local' | 'remote';
type SortKey = 'name' | 'size' | 'modified';

interface PaneState {
  path: string;
  parent: string | null;
  entries: SftpFileEntry[];
  loading: boolean;
  error: string | null;
  /** Text typed in the search box – filters the current folder instantly. */
  filter: string;
  /** Results of a recursive search (Enter in the search box); null = normal listing. */
  searchResults: SftpFileEntry[] | null;
  searchedFor: string;
  searching: boolean;
  selected: string[];
  anchor: string | null;
  sort: { key: SortKey; asc: boolean };
}

const emptyPane = (): PaneState => ({
  path: '',
  parent: null,
  entries: [],
  loading: false,
  error: null,
  filter: '',
  searchResults: null,
  searchedFor: '',
  searching: false,
  selected: [],
  anchor: null,
  sort: { key: 'name', asc: true },
});

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
}

/** Running transfer as shown outside the window. */
export interface SftpTransferInfo {
  label: string;
  files: number;
  current: string | null;
  bytes: number;
  cancelling: boolean;
}

/** Compact modification time for the list (e.g. 23.10.26, 14:05); full date with seconds in the tooltip. */
const formatDate = (secs: number): string =>
  secs
    ? new Date(secs * 1000).toLocaleString(locale(), {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
const formatDateFull = (secs: number): string =>
  secs ? new Date(secs * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'medium' }) : '';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

const remoteParent = (p: string): string | null => {
  const clean = p.replace(/\/+$/, '');
  if (!clean || clean === '') return null;
  const idx = clean.lastIndexOf('/');
  if (idx < 0) return null;
  return idx === 0 ? '/' : clean.slice(0, idx);
};

const fileIcon = (entry: SftpFileEntry) => {
  if (entry.isDir) return <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />;
  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'].includes(ext))
    return <FileArchive className="h-3.5 w-3.5 shrink-0 text-purple-400" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext))
    return <FileImage className="h-3.5 w-3.5 shrink-0 text-pink-400" />;
  if (['sh', 'py', 'js', 'ts', 'json', 'yml', 'yaml', 'conf', 'ini', 'xml', 'sql', 'rs', 'go', 'php', 'env', 'toml'].includes(ext))
    return <FileCode className="h-3.5 w-3.5 shrink-0 text-cyan-400" />;
  return <File className="h-3.5 w-3.5 shrink-0 text-slate-400" />;
};

interface DragInfo {
  from: Side;
  paths: string[];
  label: string;
  x: number;
  y: number;
  overSide: Side | null;
  overFolder: string | null;
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
  const transferIdRef = useRef<string>('');
  // Running upload/download that can be stopped, and whether "Przerwij" was clicked
  const [activeTransfer, setActiveTransfer] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const remotePaneRef = useRef<HTMLDivElement>(null);
  const localPaneRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);

  const panes = { local, remote };
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
        }
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [local, remote, transfer]);

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
            {t('Przeciągnij pliki między panelami lub zaznacz je i użyj „Wyślij” / „Pobierz”. Dwuklik na pliku przenosi go na drugą stronę. Ctrl/Shift – zaznaczanie wielu.')}
          </span>
        )}
      </div>

      {/* Drag ghost */}
      {drag && (
        <div
          className="pointer-events-none fixed z-[80] flex items-center gap-1.5 rounded-md border border-cyan-500/60 bg-slate-900/95 px-2 py-1 text-[11px] text-cyan-100 shadow-xl"
          style={{ left: drag.x + 14, top: drag.y + 10 }}
        >
          {drag.from === 'local' ? <ArrowRight className="h-3 w-3" /> : <ArrowLeft className="h-3 w-3" />}
          {drag.label}
          {drag.overSide && drag.overSide !== drag.from && (
            <span className="text-slate-400">→ {drag.overFolder ? baseName(drag.overFolder) : t('bieżący katalog')}</span>
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

interface PaneProps {
  side: Side;
  title: string;
  icon: React.ReactNode;
  pane: PaneState;
  setPane: React.Dispatch<React.SetStateAction<PaneState>>;
  busy: boolean;
  drag: DragInfo | null;
  suppressClickRef: React.MutableRefObject<boolean>;
  paneRef?: React.RefObject<HTMLDivElement | null>;
  osDropOver?: boolean;
  onPointerStart: (path: string, x: number, y: number) => void;
  onOpen: (path: string) => void;
  onRefresh: () => void;
  onHome: () => void;
  /** Server pane: go to the directory of the shell in the SSH terminal */
  onTerminalDir?: () => void;
  onMkdir: (name: string) => void;
  /** New empty file (opened in the editor). */
  onMkfile?: (name: string) => void;
  onSearch: (query: string) => void;
  onTransfer: (paths: string[]) => void;
  onDelete?: (paths: string[]) => void;
  /** Opens a file: F3 = view (read-only), F4 = edit. */
  onPreview?: (entry: SftpFileEntry, edit: boolean) => void;
  transferLabel: string;
  transferIcon: React.ReactNode;
  transferFirst?: boolean;
  extraTools?: React.ReactNode;
  /** Context menu extras */
  onPasteFiles?: () => void;
  onPin?: () => void;
}

const FilePane: React.FC<PaneProps> = ({
  side,
  title,
  icon,
  pane,
  setPane,
  busy,
  drag,
  suppressClickRef,
  paneRef,
  osDropOver,
  onPointerStart,
  onOpen,
  onRefresh,
  onHome,
  onTerminalDir,
  onMkdir,
  onMkfile,
  onSearch,
  onTransfer,
  onDelete,
  onPreview,
  transferLabel,
  transferIcon,
  transferFirst,
  extraTools,
  onPasteFiles,
  onPin,
}) => {
  const t = useT();
  const [pathInput, setPathInput] = useState(pane.path);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: SftpFileEntry | null; targets: string[] } | null>(null);
  // Name being typed for a new folder / file (null = no input shown)
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<'dir' | 'file'>('dir');
  const startNew = (kind: 'dir' | 'file') => {
    setNewKind(kind);
    setNewFolder(kind === 'file' ? '.txt' : '');
  };
  useEffect(() => setPathInput(pane.path), [pane.path]);

  const inSearch = pane.searchResults !== null;
  const visible = useMemo(() => {
    const base = pane.searchResults ?? pane.entries;
    const f = inSearch ? '' : pane.filter.trim().toLowerCase();
    const list = f ? base.filter((e) => e.name.toLowerCase().includes(f)) : [...base];
    const { key, asc } = pane.sort;
    list.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (key === 'name') r = a.name.localeCompare(b.name, 'pl', { sensitivity: 'base', numeric: true });
      else if (key === 'size') r = a.size - b.size;
      else r = a.modified - b.modified;
      return asc ? r : -r;
    });
    return list;
  }, [pane.entries, pane.searchResults, pane.filter, pane.sort, inSearch]);

  const selectedSet = useMemo(() => new Set(pane.selected), [pane.selected]);
  const selectedEntries = visible.filter((e) => selectedSet.has(e.path));
  const selectedBytes = selectedEntries.reduce((s, e) => s + (e.isDir ? 0 : e.size), 0);
  const allSelected = visible.length > 0 && visible.every((e) => selectedSet.has(e.path));

  const isDropTarget = !!drag && drag.from !== side && drag.overSide === side;

  const rowClick = (e: React.MouseEvent, entry: SftpFileEntry) => {
    if (suppressClickRef.current) return;
    setPane((p) => {
      if (e.shiftKey && p.anchor) {
        const a = visible.findIndex((v) => v.path === p.anchor);
        const b = visible.findIndex((v) => v.path === entry.path);
        if (a >= 0 && b >= 0) {
          const range = visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((v) => v.path);
          return { ...p, selected: Array.from(new Set([...(e.ctrlKey || e.metaKey ? p.selected : []), ...range])) };
        }
      }
      if (e.ctrlKey || e.metaKey) {
        const sel = p.selected.includes(entry.path)
          ? p.selected.filter((s) => s !== entry.path)
          : [...p.selected, entry.path];
        return { ...p, selected: sel, anchor: entry.path };
      }
      return { ...p, selected: [entry.path], anchor: entry.path };
    });
  };

  const toggle = (path: string) =>
    setPane((p) => ({
      ...p,
      selected: p.selected.includes(path) ? p.selected.filter((s) => s !== path) : [...p.selected, path],
      anchor: path,
    }));

  const toggleAll = () =>
    setPane((p) => ({ ...p, selected: allSelected ? [] : visible.map((v) => v.path) }));

  const sortBy = (key: SortKey) =>
    setPane((p) => ({ ...p, sort: { key, asc: p.sort.key === key ? !p.sort.asc : true } }));

  const sortMark = (key: SortKey) => (pane.sort.key === key ? (pane.sort.asc ? ' ▲' : ' ▼') : '');

  const relPath = (entry: SftpFileEntry) => {
    const root = pane.path.replace(/[\\/]+$/, '');
    const parent = entry.path.slice(0, entry.path.length - entry.name.length).replace(/[\\/]+$/, '');
    return parent.startsWith(root) ? parent.slice(root.length).replace(/^[\\/]/, '') || '.' : parent;
  };

  const transferButton = (
    <button
      onClick={() => onTransfer(pane.selected)}
      disabled={busy || pane.selected.length === 0}
      title={t('{transferLabel} zaznaczone ({length})', { transferLabel, length: pane.selected.length })}
      className="flex h-6 items-center gap-1 rounded bg-cyan-600 px-2 font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:hover:bg-cyan-600"
    >
      {transferFirst && transferIcon}
      <span>
        {transferLabel}
        {pane.selected.length ? ` (${pane.selected.length})` : ''}
      </span>
      {!transferFirst && transferIcon}
    </button>
  );

  return (
    <div
      ref={paneRef}
      data-sftp-pane={side}
      tabIndex={-1}
      onContextMenu={(e) => {
        // Never let the right click reach the terminal / application menus behind the SFTP window
        e.stopPropagation();
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') return; // keep the native cut/copy/paste menu in text fields
        e.preventDefault();
        const row = target.closest('[data-sftp-row]') as HTMLElement | null;
        const entry = row ? visible.find((v) => v.path === row.dataset.sftpRow) ?? null : null;
        let targets = pane.selected;
        if (entry && !selectedSet.has(entry.path)) {
          targets = [entry.path];
          setPane((p) => ({ ...p, selected: [entry.path], anchor: entry.path }));
        }
        (e.currentTarget as HTMLElement).focus({ preventScroll: true });
        setMenu({ x: e.clientX, y: e.clientY, entry, targets });
      }}
      onKeyDown={(e) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT') return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          setPane((p) => ({ ...p, selected: visible.map((v) => v.path) }));
        } else if (e.key === 'Backspace' && pane.parent && !inSearch) {
          e.preventDefault();
          onOpen(pane.parent);
        } else if ((e.key === 'F3' || e.key === 'F4') && onPreview && selectedEntries.length === 1 && !selectedEntries[0].isDir) {
          e.preventDefault();
          onPreview(selectedEntries[0], e.key === 'F4');
        } else if (e.key === 'Delete' && onDelete && pane.selected.length) {
          e.preventDefault();
          onDelete(pane.selected);
        } else if (e.key === 'Enter' && selectedEntries.length === 1 && selectedEntries[0].isDir) {
          e.preventDefault();
          onOpen(selectedEntries[0].path);
        }
      }}
      className={`@container relative flex min-w-0 flex-1 flex-col outline-none ${
        isDropTarget || osDropOver ? 'bg-cyan-950/30 ring-2 ring-inset ring-cyan-500/70' : ''
      }`}
    >
      {/* Title + transfer */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-2">
        <div className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-200">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        {transferButton}
      </div>

      {/* Toolbar: navigation, path, new folder, search */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-slate-800 px-2 py-1">
        <button
          onClick={() => pane.parent && onOpen(pane.parent)}
          disabled={!pane.parent || pane.loading}
          title={t('Katalog nadrzędny (Backspace)')}
          className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <button
          onClick={onHome}
          title={t('Katalog domowy')}
          className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          <Home className="h-3 w-3" />
        </button>
        {onTerminalDir && (
          <button
            onClick={onTerminalDir}
            disabled={pane.loading}
            title={t('Przejdź do katalogu, w którym jesteś w terminalu SSH')}
            className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-emerald-300 hover:bg-slate-700 disabled:opacity-40"
          >
            <SquareTerminal className="h-3 w-3" />
          </button>
        )}
        <button
          onClick={onRefresh}
          title={t('Odśwież (Ctrl+R)')}
          className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          <RefreshCw className={`h-3 w-3 ${pane.loading ? 'animate-spin' : ''}`} />
        </button>
        <input
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onOpen(pathInput.trim());
          }}
          title={pane.path}
          className="h-6 min-w-[64px] flex-1 rounded border border-slate-700 bg-slate-950 px-2 font-mono text-[10.5px] text-slate-200 focus:border-cyan-500 focus:outline-none"
        />
        <button
          onClick={() => startNew('dir')}
          title={t('Nowy katalog')}
          className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-amber-300 hover:bg-slate-700"
        >
          <FolderPlus className="h-3 w-3" />
        </button>
        {onMkfile && (
          <button
            onClick={() => startNew('file')}
            title={t('Nowy plik')}
            className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-cyan-300 hover:bg-slate-700"
          >
            <FilePlus className="h-3 w-3" />
          </button>
        )}
        {extraTools}
        {onPreview && (
          <button
            onClick={() => selectedEntries.length === 1 && !selectedEntries[0].isDir && onPreview(selectedEntries[0], false)}
            disabled={selectedEntries.length !== 1 || selectedEntries[0].isDir}
            title={t('Podgląd pliku (F3)')}
            className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
          >
            <Eye className="h-3 w-3" />
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(pane.selected)}
            disabled={busy || pane.selected.length === 0}
            title={side === 'local' ? t('Przenieś zaznaczone do kosza (Delete)') : t('Usuń zaznaczone z serwera (Delete)')}
            className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-red-500/20 hover:text-red-400 disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
        <div className="relative flex h-6 w-full items-center @md:w-44">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-slate-500" />
          <input
            value={pane.filter}
            onChange={(e) => setPane((p) => ({ ...p, filter: e.target.value, searchResults: e.target.value ? p.searchResults : null }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSearch(pane.filter);
              if (e.key === 'Escape') {
                e.stopPropagation();
                setPane((p) => ({ ...p, filter: '', searchResults: null }));
              }
            }}
            placeholder={t('Filtruj… (Enter: szukaj głębiej)')}
            title={t('Pisanie filtruje bieżący katalog. Enter przeszukuje także podkatalogi.')}
            className="h-6 w-full rounded border border-slate-700 bg-slate-950 pl-6 pr-6 text-[10.5px] text-slate-200 placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          {(pane.filter || inSearch) && (
            <button
              onClick={() => setPane((p) => ({ ...p, filter: '', searchResults: null }))}
              className="absolute right-1.5 text-slate-500 hover:text-white"
              title={t('Wyczyść')}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Search banner */}
      {(inSearch || pane.searching) && (
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 bg-cyan-950/40 px-2 py-1 text-[10.5px] text-cyan-200">
          {pane.searching ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> {t('Przeszukiwanie podkatalogów…')}
            </span>
          ) : (
            <span>
              {t('Wyniki dla „{q}” w {path}: {n}', { q: pane.searchedFor, path: pane.path, n: pane.searchResults?.length ?? 0 })}
              {(pane.searchResults?.length ?? 0) >= 500 ? t(' (pokazano pierwsze 500)') : ''}
            </span>
          )}
          <button
            onClick={() => setPane((p) => ({ ...p, filter: '', searchResults: null }))}
            className="text-cyan-300 hover:text-white"
          >
            {t('Zamknij wyniki')}
          </button>
        </div>
      )}

      {/* Column headers */}
      <div className="grid shrink-0 grid-cols-[22px_1fr_58px_104px] @md:grid-cols-[22px_1fr_70px_120px] items-center border-b border-slate-800 bg-slate-900/40 px-1 py-1 text-[10px] font-semibold text-slate-400">
        <button onClick={toggleAll} className="flex justify-center text-slate-400 hover:text-cyan-300" title={t('Zaznacz wszystko (Ctrl+A)')}>
          {allSelected ? (
            <CheckSquare className="h-3.5 w-3.5 text-cyan-400" />
          ) : pane.selected.length ? (
            <MinusSquare className="h-3.5 w-3.5 text-cyan-400" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
        <button onClick={() => sortBy('name')} className="text-left hover:text-white">
          {t('Nazwa')}{sortMark('name')}
        </button>
        <button onClick={() => sortBy('size')} className="text-right hover:text-white pr-1">
          {t('Rozmiar')}{sortMark('size')}
        </button>
        <button onClick={() => sortBy('modified')} className="truncate text-right hover:text-white pr-1">
          {t('Zmodyfikowano')}{sortMark('modified')}
        </button>
      </div>

      {/* List */}
      <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto select-none">
        {newFolder !== null && (
          <div className="flex items-center gap-1.5 border-b border-slate-800 bg-amber-950/20 px-2 py-1">
            {newKind === 'file' ? <FilePlus className="h-3.5 w-3.5 shrink-0 text-cyan-400" /> : <FolderPlus className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
            <input
              autoFocus
              // New file: the cursor goes before the suggested ".txt"
              onFocus={(e) => newKind === 'file' && e.currentTarget.setSelectionRange(0, 0)}
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newFolder.trim()) {
                  if (newKind === 'file') onMkfile?.(newFolder.trim());
                  else onMkdir(newFolder.trim());
                  setNewFolder(null);
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setNewFolder(null);
                }
              }}
              onBlur={() => setNewFolder(null)}
              placeholder={newKind === 'file' ? t('Nazwa nowego pliku – Enter, aby utworzyć i otworzyć') : t('Nazwa nowego katalogu – Enter, aby utworzyć')}
              className="h-6 flex-1 rounded border border-amber-500/50 bg-slate-950 px-2 text-[11px] text-white focus:outline-none"
            />
          </div>
        )}

        {/* ".." – parent folder entry (like FileZilla / WinSCP); also a drop target */}
        {pane.parent && !inSearch && !(pane.loading && pane.entries.length === 0) && (
          <div
            data-sftp-dir={pane.parent}
            data-sftp-side={side}
            onDoubleClick={() => onOpen(pane.parent!)}
            title={t('Katalog nadrzędny: {path}\nDwuklik: otwórz (Backspace)', { path: pane.parent })}
            className={`grid cursor-default grid-cols-[22px_1fr_58px_104px] @md:grid-cols-[22px_1fr_70px_120px] items-center px-1 py-[3px] text-[11px] ${
              drag && drag.from !== side && drag.overFolder === pane.parent
                ? 'bg-cyan-700/40 ring-1 ring-inset ring-cyan-400'
                : 'text-slate-300 hover:bg-slate-800/60'
            }`}
          >
            <span />
            <div className="flex min-w-0 items-center gap-1.5">
              <FolderUp className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="font-mono font-medium text-amber-100">..</span>
            </div>
            <span />
            <span />
          </div>
        )}

        {pane.error ? (
          <div className="m-2 rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-300">{pane.error}</div>
        ) : pane.loading && pane.entries.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Wczytywanie…
          </div>
        ) : visible.length === 0 ? (
          <div className="py-8 text-center text-[11px] text-slate-500">
            {inSearch ? t('Brak wyników') : pane.filter ? t('Brak elementów pasujących do filtra') : t('Katalog jest pusty')}
          </div>
        ) : (
          visible.map((entry) => {
            const selected = selectedSet.has(entry.path);
            const isDropFolder = entry.isDir && drag && drag.from !== side && drag.overFolder === entry.path;
            return (
              <div
                key={entry.path}
                data-sftp-row={entry.path}
                data-sftp-dir={entry.isDir ? entry.path : undefined}
                data-sftp-side={side}
                onMouseDown={(e) => {
                  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
                  (e.currentTarget.closest('[data-sftp-pane]') as HTMLElement | null)?.focus({ preventScroll: true });
                  onPointerStart(entry.path, e.clientX, e.clientY);
                }}
                onClick={(e) => rowClick(e, entry)}
                onDoubleClick={() => (entry.isDir ? onOpen(entry.path) : onTransfer([entry.path]))}
                title={
                  entry.isDir
                    ? t('{path}\nDwuklik: otwórz', { path: entry.path })
                    : t('{path}\nDwuklik: {action}', { path: entry.path, action: transferLabel.toLowerCase() })
                }
                className={`grid cursor-default grid-cols-[22px_1fr_58px_104px] @md:grid-cols-[22px_1fr_70px_120px] items-center px-1 py-[3px] text-[11px] ${
                  isDropFolder
                    ? 'bg-cyan-700/40 ring-1 ring-inset ring-cyan-400'
                    : selected
                      ? 'bg-cyan-900/45 text-white'
                      : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(entry.path);
                  }}
                  className="flex justify-center text-slate-500 hover:text-cyan-300"
                >
                  {selected ? <CheckSquare className="h-3.5 w-3.5 text-cyan-400" /> : <Square className="h-3.5 w-3.5" />}
                </button>
                <div className="flex min-w-0 items-center gap-1.5">
                  {fileIcon(entry)}
                  <span className={`truncate ${entry.isDir ? 'font-medium text-amber-100' : ''} ${entry.isLink ? 'italic' : ''}`}>
                    {entry.name}
                  </span>
                  {entry.isLink && (
                    <span title={t('Dowiązanie symboliczne')} className="shrink-0">
                      <Link2 className="h-3 w-3 text-cyan-400/80" />
                    </span>
                  )}
                  {inSearch && <span className="truncate font-mono text-[9.5px] text-slate-500">{relPath(entry)}</span>}
                </div>
                <div className="pr-1 text-right font-mono text-[10px] text-slate-500">{entry.isDir ? '' : formatBytes(entry.size)}</div>
                <div className="truncate pl-1.5 pr-1 text-right font-mono text-[10px] text-slate-500" title={formatDateFull(entry.modified)}>
                  {formatDate(entry.modified)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex h-6 shrink-0 items-center justify-between border-t border-slate-800 px-2 text-[10px] text-slate-500">
        <span>
          {tn(visible.length, ['{n} element', '{n} elementy', '{n} elementów'], { n: visible.length })}
          {pane.selected.length > 0 &&
            ' · ' + t('zaznaczono {n}', { n: pane.selected.length }) + (selectedBytes ? ` (${formatBytes(selectedBytes)})` : '')}
        </span>
        {side === 'remote' && <span className="hidden @md:inline">{t('Upuść tu pliki z systemu, aby je wysłać')}</span>}
      </div>

      {menu && (
        <PaneContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.entry?.isDir && (
            <MenuItem icon={<FolderOpen className="h-3.5 w-3.5 text-amber-400" />} onClick={() => onOpen(menu.entry!.path)}>
              {t('Otwórz')}
            </MenuItem>
          )}
          {menu.targets.length > 0 && (
            <MenuItem icon={transferIcon} disabled={busy} onClick={() => onTransfer(menu.targets)}>
              {transferLabel} {menu.targets.length > 1 ? t('zaznaczone ({length})', { length: menu.targets.length }) : t('„{name}”', { name: baseName(menu.targets[0]) })}
            </MenuItem>
          )}
          {onPreview && menu.entry && !menu.entry.isDir && (
            <>
              <MenuItem icon={<Eye className="h-3.5 w-3.5 text-cyan-300" />} onClick={() => onPreview(menu.entry!, false)}>
                {t('Podgląd (F3)')}
              </MenuItem>
              <MenuItem icon={<Pencil className="h-3.5 w-3.5 text-cyan-300" />} onClick={() => onPreview(menu.entry!, true)}>
                {t('Edytuj (F4)')}
              </MenuItem>
            </>
          )}
          {onDelete && menu.targets.length > 0 && (
            <MenuItem icon={<Trash2 className="h-3.5 w-3.5 text-red-400" />} danger disabled={busy} onClick={() => onDelete(menu.targets)}>
              {side === 'local' ? t('Przenieś do kosza') : t('Usuń')}{menu.targets.length > 1 ? ` (${menu.targets.length})` : ''}
            </MenuItem>
          )}
          {menu.entry && (
            <MenuItem
              icon={<Copy className="h-3.5 w-3.5 text-slate-400" />}
              onClick={() => api.clipboardWriteText(menu.entry!.path).catch(() => {})}
            >
              {t('Kopiuj ścieżkę')}
            </MenuItem>
          )}
          {(menu.entry || menu.targets.length > 0) && <div className="my-1 border-t border-slate-800" />}
          <MenuItem icon={<FolderPlus className="h-3.5 w-3.5 text-amber-300" />} onClick={() => startNew('dir')}>
            {t('Nowy katalog')}
          </MenuItem>
          {onMkfile && (
            <MenuItem icon={<FilePlus className="h-3.5 w-3.5 text-cyan-300" />} onClick={() => startNew('file')}>
              {t('Nowy plik')}
            </MenuItem>
          )}
          {onPasteFiles && (
            <MenuItem icon={<ClipboardPaste className="h-3.5 w-3.5 text-emerald-400" />} disabled={busy} onClick={onPasteFiles}>
              {t('Wyślij pliki ze schowka systemu')}
            </MenuItem>
          )}
          {onPin && (
            <MenuItem icon={<Pin className="h-3.5 w-3.5 text-slate-400" />} onClick={onPin}>
              {t('Zapamiętaj bieżące katalogi dla połączenia')}
            </MenuItem>
          )}
          {pane.parent && !inSearch && (
            <MenuItem icon={<ArrowUp className="h-3.5 w-3.5 text-slate-400" />} onClick={() => onOpen(pane.parent!)}>
              {t('Katalog nadrzędny')}
            </MenuItem>
          )}
          <MenuItem icon={<RefreshCw className="h-3.5 w-3.5 text-slate-400" />} onClick={onRefresh}>
            {t('Odśwież')}
          </MenuItem>
          <MenuItem
            icon={<CheckSquare className="h-3.5 w-3.5 text-slate-400" />}
            onClick={() => setPane((p) => ({ ...p, selected: visible.map((v) => v.path) }))}
          >
            {t('Zaznacz wszystko')}
          </MenuItem>
        </PaneContextMenu>
      )}
    </div>
  );
};

// =================================================================================================
// Context menu of a pane
// =================================================================================================

const PaneContextMenu: React.FC<{ x: number; y: number; onClose: () => void; children: React.ReactNode }> = ({
  x,
  y,
  onClose,
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const menuStyle = useMenuPosition(ref, { x, y });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // close only the menu, not the whole SFTP window
        onClose();
      }
    };
    const onScroll = () => onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onScroll, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClose}
      style={menuStyle}
      className="fixed z-[75] min-w-52 rounded-lg border border-slate-700 bg-slate-900/95 py-1 text-xs text-slate-200 shadow-xl shadow-black/50 backdrop-blur-md"
    >
      {children}
    </div>
  );
};

const MenuItem: React.FC<{
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ icon, onClick, disabled, danger, children }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors disabled:opacity-40 disabled:hover:bg-transparent ${
      danger ? 'hover:bg-red-500/20 hover:text-red-300' : 'hover:bg-slate-800'
    }`}
  >
    <span className="flex w-3.5 shrink-0 justify-center">{icon}</span>
    <span className="truncate">{children}</span>
  </button>
);
