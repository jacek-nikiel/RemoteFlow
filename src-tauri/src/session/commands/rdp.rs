//! RDP: external client, server certificate (TOFU), shared exchange folder and files for the
//! remote clipboard.

use crate::auth::{lock_auth, AuthState};
use crate::session::*;
use crate::vault::known_hosts;
use crate::vault::storage::load_vault_verified;
use serde::Serialize;

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
