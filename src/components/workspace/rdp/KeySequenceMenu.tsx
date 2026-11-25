/**
 * "Send key sequence" menu of the RDP session bar: shortcuts (Ctrl+Alt+Del, Win+L…), a custom
 * key combination and text typed as keystrokes. Keeps its own state; sending goes through the
 * callbacks of the viewer.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Clipboard, Keyboard, Send, ShieldCheck, Tv, X } from 'lucide-react';
import { useT } from '../../../i18n';
import { SCANCODE_OPTIONS } from './keys';

interface Props {
  isConnected: boolean;
  sendKeyCombination: (scancodes: number[], label?: string, useSpecial?: 'ctrlAltDel' | 'metaKey') => boolean;
  sendTextSequence: (text: string) => boolean | undefined;
  sendF5ToRemote: () => boolean;
  showToast: (msg: string, duration?: number) => void;
}

export const KeySequenceMenu: React.FC<Props> = ({ isConnected, sendKeyCombination, sendTextSequence, sendF5ToRemote, showToast }) => {
  const t = useT();
  // Key Sequence / Combination menu
  const [isKeyMenuOpen, setIsKeyMenuOpen] = useState(false);
  const [keyMenuTab, setKeyMenuTab] = useState<'shortcuts' | 'custom' | 'text'>('shortcuts');
  const [customCtrl, setCustomCtrl] = useState(true);
  const [customAlt, setCustomAlt] = useState(true);
  const [customShift, setCustomShift] = useState(false);
  const [customWin, setCustomWin] = useState(false);
  const [customKey, setCustomKey] = useState<number>(0xe053); // Delete by default
  const [customTextInput, setCustomTextInput] = useState('');
  const keyMenuRef = useRef<HTMLDivElement>(null);

  // Close Key Sequence menu on outside click
  useEffect(() => {
    if (!isKeyMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (keyMenuRef.current && !keyMenuRef.current.contains(e.target as Node)) {
        setIsKeyMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isKeyMenuOpen]);

  // Send custom constructed key combination
  const handleSendCustomCombo = useCallback(() => {
    const scancodes: number[] = [];
    if (customCtrl) scancodes.push(0x001d);
    if (customAlt) scancodes.push(0x0038);
    if (customShift) scancodes.push(0x002a);
    if (customWin) scancodes.push(0xe05b);
    if (customKey) scancodes.push(customKey);

    if (scancodes.length === 0) {
      showToast(t('Wybierz przynajmniej jeden klawisz'), 2000);
      return;
    }

    const labelParts: string[] = [];
    if (customCtrl) labelParts.push('Ctrl');
    if (customAlt) labelParts.push('Alt');
    if (customShift) labelParts.push('Shift');
    if (customWin) labelParts.push('Win');
    const keyOption = SCANCODE_OPTIONS.find((o) => o.code === customKey);
    if (keyOption) labelParts.push(t(keyOption.label));

    const label = labelParts.join(' + ');
    sendKeyCombination(scancodes, label);
    setIsKeyMenuOpen(false);
  }, [customCtrl, customAlt, customShift, customWin, customKey, sendKeyCombination, showToast]);

  return (
    <div className="relative" ref={keyMenuRef}>
      <button
        onClick={() => setIsKeyMenuOpen((v) => !v)}
        disabled={!isConnected}
        title={t('Wyślij sekwencję lub kombinację klawiszy do systemu Windows (Ctrl+Alt+Del, Win+L, itp.)')}
        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-40 disabled:pointer-events-none ${
          isKeyMenuOpen
            ? 'border-amber-500 bg-amber-950/70 text-amber-200 shadow-xs'
            : 'border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-700 hover:text-white'
        }`}
      >
        <Keyboard className="h-3.5 w-3.5 text-amber-400 shrink-0" />
        <span className="text-[11px] font-medium hidden sm:inline">{t('Wyślij sekwencję klawiszy')}</span>
        <ChevronDown
          className={`h-3 w-3 text-slate-400 transition-transform ${isKeyMenuOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {isKeyMenuOpen && (
        <div className="absolute right-0 top-full mt-1.5 w-84 sm:w-96 max-h-[80vh] overflow-y-auto rounded-xl border border-slate-700/80 bg-slate-900/98 p-3 shadow-2xl backdrop-blur-md z-50 text-slate-200">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2.5">
            <div className="flex items-center gap-1.5">
              <Keyboard className="h-4 w-4 text-amber-400" />
              <span className="text-xs font-bold text-white">{t('Sekwencja klawiszy Windows')}</span>
            </div>
            <button
              onClick={() => setIsKeyMenuOpen(false)}
              className="rounded-md p-1 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex rounded-lg bg-slate-950 p-0.5 mb-3 border border-slate-800">
            <button
              onClick={() => setKeyMenuTab('shortcuts')}
              className={`flex-1 rounded-md py-1 text-[11px] font-semibold transition-all ${
                keyMenuTab === 'shortcuts'
                  ? 'bg-slate-800 text-cyan-300 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Szybkie skróty')}
            </button>
            <button
              onClick={() => setKeyMenuTab('custom')}
              className={`flex-1 rounded-md py-1 text-[11px] font-semibold transition-all ${
                keyMenuTab === 'custom'
                  ? 'bg-slate-800 text-cyan-300 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Własna kombinacja')}
            </button>
            <button
              onClick={() => setKeyMenuTab('text')}
              className={`flex-1 rounded-md py-1 text-[11px] font-semibold transition-all ${
                keyMenuTab === 'text'
                  ? 'bg-slate-800 text-cyan-300 shadow-xs'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('Wpisz tekst')}
            </button>
          </div>

          {/* Tab: Szybkie skróty */}
          {keyMenuTab === 'shortcuts' && (
            <div className="space-y-3">
              {/* System i Logowanie */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
                  <ShieldCheck className="h-3 w-3 text-cyan-400" />
                  <span>{t('System i Logowanie')}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => {
                      sendKeyCombination([0x001d, 0x0038, 0xe053], t('Ctrl + Alt + Del'), 'ctrlAltDel');
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-950/20 px-2.5 py-1.5 text-left hover:bg-amber-900/40 hover:border-amber-500/60 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-amber-300">Ctrl+Alt+Del</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Logowanie')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0x001d, 0x002a, 0x0001], t('Ctrl + Shift + Esc'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-cyan-300">Ctrl+Shift+Esc</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menedżer')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x0026], t('Win + L'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-blue-300">{t('Win + L')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Zablokuj')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b], t('Klawisz Windows'), 'metaKey');
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-blue-400">{t('Klawisz Win')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menu Start')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x0013], t('Win + R'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + R')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Uruchom')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x0012], t('Win + E'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + E')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Eksplorator')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x0020], t('Win + D'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + D')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Pulpit')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x002d], t('Win + X'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + X')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menu szybkie')}</span>
                  </button>
                </div>
              </div>

              {/* Okna i Aplikacje */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
                  <Tv className="h-3 w-3 text-purple-400" />
                  <span>{t('Okna i Aplikacje')}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => {
                      sendKeyCombination([0x0038, 0x000f], t('Alt + Tab'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-purple-300">{t('Alt + Tab')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Przełącz okno')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0x0038, 0x003e], t('Alt + F4'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-950/20 px-2.5 py-1.5 text-left hover:bg-red-900/40 hover:border-red-500/50 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-red-300">{t('Alt + F4')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Zamknij okno')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0xe048], t('Win + Góra'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + ↑')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Maksymalizuj')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0xe050], t('Win + Dół'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + ↓')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Minimalizuj')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0x0038, 0x0039], t('Alt + Spacja'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Alt + Spacja')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Menu okna')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x000f], t('Win + Tab'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + Tab')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Widok zadań')}</span>
                  </button>
                </div>
              </div>

              {/* Narzędzia i Schowek */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1.5 flex items-center gap-1.5">
                  <Clipboard className="h-3 w-3 text-emerald-400" />
                  <span>{t('Narzędzia i Schowek')}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x002a, 0x001f], t('Win + Shift + S'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-emerald-300">Win+Shift+S</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Wycinanie')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe037], t('Print Screen'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Print Screen')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Zrzut ekranu')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendKeyCombination([0xe05b, 0x002f], t('Win + V'));
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-slate-200">{t('Win + V')}</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Schowek Win')}</span>
                  </button>

                  <button
                    onClick={() => {
                      sendF5ToRemote();
                      setIsKeyMenuOpen(false);
                    }}
                    className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-left hover:bg-slate-700 transition-colors group"
                  >
                    <span className="text-[11px] font-semibold text-amber-400">F5</span>
                    <span className="text-[9px] text-slate-400 group-hover:text-slate-200">{t('Odśwież')}</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Tab: Własna kombinacja */}
          {keyMenuTab === 'custom' && (
            <div className="space-y-3">
              <div>
                <span className="text-[11px] font-medium text-slate-300 block mb-1.5">
                  {t('Klawisze modyfikujące:')}
                </span>
                <div className="grid grid-cols-4 gap-1.5">
                  {[
                    { label: 'Ctrl', active: customCtrl, toggle: () => setCustomCtrl(!customCtrl) },
                    { label: 'Alt', active: customAlt, toggle: () => setCustomAlt(!customAlt) },
                    { label: 'Shift', active: customShift, toggle: () => setCustomShift(!customShift) },
                    { label: 'Win', active: customWin, toggle: () => setCustomWin(!customWin) },
                  ].map((mod) => (
                    <button
                      key={mod.label}
                      type="button"
                      onClick={mod.toggle}
                      className={`flex items-center justify-center rounded-lg border py-1.5 text-xs font-semibold transition-all ${
                        mod.active
                          ? 'border-cyan-500 bg-cyan-950/70 text-cyan-200 shadow-xs'
                          : 'border-slate-700 bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-700'
                      }`}
                    >
                      {mod.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-[11px] font-medium text-slate-300 block mb-1.5">
                  {t('Klawisz główny:')}
                </span>
                <select
                  value={customKey}
                  onChange={(e) => setCustomKey(parseInt(e.target.value, 10))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 focus:border-cyan-500 focus:outline-hidden"
                >
                  {Object.entries(
                    SCANCODE_OPTIONS.reduce((acc, opt) => {
                      if (!acc[opt.group]) acc[opt.group] = [];
                      acc[opt.group].push(opt);
                      return acc;
                    }, {} as Record<string, typeof SCANCODE_OPTIONS>)
                  ).map(([group, opts]) => (
                    <optgroup key={group} label={t(group)} className="bg-slate-900 text-slate-300">
                      {opts.map((opt) => (
                        <option key={opt.label + opt.code} value={opt.code} className="bg-slate-800 text-slate-200">
                          {t(opt.label)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              {/* Preview and Send button */}
              <div className="flex items-center gap-2 pt-2 border-t border-slate-800">
                <div className="flex-1 min-w-0 font-mono text-xs text-cyan-300 bg-slate-950 border border-slate-800 px-2.5 py-1.5 rounded-lg truncate text-center">
                  {[
                    customCtrl && 'Ctrl',
                    customAlt && 'Alt',
                    customShift && 'Shift',
                    customWin && 'Win',
                    t(SCANCODE_OPTIONS.find((o) => o.code === customKey)?.label || 'Klawisz'),
                  ]
                    .filter(Boolean)
                    .join(' + ')}
                </div>
                <button
                  onClick={handleSendCustomCombo}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 transition-colors shrink-0 shadow-xs"
                >
                  <Send className="h-3 w-3" />
                  <span>{t('Wyślij klawisze')}</span>
                </button>
              </div>
            </div>
          )}

          {/* Tab: Wpisz tekst */}
          {keyMenuTab === 'text' && (
            <div className="space-y-2">
              <span className="text-[11px] text-slate-300 block">
                {t('Wpisz tekst do wysłania jako sekwencję naciśnięć klawiszy do systemu Windows:')}
              </span>
              <textarea
                value={customTextInput}
                onChange={(e) => setCustomTextInput(e.target.value)}
                placeholder={t('Wpisz lub wklej tekst do wysłania...')}
                rows={3}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-hidden resize-none font-mono"
              />
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    sendTextSequence(customTextInput);
                    setCustomTextInput('');
                    setIsKeyMenuOpen(false);
                  }}
                  disabled={!customTextInput.trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:pointer-events-none transition-colors shadow-xs"
                >
                  <Send className="h-3 w-3" />
                  <span>{t('Wyślij tekst ({n} zn.)', { n: customTextInput.length })}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
