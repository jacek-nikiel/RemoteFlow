#[macro_use]
pub mod i18n;
pub mod display;
pub mod auth;
pub mod oslock;
pub mod session;
pub mod vault;
pub mod install;

use auth::{
    vault_batch_import, vault_change_master_password, vault_delete_connection,
    vault_delete_credential, vault_delete_group, vault_export, vault_get_credentials,
    vault_get_data, vault_get_path, vault_get_status, vault_import,
    vault_backup_now, vault_forget_known_host, vault_touch_activity, vault_get_backup_settings, vault_get_ui_settings, vault_set_ui_settings, vault_get_saved_workspace, vault_set_saved_workspace, vault_init, vault_list_backups,
    vault_restore_backup, vault_set_backup_settings, vault_list_known_hosts, vault_lock, vault_lock_to_pin, vault_reset, vault_reveal_credential_password,
    vault_reveal_password, vault_save_connection, vault_save_credential, vault_save_group,
    vault_set_connection_sftp_dirs, vault_set_pin,
    vault_unlock_master, vault_unlock_pin, vault_update_security_settings, AuthManager,
};
use session::{
    app_exit, app_maximize_window, clipboard_read_files, clipboard_read_text, clipboard_write_secret, clipboard_write_text,
    local_list_dir, open_shared_folder, pick_local_folder, pick_private_key_file, save_file_as, pick_ssh_certificate_file,
    read_local_paths_for_rdp_clipboard, save_dropped_file_to_shared, session_close,
    session_connect, session_launch_external_rdp, session_rdp_password, session_resize,
    session_send_input, sftp_list, sftp_transfer_cancel, SessionManager,
};
use session::clipstage::{clipboard_sequence, rdp_clip_stage_begin, rdp_clip_stage_commit, rdp_clip_stage_dir, rdp_clip_stage_file};
use vault::mremoteng::mremoteng_unlock;
use session::{local_delete_paths, local_mkdir, local_search, sftp_delete_paths, sftp_mkdir, sftp_release, sftp_search, sftp_transfer_download, sftp_transfer_upload};
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let auth_state = Mutex::new(AuthManager::new());
    let session_state = Mutex::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Updates from GitHub Releases, verified with the public key in tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(auth_state)
        .manage(session_state)
        .setup(|app| {
            vault::backup::start_scheduler();
            // Previous program file left by a portable update
            install::cleanup_after_update();
            // Private-key files left by a crash in the Windows fallback are wiped
            std::thread::spawn(session::ssh::sweep_stale_key_files);
            oslock::start_monitor(app.handle().clone());
            session::rdp_embed::init();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_get_status,
            vault_get_path,
            vault_init,
            vault_unlock_master,
            vault_lock,
            vault_lock_to_pin,
            vault_unlock_pin,
            vault_set_pin,
            vault_change_master_password,
            vault_reset,
            vault_update_security_settings,
            vault_get_data,
            vault_set_connection_sftp_dirs,
            display::display_get_settings,
            display::display_set_safe_rendering,
            vault_reveal_password,
            vault_save_connection,
            auth::vault_set_connection_password,
            session::connection_password_status,
            vault_delete_connection,
            auth::vault_clone_connection,
            vault_save_group,
            vault_delete_group,
            vault_get_credentials,
            vault_save_credential,
            vault_delete_credential,
            vault_reveal_credential_password,
            vault_export,
            vault_import,
            vault_batch_import,
            vault_list_known_hosts,
            vault_forget_known_host,
            vault_touch_activity,
            vault_get_backup_settings,
            vault_get_ui_settings,
            vault_set_ui_settings,
            vault_get_saved_workspace,
            vault_set_saved_workspace,
            vault_set_backup_settings,
            vault_backup_now,
            vault_list_backups,
            vault_restore_backup,
            session_rdp_password,
            session_connect,
            session_send_input,
            session_resize,
            session_close,
            session_launch_external_rdp,
            session::ssh_terminal_cwd,
            session::get_session_tunnels,
            session::rdp_certificate_preview,
            session::rdp_certificate_trust,
            session::rdp_embed::rdp_embed_start,
            session::rdp_embed::rdp_embed_update,
            session::rdp_embed::rdp_embed_stop,
            session::rdp_embed::rdp_embed_release_focus,
            display::display_set_rdp_freerdp_embedded,
            sftp_list,
            sftp_transfer_cancel,
            open_shared_folder,
            save_dropped_file_to_shared,
            clipboard_read_text,
            clipboard_write_text,
            clipboard_write_secret,
            clipboard_read_files,
            local_list_dir,
            pick_local_folder,
            save_file_as,
            pick_private_key_file,
            pick_ssh_certificate_file,
            read_local_paths_for_rdp_clipboard,
            session::read_local_file_bytes,
            app_exit,
            install::app_install_info,
            install::portable_update_check,
            install::portable_update_install,
            i18n::app_set_language,
            app_maximize_window,
            rdp_clip_stage_begin,
            rdp_clip_stage_dir,
            rdp_clip_stage_file,
            rdp_clip_stage_commit,
            clipboard_sequence,
            mremoteng_unlock,
            sftp_mkdir,
            sftp_delete_paths,
            sftp_search,
            sftp_transfer_upload,
            sftp_transfer_download,
            sftp_release,
            local_mkdir,
            local_delete_paths,
            session::sftp_mkfile,
            session::local_mkfile,
            session::adhoc::adhoc_connection_create,
            session::adhoc::adhoc_connection_forget,
            session::sftp_rename,
            session::sftp_move,
            session::sftp_chmod,
            session::local_rename,
            session::local_move,
            session::preview_stat,
            session::preview_read,
            session::preview_save,
            local_search
        ])
        .run(tauri::generate_context!())
        .expect("Błąd podczas uruchamiania aplikacji Tauri");
}

#[cfg(test)]
mod version_tests {
    /// package.json (shown in the UI), tauri.conf.json (installer) and Cargo.toml must carry the same version.
    #[test]
    fn versions_are_in_sync() {
        let pkg: serde_json::Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(pkg["version"], env!("CARGO_PKG_VERSION"), "package.json ≠ Cargo.toml");
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"), "tauri.conf.json ≠ Cargo.toml");
    }
}
