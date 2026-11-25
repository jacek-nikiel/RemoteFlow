/**
 * Local folder browser of the RDP Files & clipboard drawer: one click sends a file or a whole
 * folder (recursively) to the Windows clipboard. The last folder is kept by the viewer
 * (`localPathRef`), so reopening the browser returns to it.
 */
import React, { useEffect, useState } from 'react';
import { ArrowUp, File, Folder, HardDrive, Loader2 } from 'lucide-react';
import { SftpFileEntry } from '../../../types';
import { api } from '../../../services/api';
import { useT } from '../../../i18n';

interface Props {
  localPathRef: React.MutableRefObject<string>;
  onSend: (paths: string[]) => unknown;
}

export const LocalFolderBrowser: React.FC<Props> = ({ localPathRef, onSend }) => {
  const t = useT();
  const [localCurrentPath, setLocalCurrentPath] = useState<string>(localPathRef.current);
  const [localEntries, setLocalEntries] = useState<SftpFileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);

  // Load local directory for folder picker
  const loadLocalDirectory = async (targetPath: string = '') => {
    setLocalLoading(true);
    try {
      const res = await api.localListDir(targetPath);
      setLocalCurrentPath(res.currentPath);
      localPathRef.current = res.currentPath;
      setLocalEntries(res.entries);
    } catch (err) {
      console.error('Błąd odczytu katalogu lokalnego:', err);
    } finally {
      setLocalLoading(false);
    }
  };

  useEffect(() => {
    loadLocalDirectory(localPathRef.current || '');
  }, []);

  const handleLocalNavigateUp = () => {
    if (!localCurrentPath || localCurrentPath === '/') return;
    const parts = localCurrentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    loadLocalDirectory(parentPath || '/');
  };

  return (
    <div className="mt-2 rounded-lg border border-amber-500/40 bg-slate-950 p-2 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-amber-300 flex items-center gap-1">
          <HardDrive className="h-3 w-3" />
          <span>{t('Kliknij „Wyślij katalog” przy wybranym folderze:')}</span>
        </span>
        <button
          onClick={async () => {
            const dir = await api.pickLocalFolder();
            if (dir) await onSend([dir]);
          }}
          className="rounded border border-amber-500/40 bg-amber-950/60 hover:bg-amber-900 px-2 py-0.5 text-[10px] text-amber-200"
        >
          {t('Okno systemowe...')}
        </button>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={handleLocalNavigateUp}
          disabled={!localCurrentPath || localCurrentPath === '/' || localLoading}
          className="flex h-6 w-6 items-center justify-center rounded border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <input
          type="text"
          value={localCurrentPath}
          onChange={(e) => setLocalCurrentPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') loadLocalDirectory(localCurrentPath);
          }}
          className="flex-1 h-6 rounded border border-slate-700 bg-slate-900 px-2 font-mono text-[10px] text-slate-200"
        />
        {localCurrentPath.split('/').filter(Boolean).length > 2 && (
          <button
            onClick={() => onSend([localCurrentPath])}
            className="rounded bg-emerald-600 hover:bg-emerald-500 px-2 py-1 text-[10px] font-semibold text-white shrink-0"
          >
            {t('Wyślij ten katalog')}
          </button>
        )}
      </div>

      <div className="max-h-40 overflow-y-auto divide-y divide-slate-800/50 rounded border border-slate-800">
        {localLoading ? (
          <div className="flex items-center justify-center py-4 text-slate-400 gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
            <span>Wczytywanie...</span>
          </div>
        ) : (
          localEntries.map((item) => (
            <div
              key={item.path}
              className="flex items-center justify-between px-2 py-1 hover:bg-slate-900"
            >
              <div
                onClick={() => {
                  if (item.isDir) loadLocalDirectory(item.path);
                }}
                className={`flex items-center gap-1.5 min-w-0 flex-1 ${
                  item.isDir ? 'cursor-pointer text-amber-200 hover:text-amber-300' : 'text-slate-400'
                }`}
              >
                {item.isDir ? (
                  <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                ) : (
                  <File className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                )}
                <span className="truncate text-[11px]">{item.name}</span>
              </div>
              <button
                onClick={() => onSend([item.path])}
                className={`ml-2 rounded px-2 py-0.5 text-[10px] font-medium shrink-0 ${
                  item.isDir
                    ? 'bg-amber-600 hover:bg-amber-500 text-white'
                    : 'bg-slate-800 hover:bg-cyan-600 text-slate-200'
                }`}
              >
                {item.isDir ? t('Wyślij katalog') : t('Wyślij plik')}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
