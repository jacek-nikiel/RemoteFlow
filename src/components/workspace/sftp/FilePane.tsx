import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CheckSquare,
  ClipboardPaste,
  Copy,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Link2,
  Home,
  Loader2,
  MinusSquare,
  Pin,
  SquareTerminal,
  RefreshCw,
  Search,
  Square,
  Trash2,
  X,
  Eye,
  FilePlus,
  Pencil,
  FolderInput,
  ShieldCheck,
  TextCursorInput,
} from 'lucide-react';
import { api } from '../../../services/api';
import { SftpFileEntry } from '../../../types';
import { tn, useT } from '../../../i18n';
import { formatBytes } from '../../../utils/formatBytes';

import { Side, SortKey, PaneState, formatDate, formatDateFull, baseName, fileIcon, DragInfo } from './sftpTypes';
import { PaneContextMenu, MenuItem } from './PaneContextMenu';
import { modeString } from './SftpDialogs';

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
  /** F2: new name for an entry; resolves true when renamed (the input then closes). */
  onRename?: (entry: SftpFileEntry, newName: string) => Promise<boolean>;
  /** "Move to…" – opens the folder dialog. */
  onMove?: (paths: string[]) => void;
  /** Permissions dialog (server). */
  onChmod?: (entries: SftpFileEntry[]) => void;
}

export const FilePane: React.FC<PaneProps> = ({
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
  onRename,
  onMove,
  onChmod,
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
  // F2: path of the entry being renamed and the typed name
  const [renaming, setRenamingState] = useState<{ path: string; value: string } | null>(null);
  // Mirror of `renaming`: a blur while the rename is being saved (or after it closed) must not
  // start a second rename with the old state
  const renamingRef = useRef<{ path: string; value: string } | null>(null);
  const setRenaming = (r: { path: string; value: string } | null) => {
    renamingRef.current = r;
    setRenamingState(r);
  };
  const renameBusyRef = useRef(false);
  const startRename = (entry: SftpFileEntry) => {
    if (!onRename || busy) return;
    setRenaming({ path: entry.path, value: entry.name });
  };
  const finishRename = async (commit: boolean) => {
    const r = renamingRef.current;
    if (!r || renameBusyRef.current) return;
    const entry = visible.find((v) => v.path === r.path);
    const close = () => {
      setRenaming(null);
      paneRef?.current?.focus({ preventScroll: true });
    };
    if (!commit || !entry || !r.value.trim() || r.value.trim() === entry.name || !onRename) {
      close();
      return;
    }
    renameBusyRef.current = true;
    const ok = await onRename(entry, r.value.trim());
    if (ok) close();
    renameBusyRef.current = false;
  };

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
        } else if (e.key === 'F2' && onRename && selectedEntries.length === 1) {
          e.preventDefault();
          startRename(selectedEntries[0]);
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
            const isDropFolder =
              entry.isDir && drag && drag.overFolder === entry.path && (drag.from !== side || (!!onMove && !drag.paths.includes(entry.path)));
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
                  (entry.isDir
                    ? t('{path}\nDwuklik: otwórz', { path: entry.path })
                    : t('{path}\nDwuklik: {action}', { path: entry.path, action: transferLabel.toLowerCase() })) +
                  (side === 'remote' && entry.permissions
                    ? `\n${modeString(entry.permissions)} (${(entry.permissions & 0o7777).toString(8).padStart(3, '0')})`
                    : '')
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
                  {renaming?.path === entry.path ? (
                    <input
                      autoFocus
                      value={renaming.value}
                      spellCheck={false}
                      aria-label={t('Nowa nazwa')}
                      onFocus={(e) => {
                        // Select the name without the extension (like a file manager)
                        const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
                        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
                      }}
                      onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          finishRename(true);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          finishRename(false);
                        }
                      }}
                      onBlur={() => finishRename(true)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
                      className="min-w-0 flex-1 rounded border border-cyan-500 bg-slate-950 px-1 py-0 font-mono text-[11px] text-slate-100 outline-none"
                    />
                  ) : (
                    <span className={`truncate ${entry.isDir ? 'font-medium text-amber-100' : ''} ${entry.isLink ? 'italic' : ''}`}>
                      {entry.name}
                    </span>
                  )}
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
          {onRename && menu.entry && menu.targets.length === 1 && (
            <MenuItem icon={<TextCursorInput className="h-3.5 w-3.5 text-slate-300" />} disabled={busy} onClick={() => startRename(menu.entry!)}>
              {t('Zmień nazwę (F2)')}
            </MenuItem>
          )}
          {onMove && menu.targets.length > 0 && !inSearch && (
            <MenuItem icon={<FolderInput className="h-3.5 w-3.5 text-amber-300" />} disabled={busy} onClick={() => onMove(menu.targets)}>
              {t('Przenieś do…')}
            </MenuItem>
          )}
          {onChmod && menu.targets.length > 0 && (
            <MenuItem
              icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />}
              disabled={busy}
              onClick={() => onChmod(visible.filter((v) => menu.targets.includes(v.path)))}
            >
              {t('Uprawnienia…')}
            </MenuItem>
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
