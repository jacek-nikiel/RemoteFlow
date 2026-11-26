import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CornerDownLeft, Monitor, Search, SquareTerminal, Zap } from 'lucide-react';
import { useT } from '../../i18n';
import { Connection, Group, SessionInfo } from '../../types';
import { fuzzyScore } from '../../utils/fuzzy';
import { formatQuickTarget, parseQuickConnect, QuickTarget } from '../../utils/quickConnect';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  connections: Connection[];
  groups: Group[];
  sessions: SessionInfo[];
  /** `newTab`: open another tab even when the connection is already open (Shift+Enter). */
  onConnect: (conn: Connection, newTab: boolean) => void;
  onQuickConnect: (target: QuickTarget, auth: { sshAuthType: 'password' | 'agent'; password: string }) => Promise<void>;
}

type Item =
  | { kind: 'quick'; target: QuickTarget }
  | { kind: 'conn'; conn: Connection; path: string; open: boolean };

const MAX_CONNECTIONS = 60;

/** Ctrl+K / Ctrl+Shift+K: find a saved connection or connect to an address typed in. */
export const CommandPalette: React.FC<Props> = ({ isOpen, onClose, connections, groups, sessions, onConnect, onQuickConnect }) => {
  const t = useT();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  // Quick Connect step: user name, login method and password for the typed address
  const [quick, setQuick] = useState<QuickTarget | null>(null);
  const [quickUser, setQuickUser] = useState('');
  const [quickAuth, setQuickAuth] = useState<'password' | 'agent'>('password');
  const [quickPassword, setQuickPassword] = useState('');
  const [quickBusy, setQuickBusy] = useState(false);
  const [quickError, setQuickError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const quickUserRef = useRef<HTMLInputElement>(null);
  const quickPasswordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setIndex(0);
    setQuick(null);
    setQuickPassword('');
    setQuickError('');
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Keep the keyboard in the palette: a session behind it (the RDP picture captures keys while
  // it has the focus, the terminal too) must not take the focus back while the palette is open
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const onFocusIn = (e: FocusEvent) => {
      const root = rootRef.current;
      const target = e.target as Node | null;
      if (!root || (target && root.contains(target))) return;
      // A dialog opened above the palette (e.g. the password prompt) keeps its focus
      if (target instanceof HTMLElement && target.closest('[role="dialog"]')) return;
      setTimeout(() => (quickPasswordRef.current ?? quickUserRef.current ?? inputRef.current)?.focus({ preventScroll: true }), 0);
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [isOpen]);

  const groupPath = useMemo(() => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    const cache = new Map<string, string>();
    const path = (id: string | null | undefined): string => {
      if (!id) return '';
      if (cache.has(id)) return cache.get(id)!;
      const names: string[] = [];
      const seen = new Set<string>();
      let g = byId.get(id);
      while (g && !seen.has(g.id)) {
        seen.add(g.id);
        names.unshift(g.name);
        g = g.parentId ? byId.get(g.parentId) : undefined;
      }
      const p = names.join(' / ');
      cache.set(id, p);
      return p;
    };
    return path;
  }, [groups]);

  const openIds = useMemo(() => new Set(sessions.map((s) => s.connectionId)), [sessions]);

  const items: Item[] = useMemo(() => {
    const q = query.trim();
    const out: Item[] = [];
    const target = parseQuickConnect(q);
    const conns = connections
      .map((conn) => {
        const path = groupPath(conn.groupId);
        const score = q
          ? fuzzyScore(q, [conn.name, conn.host, conn.username ? `${conn.username}@${conn.host}` : '', conn.tags.join(' '), path, conn.protocol])
          : 1;
        return { conn, path, score, open: openIds.has(conn.id) };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) =>
        q ? b.score - a.score || a.conn.name.localeCompare(b.conn.name) : Number(b.open) - Number(a.open) || a.conn.name.localeCompare(b.conn.name)
      )
      .slice(0, MAX_CONNECTIONS);
    // An exact saved match goes before Quick Connect; otherwise the typed address comes first
    const exact = conns.length > 0 && target && conns[0].conn.host.toLowerCase() === target.host.toLowerCase();
    if (target && !exact) out.push({ kind: 'quick', target });
    conns.forEach((c) => out.push({ kind: 'conn', conn: c.conn, path: c.path, open: c.open }));
    if (target && exact) out.push({ kind: 'quick', target });
    return out;
  }, [query, connections, groupPath, openIds]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-palette-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!isOpen) return null;

  const startQuick = (target: QuickTarget) => {
    setQuick(target);
    setQuickUser(target.username);
    setQuickAuth('password');
    setQuickPassword('');
    setQuickError('');
    setTimeout(() => (target.username ? quickPasswordRef : quickUserRef).current?.focus(), 0);
  };

  const run = (item: Item | undefined, newTab: boolean) => {
    if (!item) return;
    if (item.kind === 'quick') {
      startQuick(item.target);
      return;
    }
    onClose();
    onConnect(item.conn, newTab);
  };

  const submitQuick = async () => {
    if (!quick || quickBusy) return;
    setQuickBusy(true);
    setQuickError('');
    try {
      await onQuickConnect(
        { ...quick, username: quickUser.trim() },
        { sshAuthType: quick.protocol === 'ssh' ? quickAuth : 'password', password: quickAuth === 'agent' && quick.protocol === 'ssh' ? '' : quickPassword }
      );
      setQuickPassword('');
      onClose();
    } catch (err: any) {
      setQuickError(String(err?.message || err));
    } finally {
      setQuickBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // nothing reaches the terminal / RDP behind
    if (e.key === 'Escape') {
      e.preventDefault();
      if (quick) {
        setQuick(null);
        setTimeout(() => inputRef.current?.focus(), 0);
      } else onClose();
      return;
    }
    if (quick) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitQuick();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 8));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(items[index], e.shiftKey);
    }
  };

  const firstConn = items.findIndex((i) => i.kind === 'conn');

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-slate-950/60 p-4 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div ref={rootRef} role="dialog" aria-modal="true" aria-label={t('Paleta poleceń')} className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/60">
        {!quick ? (
          <>
            <div className="flex items-center gap-2 border-b border-slate-800 px-4">
              <Search className="h-4 w-4 shrink-0 text-slate-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                aria-label={t('Szukaj')}
                placeholder={t('Szukaj połączenia albo wpisz ssh użytkownik@host:port…')}
                className="h-12 min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
              />
              <kbd className="rounded border border-slate-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">Esc</kbd>
            </div>
            <div ref={listRef} role="listbox" className="max-h-[56vh] overflow-y-auto py-1">
              {items.length === 0 && <div className="px-4 py-6 text-center text-xs text-slate-500">{t('Brak wyników')}</div>}
              {items.map((item, i) => {
                const active = i === index;
                const header =
                  i === firstConn ? t('Połączenia') : item.kind === 'quick' ? t('Szybkie połączenie') : null;
                return (
                  <React.Fragment key={item.kind === 'conn' ? item.conn.id : 'quick'}>
                    {header && <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{header}</div>}
                    <div
                      role="option"
                      aria-selected={active}
                      data-palette-index={i}
                      onMouseMove={() => index !== i && setIndex(i)}
                      onClick={(e) => run(item, e.shiftKey)}
                      className={`mx-1 flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-xs ${active ? 'bg-cyan-900/50 text-white' : 'text-slate-300'}`}
                    >
                      {item.kind === 'quick' ? (
                        <>
                          <Zap className="h-4 w-4 shrink-0 text-amber-300" />
                          <span className="min-w-0 flex-1 truncate">
                            {t('Połącz z')} <span className="font-mono text-amber-100">{formatQuickTarget(item.target)}</span>
                            <span className="ml-2 text-[10px] text-slate-500">{t('bez zapisywania w sejfie')}</span>
                          </span>
                        </>
                      ) : (
                        <>
                          {item.conn.protocol === 'rdp' ? (
                            <Monitor className="h-4 w-4 shrink-0 text-blue-400" />
                          ) : (
                            <SquareTerminal className="h-4 w-4 shrink-0 text-emerald-400" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="truncate font-medium">{item.conn.name}</span>
                              {item.open && <span title={t('Otwarte')} className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />}
                            </span>
                            <span className="block truncate font-mono text-[10px] text-slate-500">
                              {item.conn.username ? `${item.conn.username}@` : ''}
                              {item.conn.host}:{item.conn.port}
                              {item.path ? `  ·  ${item.path}` : ''}
                              {item.conn.tags.length ? `  ·  #${item.conn.tags.join(' #')}` : ''}
                            </span>
                          </span>
                          {active && <span className="shrink-0 text-[10px] text-slate-400">{item.open ? t('przejdź') : t('połącz')}</span>}
                        </>
                      )}
                      {active && <CornerDownLeft className="h-3 w-3 shrink-0 text-slate-500" />}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 px-4 py-2 text-[10px] text-slate-500">
              <span>{t('↑↓ wybór')}</span>
              <span>{t('Enter – połącz / przejdź')}</span>
              <span>{t('Shift+Enter – nowa karta')}</span>
            </div>
          </>
        ) : (
          <form
            className="p-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitQuick();
            }}
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-200">
              <button
                type="button"
                onClick={() => {
                  setQuick(null);
                  setTimeout(() => inputRef.current?.focus(), 0);
                }}
                title={t('Wstecz (Esc)')}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <Zap className="h-4 w-4" />
              <span className="font-mono">{formatQuickTarget({ ...quick, username: quickUser.trim() })}</span>
            </div>
            <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2.5 text-xs">
              <label htmlFor="qc-user" className="text-slate-400">
                {t('Użytkownik')}
              </label>
              <input
                id="qc-user"
                ref={quickUserRef}
                value={quickUser}
                onChange={(e) => setQuickUser(e.target.value)}
                spellCheck={false}
                className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 outline-none focus:border-cyan-500"
              />
              {quick.protocol === 'ssh' && (
                <>
                  <span className="text-slate-400">{t('Logowanie')}</span>
                  <div className="flex gap-1">
                    {(
                      [
                        ['password', t('Hasło')],
                        ['agent', t('Agent SSH')],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => {
                          setQuickAuth(v);
                          if (v === 'password') setTimeout(() => quickPasswordRef.current?.focus(), 0);
                        }}
                        className={`rounded-lg border px-3 py-1 ${quickAuth === v ? 'border-cyan-500 bg-cyan-900/40 text-cyan-100' : 'border-slate-700 text-slate-400 hover:bg-slate-800'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {(quick.protocol === 'rdp' || quickAuth === 'password') && (
                <>
                  <label htmlFor="qc-password" className="text-slate-400">
                    {t('Hasło')}
                  </label>
                  <input
                    id="qc-password"
                    ref={quickPasswordRef}
                    type="password"
                    value={quickPassword}
                    onChange={(e) => setQuickPassword(e.target.value)}
                    autoComplete="off"
                    className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 outline-none focus:border-cyan-500"
                  />
                </>
              )}
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              {t('Połączenie nie jest zapisywane w sejfie – hasło zostaje tylko w pamięci do zamknięcia karty. Zapiszesz je z menu karty.')}
            </p>
            {quickError && <p className="mt-2 text-[11px] text-red-400">{quickError}</p>}
            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={quickBusy || (quick.protocol === 'rdp' && !quickUser.trim())}
                className="rounded-lg bg-cyan-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-40"
              >
                {t('Połącz')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
