import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api, isTauri } from './services/api';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Connection, Credential, Group, SavedWorkspace, SessionInfo, UiSettings, VaultStatus, WorkspaceLayout } from './types';
import { setTerminalScrollback } from './utils/terminalSettings';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/sidebar/Sidebar';
import { TabBar } from './components/workspace/TabBar';
import { Workspace } from './components/workspace/Workspace';
import { MasterPasswordScreen } from './components/lockscreen/MasterPasswordScreen';
import { PinModal } from './components/lockscreen/PinModal';
import { ConnectionModal } from './components/dialogs/ConnectionModal';
import { GroupModal } from './components/dialogs/GroupModal';
import { CredentialsModal } from './components/dialogs/CredentialsModal';
import { SettingsModal } from './components/dialogs/SettingsModal';
import { UpdateNotice } from './components/common/UpdateNotice';
import { ImportExportModal } from './components/dialogs/ImportExportModal';
import { PassphrasePromptModal } from './components/dialogs/PassphrasePromptModal';
import { ConfirmDialog, DialogAnchor } from './components/dialogs/ConfirmDialog';
import { Loader2 } from 'lucide-react';
import { CommandPalette } from './components/palette/CommandPalette';
import { QuickTarget } from './utils/quickConnect';
import { RdpCertificateDialog } from './components/dialogs/RdpCertificateDialog';
import { EmptyPasswordDialog } from './components/dialogs/EmptyPasswordDialog';
import { PasswordPromptCancelled } from './utils/passwordPrompt';
import { tn, useT } from './i18n';
import { effectiveSshAuthType } from './utils/sshAuth';

/** The key goes to a session: the SSH terminal (xterm.js) or the embedded RDP picture. */
function isSessionKeyTarget(e: KeyboardEvent): boolean {
  return e.composedPath().some(
    (el) => el instanceof HTMLElement && (el.tagName === 'IRON-REMOTE-DESKTOP' || el.classList.contains('xterm'))
  );
}

export const App: React.FC = () => {
const t = useT();
  const [loading, setLoading] = useState(true);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  // One-off security notice from the backend (vault migration, accepted external modification, ...)
  const [securityWarning, setSecurityWarning] = useState<string | null>(null);

  // Data
  const [groups, setGroups] = useState<Group[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Active Sessions, Split Layout & Panes
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Quick Connect (command palette): connections not saved in the vault, kept while their tabs are open
  const [adhocConnections, setAdhocConnections] = useState<Connection[]>([]);
  const allConnections = useMemo(() => [...connections, ...adhocConnections], [connections, adhocConnections]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [connDraft, setConnDraft] = useState<Partial<Connection> | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [layout, setLayout] = useState<WorkspaceLayout>('single');
  const [paneSlots, setPaneSlots] = useState<string[]>([]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // Modals
  const [isConnModalOpen, setIsConnModalOpen] = useState(false);
  const [editingConn, setEditingConn] = useState<Connection | null>(null);
  const [defaultGroupId, setDefaultGroupId] = useState<string | null>(null);

  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Group | null>(null);
  const [defaultParentGroupId, setDefaultParentGroupId] = useState<string | null>(null);

  const [isCredentialsModalOpen, setIsCredentialsModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isImportExportModalOpen, setIsImportExportModalOpen] = useState(false);
  // `resolve`: restoring previous sessions waits for the answer (the passphrase or null = cancelled)
  const [passphrasePrompt, setPassphrasePrompt] = useState<{
    conn: Connection;
    allowDuplicate: boolean;
    resolve?: (passphrase: string | null) => void;
  } | null>(null);

  // Load vault status on mount
  const checkStatus = useCallback(async () => {
    try {
      const status = await api.getStatus();
      setVaultStatus(status);
      if (status.isUnlocked) {
        await api.maximizeWindow();
        await loadData();
      }
    } catch (err) {
      console.error('Error fetching vault status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadData = async () => {
    try {
      const data = await api.getVaultData();
      setGroups(data.groups);
      setConnections(data.connections);
      const creds = await api.getCredentials();
      setCredentials(creds);
    } catch (err) {
      console.error('Error loading vault data:', err);
    }
  };

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  // Lock handler (PIN if enabled, else Master Password)
  const handleLock = useCallback(async () => {
    if (!vaultStatus?.isUnlocked) return;
    try {
      const lockedToPin = await api.lockToPin();
      const status = await api.getStatus();
      setVaultStatus({
        ...status,
        isUnlocked: false,
        isPinLocked: lockedToPin,
      });
    } catch (err) {
      console.error('Lock error:', err);
    }
  }, [vaultStatus]);



  // Vault locked by the backend because the operating-system session was locked
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<boolean>('vault-auto-locked', async () => {
      try {
        const status = await api.getStatus();
        setVaultStatus(status);
      } catch (err) {
        console.error('Błąd odświeżania stanu sejfu po blokadzie systemu:', err);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Inactivity auto-lock: the backend locks the vault after the configured idle time (it keeps
  // working when the window is minimised and web-view timers are throttled). The UI only reports
  // user activity – throttled to one call per 15 s.
  useEffect(() => {
    if (!vaultStatus?.isUnlocked) return;

    let lastReport = 0;
    const updateActivity = () => {
      const now = Date.now();
      if (now - lastReport > 15000) {
        lastReport = now;
        api.touchActivity().catch(() => {});
      }
    };
    updateActivity();

    const events = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((ev) => window.addEventListener(ev, updateActivity, { capture: true, passive: true }));
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, updateActivity, { capture: true }));
    };
  }, [vaultStatus?.isUnlocked]);

  // Global prevention of accidental F5 / Ctrl+R page reloads in desktop app
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
    };
  }, []);

  // Connecting to a single session
  const handleConnect = async (
    conn: Connection,
    allowDuplicate = false,
    customPassphrase?: string,
    /** Called with the new tab's id as soon as the tab exists (before the connection is up). */
    onCreated?: (sessionId: string) => void
  ) => {
    // Check if key passphrase prompt is needed
    const cred = conn.credentialId ? credentials.find((c) => c.id === conn.credentialId) : undefined;
    const authType = effectiveSshAuthType(conn, cred);
    const isKeyAuth = conn.protocol === 'ssh' && (authType === 'key' || authType === 'certificate');
    const needsPassphrasePrompt =
      isKeyAuth &&
      (Boolean(conn.promptKeyPassphrase) || Boolean(conn.credentialId && cred?.promptKeyPassphrase));

    if (needsPassphrasePrompt && customPassphrase === undefined) {
      setPassphrasePrompt({ conn, allowDuplicate });
      return;
    }

    // Check if session already open (unless duplicating)
    if (!allowDuplicate) {
      const existing = sessions.find((s) => s.connectionId === conn.id);
      if (existing) {
        setActiveSessionId(existing.sessionId);
        return;
      }
    }

    const sessionId = 'sess-' + Math.random().toString(36).substring(2, 9) + '-' + Date.now();
    try {
      await api.ensureConnectionPassword(conn.id, sessionId);
    } catch (err) {
      if (!(err instanceof PasswordPromptCancelled)) setSecurityWarning(String(err));
      return;
    }

    const tunnelsDesc = conn.portForwarding
      .filter((p) => p.enabled)
      .map((p) =>
        p.forwardType === 'dynamic'
          ? `-D :${p.localPort} (SOCKS5)`
          : p.forwardType === 'remote'
            ? `-R ${t('serwer')}:${p.localPort} -> ${p.remoteHost || '127.0.0.1'}:${p.remotePort}`
            : `-L ${p.localPort} -> ${p.remoteHost || '127.0.0.1'}:${p.remotePort}`
      );

    const initialSession: SessionInfo = {
      sessionId,
      connectionId: conn.id,
      title: conn.name,
      protocol: conn.protocol,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      status: 'connecting',
      statusMessage: t('Nawiązywanie połączenia...'),
      bytesSent: 0,
      bytesReceived: 0,
      startedAt: new Date().toISOString(),
      activePortForwards: tunnelsDesc,
    };

    // 1. Mount terminal & register listener immediately before connection starts!
    setSessions((prev) => [...prev, initialSession]);
    setActiveSessionId(sessionId);
    setPaneSlots((prev) => [sessionId, ...prev.filter((id) => id !== sessionId)]);
    onCreated?.(sessionId);

    // 2. Connect via Tauri backend
    try {
      const sess = await api.connectSession(
        sessionId,
        conn.id,
        conn.name,
        conn.protocol,
        conn.host,
        conn.port,
        conn.username,
        tunnelsDesc,
        customPassphrase
      );

      // SSH: the backend reports the real state (login, errors) via `session-status`, which may
      // already have arrived – do not overwrite it with the initial "connecting".
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId
            ? {
                ...s,
                ...sess,
                status: s.status !== 'connecting' && sess.status === 'connecting' ? s.status : sess.status,
                statusMessage:
                  s.status !== 'connecting' && sess.status === 'connecting' ? s.statusMessage : sess.statusMessage,
              }
            : s
        )
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('Connect error:', errMsg);
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId
            ? { ...s, status: 'error', statusMessage: errMsg }
            : s
        )
      );
    }
  };

  // Connect to all connections in a group (Założenie 3)
  const handleConnectAllInGroup = async (_group: Group, conns: Connection[]) => {
    if (conns.length === 0) return;

    for (const conn of conns) {
      const alreadyOpen = sessions.some((s) => s.connectionId === conn.id);
      if (alreadyOpen) continue;
      await handleConnect(conn);
    }
  };

  // Reconnect / Reload session (odświeżenie / ponowne nawiązanie połączenia)
  const handleReconnectSession = async (sessionId: string) => {
    const sess = sessions.find((s) => s.sessionId === sessionId);
    if (!sess) return;
    const conn = allConnections.find((c) => c.id === sess.connectionId);
    if (!conn) return;

    try {
      await api.closeSession(sessionId);
    } catch (e) {
      console.warn('Error closing session on reconnect:', e);
    }

    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
    await handleConnect(conn, true);
  };

  // Duplicate session in a new tab
  const handleDuplicateSession = async (sessionId: string) => {
    const sess = sessions.find((s) => s.sessionId === sessionId);
    if (!sess) return;
    const conn = allConnections.find((c) => c.id === sess.connectionId);
    if (!conn) return;

    await handleConnect(conn, true);
  };

  // Pending close request awaiting user confirmation
  const [pendingClose, setPendingClose] = useState<
    | { kind: 'one'; sessionId: string; anchor: DialogAnchor }
    | { kind: 'others'; sessionId: string; anchor: DialogAnchor }
    | { kind: 'right'; sessionId: string; anchor: DialogAnchor }
    | { kind: 'all'; anchor: DialogAnchor }
    | null
  >(null);

  // Confirmation preferences (stored in the vault, cached here so they also work while locked)
  const [uiSettings, setUiSettings] = useState<UiSettings>({ confirmCloseSessions: true, confirmAppExit: true });
  const uiSettingsRef = useRef(uiSettings);
  uiSettingsRef.current = uiSettings;

  useEffect(() => {
    if (!vaultStatus?.isUnlocked) return;
    api
      .getUiSettings()
      .then((s) => {
        setUiSettings(s);
        setTerminalScrollback(s.terminalScrollback);
      })
      .catch(() => {});
  }, [vaultStatus?.isUnlocked]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<UiSettings>).detail;
      if (detail) {
        setUiSettings(detail);
        setTerminalScrollback(detail.terminalScrollback);
      }
    };
    window.addEventListener('remoteflow-ui-settings', onChanged);
    return () => window.removeEventListener('remoteflow-ui-settings', onChanged);
  }, []);

  // Session state reported by the backend workers (SSH: connected after login, error, disconnected)
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    let cancelled = false;
    listen<{ sessionId: string; status: SessionInfo['status']; message?: string | null }>('session-status', (e) => {
      const { sessionId, status, message } = e.payload;
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sessionId ? { ...s, status, statusMessage: message ?? undefined } : s))
      );
    }).then((fn) => (cancelled ? fn() : (un = fn)));
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // Vault changed outside the main forms (e.g. SFTP start folders saved from the SFTP window)
  useEffect(() => {
    const onVaultChanged = () => void loadData();
    window.addEventListener('remoteflow-vault-changed', onVaultChanged);
    return () => window.removeEventListener('remoteflow-vault-changed', onVaultChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closePromptAnchor = (anchor?: DialogAnchor | null): DialogAnchor => anchor ?? {
    x: Math.max(8, window.innerWidth - 360), y: 72, placement: 'below',
  };

  const handleCloseSession = (sessionId: string, anchor?: DialogAnchor | null) => {
    if (!sessions.some((s) => s.sessionId === sessionId)) return;
    if (!uiSettings.confirmCloseSessions) return closeSessionNow(sessionId);
    setPendingClose({ kind: 'one', sessionId, anchor: closePromptAnchor(anchor) });
  };

  const handleCloseOtherSessions = (keepSessionId: string, anchor?: DialogAnchor | null) => {
    if (!sessions.some((s) => s.sessionId !== keepSessionId)) return;
    if (!uiSettings.confirmCloseSessions) return closeOtherSessionsNow(keepSessionId);
    setPendingClose({ kind: 'others', sessionId: keepSessionId, anchor: closePromptAnchor(anchor) });
  };

  /** Tabs to the right of the given one (in tab order). */
  const sessionsRightOf = (sessionId: string) => {
    const index = sessions.findIndex((s) => s.sessionId === sessionId);
    return index === -1 ? [] : sessions.slice(index + 1);
  };

  const handleCloseSessionsToRight = (sessionId: string, anchor?: DialogAnchor | null) => {
    if (sessionsRightOf(sessionId).length === 0) return;
    if (!uiSettings.confirmCloseSessions) return closeSessionsToRightNow(sessionId);
    setPendingClose({ kind: 'right', sessionId, anchor: closePromptAnchor(anchor) });
  };

  const handleCloseAllSessions = (anchor?: DialogAnchor | null) => {
    if (sessions.length === 0) return;
    if (!uiSettings.confirmCloseSessions) return closeAllSessionsNow();
    setPendingClose({ kind: 'all', anchor: closePromptAnchor(anchor) });
  };

  // Confirmation before exiting the application (window close button, Alt+F4, ...)
  const [exitPrompt, setExitPrompt] = useState(false);
  const exitStateRef = useRef({ sessions: 0, unlocked: false });
  exitStateRef.current = { sessions: sessions.length, unlocked: !!vaultStatus?.isUnlocked };

  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    let cancelled = false;
    getCurrentWindow()
      .onCloseRequested((event) => {
        // Always intercept; the application is closed by the backend (app_exit) so that a missing
        // window permission can never leave the window impossible to close.
        event.preventDefault();
        const { sessions: open, unlocked } = exitStateRef.current;
        // Locked with nothing open (start / lock screen) – nothing to lose, close immediately
        if (!uiSettingsRef.current.confirmAppExit || (!unlocked && open === 0)) {
          flushWorkspaceRef.current().finally(() => api.exitApp().catch(() => {}));
          return;
        }
        setExitPrompt(true);
      })
      .then((fn) => (cancelled ? fn() : (un = fn)))
      .catch(() => {});
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // --- Command palette / Quick Connect ----------------------------------------------------------
  const handleQuickConnect = async (target: QuickTarget, auth: { sshAuthType: 'password' | 'agent'; password: string }) => {
    const conn = await api.adhocConnectionCreate(target.protocol, target.host, target.port, target.username, auth.sshAuthType, auth.password);
    setAdhocConnections((prev) => [...prev, conn]);
    await handleConnect(conn, true);
  };

  // A quick connection is forgotten (with its password) when its last tab is closed
  const usedAdhocRef = useRef(new Set<string>());
  useEffect(() => {
    if (adhocConnections.length === 0) return;
    const open = new Set(sessions.map((s) => s.connectionId));
    const gone = adhocConnections.filter((c) => {
      if (open.has(c.id)) {
        usedAdhocRef.current.add(c.id);
        return false;
      }
      return usedAdhocRef.current.has(c.id);
    });
    if (gone.length === 0) return;
    gone.forEach((c) => {
      usedAdhocRef.current.delete(c.id);
      api.adhocConnectionForget(c.id).catch(() => {});
    });
    setAdhocConnections((prev) => prev.filter((c) => !gone.some((g) => g.id === c.id)));
  }, [sessions, adhocConnections]);

  // Locked with the Master Password: the backend forgot the quick connections
  useEffect(() => {
    if (vaultStatus && !vaultStatus.isUnlocked && !vaultStatus.isPinLocked) {
      setAdhocConnections([]);
      setPaletteOpen(false);
    }
    if (vaultStatus && !vaultStatus.isUnlocked) setPaletteOpen(false);
  }, [vaultStatus]);


  // --- Restore previous sessions (Settings → Confirmations) -----------------------------------
  // The open tabs are written to the vault (debounced) while the option is on; after the first
  // unlock of a run they are opened again. Only connections saved in the vault are kept.
  const slotCountOf = (l: WorkspaceLayout) => (l === 'columns-3' ? 3 : l === 'grid-4' ? 4 : l === 'single' ? 1 : 2);
  const restoringRef = useRef(false);
  const restoreRequestedRef = useRef(false);
  const [restorePending, setRestorePending] = useState(false);
  const requestRestore = () => {
    if (restoreRequestedRef.current) return;
    restoreRequestedRef.current = true; // once per run – a later unlock keeps the running tabs
    restoringRef.current = true; // no saving (of the still empty tab list) before the saved one is read
    setRestorePending(true);
  };

  const currentWorkspace = (): SavedWorkspace | null => {
    const known = new Set(connections.map((c) => c.id));
    const tabs = sessions.filter((s) => known.has(s.connectionId));
    if (tabs.length === 0) return null;
    const index = (sessionId: string | null | undefined) => tabs.findIndex((s) => s.sessionId === sessionId);
    return {
      tabs: tabs.map((s) => s.connectionId),
      layout,
      panes: paneSlots.slice(0, slotCountOf(layout)).map(index),
      active: index(activeSessionId) >= 0 ? index(activeSessionId) : null,
    };
  };
  const workspaceRef = useRef<() => SavedWorkspace | null>(() => null);
  workspaceRef.current = currentWorkspace;
  const saveEnabled = !!uiSettings.restoreSessions && !!vaultStatus?.isUnlocked;
  const saveEnabledRef = useRef(saveEnabled);
  saveEnabledRef.current = saveEnabled;
  // Saves now (application exit); never while the tabs are still being restored
  const flushWorkspaceRef = useRef<() => Promise<void>>(async () => {});
  flushWorkspaceRef.current = async () => {
    if (!saveEnabledRef.current || restoringRef.current) return;
    await api.setSavedWorkspace(workspaceRef.current()).catch(() => {});
  };

  useEffect(() => {
    if (!saveEnabled || restoringRef.current) return;
    const timer = setTimeout(() => {
      if (!restoringRef.current) api.setSavedWorkspace(workspaceRef.current()).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveEnabled, sessions.length, sessions.map((s) => s.sessionId).join(','), layout, paneSlots.join(','), activeSessionId]);

  const handleConnectRef = useRef(handleConnect);
  handleConnectRef.current = handleConnect;
  const connectionsRef = useRef(connections);
  connectionsRef.current = connections;
  const credentialsRef = useRef(credentials);
  credentialsRef.current = credentials;
  const sessionsCountRef = useRef(0);
  sessionsCountRef.current = sessions.length;

  useEffect(() => {
    if (!restorePending) return;
    setRestorePending(false);
    (async () => {
      const ws = await api.getSavedWorkspace().catch(() => null);
      if (!ws || ws.tabs.length === 0 || sessionsCountRef.current > 0) {
        restoringRef.current = false;
        return;
      }
      const ids: (string | null)[] = [];
      try {
        for (const connectionId of ws.tabs) {
          const conn = connectionsRef.current.find((c) => c.id === connectionId);
          if (!conn) {
            ids.push(null);
            continue;
          }
          // A key with "ask for the passphrase" – wait for the answer before the next tab
          const cred = conn.credentialId ? credentialsRef.current.find((c) => c.id === conn.credentialId) : undefined;
          const authType = effectiveSshAuthType(conn, cred);
          const asks =
            conn.protocol === 'ssh' &&
            (authType === 'key' || authType === 'certificate') &&
            (Boolean(conn.promptKeyPassphrase) || Boolean(cred?.promptKeyPassphrase));
          let passphrase: string | undefined;
          if (asks) {
            const answer = await new Promise<string | null>((resolve) => setPassphrasePrompt({ conn, allowDuplicate: true, resolve }));
            if (answer === null) {
              ids.push(null);
              continue;
            }
            passphrase = answer;
          }
          // Resolves when the tab exists (or the connection was given up, e.g. password prompt cancelled)
          const id = await new Promise<string | null>((resolve) => {
            handleConnectRef.current(conn, true, passphrase, resolve).then(() => resolve(null), () => resolve(null));
          });
          ids.push(id);
        }
        const open = ids.filter((id): id is string => !!id);
        if (open.length === 0) return;
        const visible = ws.panes.map((i) => (i >= 0 ? ids[i] : null)).filter((id): id is string => !!id);
        const layoutToUse = open.length > 1 ? ws.layout : 'single';
        setLayout(layoutToUse);
        setPaneSlots([...visible, ...open.filter((id) => !visible.includes(id))]);
        const active = ws.active != null ? ids[ws.active] : null;
        setActiveSessionId(active ?? visible[0] ?? open[0]);
      } finally {
        restoringRef.current = false;
      }
    })();
  }, [restorePending]);

  const confirmPendingClose = () => {
    const req = pendingClose;
    setPendingClose(null);
    if (!req) return;
    if (req.kind === 'one') closeSessionNow(req.sessionId);
    else if (req.kind === 'others') closeOtherSessionsNow(req.sessionId);
    else if (req.kind === 'right') closeSessionsToRightNow(req.sessionId);
    else closeAllSessionsNow();
  };

  const describePendingClose = (): { title: string; message: string } => {
    if (!pendingClose) return { title: '', message: '' };
    if (pendingClose.kind === 'one') {
      const s = sessions.find((x) => x.sessionId === pendingClose.sessionId);
      const name = s ? `${s.title} (${s.protocol.toUpperCase()} ${s.host}:${s.port})` : t('tę sesję');
      return {
        title: t('Zamknąć połączenie?'),
        message: t('Połączenie {name} zostanie rozłączone. Niezapisana praca w sesji może zostać utracona.', { name }),
      };
    }
    if (pendingClose.kind === 'others') {
      const count = sessions.filter((x) => x.sessionId !== pendingClose.sessionId).length;
      return {
        title: t('Zamknąć pozostałe połączenia?'),
        message: t('Zostanie rozłączonych {count} pozostałych sesji (bieżąca pozostanie otwarta).', { count }),
      };
    }
    if (pendingClose.kind === 'right') {
      const count = sessionsRightOf(pendingClose.sessionId).length;
      return {
        title: t('Zamknąć karty po prawej?'),
        message: tn(count, ['Zostanie rozłączona {count} sesja z karty po prawej stronie wskazanej karty.', 'Zostaną rozłączone {count} sesje z kart po prawej stronie wskazanej karty.', 'Zostanie rozłączonych {count} sesji z kart po prawej stronie wskazanej karty.'], { count }),
      };
    }
    return {
      title: t('Zamknąć wszystkie połączenia?'),
      message: tn(sessions.length, ['Zostanie rozłączona {length} aktywna sesja.', 'Zostaną rozłączone wszystkie {length} aktywne sesje.', 'Zostanie rozłączonych wszystkich {length} aktywnych sesji.'], { length: sessions.length }),
    };
  };

  // Close session tab (optimistic immediate UI update)
  const closeSessionNow = async (sessionId: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.sessionId !== sessionId);
      if (activeSessionId === sessionId) {
        const nextActive = remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
        setActiveSessionId(nextActive);
      }
      return remaining;
    });
    setPaneSlots((prev) => prev.filter((id) => id !== sessionId));

    try {
      await api.closeSession(sessionId);
    } catch (err) {
      console.error('Close session error:', err);
    }
  };

  // Close other tabs except keepSessionId
  const closeOtherSessionsNow = async (keepSessionId: string) => {
    const toClose = sessions.filter((s) => s.sessionId !== keepSessionId);
    setSessions((prev) => prev.filter((s) => s.sessionId === keepSessionId));
    setActiveSessionId(keepSessionId);

    for (const s of toClose) {
      try {
        await api.closeSession(s.sessionId);
      } catch (err) {
        console.warn('Close other session error:', err);
      }
    }
  };

  const closeSessionsToRightNow = async (sessionId: string) => {
    const toClose = sessionsRightOf(sessionId);
    if (toClose.length === 0) return;
    const closing = new Set(toClose.map((s) => s.sessionId));
    setSessions((prev) => prev.filter((s) => !closing.has(s.sessionId)));
    if (activeSessionId && closing.has(activeSessionId)) setActiveSessionId(sessionId);
    setPaneSlots((prev) => prev.filter((id) => !closing.has(id)));

    for (const s of toClose) {
      try {
        await api.closeSession(s.sessionId);
      } catch (err) {
        console.warn('Close session to the right error:', err);
      }
    }
  };

  const closeAllSessionsNow = async () => {
    const toClose = [...sessions];
    setSessions([]);
    setActiveSessionId(null);

    for (const s of toClose) {
      try {
        await api.closeSession(s.sessionId);
      } catch (err) {
        console.warn('Close session error:', err);
      }
    }
  };

  // Reorder tabs by drag-and-drop
  const handleReorderSessions = (sourceId: string, targetId: string, position: 'left' | 'right') => {
    setSessions((prev) => {
      const sourceIndex = prev.findIndex((s) => s.sessionId === sourceId);
      const targetIndex = prev.findIndex((s) => s.sessionId === targetId);
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
        return prev;
      }

      const newSessions = [...prev];
      const [movedSession] = newSessions.splice(sourceIndex, 1);

      let newTargetIndex = newSessions.findIndex((s) => s.sessionId === targetId);
      if (position === 'right') {
        newTargetIndex += 1;
      }

      newSessions.splice(newTargetIndex, 0, movedSession);
      return newSessions;
    });
  };

  // Helper to keep paneSlots valid and synced with open sessions
  // An effect of an earlier render can run its updater after newer updates were queued (tabs
  // opened quickly one after another, e.g. restored sessions): a tab this render has not seen yet
  // must not be dropped from the panes – only tabs that were open and are gone (closed).
  const seenSessionIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const openIds = sessions.map((s) => s.sessionId);
    openIds.forEach((id) => seenSessionIdsRef.current.add(id));
    setPaneSlots((prev) => {
      const valid = prev.filter((id) => openIds.includes(id) || !seenSessionIdsRef.current.has(id));
      const missing = openIds.filter((id) => !valid.includes(id));
      return [...valid, ...missing];
    });
  }, [sessions]);

  const handleUpdatePaneSlot = (paneIndex: number, sessionId: string) => {
    setPaneSlots((prev) => {
      const next = [...prev];
      const existingIndex = next.indexOf(sessionId);
      if (existingIndex !== -1 && existingIndex !== paneIndex) {
        const temp = next[paneIndex];
        next[paneIndex] = sessionId;
        next[existingIndex] = temp;
      } else {
        next[paneIndex] = sessionId;
      }
      return next;
    });
    setActiveSessionId(sessionId);
  };

  const handleSwapPaneSlots = (sourceIndex: number, targetIndex: number) => {
    setPaneSlots((prev) => {
      const next = [...prev];
      const temp = next[sourceIndex];
      next[sourceIndex] = next[targetIndex];
      next[targetIndex] = temp;
      return next;
    });
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    if (layout === 'single') {
      setPaneSlots((prev) => [sessionId, ...prev.filter((id) => id !== sessionId)]);
    } else {
      const slotCount = layout === 'columns-3' ? 3 : layout === 'grid-4' ? 4 : 2;
      const visibleSlots = paneSlots.slice(0, slotCount);
      if (!visibleSlots.includes(sessionId)) {
        const activeIndex = paneSlots.indexOf(activeSessionId || '');
        const targetPane = activeIndex >= 0 && activeIndex < slotCount ? activeIndex : 0;
        handleUpdatePaneSlot(targetPane, sessionId);
      }
    }
  };

  const handleChangeLayout = (newLayout: WorkspaceLayout) => {
    setLayout(newLayout);
    const needed = newLayout === 'columns-3' ? 3 : newLayout === 'grid-4' ? 4 : newLayout === 'single' ? 1 : 2;
    setPaneSlots(() => {
      const available = sessions.map((s) => s.sessionId);
      const activeId = activeSessionId;
      const initial = activeId && available.includes(activeId) ? [activeId] : [];
      const others = available.filter((id) => !initial.includes(id));
      const result = [...initial, ...others].slice(0, needed);
      return result;
    });
  };

  // Toggle left connections sidebar (fullscreen terminal mode)
  const toggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => {
      const next = !prev;
      setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new CustomEvent('remoteflow-focus-terminal'));
      }, 50);
      return next;
    });
  }, []);

  // Keyboard shortcuts: Ctrl+L (Lock), F5 / Ctrl+R (Reload active connection), Ctrl+B (Toggle Sidebar).
  // In a session (SSH terminal, RDP picture) these keys belong to the remote side – Ctrl+L clears
  // the shell / goes to the address bar in Windows, Ctrl+R searches the history, Ctrl+B is the tmux
  // prefix – so there they are ignored. Ctrl+Shift+L / Ctrl+Shift+B work everywhere, also in a
  // session: they are caught before the session sees them.
  useEffect(() => {
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== 'l' && key !== 'b' && key !== 'k') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (key === 'l') handleLock();
      else if (key === 'k') setPaletteOpen((o) => !o);
      else toggleSidebar();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented && e.shiftKey) return; // handled above
      if (isSessionKeyTarget(e)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleLock();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        if (activeSessionId) {
          handleReconnectSession(activeSessionId);
        }
      }
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleLock, toggleSidebar, activeSessionId, handleReconnectSession]);

  // CRUD connections & groups
  const handleSaveConnection = async (
    conn: Connection,
    rawPassword?: string,
    rawKey?: string,
    rawPassphrase?: string
  ) => {
    // The backend can lock between the last UI event and this submit. Reconcile
    // the lock screen without closing the editor or throwing away its draft.
    const status = await api.getStatus();
    if (!status.isUnlocked) {
      setVaultStatus(status);
      throw new Error(t('Sejf został zablokowany. Odblokuj aplikację i ponownie zapisz zmiany.'));
    }
    let saved: Connection;
    try {
      saved = await api.saveConnection(conn, rawPassword, rawKey, rawPassphrase);
    } catch (error) {
      // Also cover a lock arriving after the status check but before the write.
      const latest = await api.getStatus().catch(() => null);
      if (latest && !latest.isUnlocked) setVaultStatus(latest);
      throw error;
    }
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      return idx >= 0 ? prev.map((c) => (c.id === saved.id ? saved : c)) : [...prev, saved];
    });
  };

  // Cloning asks for confirmation next to the clicked connection
  const [pendingClone, setPendingClone] = useState<{ connection: Connection; anchor: DialogAnchor | null } | null>(null);

  const handleCloneConnection = (source: Connection, anchor?: DialogAnchor | null) => {
    setPendingClone({ connection: source, anchor: anchor ?? null });
  };

  const cloneConnectionNow = async (source: Connection) => {
    try {
      const copy = await api.cloneConnection(source.id);
      setConnections((previous) => {
        if (previous.some((connection) => connection.id === copy.id)) return previous;
        const next = [...previous];
        const index = next.findIndex((connection) => connection.id === source.id);
        next.splice(index < 0 ? next.length : index + 1, 0, copy);
        return next;
      });
    } catch (error) {
      setSecurityWarning(t('Nie udało się sklonować połączenia: {error}', { error: String(error) }));
    }
  };

  // Deleting a connection / folder asks for confirmation next to the clicked item
  const [pendingDelete, setPendingDelete] = useState<{
    kind: 'connection' | 'group';
    id: string;
    anchor: DialogAnchor | null;
  } | null>(null);

  const handleDeleteConnection = (id: string, anchor?: DialogAnchor | null) => {
    setPendingDelete({ kind: 'connection', id, anchor: anchor ?? null });
  };

  const deleteConnectionNow = async (id: string) => {
    await api.deleteConnection(id);
    // Connections that went through it as a jump host now connect directly (as in the vault)
    setConnections((prev) => prev.filter((c) => c.id !== id).map((c) => (c.jumpHostId === id ? { ...c, jumpHostId: undefined } : c)));
  };

  const describePendingDelete = (): { title: string; message: string } => {
    if (!pendingDelete) return { title: '', message: '' };
    if (pendingDelete.kind === 'connection') {
      const c = connections.find((x) => x.id === pendingDelete.id);
      return {
        title: t('Usunąć połączenie?'),
        message:
          (c
            ? t('Połączenie „{name}” ({p1} {host}:{port}) zostanie trwale usunięte z sejfu.', { name: c.name, p1: c.protocol.toUpperCase(), host: c.host, port: c.port })
            : t('Połączenie zostanie trwale usunięte z sejfu.')) +
          (() => {
            const users = connections.filter((x) => x.jumpHostId === pendingDelete.id).map((x) => x.name);
            return users.length
              ? ' ' + t('Jest serwerem pośredniczącym (jump host) dla: {names} – te połączenia będą łączyć się bezpośrednio.', { names: users.slice(0, 5).join(', ') + (users.length > 5 ? '…' : '') })
              : '';
          })(),
      };
    }
    const g = groups.find((x) => x.id === pendingDelete.id);
    return {
      title: t('Usunąć folder?'),
      message: g
        ? t('Folder „{name}” zostanie usunięty. Połączenia w nim zostaną zachowane.', { name: g.name })
        : t('Folder zostanie usunięty. Połączenia w nim zostaną zachowane.'),
    };
  };

  const confirmPendingDelete = () => {
    const req = pendingDelete;
    setPendingDelete(null);
    if (!req) return;
    const run = req.kind === 'connection' ? deleteConnectionNow(req.id) : deleteGroupNow(req.id);
    run.catch((err: unknown) => console.error('Usuwanie nie powiodło się:', err));
  };

  const handleSaveGroup = async (group: Group): Promise<Group> => {
    const saved = await api.saveGroup(group);
    setGroups((prev) => {
      const idx = prev.findIndex((g) => g.id === saved.id);
      return idx >= 0 ? prev.map((g) => (g.id === saved.id ? saved : g)) : [...prev, saved];
    });
    return saved;
  };

  const handleDeleteGroup = (id: string, anchor?: DialogAnchor | null) => {
    setPendingDelete({ kind: 'group', id, anchor: anchor ?? null });
  };

  const deleteGroupNow = async (id: string) => {
    await api.deleteGroup(id);
    // Subfolders move up to the parent of the deleted folder (as in the backend)
    setGroups((prev) => {
      const parentId = prev.find((g) => g.id === id)?.parentId ?? null;
      return prev.filter((g) => g.id !== id).map((g) => (g.parentId === id ? { ...g, parentId } : g));
    });
    setConnections((prev) =>
      prev.map((c) => (c.groupId === id ? { ...c, groupId: null } : c))
    );
  };

  // Move connection between folders via Drag & Drop
  const handleMoveConnection = async (connectionId: string, targetGroupId: string | null) => {
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn || conn.groupId === targetGroupId) return;

    const updated: Connection = {
      ...conn,
      groupId: targetGroupId,
      updatedAt: new Date().toISOString(),
    };

    setConnections((prev) => prev.map((c) => (c.id === connectionId ? updated : c)));
    try {
      await api.saveConnection(updated);
    } catch (err) {
      console.error('Failed to move connection:', err);
      await loadData();
    }
  };

  // Add nested child folder (subfolder)
  const handleAddSubgroup = (parentId: string) => {
    setEditingGroup(null);
    setDefaultParentGroupId(parentId);
    setIsGroupModalOpen(true);
  };

  if (loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-white">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  // If vault is not initialized or locked with Master Password
  const needsMasterPassword =
    !vaultStatus || !vaultStatus.isInitialized || (!vaultStatus.isUnlocked && !vaultStatus.isPinLocked);

  const masterPasswordScreen = needsMasterPassword ? (
    <MasterPasswordScreen
      status={vaultStatus || {
        isInitialized: false,
        isUnlocked: false,
        isPinLocked: false,
        pinEnabled: false,
        autoLockScreen: true,
        autoLockTimeoutMins: 15,
        failedPinAttempts: 0,
        connectionsCount: 0,
        groupsCount: 0,
        credentialsCount: 0,
      }}
      onUnlocked={async (updated) => {
        setVaultStatus(updated);
        if (updated.securityWarning) {
          setSecurityWarning(updated.securityWarning);
        }
        if (updated.isUnlocked) {
          await api.maximizeWindow();
          await loadData();
          requestRestore();
          // Open sessions were kept running under the lock screen – refit and refocus them
          setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new CustomEvent('remoteflow-focus-terminal'));
          }, 100);
        }
      }}
      onReset={() => {
        // Resetting the vault ends every open session
        sessions.forEach((s) => api.closeSession(s.sessionId).catch(() => {}));
        setGroups([]);
        setConnections([]);
        setCredentials([]);
        setSessions([]);
        setActiveSessionId(null);
        setIsConnModalOpen(false);
        setEditingConn(null);
        setIsGroupModalOpen(false);
        setEditingGroup(null);
        setIsCredentialsModalOpen(false);
        setIsSettingsModalOpen(false);
        setIsImportExportModalOpen(false);
      }}
    />
  ) : null;

  // Keep editors and session viewers mounted across both PIN and full locks.
  // Unmounting an unfinished editor discarded its draft on Master Password unlock.
  if (!vaultStatus) {
    return masterPasswordScreen;
  }

  return (
    <>
    <div
      inert={!vaultStatus.isUnlocked}
      aria-hidden={!vaultStatus.isUnlocked}
      className="flex h-screen w-screen flex-col bg-slate-950 text-slate-100 overflow-hidden font-sans"
    >
      {securityWarning && (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-[60] max-w-md rounded-xl border border-amber-500/40 bg-slate-900/95 p-4 text-xs text-amber-200 shadow-2xl"
        >
          <div className="mb-1 font-bold text-amber-300">{t('Komunikat bezpieczeństwa')}</div>
          <div className="whitespace-pre-line leading-relaxed">{securityWarning}</div>
          <div className="mt-3 text-right">
            <button
              type="button"
              onClick={() => setSecurityWarning(null)}
              className="rounded-lg border border-amber-500/40 px-3 py-1 font-semibold hover:bg-amber-500/10"
            >
              {t('Rozumiem')}
            </button>
          </div>
        </div>
      )}
      {/* New version from GitHub Releases */}
      <UpdateNotice activeSessions={sessions.length} />
      {/* Top Header Bar */}
      <Header
        isSidebarCollapsed={isSidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        activeSessionsCount={sessions.length}
        vaultStatus={vaultStatus}
        onOpenCredentials={() => setIsCredentialsModalOpen(true)}
        onLock={handleLock}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        onOpenImportExport={() => setIsImportExportModalOpen(true)}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {/* Main Split Layout: Left Menu (Sidebar) / Right Pane (Tabs + Workspace) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Pane (Założenie 5) - Collapsible for full screen */}
        {!isSidebarCollapsed && (
          <Sidebar
            groups={groups}
            connections={connections}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onConnect={handleConnect}
            onConnectAllInGroup={handleConnectAllInGroup}
            onEditConnection={(conn) => {
              setEditingConn(conn);
              setIsConnModalOpen(true);
            }}
            onDeleteConnection={handleDeleteConnection}
            onCloneConnection={handleCloneConnection}
            onEditGroup={(grp) => {
              setEditingGroup(grp);
              setDefaultParentGroupId(grp.parentId);
              setIsGroupModalOpen(true);
            }}
            onDeleteGroup={handleDeleteGroup}
            onAddConnectionToGroup={(grpId) => {
              setEditingConn(null);
              setDefaultGroupId(grpId);
              setIsConnModalOpen(true);
            }}
            onAddSubgroup={handleAddSubgroup}
            onMoveConnection={handleMoveConnection}
            onNewConnection={() => {
              setEditingConn(null);
              setDefaultGroupId(null);
              setIsConnModalOpen(true);
            }}
            onNewGroup={() => {
              setEditingGroup(null);
              setDefaultParentGroupId(null);
              setIsGroupModalOpen(true);
            }}
          />
        )}

        {/* Right Pane (Założenie 5) */}
        <main className="flex flex-1 flex-col overflow-hidden bg-slate-950">
          {/* Active Tabs Bar */}
          <TabBar
            sessions={sessions}
            connections={allConnections}
            groups={groups}
            activeSessionId={activeSessionId}
            layout={layout}
            paneSlots={paneSlots}
            onChangeLayout={handleChangeLayout}
            isSidebarCollapsed={isSidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onSelectSession={handleSelectSession}
            onCloseSession={handleCloseSession}
            onReconnectSession={handleReconnectSession}
            onDuplicateSession={handleDuplicateSession}
            onCloseOtherSessions={handleCloseOtherSessions}
            onCloseSessionsToRight={handleCloseSessionsToRight}
            onCloseAll={handleCloseAllSessions}
            onReorderSessions={handleReorderSessions}
            onSaveToVault={(sessionId) => {
              const sess = sessions.find((s) => s.sessionId === sessionId);
              const conn = sess && adhocConnections.find((c) => c.id === sess.connectionId);
              if (!conn) return;
              setEditingConn(null);
              setDefaultGroupId(null);
              setConnDraft({ name: conn.host, protocol: conn.protocol, host: conn.host, port: conn.port, username: conn.username, sshAuthType: conn.sshAuthType });
              setIsConnModalOpen(true);
            }}
          />

          {/* Active Workspace / Terminal / RDP Frame */}
          <div className="flex-1 overflow-hidden">
            <Workspace
              groups={groups}
              sessions={sessions}
              activeSessionId={activeSessionId}
              connections={connections}
              layout={layout}
              paneSlots={paneSlots}
              onChangeLayout={handleChangeLayout}
              onUpdatePaneSlot={handleUpdatePaneSlot}
              onSwapPaneSlots={handleSwapPaneSlots}
              onSelectSession={handleSelectSession}
              onCloseSession={handleCloseSession}
              onReconnectSession={handleReconnectSession}
              onConnect={handleConnect}
              onNewConnection={() => {
                setEditingConn(null);
                setDefaultGroupId(null);
                setIsConnModalOpen(true);
              }}
            />
          </div>
        </main>
      </div>

      {/* Confirmation before closing connections */}
      <ConfirmDialog
        isOpen={pendingClose !== null}
        anchor={pendingClose?.anchor}
        dimBackdrop={false}
        title={describePendingClose().title}
        message={describePendingClose().message}
        confirmLabel={t('Rozłącz')}
        onConfirm={confirmPendingClose}
        onCancel={() => setPendingClose(null)}
      />

      {/* Confirmation before cloning a connection (shown next to the clicked item) */}
      <ConfirmDialog
        isOpen={pendingClone !== null}
        anchor={pendingClone?.anchor}
        variant="info"
        title={t('Sklonować połączenie?')}
        message={
          pendingClone
            ? t('Zostanie utworzona kopia połączenia „{name}” ({p1} {host}:{port}) razem z zapisanymi danymi logowania i tunelami.', {
                name: pendingClone.connection.name,
                p1: pendingClone.connection.protocol.toUpperCase(),
                host: pendingClone.connection.host,
                port: pendingClone.connection.port,
              })
            : ''
        }
        confirmLabel={t('Klonuj')}
        onConfirm={() => {
          const req = pendingClone;
          setPendingClone(null);
          if (req) void cloneConnectionNow(req.connection);
        }}
        onCancel={() => setPendingClone(null)}
      />

      {/* Confirmation before deleting a connection / folder (shown next to the clicked item) */}
      <ConfirmDialog
        isOpen={pendingDelete !== null}
        title={describePendingDelete().title}
        message={describePendingDelete().message}
        confirmLabel={t('Usuń')}
        anchor={pendingDelete?.anchor}
        onConfirm={confirmPendingDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* Connection Add/Edit Modal */}
      <ConnectionModal
        isOpen={isConnModalOpen}
        onClose={() => {
          setIsConnModalOpen(false);
          setConnDraft(null);
        }}
        onSave={handleSaveConnection}
        editingConnection={editingConn}
        draft={connDraft}
        connections={connections}
        groups={groups}
        credentials={credentials}
        defaultGroupId={defaultGroupId}
        onCreateGroup={handleSaveGroup}
      />

      {/* Group Add/Edit Modal */}
      <GroupModal
        isOpen={isGroupModalOpen}
        onClose={() => {
          setIsGroupModalOpen(false);
          setDefaultParentGroupId(null);
        }}
        onSave={handleSaveGroup}
        editingGroup={editingGroup}
        groups={groups}
        defaultParentId={defaultParentGroupId}
      />

      {/* Credentials Management Modal */}
      <CredentialsModal
        isOpen={isCredentialsModalOpen}
        onClose={() => setIsCredentialsModalOpen(false)}
        credentials={credentials}
        onCredentialsChanged={loadData}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
        status={vaultStatus}
        onStatusUpdated={setVaultStatus}
      />

      {/* Import & Export Modal */}
      <ImportExportModal
        isOpen={isImportExportModalOpen}
        groups={groups}
        connections={connections}
        onClose={() => setIsImportExportModalOpen(false)}
        onDataChanged={loadData}
      />

      {/* Passphrase Prompt Modal */}
      <PassphrasePromptModal
        isOpen={passphrasePrompt !== null}
        connection={passphrasePrompt?.conn || null}
        onConnect={(enteredPassphrase) => {
          if (passphrasePrompt) {
            const { conn, allowDuplicate, resolve } = passphrasePrompt;
            setPassphrasePrompt(null);
            if (resolve) resolve(enteredPassphrase);
            else handleConnect(conn, allowDuplicate, enteredPassphrase);
          }
        }}
        onClose={() => {
          passphrasePrompt?.resolve?.(null);
          setPassphrasePrompt(null);
        }}
      />
    </div>
    {/* Outside the inert workspace and above every editor/menu, including portals. */}
    {!vaultStatus.isUnlocked && <div className="fixed inset-0 z-[200]" data-vault-lock-screen>
      {masterPasswordScreen}
      {vaultStatus.isPinLocked && <PinModal
        onUnlocked={async (updated) => {
          setVaultStatus(updated);
          if (updated.isUnlocked) {
            await api.maximizeWindow();
            await loadData();
            requestRestore();
          }
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('remoteflow-focus-terminal'));
          }, 100);
        }}
        onUseMasterPassword={async () => {
          await api.lockVault();
          setVaultStatus((prev) => (prev ? { ...prev, isPinLocked: false, isUnlocked: false } : null));
        }}
      />}
    </div>}
    <CommandPalette
      isOpen={paletteOpen && !!vaultStatus?.isUnlocked}
      onClose={() => {
        setPaletteOpen(false);
        setTimeout(() => window.dispatchEvent(new CustomEvent('remoteflow-focus-terminal')), 50);
      }}
      connections={connections}
      groups={groups}
      sessions={sessions}
      onConnect={(conn, newTab) => {
        const open = !newTab && sessions.find((s) => s.connectionId === conn.id);
        if (open) handleSelectSession(open.sessionId);
        else handleConnect(conn, newTab);
      }}
      onQuickConnect={handleQuickConnect}
    />
    <RdpCertificateDialog sessions={sessions} unlocked={!!vaultStatus?.isUnlocked} />
    <EmptyPasswordDialog unlocked={!!vaultStatus?.isUnlocked} onSaved={(saved) => {
      setConnections((prev) => prev.map((conn) => conn.id === saved.id ? saved : conn));
    }} />

    {/* Confirmation before exiting the application – above the PIN / Master Password lock screens
        (z-[200]); previously it opened underneath them and could not be clicked */}
    <ConfirmDialog
      isOpen={exitPrompt}
      aboveLockScreen
      title={t('Zamknąć RemoteFlow?')}
      message={
        sessions.length > 0
          ? t('Program zostanie zamknięty, a aktywne połączenia ({length}) zostaną rozłączone.', { length: sessions.length })
          : t('Czy na pewno chcesz zamknąć program?')
      }
      confirmLabel={t('Zamknij program')}
      onConfirm={async () => {
        await flushWorkspaceRef.current();
        setExitPrompt(false);
        api.exitApp().catch(() => {});
      }}
      onCancel={() => setExitPrompt(false)}
    />
    </>
  );
};

export default App;
