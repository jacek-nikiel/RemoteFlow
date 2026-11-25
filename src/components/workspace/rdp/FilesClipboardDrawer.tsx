/**
 * "Files & clipboard" drawer of the RDP viewer: sending files and folders to Windows, downloading
 * files copied there, the text clipboard and where to find the shared folder. All state and
 * actions belong to the viewer (they are also used by drag & drop, the bar and the clipboard sync).
 */
import React, { useRef } from 'react';
import {
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  Folder,
  FolderOpen,
  FolderSync,
  Loader2,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { DroppedFile, FileInfo } from '@devolutions/iron-remote-desktop-rdp';
import { api } from '../../../services/api';
import { useT } from '../../../i18n';
import { formatBytes } from '../../../utils/formatBytes';
import { LocalFolderBrowser } from './LocalFolderBrowser';

interface Props {
  onClose: () => void;
  handleClearClipboard: () => void;
  isConnected: boolean;
  isSavingFiles: boolean;
  stageDroppedFilesToRdpClipboard: (files: DroppedFile[]) => Promise<unknown>;
  stageLocalPathsToRdpClipboard: (paths: string[]) => Promise<unknown>;
  isLocalBrowserOpen: boolean;
  setIsLocalBrowserOpen: (open: boolean) => void;
  localPathRef: React.MutableRefObject<string>;
  remoteAvailableFiles: FileInfo[];
  setRemoteAvailableFiles: (files: FileInfo[]) => void;
  handleDownloadRemoteFiles: () => void;
  isDownloadingRemoteFiles: boolean;
  clipboardDraft: string;
  setClipboardDraft: (text: string) => void;
  handleSendCustomTextToRemote: (text: string, notify?: boolean) => Promise<boolean>;
  pasteToRemote: () => void;
  remoteClipboardText: string;
  handleOpenSharedFolder: () => void;
  showToast: (msg: string, duration?: number) => void;
}

export const FilesClipboardDrawer: React.FC<Props> = ({
  onClose,
  handleClearClipboard,
  isConnected,
  isSavingFiles,
  stageDroppedFilesToRdpClipboard,
  stageLocalPathsToRdpClipboard,
  isLocalBrowserOpen,
  setIsLocalBrowserOpen,
  localPathRef,
  remoteAvailableFiles,
  setRemoteAvailableFiles,
  handleDownloadRemoteFiles,
  isDownloadingRemoteFiles,
  clipboardDraft,
  setClipboardDraft,
  handleSendCustomTextToRemote,
  pasteToRemote,
  remoteClipboardText,
  handleOpenSharedFolder,
  showToast,
}) => {
  const t = useT();
  const rdpFileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="absolute top-0 right-0 bottom-0 w-full sm:w-[440px] bg-slate-950/95 border-l border-slate-800 shadow-2xl backdrop-blur-md flex flex-col z-40 transition-all font-sans text-xs animate-in slide-in-from-right duration-200">
      <div className="flex h-11 items-center justify-between border-b border-slate-800 px-3 bg-slate-900/90 shrink-0">
        <div className="flex items-center gap-2">
          <FolderSync className="h-4 w-4 text-emerald-400" />
          <span className="font-semibold text-white">{t('Transfer Plików, Katalogów i Schowek RDP')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleClearClipboard}
            title={t('Wyczyść schowek (usuń przygotowane pliki, tekst oraz zresetuj schowek RDP)')}
            className="flex items-center gap-1 rounded bg-slate-800 hover:bg-rose-900/60 hover:border-rose-500/50 border border-slate-700 px-2 py-1 text-[11px] font-medium text-slate-300 hover:text-rose-200 transition-colors"
          >
            <Trash2 className="h-3 w-3 text-rose-400" />
            <span>{t('Wyczyść schowek')}</span>
          </button>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="p-3 flex-1 flex flex-col gap-3.5 overflow-y-auto">
        {/* SECTION 1: Send Files & Directories to Windows */}
        <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white flex items-center gap-1.5">
              <Upload className="h-3.5 w-3.5 text-cyan-400" />
              <span>{t('1. Wyślij pliki lub katalogi do Windows')}</span>
            </span>
          </div>
          <p className="text-[11px] text-slate-300 leading-relaxed">
            {t('Wybierz pliki lub cały katalog poniżej (albo przeciągnij je na ekran RDP). Po wybraniu przejdź do okna Windows (np. na Pulpit lub do Eksploratora plików) i naciśnij Ctrl+V (prawy przycisk myszy → „Wklej”).')}
          </p>

          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <button
              onClick={() => rdpFileInputRef.current?.click()}
              disabled={!isConnected || isSavingFiles}
              className="flex items-center gap-1 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-2.5 py-1.5 text-[11px] font-medium text-white transition-colors"
            >
              <Upload className="h-3 w-3" />
              <span>{t('Wybierz pliki...')}</span>
            </button>
            <input
              ref={rdpFileInputRef}
              type="file"
              multiple
              onChange={async (e) => {
                const files = e.target.files ? Array.from(e.target.files) : [];
                if (files.length > 0) {
                  const dropped: DroppedFile[] = files.map((f) => ({
                    file: f,
                    name: f.name,
                    size: f.size,
                    lastModified: f.lastModified,
                  }));
                  await stageDroppedFilesToRdpClipboard(dropped);
                }
                e.target.value = '';
              }}
              className="hidden"
            />

            <button
              onClick={() => setIsLocalBrowserOpen(!isLocalBrowserOpen)}
              disabled={!isConnected || isSavingFiles}
              className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
                isLocalBrowserOpen
                  ? 'border-amber-500 bg-amber-950/70 text-amber-200'
                  : 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200'
              }`}
            >
              <Folder className="h-3 w-3 text-amber-400" />
              <span>{t('Wybierz katalog...')}</span>
            </button>

            <button
              onClick={async () => {
                const clipFiles = await api.clipboardReadFiles();
                if (clipFiles.length > 0) {
                  await stageLocalPathsToRdpClipboard(clipFiles);
                } else {
                  showToast(t('Brak skopiowanych plików/katalogów w schowku Linux (użyj Ctrl+C w menedżerze plików)'));
                }
              }}
              disabled={!isConnected || isSavingFiles}
              className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 transition-colors"
              title={t('Jeśli skopiowałeś plik lub katalog w systemie Linux (Ctrl+C), kliknij tutaj aby przekazać go do schowka Windows')}
            >
              <ClipboardPaste className="h-3 w-3 text-emerald-400" />
              <span>{t('Ze schowka Linux')}</span>
            </button>
          </div>

          {/* Built-in Local Folder Browser for 1-click recursive directory selection */}
          {isLocalBrowserOpen && <LocalFolderBrowser localPathRef={localPathRef} onSend={stageLocalPathsToRdpClipboard} />}

          {/* Download files copied from Windows */}
          {remoteAvailableFiles.length > 0 ? (
            <div className="mt-2 rounded-lg border border-cyan-500/60 bg-cyan-950/60 p-2.5 flex flex-col gap-2 shadow-sm animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-cyan-200 flex items-center gap-1.5">
                  <Download className="h-3.5 w-3.5 text-cyan-400" />
                  <span>{t('Skopiowano w sesji Windows ({n}):', { n: remoteAvailableFiles.length })}</span>
                </span>
                <button
                  onClick={() => setRemoteAvailableFiles([])}
                  className="text-slate-400 hover:text-white p-0.5"
                  title={t('Wyczyść listę')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="max-h-28 overflow-y-auto text-[10px] font-mono text-slate-300 space-y-1 rounded bg-slate-950/80 p-2 border border-slate-800">
                {remoteAvailableFiles.map((f, idx) => (
                  <div key={idx} className="flex items-center justify-between truncate">
                    <span className="truncate">{f.path ? `${f.path}\\${f.name}` : f.name}</span>
                    <span className="text-slate-500 ml-2">{formatBytes(f.size)}</span>
                  </div>
                ))}
              </div>
              <button
                onClick={handleDownloadRemoteFiles}
                disabled={isDownloadingRemoteFiles}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 py-2 text-[11px] font-semibold text-white shadow-xs transition-colors"
              >
                {isDownloadingRemoteFiles ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                <span>{t('Pobierz na komputer (~/RemoteFlow_Shared)')}</span>
              </button>
            </div>
          ) : (
            <div className="mt-1 rounded border border-slate-800/80 bg-slate-950/40 p-2 text-[10px] text-slate-400 leading-relaxed">
              <span className="text-slate-300 font-medium">{t('Kopiowanie z Windows na komputer:')}</span>{' '}
              {t('zaznacz plik w sesji Windows i naciśnij Ctrl+C. Na głównym pasku połączenia pojawi się informacja, a w tym menu uaktywni się przycisk „Pobierz na komputer”.')}
            </div>
          )}
        </div>

        {/* SECTION 2: Text Clipboard Sync */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 p-2.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white flex items-center gap-1.5">
              <Clipboard className="h-3.5 w-3.5 text-emerald-400" />
              <span>{t('2. Schowek tekstowy (Linux ↔ Windows)')}</span>
            </span>
            <div className="flex items-center gap-2">
              {clipboardDraft && (
                <button
                  onClick={() => setClipboardDraft('')}
                  className="text-[10px] text-slate-400 hover:text-rose-300 transition-colors"
                >
                  {t('Wyczyść')}
                </button>
              )}
              <button
                onClick={async () => {
                  const text = await api.clipboardReadText();
                  if (text) {
                    setClipboardDraft(text);
                    showToast(t('Wczytano tekst ze schowka systemowego'));
                  }
                }}
                className="text-[10px] text-cyan-400 hover:underline"
              >
                {t('Wczytaj ze schowka Linux')}
              </button>
            </div>
          </div>
          <textarea
            value={clipboardDraft}
            onChange={(e) => setClipboardDraft(e.target.value)}
            placeholder={t('Wpisz lub wklej tekst, hasło lub polecenie PowerShell/CMD...')}
            rows={3}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 font-mono text-[11px] text-slate-100 placeholder-slate-500 focus:outline-hidden focus:border-cyan-500"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSendCustomTextToRemote(clipboardDraft, true)}
              disabled={!clipboardDraft}
              className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 py-1.5 text-white font-medium shadow-xs transition-colors"
            >
              <Send className="h-3 w-3" />
              <span>{t('Wyślij do schowka Windows')}</span>
            </button>
            <button
              onClick={async () => {
                await handleSendCustomTextToRemote(clipboardDraft, true);
                setTimeout(() => {
                  pasteToRemote();
                }, 120);
              }}
              disabled={!clipboardDraft}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 px-3 py-1.5 text-white font-medium shadow-xs transition-colors"
            >
              <ClipboardPaste className="h-3 w-3" />
              <span>{t('Wyślij i wklej (Ctrl+V)')}</span>
            </button>
          </div>

          {/* Remote Clipboard Text Preview */}
          {remoteClipboardText && (
            <div className="flex flex-col gap-1 pt-2 mt-1 border-t border-slate-800">
              <span className="font-medium text-slate-400 text-[10px]">
                {t('Ostatnio skopiowano w sesji Windows (automatycznie w schowku Linux):')}
              </span>
              <div className="rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] text-slate-300 max-h-20 overflow-y-auto whitespace-pre-wrap select-all">
                {remoteClipboardText}
              </div>
            </div>
          )}
        </div>

        {/* SECTION 3: Where to find shared folder in Windows */}
        <div className="mt-auto rounded-lg border border-cyan-500/30 bg-cyan-950/25 p-2.5 text-[11px] text-cyan-200 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 font-semibold text-white">
            <FolderSync className="h-4 w-4 text-cyan-400" />
            <span>{t('Gdzie szukać plików w systemie Windows?')}</span>
          </div>
          <ul className="text-[10px] text-cyan-200/90 space-y-1 list-disc pl-4 leading-relaxed">
            <li>
              <strong>{t('W zakładce aplikacji (widok wbudowany):')}</strong>{' '}
              {t('po wybraniu lub upuszczeniu pliku/katalogu użyj Ctrl+V (Wklej) w dowolnym folderze Eksploratora Windows lub na Pulpicie.')}
            </li>
            <li>
              <strong>{t('W oknie zewnętrznym FreeRDP:')}</strong>{' '}
              {t('folder ~/RemoteFlow_Shared jest widoczny w Eksploratorze plików w sekcji „Ten komputer” (a nie w „Sieć”) jako dysk RemoteFlow lub pod adresem \\\\tsclient\\RemoteFlow.')}
            </li>
          </ul>
          <div className="flex items-center gap-1.5 mt-1">
            <button
              onClick={handleOpenSharedFolder}
              className="flex-1 flex items-center justify-center gap-1 rounded border border-cyan-500/40 bg-cyan-900/50 hover:bg-cyan-800/60 py-1 text-[10px] font-medium text-cyan-100 transition-colors"
            >
              <FolderOpen className="h-3 w-3" />
              <span>{t('Otwórz ~/RemoteFlow_Shared')}</span>
            </button>
            <button
              onClick={() => {
                handleSendCustomTextToRemote('\\\\tsclient\\RemoteFlow', true);
                api.clipboardWriteText('\\\\tsclient\\RemoteFlow');
              }}
              className="flex items-center justify-center gap-1 rounded border border-slate-700 bg-slate-800 hover:bg-slate-700 px-2 py-1 text-[10px] font-mono text-slate-200 transition-colors"
              title={t('Skopiuj ścieżkę \\\\tsclient\\RemoteFlow do schowka Windows')}
            >
              <Copy className="h-2.5 w-2.5" />
              <span>\\tsclient\RemoteFlow</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
