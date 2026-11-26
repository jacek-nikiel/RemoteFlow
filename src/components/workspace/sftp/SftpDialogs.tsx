import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderInput, ShieldCheck } from 'lucide-react';
import { tn, useT } from '../../../i18n';
import { SftpFileEntry } from '../../../types';
import { baseName } from './sftpTypes';

/** Frame of a small dialog inside the SFTP window (Esc = cancel, click outside = cancel). */
const DialogFrame: React.FC<{
  title: string;
  icon: React.ReactNode;
  onCancel: () => void;
  children: React.ReactNode;
}> = ({ title, icon, onCancel, children }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // close only the dialog, not the SFTP window
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-3 flex items-center gap-2 text-sm font-bold text-cyan-300">
          {icon}
          {title}
        </div>
        {children}
      </div>
    </div>
  );
};

const Buttons: React.FC<{ onCancel: () => void; okLabel: string; disabled?: boolean }> = ({ onCancel, okLabel, disabled }) => {
  const t = useT();
  return (
    <div className="mt-5 flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="rounded-lg border border-slate-700 px-3.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
        {t('Anuluj')}
      </button>
      <button
        type="submit"
        disabled={disabled}
        className="rounded-lg bg-cyan-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/60 disabled:opacity-40"
      >
        {okLabel}
      </button>
    </div>
  );
};

const namesOf = (paths: string[]) => paths.slice(0, 6).map(baseName).join(', ') + (paths.length > 6 ? '…' : '');

// =================================================================================================
// Move to another folder
// =================================================================================================

export const MoveDialog: React.FC<{
  paths: string[];
  initialDir: string;
  onCancel: () => void;
  onMove: (targetDir: string) => void;
}> = ({ paths, initialDir, onCancel, onMove }) => {
  const t = useT();
  const [dir, setDir] = useState(initialDir);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <DialogFrame title={t('Przenieś do katalogu')} icon={<FolderInput className="h-4 w-4" />} onCancel={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dir.trim()) onMove(dir.trim());
        }}
      >
        <p className="mb-2 text-xs text-slate-300">
          {tn(paths.length, ['Przenoszony element: ', 'Przenoszone elementy ({n}): ', 'Przenoszone elementy ({n}): '], { n: paths.length })}
          <span className="text-slate-100">{namesOf(paths)}</span>
        </p>
        <label className="mb-1 block text-[11px] text-slate-400">{t('Katalog docelowy')}</label>
        <input
          ref={inputRef}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          spellCheck={false}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-cyan-500"
        />
        <p className="mt-2 text-[11px] text-slate-500">
          {t('Istniejące pliki nie są nadpisywane. Elementy można też przeciągnąć na katalog w tym samym panelu.')}
        </p>
        <Buttons onCancel={onCancel} okLabel={t('Przenieś')} disabled={!dir.trim()} />
      </form>
    </DialogFrame>
  );
};

// =================================================================================================
// Permissions (chmod) – server only
// =================================================================================================

const SPECIAL = [
  { label: 'SUID', bit: 0o4000 },
  { label: 'SGID', bit: 0o2000 },
  { label: 'Sticky', bit: 0o1000 },
] as const;

/** rwxr-xr-x for a mode. */
export const modeString = (mode: number): string =>
  [6, 3, 0]
    .map((s) => {
      const v = (mode >> s) & 7;
      return (v & 4 ? 'r' : '-') + (v & 2 ? 'w' : '-') + (v & 1 ? 'x' : '-');
    })
    .join('');

export const ChmodDialog: React.FC<{
  entries: SftpFileEntry[];
  onCancel: () => void;
  onApply: (mode: number, recursive: boolean, scope: 'all' | 'files' | 'dirs') => void;
}> = ({ entries, onCancel, onApply }) => {
  const t = useT();
  const initial = (entries[0]?.permissions ?? 0o644) & 0o7777;
  const mixed = entries.some((e) => (e.permissions & 0o7777) !== initial);
  const [mode, setMode] = useState(initial);
  const [octal, setOctal] = useState(initial.toString(8).padStart(3, '0'));
  const [recursive, setRecursive] = useState(false);
  const [scope, setScope] = useState<'all' | 'files' | 'dirs'>('all');
  const hasDir = useMemo(() => entries.some((e) => e.isDir && !e.isLink), [entries]);
  const links = entries.filter((e) => e.isLink).length;

  const WHO = [
    { label: t('Właściciel'), shift: 6 },
    { label: t('Grupa'), shift: 3 },
    { label: t('Inni'), shift: 0 },
  ];
  const WHAT = [
    { label: t('Odczyt'), bit: 4 },
    { label: t('Zapis'), bit: 2 },
    { label: t('Wykonanie'), bit: 1 },
  ];

  const update = (m: number) => {
    setMode(m);
    setOctal(m.toString(8).padStart(3, '0'));
  };
  const octalValid = /^[0-7]{3,4}$/.test(octal);

  return (
    <DialogFrame title={t('Uprawnienia')} icon={<ShieldCheck className="h-4 w-4" />} onCancel={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (octalValid) onApply(mode, hasDir && recursive, scope);
        }}
      >
        <p className="mb-3 text-xs text-slate-300">
          <span className="text-slate-100">{namesOf(entries.map((e) => e.path))}</span>
          {mixed && <span className="block text-[11px] text-amber-300">{t('Zaznaczone elementy mają różne uprawnienia – pokazano uprawnienia pierwszego.')}</span>}
        </p>
        <table className="w-full text-xs text-slate-300">
          <thead>
            <tr className="text-[11px] text-slate-500">
              <th className="pb-1 text-left font-normal" />
              {WHAT.map((w) => (
                <th key={w.bit} className="pb-1 font-normal">
                  {w.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WHO.map((who) => (
              <tr key={who.shift}>
                <td className="py-1">{who.label}</td>
                {WHAT.map((w) => {
                  const bit = w.bit << who.shift;
                  return (
                    <td key={w.bit} className="py-1 text-center">
                      <input
                        type="checkbox"
                        aria-label={`${who.label} – ${w.label}`}
                        checked={(mode & bit) !== 0}
                        onChange={(e) => update(e.target.checked ? mode | bit : mode & ~bit)}
                        className="h-3.5 w-3.5 accent-cyan-500"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
          {SPECIAL.map((s) => (
            <label key={s.bit} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={(mode & s.bit) !== 0}
                onChange={(e) => update(e.target.checked ? mode | s.bit : mode & ~s.bit)}
                className="h-3 w-3 accent-cyan-500"
              />
              {s.label}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs">
          <label className="text-slate-400" htmlFor="sftp-chmod-octal">
            {t('Ósemkowo')}
          </label>
          <input
            id="sftp-chmod-octal"
            value={octal}
            maxLength={4}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-7]/g, '');
              setOctal(v);
              if (/^[0-7]{3,4}$/.test(v)) setMode(parseInt(v, 8));
            }}
            className={`w-16 rounded-lg border bg-slate-950 px-2 py-1 font-mono text-slate-100 outline-none ${octalValid ? 'border-slate-700 focus:border-cyan-500' : 'border-red-500'}`}
          />
          <span className="font-mono text-slate-500">{modeString(mode)}</span>
        </div>
        {hasDir && (
          <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-2.5 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-500" />
              {t('Również zawartość katalogów (rekurencyjnie)')}
            </label>
            {recursive && (
              <div className="mt-2 flex flex-wrap gap-3 pl-5 text-[11px] text-slate-400">
                {(
                  [
                    ['all', t('pliki i katalogi')],
                    ['files', t('tylko pliki')],
                    ['dirs', t('tylko katalogi')],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-1">
                    <input type="radio" name="sftp-chmod-scope" checked={scope === v} onChange={() => setScope(v)} className="accent-cyan-500" />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {links > 0 && <p className="mt-2 text-[11px] text-slate-500">{t('Dowiązania symboliczne są pomijane.')}</p>}
        <Buttons onCancel={onCancel} okLabel={t('Zastosuj')} disabled={!octalValid} />
      </form>
    </DialogFrame>
  );
};
