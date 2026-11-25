/**
 * Window with the SSH tunnels of a terminal tab: what listens where, where it leads, whether it
 * works (a busy local port, a -R port the server refused, the tunnel connection being down) and
 * how many connections go through each tunnel now. Refreshed every second while open.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowRight, ArrowRightLeft, Check, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { api, isTauri, TunnelInfo, TunnelsStatus } from '../../services/api';
import { useT } from '../../i18n';

interface Props {
  sessionId: string;
  title: string;
  /** Tunnel descriptions from the connection settings – shown when no status is available. */
  fallback: string[];
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = { local: '-L', remote: '-R', dynamic: '-D' };

/** Address a program on this computer uses for the tunnel (none for -R: it listens on the server). */
const localAddress = (t: TunnelInfo) =>
  t.kind === 'dynamic' ? `socks5://127.0.0.1:${t.port}` : t.kind === 'local' ? `127.0.0.1:${t.port}` : null;

/** Web page behind a -L tunnel (https for the usual TLS ports). */
const browserUrl = (t: TunnelInfo) => {
  if (t.kind !== 'local') return null;
  const targetPort = Number(t.target?.split(':').pop());
  return `${targetPort === 443 || targetPort === 8443 ? 'https' : 'http'}://127.0.0.1:${t.port}/`;
};

export const TunnelsDialog: React.FC<Props> = ({ sessionId, title, fallback, onClose }) => {
  const t = useT();
  const [status, setStatus] = useState<TunnelsStatus | null | undefined>(undefined);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getSessionTunnels(sessionId)
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    load();
    const id = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const copy = useCallback((text: string) => {
    api.clipboardWriteText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
  }, []);

  const openInBrowser = async (url: string) => {
    if (isTauri()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url).catch(() => {});
    } else {
      window.open(url, '_blank', 'noopener');
    }
  };

  const kindName = (kind: string) =>
    kind === 'local' ? t('lokalny') : kind === 'remote' ? t('zdalny') : 'SOCKS5';

  const route = (tn: TunnelInfo) => {
    if (tn.kind === 'dynamic') {
      return { from: `127.0.0.1:${tn.port}`, to: t('dowolny adres (przez serwer)') };
    }
    if (tn.kind === 'remote') {
      return { from: t('serwer:{port}', { port: tn.port }), to: t('{target} (ten komputer)', { target: tn.target ?? '' }) };
    }
    return { from: `127.0.0.1:${tn.port}`, to: t('{target} (przez serwer)', { target: tn.target ?? '' }) };
  };

  const tunnels = status?.tunnels ?? [];
  const errors = tunnels.filter((tn) => tn.state === 'error').length;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('Tunele SSH')}
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 shrink-0 text-emerald-400" />
            <h2 className="truncate text-sm font-bold text-white">{t('Tunele SSH – {title}', { title })}</h2>
          </div>
          <button
            onClick={onClose}
            title={t('Zamknij')}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {status === undefined ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span>{t('Wczytywanie…')}</span>
          </div>
        ) : status === null ? (
          <div className="mt-4 space-y-2 text-xs">
            <p className="text-slate-400">{t('Tunele z ustawień połączenia:')}</p>
            <ul className="space-y-1 rounded-lg border border-slate-800 bg-slate-950/60 p-3 font-mono text-[11px] text-slate-200">
              {fallback.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <div
              className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
                status.connected
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              }`}
            >
              {status.connected ? (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              )}
              <span className="select-text break-words">
                {status.connected
                  ? errors > 0
                    ? t('Połączenie tuneli z serwerem działa, ale część tuneli nie wystartowała.')
                    : t('Połączenie tuneli z serwerem działa.')
                  : status.error
                    ? t('Brak połączenia tuneli z serwerem ({error}) – zostanie nawiązane przy kolejnym użyciu.', {
                        error: status.error,
                      })
                    : t('Łączenie tuneli z serwerem...')}
              </span>
            </div>

            <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-0.5">
              {tunnels.map((tn, i) => {
                const r = route(tn);
                const address = localAddress(tn);
                const url = browserUrl(tn);
                return (
                  <div key={i} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <div className="flex items-center gap-2">
                      <span className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-200">
                        {KIND_LABEL[tn.kind] ?? tn.kind}
                      </span>
                      <span className="text-[11px] text-slate-400">{kindName(tn.kind)}</span>
                      <span className="ml-auto flex items-center gap-1.5 text-[11px]">
                        {tn.state === 'active' ? (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            <span className="text-emerald-300">{t('Aktywny')}</span>
                          </>
                        ) : tn.state === 'waiting' ? (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                            <span className="text-amber-300">{t('Czeka na połączenie z serwerem')}</span>
                          </>
                        ) : (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                            <span className="text-red-300">{t('Błąd')}</span>
                          </>
                        )}
                      </span>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-xs text-slate-100">
                      <span className="select-text">{r.from}</span>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                      <span className="select-text break-all">{r.to}</span>
                    </div>

                    {tn.error && (
                      <p className="mt-2 select-text break-words rounded border border-red-500/30 bg-red-500/10 p-2 text-[11px] leading-relaxed text-red-300">
                        {tn.error}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="mr-auto text-[11px] text-slate-400">
                        {tn.state === 'active' &&
                          t('Otwarte połączenia: {n}', { n: tn.connections })}
                      </span>
                      {address && tn.state === 'active' && (
                        <button
                          onClick={() => copy(address)}
                          title={t('Kopiuj adres do schowka')}
                          className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 hover:text-white"
                        >
                          {copied === address ? (
                            <Check className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <Copy className="h-3 w-3 text-slate-400" />
                          )}
                          <span className="font-mono">{address}</span>
                        </button>
                      )}
                      {url && tn.state === 'active' && (
                        <button
                          onClick={() => void openInBrowser(url)}
                          title={url}
                          className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 hover:text-white"
                        >
                          <ExternalLink className="h-3 w-3 text-cyan-400" />
                          <span>{t('Otwórz w przeglądarce')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <p className="mt-3 border-t border-slate-800 pt-3 text-[11px] leading-relaxed text-slate-500">
          {t('Tunele zmienisz w ustawieniach połączenia (zakładka „Tunele SSH”) – zmiany działają po ponownym połączeniu.')}
        </p>
      </div>
    </div>,
    document.body
  );
};
