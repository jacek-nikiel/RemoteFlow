//! Quick Connect: connections typed in the command palette (e.g. `ssh root@10.0.0.15:2222`)
//! that are not saved in the vault. They live only in memory – with the password, if one was
//! given – until the tab is closed, the vault is locked with the Master Password or the
//! application exits. Everything else (host keys, RDP certificates, sessions, SFTP) works as for
//! saved connections; `resolve_connection` takes them from here instead of the vault.

use crate::vault::models::Connection;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use zeroize::Zeroizing;

pub const PREFIX: &str = "adhoc-";

struct Entry {
    conn: Connection,
    password: Option<Zeroizing<String>>,
}

static ADHOC: LazyLock<Mutex<HashMap<String, Entry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn is_adhoc(id: &str) -> bool {
    id.starts_with(PREFIX)
}

/// Connection and password of a quick connection.
pub fn get(id: &str) -> Option<(Connection, Option<String>)> {
    let map = ADHOC.lock().ok()?;
    map.get(id).map(|e| (e.conn.clone(), e.password.as_ref().map(|p| p.to_string())))
}

/// Password typed later (empty-password prompt); kept in memory only.
pub fn set_password(id: &str, password: &str) -> Result<Connection, String> {
    let mut map = ADHOC.lock().map_err(|_| "lock".to_string())?;
    let e = map.get_mut(id).ok_or_else(|| tr!("Nie znaleziono połączenia", "Connection not found").to_string())?;
    e.password = Some(Zeroizing::new(password.to_string()));
    Ok(e.conn.clone())
}

/// Forgets every quick connection (vault locked with the Master Password, vault reset).
pub fn clear() {
    if let Ok(mut map) = ADHOC.lock() {
        map.clear();
    }
}

fn build(protocol: &str, host: &str, port: u16, username: &str, ssh_auth_type: &str) -> Result<Connection, String> {
    let protocol = protocol.trim().to_lowercase();
    if protocol != "ssh" && protocol != "rdp" {
        return Err(tr!("Nieobsługiwany protokół: {}", "Unsupported protocol: {}", protocol));
    }
    let host = host.trim();
    if host.is_empty() || host.len() > 255 || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(tr!("Nieprawidłowy adres hosta", "Invalid host address").to_string());
    }
    if port == 0 {
        return Err(tr!("Nieprawidłowy port", "Invalid port").to_string());
    }
    let username = username.trim();
    if username.len() > 256 || username.chars().any(|c| c.is_control()) {
        return Err(tr!("Nieprawidłowa nazwa użytkownika", "Invalid user name").to_string());
    }
    let ssh_auth_type = match ssh_auth_type {
        "agent" if protocol == "ssh" => "agent",
        _ => "password",
    };
    let now = chrono::Utc::now().to_rfc3339();
    let name = if username.is_empty() { host.to_string() } else { format!("{}@{}", username, host) };
    Ok(Connection {
        id: format!("{}{}", PREFIX, uuid::Uuid::new_v4()),
        name,
        group_id: None,
        credential_id: None,
        protocol,
        host: host.to_string(),
        port,
        username: username.to_string(),
        password_encrypted: None,
        ssh_auth_type: ssh_auth_type.to_string(),
        private_key_encrypted: None,
        private_key_passphrase_encrypted: None,
        certificate_content: None,
        key_file_path: None,
        certificate_file_path: None,
        prompt_key_passphrase: None,
        port_forwarding: Vec::new(),
        rdp_settings: None,
        tags: Vec::new(),
        notes: None,
        default_download_dir: None,
        sftp_local_dir: None,
        sftp_remote_dir: None,
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Registers a quick connection (vault must be unlocked) and returns it for the new tab.
#[tauri::command]
pub fn adhoc_connection_create(
    protocol: String,
    host: String,
    port: u16,
    username: String,
    ssh_auth_type: String,
    password: Option<String>,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
) -> Result<Connection, String> {
    let password = password.map(Zeroizing::new);
    crate::auth::lock_auth(&auth_state)?.unlocked_key()?;
    let conn = build(&protocol, &host, port, &username, &ssh_auth_type)?;
    let mut map = ADHOC.lock().map_err(|_| "lock".to_string())?;
    if map.len() >= 500 {
        return Err(tr!("Za dużo szybkich połączeń – zamknij nieużywane zakładki", "Too many quick connections – close unused tabs").to_string());
    }
    map.insert(conn.id.clone(), Entry { conn: conn.clone(), password: password.filter(|p| !p.is_empty()) });
    Ok(conn)
}

/// The last tab of a quick connection was closed.
#[tauri::command]
pub fn adhoc_connection_forget(connection_id: String) {
    if let Ok(mut map) = ADHOC.lock() {
        map.remove(&connection_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_validates() {
        let c = build("SSH", " 10.0.0.15 ", 2222, "root", "agent").unwrap();
        assert!(is_adhoc(&c.id));
        assert_eq!((c.protocol.as_str(), c.host.as_str(), c.port, c.name.as_str()), ("ssh", "10.0.0.15", 2222, "root@10.0.0.15"));
        assert_eq!(c.ssh_auth_type, "agent");
        assert_eq!(build("rdp", "srv", 3389, "", "agent").unwrap().ssh_auth_type, "password");
        assert!(build("telnet", "h", 23, "", "password").is_err());
        assert!(build("ssh", "a b", 22, "", "password").is_err());
        assert!(build("ssh", "h", 0, "", "password").is_err());
    }
}
