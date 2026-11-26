//! Remote -> local file clipboard for RDP sessions on Windows.
//!
//! When files are copied inside the remote Windows session (Ctrl+C in Explorer), the frontend
//! downloads them over CLIPRDR into a private staging directory and then places that list on the
//! local Windows clipboard (CF_HDROP). The user can paste them with Ctrl+V in any local Explorer
//! window – no exchange folder is needed. On Linux the existing exchange-folder flow is kept.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Staging directories older than this are removed (unless among the newest few).
const MAX_AGE: Duration = Duration::from_secs(24 * 3600);
const KEEP_NEWEST: usize = 3;

fn staging_root() -> PathBuf {
    // Windows: %TEMP% is per user. Elsewhere /tmp is shared by all users – another user could
    // create the folder first and read the copied files, so the per-user cache folder is used.
    #[cfg(windows)]
    let base = std::env::temp_dir();
    #[cfg(not(windows))]
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    base.join("RemoteFlow").join("rdp-clipboard")
}

/// Percent-decoding of a header value (also used by the RDP exchange commands).
pub(crate) fn percent_decode_pub(s: &str) -> Result<String, String> {
    percent_decode(s)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3).ok_or(tr!("Nieprawidłowe kodowanie nazwy pliku", "Invalid file name encoding"))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| tr!("Nieprawidłowe kodowanie nazwy pliku", "Invalid file name encoding"))?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| tr!("Nazwa pliku nie jest poprawnym UTF-8", "The file name is not valid UTF-8").to_string())
}

/// Converts a relative path from the remote side ("dir\\sub\\file.txt") into a safe relative
/// path. Anything that could escape the staging directory is rejected.
fn sanitize_relative(rel: &str) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    for part in rel.split(['\\', '/']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".."
            || part.contains(':')
            || part.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(format!("Niedozwolona nazwa pliku: {}", rel));
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        return Err("Pusta nazwa pliku".to_string());
    }
    // Defence in depth: only normal components allowed.
    if !out.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(tr!("Niedozwolona ścieżka: {}", "Path not allowed: {}", rel));
    }
    Ok(out)
}

/// Validates that `dir` is one of our staging directories.
fn checked_stage_dir(dir: &str) -> Result<PathBuf, String> {
    let root = staging_root()
        .canonicalize()
        .map_err(|e| tr!("Brak katalogu tymczasowego schowka: {}", "Clipboard staging folder missing: {}", e))?;
    let canonical = Path::new(dir)
        .canonicalize()
        .map_err(|e| tr!("Nieprawidłowy katalog tymczasowy schowka: {}", "Invalid clipboard staging folder: {}", e))?;
    if canonical.parent() != Some(root.as_path()) {
        return Err("Katalog spoza obszaru tymczasowego schowka".to_string());
    }
    // Return the plain path (canonicalize() yields "\\?\C:\..." on Windows, which Explorer
    // does not handle well in clipboard file lists).
    Ok(PathBuf::from(dir))
}

fn cleanup_old(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut dirs: Vec<(PathBuf, SystemTime)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .collect();
    dirs.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, modified) in dirs.into_iter().skip(KEEP_NEWEST) {
        let old = SystemTime::now().duration_since(modified).map(|a| a > MAX_AGE).unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Local clipboard sequence number (Windows). Lets the UI detect that the user copied something
/// new even when the content is identical to the previous copy. `None` on other systems.
#[tauri::command]
pub fn clipboard_sequence() -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        crate::session::winproc::clipboard_sequence()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Creates a fresh staging directory for one remote copy operation and returns its path.
#[tauri::command]
pub fn rdp_clip_stage_begin() -> Result<String, String> {
    let root = staging_root();
    std::fs::create_dir_all(&root).map_err(|e| tr!("Nie można utworzyć katalogu tymczasowego: {}", "Cannot create the temporary folder: {}", e))?;
    cleanup_old(&root);
    let name = format!(
        "{}-{}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let dir = root.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| tr!("Nie można utworzyć katalogu tymczasowego: {}", "Cannot create the temporary folder: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

/// Creates a (sub)directory inside the staging directory.
#[tauri::command]
pub fn rdp_clip_stage_dir(stage_dir: String, rel_path: String) -> Result<(), String> {
    let dir = checked_stage_dir(&stage_dir)?;
    let target = dir.join(sanitize_relative(&rel_path)?);
    std::fs::create_dir_all(&target).map_err(|e| tr!("Nie można utworzyć katalogu {:?}: {}", "Cannot create folder {:?}: {}", target, e))
}

fn header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| tr!("Brak nagłówka {}", "Missing header {}", name))?
        .to_str()
        .map_err(|_| tr!("Nieprawidłowy nagłówek {}", "Invalid header {}", name))?;
    percent_decode(raw)
}

/// Writes one file. Body = raw file bytes (no base64), headers:
/// `x-stage-dir` and `x-rel-path` (both URI-encoded).
#[tauri::command]
pub async fn rdp_clip_stage_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(tr!("Oczekiwano binarnej zawartości pliku", "Binary file content expected").to_string());
    };
    let dir = checked_stage_dir(&header(&request, "x-stage-dir")?)?;
    let target = dir.join(sanitize_relative(&header(&request, "x-rel-path")?)?);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| tr!("Nie można utworzyć katalogu {:?}: {}", "Cannot create folder {:?}: {}", parent, e))?;
    }
    std::fs::write(&target, bytes).map_err(|e| tr!("Błąd zapisu pliku {:?}: {}", "Error writing file {:?}: {}", target, e))
}

/// Puts the given top-level entries of the staging directory on the local clipboard as a file
/// list (Windows CF_HDROP, "copy" drop effect). Returns the absolute paths.
#[tauri::command]
pub async fn rdp_clip_stage_commit(stage_dir: String, top_level: Vec<String>) -> Result<Vec<String>, String> {
    let dir = checked_stage_dir(&stage_dir)?;
    let mut paths = Vec::with_capacity(top_level.len());
    for name in &top_level {
        let p = dir.join(sanitize_relative(name)?);
        if !p.exists() {
            return Err(tr!("Brak pliku w katalogu tymczasowym: {}", "File missing in the temporary folder: {}", name));
        }
        let s = p.to_string_lossy().to_string();
        if !paths.contains(&s) {
            paths.push(s);
        }
    }
    if paths.is_empty() {
        return Err(tr!("Brak plików do umieszczenia w schowku", "No files to put on the clipboard").to_string());
    }

    #[cfg(target_os = "windows")]
    {
        let list = paths.clone();
        tokio::task::spawn_blocking(move || crate::session::winproc::clipboard_set_files(&list))
            .await
            .map_err(|e| e.to_string())??;
        Ok(paths)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(tr!("Schowek plików jest dostępny tylko w systemie Windows", "The file clipboard is available only on Windows").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_are_sanitised() {
        assert_eq!(sanitize_relative("dir\\sub\\a.txt").unwrap(), PathBuf::from("dir").join("sub").join("a.txt"));
        assert_eq!(sanitize_relative("zażółć.txt").unwrap(), PathBuf::from("zażółć.txt"));
        assert!(sanitize_relative("..\\evil.txt").is_err());
        assert!(sanitize_relative("C:\\Windows\\x").is_err());
        assert!(sanitize_relative("a\\..\\..\\b").is_err());
        assert!(sanitize_relative("").is_err());
        assert!(sanitize_relative("file:stream").is_err());
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("za%C5%BC%C3%B3%C5%82%C4%87%20x").unwrap(), "zażółć x");
        assert!(percent_decode("%ZZ").is_err());
    }

    #[test]
    fn stage_dir_must_be_inside_root() {
        let d = rdp_clip_stage_begin().unwrap();
        assert!(checked_stage_dir(&d).is_ok());
        rdp_clip_stage_dir(d.clone(), "folder\\sub".into()).unwrap();
        assert!(Path::new(&d).join("folder").join("sub").is_dir());
        assert!(checked_stage_dir(std::env::temp_dir().to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
