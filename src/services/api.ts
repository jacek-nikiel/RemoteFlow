import { invoke } from '@tauri-apps/api/core';
import { ConnectionPasswordStatus, PasswordPromptCancelled, requestConnectionPassword } from '../utils/passwordPrompt';
import { t } from '../i18n';
import { selectExportData } from '../utils/exportScope';
import { effectiveSshAuthType } from '../utils/sshAuth';
import { forgetOscCwd } from '../utils/terminalCwd';

// An explicit decision to use an empty password lasts for this session only.
const emptyPasswordSessions = new Set<string>();

export interface RdpCertificateInfo {
  connectionId: string;
  host: string;
  port: number;
  fingerprint: string;
  previousFingerprint: string | null;
}
import { BackupEntry, BackupSettings, UiSettings, TransferSummary, SftpFileEntry, Connection, Credential, Group, ImportSummary, KnownHostEntry, SessionInfo, SftpListResponse, VaultData, VaultStatus } from '../types';

export const isTauri = () => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
};

/** True when the app runs on Windows (WebView2 user agent). */
export const isWindowsHost = () => {
  return typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
};

// Fallback in-memory mock for web preview/testing
let mockUnlocked = false;
let mockUiSettings: UiSettings = { confirmCloseSessions: true, confirmAppExit: true };
let mockPinLocked = false;
let mockPinEnabled = true;
let mockInitialized = true;
let mockGroups: Group[] = [
  { id: 'group-prod', name: 'Produkcja (Linux/SSH)', parentId: null, icon: 'server', color: '#ef4444' },
  { id: 'group-rdp', name: 'Serwery Windows (RDP)', parentId: null, icon: 'monitor', color: '#3b82f6' },
  { id: 'group-tunnels', name: 'Tunele & SOCKS5 Proxy', parentId: null, icon: 'network', color: '#10b981' },
];

let mockConnections: Connection[] = [
  {
    id: 'conn-1',
    name: 'web-prod-01 (Nginx)',
    groupId: 'group-prod',
    protocol: 'ssh',
    host: '192.168.10.15',
    port: 22,
    username: 'admin',
    passwordEncrypted: 'mock-enc-pass',
    sshAuthType: 'key',
    portForwarding: [
      { id: 'pf-1', forwardType: 'local', localPort: 8080, remoteHost: 'localhost', remotePort: 80, enabled: true },
      { id: 'pf-2', forwardType: 'dynamic', localPort: 1080, enabled: true },
    ],
    tags: ['web', 'frontend', 'dmz'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'conn-2',
    name: 'db-cluster-master (PostgreSQL)',
    groupId: 'group-prod',
    protocol: 'ssh',
    host: '10.0.5.20',
    port: 2222,
    username: 'postgres',
    passwordEncrypted: 'mock-enc-db-pass',
    sshAuthType: 'password',
    portForwarding: [
      { id: 'pf-3', forwardType: 'local', localPort: 5433, remoteHost: 'localhost', remotePort: 5432, enabled: true }
    ],
    tags: ['database', 'cluster', 'critical'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'conn-3',
    name: 'srv-ad-dc01 (Active Directory)',
    groupId: 'group-rdp',
    protocol: 'rdp',
    host: '10.0.0.10',
    port: 3389,
    username: 'Administrator',
    passwordEncrypted: 'mock-enc-ad-pass',
    sshAuthType: 'password',
    portForwarding: [],
    rdpSettings: {
      width: 1920,
      height: 1080,
      colorDepth: 32,
      domain: 'CORP',
      sound: false,
      clipboard: true,
    },
    tags: ['windows', 'domain-controller'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'conn-4',
    name: 'bastion-gateway',
    groupId: 'group-tunnels',
    protocol: 'ssh',
    host: 'vpn.example.com',
    port: 22,
    username: 'jumpuser',
    passwordEncrypted: 'mock-enc-jump-pass',
    sshAuthType: 'certificate',
    portForwarding: [
      { id: 'pf-4', forwardType: 'dynamic', localPort: 9050, enabled: true }
    ],
    tags: ['gateway', 'proxy', 'socks5'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
];

let mockSessions: SessionInfo[] = [];
let mockCredentials: Credential[] = [];

/** mRemoteNG encryption parameters (+ optional custom master password) for the import. */
export interface MrngParams {
  password: string | null;
  encryptionEngine: string;
  blockCipherMode: string;
  kdfIterations: number;
}

export interface DisplaySettingsInfo {
  supported: boolean;
  safeRendering: boolean;
  activeSafeRendering: boolean;
  forcedByEnv: boolean;
  /** saved: RDP through FreeRDP inside the window */
  rdpFreerdpEmbedded: boolean;
  /** this instance can embed FreeRDP (X11 + xfreerdp) */
  rdpEmbedAvailable: boolean;
  x11: boolean;
  xfreerdpInstalled: boolean;
}

export interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewStat {
  size: number;
  /** Modification time, seconds since the epoch. */
  modified: number;
  readonly: boolean;
}

export const api = {
  async getStatus(): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_get_status');
    }
    return {
      isInitialized: mockInitialized,
      isUnlocked: mockUnlocked,
      isPinLocked: mockPinLocked,
      pinEnabled: mockPinEnabled,
      autoLockScreen: true,
      autoLockTimeoutMins: 15,
      failedPinAttempts: 0,
      connectionsCount: mockConnections.length,
      groupsCount: mockGroups.length,
      credentialsCount: mockCredentials.length,
    };
  },

  async getVaultPath(): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('vault_get_path');
    }
    return './vault.json';
  },

  async initVault(masterPassword: string): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_init', { masterPassword });
    }
    mockInitialized = true;
    mockUnlocked = true;
    mockPinLocked = false;
    return this.getStatus();
  },

  async unlockMaster(masterPassword: string, acceptModified: boolean = false): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_unlock_master', { masterPassword, acceptModified });
    }
    if (masterPassword === 'wrong') {
      throw new Error('Nieprawidłowe Master Password');
    }
    mockUnlocked = true;
    mockPinLocked = false;
    return this.getStatus();
  },

  async exitApp(): Promise<void> {
    if (isTauri()) {
      await invoke('app_exit');
    }
  },

  async maximizeWindow(): Promise<void> {
    if (isTauri()) {
      try {
        await invoke('app_maximize_window');
      } catch (e) {
        console.warn('Nie udało się zmaksymalizować okna:', e);
      }
    }
  },

  async changeMasterPassword(currentPassword: string, newPassword: string): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_change_master_password', { currentPassword, newPassword });
    }
    if (newPassword.length < 8) {
      throw new Error('Nowe Master Password musi mieć co najmniej 8 znaków');
    }
    mockPinEnabled = false;
    return this.getStatus();
  },

  async lockVault(): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('vault_lock');
    }
    mockUnlocked = false;
    mockPinLocked = false;
  },

  async resetVault(): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_reset');
    }
    mockInitialized = false;
    mockUnlocked = false;
    mockPinLocked = false;
    mockConnections = [];
    return this.getStatus();
  },

  async lockToPin(): Promise<boolean> {
    if (isTauri()) {
      return await invoke<boolean>('vault_lock_to_pin');
    }
    if (mockPinEnabled) {
      mockUnlocked = false;
      mockPinLocked = true;
      return true;
    }
    mockUnlocked = false;
    return false;
  },

  async unlockPin(pin: string): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_unlock_pin', { pin });
    }
    if (pin === '1234') {
      mockUnlocked = true;
      mockPinLocked = false;
      return this.getStatus();
    }
    throw new Error('Nieprawidłowy PIN! Pozostało prób: 2');
  },

  async setPin(pin: string, enable: boolean): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_set_pin', { pin, enable });
    }
    mockPinEnabled = enable;
    return this.getStatus();
  },

  async updateSecuritySettings(autoLockScreen: boolean, autoLockTimeoutMins: number): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('vault_update_security_settings', { autoLockScreen, autoLockTimeoutMins });
    }
  },

  async getVaultData(): Promise<VaultData> {
    if (isTauri()) {
      return await invoke<VaultData>('vault_get_data');
    }
    return {
      metadata: {
        version: 1,
        salt_base64: 'mock',
        canary_nonce_base64: 'mock',
        canary_ciphertext_base64: 'mock',
        pin_enabled: mockPinEnabled,
        auto_lock_screen: true,
        auto_lock_timeout_mins: 15,
        max_pin_attempts: 3,
      },
      groups: mockGroups,
      connections: mockConnections,
    };
  },

  /** RDP password for the embedded client, read from the vault when (re)connecting. */
  async getRdpSessionPassword(sessionId: string, connectionId: string): Promise<string> {
    await api.ensureConnectionPassword(connectionId, sessionId);
    if (isTauri()) {
      return (await invoke<string | null>('session_rdp_password', { sessionId })) || '';
    }
    return '';
  },

  async revealPassword(connectionId: string): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('vault_reveal_password', { connectionId });
    }
    return 'SuperSecretP@ssw0rd2026!';
  },

  async connectionPasswordStatus(connectionId: string): Promise<ConnectionPasswordStatus> {
    if (isTauri()) return invoke<ConnectionPasswordStatus>('connection_password_status', { connectionId });
    const conn = mockConnections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('Connection not found');
    const credential = mockCredentials.find((c) => c.id === conn.credentialId);
    return { connectionId, name: conn.name, host: conn.host, port: conn.port,
      requiresPassword: conn.protocol === 'rdp' || effectiveSshAuthType(conn, credential) === 'password',
      hasPassword: Boolean(conn.passwordEncrypted ?? credential?.passwordEncrypted) };
  },

  async ensureConnectionPassword(connectionId: string, sessionId: string): Promise<void> {
    const status = await api.connectionPasswordStatus(connectionId);
    if (!status.requiresPassword || status.hasPassword) { emptyPasswordSessions.delete(sessionId); return; }
    if (emptyPasswordSessions.has(sessionId)) return;
    const decision = await requestConnectionPassword(status);
    if (decision === 'cancel') throw new PasswordPromptCancelled();
    if (decision === 'empty') emptyPasswordSessions.add(sessionId);
  },

  async setConnectionPassword(connectionId: string, password: string): Promise<Connection> {
    if (isTauri()) return invoke<Connection>('vault_set_connection_password', { connectionId, password });
    const index = mockConnections.findIndex((c) => c.id === connectionId);
    if (index < 0 || !password.length) throw new Error('A connection and non-empty password are required');
    mockConnections[index] = { ...mockConnections[index], passwordEncrypted: 'mock-saved-password', updatedAt: new Date().toISOString() };
    return mockConnections[index];
  },

  async saveConnection(
    connection: Connection,
    rawPassword?: string,
    rawPrivateKey?: string,
    rawPassphrase?: string
  ): Promise<Connection> {
    if (isTauri()) {
      return await invoke<Connection>('vault_save_connection', {
        connection,
        rawPassword: rawPassword || null,
        rawPrivateKey: rawPrivateKey || null,
        rawPassphrase: rawPassphrase || null,
      });
    }
    const idx = mockConnections.findIndex(c => c.id === connection.id);
    if (idx >= 0) {
      mockConnections[idx] = connection;
    } else {
      mockConnections.push(connection);
    }
    return connection;
  },

  async deleteConnection(connectionId: string): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('vault_delete_connection', { connectionId });
    }
    mockConnections = mockConnections.filter(c => c.id !== connectionId);
  },

  async cloneConnection(connectionId: string): Promise<Connection> {
    if (isTauri()) return invoke<Connection>('vault_clone_connection', { connectionId });
    const index = mockConnections.findIndex((connection) => connection.id === connectionId);
    if (index < 0) throw new Error('Connection not found');
    const source = mockConnections[index];
    const label = t('kopia');
    const names = new Set(mockConnections.map((connection) => connection.name.toLocaleLowerCase()));
    let name = `${source.name} (${label})`;
    let number = 2;
    while (names.has(name.toLocaleLowerCase())) name = `${source.name} (${label} ${number++})`;
    const now = new Date().toISOString();
    const copy = { ...structuredClone(source), id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
    mockConnections = [...mockConnections.slice(0, index + 1), copy, ...mockConnections.slice(index + 1)];
    return copy;
  },

  async saveGroup(group: Group): Promise<Group> {
    if (isTauri()) {
      return await invoke<Group>('vault_save_group', { group });
    }
    const idx = mockGroups.findIndex(g => g.id === group.id);
    if (idx >= 0) {
      mockGroups[idx] = group;
    } else {
      mockGroups.push(group);
    }
    return group;
  },

  async deleteGroup(groupId: string): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('vault_delete_group', { groupId });
    }
    mockGroups = mockGroups.filter(g => g.id !== groupId);
    mockConnections = mockConnections.map(c => c.groupId === groupId ? { ...c, groupId: null } : c);
  },

  async connectSession(
    sessionId: string | null | undefined,
    connectionId: string,
    title: string,
    protocol: 'ssh' | 'rdp',
    host: string,
    port: number,
    username: string,
    portForwardsDesc: string[],
    customPassphrase?: string
  ): Promise<SessionInfo> {
    sessionId = sessionId || crypto.randomUUID();
    await api.ensureConnectionPassword(connectionId, sessionId);
    if (isTauri()) {
      return await invoke<SessionInfo>('session_connect', {
        sessionId: sessionId || null,
        connectionId,
        title,
        protocol,
        host,
        port,
        username,
        portForwardsDesc,
        customPassphrase: customPassphrase || null,
      });
    }
    const sess: SessionInfo = {
      sessionId: sessionId || 'sess-' + Math.random().toString(36).substring(2, 9),
      connectionId,
      title,
      protocol,
      host,
      port,
      username,
      status: 'connected',
      statusMessage: 'Połączono pomyślnie',
      bytesSent: 1024,
      bytesReceived: 4096,
      startedAt: new Date().toISOString(),
      activePortForwards: portForwardsDesc,
    };
    mockSessions.push(sess);
    return sess;
  },

  async sendInput(sessionId: string, data: string): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('session_send_input', { sessionId, data });
    }
  },

  async closeSession(sessionId: string): Promise<void> {
    emptyPasswordSessions.delete(sessionId);
    forgetOscCwd(sessionId);
    if (isTauri()) {
      return await invoke<void>('session_close', { sessionId });
    }
    mockSessions = mockSessions.filter(s => s.sessionId !== sessionId);
  },

  /** Current directory of the shell in an SSH terminal tab (error "NO_PROC": server without /proc). */
  async terminalCwd(sessionId: string): Promise<{ path: string; otherUserShell: boolean }> {
    if (isTauri()) {
      return await invoke('ssh_terminal_cwd', { sessionId });
    }
    return { path: '/var/www/html', otherUserShell: false };
  },

  async launchExternalRdp(session: SessionInfo): Promise<void> {
    await api.ensureConnectionPassword(session.connectionId, session.sessionId);
    if (isTauri()) {
      return await invoke<void>('session_launch_external_rdp', {
        sessionId: session.sessionId,
        connectionId: session.connectionId,
        title: session.title,
        host: session.host,
        port: session.port,
        username: session.username,
      });
    }
  },

  async previewRdpCertificate(connectionId: string): Promise<RdpCertificateInfo> {
    return invoke<RdpCertificateInfo>('rdp_certificate_preview', { connectionId });
  },

  async trustRdpCertificate(info: RdpCertificateInfo): Promise<void> {
    return invoke<void>('rdp_certificate_trust', { ...info });
  },

  async exportVault(exportPassword?: string, allowPlaintext: boolean = false, groupIds: string[] | null = null, includeUngrouped = false): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('vault_export', {
        exportPassword: exportPassword || null,
        allowPlaintext,
        groupIds,
        includeUngrouped,
      });
    }
    if (groupIds !== null && ((!groupIds.length && !includeUngrouped) || groupIds.some((id) => !mockGroups.some((group) => group.id === id)))) {
      throw new Error(t('Wybierz poprawne grupy do eksportu'));
    }
    const selected = selectExportData(mockGroups, mockConnections, groupIds, includeUngrouped);
    const credentialIds = new Set(selected.connections.map((connection) => connection.credentialId));
    // Mock export
    const payload = {
      format: 'remoteflow_export',
      version: 1,
      isEncrypted: !!exportPassword,
      groups: selected.groups,
      connections: selected.connections,
      credentials: groupIds === null ? mockCredentials : mockCredentials.filter((credential) => credentialIds.has(credential.id)),
      exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(payload, null, 2);
  },

  async importVault(payloadJson: string, importPassword?: string, merge: boolean = true): Promise<ImportSummary> {
    if (isTauri()) {
      return await invoke<ImportSummary>('vault_import', {
        payloadJson,
        importPassword: importPassword || null,
        merge,
      });
    }
    // Mock import
    const data = JSON.parse(payloadJson);
    const groups: Group[] = data.groups || [];
    const conns: Connection[] = data.connections || [];
    if (merge) {
      mockGroups = [...mockGroups, ...groups.filter(g => !mockGroups.some(mg => mg.id === g.id))];
      mockConnections = [...mockConnections, ...conns.filter(c => !mockConnections.some(mc => mc.id === c.id))];
    } else {
      mockGroups = groups;
      mockConnections = conns;
    }
    return {
      groupsImported: groups.length,
      connectionsImported: conns.length,
    };
  },

  async batchImport(
    groups: Group[],
    connections: Connection[],
    merge: boolean = true,
    mremoteng: MrngParams | null = null
  ): Promise<ImportSummary> {
    if (isTauri()) {
      return await invoke<ImportSummary>('vault_batch_import', {
        groups,
        connections,
        merge,
        mremoteng,
      });
    }
    if (merge) {
      mockGroups = [...mockGroups, ...groups.filter(g => !mockGroups.some(mg => mg.id === g.id))];
      mockConnections = [...mockConnections, ...connections.filter(c => !mockConnections.some(mc => mc.id === c.id))];
    } else {
      mockGroups = groups;
      mockConnections = connections;
    }
    return {
      groupsImported: groups.length,
      connectionsImported: connections.length,
    };
  },

  async getCredentials(): Promise<Credential[]> {
    if (isTauri()) {
      return await invoke<Credential[]>('vault_get_credentials');
    }
    return mockCredentials;
  },

  async saveCredential(
    credential: Credential,
    rawPassword?: string,
    rawKey?: string,
    rawPassphrase?: string
  ): Promise<Credential> {
    if (isTauri()) {
      return await invoke<Credential>('vault_save_credential', {
        credential,
        rawPassword: rawPassword || null,
        rawPrivateKey: rawKey || null,
        rawPassphrase: rawPassphrase || null,
      });
    }
    const idx = mockCredentials.findIndex(c => c.id === credential.id);
    if (idx >= 0) {
      mockCredentials[idx] = credential;
    } else {
      mockCredentials.push(credential);
    }
    return credential;
  },

  async deleteCredential(credentialId: string): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('vault_delete_credential', { credentialId });
    }
    mockCredentials = mockCredentials.filter(c => c.id !== credentialId);
  },

  async revealCredentialPassword(credentialId: string): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('vault_reveal_credential_password', { credentialId });
    }
    return 'MockSecretPassword!';
  },

  async getUiSettings(): Promise<UiSettings> {
    if (isTauri()) {
      return await invoke<UiSettings>('vault_get_ui_settings');
    }
    return { ...mockUiSettings };
  },

  async setUiSettings(settings: UiSettings): Promise<void> {
    if (isTauri()) {
      await invoke<void>('vault_set_ui_settings', { settings });
    } else {
      mockUiSettings = { ...settings };
    }
  },

  async getBackupSettings(): Promise<BackupSettings> {
    if (isTauri()) {
      return await invoke<BackupSettings>('vault_get_backup_settings');
    }
    return { enabled: true, intervalHours: 24, keep: 10, dir: null };
  },

  async setBackupSettings(settings: BackupSettings): Promise<void> {
    if (isTauri()) {
      await invoke<void>('vault_set_backup_settings', { settings: { ...settings, dir: settings.dir || null } });
    }
  },

  async backupNow(): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('vault_backup_now');
    }
    return './backups/vault-mock.json';
  },

  async listBackups(): Promise<BackupEntry[]> {
    if (isTauri()) {
      return await invoke<BackupEntry[]>('vault_list_backups');
    }
    return [];
  },

  async restoreBackup(name: string): Promise<VaultStatus> {
    if (isTauri()) {
      return await invoke<VaultStatus>('vault_restore_backup', { name });
    }
    return this.getStatus();
  },

  /** Windows clipboard sequence number (changes on every copy); null on other systems. */
  async clipboardSequence(): Promise<number | null> {
    if (!isTauri()) return null;
    try {
      return await invoke<number | null>('clipboard_sequence');
    } catch {
      return null;
    }
  },

  // --- RDP remote -> local file clipboard (Windows) ---------------------------------------------
  async rdpClipStageBegin(): Promise<string> {
    return await invoke<string>('rdp_clip_stage_begin');
  },

  async rdpClipStageDir(stageDir: string, relPath: string): Promise<void> {
    await invoke<void>('rdp_clip_stage_dir', { stageDir, relPath });
  },

  /** Sends raw file bytes (no base64) to the staging directory. */
  async rdpClipStageFile(stageDir: string, relPath: string, data: Uint8Array): Promise<void> {
    await invoke<void>('rdp_clip_stage_file', data, {
      headers: {
        'x-stage-dir': encodeURIComponent(stageDir),
        'x-rel-path': encodeURIComponent(relPath),
      },
    });
  },

  /** Places the staged top-level entries on the local Windows clipboard (CF_HDROP). */
  async rdpClipStageCommit(stageDir: string, topLevel: string[]): Promise<string[]> {
    return await invoke<string[]>('rdp_clip_stage_commit', { stageDir, topLevel });
  },

  /**
   * Verifies the mRemoteNG master password (Protected marker). For files saved with
   * "full file encryption" returns the decrypted inner XML.
   */
  async mremotengUnlock(params: MrngParams, protectedMarker: string | null, fullFileData: string | null): Promise<string | null> {
    if (!isTauri()) return null;
    return await invoke<string | null>('mremoteng_unlock', {
      params,
      protected: protectedMarker,
      fullFileData,
    });
  },

  /** Reports user activity to the backend inactivity auto-lock. */
  async touchActivity(): Promise<void> {
    if (isTauri()) {
      await invoke<void>('vault_touch_activity');
    }
  },

  async listKnownHosts(): Promise<KnownHostEntry[]> {
    if (isTauri()) {
      return await invoke<KnownHostEntry[]>('vault_list_known_hosts');
    }
    return [];
  },

  async forgetKnownHost(id: string): Promise<void> {
    if (isTauri()) {
      await invoke<void>('vault_forget_known_host', { id });
    }
  },

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    if (isTauri()) {
      return await invoke<void>('session_resize', { sessionId, cols, rows });
    }
  },

  // --- Two-pane SFTP manager -------------------------------------------------------------------
  async sftpMkdir(connectionId: string, parent: string, name: string): Promise<string> {
    return await invoke<string>('sftp_mkdir', { connectionId, parent, name });
  },

  async sftpDeletePaths(connectionId: string, remotePaths: string[]): Promise<number> {
    return await invoke<number>('sftp_delete_paths', { connectionId, remotePaths });
  },

  async sftpSearch(connectionId: string, remoteDir: string, query: string): Promise<SftpFileEntry[]> {
    return await invoke<SftpFileEntry[]>('sftp_search', { connectionId, remoteDir, query });
  },

  async sftpTransferUpload(connectionId: string, localPaths: string[], remoteDir: string, transferId: string): Promise<TransferSummary> {
    return await invoke<TransferSummary>('sftp_transfer_upload', { connectionId, localPaths, remoteDir, transferId });
  },

  async sftpTransferDownload(connectionId: string, remotePaths: string[], localDir: string, transferId: string): Promise<TransferSummary> {
    return await invoke<TransferSummary>('sftp_transfer_download', { connectionId, remotePaths, localDir, transferId });
  },

  /** Stops a running upload/download; false when it has already finished. */
  async sftpTransferCancel(transferId: string): Promise<boolean> {
    if (!isTauri()) return false;
    return await invoke<boolean>('sftp_transfer_cancel', { transferId });
  },

  async sftpRelease(connectionId: string): Promise<void> {
    if (isTauri()) await invoke<void>('sftp_release', { connectionId });
  },

  /** New empty file on the server; returns its path. */
  async sftpMkfile(connectionId: string, parent: string, name: string): Promise<string> {
    return await invoke<string>('sftp_mkfile', { connectionId, parent, name });
  },

  /** New empty local file; returns its path. */
  async localMkfile(parent: string, name: string): Promise<string> {
    return await invoke<string>('local_mkfile', { parent, name });
  },

  async localMkdir(parent: string, name: string): Promise<string> {
    return await invoke<string>('local_mkdir', { parent, name });
  },

  // --- File preview / editor of the SFTP window (side: 'local' | 'remote') --------------------
  async previewStat(side: 'local' | 'remote', connectionId: string, path: string): Promise<PreviewStat> {
    return await invoke<PreviewStat>('preview_stat', { side, connectionId, path });
  },

  /** A chunk of the file (at most 4 MB). */
  async previewRead(side: 'local' | 'remote', connectionId: string, path: string, offset: number, length: number): Promise<Uint8Array> {
    const buf = await invoke<ArrayBuffer>('preview_read', { side, connectionId, path, offset, length });
    return new Uint8Array(buf);
  },

  /**
   * Saves the file. `expected` = stat from opening: when the file changed since, the error starts
   * with "CONFLICT:" (pass null to overwrite anyway). The content goes as the raw request body.
   */
  async previewSave(side: 'local' | 'remote', connectionId: string, path: string, data: Uint8Array, expected: PreviewStat | null): Promise<PreviewStat> {
    const args = { side, connectionId, path, expectedSize: expected?.size ?? null, expectedModified: expected?.modified ?? null };
    return await invoke<PreviewStat>('preview_save', data, { headers: { 'x-rf-args': encodeURIComponent(JSON.stringify(args)) } });
  },

  /** Deletes local files/folders: to the trash, or permanently. Error "TRASH_UNAVAILABLE:…" = no trash there. */
  async localDeletePaths(paths: string[], permanent: boolean): Promise<number> {
    return await invoke<number>('local_delete_paths', { paths, permanent });
  },

  async localSearch(localDir: string, query: string): Promise<SftpFileEntry[]> {
    return await invoke<SftpFileEntry[]>('local_search', { localDir, query });
  },

  async sftpList(connectionId: string, remotePath: string = ''): Promise<SftpListResponse> {
    if (isTauri()) {
      return await invoke<SftpListResponse>('sftp_list', { connectionId, remotePath });
    }
    return {
      currentPath: remotePath || '/home/user',
      entries: [
        { name: 'app', path: '/home/user/app', isDir: true, size: 4096, modified: Math.floor((Date.now() - 3600000) / 1000), permissions: 16877 },
        { name: 'backup', path: '/home/user/backup', isDir: true, size: 4096, modified: Math.floor((Date.now() - 7200000) / 1000), permissions: 16877 },
        { name: 'current', path: '/home/user/current', isDir: true, size: 0, modified: Math.floor((Date.now() - 7200000) / 1000), permissions: 16877, isLink: true },
        { name: 'config.json', path: '/home/user/config.json', isDir: false, size: 1420, modified: Math.floor((Date.now() - 600000) / 1000), permissions: 33188 },
        { name: 'server.log', path: '/home/user/server.log', isDir: false, size: 52428, modified: Math.floor((Date.now() - 120000) / 1000), permissions: 33188 },
      ],
    };
  },

  async sftpUploadFile(connectionId: string, remoteDir: string, filename: string, contentBase64: string): Promise<number> {
    if (isTauri()) {
      return await invoke<number>('sftp_upload_file', { connectionId, remoteDir, filename, contentBase64 });
    }
    return 1024;
  },

  async sftpUploadPaths(connectionId: string, remoteDir: string, localPaths: string[]): Promise<number> {
    if (isTauri()) {
      return await invoke<number>('sftp_upload_paths', { connectionId, remoteDir, localPaths });
    }
    return localPaths.length;
  },

  async openSharedFolder(targetDir?: string): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('open_shared_folder', { targetDir: targetDir || null });
    }
    return targetDir || '~/Downloads';
  },

  async saveDroppedFileToShared(
    filename: string,
    contentBase64: string,
    targetDir?: string
  ): Promise<string> {
    if (isTauri()) {
      return await invoke<string>('save_dropped_file_to_shared', {
        filename,
        contentBase64,
        targetDir: targetDir || null,
      });
    }
    return `${targetDir || '~/Downloads'}/${filename}`;
  },

  async clipboardReadText(): Promise<string> {
    if (isTauri()) {
      try {
        const text = await invoke<string>('clipboard_read_text');
        if (text) return text;
      } catch {
        // Fallback to browser clipboard
      }
    }
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  },

  async clipboardWriteText(text: string): Promise<void> {
    if (isTauri()) {
      try {
        await invoke<void>('clipboard_write_text', { text });
      } catch (e) {
        console.warn('clipboard_write_text error:', e);
      }
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore browser permission error if native GTK clipboard succeeded
    }
  },

  async clipboardReadFiles(): Promise<string[]> {
    if (isTauri()) {
      try {
        return await invoke<string[]>('clipboard_read_files');
      } catch {
        return [];
      }
    }
    return [];
  },

  async localListDir(localPath: string = ''): Promise<SftpListResponse> {
    if (isTauri()) {
      return await invoke<SftpListResponse>('local_list_dir', { localPath });
    }
    return {
      currentPath: localPath || '/home/user',
      entries: [
        { name: 'Desktop', path: '/home/user/Desktop', isDir: true, size: 4096, modified: Date.now() / 1000, permissions: 0o755 },
        { name: 'Downloads', path: '/home/user/Downloads', isDir: true, size: 4096, modified: Date.now() / 1000, permissions: 0o755 },
        { name: 'Documents', path: '/home/user/Documents', isDir: true, size: 4096, modified: Date.now() / 1000, permissions: 0o755 },
      ],
    };
  },

  async pickLocalFolder(): Promise<string | null> {
    if (isTauri()) {
      return await invoke<string | null>('pick_local_folder');
    }
    return null;
  },

  /** Native file dialog; the backend reads ONLY the file chosen there (and only if it is a private key). */
  async pickPrivateKeyFile(title?: string): Promise<{ path: string; content: string } | null> {
    if (isTauri()) {
      return await invoke<{ path: string; content: string } | null>('pick_private_key_file', { title: title || null });
    }
    return null;
  },

  /** Native file dialog for an SSH certificate (…-cert.pub); the backend checks the file. */
  async pickSshCertificateFile(title?: string): Promise<{ path: string; content: string } | null> {
    if (isTauri()) {
      return await invoke<{ path: string; content: string } | null>('pick_ssh_certificate_file', { title: title || null });
    }
    return null;
  },

  async readLocalPathsForRdpClipboard(localPaths: string[]): Promise<import('../types').RdpClipboardFileEntry[]> {
    if (isTauri()) {
      return await invoke<import('../types').RdpClipboardFileEntry[]>('read_local_paths_for_rdp_clipboard', { localPaths });
    }
    return [];
  },

  /** Display settings applied at start-up (Linux: GPU / compatible rendering). */
  async getDisplaySettings(): Promise<DisplaySettingsInfo> {
    if (isTauri()) {
      return await invoke('display_get_settings');
    }
    return {
      supported: false,
      safeRendering: false,
      activeSafeRendering: false,
      forcedByEnv: false,
      rdpFreerdpEmbedded: false,
      rdpEmbedAvailable: false,
      x11: false,
      xfreerdpInstalled: false,
    };
  },

  /** Linux: RDP sessions drawn by FreeRDP inside the RemoteFlow window (from the next start). */
  async setRdpFreerdpEmbedded(enabled: boolean): Promise<void> {
    if (isTauri()) {
      await invoke<void>('display_set_rdp_freerdp_embedded', { enabled });
    }
  },

  /** Starts FreeRDP inside the window over the given area (CSS px, relative to the web view). */
  async rdpEmbedStart(session: SessionInfo, rect: EmbedRect): Promise<void> {
    await api.ensureConnectionPassword(session.connectionId, session.sessionId);
    if (isTauri()) {
      await invoke<void>('rdp_embed_start', {
        sessionId: session.sessionId,
        connectionId: session.connectionId,
        title: session.title,
        rect,
      });
    }
  },

  async rdpEmbedUpdate(sessionId: string, rect: EmbedRect, visible: boolean): Promise<void> {
    if (isTauri()) {
      await invoke<void>('rdp_embed_update', { sessionId, rect, visible });
    }
  },

  /** Keyboard back to the RemoteFlow window (a click on the web content). */
  async rdpEmbedReleaseFocus(): Promise<void> {
    if (isTauri()) {
      await invoke<void>('rdp_embed_release_focus');
    }
  },

  async rdpEmbedStop(sessionId: string): Promise<void> {
    if (isTauri()) {
      await invoke<void>('rdp_embed_stop', { sessionId });
    }
  },

  async setSafeRendering(enabled: boolean): Promise<void> {
    if (isTauri()) {
      await invoke<void>('display_set_safe_rendering', { enabled });
    }
  },

  /** Saves (or clears with null) the SFTP start folders of a connection. */
  async setConnectionSftpDirs(connectionId: string, localDir: string | null, remoteDir: string | null): Promise<void> {
    if (isTauri()) {
      await invoke<void>('vault_set_connection_sftp_dirs', {
        connectionId,
        localDir: localDir || null,
        remoteDir: remoteDir || null,
      });
    }
  }
};

