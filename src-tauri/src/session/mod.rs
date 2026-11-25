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

#[tauri::command]
pub fn session_launch_external_rdp(
    session_id: String,
    connection_id: String,
    title: String,
    host: String,
    port: u16,
    username: String,
    session_state: tauri::State<'_, SessionState>,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = (&host, port, &username);
    let resolved = resolve_connection(&auth_state, &connection_id)?;

    let (kill_tx, kill_rx) = std::sync::mpsc::channel();
    let rdp_config = rdp_config_from(resolved, title, None);

    rdp::spawn_rdp_session(session_id.clone(), rdp_config, kill_rx, app);

    let mut mgr = session_state.lock().map_err(|e| e.to_string())?;
    mgr.rdp_killers.insert(session_id, kill_tx);
    Ok(())
}

fn rdp_config_from(resolved: ResolvedConnection, title: String, embed: Option<rdp::EmbedTarget>) -> rdp::RdpConnectionConfig {
    rdp::RdpConnectionConfig {
        connection_id: resolved.conn.id.clone(),
        certificate_fingerprint: resolved.rdp_fingerprint,
        title,
        host: resolved.conn.host.clone(),
        port: resolved.conn.port,
        username: resolved.username.clone(),
        password: resolved.password.clone(),
        domain: resolved.conn.rdp_settings.as_ref().and_then(|s| s.domain.clone()),
        rdp_settings: resolved.conn.rdp_settings.clone(),
        embed,
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RdpCertificateInfo {
    connection_id: String,
    host: String,
    port: u16,
    fingerprint: String,
    previous_fingerprint: Option<String>,
}

#[tauri::command]
pub async fn rdp_certificate_preview(connection_id: String, auth_state: tauri::State<'_, AuthState>) -> Result<RdpCertificateInfo, String> {
    let resolved = resolve_connection(&auth_state, &connection_id)?;
    if resolved.conn.protocol != "rdp" { return Err(tr!("To nie jest połączenie RDP", "Not an RDP connection").into()); }
    let host = resolved.conn.host;
    let port = resolved.conn.port;
    let fingerprint = rdp_proxy::probe_certificate(&host, port).await?;
    Ok(RdpCertificateInfo { connection_id, host, port, fingerprint, previous_fingerprint: resolved.rdp_fingerprint })
}

#[tauri::command]
pub async fn rdp_certificate_trust(connection_id: String, host: String, port: u16, fingerprint: String,
    previous_fingerprint: Option<String>, auth_state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let preview = rdp_certificate_preview(connection_id.clone(), auth_state.clone()).await?;
    if preview.host != host || preview.port != port || preview.fingerprint != fingerprint {
        return Err(tr!("Certyfikat lub adres serwera zmienił się. Sprawdź odcisk ponownie.", "The certificate or server address changed. Check the fingerprint again.").into());
    }
    let mgr = lock_auth(&auth_state)?;
    let key = mgr.unlocked_key()?;
    crate::vault::storage::update_vault(key, |v| {
        let conn = v.connections.iter().find(|c| c.id == connection_id && c.protocol == "rdp" && c.host == host && c.port == port)
            .ok_or_else(|| tr!("Połączenie RDP zmieniło się – sprawdź certyfikat ponownie", "The RDP connection changed – check the certificate again").to_string())?;
        let id = known_hosts::host_id("rdp", &conn.host, conn.port);
        if v.metadata.known_hosts.get(&id) != previous_fingerprint.as_ref() { return Err(tr!("Zaufany certyfikat zmienił się w międzyczasie – sprawdź go ponownie", "The trusted certificate changed in the meantime – check it again").into()); }
        v.metadata.known_hosts.insert(id, fingerprint);
        Ok(())
    })?;
    known_hosts::remember_verified(&load_vault_verified(key)?.metadata.known_hosts);
    Ok(())
}

/// FreeRDP configuration of a saved connection (credentials from the unlocked vault).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn rdp_config_for_connection(
    auth_state: &AuthState,
    connection_id: &str,
    title: String,
    embed: Option<rdp::EmbedTarget>,
) -> Result<rdp::RdpConnectionConfig, String> {
    Ok(rdp_config_from(resolve_connection(auth_state, connection_id)?, title, embed))
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

#[derive(Serialize)]
pub struct SftpListResponse {
    #[serde(rename = "currentPath")]
    pub current_path: String,
    pub entries: Vec<sftp::SftpFileEntry>,
    /// Parent directory (local listings), `None` at the file-system root.
    #[serde(rename = "parentPath", skip_serializing_if = "Option::is_none")]
    pub parent_path: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Two-pane SFTP manager
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct TransferProgress {
    #[serde(rename = "transferId")]
    transfer_id: String,
    files: u32,
    current: String,
    bytes: u64,
}

fn progress_emitter(app: tauri::AppHandle, transfer_id: String) -> impl FnMut(u32, &str, u64) {
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |files: u32, current: &str, bytes: u64| {
        if last.elapsed() >= std::time::Duration::from_millis(120) {
            last = std::time::Instant::now();
            let _ = app.emit(
                "sftp-transfer-progress",
                TransferProgress { transfer_id: transfer_id.clone(), files, current: current.to_string(), bytes },
            );
        }
    }
}

/// Cancel flags of running transfers (transfer id → flag).
static TRANSFER_CANCEL: std::sync::LazyLock<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Registers a running transfer; the flag is removed when the guard is dropped.
struct CancelGuard {
    id: String,
    flag: Arc<std::sync::atomic::AtomicBool>,
}

impl CancelGuard {
    fn new(id: &str) -> Self {
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if let Ok(mut m) = TRANSFER_CANCEL.lock() {
            m.insert(id.to_string(), flag.clone());
        }
        CancelGuard { id: id.to_string(), flag }
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = TRANSFER_CANCEL.lock() {
            m.remove(&self.id);
        }
    }
}

/// Stops a running upload/download ("Przerwij" in the SFTP window). Returns false when the
/// transfer has already finished.
#[tauri::command]
pub fn sftp_transfer_cancel(transfer_id: String) -> bool {
    match TRANSFER_CANCEL.lock().ok().and_then(|m| m.get(&transfer_id).cloned()) {
        Some(flag) => {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn sftp_mkdir(
    connection_id: String,
    parent: String,
    name: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| transfer::remote_mkdir(sftp, &parent, &name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// New empty file on the server (SFTP window); returns its path.
#[tauri::command]
pub async fn sftp_mkfile(
    connection_id: String,
    parent: String,
    name: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| transfer::remote_mkfile(sftp, &parent, &name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// New empty local file (SFTP window); returns its path.
#[tauri::command]
pub async fn local_mkfile(parent: String, name: String, auth_state: tauri::State<'_, AuthState>) -> Result<String, String> {
    localfs::local_access(&auth_state)?.check(std::path::Path::new(&parent).join(&name))?;
    tokio::task::spawn_blocking(move || transfer::local_mkfile(&parent, &name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_delete_paths(
    connection_id: String,
    remote_paths: Vec<String>,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| {
            let mut n = 0;
            for p in &remote_paths {
                transfer::remote_delete(sftp, p)?;
                n += 1;
            }
            Ok(n)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_search(
    connection_id: String,
    remote_dir: String,
    query: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<Vec<sftp::SftpFileEntry>, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| transfer::remote_search(sftp, &remote_dir, &query))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_transfer_upload(
    connection_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<transfer::TransferSummary, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    let access = localfs::local_access(&auth_state)?;
    for p in &local_paths {
        access.check(p)?;
    }
    let guard = CancelGuard::new(&transfer_id);
    let mut progress = progress_emitter(app.clone(), transfer_id);
    tokio::task::spawn_blocking(move || transfer::upload_paths(&config, &local_paths, &remote_dir, &mut progress, &guard.flag))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_transfer_download(
    connection_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_id: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<transfer::TransferSummary, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    localfs::local_access(&auth_state)?.check(&local_dir)?;
    let guard = CancelGuard::new(&transfer_id);
    let mut progress = progress_emitter(app.clone(), transfer_id);
    tokio::task::spawn_blocking(move || transfer::download_paths(&config, &remote_paths, &local_dir, &mut progress, &guard.flag))
        .await
        .map_err(|e| e.to_string())?
}

/// Closes the cached browsing session of a connection (SFTP window closed).
#[tauri::command]
pub fn sftp_release(connection_id: String) {
    std::thread::spawn(move || transfer::release_pooled(&connection_id));
}

#[tauri::command]
pub async fn local_mkdir(parent: String, name: String, auth_state: tauri::State<'_, AuthState>) -> Result<String, String> {
    localfs::local_access(&auth_state)?.check(std::path::Path::new(&parent).join(&name))?;
    tokio::task::spawn_blocking(move || transfer::local_mkdir(&parent, &name))
        .await
        .map_err(|e| e.to_string())?
}

// --- File preview / text editor of the SFTP window (see preview.rs) ---------------------------

/// Size, modification time and read-only flag of a file (`side`: "local" | "remote").
#[tauri::command]
pub async fn preview_stat(
    side: String,
    connection_id: String,
    path: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<preview::FileStat, String> {
    if side == "local" {
        localfs::local_access(&auth_state)?.check(&path)?;
        return tokio::task::spawn_blocking(move || preview::local_stat(&path)).await.map_err(|e| e.to_string())?;
    }
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || transfer::with_pooled_sftp(&connection_id, &config, |sftp| preview::remote_stat(sftp, &path)))
        .await
        .map_err(|e| e.to_string())?
}

/// A chunk of a file as raw bytes (ArrayBuffer on the JavaScript side), at most 4 MB.
#[tauri::command]
pub async fn preview_read(
    side: String,
    connection_id: String,
    path: String,
    offset: u64,
    length: u64,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<tauri::ipc::Response, String> {
    let bytes = if side == "local" {
        localfs::local_access(&auth_state)?.check(&path)?;
        tokio::task::spawn_blocking(move || preview::local_read(&path, offset, length)).await.map_err(|e| e.to_string())??
    } else {
        let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
        tokio::task::spawn_blocking(move || {
            transfer::with_pooled_sftp(&connection_id, &config, |sftp| preview::remote_read(sftp, &path, offset, length))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    Ok(tauri::ipc::Response::new(bytes))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewSaveArgs {
    side: String,
    connection_id: String,
    path: String,
    /// Size and modification time from opening; None = overwrite whatever is there.
    expected_size: Option<u64>,
    expected_modified: Option<u64>,
}

/// Saves the edited file. The new content is the raw request body; the other arguments come in
/// the `x-rf-args` header (URI-encoded JSON), so a large file is not sent as a JSON number array.
#[tauri::command]
pub async fn preview_save(
    request: tauri::ipc::Request<'_>,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<preview::FileStat, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected raw file content".into());
    };
    if data.len() > preview::MAX_SAVE {
        return Err(tr!("Plik jest za duży do zapisania z edytora.", "The file is too large to be saved from the editor.").to_string());
    }
    let header = request
        .headers()
        .get("x-rf-args")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-rf-args")?;
    let decoded = percent_encoding::percent_decode_str(header).decode_utf8().map_err(|e| e.to_string())?;
    let args: PreviewSaveArgs = serde_json::from_str(&decoded).map_err(|e| e.to_string())?;
    let expected = args.expected_size.zip(args.expected_modified);
    let data = data.clone();
    if args.side == "local" {
        localfs::local_access(&auth_state)?.check(&args.path)?;
        return tokio::task::spawn_blocking(move || preview::local_save(&args.path, &data, expected))
            .await
            .map_err(|e| e.to_string())?;
    }
    let config = resolve_connection_ssh_config(&args.connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&args.connection_id, &config, |sftp| preview::remote_save(sftp, &args.path, &data, expected))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes local files/folders (SFTP window). See `transfer::local_delete`.
#[tauri::command]
pub async fn local_delete_paths(paths: Vec<String>, permanent: bool, auth_state: tauri::State<'_, AuthState>) -> Result<u32, String> {
    let access = localfs::local_access(&auth_state)?;
    for p in &paths {
        access.check_delete(p)?;
    }
    tokio::task::spawn_blocking(move || {
        let mut n = 0;
        for p in &paths {
            transfer::local_delete(p, permanent)?;
            n += 1;
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_search(local_dir: String, query: String, auth_state: tauri::State<'_, AuthState>) -> Result<Vec<sftp::SftpFileEntry>, String> {
    localfs::require_unlocked(&auth_state)?;
    tokio::task::spawn_blocking(move || transfer::local_search(&local_dir, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sftp_list(
    connection_id: String,
    remote_path: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<SftpListResponse, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    let (current_path, entries) = tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| transfer::remote_list(sftp, &remote_path))
    })
    .await
    .map_err(|e| tr!("Błąd zadania SFTP: {}", "SFTP task error: {}", e))??;

    Ok(SftpListResponse {
        current_path,
        entries,
        parent_path: None,
    })
}

#[tauri::command]
pub async fn sftp_upload_file(
    connection_id: String,
    remote_dir: String,
    filename: String,
    content_base64: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<u64, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        sftp::sftp_upload_base64_file(&config, &remote_dir, &filename, &content_base64)
    })
    .await
    .map_err(|e| tr!("Błąd zadania przesyłania pliku SFTP: {}", "SFTP file upload task error: {}", e))?
}

#[tauri::command]
pub async fn sftp_upload_paths(
    connection_id: String,
    remote_dir: String,
    local_paths: Vec<String>,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    let access = localfs::local_access(&auth_state)?;
    for p in &local_paths {
        access.check(p)?;
    }
    tokio::task::spawn_blocking(move || {
        sftp::sftp_upload_local_paths(&config, local_paths, &remote_dir)
    })
    .await
    .map_err(|e| tr!("Błąd zadania przesyłania katalogu SFTP: {}", "SFTP folder upload task error: {}", e))?
}

#[tauri::command]
pub fn open_shared_folder(target_dir: Option<String>) -> Result<String, String> {
    let resolved_dir = if let Some(dir) = target_dir.filter(|s| !s.trim().is_empty()) {
        std::path::PathBuf::from(dir)
    } else {
        dirs::download_dir().or_else(dirs::home_dir).unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
    };

    let _ = std::fs::create_dir_all(&resolved_dir);
    // Only folders are opened: "opening" a file passed here would run it (an executable, a script,
    // a .desktop file) through the system file associations.
    if !resolved_dir.is_dir() {
        return Err(tr!("To nie jest katalog: {}", "Not a folder: {}", resolved_dir.display()));
    }
    let path_str = resolved_dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&path_str).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&path_str).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(&path_str).spawn();

    Ok(path_str)
}

#[tauri::command]
pub async fn save_dropped_file_to_shared(
    filename: String,
    content_base64: String,
    connection_id: Option<String>,
    auth_state: tauri::State<'_, AuthState>,
) -> Result<String, String> {
    // The target folder is the connection's exchange folder from the vault, never a path from the UI
    let access = localfs::local_access(&auth_state)?;
    let target_dir = match connection_id.filter(|id| !id.is_empty()) {
        Some(id) => {
            let mgr = lock_auth(&auth_state)?;
            let key = mgr.unlocked_key()?;
            load_vault_verified(key)?
                .connections
                .into_iter()
                .find(|c| c.id == id)
                .and_then(|c| c.default_download_dir)
        }
        None => None,
    };
    tokio::task::spawn_blocking(move || {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&content_base64)
            .map_err(|e| tr!("Błąd dekodowania pliku: {}", "File decoding error: {}", e))?;

        let save_dir = if let Some(dir) = target_dir.filter(|s| !s.trim().is_empty()) {
            std::path::PathBuf::from(dir)
        } else {
            dirs::download_dir()
                .or_else(dirs::home_dir)
                .ok_or_else(|| tr!("Nie znaleziono katalogu pobierania", "The downloads folder was not found").to_string())?
        };

        let _ = std::fs::create_dir_all(&save_dir);

        let normalized = filename.replace('\\', "/");
        let parts: Vec<&str> = normalized
            .split('/')
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .collect();

        if parts.is_empty() {
            return Err(tr!("Nieprawidłowa nazwa pliku", "Invalid file name").to_string());
        }

        let mut target_path = save_dir;
        if parts.len() > 1 {
            for dir_part in &parts[..parts.len() - 1] {
                target_path = target_path.join(dir_part);
            }
            let _ = std::fs::create_dir_all(&target_path);
        }
        target_path = target_path.join(parts.last().unwrap());
        access.check(&target_path)?;

        std::fs::write(&target_path, &data)
            .map_err(|e| tr!("Błąd zapisu pliku do katalogu wymiany: {}", "Error writing the file to the exchange folder: {}", e))?;

        Ok(target_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "linux")]
fn decode_file_uri(uri: &str) -> Option<String> {
    let raw = uri.strip_prefix("file://")?;
    let mut bytes = Vec::with_capacity(raw.len());
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h1), Some(h2)) = (
                (b[i + 1] as char).to_digit(16),
                (b[i + 2] as char).to_digit(16),
            ) {
                bytes.push(((h1 << 4) | h2) as u8);
                i += 3;
                continue;
            }
        }
        bytes.push(b[i]);
        i += 1;
    }
    String::from_utf8(bytes).ok()
}

#[tauri::command]
pub async fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let tx_cell = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
            let tx_clone = tx_cell.clone();
            clip.request_text(move |_clip, text| {
                if let Some(sender) = tx_clone.borrow_mut().take() {
                    let s = text.map(|t| t.to_string()).unwrap_or_default();
                    let _ = sender.send(s);
                }
            });
        });

        let mut text = tokio::time::timeout(std::time::Duration::from_millis(450), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

        if text.is_empty() {
            text = tokio::task::spawn_blocking(linux_clipboard::read_text)
                .await
                .unwrap_or_default();
        }

        Ok(text)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let text = tokio::task::spawn_blocking(winproc::clipboard_get_text)
            .await
            .unwrap_or_default();
        Ok(text)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        Ok(String::new())
    }
}

#[tauri::command]
pub async fn clipboard_write_text(text: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // GTK clipboard of the window first, then a system helper (Wayland/X11) – see
        // linux_clipboard.rs. The helper runs after GTK so both hold the same text.
        let text_for_gtk = text.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let _ = app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            clip.set_text(&text_for_gtk);
            clip.store();
            let _ = tx.send(());
        });
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), rx).await;

        let _ = tokio::task::spawn_blocking(move || linux_clipboard::write_text(&text)).await;

        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let _ = tokio::task::spawn_blocking(move || winproc::clipboard_set_text(&text)).await;
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (text, app);
        Ok(())
    }
}

/// How long a copied password stays on the clipboard.
const SECRET_CLIPBOARD_SECS: u64 = 30;
static SECRET_CLIPBOARD_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Copies a password: on Windows kept out of the clipboard history and cloud sync; after
/// 30 seconds the clipboard is cleared if it still holds this password (and no newer one was copied).
#[tauri::command]
pub async fn clipboard_write_secret(text: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let secret = zeroize::Zeroizing::new(text);
    #[cfg(target_os = "windows")]
    {
        let copy = secret.clone();
        tokio::task::spawn_blocking(move || winproc::clipboard_set_secret(&copy)).await.map_err(|e| e.to_string())??;
    }
    #[cfg(not(target_os = "windows"))]
    clipboard_write_text(secret.to_string(), app.clone()).await?;

    let generation = SECRET_CLIPBOARD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(SECRET_CLIPBOARD_SECS)).await;
        if SECRET_CLIPBOARD_GENERATION.load(Ordering::SeqCst) != generation || secret.is_empty() {
            return;
        }
        let current = zeroize::Zeroizing::new(clipboard_read_text(app.clone()).await.unwrap_or_default());
        if *current != *secret {
            return; // the user copied something else meanwhile
        }
        #[cfg(target_os = "windows")]
        {
            let _ = app;
            let _ = tokio::task::spawn_blocking(winproc::clipboard_clear).await;
        }
        #[cfg(not(target_os = "windows"))]
        let _ = clipboard_write_text(String::new(), app).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn clipboard_read_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let tx_cell = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
            let tx_clone = tx_cell.clone();
            clip.request_uris(move |_clip, uris| {
                if let Some(sender) = tx_clone.borrow_mut().take() {
                    let list: Vec<String> = uris.iter().map(|u| u.to_string()).collect();
                    let _ = sender.send(list);
                }
            });
        });

        let uris = tokio::time::timeout(std::time::Duration::from_millis(450), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

        let home_str = dirs::home_dir()
            .map(|h| h.to_string_lossy().trim_end_matches('/').to_string())
            .unwrap_or_default();

        let mut paths = Vec::new();
        for uri in uris {
            if let Some(p) = decode_file_uri(&uri) {
                let clean = p.trim_end_matches('/').to_string();
                if !clean.is_empty()
                    && clean != "/"
                    && clean != home_str
                    && std::path::Path::new(&clean).exists()
                    && !paths.contains(&clean)
                {
                    paths.push(clean);
                }
            }
        }

        if paths.is_empty() {
            if let Ok(text) = clipboard_read_text(app).await {
                for line in text.lines() {
                    let trimmed = line.trim();
                    if let Some(p) = decode_file_uri(trimmed) {
                        let clean = p.trim_end_matches('/').to_string();
                        if !clean.is_empty()
                            && clean != "/"
                            && clean != home_str
                            && std::path::Path::new(&clean).exists()
                            && !paths.contains(&clean)
                        {
                            paths.push(clean);
                        }
                    } else if trimmed.starts_with('/') && !trimmed.contains('\0') {
                        let clean = trimmed.trim_end_matches('/').to_string();
                        if !clean.is_empty()
                            && clean != "/"
                            && clean != home_str
                            && std::path::Path::new(&clean).exists()
                            && !paths.contains(&clean)
                        {
                            paths.push(clean);
                        }
                    }
                }
            }
        }

        Ok(paths)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let paths = tokio::task::spawn_blocking(winproc::clipboard_get_files)
            .await
            .unwrap_or_default();
        Ok(paths)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn local_list_dir(local_path: String, auth_state: tauri::State<'_, AuthState>) -> Result<SftpListResponse, String> {
    localfs::require_unlocked(&auth_state)?;
    tokio::task::spawn_blocking(move || {
        let target = if local_path.is_empty() || local_path == "~" || local_path == "." {
            dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"))
        } else {
            std::path::PathBuf::from(&local_path)
        };

        let canonical = std::fs::canonicalize(&target).unwrap_or(target);
        let current_path = transfer::display_path(&canonical);
        let parent_path = canonical.parent().map(transfer::display_path);

        let read_dir = std::fs::read_dir(&canonical)
            .map_err(|e| tr!("Błąd odczytu katalogu lokalnego '{}': {}", "Error reading local folder '{}': {}", current_path, e))?;

        let mut entries = Vec::new();
        for item in read_dir.flatten() {
            let p = item.path();
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            // Symbolic links are shown (with the data of their target); hidden system entries
            // on Windows (legacy profile junctions) are not.
            if let Some(entry) = transfer::local_entry(&p) {
                entries.push(entry);
            }
        }

        entries.sort_by(|a, b| {
            let a_hidden = a.name.starts_with('.');
            let b_hidden = b.name.starts_with('.');
            if a_hidden != b_hidden {
                a_hidden.cmp(&b_hidden)
            } else if a.is_dir != b.is_dir {
                b.is_dir.cmp(&a.is_dir)
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });

        Ok(SftpListResponse {
            current_path,
            entries,
            parent_path,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pick_local_folder() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            let script = tr!(
                "{} $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Wybierz katalog'; if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.SelectedPath }}", "{} $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Choose a folder'; if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.SelectedPath }}",
                winproc::DIALOG_PRELUDE
            );
            if let Some(out) = winproc::powershell(&script) {
                let s = out.trim().to_string();
                if !s.is_empty() {
                    return Ok(Some(s));
                }
            }
            return Ok(None);
        }

        #[cfg(not(target_os = "windows"))]
        {
            let home = dirs::home_dir()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string());

            if let Ok(out) = std::process::Command::new("kdialog")
                .arg("--getexistingdirectory")
                .arg(&home)
                .arg("--title")
                .arg(tr!("Wybierz katalog do przesłania", "Choose a folder to upload"))
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            if let Ok(out) = std::process::Command::new("zenity")
                .arg("--file-selection")
                .arg("--directory")
                .arg(tr!("--title=Wybierz katalog do przesłania", "--title=Choose a folder to upload"))
                .arg(format!("--filename={}/", home))
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native "open file" dialog (blocking). Not exposed to the UI as a command: the UI never gets
/// to choose which local file the backend reads.
fn pick_file_dialog(title: Option<String>) -> Result<Option<String>, String> {
    {
        let dialog_title = title.unwrap_or_else(|| tr!("Wybierz plik klucza prywatnego SSH", "Choose the SSH private key file").to_string());
        #[cfg(target_os = "windows")]
        {
            let script = format!(
                "{} $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Multiselect = $false; $f.Title = '{}'; if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.FileName }}",
                winproc::DIALOG_PRELUDE,
                dialog_title.replace('\'', "''")
            );
            if let Some(out) = winproc::powershell(&script) {
                let s = out.trim().to_string();
                if !s.is_empty() {
                    return Ok(Some(s));
                }
            }
            return Ok(None);
        }

        #[cfg(not(target_os = "windows"))]
        {
            let home = dirs::home_dir()
                .map(|h| h.join(".ssh").to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string());

            if let Ok(out) = std::process::Command::new("kdialog")
                .arg("--getopenfilename")
                .arg(&home)
                .arg("--title")
                .arg(&dialog_title)
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            if let Ok(out) = std::process::Command::new("zenity")
                .arg("--file-selection")
                .arg(format!("--title={}", dialog_title))
                .arg(format!("--filename={}/", home))
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            Ok(None)
        }
    }
}

#[derive(Serialize)]
pub struct PickedKeyFile {
    pub path: String,
    pub content: String,
}

const MAX_KEY_FILE_BYTES: u64 = 64 * 1024;

/// Checks that a file chosen as an SSH private key really looks like one.
pub(crate) fn read_private_key_file(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    if !meta.is_file() || meta.len() > MAX_KEY_FILE_BYTES {
        return Err(tr!("Wybrany plik nie jest kluczem prywatnym SSH", "The selected file is not an SSH private key").to_string());
    }
    let content = std::fs::read_to_string(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    let looks_like_key = content.contains("PRIVATE KEY-----") || content.starts_with("PuTTY-User-Key-File-");
    if !looks_like_key {
        return Err(tr!("Wybrany plik nie jest kluczem prywatnym SSH", "The selected file is not an SSH private key").to_string());
    }
    Ok(content)
}

/// Opens the native file dialog and returns the chosen SSH private key. Replaces the former
/// `read_local_text_file(path)` command, which let the web layer read ANY file it named
/// (e.g. ~/.ssh/id_rsa) – a script injected into the UI could have stolen keys that way.
/// Now only a file the user explicitly picks in the system dialog is read.
#[tauri::command]
pub async fn pick_private_key_file(title: Option<String>) -> Result<Option<PickedKeyFile>, String> {
    tokio::task::spawn_blocking(move || {
        let Some(path) = pick_file_dialog(title)? else {
            return Ok(None);
        };
        let content = read_private_key_file(std::path::Path::new(&path))?;
        Ok(Some(PickedKeyFile { path, content }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Checks that a file chosen as an SSH certificate really is an OpenSSH certificate
/// (`ssh-ed25519-cert-v01@openssh.com AAAA… comment`).
fn read_certificate(path: &std::path::Path) -> Result<String, String> {
    let not_cert = || {
        tr!(
            "Wybrany plik nie jest certyfikatem SSH (oczekiwano pliku …-cert.pub)",
            "The selected file is not an SSH certificate (expected a …-cert.pub file)"
        )
        .to_string()
    };
    let meta = std::fs::metadata(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    if !meta.is_file() || meta.len() > MAX_KEY_FILE_BYTES {
        return Err(not_cert());
    }
    let content = std::fs::read_to_string(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    if !looks_like_ssh_certificate(&content) {
        return Err(not_cert());
    }
    Ok(content.trim().to_string())
}

fn looks_like_ssh_certificate(content: &str) -> bool {
    let mut parts = content.split_whitespace();
    let kind = parts.next().unwrap_or("");
    kind.ends_with("-cert-v01@openssh.com") && parts.next().is_some_and(|b| b.starts_with("AAAA"))
}

/// Opens the native file dialog and returns the chosen SSH certificate (…-cert.pub).
#[tauri::command]
pub async fn pick_ssh_certificate_file(title: Option<String>) -> Result<Option<PickedKeyFile>, String> {
    tokio::task::spawn_blocking(move || {
        let title = title.unwrap_or_else(|| tr!("Wybierz plik certyfikatu SSH", "Choose the SSH certificate file").to_string());
        let Some(path) = pick_file_dialog(Some(title))? else {
            return Ok(None);
        };
        let content = read_certificate(std::path::Path::new(&path))?;
        Ok(Some(PickedKeyFile { path, content }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct RdpClipboardFileEntry {
    pub name: String,
    pub path: Option<String>,
    #[serde(rename = "isDirectory")]
    pub is_directory: bool,
    pub size: u64,
    #[serde(rename = "lastModified")]
    pub last_modified: u64,
    #[serde(rename = "contentBase64")]
    pub content_base64: Option<String>,
}

fn collect_rdp_clipboard_entries(
    local: &std::path::Path,
    rel_parent_win: Option<String>,
    shared_target_dir: &std::path::Path,
    out: &mut Vec<RdpClipboardFileEntry>,
    depth: u32,
) -> Result<(), String> {
    if out.len() >= 500 || depth > 16 {
        return Ok(());
    }

    let sym_meta = match std::fs::symlink_metadata(local) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };
    if sym_meta.file_type().is_symlink() {
        return Ok(());
    }

    let name = local
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("item")
        .to_string();

    if depth > 0
        && (name == ".cache"
            || name == ".local"
            || name == ".cargo"
            || name == ".rustup"
            || name == "node_modules"
            || name == "target"
            || name == ".git")
    {
        return Ok(());
    }

    let last_modified = sym_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let shared_dest = shared_target_dir.join(&name);

    if sym_meta.is_dir() {
        let _ = std::fs::create_dir_all(&shared_dest);
        out.push(RdpClipboardFileEntry {
            name: name.clone(),
            path: rel_parent_win.clone(),
            is_directory: true,
            size: 0,
            last_modified,
            content_base64: None,
        });

        let next_parent = match rel_parent_win {
            Some(ref p) if !p.is_empty() => Some(format!("{}\\{}", p, name)),
            _ => Some(name),
        };

        if let Ok(entries) = std::fs::read_dir(local) {
            for entry in entries.flatten() {
                collect_rdp_clipboard_entries(
                    &entry.path(),
                    next_parent.clone(),
                    &shared_dest,
                    out,
                    depth + 1,
                )?;
            }
        }
    } else if sym_meta.is_file() {
        // Cap individual file size for in-memory base64 clipboard staging to 50 MB
        if sym_meta.len() > 50 * 1024 * 1024 {
            return Ok(());
        }
        use base64::Engine;
        let data = std::fs::read(local)
            .map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", local.display(), e))?;
        let _ = std::fs::write(&shared_dest, &data);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        out.push(RdpClipboardFileEntry {
            name,
            path: rel_parent_win,
            is_directory: false,
            size: data.len() as u64,
            last_modified,
            content_base64: Some(b64),
        });
    }

    Ok(())
}

/// Folder shared with RDP sessions (FreeRDP drive "RemoteFlow", files for the remote clipboard):
/// `~/RemoteFlow_Shared`, owner-only on Unix (0700 – also an existing folder is tightened). No
/// fallback to a folder every local user can write to (`/tmp`).
pub(crate) fn shared_exchange_dir() -> Result<std::path::PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or_else(|| tr!("Nie znaleziono katalogu domowego", "The home folder was not found").to_string())?
        .join("RemoteFlow_Shared");
    crate::vault::storage::create_private_dir(&dir)
        .map_err(|e| tr!("Nie można utworzyć katalogu {:?}: {}", "Cannot create folder {:?}: {}", dir, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::symlink_metadata(&dir) {
            if meta.is_dir() && meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            }
        }
    }
    Ok(dir)
}

#[tauri::command]
pub async fn read_local_paths_for_rdp_clipboard(
    local_paths: Vec<String>,
    auth_state: tauri::State<'_, AuthState>,
) -> Result<Vec<RdpClipboardFileEntry>, String> {
    let access = localfs::local_access(&auth_state)?;
    for p in &local_paths {
        access.check(p)?;
    }
    let shared_dir = shared_exchange_dir()?;
    tokio::task::spawn_blocking(move || {
        let home_dir = dirs::home_dir()
            .map(|h| h.to_string_lossy().trim_end_matches('/').to_string())
            .unwrap_or_default();

        let mut result = Vec::new();
        for lp in local_paths {
            let clean = lp.trim_end_matches('/');
            if clean.is_empty() || clean == "/" {
                return Err(tr!("Nie można przesłać głównego systemu plików '/'.", "The root file system '/' cannot be uploaded.").to_string());
            }
            if !home_dir.is_empty() && clean == home_dir {
                return Err(tr!(
                    "Nie można przesłać całego katalogu domowego ({}). Wybierz konkretny podkatalog lub plik.", "The whole home folder ({}) cannot be uploaded. Choose a specific subfolder or file.",
                    home_dir
                ));
            }
            let p = std::path::Path::new(&lp);
            if p.exists() {
                collect_rdp_clipboard_entries(p, None, &shared_dir, &mut result, 0)?;
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Exits the application after the user confirmed it in the UI (the window close request is
/// intercepted by the frontend, so the window cannot simply be destroyed by the OS).
#[tauri::command]
pub fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn app_maximize_window(window: tauri::Window) -> Result<(), String> {
    window.maximize().map_err(|e| e.to_string())
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
