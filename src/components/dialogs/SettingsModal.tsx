import React, { useState, useEffect } from 'react';
import {
  X,
  Shield,
  Lock,
  Clock,
  CheckCircle2,
  Loader2,
  KeyRound,
  Eye,
  EyeOff,
  AlertTriangle,
  Fingerprint,
  Trash2,
  Archive,
  RotateCcw,
  MessageSquareWarning,
  Languages,
  Palette,
  SquareTerminal,
  Download,
} from 'lucide-react';
import { APP_VERSION } from '../../version';
import { announceUpdate, autoCheckEnabled, checkForUpdate, setAutoCheckEnabled, skipVersion } from '../../utils/updater';
import {
  clampScrollback,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
} from '../../utils/terminalSettings';
import { api } from '../../services/api';
import { BackupEntry, BackupSettings, KnownHostEntry, UiSettings, VaultStatus } from '../../types';
import { ConfirmDialog } from './ConfirmDialog';
import { locale, tn, useT } from '../../i18n';
import { LanguageSegmented } from '../../i18n/LanguageSwitcher';
import { LinuxRdpClientSetting, LinuxRenderingSetting, TerminalDarkToggle, ThemeSegmented } from '../../theme/ThemeSwitcher';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  status: VaultStatus;
  onStatusUpdated: (status: VaultStatus) => void;
}

export const SettingsModal: React.FC<Props> = ({
  isOpen,
  onClose,
  status,
  onStatusUpdated,
}) => {
  const t = useT();
  // General & PIN settings
  const [pinEnabled, setPinEnabled] = useState(status.pinEnabled);
  const [pinCode, setPinCode] = useState('');
  const [confirmPinCode, setConfirmPinCode] = useState('');
  const [autoLockScreen, setAutoLockScreen] = useState(status.autoLockScreen);
  const [autoLockTimeout, setAutoLockTimeout] = useState(status.autoLockTimeoutMins);
  const [uiSettings, setUiSettings] = useState<UiSettings>({ confirmCloseSessions: true, confirmAppExit: true });

  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Master password change state
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);
  const [currentMasterPassword, setCurrentMasterPassword] = useState('');
  const [newMasterPassword, setNewMasterPassword] = useState('');
  const [confirmMasterPassword, setConfirmMasterPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordSuccessMsg, setPasswordSuccessMsg] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState<string>('');
  const [knownHosts, setKnownHosts] = useState<KnownHostEntry[]>([]);
  // Backups
  const [backupSettings, setBackupSettings] = useState<BackupSettings>({
    enabled: true,
    intervalHours: 24,
    keep: 10,
    dir: null,
  });
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [restoreCandidate, setRestoreCandidate] = useState<BackupEntry | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await api.getVaultPath();
        if (p) setVaultPath(p);
      } catch {}
      try {
        setKnownHosts(await api.listKnownHosts());
      } catch {}
      try {
        setUiSettings(await api.getUiSettings());
      } catch {}
      try {
        setBackupSettings(await api.getBackupSettings());
        setBackups(await api.listBackups());
      } catch {}
    })();
  }, [isOpen]);

  const handleBackupNow = async () => {
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const path = await api.backupNow();
      setBackupMsg({ text: t('Utworzono kopię: {path}', { path }), type: 'success' });
      setBackups(await api.listBackups());
    } catch (err: unknown) {
      setBackupMsg({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackup = async (entry: BackupEntry) => {
    setRestoreCandidate(null);
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const updated = await api.restoreBackup(entry.name);
      // The restored vault is locked – the user must enter the Master Password valid for that backup.
      onStatusUpdated(updated);
      onClose();
    } catch (err: unknown) {
      setBackupMsg({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleForgetHost = async (id: string) => {
    try {
      await api.forgetKnownHost(id);
      setKnownHosts((prev) => prev.filter((h) => h.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    setPinEnabled(status.pinEnabled);
    setAutoLockScreen(status.autoLockScreen);
    setAutoLockTimeout(status.autoLockTimeoutMins);
  }, [status]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    // Validate PIN if enabling or changing
    if (pinEnabled && pinCode) {
      if (pinCode.length < 4) {
        setError(t('PIN musi mieć co najmniej 4 cyfry'));
        return;
      }
      if (pinCode !== confirmPinCode) {
        setError(t('Wprowadzone kody PIN nie są zgodne'));
        return;
      }
    }

    setSaving(true);
    try {
      // 1. Update PIN state if changed
      if (pinEnabled !== status.pinEnabled || pinCode) {
        const updatedStatus = await api.setPin(pinCode, pinEnabled);
        onStatusUpdated(updatedStatus);
      }

      // 2. Update auto-lock policies
      await api.updateSecuritySettings(autoLockScreen, autoLockTimeout);

      // 3. Backup policy
      await api.setBackupSettings(backupSettings);

      // 4. Confirmations (closing connections / exiting the application)
      const savedUi: UiSettings = {
        ...uiSettings,
        terminalScrollback: clampScrollback(uiSettings.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK),
      };
      await api.setUiSettings(savedUi);
      setUiSettings(savedUi);
      window.dispatchEvent(new CustomEvent<UiSettings>('remoteflow-ui-settings', { detail: savedUi }));

      setSuccessMsg(t('Ustawienia zostały zapisane.'));
      setPinCode('');
      setConfirmPinCode('');
      setTimeout(() => {
        setSuccessMsg(null);
      }, 3000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleChangeMasterPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccessMsg(null);

    if (!currentMasterPassword) {
      setPasswordError(t('Wprowadź obecne Master Password'));
      return;
    }
    if (newMasterPassword.length < 8) {
      setPasswordError(t('Nowe Master Password musi mieć co najmniej 8 znaków'));
      return;
    }
    if (newMasterPassword !== confirmMasterPassword) {
      setPasswordError(t('Nowe hasła nie są identyczne'));
      return;
    }
    if (currentMasterPassword === newMasterPassword) {
      setPasswordError(t('Nowe Master Password musi być inne niż obecne'));
      return;
    }

    setChangingPassword(true);
    try {
      const updatedStatus = await api.changeMasterPassword(currentMasterPassword, newMasterPassword);
      onStatusUpdated(updatedStatus);
      setPinEnabled(false);
      setPinCode('');
      setConfirmPinCode('');
      setCurrentMasterPassword('');
      setNewMasterPassword('');
      setConfirmMasterPassword('');
      setPasswordSuccessMsg(t('Master Password zostało pomyślnie zmienione! Wszystkie wpisy zostały ponownie zaszyfrowane nowym kluczem Argon2id / AES-256-GCM. Kod PIN został zresetowany.'));
      setTimeout(() => {
        setPasswordSuccessMsg(null);
      }, 6000);
    } catch (err: unknown) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangingPassword(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl max-h-[92vh] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-800 px-6 bg-slate-900/80">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-cyan-400" />
            <h2 className="text-sm font-bold text-white">
              {t('Ustawienia Bezpieczeństwa & Sejfu')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="overflow-y-auto flex-1 p-6 space-y-5">
          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
              {error}
            </div>
          )}

          {successMsg && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Master Password Section */}
          <div className="rounded-xl border border-cyan-900/40 bg-gradient-to-b from-cyan-950/20 to-slate-950/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 text-cyan-400" />
                  {t('Master Password (Hasło Główne)')}
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {t('Główny klucz kryptograficzny szyfrujący bazę danych, poświadczenia i klucze SSH')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setIsChangePasswordOpen((prev) => !prev);
                  setPasswordError(null);
                  setPasswordSuccessMsg(null);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                  isChangePasswordOpen
                    ? 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white'
                    : 'border-cyan-700/60 bg-cyan-950/60 text-cyan-200 hover:bg-cyan-900/60 hover:text-white shadow-sm'
                }`}
              >
                {isChangePasswordOpen ? t('Zwiń') : t('Zmień Master Password')}
              </button>
            </div>

            {passwordError && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400">
                {passwordError}
              </div>
            )}

            {passwordSuccessMsg && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400 mt-0.5" />
                <span>{passwordSuccessMsg}</span>
              </div>
            )}

            {isChangePasswordOpen && (
              <form onSubmit={handleChangeMasterPassword} className="pt-3 border-t border-cyan-900/30 space-y-3">
                <div className="rounded-lg bg-amber-950/25 border border-amber-800/40 p-2.5 text-[11px] text-amber-300/90 flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                  <span>
                    <strong>{t('Uwaga:')}</strong>{' '}
                    {t('Zmiana hasła głównego bezpiecznie odszyfruje i ponownie zaszyfruje wszystkie Twoje połączenia oraz poświadczenia nowym kluczem Argon2id + AES-256-GCM. Ze względów bezpieczeństwa ewentualny kod PIN zostanie zresetowany.')}
                  </span>
                </div>

                <div className="space-y-2.5">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300">
                      {t('Obecne Master Password')}
                    </label>
                    <div className="relative mt-1">
                      <input
                        type={showCurrentPassword ? 'text' : 'password'}
                        value={currentMasterPassword}
                        onChange={(e) => setCurrentMasterPassword(e.target.value)}
                        placeholder={t('Wprowadź obecne hasło główne...')}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-2 pr-9 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                      >
                        {showCurrentPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300">
                        {t('Nowe Master Password')}
                      </label>
                      <div className="relative mt-1">
                        <input
                          type={showNewPassword ? 'text' : 'password'}
                          value={newMasterPassword}
                          onChange={(e) => setNewMasterPassword(e.target.value)}
                          placeholder={t('Min. 8 znaków...')}
                          className="w-full rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-2 pr-9 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                        >
                          {showNewPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300">
                        {t('Powtórz Nowe Hasło')}
                      </label>
                      <div className="relative mt-1">
                        <input
                          type={showConfirmPassword ? 'text' : 'password'}
                          value={confirmMasterPassword}
                          onChange={(e) => setConfirmMasterPassword(e.target.value)}
                          placeholder={t('Powtórz nowe hasło...')}
                          className="w-full rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-2 pr-9 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                        >
                          {showConfirmPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end pt-1">
                  <button
                    type="submit"
                    disabled={changingPassword || !currentMasterPassword || !newMasterPassword}
                    className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-cyan-600/25 hover:opacity-95 disabled:opacity-50 transition-opacity"
                  >
                    {changingPassword && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <span>{changingPassword ? t('Re-szyfrowanie sejfu...') : t('Zastosuj nowe Master Password')}</span>
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* General Settings Form (PIN, Auto-Lock, SFTP Path) */}
          <form id="settings-general-form" onSubmit={handleSaveSettings} className="space-y-5">
            {/* PIN Lock Section */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Lock className="h-3.5 w-3.5 text-cyan-400" />
                    {t('Szybka blokada kodem PIN (Quick Unlock)')}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {t('Pozwala odblokować ekran kodem PIN zamiast długiego Master Password')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={pinEnabled}
                  onChange={(e) => setPinEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0 cursor-pointer"
                />
              </div>

              {pinEnabled && (
                <div className="pt-2 border-t border-slate-800/80 space-y-3">
                  <div className="rounded-lg bg-cyan-950/30 border border-cyan-800/30 p-2.5 text-[11px] text-cyan-300">
                    <strong>{t('Ważna zasada:')}</strong>{' '}
                    {t('Przy uruchomieniu aplikacji zawsze wymagany jest Master Password. Kod PIN chroni aktywne sesje podczas blokady ekranu lub bezczynności.')}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300">
                        {status.pinEnabled ? t('Zmień kod PIN') : t('Ustaw kod PIN (4-8 cyfr)')}
                      </label>
                      <input
                        type="password"
                        maxLength={8}
                        value={pinCode}
                        onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
                        placeholder={t('Wpisz PIN...')}
                        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-mono text-white focus:border-cyan-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-semibold text-slate-300">
                        {t('Powtórz kod PIN')}
                      </label>
                      <input
                        type="password"
                        maxLength={8}
                        value={confirmPinCode}
                        onChange={(e) => setConfirmPinCode(e.target.value.replace(/\D/g, ''))}
                        placeholder={t('Powtórz PIN...')}
                        className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-mono text-white focus:border-cyan-500 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Auto-Lock Settings */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-amber-400" />
                {t('Reguły automatycznej blokady')}
              </div>

              <label className="flex items-center justify-between cursor-pointer">
                <div className="text-xs text-slate-300">
                  {t('Blokuj program po wykryciu blokady systemu operacyjnego')}
                  <div className="text-[10px] text-slate-500">
                    {t('Windows (Win+L, wygaszacz z blokadą) / Linux (logind, ScreenSaver D-Bus)')}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={autoLockScreen}
                  onChange={(e) => setAutoLockScreen(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
              </label>

              <div className="flex items-center justify-between pt-2 border-t border-slate-800/80">
                <div className="text-xs text-slate-300">
                  {t('Automatyczna blokada przy bezczynności')}
                </div>
                <select
                  value={autoLockTimeout}
                  onChange={(e) => setAutoLockTimeout(Number(e.target.value))}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-white focus:border-cyan-500 focus:outline-none"
                >
                  <option value={0}>{t('Nigdy (Wyłączone)')}</option>
                  <option value={5}>{t('Po 5 minutach')}</option>
                  <option value={15}>{t('Po 15 minutach (Domyślnie)')}</option>
                  <option value={30}>{t('Po 30 minutach')}</option>
                  <option value={60}>{t('Po 60 minutach')}</option>
                </select>
              </div>
            </div>

            {/* Interface language */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Languages className="h-3.5 w-3.5 text-cyan-400" />
                    {t('Język interfejsu')}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t('Zmiana działa od razu, także na ekranie logowania.')}</p>
                </div>
                <LanguageSegmented />
              </div>
            </div>

            {/* Colour theme */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Palette className="h-3.5 w-3.5 text-cyan-400" />
                    {t('Motyw kolorystyczny')}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">{t('Jasny lub ciemny wygląd aplikacji. Zmiana działa od razu.')}</p>
                </div>
                <ThemeSegmented />
              </div>
              <TerminalDarkToggle />
              <LinuxRenderingSetting />
              <LinuxRdpClientSetting />
            </div>

            {/* Updates (GitHub Releases) */}
            <UpdateSettings />

            {/* SSH terminal */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <SquareTerminal className="h-3.5 w-3.5 text-emerald-400" />
                {t('Terminal SSH')}
              </div>
              <label className="flex items-center justify-between gap-3">
                <div className="text-xs text-slate-300">
                  {t('Bufor historii (liczba linii)')}
                  <div className="text-[10px] text-slate-500">
                    {t('Ile wcześniejszych linii można przewinąć myszą – także po rozłączeniu. Od {min} do {max}, domyślnie {def}. Większy bufor zużywa więcej pamięci.', {
                      min: MIN_TERMINAL_SCROLLBACK,
                      max: MAX_TERMINAL_SCROLLBACK,
                      def: DEFAULT_TERMINAL_SCROLLBACK,
                    })}
                  </div>
                </div>
                <input
                  type="number"
                  min={MIN_TERMINAL_SCROLLBACK}
                  max={MAX_TERMINAL_SCROLLBACK}
                  step={100}
                  value={uiSettings.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK}
                  onChange={(e) => {
                    const value = e.target.value === '' ? MIN_TERMINAL_SCROLLBACK : Number(e.target.value);
                    setUiSettings((u) => ({ ...u, terminalScrollback: value }));
                  }}
                  onBlur={() =>
                    setUiSettings((u) => ({ ...u, terminalScrollback: clampScrollback(u.terminalScrollback ?? DEFAULT_TERMINAL_SCROLLBACK) }))
                  }
                  className="w-28 shrink-0 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-right font-mono text-xs text-white focus:border-cyan-500 focus:outline-hidden"
                />
              </label>
            </div>

            {/* Confirmations */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <MessageSquareWarning className="h-3.5 w-3.5 text-rose-400" />
                {t('Potwierdzenia')}
              </div>

              <label className="flex items-center justify-between cursor-pointer">
                <div className="text-xs text-slate-300">
                  {t('Pytaj przed zamknięciem połączenia')}
                  <div className="text-[10px] text-slate-500">
                    {t('Wyłączone: zakładki połączeń (pojedyncze, pozostałe, wszystkie) zamykają się bez pytania')}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={uiSettings.confirmCloseSessions}
                  onChange={(e) => setUiSettings((u) => ({ ...u, confirmCloseSessions: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
              </label>

              <label className="flex items-center justify-between cursor-pointer pt-2 border-t border-slate-800/80">
                <div className="text-xs text-slate-300">
                  {t('Pytaj przed zamknięciem programu')}
                </div>
                <input
                  type="checkbox"
                  checked={uiSettings.confirmAppExit}
                  onChange={(e) => setUiSettings((u) => ({ ...u, confirmAppExit: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
                />
              </label>
            </div>

            {/* Periodic vault backups */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Archive className="h-3.5 w-3.5 text-emerald-400" />
                  {t('Kopie zapasowe sejfu')}
                </div>
                <input
                  type="checkbox"
                  checked={backupSettings.enabled}
                  onChange={(e) => setBackupSettings((b) => ({ ...b, enabled: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0 cursor-pointer"
                />
              </div>
              <p className="text-[11px] text-slate-400">
                {t('Kopia pliku z połączeniami jest tworzona automatycznie (tylko gdy dane się zmieniły). Kopie pozostają zaszyfrowane – do ich otwarcia potrzebne jest Master Password obowiązujące w chwili wykonania kopii.')}
              </p>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-[11px] text-slate-300">
                  {t('Częstotliwość')}
                  <select
                    value={backupSettings.intervalHours}
                    disabled={!backupSettings.enabled}
                    onChange={(e) => setBackupSettings((b) => ({ ...b, intervalHours: Number(e.target.value) }))}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white focus:border-cyan-500 focus:outline-none disabled:opacity-50"
                  >
                    <option value={1}>{t('Co godzinę')}</option>
                    <option value={6}>{t('Co 6 godzin')}</option>
                    <option value={12}>{t('Co 12 godzin')}</option>
                    <option value={24}>{t('Codziennie')}</option>
                    <option value={168}>{t('Co tydzień')}</option>
                  </select>
                </label>
                <label className="text-[11px] text-slate-300">
                  {t('Przechowuj kopii')}
                  <select
                    value={backupSettings.keep}
                    onChange={(e) => setBackupSettings((b) => ({ ...b, keep: Number(e.target.value) }))}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-white focus:border-cyan-500 focus:outline-none"
                  >
                    {[3, 5, 10, 20, 50].map((n) => (
                      <option key={n} value={n}>
                        {tn(n, ['{n} ostatnia', '{n} ostatnie', '{n} ostatnich'], { n })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={backupSettings.dir || ''}
                  onChange={(e) => setBackupSettings((b) => ({ ...b, dir: e.target.value }))}
                  placeholder={t('Domyślnie: folder „backups” obok pliku sejfu')}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={async () => {
                    const folder = await api.pickLocalFolder();
                    if (folder) setBackupSettings((b) => ({ ...b, dir: folder }));
                  }}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 hover:text-white transition-colors shrink-0"
                >
                  {t('Wybierz folder...')}
                </button>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-[10px] text-slate-500">
                  {t('Zmiany ustawień zapisz przyciskiem „Zapisz ustawienia”.')}
                </span>
                <button
                  type="button"
                  disabled={backupBusy}
                  onClick={handleBackupNow}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-600/50 bg-emerald-600/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/20 disabled:opacity-50"
                >
                  {backupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                  {t('Utwórz kopię teraz')}
                </button>
              </div>

              {backupMsg && (
                <div
                  className={`rounded-lg border p-2 text-[11px] break-all ${
                    backupMsg.type === 'success'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-red-500/30 bg-red-500/10 text-red-400'
                  }`}
                >
                  {backupMsg.text}
                </div>
              )}

              {backups.length > 0 && (
                <ul className="space-y-1.5 max-h-44 overflow-y-auto">
                  {backups.map((b) => (
                    <li
                      key={b.name}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="text-[11px] text-slate-200 truncate" title={b.path}>
                          {new Date(b.createdAt).toLocaleString(locale())}
                        </div>
                        <div className="font-mono text-[10px] text-slate-500 truncate">
                          {b.name} · {(b.size / 1024).toFixed(1)} KB
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={backupBusy}
                        onClick={() => setRestoreCandidate(b)}
                        title={t('Przywróć tę kopię')}
                        className="shrink-0 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 hover:bg-amber-500/10 hover:text-amber-300 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {t('Przywróć')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Trusted hosts (TOFU) */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-2.5">
              <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                <Fingerprint className="h-3.5 w-3.5 text-violet-400" />
                {t('Zaufane hosty (klucze SSH / certyfikaty RDP)')}
              </div>
              <p className="text-[11px] text-slate-400">
                {t('Odcisk serwera jest zapamiętywany przy pierwszym połączeniu. Jeśli później się zmieni, połączenie zostanie przerwane przed wysłaniem hasła. Usuń wpis tylko wtedy, gdy zmiana jest zamierzona.')}
              </p>
              {knownHosts.length === 0 ? (
                <div className="text-[11px] text-slate-500">{t('Brak zapamiętanych serwerów.')}</div>
              ) : (
                <ul className="space-y-1.5 max-h-48 overflow-y-auto">
                  {knownHosts.map((h) => (
                    <li
                      key={h.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-slate-200 truncate">{h.id}</div>
                        <div className="font-mono text-[10px] text-slate-500 truncate" title={h.fingerprint}>
                          {h.fingerprint}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleForgetHost(h.id)}
                        title={t('Zapomnij ten serwer')}
                        className="shrink-0 rounded-md p-1 text-slate-400 hover:bg-rose-500/10 hover:text-rose-300"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Cryptography & Storage Info */}
            <div className="rounded-xl border border-slate-800/80 bg-slate-900/60 p-3 text-[11px] text-slate-400 space-y-1.5">
              <div className="flex justify-between items-center gap-2">
                <span className="shrink-0">{t('Baza danych (sejf):')}</span>
                <span className="font-mono text-cyan-300 truncate text-[10px] max-w-[280px]" title={vaultPath}>
                  {vaultPath || 'vault.json'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t('Szyfrowanie bazy:')}</span>
                <span className="font-mono text-slate-200">{t('AES-256-GCM (NIST)')}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('Derywacja klucza KDF:')}</span>
                <span className="font-mono text-slate-200">{t('Argon2id (RFC 9106)')}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('Limit błędnych prób PIN:')}</span>
                <span className="font-mono text-slate-200">{t('3 próby ➔ Wymóg Master Password')}</span>
              </div>
            </div>
          </form>
        </div>

        {/* Footer buttons */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-4 bg-slate-900/90 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
          >
            {t('Zamknij')}
          </button>
          <button
            type="submit"
            form="settings-general-form"
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 px-5 py-2 text-xs font-semibold text-white shadow-md shadow-cyan-600/25 hover:opacity-95 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('Zapisz ustawienia')}
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={restoreCandidate !== null}
        title={t('Przywrócić kopię zapasową?')}
        message={
          restoreCandidate
            ? t(
                'Obecny sejf zostanie zastąpiony kopią z {date} (aktualny stan zostanie wcześniej zapisany jako osobna kopia). Aplikacja zostanie zablokowana – podaj Master Password, które obowiązywało w chwili wykonania tej kopii.',
                { date: new Date(restoreCandidate.createdAt).toLocaleString(locale()) }
              )
            : ''
        }
        confirmLabel={t('Przywróć')}
        onConfirm={() => restoreCandidate && handleRestoreBackup(restoreCandidate)}
        onCancel={() => setRestoreCandidate(null)}
      />
    </div>
  );
};

/** Settings → Updates: automatic checks and a manual "check now". */
const UpdateSettings: React.FC = () => {
  const t = useT();
  const [auto, setAuto] = useState(autoCheckEnabled());
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null);

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    try {
      const update = await checkForUpdate();
      if (update) {
        skipVersion(null); // a manual check shows also a version skipped before
        announceUpdate(update);
        setResult({ text: t('Dostępna wersja {version} – szczegóły w okienku w prawym dolnym rogu.', { version: update.version }) });
      } else {
        setResult({ text: t('Masz najnowszą wersję.') });
      }
    } catch (err: any) {
      setResult({ text: t('Nie udało się sprawdzić aktualizacji: {error}', { error: String(err?.message || err) }), error: true });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4 space-y-3">
      <div className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
        <Download className="h-3.5 w-3.5 text-cyan-400" />
        {t('Aktualizacje')}
      </div>
      <label className="flex items-center justify-between cursor-pointer">
        <div className="text-xs text-slate-300">
          {t('Sprawdzaj automatycznie')}
          <div className="text-[10px] text-slate-500">
            {t('Przy uruchomieniu i raz dziennie, z wydań projektu na GitHubie. Instalowane są tylko paczki podpisane kluczem projektu.')}
          </div>
        </div>
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked);
            setAutoCheckEnabled(e.target.checked);
          }}
          className="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-0"
        />
      </label>
      <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800/80">
        <div className="text-xs text-slate-300">
          {t('Zainstalowana wersja: {version}', { version: APP_VERSION })}
          {result && (
            <div className={`text-[10px] ${result.error ? 'text-red-400' : 'text-emerald-300'}`}>{result.text}</div>
          )}
        </div>
        <button
          type="button"
          onClick={checkNow}
          disabled={checking}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-1.5 text-[11px] text-slate-200 hover:bg-slate-700 disabled:opacity-60"
        >
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          {t('Sprawdź teraz')}
        </button>
      </div>
    </div>
  );
};
