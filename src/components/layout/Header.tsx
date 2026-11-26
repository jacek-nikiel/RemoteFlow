import React from 'react';
import {
  Lock,
  Settings,
  Activity,
  ArrowDownUp,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { APP_VERSION } from '../../version';
import { VaultStatus } from '../../types';
import { useT } from '../../i18n';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { AppLogo } from '../common/AppLogo';

interface Props {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  activeSessionsCount: number;
  vaultStatus: VaultStatus | null;
  onOpenCredentials: () => void;
  onLock: () => void;
  onOpenSettings: () => void;
  onOpenImportExport: () => void;
}

export const Header: React.FC<Props> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  activeSessionsCount,
  vaultStatus,
  onOpenCredentials,
  onLock,
  onOpenSettings,
  onOpenImportExport,
}) => {
  const t = useT();
  return (
    <header className="flex h-9 items-center justify-between border-b border-slate-800 bg-slate-900/90 px-3 select-none">
      {/* Brand & Sidebar Toggle & Stats */}
      <div className="flex items-center gap-2.5">
        {/* Toggle Sidebar Button (Pełny ekran dla aktywnego okna) */}
        <button
          onClick={onToggleSidebar}
          title={
            isSidebarCollapsed
              ? t('Pokaż panel połączeń (drzewo hostów) [Ctrl+Shift+B]')
              : t('Schowaj panel połączeń (pełny ekran dla terminala) [Ctrl+Shift+B]')
          }
          className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-slate-800 bg-slate-800/60 text-slate-300 transition-colors hover:border-cyan-500/40 hover:bg-slate-800 hover:text-cyan-400"
        >
          {isSidebarCollapsed ? (
            <PanelLeftOpen className="h-3.5 w-3.5" />
          ) : (
            <PanelLeftClose className="h-3.5 w-3.5" />
          )}
        </button>

        <div className="flex items-center gap-1.5">
          <AppLogo className="h-6 w-6 drop-shadow-[0_1px_2px_rgba(6,182,212,0.25)]" />
          <span className="text-xs font-bold tracking-tight text-white">
            Remote<span className="text-cyan-400">Flow</span>
          </span>
          <span
            title={t('RemoteFlow wersja {v}', { v: APP_VERSION })}
            className="rounded border border-slate-700/80 bg-slate-800/60 px-1 py-px font-mono text-[9.5px] leading-none text-slate-400"
          >
            v{APP_VERSION}
          </span>
        </div>

        {/* 100+ concurrent connections capacity badge */}
        <div className="flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-950/70 px-2 py-0.5 text-[11px] text-slate-300">
          <span className="relative flex h-1.5 w-1.5">
            <span
              className={`absolute inline-flex h-full w-full animate-ping rounded-full ${
                activeSessionsCount > 0 ? 'bg-emerald-400 opacity-75' : 'bg-slate-500 opacity-20'
              }`}
            />
            <span
              className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                activeSessionsCount > 0 ? 'bg-emerald-500' : 'bg-slate-600'
              }`}
            />
          </span>
          <Activity className="h-2.5 w-2.5 text-cyan-400" />
          <span className="font-mono text-[10px]">
            {activeSessionsCount}
            <span className="text-slate-500"> / 100+ {t('sesji')}</span>
          </span>
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-1.5">
        <button
          onClick={onOpenCredentials}
          title={t('Zarządzaj poświadczeniami (współdzielone loginy, hasła, klucze)')}
          className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-800/60 px-2 py-1 text-[11px] font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <KeyRound className="h-3 w-3 text-emerald-400" />
          <span>{t('Poświadczenia')}</span>
          {vaultStatus && vaultStatus.credentialsCount > 0 && (
            <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-mono text-emerald-300">
              {vaultStatus.credentialsCount}
            </span>
          )}
        </button>

        <button
          onClick={onOpenImportExport}
          title={t('Import / Eksport bazy połączeń (mRemoteNG, JSON, .rfvault)')}
          className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-800/60 px-2 py-1 text-[11px] font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white"
        >
          <ArrowDownUp className="h-3 w-3 text-cyan-400" />
          <span>{t('Import / Eksport')}</span>
        </button>

        <LanguageSwitcher />

        <div className="h-3 w-px bg-slate-800 mx-0.5" />

        <button
          onClick={onLock}
          title={
            vaultStatus?.pinEnabled
              ? t('Zablokuj aplikację kodem PIN (Ctrl+Shift+L)')
              : t('Zablokuj aplikację hasłem Master (Ctrl+Shift+L)')
          }
          className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-slate-800 bg-slate-800/40 text-slate-400 transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-400"
        >
          <Lock className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={onOpenSettings}
          title={t('Ustawienia')}
          className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-slate-800 bg-slate-800/40 text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-800 hover:text-white"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
};
