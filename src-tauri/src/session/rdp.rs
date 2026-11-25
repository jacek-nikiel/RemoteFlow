use crate::vault::models::RdpSettings;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc::Receiver;
use tauri::{AppHandle, Emitter};

pub struct RdpConnectionConfig {
    pub connection_id: String,
    pub certificate_fingerprint: Option<String>,
    pub title: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub domain: Option<String>,
    pub rdp_settings: Option<RdpSettings>,
    /// Linux/X11: draw the session inside this native window of RemoteFlow (FreeRDP
    /// `/parent-window`) instead of a separate window.
    pub embed: Option<EmbedTarget>,
}

/// The password is wiped from memory when the config is dropped.
impl Drop for RdpConnectionConfig {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        if let Some(p) = &mut self.password {
            p.zeroize();
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EmbedTarget {
    /// X11 window id of the container window
    pub parent_xid: u64,
    /// initial size in device pixels
    pub width: u32,
    pub height: u32,
}

/// Splits the RDP login into the account name and the domain the way Windows does.
///
/// Accepted forms (the domain field of the connection is optional):
/// - `jan` + domain `CORP`            → `jan` / `CORP`
/// - `CORP\jan` (domain field ignored) → `jan` / `CORP`
/// - `jan@corp.local` (UPN)            → `jan@corp.local` / no domain (the UPN already identifies the domain)
/// - `.\jan` or domain `.`             → `jan` / no domain (local account of the target machine)
///
/// IronRDP (sspi) rejects a user name containing `\` or `@` when a separate domain is also given
/// ("invalid username"), so the two must never be sent together.
pub fn normalize_rdp_identity(username: &str, domain: Option<&str>) -> (String, Option<String>) {
    let user = username.trim();
    let mut dom = domain.map(str::trim).filter(|d| !d.is_empty()).map(str::to_string);

    let (user, from_user) = match user.split_once('\\') {
        Some((d, u)) => (u.trim().to_string(), Some(d.trim().to_string())),
        None => (user.to_string(), None),
    };
    if let Some(d) = from_user {
        // The domain typed together with the user name wins over the separate field
        dom = Some(d).filter(|d| !d.is_empty());
    } else if user.contains('@') {
        // User principal name – it already carries the domain
        dom = None;
    }
    // "." means the local machine: no domain for NTLM/CredSSP
    if dom.as_deref() == Some(".") {
        dom = None;
    }
    // A domain may be entered as NetBIOS (CORP) or DNS name (corp.local); both are accepted by Windows.
    // Characters that can never appear in it are dropped instead of failing the whole login.
    let dom = dom.map(|d| d.replace(['\\', '@'], "")).filter(|d| !d.is_empty());
    (user, dom)
}

/// Login shown to the user / passed to clients that expect a single string (`DOMAIN\user` or UPN).
pub fn display_rdp_login(username: &str, domain: Option<&str>) -> String {
    match domain {
        Some(d) if !d.is_empty() => format!("{}\\{}", d, username),
        _ => username.to_string(),
    }
}

/// Minimal .rdp file for mstsc: address + pre-filled user name (no password).
fn write_mstsc_rdp_file(session_id: &str, host: &str, port: u16, login: &str, clipboard: bool) -> std::io::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join("RemoteFlow").join("mstsc");
    std::fs::create_dir_all(&dir)?;
    let safe_id: String = session_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let path = dir.join(format!("{}.rdp", safe_id));
    let clean = |v: &str| v.replace(['\r', '\n'], "");
    let mut content = format!("full address:s:{}\r\n", crate::session::host_port(&clean(host), port));
    if !login.is_empty() {
        content.push_str(&format!("username:s:{}\r\n", clean(login)));
    }
    content.push_str("prompt for credentials:i:1\r\n");
    // Clipboard as in the connection's RDP settings; local drives are never shared with the server
    content.push_str(&format!("redirectclipboard:i:{}\r\n", u8::from(clipboard)));
    content.push_str("redirectdrives:i:0\r\ndrivestoredirect:s:\r\n");
    std::fs::write(&path, content)?;
    Ok(path)
}

pub fn spawn_rdp_session(
    session_id: String,
    config: RdpConnectionConfig,
    kill_rx: Receiver<()>,
    app: AppHandle,
) {
    std::thread::spawn(move || {
        let sid = session_id.clone();
        let emit_log = |msg: String| {
            let _ = app.emit(&format!("rdp-data-{}", sid), msg);
        };

        emit_log(tr!(
            "▶ Inicjalizacja połączenia RDP do {}:{} (użytkownik: {})...", "▶ Starting the RDP connection to {}:{} (user: {})...",
            config.host, config.port, config.username
        ));

        // Locate available RDP binary on the system
        let binary_candidates = if config.embed.is_some() {
            // Only the X11 client can draw into another (X11) window
            vec!["xfreerdp3", "xfreerdp"]
        } else if cfg!(target_os = "windows") {
            vec!["mstsc.exe", "mstsc"]
        } else if cfg!(target_os = "macos") {
            vec!["xfreerdp3", "xfreerdp", "open"]
        } else {
            // Linux: prioritize modern FreeRDP 3 then FreeRDP 2
            vec!["xfreerdp3", "wlfreerdp3", "sdl-freerdp3", "xfreerdp", "wlfreerdp", "remmina"]
        };

        let mut found_binary: Option<String> = None;
        if cfg!(target_os = "windows") {
            let system_mstsc = std::path::Path::new(r"C:\Windows\System32\mstsc.exe");
            if system_mstsc.exists() {
                found_binary = Some(system_mstsc.to_string_lossy().to_string());
            } else {
                for bin in &binary_candidates {
                    if let Ok(output) = crate::session::winproc_where(bin) {
                        if output.status.success() {
                            found_binary = Some(bin.to_string());
                            break;
                        }
                    }
                }
            }
        } else {
            for bin in &binary_candidates {
                if let Ok(output) = Command::new("which").arg(bin).output() {
                    if output.status.success() {
                        found_binary = Some(bin.to_string());
                        break;
                    }
                }
            }
        }

        let binary = match found_binary {
            Some(b) => b,
            None => {
                emit_log(tr!("❌ Błąd: Nie znaleziono zainstalowanego klienta RDP (FreeRDP) w systemie.", "❌ Error: no installed RDP client (FreeRDP) was found.").to_string());
                emit_log(tr!("ℹ️ Wskazówka: Zainstaluj pakiet poleceniem:", "ℹ️ Tip: install the package with:").to_string());
                emit_log("   Arch/CachyOS: sudo pacman -S freerdp".to_string());
                emit_log(tr!("   Debian/Ubuntu: sudo apt install freerdp3-x11 (lub freerdp2-x11)", "   Debian/Ubuntu: sudo apt install freerdp3-x11 (or freerdp2-x11)").to_string());
                emit_log("   Fedora: sudo dnf install freerdp".to_string());
                let _ = app.emit(&format!("rdp-status-{}", sid), "error");
                return;
            }
        };

        emit_log(tr!("✓ Wykryto klienta RDP: {}", "✓ RDP client found: {}", binary));

        let mut cmd = Command::new(&binary);
        // FreeRDP drawing inside the RemoteFlow window cannot outlive it: if RemoteFlow ends
        // without closing the tab (crash, kill), the kernel ends FreeRDP too. The spawning thread
        // waits for the process for its whole life, so the signal is tied to the right thread.
        #[cfg(target_os = "linux")]
        if config.embed.is_some() {
            use std::os::unix::process::CommandExt;
            // SAFETY: prctl is async-signal-safe; nothing else runs between fork and exec.
            unsafe {
                cmd.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    Ok(())
                });
            }
        }

        let (rdp_user, rdp_domain) = normalize_rdp_identity(&config.username, config.domain.as_deref());
        let mut stdin_password: Option<String> = None;

        if binary.contains("freerdp") {
            cmd.arg(format!("/v:{}", crate::session::host_port(&config.host, config.port)));
            if !rdp_user.is_empty() {
                cmd.arg(format!("/u:{}", rdp_user));
            }
            // The password is never put on the command line (visible to every user via `ps`,
            // /proc/<pid>/cmdline). FreeRDP 2 and 3 read it from stdin with /from-stdin:force
            // ("Password:" prompt before connecting); it is written to the pipe after spawn.
            stdin_password = Some(config.password.clone().unwrap_or_default());
            cmd.arg("/from-stdin:force");
            if let Some(dom) = &rdp_domain {
                cmd.arg(format!("/d:{}", dom));
            }
            if let Some(embed) = &config.embed {
                cmd.arg(format!("/parent-window:{}", embed.parent_xid));
                cmd.arg(format!("/size:{}x{}", embed.width.max(320), embed.height.max(240)));
            } else {
                cmd.arg(format!("/t:RemoteFlow - {} ({}:{})", config.title, config.host, config.port));
            }
            // Trust-on-first-use instead of blindly accepting any certificate (MITM protection).
            // The server identity lives in the vault (shared with the embedded client): on the
            // first connection the certificate is read here and remembered, so FreeRDP is pinned
            // to it from the start instead of keeping its own, separate TOFU store.
            let mut pinned = config.certificate_fingerprint.clone();
            if pinned.is_none() {
                match tauri::async_runtime::block_on(crate::session::rdp_proxy::probe_certificate(&config.host, config.port)) {
                    Ok(fingerprint) => {
                        let verifier = crate::session::make_host_verifier(&app, "rdp", config.host.clone(), config.port);
                        match (verifier.0)(&fingerprint) {
                            Ok(_) => {
                                emit_log(tr!(
                                    "🔐 Zapamiętano certyfikat serwera RDP (pierwsze połączenie): {}",
                                    "🔐 RDP server certificate remembered (first connection): {}",
                                    fingerprint
                                ));
                                pinned = Some(fingerprint);
                            }
                            Err(e) => {
                                emit_log(e);
                                let _ = app.emit(&format!("rdp-status-{}", sid), "error");
                                return;
                            }
                        }
                    }
                    // Unreachable server etc. – FreeRDP reports the problem itself
                    Err(e) => emit_log(tr!(
                        "⚠️ Nie udało się wcześniej odczytać certyfikatu serwera ({}). FreeRDP sprawdzi go samodzielnie (TOFU).",
                        "⚠️ Could not read the server certificate in advance ({}). FreeRDP will check it itself (TOFU).",
                        e
                    )),
                }
            }
            match pinned.as_deref().map(freerdp_certificate_arg).transpose() {
                Ok(Some(arg)) => { cmd.arg(arg); }
                Ok(None) => { cmd.arg("/cert:tofu"); }
                Err(e) => {
                    emit_log(e);
                    let _ = app.emit(&format!("rdp-status-{}", sid), "error");
                    return;
                }
            }
            // "Clipboard" in the connection's RDP settings (default on)
            let clipboard = config.rdp_settings.as_ref().is_none_or(|s| s.clipboard);
            if !clipboard {
                cmd.arg("-clipboard");
            } else if binary.contains("freerdp3") {
                cmd.arg("/clipboard:direction-to:all,files-to:all");
            } else {
                cmd.arg("+clipboard");
            }
            cmd.arg("+dynamic-resolution");
            // Graphics pipeline (RemoteFX progressive / H.264 when the server and the FreeRDP build
            // support it) and automatic bandwidth detection – much faster than the legacy bitmap
            // updates, especially when large parts of the screen change.
            cmd.arg("/gfx");
            cmd.arg("/network:auto");

            // Only the dedicated exchange folder is shared with the remote session (visible in Windows
            // Explorer as "RemoteFlow on <hostname>" / \\tsclient\RemoteFlow). The home folder is NOT
            // shared – the server would get read/write access to all personal files (SSH keys, the vault…).
            match crate::session::shared_exchange_dir() {
                Ok(shared_dir) => {
                    cmd.arg(format!("/drive:RemoteFlow,{}", shared_dir.to_string_lossy()));
                }
                Err(e) => eprintln!("[RemoteFlow RDP] Folder wymiany niedostępny: {}", e),
            }

            if let Some(settings) = &config.rdp_settings {
                if settings.sound {
                    cmd.arg("/sound:sys:pulse");
                }
                if config.embed.is_none() && settings.width > 0 && settings.height > 0 && !binary.contains("wlfreerdp") {
                    cmd.arg(format!("/size:{}x{}", settings.width, settings.height));
                }
            }
        } else if binary.contains("mstsc") {
            // mstsc has no command line switch for the user name: a temporary .rdp file pre-fills
            // DOMAIN\user in the login prompt (the password is never written to disk).
            let clipboard = config.rdp_settings.as_ref().is_none_or(|s| s.clipboard);
            match write_mstsc_rdp_file(&sid, &config.host, config.port, &display_rdp_login(&rdp_user, rdp_domain.as_deref()), clipboard) {
                Ok(path) => {
                    cmd.arg(&path);
                    let cleanup = path.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        let _ = std::fs::remove_file(cleanup);
                    });
                }
                Err(e) => {
                    emit_log(tr!("⚠️ Nie udało się przygotować pliku .rdp ({}), użytkownik nie zostanie podpowiedziany.", "⚠️ Could not prepare the .rdp file ({}), the user name will not be pre-filled.", e));
                    cmd.arg(format!("/v:{}", crate::session::host_port(&config.host, config.port)));
                }
            }
        }

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(if stdin_password.is_some() { Stdio::piped() } else { Stdio::null() });

        let mut child = match cmd.spawn() {
            Ok(c) => {
                if config.embed.is_some() {
                    crate::session::rdp_embed::register_process(&sid, c.id());
                }
                emit_log(tr!("⚡ Uruchomiono natywne okno sesji RDP (PID: {}).", "⚡ Native RDP session window started (PID: {}).", c.id()));
                let _ = app.emit(&format!("rdp-status-{}", sid), "connected");
                c
            }
            Err(e) => {
                emit_log(tr!("❌ Błąd uruchamiania procesu RDP: {}", "❌ Error starting the RDP process: {}", e));
                let _ = app.emit(&format!("rdp-status-{}", sid), "error");
                return;
            }
        };

        // Hand the password to FreeRDP through the pipe, then close it (EOF on any further prompt)
        if let (Some(password), Some(mut stdin)) = (stdin_password.take(), child.stdin.take()) {
            std::thread::spawn(move || {
                use std::io::Write;
                let mut line = zeroize::Zeroizing::new(password.into_bytes());
                line.push(b'\n');
                let _ = stdin.write_all(&line);
                let _ = stdin.flush();
            });
        }

        // Pipe stdout to frontend
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let sid_stdout = sid.clone();
        let app_stdout = app.clone();

        if let Some(out) = stdout {
            std::thread::spawn(move || {
                let reader = BufReader::new(out);
                for line in reader.lines().flatten() {
                    let _ = app_stdout.emit(&format!("rdp-data-{}", sid_stdout), line);
                }
            });
        }

        // Pipe stderr to frontend
        let sid_stderr = sid.clone();
        let app_stderr = app.clone();
        let certificate_event = RdpCertificateError {
            session_id: sid.clone(), connection_id: config.connection_id.clone(),
            embedded: config.embed.is_some(),
        };
        if let Some(err) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(err);
                let mut reported = false;
                for line in reader.lines().flatten() {
                    if !reported && is_certificate_error(&line) {
                        reported = true;
                        let _ = app_stderr.emit("rdp-certificate-error", certificate_event.clone());
                        let _ = app_stderr.emit(&format!("rdp-status-{}", sid_stderr), "error");
                    }
                    let _ = app_stderr.emit(&format!("rdp-data-{}", sid_stderr), line);
                }
            });
        }

        // Wait loop: either child process exits or user closes tab (kill_rx)
        loop {
            // Check if user closed tab in RemoteFlow
            if let Ok(()) = kill_rx.try_recv() {
                emit_log(tr!("⏹ Zamykanie procesu RDP na żądanie użytkownika...", "⏹ Closing the RDP process at the user's request...").to_string());
                let _ = child.kill();
                let _ = child.wait();
                return;
            }

            // Check if RDP process exited on its own
            match child.try_wait() {
                Ok(Some(status)) => {
                    emit_log(tr!("ℹ️ Okno sesji RDP zostało zamknięte (kod: {}).", "ℹ️ The RDP session window was closed (code: {}).", status));
                    let normal = if binary.contains("freerdp") {
                        freerdp_ended_normally(status.code())
                    } else {
                        status.success()
                    };
                    let _ = app.emit(&format!("rdp-status-{}", sid), if normal { "disconnected" } else { "error" });
                    return;
                }
                Ok(None) => {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                }
                Err(e) => {
                    emit_log(tr!("⚠️ Błąd monitorowania procesu RDP: {}", "⚠️ Error monitoring the RDP process: {}", e));
                    return;
                }
            }
        }
    });
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RdpCertificateError {
    session_id: String,
    connection_id: String,
    embedded: bool,
}

/// FreeRDP exit codes of a session that simply ended (xfreerdp `XF_EXIT_*`): 0 success,
/// 1 disconnect, 2 logoff, 3 idle timeout, 4 logon timeout, 5 connection replaced by another
/// session, 11/12 disconnect / logoff by the user. Everything else (e.g. 131 connection failed,
/// 132 authentication failure, 143 TLS / certificate failure, a signal) is an error.
fn freerdp_ended_normally(code: Option<i32>) -> bool {
    matches!(code, Some(0..=5) | Some(11) | Some(12))
}

fn is_certificate_error(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("certificate not trusted") || lower.contains("tls_print_certificate_error")
        || lower.contains("remote host identification has changed") || lower.contains("certificate for") && lower.contains("has changed")
}

fn freerdp_certificate_arg(fingerprint: &str) -> Result<String, String> {
    use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
    let digest = fingerprint.strip_prefix("SHA256:").and_then(|s| STANDARD_NO_PAD.decode(s).ok())
        .filter(|d| d.len() == 32).ok_or_else(|| tr!("Nieprawidłowy odcisk SHA-256 certyfikatu RDP zapisany w sejfie", "Invalid RDP certificate SHA-256 fingerprint stored in the vault").to_string())?;
    // FreeRDP 2 requires colon-separated bytes; FreeRDP 3 accepts both forms.
    let hex = digest.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(":");
    // A fingerprint allow-list alone still falls back to CA validation / the shared cache on
    // mismatch. Use a fresh verification name so that only the explicitly pinned certificate
    // can pass; no previously cached identity or valid certificate for the real host can win.
    let name = format!("rf-{}.{}.invalid", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    Ok(format!("/cert:deny,name:{},fingerprint:sha256:{}", name, hex))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freerdp_logoff_is_not_an_error() {
        for code in [0, 1, 2, 3, 4, 5, 11, 12] {
            assert!(freerdp_ended_normally(Some(code)), "{code}");
        }
        for code in [6, 7, 131, 132, 143] {
            assert!(!freerdp_ended_normally(Some(code)), "{code}");
        }
        assert!(!freerdp_ended_normally(None), "killed by a signal");
    }

    #[test]
    fn certificate_errors_are_distinguished_from_other_tls_errors() {
        assert!(is_certificate_error("[ERROR][com.freerdp.crypto] - [tls_print_certificate_error]: The fingerprint for the host key sent by the remote host is ca:23"));
        assert!(is_certificate_error("certificate not trusted, aborting."));
        assert!(!is_certificate_error("ERRCONNECT_TLS_CONNECT_FAILED"));
    }

    #[test]
    fn explicit_freerdp_pin_is_validated_and_does_not_disable_verification() {
        let fingerprint = crate::vault::cipher::sha256_fingerprint(b"certificate");
        let arg = freerdp_certificate_arg(&fingerprint).unwrap();
        assert!(arg.starts_with("/cert:deny,name:rf-"));
        assert!(arg.contains(".invalid,fingerprint:sha256:"));
        assert_ne!(arg, freerdp_certificate_arg(&fingerprint).unwrap(), "each launch isolates cache and name validation");
        let hex = arg.split_once("fingerprint:sha256:").unwrap().1;
        assert_eq!(hex.split(':').count(), 32);
        assert!(hex.split(':').all(|byte| byte.len() == 2 && byte.chars().all(|c| c.is_ascii_hexdigit())));
        assert!(freerdp_certificate_arg("SHA256:AAAA").is_err());
        assert!(freerdp_certificate_arg("ignore").is_err());
    }

    fn n(u: &str, d: Option<&str>) -> (String, Option<String>) {
        normalize_rdp_identity(u, d)
    }

    #[test]
    fn domain_field_only() {
        assert_eq!(n("jan", Some("CORP")), ("jan".into(), Some("CORP".into())));
        assert_eq!(n(" jan ", Some(" corp.local ")), ("jan".into(), Some("corp.local".into())));
        assert_eq!(n("jan", Some("")), ("jan".into(), None));
        assert_eq!(n("jan", None), ("jan".into(), None));
    }

    #[test]
    fn down_level_name_in_username() {
        assert_eq!(n("CORP\\jan", None), ("jan".into(), Some("CORP".into())));
        // Same domain in both places (typical mRemoteNG import) – no duplicate, no error
        assert_eq!(n("CORP\\jan", Some("CORP")), ("jan".into(), Some("CORP".into())));
        // The user name prefix wins over a different domain field
        assert_eq!(n("OTHER\\jan", Some("CORP")), ("jan".into(), Some("OTHER".into())));
    }

    #[test]
    fn upn_and_local_accounts() {
        assert_eq!(n("jan@corp.local", Some("CORP")), ("jan@corp.local".into(), None));
        assert_eq!(n(".\\administrator", Some("CORP")), ("administrator".into(), None));
        assert_eq!(n("administrator", Some(".")), ("administrator".into(), None));
        assert_eq!(n("\\jan", Some("CORP")), ("jan".into(), None));
    }

    #[test]
    fn display_login() {
        assert_eq!(display_rdp_login("jan", Some("CORP")), "CORP\\jan");
        assert_eq!(display_rdp_login("jan@corp.local", None), "jan@corp.local");
    }
}
