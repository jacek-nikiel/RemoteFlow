//! Two-pane SFTP window: listing, transfers, folders and files on both sides, file preview/editor.

use crate::auth::AuthState;
use crate::session::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

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

// --- Rename / move / permissions (see fileops.rs) ----------------------------------------------

/// Renames a file or folder on the server; returns the new path.
#[tauri::command]
pub async fn sftp_rename(
    connection_id: String,
    path: String,
    new_name: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| fileops::remote_rename(sftp, &path, &new_name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves files / folders into another folder on the server; returns how many were moved.
#[tauri::command]
pub async fn sftp_move(
    connection_id: String,
    paths: Vec<String>,
    target_dir: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| fileops::remote_move(sftp, &paths, &target_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Changes permissions on the server (`scope`: "all" | "files" | "dirs" for the contents of
/// folders when `recursive`); returns how many entries were changed.
#[tauri::command]
pub async fn sftp_chmod(
    connection_id: String,
    paths: Vec<String>,
    mode: u32,
    recursive: bool,
    scope: String,
    auth_state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<u32, String> {
    if mode > 0o7777 {
        return Err(tr!("Nieprawidłowe uprawnienia", "Invalid permissions").to_string());
    }
    let config = resolve_connection_ssh_config(&connection_id, &auth_state, &app)?;
    let scope = fileops::ChmodScope::parse(&scope);
    tokio::task::spawn_blocking(move || {
        transfer::with_pooled_sftp(&connection_id, &config, |sftp| fileops::remote_chmod(sftp, &paths, mode, recursive, scope))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Renames a local file or folder; returns the new path.
#[tauri::command]
pub async fn local_rename(path: String, new_name: String, auth_state: tauri::State<'_, AuthState>) -> Result<String, String> {
    let access = localfs::local_access(&auth_state)?;
    let target = fileops::local_rename_target(&path, &new_name)?;
    // The old name disappears like a delete; the new one must not land among protected files
    access.check_delete(&path)?;
    access.check(&target)?;
    tokio::task::spawn_blocking(move || fileops::local_rename(&path, &target))
        .await
        .map_err(|e| e.to_string())?
}

/// Moves local files / folders into another folder; returns how many were moved.
#[tauri::command]
pub async fn local_move(paths: Vec<String>, target_dir: String, auth_state: tauri::State<'_, AuthState>) -> Result<u32, String> {
    let access = localfs::local_access(&auth_state)?;
    let moves = fileops::local_move_targets(&paths, &target_dir)?;
    for (from, to) in &moves {
        access.check_delete(from)?;
        access.check(to)?;
    }
    tokio::task::spawn_blocking(move || fileops::local_move(&moves))
        .await
        .map_err(|e| e.to_string())?
}
