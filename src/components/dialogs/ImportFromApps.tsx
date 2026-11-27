/**
 * Import from other programs: OpenSSH (~/.ssh/config), PuTTY and WinSCP. The backend reads the
 * source and returns what it found (without passwords); the chosen entries are imported by key.
 */
import React, { useMemo, useState } from 'react';
import { CheckSquare, FileSearch, FolderOpen, KeyRound, Link2, Loader2, Square, TriangleAlert, Upload } from 'lucide-react';
import { api, isTauri } from '../../services/api';
import { Group, ImportCandidate, ImportScan } from '../../types';
import { tn, useT } from '../../i18n';

type Source = 'ssh_config' | 'putty' | 'winscp';

interface Props {
  groups: Group[];
  onImported: (text: string) => Promise<void>;
  onError: (text: string) => void;
}

const groupPathOf = (groups: Group[], id: string): string => {
  const names: string[] = [];
  const seen = new Set<string>();
  let g = groups.find((x) => x.id === id);
  while (g && !seen.has(g.id)) {
    seen.add(g.id);
    names.unshift(g.name);
    g = g.parentId ? groups.find((x) => x.id === g!.parentId) : undefined;
  }
  return names.join(' / ');
};

export const ImportFromApps: React.FC<Props> = ({ groups, onImported, onError }) => {
  const t = useT();
  const [source, setSource] = useState<Source>('ssh_config');
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // '' = new folder (name below), '-' = top level, otherwise an existing folder id
  const [target, setTarget] = useState('');
  const [newGroup, setNewGroup] = useState('');

  const sources: { id: Source; label: string; hint: string }[] = [
    { id: 'ssh_config', label: 'OpenSSH', hint: t('~/.ssh/config – hosty, użytkownicy, porty, klucze, ProxyJump i tunele') },
    { id: 'putty', label: 'PuTTY', hint: t('Zapisane sesje SSH (rejestr Windows albo ~/.putty), klucze .ppk i tunele') },
    { id: 'winscp', label: 'WinSCP', hint: t('Zapisane witryny SFTP/SCP z folderami, hasłami i tunelem SSH') },
  ];
  const defaultFolder = { ssh_config: 'OpenSSH', putty: 'PuTTY', winscp: 'WinSCP' }[source];

  const read = async (pick: boolean) => {
    setLoading(true);
    try {
      const result = await api.importScan(source, pick);
      if (!result) return;
      setScan(result);
      // Everything new is chosen; entries already in the vault and jump hosts only added for others are not
      setSelected(new Set(result.candidates.filter((c) => !c.exists && !c.implicit).map((c) => c.key)));
      setTarget('');
      setNewGroup(defaultFolder);
    } catch (err: any) {
      setScan(null);
      onError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => (scan ? scan.candidates.filter((c) => !c.implicit) : []), [scan]);
  const byKey = useMemo(() => new Map((scan?.candidates ?? []).map((c) => [c.key, c])), [scan]);
  const allChosen = visible.length > 0 && visible.every((c) => selected.has(c.key));

  const noteText = (n: string) =>
    n === 'key-missing'
      ? t('brak pliku klucza')
      : n === 'password'
        ? t('hasło nieczytelne')
        : n === 'Proxy'
          ? t('proxy PuTTY pominięte')
          : t('pominięto: {what}', { what: n });

  const doImport = async () => {
    if (!scan) return;
    setImporting(true);
    try {
      const r = await api.importApply(
        scan.scanId,
        [...selected],
        target && target !== '-' ? target : null,
        target === '' ? newGroup.trim() || defaultFolder : null
      );
      setScan(null);
      await onImported(
        tn(r.connections, ['Zaimportowano {n} połączenie', 'Zaimportowano {n} połączenia', 'Zaimportowano {n} połączeń'], { n: r.connections }) +
          (r.passwords ? ' ' + t('(z hasłami: {n})', { n: r.passwords }) : '') +
          '.'
      );
    } catch (err: any) {
      onError(String(err?.message || err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              setSource(s.id);
              setScan(null);
            }}
            className={`rounded-xl border p-3 text-left transition-all ${
              source === s.id ? 'border-cyan-500 bg-cyan-500/10 text-white' : 'border-slate-800 bg-slate-800/40 text-slate-400 hover:border-slate-700'
            }`}
          >
            <div className="text-xs font-bold">{s.label}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{s.hint}</div>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => read(false)}
          disabled={loading || !isTauri()}
          className="flex items-center gap-2 rounded-lg bg-cyan-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
          {source === 'ssh_config' ? t('Wczytaj ~/.ssh/config') : source === 'putty' ? t('Wczytaj sesje PuTTY') : t('Wczytaj witryny WinSCP')}
        </button>
        <button
          type="button"
          onClick={() => read(true)}
          disabled={loading || !isTauri()}
          className="flex items-center gap-2 rounded-lg border border-slate-700 px-3.5 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {source === 'ssh_config' ? t('Wskaż plik…') : source === 'putty' ? t('Wskaż plik .reg…') : t('Wskaż WinSCP.ini / .reg…')}
        </button>
      </div>

      {scan && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-[11px] text-slate-400">
            <span className="truncate" title={scan.location}>
              {t('Źródło: {where}', { where: scan.location })}
            </span>
            {visible.length > 0 && (
              <button
                type="button"
                onClick={() => setSelected(allChosen ? new Set() : new Set(visible.map((c) => c.key)))}
                className="shrink-0 text-cyan-400 hover:text-cyan-300"
              >
                {allChosen ? t('Odznacz wszystko') : t('Zaznacz wszystko')}
              </button>
            )}
          </div>
          {scan.warnings.includes('master-password') && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] text-amber-200">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t('WinSCP ma hasło główne – zapisanych haseł nie da się odczytać, połączenia zostaną zaimportowane bez nich.')}
            </div>
          )}
          {visible.length === 0 ? (
            <div className="rounded-lg border border-slate-800 p-4 text-center text-xs text-slate-500">{t('Nie znaleziono połączeń SSH.')}</div>
          ) : (
            <div className="max-h-[38vh] overflow-y-auto rounded-xl border border-slate-800">
              {visible.map((c: ImportCandidate) => {
                const on = selected.has(c.key);
                const jump = c.jump ? byKey.get(c.jump) : undefined;
                return (
                  <label
                    key={c.key}
                    className={`flex cursor-pointer items-start gap-2.5 border-b border-slate-800/70 px-3 py-2 text-xs last:border-b-0 ${on ? 'bg-cyan-950/30' : 'hover:bg-slate-800/40'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(c.key)) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        })
                      }
                    />
                    {on ? <CheckSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-400" /> : <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2">
                        <span className="font-medium text-slate-100">{c.name}</span>
                        {c.folder.length > 0 && <span className="text-[10px] text-slate-500">{c.folder.join(' / ')}</span>}
                        {c.exists && <span className="rounded bg-slate-700/60 px-1 text-[10px] text-slate-300">{t('już w sejfie')}</span>}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-slate-500">
                        {c.username ? `${c.username}@` : ''}
                        {c.host}:{c.port}
                      </span>
                      <span className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-slate-400">
                        {c.keyFile && (
                          <span className="flex items-center gap-1" title={c.keyFile}>
                            <KeyRound className="h-3 w-3" />
                            {c.keyFile.split(/[\\/]/).pop()}
                          </span>
                        )}
                        {c.hasPassword && <span>{t('hasło')}</span>}
                        {jump && (
                          <span className="flex items-center gap-1">
                            <Link2 className="h-3 w-3" />
                            {t('przez {host}', { host: jump.name })}
                          </span>
                        )}
                        {c.forwards.length > 0 && <span>{tn(c.forwards.length, ['{n} tunel', '{n} tunele', '{n} tuneli'], { n: c.forwards.length })}</span>}
                        {c.notes.map((n) => (
                          <span key={n} className="text-amber-300/80">
                            {noteText(n)}
                          </span>
                        ))}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {visible.length > 0 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="import-target" className="block text-[11px] text-slate-400">
                    {t('Folder docelowy')}
                  </label>
                  <select
                    id="import-target"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                  >
                    <option value="">{t('Nowy folder')}</option>
                    <option value="-">{t('Bez folderu')}</option>
                    {groups
                      .map((g) => ({ id: g.id, path: groupPathOf(groups, g.id) }))
                      .sort((a, b) => a.path.localeCompare(b.path))
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.path}
                        </option>
                      ))}
                  </select>
                </div>
                {target === '' && (
                  <div>
                    <label htmlFor="import-new-group" className="block text-[11px] text-slate-400">
                      {t('Nazwa nowego folderu')}
                    </label>
                    <input
                      id="import-new-group"
                      value={newGroup}
                      onChange={(e) => setNewGroup(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                {t('Serwery pośredniczące (ProxyJump, tunel WinSCP) są dodawane razem z połączeniami, które ich używają; jeśli są już w sejfie, używane są istniejące.')}
              </p>
              <button
                type="button"
                onClick={doImport}
                disabled={importing || selected.size === 0}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 py-3 text-xs font-semibold text-white shadow-lg shadow-cyan-600/20 hover:opacity-95 disabled:opacity-50"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {tn(selected.size, ['Importuj {n} połączenie', 'Importuj {n} połączenia', 'Importuj {n} połączeń'], { n: selected.size })}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
