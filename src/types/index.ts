export type ProtocolType = 'ssh' | 'rdp';
export type SshAuthType = 'password' | 'key' | 'certificate' | 'agent';
export type ForwardType = 'local' | 'remote' | 'dynamic';

export interface PortForwardRule {
  id: string;
  forwardType: ForwardType;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  enabled: boolean;
}

export interface RdpSettings {
  width: number;
  height: number;
  colorDepth: number;
  domain?: string;
  sound: boolean;
  clipboard: boolean;
}

export interface Credential {
  id: string;
  name: string;
  username: string;
  passwordEncrypted?: string;
  authType: SshAuthType;
  privateKeyEncrypted?: string;
  privateKeyPassphraseEncrypted?: string;
  certificateContent?: string;
  keyFilePath?: string | null;
  /** SSH certificate file, read at every connection (takes precedence over certificateContent). */
  certificateFilePath?: string | null;
  promptKeyPassphrase?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Connection {
  id: string;
  name: string;
  groupId: string | null;
  credentialId?: string | null;
  protocol: ProtocolType;
  host: string;
  port: number;
  username: string;
  passwordEncrypted?: string;
  sshAuthType: SshAuthType;
  privateKeyEncrypted?: string;
  privateKeyPassphraseEncrypted?: string;
  certificateContent?: string;
  keyFilePath?: string | null;
  /** SSH certificate file, read at every connection (takes precedence over certificateContent). */
  certificateFilePath?: string | null;
  promptKeyPassphrase?: boolean;
  /** SSH: saved SSH connection used as a jump host (ProxyJump). */
  jumpHostId?: string | null;
  portForwarding: PortForwardRule[];
  rdpSettings?: RdpSettings;
  tags: string[];
  notes?: string;
  /** RDP: local folder for exchanged files (empty = Downloads). Legacy SFTP start folder for SSH. */
  defaultDownloadDir?: string | null;
  /** SFTP start folder on this computer (empty = home folder). */
  sftpLocalDir?: string | null;
  /** SFTP start folder on the server (empty = home of the connection's user). */
  sftpRemoteDir?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  icon?: string;
  color?: string;
}

export interface VaultMetadata {
  version: number;
  salt_base64: string;
  canary_nonce_base64: string;
  canary_ciphertext_base64: string;
  pin_enabled: boolean;
  auto_lock_screen: boolean;
  auto_lock_timeout_mins: number;
  max_pin_attempts: number;
}

export interface VaultData {
  metadata: VaultMetadata;
  groups: Group[];
  connections: Connection[];
  credentials?: Credential[];
}

export interface VaultStatus {
  isInitialized: boolean;
  isUnlocked: boolean;
  isPinLocked: boolean;
  pinEnabled: boolean;
  autoLockScreen: boolean;
  autoLockTimeoutMins: number;
  failedPinAttempts: number;
  connectionsCount: number;
  groupsCount: number;
  credentialsCount: number;
  securityWarning?: string | null;
}

export interface SessionInfo {
  sessionId: string;
  connectionId: string;
  title: string;
  protocol: ProtocolType;
  host: string;
  port: number;
  username: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  statusMessage?: string;
  bytesSent: number;
  bytesReceived: number;
  startedAt: string;
  activePortForwards: string[];
  rdpProxyPort?: number | null;
  rdpProxyToken?: string | null;
  rdpDomain?: string | null;
  rdpSettings?: RdpSettings | null;
}

export type WorkspaceLayout = 'single' | 'split-horizontal' | 'split-vertical' | 'grid-4' | 'columns-3';

export interface ImportSummary {
  groupsImported: number;
  connectionsImported: number;
  credentialsImported?: number;
  passwordsFailed?: number;
}

export interface BackupSettings {
  enabled: boolean;
  intervalHours: number;
  keep: number;
  dir?: string | null;
}

/** Interface confirmations stored in the vault. */
export interface UiSettings {
  confirmCloseSessions: boolean;
  confirmAppExit: boolean;
  /** Lines of SSH terminal history (scrollback); default 10 000. */
  terminalScrollback?: number;
  /** Open the tabs from the last run after unlocking (off by default). */
  restoreSessions?: boolean;
}

/** A connection found in OpenSSH / PuTTY / WinSCP (Import window). */
export interface ImportCandidate {
  key: string;
  name: string;
  folder: string[];
  protocol: ProtocolType;
  host: string;
  port: number;
  username: string;
  keyFile?: string | null;
  jump?: string | null;
  forwards: PortForwardRule[];
  hasPassword: boolean;
  notes: string[];
  exists: boolean;
  implicit: boolean;
}

export interface ImportScan {
  scanId: string;
  location: string;
  candidates: ImportCandidate[];
  warnings: string[];
}

/** Tabs kept for "Restore previous sessions". */
export interface SavedWorkspace {
  /** Connection ids in tab order. */
  tabs: string[];
  layout: WorkspaceLayout;
  /** Tab shown in each pane (index into `tabs`, -1 = empty). */
  panes: number[];
  active?: number | null;
}

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

export interface KnownHostEntry {
  /** "ssh:host:port" or "rdp:host:port" */
  id: string;
  fingerprint: string;
}

export interface SftpFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  permissions: number;
  /** Symbolic link (type / size are those of its target). */
  isLink?: boolean;
}

export interface SftpListResponse {
  currentPath: string;
  entries: SftpFileEntry[];
  /** Parent directory (local listings only); undefined at the file-system root. */
  parentPath?: string | null;
}

export interface TransferSummary {
  files: number;
  folders: number;
  bytes: number;
  failed: number;
  errors: string[];
  /** Links to folders inside transferred folders that were not followed. */
  skippedLinks?: number;
  /** Stopped by the user ("Przerwij"); the counters cover what finished before. */
  cancelled?: boolean;
}

export interface TransferProgress {
  transferId: string;
  files: number;
  current: string;
  /** Bytes transferred so far (all files). */
  bytes?: number;
}

export interface RdpClipboardFileEntry {
  name: string;
  path?: string;
  isDirectory: boolean;
  size: number;
  lastModified: number;
  /** File on this computer (content read with api.readLocalFileBytes). */
  localPath?: string | null;
}

export interface RdpClipboardRead {
  entries: RdpClipboardFileEntry[];
  /** Files too large for the remote clipboard (left out). */
  skippedLarge: number;
  /** Too many files – the rest was left out. */
  truncated: boolean;
}

