use crate::vault::cipher::fingerprint_from_digest;
use crate::vault::known_hosts::HostTrust;
use std::io::{Read, Write};
use std::net::ToSocketAddrs;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Checks a server fingerprint ("SHA256:...") against the trusted-hosts store.
#[derive(Clone)]
pub struct HostKeyVerifier(pub Arc<dyn Fn(&str) -> Result<HostTrust, String> + Send + Sync>);

impl std::fmt::Debug for HostKeyVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HostKeyVerifier")
    }
}

#[derive(Clone)]
pub struct SshConnectionConfig {
    pub auth_type: String,
    pub certificate: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    /// Mandatory: the server's host key is verified BEFORE any credentials are sent.
    pub host_key_verifier: HostKeyVerifier,
}

/// Secrets are wiped from memory when a config (or any clone of it) is dropped.
impl Drop for SshConnectionConfig {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        for secret in [&mut self.password, &mut self.private_key, &mut self.passphrase].into_iter().flatten() {
            secret.zeroize();
        }
    }
}

/// Never prints the secrets.
impl std::fmt::Debug for SshConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshConnectionConfig")
            .field("auth_type", &self.auth_type)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

pub enum SshWorkerCommand {
    Input(Vec<u8>),
    Resize(u32, u32),
    /// Current directory of the terminal's shell (SFTP "directory from the terminal")
    Cwd(std::sync::mpsc::Sender<Result<crate::session::terminal_cwd::TerminalCwd, String>>),
    Close,
}

/// Folder for the rare Windows fallback in [`ssh_connect_raw`] (per-user, not shared %TEMP%).
fn key_tmp_dir() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("RemoteFlow")
        .join("ssh-tmp")
}

/// Overwrites a file with zeros before deleting it (best effort – SSD wear levelling may keep
/// old blocks, which is why this path is only a last-resort fallback).
fn wipe_file(path: &std::path::Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(path) {
            let zeros = vec![0u8; meta.len() as usize];
            let _ = f.write_all(&zeros);
            let _ = f.sync_all();
        }
    }
    let _ = std::fs::remove_file(path);
}

/// Removes key files left behind by a crash or a killed process (called at startup).
pub fn sweep_stale_key_files() {
    // Files from versions before 1.1.2 were written to %TEMP%
    let legacy = std::fs::read_dir(std::env::temp_dir()).into_iter().flatten().flatten();
    let current = std::fs::read_dir(key_tmp_dir()).into_iter().flatten().flatten();
    for entry in legacy.chain(current) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with("rf_ssh_") && name.ends_with(".tmp") {
            wipe_file(&entry.path());
        }
    }
}

/// Private key written to disk only for the duration of one authentication; wiped on drop.
#[cfg_attr(not(windows), allow(dead_code))]
struct TempKeyFile {
    path: std::path::PathBuf,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl TempKeyFile {
    fn create(content: &[u8]) -> std::io::Result<Self> {
        let dir = key_tmp_dir();
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("rf_ssh_{}.tmp", uuid::Uuid::new_v4()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true); // never follow / reuse an existing file
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path)?;
        let guard = TempKeyFile { path };
        f.write_all(content)?;
        f.sync_all()?;
        Ok(guard)
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TempKeyFile {
    fn drop(&mut self) {
        wipe_file(&self.path);
    }
}

/// Public-key authentication with a key held in memory.
/// On Unix the `ssh2` crate exposes this (OpenSSL backend). On Windows (WinCNG backend) the
/// crate hides the method behind its OpenSSL features, although libssh2 itself supports it
/// (WinCNG + crypt32), so the libssh2 function is called directly.
pub(crate) fn pubkey_from_memory(sess: &ssh2::Session, username: &str, public_key: Option<&str>, key: &str, passphrase: Option<&str>) -> bool {
    #[cfg(not(windows))]
    {
        sess.userauth_pubkey_memory(username, public_key, key, passphrase).is_ok()
    }
    #[cfg(windows)]
    {
        // NUL-terminated copies for C; the key and passphrase copies are wiped on drop.
        fn c_bytes(s: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
            if s.as_bytes().contains(&0) {
                return None;
            }
            let mut v = zeroize::Zeroizing::new(Vec::with_capacity(s.len() + 1));
            v.extend_from_slice(s.as_bytes());
            v.push(0);
            Some(v)
        }
        let (Some(user), Some(priv_key)) = (c_bytes(username), c_bytes(key)) else {
            return false;
        };
        let pass = match passphrase.map(c_bytes) {
            Some(Some(p)) => Some(p),
            Some(None) => return false,
            None => None,
        };
        let public = match public_key.map(c_bytes) {
            Some(Some(p)) => Some(p),
            Some(None) => return false,
            None => None,
        };
        let mut raw = sess.raw();
        let rc = unsafe {
            libssh2_sys::libssh2_userauth_publickey_frommemory(
                &mut *raw,
                user.as_ptr() as *const _,
                username.len() as _,
                public.as_ref().map(|p| p.as_ptr() as *const _).unwrap_or(std::ptr::null()),
                public_key.map(str::len).unwrap_or(0),
                priv_key.as_ptr() as *const _,
                key.len() as _,
                pass.as_ref().map(|p| p.as_ptr() as *const _).unwrap_or(std::ptr::null()),
            )
        };
        rc == 0
    }
}

/// Time limit for the SSH handshake and authentication. Without it a server that accepts the
/// TCP connection but never answers would block the thread forever (closing the tab did not help).
#[cfg(not(test))]
const HANDSHAKE_TIMEOUT_MS: u32 = 20_000;
#[cfg(test)]
const HANDSHAKE_TIMEOUT_MS: u32 = 1_500;

pub fn ssh_connect_raw(config: &SshConnectionConfig) -> Result<ssh2::Session, String> {
    validate_auth(config)?;
    // Host and port go to the resolver separately – "host:port" broke IPv6 literals (::1 -> "::1:22")
    let host = crate::session::bare_host(&config.host);
    let addr_str = crate::session::host_port(&config.host, config.port);
    let mut tcp_stream = None;
    let mut connected_addr = None;

    if let Ok(addrs) = (host, config.port).to_socket_addrs() {
        for addr in addrs {
            if let Ok(stream) = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(4)) {
                let _ = stream.set_nodelay(true);

                // Enable OS-level TCP KeepAlive so NAT gateways and firewalls never drop idle TCP state
                let socket = socket2::Socket::from(stream);
                let keepalive = socket2::TcpKeepalive::new()
                    .with_time(std::time::Duration::from_secs(15))
                    .with_interval(std::time::Duration::from_secs(5));
                let _ = socket.set_tcp_keepalive(&keepalive);
                let stream: std::net::TcpStream = socket.into();

                tcp_stream = Some(stream);
                connected_addr = Some(addr);
                break;
            }
        }
    }

    let tcp = tcp_stream.ok_or_else(|| {
        tr!("Nie udało się połączyć z hostem '{}': brak odpowiedzi (sprawdź adres IP i port)", "Could not connect to host '{}': no response (check the IP address and port)", addr_str)
    })?;

    let mut sess = ssh2::Session::new().map_err(|e| tr!("Błąd inicjalizacji biblioteki SSH: {}", "SSH library initialisation error: {}", e))?;
    sess.set_tcp_stream(tcp);
    // Covers the handshake, the host key check and authentication; callers set their own
    // timeout (or non-blocking mode) for the rest of the session.
    sess.set_timeout(HANDSHAKE_TIMEOUT_MS);
    if let Err(e) = sess.handshake() {
        let mut msg = tr!("Błąd negocjacji SSH (Handshake): {}", "SSH handshake error: {}", e);
        // KEX failure: no common algorithm – say which ones the server offers (see ssh_algos.rs)
        if e.code() == ssh2::ErrorCode::Session(-5) {
            if let Some(addr) = connected_addr {
                if let Ok(server) = crate::session::ssh_algos::probe(addr, std::time::Duration::from_secs(5)) {
                    if let Some(why) = crate::session::ssh_algos::explain(&server, &crate::session::ssh_algos::supported(&sess)) {
                        msg = format!("{msg}\n{why}");
                    }
                }
            }
        }
        return Err(msg);
    }

    // Host key verification (TOFU) – must happen before any authentication attempt,
    // otherwise a man-in-the-middle would receive the password.
    let digest = sess
        .host_key_hash(ssh2::HashType::Sha256)
        .ok_or_else(|| tr!("Serwer SSH nie przedstawił klucza hosta", "The SSH server did not present a host key").to_string())?;
    let fingerprint = fingerprint_from_digest(digest);
    (config.host_key_verifier.0)(&fingerprint)?;

    if matches!(config.auth_type.as_str(), "key" | "certificate") {
      if let Some(key_content) = &config.private_key {
        let trimmed = key_content.trim();
        if !trimmed.is_empty() {
            let passphrase = config.passphrase.as_deref().filter(|p| !p.is_empty());
            let certificate = if config.auth_type == "certificate" { config.certificate.as_deref() } else { None };
            // libssh2 expects a public certificate file for file-based authentication.
            let certificate_file = certificate.map(|c| TempKeyFile::create(c.as_bytes())).transpose()
                .map_err(|e| tr!("Nie można przygotować certyfikatu SSH: {}", "Cannot prepare the SSH certificate: {}", e))?;
            let key_path = std::path::Path::new(trimmed);
            let is_path = !trimmed.contains('\n') && key_path.is_file();
            // A one-line value naming an existing file: read with the same checks as a picked key
            // file (size limit, private key header) – never any other file
            let file_text = if is_path {
                Some(crate::session::read_private_key_file(key_path).map(zeroize::Zeroizing::new)?)
            } else {
                None
            };
            let key_text: &str = file_text.as_deref().map(String::as_str).unwrap_or(key_content);
            if let Some(msg) = crate::session::ssh_keyauth::unsupported_format_message(key_text) {
                return Err(msg);
            }
            if crate::session::ssh_keyauth::is_openssh_key(key_text) {
                // OpenSSH format (default of current ssh-keygen): decoded in Rust – works on
                // Windows too (WinCNG cannot read it) and reports a wrong passphrase clearly.
                crate::session::ssh_keyauth::authenticate(&sess, &config.username, key_text, passphrase, certificate)?;
            } else if is_path {
                // The user's own key file: libssh2 reads it directly – no copy is ever written.
                let _ = sess.userauth_pubkey_file(&config.username, certificate_file.as_ref().map(TempKeyFile::path), key_path, passphrase);
            } else {
                // Key stored in the vault: authenticate from memory on every platform
                // (OpenSSL backend on Unix, WinCNG + crypt32 on Windows).
                let authed = pubkey_from_memory(&sess, &config.username, certificate, key_content, passphrase);
                #[cfg(not(windows))]
                let _ = authed;

                // WinCNG cannot decrypt passphrase-protected PEM keys held in memory, only from a
                // file. Only in that case a short-lived, owner-only file is used and wiped right away.
                #[cfg(windows)]
                {
                    if !authed && passphrase.is_some() {
                        if let Ok(tmp) = TempKeyFile::create(key_content.as_bytes()) {
                            let _ = sess.userauth_pubkey_file(&config.username, certificate_file.as_ref().map(TempKeyFile::path), tmp.path(), passphrase);
                        }
                    }
                }
            }
        }
      }
    }

    if config.auth_type == "password" {
        let _ = sess.userauth_password(&config.username, config.password.as_deref().unwrap_or_default());
    }

    if config.auth_type == "agent" {
        let _ = sess.userauth_agent(&config.username);
    }

    if !sess.authenticated() {
        return Err(tr!(
            "Niepowodzenie logowania dla użytkownika '{}' na serwerze {}. Sprawdź hasło lub klucz.", "Login failed for user '{}' on server {}. Check the password or key.",
            config.username, addr_str
        ));
    }

    Ok(sess)
}

fn validate_auth(config: &SshConnectionConfig) -> Result<(), String> {
    match config.auth_type.as_str() {
        "password" | "agent" => Ok(()),
        "key" | "certificate" => {
            if config.private_key.as_deref().is_none_or(|k| k.trim().is_empty()) {
                return Err(tr!("Brak klucza prywatnego SSH", "SSH private key is missing").into());
            }
            if config.auth_type == "certificate" && config.certificate.as_deref().is_none_or(|c| {
                !c.split_whitespace().next().is_some_and(|kind| kind.ends_with("-cert-v01@openssh.com"))
            }) {
                return Err(tr!("Brak poprawnego certyfikatu OpenSSH", "A valid OpenSSH certificate is required").into());
            }
            Ok(())
        }
        _ => Err(tr!("Nieobsługiwany typ uwierzytelnienia SSH", "Unsupported SSH authentication type").into()),
    }
}

/// Converts the complete UTF-8 prefix of `pending` to text and keeps an incomplete trailing
/// character (at most 3 bytes) for the next read. Invalid bytes are replaced (lossy).
fn take_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() && pending.len() - e.valid_up_to() < 4 => {
            // Incomplete character at the end – wait for the rest of it
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).to_string();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            // Invalid bytes in the middle: convert everything except a possible incomplete tail
            let cut = incomplete_tail_start(pending);
            let out = String::from_utf8_lossy(&pending[..cut]).to_string();
            pending.drain(..cut);
            out
        }
    }
}

/// Index where a possibly incomplete UTF-8 sequence starts at the end of `bytes` (or len).
fn incomplete_tail_start(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=3.min(len) {
        let b = bytes[len - back];
        if b & 0b1100_0000 == 0b1000_0000 {
            continue; // continuation byte – look further back
        }
        let needed = if b >= 0xF0 { 4 } else if b >= 0xE0 { 3 } else if b >= 0xC0 { 2 } else { 1 };
        return if needed > back { len - back } else { len };
    }
    len
}

pub fn spawn_ssh_session(
    session_id: String,
    config: SshConnectionConfig,
    cmd_rx: Receiver<SshWorkerCommand>,
    app: AppHandle,
) {
    std::thread::spawn(move || {
        let data_app = app.clone();
        let data_event = format!("ssh-data-{}", session_id);
        run_ssh_worker(
            config,
            cmd_rx,
            move |text: String| {
                let _ = data_app.emit(&data_event, text);
            },
            move |status: &str, message: Option<String>| {
                crate::session::report_session_status(&app, &session_id, status, message)
            },
        );
    });
}

/// Connection attempt with an overall time limit. libssh2 timeouts cover waiting for the
/// network, not every step (e.g. key handling in the crypto backend); if the attempt does not
/// finish, the tab gets an error instead of staying in "connecting" forever. The abandoned
/// attempt ends on its own; its result is dropped.
fn connect_with_deadline(config: SshConnectionConfig) -> Result<ssh2::Session, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(ssh_connect_raw(&config));
    });
    let limit = std::time::Duration::from_millis(u64::from(HANDSHAKE_TIMEOUT_MS) * 2 + 10_000);
    rx.recv_timeout(limit).unwrap_or_else(|_| {
        Err(tr!(
            "Przekroczono czas logowania ({} s) – serwer lub obsługa klucza nie odpowiada.",
            "Login timed out ({} s) – the server or key handling does not respond.",
            limit.as_secs()
        ))
    })
}

/// The terminal session loop: connects, starts the shell and moves data until the session ends.
/// `emit` sends terminal output to the UI, `set_status` reports connecting/connected/error/
/// disconnected (separate from Tauri so it can be tested).
fn run_ssh_worker(
    config: SshConnectionConfig,
    cmd_rx: Receiver<SshWorkerCommand>,
    emit: impl Fn(String),
    set_status: impl Fn(&str, Option<String>),
) {
    {
        let emit_error = |msg: String| {
            // Multi-line messages (e.g. the algorithm diagnosis) need CR+LF in the terminal
            let msg = msg.replace("\r\n", "\n").replace('\n', "\r\n");
            let formatted = tr!("\r\n\x1b[1;31m[RemoteFlow Błąd SSH]\x1b[0m {}\r\n", "\r\n\x1b[1;31m[RemoteFlow SSH error]\x1b[0m {}\r\n", msg);
            emit(formatted);
        };

        let sess = match connect_with_deadline(config) {
            Ok(s) => s,
            Err(e) => {
                emit_error(e.clone());
                set_status("error", Some(e));
                return;
            }
        };

        let fail = |msg: String| {
            emit_error(msg.clone());
            set_status("error", Some(msg));
        };

        // 4. Request PTY & Shell
        let mut channel = match sess.channel_session() {
            Ok(c) => c,
            Err(e) => return fail(tr!("Błąd otwierania kanału SSH: {}", "Error opening the SSH channel: {}", e)),
        };
        if let Err(e) = channel.request_pty("xterm-256color", None, Some((100, 30, 0, 0))) {
            return fail(tr!("Błąd żądania PTY: {}", "PTY request error: {}", e));
        }
        if let Err(e) = channel.shell() {
            return fail(tr!("Błąd uruchamiania powłoki: {}", "Error starting the shell: {}", e));
        }
        set_status("connected", None);

        // Blocking mode with a short timeout: a read waits at most 30 ms for data, a write sends
        // what fits into the channel window and returns how much it sent.
        sess.set_blocking(true);
        sess.set_timeout(30);
        sess.set_keepalive(false, 15);

        // 5. Main bidirectional loop
        let mut last_keepalive = std::time::Instant::now();
        let mut buffer = [0u8; 4096];
        // Bytes of a UTF-8 character split between two reads (e.g. "ż" = 2 bytes)
        let mut utf8_pending: Vec<u8> = Vec::new();
        // Input not yet accepted by the channel (large paste, full window, slow link). Kept
        // until it is sent – previously `write_all` hit the 30 ms timeout and the rest was lost.
        let mut outgoing: std::collections::VecDeque<u8> = std::collections::VecDeque::new();
        const MAX_OUTGOING: usize = 16 * 1024 * 1024;

        let is_timeout = |e: &std::io::Error| matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock);
        let lost_connection = |e: &dyn std::fmt::Display| {
            let err_str = e.to_string();
            if err_str.contains("transport read")
                || err_str.contains("Broken pipe")
                || err_str.contains("Connection reset")
                || err_str.contains("WSAECONNRESET")
            {
                tr!(
                    "Połączenie SSH zostało zakończone przez serwer zdalny lub nastąpiła utrata łączności sieciowej.",
                    "The SSH connection was closed by the remote server or the network connection was lost."
                )
                .to_string()
            } else {
                tr!("Błąd kanału SSH: {}", "SSH channel error: {}", err_str)
            }
        };

        // Returns false when the session must end (Close / UI gone).
        let handle_cmd = |cmd: SshWorkerCommand, outgoing: &mut std::collections::VecDeque<u8>, channel: &mut ssh2::Channel, sess: &ssh2::Session| -> bool {
            match cmd {
                SshWorkerCommand::Input(data) => {
                    if outgoing.len() + data.len() <= MAX_OUTGOING {
                        outgoing.extend(data);
                    } else {
                        emit_error(tr!(
                            "Wklejany tekst jest zbyt duży (ponad 16 MB oczekuje na wysłanie) – pominięto.",
                            "The pasted text is too large (over 16 MB waiting to be sent) – skipped."
                        ).to_string());
                    }
                    true
                }
                SshWorkerCommand::Resize(cols, rows) => {
                    let _ = channel.request_pty_size(cols, rows, None, None);
                    true
                }
                SshWorkerCommand::Cwd(reply) => {
                    // A short extra channel on this connection; the terminal pauses for its
                    // duration (usually well under a second). Longer timeout than the 30 ms reads.
                    sess.set_timeout(8000);
                    let result = crate::session::terminal_cwd::query(sess);
                    sess.set_timeout(30);
                    let _ = reply.send(result);
                    true
                }
                SshWorkerCommand::Close => {
                    let _ = channel.close();
                    false
                }
            }
        };

        loop {
            // Periodic keepalive through NAT / firewalls – not while input is being sent (the data
            // keeps the connection alive anyway and no other packet is squeezed in between)
            if last_keepalive.elapsed() >= std::time::Duration::from_secs(5) && outgoing.is_empty() {
                let _ = sess.keepalive_send();
                last_keepalive = std::time::Instant::now();
            }

            // Commands from the UI (keystrokes, resize, close)
            loop {
                match cmd_rx.try_recv() {
                    Ok(cmd) => {
                        if !handle_cmd(cmd, &mut outgoing, &mut channel, &sess) {
                            return;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        let _ = channel.close();
                        return;
                    }
                }
            }

            // Send pending input – whatever the channel accepts now; the rest stays queued
            if !outgoing.is_empty() {
                let (front, _) = outgoing.as_slices();
                let chunk = &front[..front.len().min(32 * 1024)];
                match channel.write(chunk) {
                    Ok(n) => {
                        outgoing.drain(..n);
                    }
                    Err(ref e) if is_timeout(e) => {}
                    Err(e) => {
                        let msg = lost_connection(&e);
                        emit_error(msg.clone());
                        set_status("error", Some(msg));
                        break;
                    }
                }
            }

            // Read output from remote SSH channel
            match channel.read(&mut buffer) {
                Ok(0) => {
                    // EOF - remote server closed session
                    emit(tr!("\r\n\x1b[33m[Sesja SSH została zakończona przez serwer zdalny]\x1b[0m\r\n", "\r\n\x1b[33m[The SSH session was closed by the remote server]\x1b[0m\r\n").to_string());
                    set_status("disconnected", Some(tr!("Sesja zakończona przez serwer", "Session closed by the server").to_string()));
                    break;
                }
                Ok(n) => {
                    // Terminal queries (DA, cursor position, colour queries) are answered by xterm.js
                    // itself – answering them here too sent a second, wrong reply that showed up
                    // as stray text (e.g. "1;2c", "24;80R") and reported a dark background in the
                    // light theme.
                    utf8_pending.extend_from_slice(&buffer[..n]);
                    let text = take_utf8(&mut utf8_pending);
                    if !text.is_empty() {
                        emit(text);
                    }
                }
                Err(ref e) if is_timeout(e) => {
                    // Nothing from the server: wait briefly for user input (unless input is queued)
                    if outgoing.is_empty() {
                        match cmd_rx.recv_timeout(std::time::Duration::from_millis(15)) {
                            Ok(cmd) => {
                                if !handle_cmd(cmd, &mut outgoing, &mut channel, &sess) {
                                    return;
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                let _ = channel.close();
                                return;
                            }
                        }
                    }
                }
                Err(e) => {
                    let msg = lost_connection(&e);
                    emit_error(msg.clone());
                    set_status("error", Some(msg));
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod handshake_timeout_tests {
    use super::*;
    use crate::vault::known_hosts::HostTrust;

    #[test]
    fn selected_auth_method_requires_its_own_material() {
        let mut cfg = SshConnectionConfig {
            auth_type: "key".into(), certificate: None, host: "localhost".into(), port: 22,
            username: "user".into(), password: Some("must not fall back".into()), private_key: None,
            passphrase: None, host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
        };
        assert!(validate_auth(&cfg).is_err());
        cfg.private_key = Some("private key".into());
        assert!(validate_auth(&cfg).is_ok());
        cfg.auth_type = "certificate".into();
        assert!(validate_auth(&cfg).is_err());
        cfg.certificate = Some("ssh-ed25519-cert-v01@openssh.com AAAA comment".into());
        assert!(validate_auth(&cfg).is_ok());
        cfg.auth_type = "unknown".into();
        assert!(validate_auth(&cfg).is_err());
    }

    /// A server that accepts TCP but never speaks SSH must not block the thread forever.
    #[test]
    fn silent_server_times_out() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _keep: Vec<_> = l.incoming().take(1).collect(); // accept and stay silent
            std::thread::sleep(std::time::Duration::from_secs(10));
        });
        let cfg = SshConnectionConfig {
            auth_type: "password".into(),
            certificate: None,
            host: "127.0.0.1".into(),
            port,
            username: "x".into(),
            password: Some("x".into()),
            private_key: None,
            passphrase: None,
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
        };
        let t0 = std::time::Instant::now();
        assert!(ssh_connect_raw(&cfg).is_err());
        assert!(t0.elapsed() < std::time::Duration::from_secs(5), "{:?}", t0.elapsed());
    }

    #[test]
    fn ipv6_loopback_is_resolved() {
        let l = match std::net::TcpListener::bind("[::1]:0") {
            Ok(l) => l,
            Err(_) => return, // no IPv6 on this machine
        };
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _keep: Vec<_> = l.incoming().take(1).collect();
            std::thread::sleep(std::time::Duration::from_secs(5));
        });
        let cfg = SshConnectionConfig {
            auth_type: "password".into(),
            certificate: None,
            host: "::1".into(),
            port,
            username: "x".into(),
            password: None,
            private_key: None,
            passphrase: None,
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
        };
        // TCP connects (then the silent server makes the handshake fail) – not "cannot connect"
        let err = ssh_connect_raw(&cfg).err().expect("must fail");
        assert!(err.contains("Handshake") || err.contains("handshake"), "{}", err);
    }
}

#[cfg(test)]
mod worker_e2e {
    use super::*;
    use crate::vault::known_hosts::HostTrust;
    use std::sync::Mutex;

    fn cfg(password: &str) -> SshConnectionConfig {
        SshConnectionConfig {
            auth_type: "password".into(),
            certificate: None,
            host: "127.0.0.1".into(),
            port: 2222,
            username: "rftest".into(),
            password: Some(password.into()),
            private_key: None,
            passphrase: None,
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
        }
    }

    fn start(password: &str) -> (std::sync::mpsc::Sender<SshWorkerCommand>, Arc<Mutex<String>>, Arc<Mutex<Vec<String>>>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let out = Arc::new(Mutex::new(String::new()));
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let (o, st) = (out.clone(), statuses.clone());
        let c = cfg(password);
        std::thread::spawn(move || {
            run_ssh_worker(c, rx, move |t| o.lock().unwrap().push_str(&t), move |s, _| st.lock().unwrap().push(s.to_string()))
        });
        (tx, out, statuses)
    }

    fn wait_for(cond: impl Fn() -> bool, secs: u64) -> bool {
        let t0 = std::time::Instant::now();
        while t0.elapsed() < std::time::Duration::from_secs(secs) {
            if cond() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    /// A 3 MB paste arrives completely (previously `write_all` with the 30 ms timeout dropped the
    /// rest), and the state is reported only after login.
    #[test]
    #[ignore]
    fn large_paste_is_not_lost_and_status_is_reported() {
        let target = "/tmp/rf-paste-test.txt";
        let _ = std::fs::remove_file(target);
        let (tx, out, statuses) = start("Test-Pass-123");
        assert!(wait_for(|| statuses.lock().unwrap().contains(&"connected".to_string()), 15));
        // The reader starts late, so the channel window fills up and writes have to wait.
        // Raw mode: no line editing (and no terminal bell flood when the input queue is full).
        tx.send(SshWorkerCommand::Input(
            format!("stty raw -echo; sleep 1; head -c 3000000 > {}; stty sane; echo DONE-$((40+2))\n", target).into_bytes(),
        ))
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let line = format!("{}\n", "x".repeat(99));
        let paste = line.repeat(30_000); // 3 000 000 bytes
        tx.send(SshWorkerCommand::Input(paste.into_bytes())).unwrap();
        assert!(wait_for(|| out.lock().unwrap().contains("DONE-42"), 90), "paste did not finish");
        assert_eq!(std::fs::metadata(target).unwrap().len(), 3_000_000);
        tx.send(SshWorkerCommand::Close).unwrap();
        let _ = std::fs::remove_file(target);
        assert_eq!(statuses.lock().unwrap().first().map(String::as_str), Some("connected"));
    }

    /// "Directory from the terminal": the deepest shell of THIS connection is found, also in a
    /// nested shell and while a program runs in the foreground; nothing is typed into the terminal.
    #[test]
    #[ignore]
    fn terminal_cwd_follows_cd_and_nested_shells() {
        let (tx, out, statuses) = start("Test-Pass-123");
        assert!(wait_for(|| statuses.lock().unwrap().contains(&"connected".to_string()), 15));
        let cwd = |tx: &std::sync::mpsc::Sender<SshWorkerCommand>| {
            let (rtx, rrx) = std::sync::mpsc::channel();
            tx.send(SshWorkerCommand::Cwd(rtx)).unwrap();
            rrx.recv_timeout(std::time::Duration::from_secs(15)).unwrap()
        };
        tx.send(SshWorkerCommand::Input(b"cd /usr/share; echo STEP-$((1+1))\n".to_vec())).unwrap();
        assert!(wait_for(|| out.lock().unwrap().contains("STEP-2"), 10));
        let before = out.lock().unwrap().len();
        assert_eq!(cwd(&tx).unwrap().path, "/usr/share");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(out.lock().unwrap().len(), before, "nothing appears in the terminal");
        // nested shell with its own directory, and a foreground program in it
        tx.send(SshWorkerCommand::Input(b"bash --norc\n".to_vec())).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        tx.send(SshWorkerCommand::Input(b"cd /etc; echo STEP-$((2+1)); sleep 30\n".to_vec())).unwrap();
        assert!(wait_for(|| out.lock().unwrap().contains("STEP-3"), 10));
        assert_eq!(cwd(&tx).unwrap().path, "/etc");
        // a second connection in another directory does not mix in
        let (tx2, out2, st2) = start("Test-Pass-123");
        assert!(wait_for(|| st2.lock().unwrap().contains(&"connected".to_string()), 15));
        tx2.send(SshWorkerCommand::Input(b"cd /var; echo STEP-$((3+1))\n".to_vec())).unwrap();
        assert!(wait_for(|| out2.lock().unwrap().contains("STEP-4"), 10));
        assert_eq!(cwd(&tx2).unwrap().path, "/var");
        assert_eq!(cwd(&tx).unwrap().path, "/etc");
        tx.send(SshWorkerCommand::Close).unwrap();
        tx2.send(SshWorkerCommand::Close).unwrap();
    }

    #[test]
    #[ignore]
    fn wrong_password_reports_error() {
        let (_tx, _out, statuses) = start("wrong-password");
        assert!(wait_for(|| statuses.lock().unwrap().contains(&"error".to_string()), 30));
        assert!(!statuses.lock().unwrap().contains(&"connected".to_string()));
    }
}

#[cfg(test)]
mod utf8_tests {
    use super::*;

    #[test]
    fn split_characters_are_joined() {
        let bytes = "zażółć".as_bytes();
        let mut pending = Vec::new();
        let mut out = String::new();
        for chunk in bytes.chunks(1) {
            pending.extend_from_slice(chunk);
            out.push_str(&take_utf8(&mut pending));
        }
        assert_eq!(out, "zażółć");
        assert!(pending.is_empty());
    }

    #[test]
    fn invalid_bytes_do_not_block_output() {
        let mut pending = vec![b'a', 0xff, b'b', 0xC5];
        let out = take_utf8(&mut pending);
        assert_eq!(out, "a\u{fffd}b");
        assert_eq!(pending, vec![0xC5]);
        pending.push(0xBC);
        assert_eq!(take_utf8(&mut pending), "ż");
    }
}

#[cfg(test)]
mod key_file_tests {
    use super::*;

    #[test]
    fn temp_key_file_is_wiped_and_swept() {
        let tmp = TempKeyFile::create(b"-----BEGIN KEY-----secret").unwrap();
        let path = tmp.path().to_path_buf();
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        drop(tmp);
        assert!(!path.exists());

        // A file left behind by a crash is removed at the next start
        let stale = key_tmp_dir().join("rf_ssh_stale-test.tmp");
        std::fs::write(&stale, b"secret").unwrap();
        sweep_stale_key_files();
        assert!(!stale.exists());
    }
}

/// Needs a local sshd on 127.0.0.1:2222 with user `rftest` whose authorized_keys contains
/// /tmp/k/id_rsa.pub (PEM, no passphrase) and /tmp/k/id_ed.pub (OpenSSH, passphrase `kp-123`).
#[cfg(test)]
mod key_auth_e2e {
    use super::*;

    fn cfg(key: String, passphrase: Option<&str>) -> SshConnectionConfig {
        SshConnectionConfig {
            auth_type: "key".into(),
            certificate: None,
            host: "127.0.0.1".into(),
            port: 2222,
            username: "rftest".into(),
            password: None,
            private_key: Some(key),
            passphrase: passphrase.map(|s| s.to_string()),
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
        }
    }

    #[test]
    #[ignore]
    fn key_from_memory_and_from_path() {
        let pem = std::fs::read_to_string("/tmp/k/id_rsa").unwrap();
        assert!(ssh_connect_raw(&cfg(pem, None)).unwrap().authenticated());
        assert!(ssh_connect_raw(&cfg("/tmp/k/id_rsa".into(), None)).unwrap().authenticated());
        let ed = std::fs::read_to_string("/tmp/k/id_ed").unwrap();
        assert!(ssh_connect_raw(&cfg(ed, Some("kp-123"))).unwrap().authenticated());
        assert!(ssh_connect_raw(&cfg("/tmp/k/id_ed".into(), Some("kp-123"))).unwrap().authenticated());
        assert!(ssh_connect_raw(&cfg("/tmp/k/id_ed".into(), Some("wrong"))).is_err());
    }
}

/// Needs a local sshd on 127.0.0.1:2222 with user `rftest` whose authorized_keys contains the
/// public keys from /tmp/keytest (generated with the passphrase `Klucz-123`).
#[cfg(test)]
mod passphrase_key_tests {
    use super::*;
    use crate::vault::known_hosts::HostTrust;

    #[test]
    #[ignore]
    fn passphrase_protected_keys_from_memory() {
        for name in ["ed", "rsa_openssh", "rsa_pem", "ecdsa", "ec384", "rsa_pkcs8"] {
            let key = std::fs::read_to_string(format!("/tmp/keytest/{name}")).unwrap();
            for (label, pass) in [("good", "Klucz-123"), ("bad", "wrong")] {
                let cfg = SshConnectionConfig {
                    auth_type: "key".into(), certificate: None, host: "127.0.0.1".into(), port: 2222,
                    username: "rftest".into(), password: None, private_key: Some(key.clone()),
                    passphrase: Some(pass.into()), host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
                };
                let t0 = std::time::Instant::now();
                let r = ssh_connect_raw(&cfg);
                eprintln!("{name} {label}: {:?} in {:?}", r.as_ref().map(|_| "OK").map_err(|e| e.clone()), t0.elapsed());
                assert_eq!(r.is_ok(), label == "good", "{name} {label}");
            }
        }
    }

    /// Certificate login with a passphrase-protected OpenSSH-format Ed25519 key (signing callback
    /// with the certificate blob). Needs sshd on 127.0.0.1:2223 with `TrustedUserCAKeys` and
    /// /tmp/certtest/user (passphrase `Klucz-123`) + user-cert.pub signed by that CA.
    #[test]
    #[ignore]
    fn certificate_with_passphrase_protected_openssh_key() {
        let cfg = SshConnectionConfig {
            auth_type: "certificate".into(),
            certificate: Some(std::fs::read_to_string("/tmp/certtest/user-cert.pub").unwrap()),
            host: "127.0.0.1".into(), port: 2223, username: "rftest".into(), password: None,
            private_key: Some(std::fs::read_to_string("/tmp/certtest/user").unwrap()),
            passphrase: Some("Klucz-123".into()), host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
        };
        assert!(ssh_connect_raw(&cfg).unwrap().authenticated());
    }
}
