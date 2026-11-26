import React, { useState } from 'react';
import { Lock, ShieldAlert, KeyRound, Loader2, ArrowRight } from 'lucide-react';
import { APP_VERSION } from '../../version';
import { api } from '../../services/api';
import { VaultStatus } from '../../types';
import { useT } from '../../i18n';
import { MAX_PIN_LEN, MIN_PIN_LEN } from '../../utils/pin';

interface Props {
  onUnlocked: (status: VaultStatus) => void;
  onUseMasterPassword: () => void;
}

export const PinModal: React.FC<Props> = ({ onUnlocked, onUseMasterPassword }) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useT();

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!pin) return;

    setError(null);
    setLoading(true);
    try {
      const status = await api.unlockPin(pin);
      onUnlocked(status);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setPin('');
      // Too many attempts (or PIN no longer armed): the backend dropped the PIN-wrapped key,
      // only the Master Password can unlock now.
      if (/Przekroczono limit|nie jest aktywna|Too many|not active/i.test(msg)) {
        setTimeout(() => onUseMasterPassword(), 1500);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleDigitClick = (digit: string) => {
    if (pin.length < MAX_PIN_LEN) {
      const nextPin = pin + digit;
      setPin(nextPin);
      if (nextPin.length >= 4) {
        // Can be auto submitted if typical 4-digit PIN or user can press enter
      }
    }
  };

  const handleBackspace = () => {
    setPin(prev => prev.slice(0, -1));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 backdrop-blur-md p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl text-center">
        {/* Lock Icon */}
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
          <Lock className="h-7 w-7" />
        </div>

        <h2 className="text-xl font-bold text-white">{t('Ekran zablokowany')}</h2>
        <p className="mt-1 text-xs text-slate-400">
          {t('Wprowadź kod PIN, aby powrócić do aktywnych sesji')}
        </p>
        <p className="mt-1 font-mono text-[10px] text-slate-500">RemoteFlow {APP_VERSION}</p>

        {/* PIN Dots */}
        <div className="my-6 flex justify-center gap-3">
          {/* One dot per typed digit (at least four placeholders) – the PIN can have 4 to 12 digits */}
          {Array.from({ length: Math.max(MIN_PIN_LEN, pin.length) }, (_, idx) => idx).map((idx) => (
            <div
              key={idx}
              className={`h-4 w-4 rounded-full border transition-all ${
                idx < pin.length
                  ? 'border-cyan-400 bg-cyan-400 shadow-md shadow-cyan-400/50'
                  : 'border-slate-700 bg-slate-800'
              }`}
            />
          ))}
        </div>

        {/* Keyboard input */}
        <form onSubmit={handleSubmit} className="mb-4">
          <input
            type="password"
            maxLength={MAX_PIN_LEN}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            autoFocus
            placeholder={t('Wpisz PIN...')}
            className="w-full text-center tracking-widest text-lg font-mono rounded-xl border border-slate-700 bg-slate-800/80 py-2.5 text-white placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
          />
        </form>

        {error && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400 text-left">
            <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
        )}

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-2.5 mb-4">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              onClick={() => handleDigitClick(digit)}
              className="flex h-12 items-center justify-center rounded-xl bg-slate-800/90 text-lg font-semibold text-slate-200 transition-colors hover:bg-slate-700 active:scale-95"
            >
              {digit}
            </button>
          ))}
          <button
            type="button"
            onClick={handleBackspace}
            className="flex h-12 items-center justify-center rounded-xl bg-slate-800/50 text-sm font-medium text-slate-400 hover:bg-slate-800 active:scale-95"
          >
            ← {t('Cofnij')}
          </button>
          <button
            type="button"
            onClick={() => handleDigitClick('0')}
            className="flex h-12 items-center justify-center rounded-xl bg-slate-800/90 text-lg font-semibold text-slate-200 transition-colors hover:bg-slate-700 active:scale-95"
          >
            0
          </button>
          <button
            type="button"
            disabled={pin.length < MIN_PIN_LEN || loading}
            onClick={() => handleSubmit()}
            className="flex h-12 items-center justify-center rounded-xl bg-cyan-600 text-sm font-semibold text-white shadow-md shadow-cyan-600/30 transition-all hover:bg-cyan-500 disabled:opacity-40 active:scale-95"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-5 w-5" />}
          </button>
        </div>

        {/* Fallback to Master Password */}
        <button
          type="button"
          onClick={onUseMasterPassword}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-400 transition-colors"
        >
          <KeyRound className="h-3.5 w-3.5" />
          {t('Użyj Master Password zamiast PIN')}
        </button>
      </div>
    </div>
  );
};
