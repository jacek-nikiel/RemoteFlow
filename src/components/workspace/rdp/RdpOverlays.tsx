/** Overlays of the RDP viewer: connecting, and connection error / session ended. */
import React, { useState } from 'react';
import { AlertTriangle, Check, Copy, Download, ExternalLink, Loader2, Monitor, RefreshCw } from 'lucide-react';
import { api } from '../../../services/api';
import { useT } from '../../../i18n';
import { explainRdpError } from '../../../utils/rdpErrors';

export const RdpConnectingOverlay: React.FC<{
  session: { title: string; host: string; port: number };
  rdpLogin: string;
  statusMessage: string;
}> = ({ session, rdpLogin, statusMessage }) => {
  const t = useT();
  return (
    <div role="status" className="absolute inset-0 bg-rdp-bg flex flex-col items-center justify-center z-10 p-6 text-center">
      <div className="relative flex items-center justify-center mb-4">
        <div className="h-16 w-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shadow-xl shadow-blue-500/10">
          <Monitor className="h-8 w-8 animate-pulse" />
        </div>
        <Loader2 className="absolute -bottom-1 -right-1 h-6 w-6 text-cyan-400 animate-spin" />
      </div>
      <h3 className="text-base font-semibold text-white tracking-tight">{t('Łączenie z {title}', { title: session.title })}</h3>
      <p className="mt-1 font-mono text-xs text-slate-400">
        {rdpLogin}@{session.host}:{session.port}
      </p>
      <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-slate-900 border border-slate-800 px-3 py-1 text-[11px] text-cyan-300">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-ping" />
        <span>{statusMessage}</span>
      </div>
    </div>
  );
};

export const RdpErrorOverlay: React.FC<{
  isError: boolean;
  statusMessage: string;
  rdpLogin: string;
  onReconnect: () => void;
  handleLaunchExternal: () => void;
  isLaunchingExternal: boolean;
  handleDownloadRdp: () => void;
}> = ({ isError, statusMessage, rdpLogin, onReconnect, handleLaunchExternal, isLaunchingExternal, handleDownloadRdp }) => {
  const t = useT();
  const [errorCopied, setErrorCopied] = useState(false);
  return (
    <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center z-10 p-6 text-center">
      <div className="h-14 w-14 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shadow-xl shadow-red-500/10 mb-4">
        <AlertTriangle className="h-7 w-7" />
      </div>
      <h3 className="text-base font-bold text-white tracking-tight">
        {isError ? t('Błąd połączenia z sesją RDP') : t('Sesja RDP zakończona')}
      </h3>
      <div className="relative mt-1 max-w-md my-2">
        <p className="select-text cursor-text break-words text-xs text-slate-400 leading-relaxed font-mono bg-slate-900/80 border border-slate-800 p-2.5 pr-8 rounded-lg">
          {statusMessage}
        </p>
        <button
          type="button"
          title={t('Kopiuj treść błędu')}
          onClick={() => {
            api.clipboardWriteText(statusMessage).catch(() => {});
            setErrorCopied(true);
            setTimeout(() => setErrorCopied(false), 1500);
          }}
          className="absolute right-1.5 top-1.5 rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-white"
        >
          {errorCopied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {isError && explainRdpError(statusMessage) && (
        <div className="max-w-md rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-left text-xs leading-relaxed text-amber-200">
          {explainRdpError(statusMessage)}
          <div className="mt-1.5 text-amber-300/80">
            {t('Wysłany login:')} <span className="select-text font-mono text-amber-100">{rdpLogin}</span>
          </div>
        </div>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={onReconnect}
          className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 shadow-lg shadow-blue-600/20 transition-all"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>{t('Połącz ponownie')}</span>
        </button>
        <button
          onClick={handleLaunchExternal}
          disabled={isLaunchingExternal}
          className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition-all"
        >
          <ExternalLink className="h-3.5 w-3.5 text-purple-400" />
          <span>{t('Otwórz w FreeRDP')}</span>
        </button>
        <button
          onClick={handleDownloadRdp}
          className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          <span>{t('Zapisz .rdp…')}</span>
        </button>
      </div>
    </div>
  );
};
