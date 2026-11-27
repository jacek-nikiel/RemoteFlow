import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import { Connection, Group } from '../../types';
import { fuzzyScore } from '../../utils/fuzzy';
import { useT } from '../../i18n';

interface Props {
  id: string;
  value: string;
  onChange: (id: string) => void;
  /** Allowed jump hosts, already sorted by name. */
  candidates: Connection[];
  groups: Group[];
}

/** Folder path "Parent / Child" of a group. */
function groupPathOf(groups: Group[]) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  return (id: string | null | undefined): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let g = id ? byId.get(id) : undefined;
    while (g && !seen.has(g.id)) {
      seen.add(g.id);
      names.unshift(g.name);
      g = g.parentId ? byId.get(g.parentId) : undefined;
    }
    return names.join(' / ');
  };
}

const address = (c: Connection) => `${c.username ? `${c.username}@` : ''}${c.host}:${c.port}`;

/** Jump host choice with search (name, address, user, folder, tags) – also for long lists. */
export const JumpHostPicker: React.FC<Props> = ({ id, value, onChange, candidates, groups }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathOf = useMemo(() => groupPathOf(groups), [groups]);

  const selected = candidates.find((c) => c.id === value);

  // "" = direct connection, then the matching jump hosts (best match first while searching)
  const items = useMemo(() => {
    const q = query.trim();
    const list = q
      ? candidates
          .map((c) => ({
            c,
            score: fuzzyScore(q, [c.name, c.host, c.username ? `${c.username}@${c.host}` : '', pathOf(c.groupId), (c.tags || []).join(' ')]),
          }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.c)
      : candidates;
    return q ? list : [null, ...list];
  }, [query, candidates, pathOf]);

  // Opening: empty search, the current choice highlighted
  const openList = () => {
    setQuery('');
    const idx = value ? candidates.findIndex((c) => c.id === value) + 1 : 0;
    setActive(Math.max(idx, 0));
    setOpen(true);
  };

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the highlighted row visible
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, items]);

  // Close on a click outside
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (c: Connection | null) => {
    onChange(c ? c.id : '');
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items.length > 0) pick(items[Math.min(active, items.length - 1)]);
    } else if (e.key === 'Escape') {
      // Close only the list, not the whole dialog
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const label = !value
    ? t('Brak – połączenie bezpośrednie')
    : selected
      ? `${selected.name} (${address(selected)})`
      : t('(połączenie nie istnieje)');

  return (
    <div ref={rootRef} className="mt-1.5">
      <button
        id={id}
        type="button"
        onClick={() => (open ? setOpen(false) : openList())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-left text-xs text-white focus:border-cyan-500 focus:outline-none"
      >
        <span className={`truncate ${value ? '' : 'text-slate-400'}`}>{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-1 rounded-lg border border-slate-700 bg-slate-900 shadow-xl" onKeyDown={onKeyDown}>
          <div className="flex items-center gap-2 border-b border-slate-800 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder={t('Szukaj: nazwa, adres, użytkownik, folder…')}
              className="w-full bg-transparent text-xs text-white placeholder:text-slate-500 focus:outline-none"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-56 overflow-y-auto p-1">
            {items.length === 0 && <div className="px-2.5 py-2 text-xs text-slate-500">{t('Brak pasujących połączeń SSH')}</div>}
            {items.map((c, i) => {
              const isSel = c ? c.id === value : !value;
              const path = c ? pathOf(c.groupId) : '';
              return (
                <div
                  key={c ? c.id : '__direct'}
                  data-idx={i}
                  role="option"
                  aria-selected={isSel}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(c)}
                  className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${i === active ? 'bg-slate-800 text-white' : 'text-slate-300'}`}
                >
                  <Check className={`h-3.5 w-3.5 shrink-0 ${isSel ? 'text-cyan-400' : 'invisible'}`} />
                  {c ? (
                    <div className="min-w-0">
                      <div className="truncate">
                        {c.name} <span className="text-slate-500">({address(c)})</span>
                      </div>
                      {path && <div className="truncate text-[10px] text-slate-500">{path}</div>}
                    </div>
                  ) : (
                    <span className="text-slate-400">{t('Brak – połączenie bezpośrednie')}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
