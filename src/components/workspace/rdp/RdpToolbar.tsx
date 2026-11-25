/**
 * Session bar of the RDP viewer: on the left the session (name, address, state, TLS) and the
 * file / clipboard notices, on the right the actions (resolution, statistics, scaling, files &
 * clipboard, key menu, F5, password, full screen, reconnect). State and actions belong to the viewer.
 */
import React from 'react';
import {
  Activity,
  Check,
  Download,
  FileUp,
  FolderSync,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Tv,
  Volume2,
  X,
  ZoomIn,
} from 'lucide-react';
import type { FileInfo } from '@devolutions/iron-remote-desktop-rdp';
import { SessionInfo } from '../../../types';
import { useT } from '../../../i18n';
import { KeySequenceMenu } from './KeySequenceMenu';
import { RESOLUTION_PRESETS } from './layout';

interface SessionStatusProps {
  session: SessionInfo;
  isConnected: boolean;
  isConnecting: boolean;
  isError: boolean;
  /** Files prepared for pasting in Windows (Ctrl+V). */
  stagedUploadNames: string[];
  onPasteStaged: () => void;
  onCancelStaged: () => void;
  /** Files copied in the Windows session, ready to download. */
  remoteAvailableFiles: FileInfo[];
  setRemoteAvailableFiles: (files: FileInfo[]) => void;
  isDownloadingRemoteFiles: boolean;
  handleDownloadRemoteFiles: () => void;
  clipboardFeedback: string | null;
  uploadProgressText: string | null;
  isSavingFiles: boolean;
}

/** Left part of the session bar. */
export const RdpSessionStatus: React.FC<SessionStatusProps> = ({
  session,
  isConnected,
  isConnecting,
  isError,
  stagedUploadNames,
  onPasteStaged,
  onCancelStaged,
  remoteAvailableFiles,
  setRemoteAvailableFiles,
  isDownloadingRemoteFiles,
  handleDownloadRemoteFiles,
  clipboardFeedback,
  uploadProgressText,
  isSavingFiles,
}) => {
  const t = useT();
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex items-center gap-1.5 text-blue-400 font-semibold shrink-0">
        <Monitor className="h-4 w-4 shrink-0" />
        <span className="truncate max-w-[130px]">{session.title}</span>
      </div>
      <span className="text-slate-600">|</span>
      <span className="font-mono text-slate-300 text-[11px] truncate max-w-[160px]">
        {session.username}@{session.host}:{session.port}
      </span>
      <div className="flex items-center gap-1.5 ml-1 shrink-0">
        <span
          className={`h-2 w-2 rounded-full shrink-0 ${
            isConnected
              ? 'bg-emerald-400 shadow-xs shadow-emerald-400/50'
              : isConnecting
              ? 'bg-amber-400 animate-pulse'
              : 'bg-red-400'
          }`}
        />
        <span
          className={`text-[11px] font-medium hidden sm:inline ${
            isConnected
              ? 'text-emerald-400'
              : isConnecting
              ? 'text-amber-400'
              : 'text-red-400'
          }`}
        >
          {isConnected
            ? t('Aktywny')
            : isConnecting
            ? t('Łączenie...')
            : isError
            ? t('Błąd połączenia')
            : t('Rozłączono')}
        </span>
      </div>

      <div className="hidden lg:flex items-center gap-1.5 ml-2 border-l border-slate-800 pl-2 text-[10px] text-slate-400 shrink-0">
        <span className="flex items-center gap-1 text-emerald-400" title={t('Szyfrowanie TLS / NLA aktywne')}>
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>TLS</span>
        </span>
        {session.rdpSettings?.sound && (
          <span className="flex items-center gap-1 text-purple-400" title={t('Dźwięk zdalny włączony')}>
            <Volume2 className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      {/* Plik/katalog gotowy do wklejenia na pasku informacyjnym RDP obok TLS */}
      {stagedUploadNames.length > 0 && isConnected && (
        <div className="flex items-center gap-1.5 ml-2 rounded-full bg-emerald-950/90 border border-emerald-500/60 px-2.5 py-0.5 text-[10px] text-emerald-200 font-medium shadow-xs shrink-0 animate-in fade-in duration-150">
          <FileUp className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
          <span className="truncate max-w-[180px] sm:max-w-[260px]">
            {t('Gotowe:')} <strong className="text-white">{stagedUploadNames.join(', ')}</strong>
          </span>
          <button
            onClick={onPasteStaged}
            title={t('Wklej w sesji Windows (Ctrl+V)')}
            className="ml-1 rounded bg-emerald-600 hover:bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold text-white transition-colors"
          >
            Ctrl+V
          </button>
          <button
            onClick={onCancelStaged}
            title={t('Anuluj')}
            className="text-emerald-300 hover:text-white p-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Informacja o skopiowanych plikach w Windows na głównym pasku połączenia */}
      {remoteAvailableFiles.length > 0 && isConnected && (
        <div
          onClick={() => {
            if (!isDownloadingRemoteFiles) {
              handleDownloadRemoteFiles();
            }
          }}
          title={t('Skopiowano pliki w sesji Windows. Kliknij, aby pobrać je od razu na komputer (do wspólnego katalogu wymiany).')}
          className="flex items-center gap-1.5 ml-2 rounded-full bg-cyan-950/90 border border-cyan-500/60 px-2.5 py-0.5 text-[10px] text-cyan-200 font-medium shadow-xs shrink-0 cursor-pointer hover:bg-cyan-900/90 hover:border-cyan-400 transition-all animate-in fade-in duration-150"
        >
          {isDownloadingRemoteFiles ? (
            <Loader2 className="h-3.5 w-3.5 text-cyan-400 animate-spin shrink-0" />
          ) : (
            <Download className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
          )}
          <span className="truncate max-w-[170px] sm:max-w-[260px]">
            {isDownloadingRemoteFiles ? (
              <span>{t('Pobieranie plików na komputer...')}</span>
            ) : (
              <>
                {t('Pobierz z Windows ({n}):', { n: remoteAvailableFiles.length })}{' '}
                <strong className="text-white">
                  {remoteAvailableFiles.slice(0, 2).map((f) => f.name).join(', ')}
                  {remoteAvailableFiles.length > 2 ? ` (+${remoteAvailableFiles.length - 2})` : ''}
                </strong>
              </>
            )}
          </span>
          {!isDownloadingRemoteFiles && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRemoteAvailableFiles([]);
              }}
              title={t('Odrzuć powiadomienie')}
              className="text-cyan-300 hover:text-white p-0.5 ml-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {/* Real-time Feedback Toast Badge */}
      {(clipboardFeedback || uploadProgressText) && (
        <div className="flex items-center gap-1 ml-2 rounded-full bg-cyan-950/90 border border-cyan-500/60 px-2.5 py-0.5 text-[10px] text-cyan-200 font-medium shadow-xs truncate max-w-[340px]">
          <Check className="h-3 w-3 text-cyan-400 shrink-0" />
          <span className="truncate">{uploadProgressText || clipboardFeedback}</span>
        </div>
      )}

      {/* Saving Files indicator */}
      {isSavingFiles && (
        <div className="flex items-center gap-1 ml-2 rounded-full bg-amber-950/90 border border-amber-500/60 px-2 py-0.5 text-[10px] text-amber-300 font-medium shadow-xs shrink-0">
          <Loader2 className="h-3 w-3 animate-spin text-amber-400" />
          <span>{t('Przygotowywanie plików...')}</span>
        </div>
      )}
    </div>
  );
};

interface ActionsProps {
  isConnected: boolean;
  selectedResolution: string;
  applyResolution: (preset: string) => void;
  isStatsOpen: boolean;
  onToggleStats: () => void;
  scaleMode: 'fit' | 'real';
  handleSetScale: (mode: 'fit' | 'real') => void;
  isClipboardDrawerOpen: boolean;
  onToggleDrawer: () => void;
  clipboardAllowed: boolean;
  /** Files waiting in either direction (badge on the Files & clipboard button). */
  fileBadge: number;
  sendKeyCombination: (scancodes: number[], label?: string, useSpecial?: 'ctrlAltDel' | 'metaKey') => boolean;
  sendTextSequence: (text: string) => boolean | undefined;
  sendF5ToRemote: () => boolean;
  showToast: (msg: string, duration?: number) => void;
  handleCopyPassword: () => void;
  copiedPassword: boolean;
  isFullscreen: boolean;
  handleToggleFullscreen: () => void;
  onReconnect: () => void;
}

/** Right part of the session bar. */
export const RdpToolbarActions: React.FC<ActionsProps> = ({
  isConnected,
  selectedResolution,
  applyResolution,
  isStatsOpen,
  onToggleStats,
  scaleMode,
  handleSetScale,
  isClipboardDrawerOpen,
  onToggleDrawer,
  clipboardAllowed,
  fileBadge,
  sendKeyCombination,
  sendTextSequence,
  sendF5ToRemote,
  showToast,
  handleCopyPassword,
  copiedPassword,
  isFullscreen,
  handleToggleFullscreen,
  onReconnect,
}) => {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {/* Resolution Selector Dropdown */}
      <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-slate-200 hover:border-slate-600">
        <Tv className="h-3 w-3 text-cyan-400 shrink-0" />
        <select
          value={selectedResolution}
          onChange={(e) => applyResolution(e.target.value)}
          disabled={!isConnected}
          title={t('Zmień rozdzielczość pulpitu zdalnego w czasie rzeczywistym')}
          className="bg-transparent text-[11px] font-medium text-slate-200 outline-hidden cursor-pointer disabled:opacity-50"
        >
          {RESOLUTION_PRESETS.map((p) => (
            <option key={p.value} value={p.value} className="bg-slate-900 text-slate-200">
              {t(p.label)}
            </option>
          ))}
        </select>
      </div>

      {/* Performance statistics of the embedded client */}
      <button
        onClick={onToggleStats}
        title={t('Statystyki wydajności RDP (dane, rysowanie, obciążenie)')}
        className={`flex items-center rounded-lg border px-2 py-1 text-xs transition-colors ${
          isStatsOpen
            ? 'border-cyan-500/50 bg-cyan-950/40 text-cyan-200 hover:bg-cyan-900/50'
            : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700'
        }`}
      >
        <Activity className="h-3 w-3 text-cyan-400" />
      </button>

      {/* Scale Switcher: Fit vs Real (100% 1:1) – only for a fixed resolution: in Auto the
          desktop always has the size of the area, so both would look the same */}
      {selectedResolution !== 'auto' && (
        <div className="flex items-center rounded-lg border border-slate-700 bg-slate-800/60 p-0.5" role="group">
          <ZoomIn className="mx-1 h-3 w-3 text-amber-400" />
          {(
            [
              ['fit', t('Dopasuj'), t('Dopasuj do okna')],
              ['real', '100%', t('100% oryginał (1:1)')],
            ] as const
          ).map(([mode, label, title]) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleSetScale(mode)}
              title={title}
              aria-pressed={scaleMode === mode}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
                scaleMode === mode ? 'bg-cyan-600 text-white' : 'text-slate-300 hover:bg-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Toggle Unified Files & Clipboard Drawer */}
      <button
        onClick={onToggleDrawer}
        disabled={!clipboardAllowed}
        title={clipboardAllowed ? t('Transfer plików, katalogów i menedżer schowka RDP') : t('Schowek jest wyłączony w ustawieniach tego połączenia')}
        className={`relative flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors ${
          isClipboardDrawerOpen
            ? 'border-emerald-500 bg-emerald-950/60 text-emerald-200 shadow-xs'
            : fileBadge > 0
            ? 'border-cyan-500 bg-cyan-950/50 text-cyan-200'
            : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white'
        } disabled:cursor-default disabled:opacity-40`}
      >
        <FolderSync className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-[11px] font-medium hidden sm:inline">{t('Pliki i Schowek')}</span>
        {fileBadge > 0 && (
          <span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[9px] font-bold text-slate-950">
            {fileBadge}
          </span>
        )}
      </button>

      {/* Wyślij sekwencję klawiszy do Windows */}
      <KeySequenceMenu
        isConnected={isConnected}
        sendKeyCombination={sendKeyCombination}
        sendTextSequence={sendTextSequence}
        sendF5ToRemote={sendF5ToRemote}
        showToast={showToast}
      />

      {/* Send F5 (Odśwież) to Windows */}
      <button
        onClick={sendF5ToRemote}
        disabled={!isConnected}
        title={t('Wyślij klawisz F5 (Odśwież w systemie Windows) [F5]')}
        className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:pointer-events-none transition-colors"
      >
        <span className="text-[11px] font-semibold text-amber-400">F5</span>
        <span className="text-[11px] hidden lg:inline text-slate-300">{t('Odśwież')}</span>
      </button>

      {/* Copy Password Button */}
      <button
        onClick={handleCopyPassword}
        title={t('Kopiuj hasło sesji do schowka (lokalnego i RDP)')}
        className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2 py-1 text-slate-200 hover:bg-slate-700 hover:text-white transition-colors"
      >
        {copiedPassword ? (
          <Check className="h-3 w-3 text-emerald-400" />
        ) : (
          <KeyRound className="h-3 w-3 text-cyan-400" />
        )}
        <span className="text-[11px] hidden md:inline">{copiedPassword ? t('Skopiowano!') : t('Hasło')}</span>
      </button>

      {/* Fullscreen Toggle */}
      <button
        onClick={handleToggleFullscreen}
        title={isFullscreen ? t('Opuść pełny ekran') : t('Pełny ekran')}
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
      >
        {isFullscreen ? (
          <Minimize2 className="h-3.5 w-3.5 text-cyan-400" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5 text-slate-400" />
        )}
      </button>

      {/* Reconnect Button */}
      <button
        onClick={onReconnect}
        title={t('Połącz ponownie')}
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
      >
        <RefreshCw className="h-3.5 w-3.5 text-slate-400" />
      </button>
    </div>
  );
};
