//! Vault data: connections, groups, credentials (create, edit, delete, reveal passwords).

use crate::vault::cipher::{decrypt_opt, encrypt_string};
use crate::vault::models::{Connection, Credential, Group, VaultData};
use crate::vault::storage::{load_vault_verified, update_vault};
use zeroize::Zeroizing;
use super::*;

#[tauri::command]
pub fn vault_get_data(state: tauri::State<'_, AuthState>) -> Result<VaultData, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let mut vault = load_vault_verified(key)?;
    // A folder cycle (older version, imported file) would hide the whole branch in the tree
    crate::vault::models::group_tree::break_cycles(&mut vault.groups);
    // Not needed by the UI.
    vault.mac = None;
    vault.metadata.pin_encrypted_base64 = None;
    Ok(vault)
}

#[tauri::command]
pub fn vault_reveal_password(connection_id: &str, state: tauri::State<'_, AuthState>) -> Result<String, String> {
    vault_reveal_password_impl(connection_id, &state)
}

pub(crate) fn vault_reveal_password_impl(connection_id: &str, state: &AuthState) -> Result<String, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    if crate::session::adhoc::is_adhoc(connection_id) {
        return crate::session::adhoc::get(connection_id)
            .and_then(|(_, password)| password)
            .ok_or_else(|| tr!("Brak zapisanego hasła", "No saved password").to_string());
    }
    let vault = load_vault_verified(key)?;
    let conn = vault
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or(tr!("Nie znaleziono połączenia", "Connection not found"))?;

    if let Some(pwd) = decrypt_opt(key, &conn.password_encrypted)? {
        return Ok(pwd);
    }

    if let Some(cred_id) = &conn.credential_id {
        if let Some(cred) = vault.credentials.iter().find(|c| c.id == *cred_id) {
            if let Some(pwd) = decrypt_opt(key, &cred.password_encrypted)? {
                return Ok(pwd);
            }
        }
    }

    Ok(String::new())
}

#[tauri::command]
pub fn vault_save_connection(connection: Connection, raw_password: Option<String>, raw_private_key: Option<String>, raw_passphrase: Option<String>, state: tauri::State<'_, AuthState>) -> Result<Connection, String> {
    vault_save_connection_impl(connection, raw_password, raw_private_key, raw_passphrase, &state)
}

#[tauri::command]
pub fn vault_set_connection_password(connection_id: String, password: String, state: tauri::State<'_, AuthState>) -> Result<Connection, String> {
    vault_set_connection_password_impl(&connection_id, password, &state)
}

pub(crate) fn vault_set_connection_password_impl(connection_id: &str, password: String, state: &AuthState) -> Result<Connection, String> {
    let password = Zeroizing::new(password);
    if password.is_empty() {
        return Err(tr!("Wprowadź niepuste hasło", "Enter a non-empty password").into());
    }
    let mgr = lock_auth(state)?;
    let key = mgr.unlocked_key()?;
    if crate::session::adhoc::is_adhoc(connection_id) {
        return crate::session::adhoc::set_password(connection_id, &password);
    }
    let encrypted = encrypt_string(key, &password)?;
    update_vault(key, |v| {
        let conn = v.connections.iter_mut().find(|c| c.id == connection_id)
            .ok_or_else(|| tr!("Nie znaleziono połączenia", "Connection not found").to_string())?;
        conn.password_encrypted = Some(encrypted);
        conn.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(conn.clone())
    })
}

pub(crate) fn vault_save_connection_impl(mut connection: Connection, raw_password: Option<String>, raw_private_key: Option<String>, raw_passphrase: Option<String>, state: &AuthState) -> Result<Connection, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;

    seal_raw(key, raw_password, &mut connection.password_encrypted)?;
    seal_raw(key, raw_private_key, &mut connection.private_key_encrypted)?;
    seal_raw(key, raw_passphrase, &mut connection.private_key_passphrase_encrypted)?;

    let now = chrono::Utc::now().to_rfc3339();
    connection.updated_at = now.clone();
    if connection.created_at.is_empty() {
        connection.created_at = now;
    }

    let saved = connection.clone();
    update_vault(key, |v| {
        upsert_by_id(&mut v.connections, connection, |c| c.id.as_str());
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn vault_delete_connection(connection_id: &str, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        v.connections.retain(|c| c.id != connection_id);
        Ok(())
    })
}

#[tauri::command]
pub fn vault_clone_connection(connection_id: &str, state: tauri::State<'_, AuthState>) -> Result<Connection, String> {
    vault_clone_connection_impl(connection_id, &state)
}

pub(crate) fn vault_clone_connection_impl(connection_id: &str, state: &AuthState) -> Result<Connection, String> {
    let mgr = lock_auth(state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        let index = v.connections.iter().position(|c| c.id == connection_id)
            .ok_or_else(|| tr!("Nie znaleziono połączenia", "Connection not found").to_string())?;
        let mut copy = v.connections[index].clone();
        let names: std::collections::HashSet<_> = v.connections.iter().map(|c| c.name.to_lowercase()).collect();
        let label = tr!("kopia", "copy");
        let base = copy.name.clone();
        copy.name = format!("{} ({})", base, label);
        let mut number = 2;
        while names.contains(&copy.name.to_lowercase()) {
            copy.name = format!("{} ({} {})", base, label, number);
            number += 1;
        }
        copy.id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        copy.created_at = now.clone();
        copy.updated_at = now;
        // Secrets already use this vault's key. Copy ciphertext without exposing plaintext
        // to the frontend; the complete new vault is authenticated and encrypted on write.
        v.connections.insert(index + 1, copy.clone());
        Ok(copy)
    })
}

#[tauri::command]
pub fn vault_save_group(group: Group, state: tauri::State<'_, AuthState>) -> Result<Group, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let mut group = group;
    if group.parent_id.as_deref() == Some("") {
        group.parent_id = None;
    }
    let saved = group.clone();
    update_vault(key, |v| {
        if crate::vault::models::group_tree::parent_creates_cycle(&v.groups, &group.id, group.parent_id.as_deref()) {
            return Err(tr!(
                "Folder nie może być umieszczony we własnym podfolderze.",
                "A folder cannot be placed inside its own subfolder."
            )
            .to_string());
        }
        upsert_by_id(&mut v.groups, group, |g| g.id.as_str());
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn vault_delete_group(group_id: &str, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        // Remove the group; its subfolders move up to its parent, its connections become
        // "without a folder" (as before)
        let parent = v.groups.iter().find(|g| g.id == group_id).and_then(|g| g.parent_id.clone());
        v.groups.retain(|g| g.id != group_id);
        for g in v.groups.iter_mut() {
            if g.parent_id.as_deref() == Some(group_id) {
                g.parent_id = parent.clone();
            }
        }
        for conn in v.connections.iter_mut() {
            if conn.group_id.as_deref() == Some(group_id) {
                conn.group_id = None;
            }
        }
        Ok(())
    })
}


#[tauri::command]
pub fn vault_get_credentials(state: tauri::State<'_, AuthState>) -> Result<Vec<Credential>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    Ok(load_vault_verified(key)?.credentials)
}

#[tauri::command]
pub fn vault_save_credential(
    mut credential: Credential,
    raw_password: Option<String>,
    raw_private_key: Option<String>,
    raw_passphrase: Option<String>,
    state: tauri::State<'_, AuthState>,
) -> Result<Credential, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;

    seal_raw(key, raw_password, &mut credential.password_encrypted)?;
    seal_raw(key, raw_private_key, &mut credential.private_key_encrypted)?;
    seal_raw(key, raw_passphrase, &mut credential.private_key_passphrase_encrypted)?;

    let now = chrono::Utc::now().to_rfc3339();
    credential.updated_at = now.clone();
    if credential.created_at.is_empty() {
        credential.created_at = now;
    }

    let saved = credential.clone();
    update_vault(key, |v| {
        upsert_by_id(&mut v.credentials, credential, |c| c.id.as_str());
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn vault_delete_credential(credential_id: &str, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        v.credentials.retain(|c| c.id != credential_id);
        for conn in v.connections.iter_mut() {
            if conn.credential_id.as_deref() == Some(credential_id) {
                conn.credential_id = None;
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn vault_reveal_credential_password(
    credential_id: &str,
    state: tauri::State<'_, AuthState>,
) -> Result<String, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let vault = load_vault_verified(key)?;
    let cred = vault
        .credentials
        .iter()
        .find(|c| c.id == credential_id)
        .ok_or(tr!("Nie znaleziono poświadczenia", "Credential not found"))?;
    Ok(decrypt_opt(key, &cred.password_encrypted)?.unwrap_or_default())
}

/// Saves (or clears with `None`) the SFTP start folders of one connection.
#[tauri::command]
pub fn vault_set_connection_sftp_dirs(
    connection_id: String,
    local_dir: Option<String>,
    remote_dir: Option<String>,
    state: tauri::State<'_, AuthState>,
) -> Result<(), String> {
    let clean = |d: Option<String>| d.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        let conn = v
            .connections
            .iter_mut()
            .find(|c| c.id == connection_id)
            .ok_or(tr!("Nie znaleziono połączenia", "Connection not found"))?;
        conn.sftp_local_dir = clean(local_dir);
        conn.sftp_remote_dir = clean(remote_dir);
        if conn.protocol == "ssh" {
            // The legacy SFTP folder is replaced by the new fields.
            conn.default_download_dir = None;
        }
        conn.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    })
}
