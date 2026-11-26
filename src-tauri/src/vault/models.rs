use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwardRule {
    pub id: String,
    #[serde(rename = "forwardType")]
    pub forward_type: String, // "local", "remote", "dynamic"
    #[serde(rename = "localPort")]
    pub local_port: u16,
    #[serde(rename = "remoteHost")]
    pub remote_host: Option<String>,
    #[serde(rename = "remotePort")]
    pub remote_port: Option<u16>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RdpSettings {
    pub width: u32,
    pub height: u32,
    #[serde(rename = "colorDepth")]
    pub color_depth: u32,
    pub domain: Option<String>,
    pub sound: bool,
    pub clipboard: bool,
}

impl Default for RdpSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            color_depth: 32,
            domain: None,
            sound: false,
            clipboard: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(rename = "passwordEncrypted")]
    pub password_encrypted: Option<String>,
    #[serde(rename = "authType")]
    pub auth_type: String, // "password", "key", "certificate"
    #[serde(rename = "privateKeyEncrypted")]
    pub private_key_encrypted: Option<String>,
    #[serde(rename = "privateKeyPassphraseEncrypted")]
    pub private_key_passphrase_encrypted: Option<String>,
    #[serde(rename = "certificateContent")]
    pub certificate_content: Option<String>,
    #[serde(rename = "keyFilePath", default, skip_serializing_if = "Option::is_none")]
    pub key_file_path: Option<String>,
    /// SSH certificate file (…-cert.pub), read at every connection; takes precedence over
    /// `certificate_content`, which keeps the content loaded when the file was chosen.
    #[serde(rename = "certificateFilePath", default, skip_serializing_if = "Option::is_none")]
    pub certificate_file_path: Option<String>,
    #[serde(rename = "promptKeyPassphrase", default, skip_serializing_if = "Option::is_none")]
    pub prompt_key_passphrase: Option<bool>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(rename = "groupId")]
    pub group_id: Option<String>,
    #[serde(rename = "credentialId")]
    pub credential_id: Option<String>,
    pub protocol: String, // "ssh" or "rdp"
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "passwordEncrypted")]
    pub password_encrypted: Option<String>, // Base64 packed: nonce + ciphertext
    #[serde(rename = "sshAuthType")]
    pub ssh_auth_type: String, // "password", "key", "certificate", "agent"
    #[serde(rename = "privateKeyEncrypted")]
    pub private_key_encrypted: Option<String>,
    #[serde(rename = "privateKeyPassphraseEncrypted")]
    pub private_key_passphrase_encrypted: Option<String>,
    #[serde(rename = "certificateContent")]
    pub certificate_content: Option<String>,
    #[serde(rename = "keyFilePath", default, skip_serializing_if = "Option::is_none")]
    pub key_file_path: Option<String>,
    /// SSH certificate file (…-cert.pub), read at every connection; takes precedence over
    /// `certificate_content`, which keeps the content loaded when the file was chosen.
    #[serde(rename = "certificateFilePath", default, skip_serializing_if = "Option::is_none")]
    pub certificate_file_path: Option<String>,
    #[serde(rename = "promptKeyPassphrase", default, skip_serializing_if = "Option::is_none")]
    pub prompt_key_passphrase: Option<bool>,
    #[serde(rename = "portForwarding")]
    pub port_forwarding: Vec<PortForwardRule>,
    #[serde(rename = "rdpSettings")]
    pub rdp_settings: Option<RdpSettings>,
    pub tags: Vec<String>,
    pub notes: Option<String>,
    /// RDP: local folder for files exchanged with the remote session (empty = system Downloads).
    /// Older versions also used it as the SFTP start folder – still read as a fallback for that.
    #[serde(rename = "defaultDownloadDir", default, skip_serializing_if = "Option::is_none")]
    pub default_download_dir: Option<String>,
    /// SFTP: local folder opened in the left pane (empty = user's home folder).
    #[serde(rename = "sftpLocalDir", default, skip_serializing_if = "Option::is_none")]
    pub sftp_local_dir: Option<String>,
    /// SFTP: server folder opened in the right pane (empty = home of the connection's user).
    #[serde(rename = "sftpRemoteDir", default, skip_serializing_if = "Option::is_none")]
    pub sftp_remote_dir: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultMetadata {
    pub version: u32,
    pub salt_base64: String,
    pub canary_nonce_base64: String,
    pub canary_ciphertext_base64: String,
    // PIN lock optional configuration
    pub pin_enabled: bool,
    /// The PIN itself, encrypted with the master key. It can only be recovered after a
    /// successful Master Password unlock, so vault.json alone never allows a PIN brute-force.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_encrypted_base64: Option<String>,
    /// Legacy (format v1) fields: master key wrapped by the PIN and stored on disk.
    /// Removed during migration to v2 – kept only so old files can be parsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_salt_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_wrapped_master_key_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_nonce_base64: Option<String>,
    pub auto_lock_screen: bool,
    pub auto_lock_timeout_mins: u32, // 0 = disabled
    pub max_pin_attempts: u32,
    /// Legacy (up to 1.1.3): global SFTP download folder. No longer used, but kept so that the
    /// integrity MAC (computed over the re-serialised vault) of existing files still matches.
    #[serde(rename = "globalDownloadDir", default, skip_serializing_if = "Option::is_none")]
    pub global_download_dir: Option<String>,
    /// Trusted server identities (TOFU): "ssh:host:port" / "rdp:host:port" -> "SHA256:..." fingerprint.
    #[serde(rename = "knownHosts", default, skip_serializing_if = "BTreeMap::is_empty")]
    pub known_hosts: BTreeMap<String, String>,
    /// Periodic backup configuration.
    /// NOTE: every field added to the vault MUST be skipped when it has its default value,
    /// otherwise the integrity MAC of vaults written by older versions would no longer match.
    #[serde(default, skip_serializing_if = "BackupSettings::is_default")]
    pub backup: BackupSettings,
    /// Interface confirmations (closing sessions, exiting the application).
    #[serde(default, skip_serializing_if = "UiSettings::is_default")]
    pub ui: UiSettings,
    /// Open tabs and the layout, kept for "Restore previous sessions" (only while it is on).
    #[serde(rename = "savedWorkspace", default, skip_serializing_if = "Option::is_none")]
    pub saved_workspace: Option<SavedWorkspace>,
}

/// Tabs open when the application was closed (only connections saved in the vault).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedWorkspace {
    /// Connection ids in tab order.
    pub tabs: Vec<String>,
    /// "single" | "split-horizontal" | "split-vertical" | "grid-4" | "columns-3"
    pub layout: String,
    /// Tab shown in each pane (index into `tabs`, -1 = empty pane).
    #[serde(default)]
    pub panes: Vec<i32>,
    /// Index of the active tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<u32>,
}

pub const MAX_SAVED_TABS: usize = 200;

impl SavedWorkspace {
    /// Drops what cannot be valid (too many tabs, indexes outside the list, unknown layouts).
    pub fn sanitized(mut self) -> Self {
        self.tabs.truncate(MAX_SAVED_TABS);
        self.tabs.retain(|id| !id.is_empty() && id.len() <= 200);
        const LAYOUTS: [&str; 5] = ["single", "split-horizontal", "split-vertical", "grid-4", "columns-3"];
        if !LAYOUTS.contains(&self.layout.as_str()) {
            self.layout = "single".into();
        }
        let n = self.tabs.len() as i32;
        self.panes.truncate(4);
        for p in self.panes.iter_mut() {
            if *p < 0 || *p >= n {
                *p = -1;
            }
        }
        if self.active.is_some_and(|a| a as i32 >= n) {
            self.active = None;
        }
        self
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiSettings {
    /// Ask before closing connection tabs.
    #[serde(rename = "confirmCloseSessions", default = "default_true")]
    pub confirm_close_sessions: bool,
    /// Ask before exiting the application.
    #[serde(rename = "confirmAppExit", default = "default_true")]
    pub confirm_app_exit: bool,
    /// Lines kept in the SSH terminal history (scrollback). Not serialized when default, so
    /// existing vaults keep the same serialized form.
    #[serde(rename = "terminalScrollback", default = "default_scrollback", skip_serializing_if = "is_default_scrollback")]
    pub terminal_scrollback: u32,
    /// Open the tabs from the last run after unlocking (off by default).
    #[serde(rename = "restoreSessions", default, skip_serializing_if = "std::ops::Not::not")]
    pub restore_sessions: bool,
}

pub const DEFAULT_TERMINAL_SCROLLBACK: u32 = 10_000;
pub const MIN_TERMINAL_SCROLLBACK: u32 = 100;
pub const MAX_TERMINAL_SCROLLBACK: u32 = 200_000;

fn default_scrollback() -> u32 {
    DEFAULT_TERMINAL_SCROLLBACK
}

fn is_default_scrollback(v: &u32) -> bool {
    *v == DEFAULT_TERMINAL_SCROLLBACK
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            confirm_close_sessions: true,
            confirm_app_exit: true,
            terminal_scrollback: DEFAULT_TERMINAL_SCROLLBACK,
            restore_sessions: false,
        }
    }
}

impl UiSettings {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupSettings {
    pub enabled: bool,
    #[serde(rename = "intervalHours")]
    pub interval_hours: u32,
    /// How many backup files to keep (older ones are deleted).
    pub keep: u32,
    /// Custom backup directory; `None` = "backups" folder next to vault.json.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            keep: 10,
            dir: None,
        }
    }
}

impl BackupSettings {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    /// RFC 3339 modification time
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultData {
    pub metadata: VaultMetadata,
    pub groups: Vec<Group>,
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub credentials: Vec<Credential>,
    /// HMAC-SHA256 (key derived from the master key) over the whole vault with this field empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    /// Format v3 disk envelope. Never present in the decrypted in-memory vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted_data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultStatus {
    #[serde(rename = "isInitialized")]
    pub is_initialized: bool,
    #[serde(rename = "isUnlocked")]
    pub is_unlocked: bool,
    #[serde(rename = "isPinLocked")]
    pub is_pin_locked: bool,
    #[serde(rename = "pinEnabled")]
    pub pin_enabled: bool,
    #[serde(rename = "autoLockScreen")]
    pub auto_lock_screen: bool,
    #[serde(rename = "autoLockTimeoutMins")]
    pub auto_lock_timeout_mins: u32,
    #[serde(rename = "failedPinAttempts")]
    pub failed_pin_attempts: u32,
    #[serde(rename = "connectionsCount")]
    pub connections_count: usize,
    #[serde(rename = "groupsCount")]
    pub groups_count: usize,
    #[serde(rename = "credentialsCount")]
    pub credentials_count: usize,
    /// One-off security notice for the UI (migration, integrity problems, ...).
    #[serde(rename = "securityWarning", default, skip_serializing_if = "Option::is_none")]
    pub security_warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPayload {
    pub format: String, // "remoteflow_export"
    pub version: u32,
    #[serde(rename = "isEncrypted")]
    pub is_encrypted: bool,
    #[serde(rename = "saltBase64")]
    pub salt_base64: Option<String>,
    #[serde(rename = "nonceBase64")]
    pub nonce_base64: Option<String>,
    #[serde(rename = "ciphertextBase64")]
    pub ciphertext_base64: Option<String>,
    pub groups: Option<Vec<Group>>,
    pub connections: Option<Vec<Connection>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credentials: Option<Vec<Credential>>,
    #[serde(rename = "exportedAt")]
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecryptedExportData {
    pub groups: Vec<Group>,
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub credentials: Vec<Credential>,
    #[serde(rename = "exportedAt")]
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSummary {
    #[serde(rename = "groupsImported")]
    pub groups_imported: usize,
    #[serde(rename = "connectionsImported")]
    pub connections_imported: usize,
    #[serde(rename = "credentialsImported", default)]
    pub credentials_imported: usize,
    /// mRemoteNG import: passwords that could not be decrypted (imported without password).
    #[serde(rename = "passwordsFailed", default)]
    pub passwords_failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub id: String,
    pub fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_settings_default_is_not_serialized_and_old_files_parse() {
        // Older vaults have no "ui" key: they must parse to the defaults and serialize back
        // without the key, so their integrity MAC still matches.
        let ui: UiSettings = serde_json::from_str("{}").unwrap();
        assert!(ui.is_default());
        assert!(ui.confirm_close_sessions && ui.confirm_app_exit);
        let partial: UiSettings = serde_json::from_str(r#"{"confirmAppExit":false}"#).unwrap();
        assert!(partial.confirm_close_sessions && !partial.confirm_app_exit);
        assert!(!partial.is_default());
        // The default scrollback is not written – a non-default "ui" saved by an older version
        // serializes exactly as before
        assert_eq!(serde_json::to_string(&partial).unwrap(), r#"{"confirmCloseSessions":true,"confirmAppExit":false}"#);
        assert_eq!(partial.terminal_scrollback, DEFAULT_TERMINAL_SCROLLBACK);
        let custom: UiSettings = serde_json::from_str(r#"{"terminalScrollback":50000}"#).unwrap();
        assert_eq!(custom.terminal_scrollback, 50_000);
        assert!(serde_json::to_string(&custom).unwrap().contains("\"terminalScrollback\":50000"));
    }
}

/// Folder tree checks. A folder whose parent chain leads back to itself (A → B → A) is never
/// shown: none of its folders is a root and its connections are not "without a folder" either.
pub mod group_tree {
    use super::Group;
    use std::collections::{HashMap, HashSet};

    /// `true` when giving folder `id` the parent `parent` would make a cycle (also `parent == id`).
    pub fn parent_creates_cycle(groups: &[Group], id: &str, parent: Option<&str>) -> bool {
        let parents: HashMap<&str, Option<&str>> =
            groups.iter().map(|g| (g.id.as_str(), g.parent_id.as_deref())).collect();
        let mut seen = HashSet::new();
        let mut current = parent;
        while let Some(p) = current {
            if p == id {
                return true;
            }
            if !seen.insert(p) {
                return false; // an older cycle above – not created by this change
            }
            current = parents.get(p).copied().flatten();
        }
        false
    }

    /// Breaks every cycle by moving one folder of it to the top level. Returns whether anything changed.
    pub fn break_cycles(groups: &mut [Group]) -> bool {
        let mut changed = false;
        for i in 0..groups.len() {
            let parents: HashMap<String, Option<String>> =
                groups.iter().map(|g| (g.id.clone(), g.parent_id.clone())).collect();
            let id = groups[i].id.clone();
            let mut seen = HashSet::new();
            let mut current = groups[i].parent_id.clone();
            while let Some(p) = current {
                if p == id {
                    groups[i].parent_id = None;
                    changed = true;
                    break;
                }
                if !seen.insert(p.clone()) {
                    break; // this folder only hangs below a cycle; the cycle's own folders fix it
                }
                current = parents.get(&p).cloned().flatten();
            }
        }
        changed
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn g(id: &str, parent: Option<&str>) -> Group {
            Group { id: id.into(), name: id.into(), parent_id: parent.map(Into::into), icon: None, color: None }
        }

        #[test]
        fn detects_and_breaks_cycles() {
            let groups = vec![g("a", None), g("b", Some("a")), g("c", Some("b"))];
            assert!(parent_creates_cycle(&groups, "a", Some("c")));
            assert!(parent_creates_cycle(&groups, "a", Some("a")));
            assert!(!parent_creates_cycle(&groups, "c", Some("a")));
            assert!(!parent_creates_cycle(&groups, "a", None));

            let mut cyclic = vec![g("a", Some("b")), g("b", Some("a")), g("c", Some("b")), g("d", Some("d"))];
            assert!(break_cycles(&mut cyclic));
            assert_eq!(cyclic[0].parent_id, None); // a moved to the top
            assert_eq!(cyclic[1].parent_id.as_deref(), Some("a"));
            assert_eq!(cyclic[2].parent_id.as_deref(), Some("b"));
            assert_eq!(cyclic[3].parent_id, None);
            assert!(!break_cycles(&mut cyclic));
        }
    }
}

#[cfg(test)]
mod saved_workspace_tests {
    use super::*;

    #[test]
    fn sanitized_drops_invalid_parts() {
        let ws = SavedWorkspace {
            tabs: vec!["a".into(), "".into(), "b".into()],
            layout: "weird".into(),
            panes: vec![1, 5, -3, 0, 0, 1],
            active: Some(7),
        }
        .sanitized();
        assert_eq!(ws.tabs, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(ws.layout, "single");
        assert_eq!(ws.panes, vec![1, -1, -1, 0]);
        assert_eq!(ws.active, None);
    }

    #[test]
    fn defaults_are_not_serialized() {
        // Vaults written by older versions must keep the same serialized form (integrity MAC)
        let ui = serde_json::to_string(&UiSettings::default()).unwrap();
        assert!(!ui.contains("restoreSessions"));
    }
}
