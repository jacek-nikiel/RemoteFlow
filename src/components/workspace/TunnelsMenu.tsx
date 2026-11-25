/**
 * Tunnels of an SSH terminal tab, opened from its "Tunnels (N)" button – a compact list next to
 * the button (like "Open connections"): what listens where, where it leads, whether it works
 * (a busy local port, a -R port the server refused, the tunnel connection being down) and how
 * many connections go through each tunnel now. Refreshed every second while open.
 */
import React, { RefObject, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, Copy, ExternalLink, Loader2, X } from 'lucide-react';
import { api, isTauri, TunnelInfo, TunnelsStatus } from '../../services/api';
import { useT } from '../../i18n';
import { useMenuPosition } from '../../utils/useMenuPosition';

interface Props {
  sessionId: string;
  /** Tunnel descriptions from the connection settings – shown when no status is available. */
  fallback: string[];
  /** The button that opened the list: the list is placed under it, clicks on it do not count as "outside". */
  trigger: RefObject<HTMLElement | null>;
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

const anchorOf = (el: HTMLElement | null) => {
  const r = el?.getBoundingClientRect();
  return r ? { x: r.right, y: r.bottom + 6 } : null;
};

export const TunnelsMenu: React.FC<Props> = ({ sessionId, fallback, trigger, onClose }) => {
  const t = useT();
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState(() => anchorOf(trigger.current));
  const style = useMenuPosition(menu, anchor);
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
    const outside = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const reposition = () => setAnchor(anchorOf(trigger.current));
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', reposition);
    };
  }, [onClose, trigger]);

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

  const kindName = (kind: string) => (kind === 'local' ? t('lokalny') : kind === 'remote' ? t('zdalny') : 'SOCKS5');

  const route = (tn: TunnelInfo) => {
    if (tn.kind === 'dynamic') return { from: `127.0.0.1:${tn.port}`, to: t('dowolny adres (przez serwer)') };
    if (tn.kind === 'remote') {
      return { from: t('serwer:{port}', { port: tn.port }), to: t('{target} (ten komputer)', { target: tn.target ?? '' }) };
    }
    return { from: `127.0.0.1:${tn.port}`, to: t('{target} (przez serwer)', { target: tn.target ?? '' }) };
  };

  const stateText = (tn: TunnelInfo) =>
    tn.state === 'active'
      ? t('Aktywny')
      : tn.state === 'waiting'
        ? t('Czeka na połączenie z serwerem')
        : t('Błąd');

  const tunnels = status?.tunnels ?? [];
  const iconButton =
    'flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-white';

  return createPortal(
    <div
      ref={menu}
      id={menuId}
      role="dialog"
      aria-label={t('Tunele SSH')}
      style={{ ...style, maxHeight: 'min(440px, calc(100vh - 16px))' }}
      className="fixed z-[80] flex w-[min(440px,calc(100vw-16px))] flex-col rounded-xl border border-slate-700 bg-slate-900 text-slate-200 shadow-2xl"
    >
      <div className="flex shrink-0 items-center justify-between px-3 pt-3 text-xs font-semibold">
        <span>
          {t('Tunele SSH')} <span className="text-slate-400">({status ? tunnels.length : fallback.length})</span>
        </span>
        <button
          type="button"
          onClick={onClose}
          title={t('Zamknij')}
          aria-label={t('Zamknij')}
          className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {status && (
        <div
          className={`mx-3 mt-1.5 flex items-start gap-1.5 text-[11px] ${status.connected ? 'text-emerald-300' : 'text-amber-300'}`}
        >
          <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${status.connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
          <span className="select-text break-words">
            {status.connected
              ? t('Połączenie tuneli z serwerem działa.')
              : status.error
                ? t('Brak połączenia tuneli z serwerem ({error}) – zostanie nawiązane przy kolejnym użyciu.', {
                    error: status.error,
                  })
                : t('Łączenie tuneli z serwerem...')}
          </span>
        </div>
      )}

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {status === undefined ? (
          <div className="flex items-center justify-center gap-2 py-5 text-xs text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            <span>{t('Wczytywanie…')}</span>
          </div>
        ) : status === null ? (
          fallback.map((d) => (
            <div key={d} className="rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200">
              {d}
            </div>
          ))
        ) : (
          tunnels.map((tn, i) => {
            const r = route(tn);
            const address = localAddress(tn);
            const url = browserUrl(tn);
            const active = tn.state === 'active';
            return (
              <div key={i} className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-slate-800/70">
                <span className="mt-0.5 w-6 shrink-0 rounded border border-slate-700 bg-slate-800 text-center font-mono text-[10px] font-semibold text-slate-200">
                  {KIND_LABEL[tn.kind] ?? tn.kind}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1 font-mono text-[11px] text-slate-100">
                    <span className="select-text">{r.from}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-slate-500" />
                    <span className="select-text break-all">{r.to}</span>
                  </span>
                  <span className="mt-0.5 block text-[11px] text-slate-400">
                    {kindName(tn.kind)} ·{' '}
                    <span className={active ? 'text-emerald-300' : tn.state === 'waiting' ? 'text-amber-300' : 'text-red-300'}>
                      {stateText(tn)}
                    </span>
                    {active && <> · {t('Otwarte połączenia: {n}', { n: tn.connections })}</>}
                  </span>
                  {tn.error && (
                    <span className="mt-1 block select-text break-words text-[11px] leading-snug text-red-300">{tn.error}</span>
                  )}
                </span>
                {address && active && (
                  <button
                    type="button"
                    onClick={() => copy(address)}
                    title={t('Kopiuj adres do schowka') + `: ${address}`}
                    aria-label={t('Kopiuj adres do schowka')}
                    className={iconButton}
                  >
                    {copied === address ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                )}
                {url && active && (
                  <button
                    type="button"
                    onClick={() => void openInBrowser(url)}
                    title={`${t('Otwórz w przeglądarce')}: ${url}`}
                    aria-label={t('Otwórz w przeglądarce')}
                    className={iconButton}
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-cyan-400" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="shrink-0 border-t border-slate-800 px-3 py-2 text-[10px] leading-snug text-slate-500">
        {t('Tunele zmienisz w ustawieniach połączenia (zakładka „Tunele SSH”) – zmiany działają po ponownym połączeniu.')}
      </p>
    </div>,
    document.body
  );
};
