//! Import from OpenSSH (`~/.ssh/config`), PuTTY and WinSCP (Import / Export window).
//!
//! A scan returns what was found (without passwords); the import then takes the chosen entries
//! by key. Passwords read from WinSCP stay in the backend (in memory, between the two calls) and
//! are encrypted with the vault key – they never pass through the user interface.

use super::*;
use crate::vault::importers::{self, ImportCandidate};
use crate::vault::models::{Connection, Group};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
    pub scan_id: String,
    /// File or registry key that was read (for the window).
    pub location: String,
    pub candidates: Vec<ImportCandidate>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub connections: usize,
    pub groups: usize,
    pub passwords: usize,
}

/// Recent scans (scan id → candidates); only a few are kept.
static SCANS: std::sync::LazyLock<Mutex<Vec<(String, Vec<ImportCandidate>)>>> = std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// Forgets scanned passwords (vault locked).
pub fn forget_scans() {
    if let Ok(mut s) = SCANS.lock() {
        s.clear();
    }
}

const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;

fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(path).map_err(|e| tr!("Nie można odczytać '{}': {}", "Cannot read '{}': {}", path.display(), e))?;
    if !meta.is_file() || meta.len() > MAX_SOURCE_BYTES {
        return Err(tr!("'{}' nie jest plikiem konfiguracji", "'{}' is not a configuration file", path.display()));
    }
    std::fs::read(path).map_err(|e| tr!("Nie można odczytać '{}': {}", "Cannot read '{}': {}", path.display(), e))
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `reg export <key>` to a temporary file (Windows); the .reg text, or None when the key does
/// not exist.
#[cfg(target_os = "windows")]
fn reg_export(key: &str) -> Option<String> {
    let dir = dirs::data_local_dir()?.join("RemoteFlow").join("import-tmp");
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join(format!("{}.reg", uuid::Uuid::new_v4()));
    let file_s = file.to_string_lossy().to_string();
    let ok = crate::session::winproc::hidden_command("reg.exe")
        .args(["export", key, file_s.as_str(), "/y"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let text = ok.then(|| std::fs::read(&file).ok()).flatten().map(|b| importers::decode_reg_bytes(&b));
    // May hold WinSCP passwords (obfuscated) – overwritten before it is deleted
    if let Ok(meta) = std::fs::metadata(&file) {
        let _ = std::fs::write(&file, vec![0u8; meta.len() as usize]);
    }
    let _ = std::fs::remove_file(&file);
    text
}

#[cfg(not(target_os = "windows"))]
fn reg_export(_key: &str) -> Option<String> {
    None
}

fn scan_ssh_config(path: &Path) -> Result<(Vec<ImportCandidate>, Vec<String>), String> {
    let text = String::from_utf8_lossy(&read_limited(path)?).into_owned();
    let home_dir = home();
    let ssh_dir = path.parent().map(Path::to_path_buf).unwrap_or_else(|| home_dir.join(".ssh"));
    let home_s = home_dir.to_string_lossy().to_string();
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    let load = |p: &str| -> Option<String> { read_limited(Path::new(p)).ok().map(|b| String::from_utf8_lossy(&b).into_owned()) };
    let expand = |pattern: &str| -> Vec<String> {
        let p = if let Some(rest) = pattern.strip_prefix("~/") { home_dir.join(rest) } else { PathBuf::from(pattern) };
        // Relative Include paths are relative to ~/.ssh
        let p = if p.is_absolute() { p } else { ssh_dir.join(p) };
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !name.contains(['*', '?']) {
            return vec![p.to_string_lossy().to_string()];
        }
        let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
        let re_match = |n: &str| {
            let (pre, post) = name.split_once('*').unwrap_or((&name, ""));
            n.starts_with(pre) && n.ends_with(post) && !n.starts_with('.')
        };
        let mut files: Vec<String> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_file() && re_match(&e.file_name().to_string_lossy()))
            .map(|e| e.path().to_string_lossy().to_string())
            .collect();
        files.sort();
        files.truncate(200);
        files
    };
    let env = importers::ssh_config::Env { home: &home_s, local_user: &user, load: &load, expand: &expand };
    Ok(importers::ssh_config::parse(&text, &env))
}

fn scan_putty(path: Option<&Path>) -> Result<(Vec<ImportCandidate>, String), String> {
    if let Some(p) = path {
        let text = importers::decode_reg_bytes(&read_limited(p)?);
        return Ok((importers::putty::from_reg(&text), p.display().to_string()));
    }
    const KEY: &str = "HKCU\\Software\\SimonTatham\\PuTTY\\Sessions";
    if cfg!(target_os = "windows") {
        let text = reg_export(KEY).ok_or_else(|| tr!("Nie znaleziono zapisanych sesji PuTTY.", "No saved PuTTY sessions were found.").to_string())?;
        return Ok((importers::putty::from_reg(&text), KEY.to_string()));
    }
    // PuTTY on Linux / macOS: one file per session
    let dir = home().join(".putty").join("sessions");
    let entries = std::fs::read_dir(&dir).map_err(|_| {
        tr!("Nie znaleziono zapisanych sesji PuTTY ({}).", "No saved PuTTY sessions were found ({}).", dir.display())
    })?;
    let mut out = Vec::new();
    for e in entries.flatten().take(5000) {
        if let Ok(bytes) = read_limited(&e.path()) {
            out.extend(importers::putty::from_session_file(&e.file_name().to_string_lossy(), &String::from_utf8_lossy(&bytes)));
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok((out, dir.display().to_string()))
}

fn scan_winscp(path: Option<&Path>) -> Result<(Vec<ImportCandidate>, Vec<String>, String), String> {
    let sections = |text: &str| if text.contains("Windows Registry Editor") || text.starts_with("REGEDIT") { importers::parse_reg(text) } else { importers::parse_ini(text) };
    if let Some(p) = path {
        let text = importers::decode_reg_bytes(&read_limited(p)?);
        let (c, w) = importers::winscp::from_sections(sections(&text));
        return Ok((c, w, p.display().to_string()));
    }
    const KEY: &str = "HKCU\\Software\\Martin Prikryl\\WinSCP 2";
    if let Some(text) = reg_export(KEY) {
        let (c, w) = importers::winscp::from_sections(importers::parse_reg(&text));
        if !c.is_empty() {
            return Ok((c, w, KEY.to_string()));
        }
    }
    // WinSCP.ini in the roaming profile (or chosen by the user)
    let ini = dirs::config_dir().map(|d| d.join("WinSCP.ini"));
    match ini.filter(|p| p.is_file()) {
        Some(p) => {
            let text = importers::decode_reg_bytes(&read_limited(&p)?);
            let (c, w) = importers::winscp::from_sections(importers::parse_ini(&text));
            Ok((c, w, p.display().to_string()))
        }
        None => Err(tr!(
            "Nie znaleziono zapisanych witryn WinSCP – wskaż plik WinSCP.ini albo plik .reg.",
            "No saved WinSCP sites were found – choose the WinSCP.ini file or a .reg file."
        )
        .to_string()),
    }
}

/// Reads the connections of another program. `source`: "ssh_config" | "putty" | "winscp";
/// `pick`: choose the file in the system dialog instead of the default location.
#[tauri::command]
pub async fn import_scan(source: String, pick: bool, state: tauri::State<'_, AuthState>) -> Result<Option<ImportScan>, String> {
    let saved: Vec<Connection> = {
        let mgr = lock_auth(&state)?;
        let key = mgr.unlocked_key()?;
        load_vault_verified(key)?.connections
    };
    let result = tokio::task::spawn_blocking(move || -> Result<Option<ImportScan>, String> {
        let picked = if pick {
            let title = match source.as_str() {
                "ssh_config" => tr!("Wybierz plik konfiguracji OpenSSH", "Choose the OpenSSH configuration file"),
                "putty" => tr!("Wybierz plik .reg z sesjami PuTTY", "Choose the .reg file with PuTTY sessions"),
                _ => tr!("Wybierz WinSCP.ini albo plik .reg", "Choose WinSCP.ini or a .reg file"),
            };
            match crate::session::pick_file_dialog(Some(title.to_string()))? {
                Some(p) => Some(PathBuf::from(p)),
                None => return Ok(None),
            }
        } else {
            None
        };
        let (mut candidates, warnings, location) = match source.as_str() {
            "ssh_config" => {
                let path = picked.unwrap_or_else(|| home().join(".ssh").join("config"));
                if !path.is_file() {
                    return Err(tr!("Nie znaleziono pliku {}.", "File {} was not found.", path.display()));
                }
                let (c, w) = scan_ssh_config(&path)?;
                (c, w, path.display().to_string())
            }
            "putty" => {
                let (c, l) = scan_putty(picked.as_deref())?;
                (c, Vec::new(), l)
            }
            "winscp" => scan_winscp(picked.as_deref())?,
            other => return Err(format!("unknown source {other}")),
        };
        for c in candidates.iter_mut() {
            c.exists = saved.iter().any(|s| {
                s.protocol == c.protocol && s.host.eq_ignore_ascii_case(&c.host) && s.port == c.port && s.username == c.username
            });
            if let Some(k) = &c.key_file {
                let p = Path::new(k);
                if p.is_absolute() && !p.exists() {
                    c.notes.push("key-missing".into());
                }
            }
        }
        if candidates.len() > 5000 {
            candidates.truncate(5000);
        }
        let scan_id = uuid::Uuid::new_v4().to_string();
        if let Ok(mut scans) = SCANS.lock() {
            scans.push((scan_id.clone(), candidates.clone()));
            let excess = scans.len().saturating_sub(3);
            scans.drain(..excess);
        }
        Ok(Some(ImportScan { scan_id, location, candidates, warnings }))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

/// Imports the chosen entries of a scan (their jump hosts come along). `group_id`: existing
/// folder; `new_group`: name of a new top-level folder (takes precedence); neither = top level.
#[tauri::command]
pub fn import_apply(
    scan_id: String,
    keys: Vec<String>,
    group_id: Option<String>,
    new_group: Option<String>,
    state: tauri::State<'_, AuthState>,
) -> Result<ImportResult, String> {
    let candidates = SCANS
        .lock()
        .ok()
        .and_then(|s| s.iter().find(|(id, _)| *id == scan_id).map(|(_, c)| c.clone()))
        .ok_or_else(|| tr!("Lista do importu wygasła – wczytaj ją ponownie.", "The import list has expired – read it again.").to_string())?;
    let by_key: HashMap<&str, &ImportCandidate> = candidates.iter().map(|c| (c.key.as_str(), c)).collect();

    // Chosen entries plus every jump host they need
    let mut chosen: Vec<&ImportCandidate> = Vec::new();
    let mut queue: Vec<&str> = keys.iter().map(String::as_str).collect();
    while let Some(k) = queue.pop() {
        let Some(c) = by_key.get(k) else { continue };
        if chosen.iter().any(|x| x.key == c.key) {
            continue;
        }
        chosen.push(c);
        if let Some(j) = &c.jump {
            queue.push(j);
        }
    }
    if chosen.is_empty() {
        return Err(tr!("Nie wybrano żadnego połączenia", "No connection was chosen").into());
    }

    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let now = chrono::Utc::now().to_rfc3339();
    let new_id = |prefix: &str| format!("{}-{}", prefix, &uuid::Uuid::new_v4().simple().to_string()[..10]);

    update_vault(key, |v| {
        let mut groups_added = 0usize;
        let base: Option<String> = match new_group.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(name) => {
                let g = Group { id: new_id("group"), name: name.to_string(), parent_id: None, icon: None, color: None };
                let id = g.id.clone();
                v.groups.push(g);
                groups_added += 1;
                Some(id)
            }
            None => group_id.filter(|id| v.groups.iter().any(|g| &g.id == id)),
        };
        // Subfolders from the source (WinSCP), reused when they already exist
        let folder_id = |v: &mut crate::vault::models::VaultData, path: &[String], groups_added: &mut usize| -> Option<String> {
            let mut parent = base.clone();
            for name in path {
                let existing = v.groups.iter().find(|g| g.parent_id == parent && g.name == *name).map(|g| g.id.clone());
                parent = Some(match existing {
                    Some(id) => id,
                    None => {
                        let g = Group { id: new_id("group"), name: name.clone(), parent_id: parent.clone(), icon: None, color: None };
                        let id = g.id.clone();
                        v.groups.push(g);
                        *groups_added += 1;
                        id
                    }
                });
            }
            parent
        };

        // Jump hosts that already exist in the vault are used instead of a second copy
        let mut ids: HashMap<String, String> = HashMap::new();
        for c in &chosen {
            let reuse = (c.implicit && c.exists)
                .then(|| {
                    v.connections
                        .iter()
                        .find(|s| s.protocol == c.protocol && s.host.eq_ignore_ascii_case(&c.host) && s.port == c.port && s.username == c.username)
                        .map(|s| s.id.clone())
                })
                .flatten();
            ids.insert(c.key.clone(), reuse.unwrap_or_else(|| new_id("conn")));
        }

        let mut added = 0usize;
        let mut passwords = 0usize;
        for c in &chosen {
            let id = ids[&c.key].clone();
            if v.connections.iter().any(|s| s.id == id) {
                continue; // reused jump host
            }
            let group = folder_id(v, &c.folder, &mut groups_added);
            let mut conn = Connection {
                id,
                name: c.name.clone(),
                group_id: group,
                credential_id: None,
                protocol: c.protocol.clone(),
                host: c.host.clone(),
                port: c.port,
                username: c.username.clone(),
                password_encrypted: c.password.as_ref().filter(|p| !p.is_empty()).map(|p| p.to_string()),
                ssh_auth_type: if c.key_file.is_some() { "key".into() } else { "password".into() },
                private_key_encrypted: None,
                private_key_passphrase_encrypted: None,
                certificate_content: None,
                key_file_path: c.key_file.clone(),
                certificate_file_path: None,
                prompt_key_passphrase: None,
                jump_host_id: c.jump.as_ref().and_then(|j| ids.get(j).cloned()),
                port_forwarding: c.forwards.clone(),
                rdp_settings: None,
                tags: Vec::new(),
                notes: None,
                default_download_dir: None,
                sftp_local_dir: None,
                sftp_remote_dir: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            if conn.password_encrypted.is_some() {
                passwords += 1;
            }
            seal_connection(key, &mut conn, false)?;
            v.connections.push(conn);
            added += 1;
        }
        Ok(ImportResult { connections: added, groups: groups_added, passwords })
    })
}
