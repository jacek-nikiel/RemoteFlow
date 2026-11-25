import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { useLang, useT } from '../../i18n';
import {
  AvailableUpdate,
  autoCheckEnabled,
  checkForUpdate,
  localizedNotes,
  openReleasesPage,
  skipVersion,
  skippedVersion,
  UPDATE_EVENT,
} from '../../utils/updater';

const FIRST_CHECK_DELAY_MS = 8_000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Notice about a new version (bottom-right corner): release notes, install with download
 * progress, "later" and "skip this version". Automatic checks at start-up and once a day.
 */
export const UpdateNotice: React.FC<{ activeSessions: number }> = ({ activeSessions }) => {
  const t = useT();
  const lang = useLang();
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Automatic checks (silent: errors – e.g. no network – are not shown)
  useEffect(() => {
    const run = () => {
      if (!autoCheckEnabled()) return;
      checkForUpdate()
        .then((u) => {
          if (u && u.version !== skippedVersion()) setUpdate(u);
        })
        .catch(() => {});
    };
    const first = setTimeout(run, FIRST_CHECK_DELAY_MS);
    const daily = setInterval(run, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(daily);
    };
  }, []);

  // Manual check from Settings
  useEffect(() => {
    const onUpdate = (e: Event) => {
      setError(null);
      setUpdate((e as CustomEvent<AvailableUpdate>).detail);
    };
    window.addEventListener(UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(UPDATE_EVENT, onUpdate);
  }, []);

  if (!update) return null;
  // English or Polish part of the release notes, as the interface
  const notes = localizedNotes(update.notes, lang);

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await update.install((done, total) => setProgress({ done, total }));
    } catch (err: any) {
      setError(String(err?.message || err));
      setInstalling(false);
      setProgress(null);
    }
  };

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const percent = progress?.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div
      role="dialog"
      aria-label={t('Dostępna aktualizacja')}
      className="fixed bottom-4 right-4 z-[70] w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border border-cyan-500/40 bg-slate-900/95 p-4 text-xs text-slate-200 shadow-2xl backdrop-blur-md"
    >
      <div className="mb-2 flex items-start gap-2">
        <Download className="mt-0.5 h-4 w-4 shrink-0 text-cyan-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white">
            {t('Dostępna nowa wersja {version}', { version: update.version })}
          </div>
          <div className="text-[11px] text-slate-400">{t('Zainstalowana wersja: {version}', { version: update.currentVersion })}</div>
        </div>
        {!installing && (
          <button type="button" title={t('Później')} onClick={() => setUpdate(null)} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {notes && (
        <div className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-[11px] leading-relaxed text-slate-300 select-text">
          {notes}
        </div>
      )}

      {!update.canSelfUpdate && (
        <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 p-2 text-[11px] text-slate-300">
          {update.pacman
            ? t('Program zainstalowano z paczki Arch Linux – pobierz nową paczkę .pkg.tar.zst ze strony wydań i zainstaluj ją poleceniem „sudo pacman -U …” (paczkę z AUR zaktualizuj swoim pomocnikiem AUR). Dane i ustawienia zostaną zachowane.')
            : t('To jest kopia przenośna – pobierz nową wersję ze strony wydań i zastąp nią obecny plik programu (dane i ustawienia zostaną zachowane).')}
        </div>
      )}

      {update.canSelfUpdate && update.portable && !installing && (
        <div className="mb-3 rounded-lg border border-slate-700 bg-slate-950/60 p-2 text-[11px] text-slate-300">
          {t('Kopia przenośna: plik programu zostanie zastąpiony nową wersją w tym samym folderze (dane i ustawienia zostaną zachowane).')}
        </div>
      )}

      {update.canSelfUpdate && activeSessions > 0 && !installing && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          {t('Instalacja zamknie program i wszystkie aktywne połączenia ({count}).', { count: activeSessions })}
        </div>
      )}

      {installing && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-cyan-200">
            <Loader2 className="h-3 w-3 animate-spin" />
            {progress?.total && progress.done >= progress.total
              ? t('Instalowanie – program uruchomi się ponownie…')
              : t('Pobieranie {done} MB{total}', {
                  done: mb(progress?.done ?? 0),
                  total: progress?.total ? ` / ${mb(progress.total)} MB` : '',
                })}
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div className="h-full bg-cyan-500 transition-all" style={{ width: `${percent ?? 15}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 whitespace-pre-wrap break-words rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-[11px] text-red-300">
          {update.canSelfUpdate
            ? t('Nie udało się zainstalować aktualizacji: {error}', { error })
            : t('Nie udało się otworzyć strony: {error}', { error })}
        </div>
      )}

      {!installing && (
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              skipVersion(update.version);
              setUpdate(null);
            }}
            className="rounded-lg px-2.5 py-1.5 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            {t('Pomiń tę wersję')}
          </button>
          <button
            type="button"
            onClick={() => setUpdate(null)}
            className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800"
          >
            {t('Później')}
          </button>
          {update.canSelfUpdate ? (
          <button
            type="button"
            onClick={install}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-cyan-500"
          >
            <RefreshCw className="h-3 w-3" />
            {t('Zainstaluj i uruchom ponownie')}
          </button>
          ) : (
          <button
            type="button"
            onClick={() => {
              openReleasesPage()
                .then(() => setUpdate(null))
                .catch((err: any) => setError(String(err?.message || err)));
            }}
            className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-cyan-500"
          >
            <ExternalLink className="h-3 w-3" />
            {t('Pobierz nową wersję')}
          </button>
          )}
        </div>
      )}
    </div>
  );
};
