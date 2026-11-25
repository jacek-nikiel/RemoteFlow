pub mod rdp;
pub mod rdp_embed;
pub mod rdp_proxy;
pub mod sftp;
pub mod terminal_cwd;
pub mod ssh;
pub mod ssh_algos;
pub mod ssh_keyauth;
pub mod transfer;
pub mod preview;
pub mod localfs;
pub mod tunnels;
pub mod commands;

#[cfg(target_os = "linux")]
pub mod linux_clipboard;
pub mod clipstage;
pub mod winproc;

use crate::auth::{lock_auth, AuthState};
use crate::vault::cipher::decrypt_opt;
use crate::vault::known_hosts;
use crate::vault::models::{Connection, RdpSettings};
use crate::vault::storage::load_vault_verified;
use rand::RngCore;
use rdp_proxy::RdpProxyHandle;
use serde::{Deserialize, Serialize};
use ssh::{spawn_ssh_session, HostKeyVerifier, SshConnectionConfig, SshWorkerCommand};
use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};
use tunnels::{start_tunnels, TunnelHandle};

pub use commands::clipboard::*;
pub use commands::dialogs::*;
pub use commands::rdp::*;
pub use commands::sftp::*;
use commands::dialogs::{read_certificate, read_private_key_file};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    pub title: String,
    pub protocol: String, // "ssh" or "rdp"
    pub host: String,
    pub port: u16,
    pub username: String,
    pub status: String, // "connecting", "connected", "disconnected", "error"
    #[serde(rename = "statusMessage")]
    pub status_message: Option<String>,
    #[serde(rename = "bytesSent")]
    pub bytes_sent: u64,
    #[serde(rename = "bytesReceived")]
    pub bytes_received: u64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "activePortForwards")]
    pub active_port_forwards: Vec<String>,
    #[serde(rename = "rdpProxyPort")]
    pub rdp_proxy_port: Option<u16>,
    /// Random per-session secret the WebAssembly client must present to the local proxy.
    #[serde(rename = "rdpProxyToken")]
    pub rdp_proxy_token: Option<String>,
    #[serde(rename = "rdpDomain")]
    pub rdp_domain: Option<String>,
    #[serde(rename = "rdpSettings")]
    pub rdp_settings: Option<RdpSettings>,
}

pub struct SessionManager {
    pub sessions: HashMap<String, SessionInfo>,
    pub senders: HashMap<String, Sender<SshWorkerCommand>>,
    pub rdp_killers: HashMap<String, Sender<()>>,
    /// FreeRDP processes drawing inside the RemoteFlow window (rdp_embed)
    pub rdp_embed_killers: HashMap<String, Sender<()>>,
    pub rdp_proxies: HashMap<String, RdpProxyHandle>,
    pub tunnels: HashMap<String, TunnelHandle>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            senders: HashMap::new(),
            rdp_killers: HashMap::new(),
            rdp_embed_killers: HashMap::new(),
            rdp_proxies: HashMap::new(),
            tunnels: HashMap::new(),
        }
    }
}

pub type SessionState = Mutex<SessionManager>;

/// Host without IPv6 brackets ("[::1]" -> "::1"), for the resolver.
pub fn bare_host(host: &str) -> &str {
    let h = host.trim();
    h.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(h)
}

/// "host:port" with brackets around IPv6 literals ("[::1]:22"), as expected by socket address
/// parsers, FreeRDP (/v:) and the RDP proxy destination check.
pub fn host_port(host: &str, port: u16) -> String {
    let h = bare_host(host);
    if h.contains(':') { format!("[{}]:{}", h, port) } else { format!("{}:{}", h, port) }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusEvent {
    session_id: String,
    status: String,
    message: Option<String>,
}

/// Updates the state of a session (connecting / connected / error / disconnected) and tells the
/// UI. Called by the worker threads, so the tab shows the real state (e.g. a failed login).
pub(crate) fn report_session_status(app: &tauri::AppHandle, session_id: &str, status: &str, message: Option<String>) {
    if let Some(state) = app.try_state::<SessionState>() {
        if let Ok(mut mgr) = state.lock() {
            if let Some(s) = mgr.sessions.get_mut(session_id) {
                s.status = status.to_string();
                s.status_message = message.clone();
            }
        }
    }
    let _ = app.emit(
        "session-status",
        SessionStatusEvent { session_id: session_id.to_string(), status: status.to_string(), message },
    );
}

#[cfg(test)]
mod addr_tests {
    use super::*;

    #[test]
    fn ipv6_literals_get_brackets() {
        assert_eq!(host_port("::1", 22), "[::1]:22");
        assert_eq!(host_port("[fe80::1]", 3389), "[fe80::1]:3389");
        assert_eq!(host_port("srv.local", 22), "srv.local:22");
        assert_eq!(host_port("10.0.0.5", 22), "10.0.0.5:22");
        assert_eq!(bare_host("[::1]"), "::1");
        use std::net::ToSocketAddrs;
        assert!(host_port("::1", 22).to_socket_addrs().is_ok());
        assert!((bare_host("[::1]"), 22).to_socket_addrs().is_ok());
    }
}

/// `where <bin>` without flashing a console window (Windows); plain `where` elsewhere.
pub(crate) fn winproc_where(bin: &str) -> std::io::Result<std::process::Output> {
    #[cfg(target_os = "windows")]
    {
        winproc::hidden_command("where").arg(bin).output()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("where").arg(bin).output()
    }
}

/// RDP password for the embedded client, read from the vault at the moment of (re)connecting.
/// It is not kept in `SessionInfo`, so once the vault is locked it
/// can no longer be obtained – a reconnect then needs an unlocked vault.
#[tauri::command]
pub fn session_rdp_password(
    session_id: String,
    session_state: tauri::State<'_, SessionState>,
    auth_state: tauri::State<'_, AuthState>,
) -> Result<Option<String>, String> {
    let connection_id = {
        let mgr = session_state.lock().map_err(|e| e.to_string())?;
        let session = mgr
            .sessions
            .get(&session_id)
            .filter(|s| s.protocol == "rdp")
            .ok_or_else(|| tr!("Nie znaleziono sesji RDP", "RDP session not found").to_string())?;
        session.connection_id.clone()
    };
    Ok(resolve_connection(&auth_state, &connection_id)?.password)
}

/// Credentials and connection data resolved from the (integrity-verified) vault.
struct ResolvedConnection {
    conn: Connection,
    username: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    rdp_fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPasswordStatus {
    connection_id: String,
    name: String,
    host: String,
    port: u16,
    requires_password: bool,
    has_password: bool,
}

fn password_status(mut resolved: ResolvedConnection) -> ConnectionPasswordStatus {
    let password = resolved.password.take().map(zeroize::Zeroizing::new);
    ConnectionPasswordStatus {
        connection_id: resolved.conn.id,
        name: resolved.conn.name,
        host: resolved.conn.host,
        port: resolved.conn.port,
        requires_password: resolved.conn.protocol == "rdp" || resolved.conn.protocol == "ssh" && resolved.conn.ssh_auth_type == "password",
        has_password: password.as_deref().is_some_and(|p| !p.is_empty()),
    }
}

#[tauri::command]
pub fn connection_password_status(connection_id: String, auth_state: tauri::State<'_, AuthState>) -> Result<ConnectionPasswordStatus, String> {
    Ok(password_status(resolve_connection(&auth_state, &connection_id)?))
}

/// Reads an SSH certificate file chosen in the connection (None when missing or not a certificate).
fn read_certificate_file(path: &Option<String>) -> Option<String> {
    let path = path.as_deref()?.trim();
    if path.is_empty() {
        return None;
    }
    read_certificate(std::path::Path::new(path)).ok()
}

/// Key file of a connection/credential. The path may come from an imported file, so it gets the
/// same checks as a key picked in the dialog (size limit, private key header); anything else is
/// ignored (the key stored in the vault is used, if any).
fn read_key_file(path: &Option<String>) -> Option<String> {
    let path = path.as_deref()?.trim();
    if path.is_empty() {
        return None;
    }
    match read_private_key_file(std::path::Path::new(path)) {
        Ok(content) => Some(content),
        Err(e) => {
            eprintln!("[RemoteFlow] Pominięto plik klucza {:?}: {}", path, e);
            None
        }
    }
}

/// Resolves a saved connection. Host, port and protocol ALWAYS come from the vault, never from the
/// UI, so a compromised frontend cannot redirect stored credentials to an arbitrary server.
fn resolve_connection(auth_state: &AuthState, connection_id: &str) -> Result<ResolvedConnection, String> {
    let mgr = lock_auth(auth_state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Magazyn poświadczeń jest zablokowany", "The credential store is locked").to_string())?;
    let vault = load_vault_verified(key)?;
    resolve_connection_data(&vault, key, connection_id)
}

fn resolve_connection_data(vault: &crate::vault::models::VaultData, key: &[u8; 32], connection_id: &str) -> Result<ResolvedConnection, String> {
    let mut conn = vault
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .cloned()
        .ok_or_else(|| tr!("Nie znaleziono połączenia o ID '{}'", "Connection with ID '{}' not found", connection_id))?;

    let mut username = conn.username.clone();
    let mut password: Option<String> = None;
    let mut private_key: Option<String> = None;
    let mut passphrase: Option<String> = None;

    // Login method actually used (see `effective_ssh_auth_type`)
    let linked = conn.credential_id.as_ref().and_then(|id| vault.credentials.iter().find(|c| c.id == *id));
    conn.ssh_auth_type = effective_ssh_auth_type(&conn, linked.map(|c| c.auth_type.as_str()));

    // Reusable credential (lower priority)
    if let Some(cred_id) = &conn.credential_id {
        if let Some(cred) = vault.credentials.iter().find(|c| c.id == *cred_id) {
            if !cred.username.is_empty() {
                username = cred.username.clone();
            }
            password = decrypt_opt(key, &cred.password_encrypted)?;
            private_key = read_key_file(&cred.key_file_path);
            if private_key.is_none() {
                private_key = decrypt_opt(key, &cred.private_key_encrypted)?;
            }
            passphrase = decrypt_opt(key, &cred.private_key_passphrase_encrypted)?;
        }
    }

    // Direct connection credentials override the reusable credential if set
    if let Some(p) = decrypt_opt(key, &conn.password_encrypted)? {
        password = Some(p);
    }
    if let Some(k) = read_key_file(&conn.key_file_path) {
        private_key = Some(k);
    } else if let Some(k) = decrypt_opt(key, &conn.private_key_encrypted)? {
        private_key = Some(k);
    }
    if let Some(p) = decrypt_opt(key, &conn.private_key_passphrase_encrypted)? {
        passphrase = Some(p);
    }

    // SSH certificate: connection file > connection content > profile file > profile content.
    // The file is read at every connection, so a renewed (short-lived) certificate is picked up.
    let non_empty = |c: &Option<String>| c.clone().filter(|c| !c.trim().is_empty());
    let profile = linked;
    let certificate = read_certificate_file(&conn.certificate_file_path)
        .or_else(|| non_empty(&conn.certificate_content))
        .or_else(|| profile.and_then(|c| read_certificate_file(&c.certificate_file_path)))
        .or_else(|| profile.and_then(|c| non_empty(&c.certificate_content)));
    if certificate.is_none() && conn.protocol == "ssh" && conn.ssh_auth_type == "certificate" {
        let path = [conn.certificate_file_path.as_deref(), profile.and_then(|c| c.certificate_file_path.as_deref())]
            .into_iter()
            .flatten()
            .find(|p| !p.trim().is_empty());
        if let Some(path) = path {
            return Err(tr!(
                "Nie można odczytać certyfikatu SSH z pliku '{}' – sprawdź, czy plik istnieje i jest certyfikatem OpenSSH (…-cert.pub).",
                "Cannot read the SSH certificate from '{}' – check that the file exists and is an OpenSSH certificate (…-cert.pub).",
                path
            ));
        }
    }
    conn.certificate_content = certificate;

    Ok(ResolvedConnection {
        rdp_fingerprint: vault.metadata.known_hosts.get(&known_hosts::host_id("rdp", &conn.host, conn.port)).cloned(),
        conn,
        username,
        password,
        private_key,
        passphrase,
    })
}

/// SSH login method of a connection. SSH no longer falls back from one method to another, so the
/// method must match the material that will be used:
/// - "agent" chosen in the connection always means the SSH agent;
/// - a connection with its own secret (password, key or key file) uses its own method – its secret
///   overrides the profile;
/// - otherwise a linked credential profile decides (its type may have been changed after the
///   connection was linked to it – earlier the method was only copied when choosing the profile).
pub(crate) fn effective_ssh_auth_type(conn: &Connection, credential_auth_type: Option<&str>) -> String {
    let own_secret = conn.password_encrypted.is_some()
        || conn.private_key_encrypted.is_some()
        || conn.key_file_path.as_deref().is_some_and(|p| !p.trim().is_empty());
    match credential_auth_type {
        Some(profile) if conn.ssh_auth_type != "agent" && !own_secret && !profile.is_empty() => profile.to_string(),
        _ => conn.ssh_auth_type.clone(),
    }
}

/// Builds a TOFU verifier for a server identity ("ssh" or "rdp").
pub fn make_host_verifier(app: &tauri::AppHandle, kind: &'static str, host: String, port: u16) -> HostKeyVerifier {
    let app = app.clone();
    HostKeyVerifier(Arc::new(move |fingerprint: &str| {
        let key = {
            let state = app.state::<AuthState>();
            let mgr = lock_auth(&state)?;
            mgr.unlocked_key().ok().cloned()
        };
        known_hosts::check_host(key.as_deref(), kind, &host, port, fingerprint)
    }))
}

fn random_token() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[tauri::command]
pub fn session_connect(
    session_id: Option<String>,
    connection_id: String,
    title: String,
    protocol: String,
    host: String,
    port: u16,
    username: String,
    port_forwards_desc: Vec<String>,
    custom_passphrase: Option<String>,
    session_state: tauri::State<'_, SessionState>,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<SessionInfo, String> {
    // host/port/protocol/username sent by the UI are informational only – the vault is authoritative.
    let _ = (&protocol, &host, port, &username);

    let resolved = resolve_connection(&auth_state, &connection_id)?;
    let conn = &resolved.conn;
    let host = conn.host.clone();
    let port = conn.port;
    let protocol = conn.protocol.clone();

    let session_id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    eprintln!("[RemoteFlow] session_connect: id={}, proto={}, target={}:{}", session_id, protocol, host, port);

    let mut resolved_passphrase = resolved.passphrase.clone();
    if let Some(cp) = custom_passphrase {
        if !cp.is_empty() {
            resolved_passphrase = Some(cp);
        }
    }

    if protocol == "ssh" {
        let session = SessionInfo {
            session_id: session_id.clone(),
            connection_id,
            title,
            protocol: protocol.clone(),
            host: host.clone(),
            port,
            username: resolved.username.clone(),
            // The worker thread reports "connected" (after login) or "error" via `session-status`
            status: "connecting".to_string(),
            status_message: Some(tr!("Nawiązywanie połączenia...", "Connecting...").to_string()),
            bytes_sent: 0,
            bytes_received: 0,
            started_at: now,
            active_port_forwards: port_forwards_desc,
            rdp_proxy_port: None,
            rdp_proxy_token: None,
            rdp_domain: None,
            rdp_settings: None,
        };

        let (tx, rx) = std::sync::mpsc::channel();
        let config = SshConnectionConfig {
            auth_type: conn.ssh_auth_type.clone(),
            certificate: conn.certificate_content.clone(),
            host: host.clone(),
            port,
            username: resolved.username.clone(),
            password: resolved.password.clone(),
            private_key: resolved.private_key.clone(),
            passphrase: resolved_passphrase,
            host_key_verifier: make_host_verifier(&app, "ssh", host, port),
        };

        // Registered before the worker starts, so its status updates always find the session
        {
            let mut mgr = session_state.lock().map_err(|e| e.to_string())?;
            mgr.sessions.insert(session_id.clone(), session.clone());
            mgr.senders.insert(session_id.clone(), tx);
        }
        spawn_ssh_session(session_id.clone(), config.clone(), rx, app.clone());

        let tunnel_app = app.clone();
        let tunnel_sid = session_id.clone();
        // Local ports already used by tunnels of other tabs (clear message instead of the OS error)
        let owners: HashMap<u16, String> = {
            let mgr = session_state.lock().map_err(|e| e.to_string())?;
            mgr.tunnels
                .values()
                .flat_map(|t| t.ports.iter().map(move |p| (*p, t.title.clone())))
                .collect()
        };
        let tunnel_handle = start_tunnels(
            config,
            conn.port_forwarding.clone(),
            Arc::new(move |msg: String| {
                let _ = tunnel_app.emit(&format!("ssh-data-{}", tunnel_sid), msg);
            }),
            session.title.clone(),
            &owners,
        );

        let mut mgr = session_state.lock().map_err(|e| e.to_string())?;
        if let Some(th) = tunnel_handle {
            mgr.tunnels.insert(session_id.clone(), th);
        }
        // The worker may already have reported "connected" / "error"
        Ok(mgr.sessions.get(&session_id).cloned().unwrap_or(session))
    } else if protocol == "rdp" {
        // Local WebSocket-to-TCP proxy for the WebAssembly client. It is locked to the configured
        // target, requires a per-session random token and pins the server's TLS certificate.
        let proxy_token = random_token();
        let error_app = app.clone();
        let error_sid = session_id.clone();
        let proxy_res = rdp_proxy::start_rdp_proxy(
            host.clone(),
            port,
            proxy_token.clone(),
            make_host_verifier(&app, "rdp", host.clone(), port),
            Arc::new(move |msg: String| {
                let _ = error_app.emit(&format!("rdp-proxy-error-{}", error_sid), msg);
            }),
        );
        let proxy_handle = proxy_res.map_err(|e| {
            eprintln!("[RemoteFlow] Błąd startu proxy RDP: {}", e);
            tr!("Nie udało się uruchomić lokalnego proxy RDP: {}", "Could not start the local RDP proxy: {}", e)
        })?;
        let rdp_proxy_port = Some(proxy_handle.port);
        // "CORP\\jan", "jan@corp.local" and the separate domain field are reduced to one consistent form
        let (rdp_user, rdp_domain) = rdp::normalize_rdp_identity(
            &resolved.username,
            conn.rdp_settings.as_ref().and_then(|s| s.domain.as_deref()),
        );

        let session = SessionInfo {
            session_id: session_id.clone(),
            connection_id,
            title,
            protocol,
            host,
            port,
            username: rdp_user,
            status: "connected".to_string(),
            status_message: Some(tr!("Sesja RDP aktywna w zakładce", "RDP session active in the tab").to_string()),
            bytes_sent: 0,
            bytes_received: 0,
            started_at: now,
            active_port_forwards: port_forwards_desc,
            rdp_proxy_port,
            rdp_proxy_token: Some(proxy_token),
            rdp_domain,
            rdp_settings: conn.rdp_settings.clone(),
        };

        let mut mgr = session_state.lock().map_err(|e| e.to_string())?;
        mgr.sessions.insert(session_id.clone(), session.clone());
        mgr.rdp_proxies.insert(session_id.clone(), proxy_handle);
        Ok(session)
    } else {
        Err(tr!("Nieobsługiwany protokół: {}", "Unsupported protocol: {}", protocol))
    }
}

#[tauri::command]
pub fn session_send_input(
    session_id: String,
    data: String,
    state: tauri::State<'_, SessionState>,
) -> Result<(), String> {
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    if let Some(session) = mgr.sessions.get_mut(&session_id) {
        session.bytes_sent += data.len() as u64;
    }

    if let Some(tx) = mgr.senders.get(&session_id) {
        let _ = tx.send(SshWorkerCommand::Input(data.into_bytes()));
    }

    Ok(())
}

#[tauri::command]
pub fn session_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    state: tauri::State<'_, SessionState>,
) -> Result<(), String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    if let Some(tx) = mgr.senders.get(&session_id) {
        let _ = tx.send(SshWorkerCommand::Resize(cols, rows));
    }
    Ok(())
}

/// Tunnels of an SSH tab and their state (the tunnels window of the terminal). `None` when the
/// session has no tunnels.
#[tauri::command]
pub fn get_session_tunnels(
    session_id: String,
    state: tauri::State<'_, SessionState>,
) -> Result<Option<tunnels::TunnelsStatus>, String> {
    let mgr = state.lock().map_err(|e| e.to_string())?;
    Ok(mgr.tunnels.get(&session_id).and_then(|t| t.status()))
}

/// Current directory of the shell in an SSH terminal tab (SFTP "directory from the terminal").
#[tauri::command]
pub async fn ssh_terminal_cwd(
    session_id: String,
    state: tauri::State<'_, SessionState>,
) -> Result<terminal_cwd::TerminalCwd, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let mgr = state.lock().map_err(|e| e.to_string())?;
        let sender = mgr
            .senders
            .get(&session_id)
            .ok_or_else(|| tr!("Sesja terminala nie jest aktywna.", "The terminal session is not active.").to_string())?;
        sender
            .send(SshWorkerCommand::Cwd(tx))
            .map_err(|_| tr!("Sesja terminala została zakończona.", "The terminal session has ended.").to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(15)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| tr!("Serwer nie odpowiedział na czas.", "The server did not respond in time.").to_string())?
}

#[tauri::command]
pub fn session_close(
    session_id: String,
    state: tauri::State<'_, SessionState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    if let Some(kill_tx) = mgr.rdp_embed_killers.remove(&session_id) {
        let _ = kill_tx.send(());
    }
    rdp_embed::destroy_container(&app, &session_id);
    mgr.sessions.remove(&session_id);
    if let Some(tx) = mgr.senders.remove(&session_id) {
        let _ = tx.send(SshWorkerCommand::Close);
    }
    if let Some(kill_tx) = mgr.rdp_killers.remove(&session_id) {
        let _ = kill_tx.send(());
    }
    if let Some(proxy) = mgr.rdp_proxies.remove(&session_id) {
        proxy.shutdown();
    }
    if let Some(tunnel) = mgr.tunnels.remove(&session_id) {
        tunnel.shutdown();
    }
    Ok(())
}

pub fn resolve_connection_ssh_config(
    connection_id: &str,
    auth_state: &tauri::State<'_, AuthState>,
    app: &tauri::AppHandle,
) -> Result<SshConnectionConfig, String> {
    let resolved = resolve_connection(auth_state, connection_id)?;
    let host = resolved.conn.host.clone();
    let port = resolved.conn.port;
    Ok(SshConnectionConfig {
        auth_type: resolved.conn.ssh_auth_type.clone(),
        certificate: resolved.conn.certificate_content.clone(),
        host: host.clone(),
        port,
        username: resolved.username,
        password: resolved.password,
        private_key: resolved.private_key,
        passphrase: resolved.passphrase,
        host_key_verifier: make_host_verifier(app, "ssh", host, port),
    })
}

#[cfg(test)]
mod key_file_pick_tests {
    use super::read_private_key_file;

    #[test]
    fn empty_password_check_decrypts_effective_credentials_and_skips_key_auth() {
        use crate::vault::cipher::encrypt_string;
        let key = [17u8; 32];
        let mut vault: crate::vault::models::VaultData = serde_json::from_value(serde_json::json!({
            "metadata": { "version": 3, "salt_base64": "", "canary_nonce_base64": "", "canary_ciphertext_base64": "",
                "pin_enabled": false, "auto_lock_screen": true, "auto_lock_timeout_mins": 15, "max_pin_attempts": 3 },
            "groups": [],
            "connections": [{ "id": "c", "name": "server", "protocol": "ssh", "host": "server", "port": 22,
                "username": "root", "credentialId": "profile", "sshAuthType": "password",
                "portForwarding": [], "tags": [], "createdAt": "", "updatedAt": "" }],
            "credentials": [{ "id": "profile", "name": "profile", "username": "alice", "authType": "password",
                "passwordEncrypted": encrypt_string(&key, "inherited password").unwrap(), "createdAt": "", "updatedAt": "" }]
        })).unwrap();
        let status = || super::password_status(super::resolve_connection_data(&vault, &key, "c").unwrap());
        assert!(status().requires_password && status().has_password);
        vault.connections[0].password_encrypted = Some(encrypt_string(&key, "").unwrap());
        let status = super::password_status(super::resolve_connection_data(&vault, &key, "c").unwrap());
        assert!(status.requires_password && !status.has_password, "an encrypted empty string is still empty");
        vault.connections[0].password_encrypted = Some(encrypt_string(&key, " ").unwrap());
        assert!(super::password_status(super::resolve_connection_data(&vault, &key, "c").unwrap()).has_password, "spaces are valid password characters");
        for method in ["key", "certificate", "agent"] {
            vault.connections[0].ssh_auth_type = method.into();
            assert!(!super::password_status(super::resolve_connection_data(&vault, &key, "c").unwrap()).requires_password);
        }
        vault.connections[0].protocol = "rdp".into();
        vault.connections[0].password_encrypted = None;
        vault.credentials[0].password_encrypted = None;
        let status = super::password_status(super::resolve_connection_data(&vault, &key, "c").unwrap());
        assert!(status.requires_password && !status.has_password);
    }

    #[test]
    fn login_method_follows_profile_unless_connection_has_own_secret() {
        use crate::vault::cipher::encrypt_string;
        let key = [7u8; 32];
        let mut vault: crate::vault::models::VaultData = serde_json::from_value(serde_json::json!({
            "metadata": { "version": 3, "salt_base64": "", "canary_nonce_base64": "", "canary_ciphertext_base64": "",
                "pin_enabled": false, "auto_lock_screen": true, "auto_lock_timeout_mins": 15, "max_pin_attempts": 3 },
            "groups": [],
            "connections": [{ "id": "c", "name": "server", "protocol": "ssh", "host": "server", "port": 22,
                "username": "root", "credentialId": "profile", "sshAuthType": "password",
                "portForwarding": [], "tags": [], "createdAt": "", "updatedAt": "" }],
            "credentials": [{ "id": "profile", "name": "profile", "username": "alice", "authType": "key",
                "privateKeyEncrypted": encrypt_string(&key, "profile key").unwrap(), "createdAt": "", "updatedAt": "" }]
        })).unwrap();
        // Profile changed to a key after linking: the key is used and no password is requested
        let resolved = super::resolve_connection_data(&vault, &key, "c").unwrap();
        assert_eq!(resolved.conn.ssh_auth_type, "key");
        assert!(!super::password_status(resolved).requires_password);
        // The connection's own password overrides the profile
        vault.connections[0].password_encrypted = Some(encrypt_string(&key, "own").unwrap());
        assert_eq!(super::resolve_connection_data(&vault, &key, "c").unwrap().conn.ssh_auth_type, "password");
        // Agent chosen in the connection always wins; without a profile the connection decides
        vault.connections[0].password_encrypted = None;
        vault.connections[0].ssh_auth_type = "agent".into();
        assert_eq!(super::resolve_connection_data(&vault, &key, "c").unwrap().conn.ssh_auth_type, "agent");
        vault.connections[0].ssh_auth_type = "password".into();
        vault.connections[0].credential_id = None;
        assert_eq!(super::resolve_connection_data(&vault, &key, "c").unwrap().conn.ssh_auth_type, "password");
    }

    #[test]
    fn connection_key_overrides_profile_and_profile_certificate_is_inherited() {
        use crate::vault::cipher::encrypt_string;
        let key = [42u8; 32];
        let direct = encrypt_string(&key, "connection key").unwrap();
        let profile = encrypt_string(&key, "profile key").unwrap();
        let mut vault: crate::vault::models::VaultData = serde_json::from_value(serde_json::json!({
            "metadata": { "version": 2, "salt_base64": "", "canary_nonce_base64": "", "canary_ciphertext_base64": "",
                "pin_enabled": false, "auto_lock_screen": true, "auto_lock_timeout_mins": 15, "max_pin_attempts": 3 },
            "groups": [],
            "connections": [{ "id": "c", "name": "server", "protocol": "ssh", "host": "server", "port": 22,
                "username": "root", "credentialId": "profile", "sshAuthType": "certificate",
                "privateKeyEncrypted": direct, "portForwarding": [], "tags": [], "createdAt": "", "updatedAt": "" }],
            "credentials": [{ "id": "profile", "name": "profile", "username": "alice", "authType": "certificate",
                "privateKeyEncrypted": profile, "certificateContent": "profile certificate", "createdAt": "", "updatedAt": "" }]
        })).unwrap();
        let resolved = super::resolve_connection_data(&vault, &key, "c").unwrap();
        assert_eq!(resolved.private_key.as_deref(), Some("connection key"));
        assert_eq!(resolved.conn.certificate_content.as_deref(), Some("profile certificate"));
        vault.connections[0].private_key_encrypted = None;
        vault.connections[0].certificate_content = Some("connection certificate".into());
        let resolved = super::resolve_connection_data(&vault, &key, "c").unwrap();
        assert_eq!(resolved.private_key.as_deref(), Some("profile key"));
        assert_eq!(resolved.conn.certificate_content.as_deref(), Some("connection certificate"));
    }

    #[test]
    fn certificate_file_is_read_at_connect_time_and_takes_precedence() {
        let key = [42u8; 32];
        let dir = std::env::temp_dir().join(format!("rf-cert-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("id_ed25519-cert.pub");
        std::fs::write(&file, "ssh-ed25519-cert-v01@openssh.com AAAAfile1 user@host\n").unwrap();
        let mut vault: crate::vault::models::VaultData = serde_json::from_value(serde_json::json!({
            "metadata": { "version": 2, "salt_base64": "", "canary_nonce_base64": "", "canary_ciphertext_base64": "",
                "pin_enabled": false, "auto_lock_screen": true, "auto_lock_timeout_mins": 15, "max_pin_attempts": 3 },
            "groups": [],
            "connections": [{ "id": "c", "name": "server", "protocol": "ssh", "host": "server", "port": 22,
                "username": "root", "sshAuthType": "certificate", "certificateContent": "stored certificate",
                "certificateFilePath": file.to_string_lossy(), "portForwarding": [], "tags": [], "createdAt": "", "updatedAt": "" }],
            "credentials": []
        })).unwrap();
        let cert = |v: &crate::vault::models::VaultData| super::resolve_connection_data(v, &key, "c").map(|r| r.conn.certificate_content);
        assert_eq!(cert(&vault).unwrap().as_deref(), Some("ssh-ed25519-cert-v01@openssh.com AAAAfile1 user@host"));
        // A renewed certificate in the same file is used without editing the connection
        std::fs::write(&file, "ssh-ed25519-cert-v01@openssh.com AAAAfile2 user@host").unwrap();
        assert_eq!(cert(&vault).unwrap().as_deref(), Some("ssh-ed25519-cert-v01@openssh.com AAAAfile2 user@host"));
        // Not a certificate / missing file: the content stored when the file was chosen
        std::fs::write(&file, "-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
        assert_eq!(cert(&vault).unwrap().as_deref(), Some("stored certificate"));
        std::fs::remove_file(&file).unwrap();
        assert_eq!(cert(&vault).unwrap().as_deref(), Some("stored certificate"));
        // Nothing usable: a clear error naming the file
        vault.connections[0].certificate_content = None;
        assert!(cert(&vault).unwrap_err().contains("id_ed25519-cert.pub"));
        // Saved without the new field (older vault) – unchanged serialization
        vault.connections[0].certificate_file_path = None;
        let json = serde_json::to_string(&vault.connections[0]).unwrap();
        assert!(!json.contains("certificateFilePath"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_private_keys_are_read() {
        let dir = std::env::temp_dir().join(format!("rf-keypick-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id_test");
        std::fs::write(&key, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n").unwrap();
        assert!(read_private_key_file(&key).is_ok());
        let other = dir.join("passwd");
        std::fs::write(&other, "root:x:0:0:root:/root:/bin/bash\n").unwrap();
        assert!(read_private_key_file(&other).is_err());
        let big = dir.join("big");
        std::fs::write(&big, vec![b'A'; 70 * 1024]).unwrap();
        assert!(read_private_key_file(&big).is_err());
        assert!(read_private_key_file(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
