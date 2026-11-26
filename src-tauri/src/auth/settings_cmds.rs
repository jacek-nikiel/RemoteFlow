//! Settings kept in the vault: trusted hosts, interface settings, backups.

use crate::vault::models::{KnownHostEntry, VaultStatus, BackupEntry, BackupSettings, SavedWorkspace, UiSettings};
use crate::vault::backup;
use crate::vault::storage::{load_vault, load_vault_verified, update_vault};
use super::*;

#[tauri::command]
pub fn vault_list_known_hosts(state: tauri::State<'_, AuthState>) -> Result<Vec<KnownHostEntry>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let vault = load_vault_verified(key)?;
    crate::vault::known_hosts::remember_verified(&vault.metadata.known_hosts);
    Ok(vault
        .metadata
        .known_hosts
        .into_iter()
        .map(|(id, fingerprint)| KnownHostEntry { id, fingerprint })
        .collect())
}

#[tauri::command]
pub fn vault_forget_known_host(id: String, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        v.metadata.known_hosts.remove(&id);
        crate::vault::known_hosts::remember_verified(&v.metadata.known_hosts);
        Ok(())
    })
}


// ---------------------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn vault_get_ui_settings(state: tauri::State<'_, AuthState>) -> Result<UiSettings, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    Ok(load_vault_verified(key)?.metadata.ui)
}

#[tauri::command]
pub fn vault_set_ui_settings(settings: UiSettings, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?.clone();
    drop(mgr);
    let mut settings = settings;
    settings.terminal_scrollback = settings.terminal_scrollback.clamp(
        crate::vault::models::MIN_TERMINAL_SCROLLBACK,
        crate::vault::models::MAX_TERMINAL_SCROLLBACK,
    );
    update_vault(&key, |v| {
        // Turning "Restore previous sessions" off also forgets the saved tabs
        if !settings.restore_sessions {
            v.metadata.saved_workspace = None;
        }
        v.metadata.ui = settings;
        Ok(())
    })
}

/// Tabs saved for "Restore previous sessions" (None when the option is off or nothing is saved).
#[tauri::command]
pub fn vault_get_saved_workspace(state: tauri::State<'_, AuthState>) -> Result<Option<SavedWorkspace>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let data = load_vault_verified(key)?;
    Ok(if data.metadata.ui.restore_sessions { data.metadata.saved_workspace } else { None })
}

/// Saves the open tabs (only while "Restore previous sessions" is on; an unchanged state is
/// not written again).
#[tauri::command]
pub fn vault_set_saved_workspace(workspace: Option<SavedWorkspace>, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?.clone();
    drop(mgr);
    let workspace = workspace.map(SavedWorkspace::sanitized).filter(|w| !w.tabs.is_empty());
    let current = load_vault_verified(&key)?;
    if !current.metadata.ui.restore_sessions || current.metadata.saved_workspace == workspace {
        return Ok(());
    }
    update_vault(&key, |v| {
        v.metadata.saved_workspace = workspace;
        Ok(())
    })
}

#[tauri::command]
pub fn vault_get_backup_settings(state: tauri::State<'_, AuthState>) -> Result<BackupSettings, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    Ok(load_vault_verified(key)?.metadata.backup)
}

#[tauri::command]
pub fn vault_set_backup_settings(settings: BackupSettings, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mut settings = settings;
    if settings.interval_hours == 0 || settings.interval_hours > backup::MAX_INTERVAL_HOURS {
        return Err(tr!("Interwał kopii musi wynosić od 1 do {} godzin", "The backup interval must be between 1 and {} hours", backup::MAX_INTERVAL_HOURS));
    }
    if settings.keep == 0 || settings.keep > backup::MAX_KEEP {
        return Err(tr!("Liczba przechowywanych kopii musi wynosić od 1 do {}", "The number of kept backups must be between 1 and {}", backup::MAX_KEEP));
    }
    settings.dir = settings.dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if let Some(dir) = &settings.dir {
        let path = std::path::Path::new(dir);
        if !path.is_absolute() {
            return Err(tr!("Katalog kopii zapasowych musi być ścieżką bezwzględną", "The backup folder must be an absolute path").to_string());
        }
    }

    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    if let Some(dir) = &settings.dir {
        // Only once the vault is unlocked; owner-only like the default backup folder
        crate::vault::storage::create_private_dir(std::path::Path::new(dir))
            .map_err(|e| tr!("Nie można utworzyć katalogu kopii: {}", "Cannot create the backup folder: {}", e))?;
    }
    update_vault(key, |v| {
        v.metadata.backup = settings;
        Ok(())
    })
}

#[tauri::command]
pub fn vault_backup_now(state: tauri::State<'_, AuthState>) -> Result<String, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let settings = load_vault_verified(key)?.metadata.backup;
    let path = backup::create_backup(&settings, "manual", false)?
        .ok_or_else(|| tr!("Brak pliku sejfu do skopiowania", "No vault file to back up").to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn vault_list_backups(state: tauri::State<'_, AuthState>) -> Result<Vec<BackupEntry>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let settings = load_vault_verified(key)?.metadata.backup;
    Ok(backup::list_backups(&settings))
}

/// Restores a backup and locks the application – the restored vault must be unlocked with the
/// Master Password that was valid when the backup was taken.
#[tauri::command]
pub fn vault_restore_backup(name: String, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    let mut mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let settings = load_vault_verified(key)?.metadata.backup;
    backup::restore_backup(&settings, &name)?;
    crate::vault::known_hosts::forget_verified();
    mgr.clear();
    let vault = load_vault()?;
    Ok(build_status(vault.as_ref(), &mgr, None))
}
