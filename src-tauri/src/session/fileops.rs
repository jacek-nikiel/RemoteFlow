//! Rename, move and permissions (chmod) in the two-pane SFTP window.
//!
//! Nothing is ever overwritten: an existing target is reported as an error, so a typo in the
//! new name or the target folder cannot destroy a file.

use crate::session::transfer::{display_path, is_remote_symlink, remote_join, remote_path_string, sanitize_name, MAX_DEPTH};
use std::path::{Path, PathBuf};

fn remote_name(path: &str) -> Result<String, String> {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .ok_or_else(|| tr!("Nieprawidłowa ścieżka: '{}'", "Invalid path: '{}'", path))
}

fn remote_parent_of(path: &str) -> String {
    let clean = path.trim_end_matches('/');
    match clean.rfind('/') {
        Some(0) => "/".to_string(),
        Some(i) => clean[..i].to_string(),
        None => String::new(),
    }
}

/// `dir` is `path` itself or one of its subfolders (moving a folder into itself).
fn remote_is_inside(dir: &str, path: &str) -> bool {
    let d = dir.trim_end_matches('/');
    let p = path.trim_end_matches('/');
    d == p || d.starts_with(&format!("{}/", p))
}

fn remote_rename_raw(sftp: &ssh2::Sftp, from: &Path, to: &Path) -> Result<(), String> {
    if sftp.lstat(to).is_ok() {
        return Err(tr!("'{}' już istnieje", "'{}' already exists", remote_path_string(to)));
    }
    // ATOMIC | NATIVE without OVERWRITE – the existence check above covers servers that ignore flags
    sftp.rename(from, to, Some(ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE))
        .map_err(|e| tr!("Nie udało się przenieść '{}' do '{}': {}", "Could not move '{}' to '{}': {}", remote_path_string(from), remote_path_string(to), e))
}

/// Renames a file or folder on the server; returns the new path.
pub fn remote_rename(sftp: &ssh2::Sftp, path: &str, new_name: &str) -> Result<String, String> {
    let name = sanitize_name(new_name)?;
    let target = remote_join(&remote_parent_of(path), &name);
    if remote_name(path)? == name {
        return Ok(remote_path_string(&target));
    }
    remote_rename_raw(sftp, Path::new(path), &target)?;
    Ok(remote_path_string(&target))
}

/// Moves files / folders into `target_dir` on the server; returns how many were moved.
pub fn remote_move(sftp: &ssh2::Sftp, paths: &[String], target_dir: &str) -> Result<u32, String> {
    let dir = target_dir.trim();
    if dir.is_empty() {
        return Err(tr!("Podaj katalog docelowy", "Enter the target folder").to_string());
    }
    let st = sftp.stat(Path::new(dir)).map_err(|e| tr!("Katalog '{}' nie istnieje: {}", "Folder '{}' does not exist: {}", dir, e))?;
    if !st.is_dir() {
        return Err(tr!("'{}' nie jest katalogiem", "'{}' is not a folder", dir));
    }
    let mut moved = 0;
    for path in paths {
        if remote_is_inside(dir, path) {
            return Err(tr!("Nie można przenieść '{}' do jego własnego podkatalogu", "Cannot move '{}' into its own subfolder", path));
        }
        if remote_parent_of(path).trim_end_matches('/') == dir.trim_end_matches('/') {
            continue; // already there
        }
        remote_rename_raw(sftp, Path::new(path), &remote_join(dir, &remote_name(path)?))?;
        moved += 1;
    }
    Ok(moved)
}

/// Which entries a recursive chmod changes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChmodScope {
    All,
    Files,
    Dirs,
}

impl ChmodScope {
    pub fn parse(s: &str) -> Self {
        match s {
            "files" => ChmodScope::Files,
            "dirs" => ChmodScope::Dirs,
            _ => ChmodScope::All,
        }
    }
    fn applies(self, is_dir: bool) -> bool {
        match self {
            ChmodScope::All => true,
            ChmodScope::Files => !is_dir,
            ChmodScope::Dirs => is_dir,
        }
    }
}

fn set_mode(sftp: &ssh2::Sftp, path: &Path, mode: u32) -> Result<(), String> {
    let stat = ssh2::FileStat { size: None, uid: None, gid: None, perm: Some(mode & 0o7777), atime: None, mtime: None };
    sftp.setstat(path, stat)
        .map_err(|e| tr!("Nie udało się zmienić uprawnień '{}': {}", "Could not change the permissions of '{}': {}", remote_path_string(path), e))
}

/// Changes permissions; returns how many entries were changed. Symbolic links are never
/// followed (chmod of a link would change its target, possibly outside the selected folder).
pub fn remote_chmod(sftp: &ssh2::Sftp, paths: &[String], mode: u32, recursive: bool, scope: ChmodScope) -> Result<u32, String> {
    let mut changed = 0;
    for path in paths {
        let p = Path::new(path);
        let stat = sftp.lstat(p).map_err(|e| tr!("Nie można odczytać '{}': {}", "Cannot read '{}': {}", path, e))?;
        if is_remote_symlink(&stat) {
            continue;
        }
        // The selected entries themselves are always changed; the scope applies to their contents
        set_mode(sftp, p, mode)?;
        changed += 1;
        if recursive && stat.is_dir() {
            changed += chmod_dir(sftp, p, mode, scope, 0)?;
        }
    }
    Ok(changed)
}

fn chmod_dir(sftp: &ssh2::Sftp, dir: &Path, mode: u32, scope: ChmodScope, depth: u32) -> Result<u32, String> {
    if depth > MAX_DEPTH {
        return Err(tr!("Zbyt głębokie zagnieżdżenie: {}", "Nesting too deep: {}", remote_path_string(dir)));
    }
    let entries = sftp.readdir(dir).map_err(|e| tr!("Błąd odczytu '{}': {}", "Error reading '{}': {}", remote_path_string(dir), e))?;
    let mut changed = 0;
    for (path, stat) in entries {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "." || name == ".." || is_remote_symlink(&stat) {
            continue;
        }
        let is_dir = stat.is_dir();
        if scope.applies(is_dir) {
            set_mode(sftp, &path, mode)?;
            changed += 1;
        }
        if is_dir {
            changed += chmod_dir(sftp, &path, mode, scope, depth + 1)?;
        }
    }
    Ok(changed)
}

// --- This computer ------------------------------------------------------------------------

fn local_rename_raw(from: &Path, to: &Path) -> Result<(), String> {
    if to.symlink_metadata().is_ok() {
        return Err(tr!("'{}' już istnieje", "'{}' already exists", display_path(to)));
    }
    std::fs::rename(from, to).map_err(|e| {
        if (cfg!(unix) && e.raw_os_error() == Some(18)) || (cfg!(windows) && e.raw_os_error() == Some(17)) {
            // EXDEV (Unix 18) / ERROR_NOT_SAME_DEVICE (Windows 17)
            tr!(
                "Nie można przenieść '{}' na inny dysk – skopiuj i usuń.",
                "Cannot move '{}' to another drive – copy it and delete the original.",
                display_path(from)
            )
        } else {
            tr!("Nie udało się przenieść '{}' do '{}': {}", "Could not move '{}' to '{}': {}", display_path(from), display_path(to), e)
        }
    })
}

/// New local path after renaming `path` to `new_name` (the name is validated).
pub fn local_rename_target(path: &str, new_name: &str) -> Result<PathBuf, String> {
    let name = sanitize_name(new_name)?;
    let parent = Path::new(path).parent().ok_or_else(|| tr!("Nieprawidłowa ścieżka: '{}'", "Invalid path: '{}'", path))?;
    Ok(parent.join(name))
}

pub fn local_rename(path: &str, target: &Path) -> Result<String, String> {
    let from = Path::new(path);
    if from == target {
        return Ok(display_path(target));
    }
    // Only the letter case changes (Windows / macOS: the "existing" target is the file itself)
    let same_file = from.parent() == target.parent()
        && from.file_name().map(|n| n.to_string_lossy().to_lowercase()) == target.file_name().map(|n| n.to_string_lossy().to_lowercase());
    if same_file && !cfg!(target_os = "linux") {
        std::fs::rename(from, target).map_err(|e| tr!("Nie udało się zmienić nazwy '{}': {}", "Could not rename '{}': {}", display_path(from), e))?;
    } else {
        local_rename_raw(from, target)?;
    }
    Ok(display_path(target))
}

/// Paths `local_move` would create (for the access check before moving).
pub fn local_move_targets(paths: &[String], target_dir: &str) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let dir = PathBuf::from(target_dir.trim());
    if target_dir.trim().is_empty() || !dir.is_dir() {
        return Err(tr!("Katalog '{}' nie istnieje", "Folder '{}' does not exist", target_dir));
    }
    let dir_c = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    let mut out = Vec::new();
    for path in paths {
        let from = PathBuf::from(path);
        let from_c = from.canonicalize().unwrap_or_else(|_| from.clone());
        if dir_c.starts_with(&from_c) {
            return Err(tr!("Nie można przenieść '{}' do jego własnego podkatalogu", "Cannot move '{}' into its own subfolder", path));
        }
        if from_c.parent() == Some(dir_c.as_path()) {
            continue; // already there
        }
        let name = from.file_name().ok_or_else(|| tr!("Nieprawidłowa ścieżka: '{}'", "Invalid path: '{}'", path))?;
        out.push((from.clone(), dir.join(name)));
    }
    Ok(out)
}

pub fn local_move(moves: &[(PathBuf, PathBuf)]) -> Result<u32, String> {
    let mut moved = 0;
    for (from, to) in moves {
        local_rename_raw(from, to)?;
        moved += 1;
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths() {
        assert_eq!(remote_parent_of("/etc/nginx/"), "/etc");
        assert_eq!(remote_parent_of("/etc"), "/");
        assert_eq!(remote_parent_of("file"), "");
        assert!(remote_is_inside("/a/b/c", "/a/b"));
        assert!(remote_is_inside("/a/b", "/a/b/"));
        assert!(!remote_is_inside("/a/bc", "/a/b"));
    }

    #[test]
    fn chmod_scope() {
        assert!(ChmodScope::parse("files").applies(false));
        assert!(!ChmodScope::parse("files").applies(true));
        assert!(ChmodScope::parse("dirs").applies(true));
        assert!(ChmodScope::parse("x").applies(true));
    }

    #[test]
    fn local_rename_and_move() {
        let base = std::env::temp_dir().join(format!("rf-fileops-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("dir/sub")).unwrap();
        std::fs::write(base.join("a.txt"), b"a").unwrap();
        std::fs::write(base.join("b.txt"), b"b").unwrap();
        let a = base.join("a.txt").to_string_lossy().to_string();
        // existing target refused
        let t = local_rename_target(&a, "b.txt").unwrap();
        assert!(local_rename(&a, &t).is_err());
        assert!(local_rename_target(&a, "x/y").is_err());
        let t = local_rename_target(&a, "c.txt").unwrap();
        let c = local_rename(&a, &t).unwrap();
        assert!(Path::new(&c).exists());
        // move into a folder; a folder into itself refused
        let dir = base.join("dir").to_string_lossy().to_string();
        let moves = local_move_targets(&[c.clone()], &dir).unwrap();
        assert_eq!(local_move(&moves).unwrap(), 1);
        assert!(base.join("dir/c.txt").exists());
        let sub = base.join("dir/sub").to_string_lossy().to_string();
        assert!(local_move_targets(&[dir.clone()], &sub).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
