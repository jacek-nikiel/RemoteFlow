import React, { useEffect, useState } from 'react';
import { Activity, Check, Copy, RotateCcw, X } from 'lucide-react';
import { useT } from '../../i18n';
import { api } from '../../services/api';
import { APP_VERSION } from '../../version';
import { getRdpDisplayInfo } from './rdp/layout';
import { activeRdpColorDepth } from './rdp/graphicsMode';
import { RdpBurst, RdpStatsSnapshot, resetRdpStats, setRdpStatsEnabled, takeRdpStats } from '../../utils/rdpStats';

const f1 = (n: number) => n.toFixed(1);
const f0 = (n: number) => Math.round(n).toString();

/** Performance statistics overlay of the embedded RDP client (see utils/rdpStats). */
export const RdpStatsPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useT();
  const [s, setS] = useState<RdpStatsSnapshot | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setRdpStatsEnabled(true);
    const id = setInterval(() => setS(takeRdpStats()), 1000);
    return () => {
      clearInterval(id);
      setRdpStatsEnabled(false);
    };
  }, []);

  const burstText = (b: RdpBurst | null) =>
    b
      ? t('{ms} ms, {mpx} Mpx, {mb} MB, wątek zajęty {busy} ms (rysowanie {draw} ms), {n} regionów', {
          ms: f0(b.ms),
          mpx: b.mpx.toFixed(2),
          mb: b.mb.toFixed(2),
          busy: f0(b.busyMs),
          draw: f0(b.drawMs),
          n: f0(b.regions),
        })
      : t('brak – przełącz okno na zdalnym pulpicie');

  const d = s ? getRdpDisplayInfo() : null;
  const displayText = d
    ? t('pulpit {desktop} (zamówiony {requested}), obszar {area} px ekranu, skalowanie ekranu {screen}% – {shown}', {
        desktop: `${d.desktop.width}×${d.desktop.height}`,
        requested: d.requested
          ? `${d.requested.width}×${d.requested.height}, ${d.requested.scale}%`
          : '–',
        area: `${d.area.width}×${d.area.height}`,
        screen: d.screen,
        shown:
          d.scale !== 1
            ? t('przeskalowany ×{s}', { s: d.scale.toFixed(3) })
            : d.misalign > 0.05
              ? t('1:1, ale przesunięty o {px} px ekranu', { px: d.misalign.toFixed(2) })
              : t('pokazany 1:1 (ostro)'),
      })
    : '–';

  const rows: [string, string][] = s
    ? [
        [t('Silnik'), `${s.engine}, ${s.canvas}`],
        [t('Obraz'), displayText],
        [t('Grafika'), activeRdpColorDepth() ? t('potok graficzny (GFX), {depth} bit', { depth: activeRdpColorDepth() }) : '–'],
        [t('Dane z serwera'), t('{mb} MB/s ({n} wiad./s)', { mb: f1(s.mbps), n: f0(s.msgs) })],
        [t('Aktualizacje ekranu'), t('{n} regionów/s, {mpx} Mpx/s', { n: f0(s.regions), mpx: f1(s.mpx) })],
        ...(s.engine.startsWith('WebKit') ? [[t('Klatki wyświetlone'), `${f0(s.frames)}/s`] as [string, string]] : []),
        [t('Rysowanie'), t('{ms} ms/s', { ms: f0(s.drawMs) })],
        [t('Wątek główny zajęty'), t('{ms} ms/s (najdłuższa blokada {max} ms)', { ms: f0(s.busyMs), max: f0(s.maxBlockMs) })],
        [t('Ostatnia duża zmiana'), burstText(s.lastBurst)],
        [t('Średnio ({n} zmian)', { n: s.bursts }), burstText(s.avgBurst)],
      ]
    : [];

  const copy = () => {
    const text = [`RemoteFlow ${APP_VERSION} – RDP`, navigator.userAgent, ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n');
    api.clipboardWriteText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="rf-dark absolute left-2 top-2 z-20 w-[min(26rem,calc(100%-1rem))] rounded-lg border border-slate-700 bg-slate-950/90 p-2.5 text-[11px] text-slate-300 shadow-xl backdrop-blur-sm">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 text-cyan-400" />
        <span className="font-semibold text-white">{t('Statystyki RDP')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={resetRdpStats}
            title={t('Wyzeruj statystyki')}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={!s}
            title={t('Kopiuj statystyki')}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            title={t('Zamknij')}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      {s ? (
        <table className="w-full">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="align-top">
                <td className="whitespace-nowrap pr-2 text-slate-400">{k}</td>
                <td className="select-text font-mono text-slate-200">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="text-slate-400">{t('Zbieranie danych…')}</div>
      )}
      <div className="mt-1.5 text-[10px] leading-snug text-slate-500">
        {t('Duża zmiana: wątek zajęty prawie przez cały czas = ogranicza komputer (dekodowanie/rysowanie); dużo mniej = ogranicza sieć lub serwer.')}
      </div>
    </div>
  );
};
