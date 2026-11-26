import { File, FileArchive, FileCode, FileImage, Folder } from 'lucide-react';
import { SftpFileEntry } from '../../../types';
import { locale } from '../../../i18n';

export type Side = 'local' | 'remote';
export type SortKey = 'name' | 'size' | 'modified';

export interface PaneState {
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

export const emptyPane = (): PaneState => ({
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

/** Compact modification time for the list (e.g. 23.10.26, 14:05); full date with seconds in the tooltip. */
export const formatDate = (secs: number): string =>
  secs
    ? new Date(secs * 1000).toLocaleString(locale(), {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
export const formatDateFull = (secs: number): string =>
  secs ? new Date(secs * 1000).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'medium' }) : '';

export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

export const remoteParent = (p: string): string | null => {
  const clean = p.replace(/\/+$/, '');
  if (!clean || clean === '') return null;
  const idx = clean.lastIndexOf('/');
  if (idx < 0) return null;
  return idx === 0 ? '/' : clean.slice(0, idx);
};

export const fileIcon = (entry: SftpFileEntry) => {
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

export interface DragInfo {
  from: Side;
  paths: string[];
  label: string;
  x: number;
  y: number;
  overSide: Side | null;
  overFolder: string | null;
}
