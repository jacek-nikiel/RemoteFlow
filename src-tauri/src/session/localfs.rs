//! Guard of the commands that work on this computer's files (SFTP window, file preview/editor,
//! RDP file exchange). Only code running in the application window can call them; that is
//! protected by the CSP (no inline/eval scripts, no innerHTML). As a second line of defence:
//! - they work only while the vault is unlocked (the lock screen needs none of them),
//! - the application's own data – the vault file and its siblings (`vault.json*`, `display.json`),
//!   the backup folder – cannot be previewed, edited, overwritten, deleted or sent anywhere.
//!   A folder that contains them cannot be deleted either.
//!
//! The user's other files (also `~/.ssh`) stay accessible on purpose: editing `~/.ssh/config` or
//! uploading `authorized_keys` to a server is normal use of the SFTP window.

use std::path::{Component, Path, PathBuf};

use crate::auth::{lock_auth, AuthState};
use crate::vault::storage::{get_vault_path, load_vault_verified};

/// Access to local files for one command call (see the module description).
pub struct LocalAccess {
    /// Folder of the vault file (canonical).
    vault_dir: Option<PathBuf>,
    /// Backup folders – the default one next to the vault and a custom one (canonical).
    protected_dirs: Vec<PathBuf>,
}

/// Protected locations computed for one state of the vault file (modification time, size):
/// decrypting the vault for every preview chunk or folder operation would cost time for nothing.
struct Cached {
    stamp: (Option<std::time::SystemTime>, u64),
    vault_dir: Option<PathBuf>,
    protected_dirs: Vec<PathBuf>,
}

static CACHE: std::sync::Mutex<Option<Cached>> = std::sync::Mutex::new(None);

/// Checks that the vault is unlocked and collects the protected locations.
pub fn local_access(auth_state: &AuthState) -> Result<LocalAccess, String> {
    let mgr = lock_auth(auth_state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Magazyn poświadczeń jest zablokowany", "The credential store is locked").to_string())?;
    let vault_path = get_vault_path();
    let stamp = std::fs::metadata(&vault_path).map(|m| (m.modified().ok(), m.len())).unwrap_or((None, 0));
    let mut cache = CACHE.lock().map_err(|e| e.to_string())?;
    if let Some(c) = cache.as_ref().filter(|c| c.stamp == stamp) {
        return Ok(LocalAccess { vault_dir: c.vault_dir.clone(), protected_dirs: c.protected_dirs.clone() });
    }
    // The custom backup folder is in the vault; the default one is always protected
    let backup_settings = load_vault_verified(key).map(|v| v.metadata.backup).unwrap_or_default();
    drop(mgr);
    let vault_dir = vault_path.parent().map(canonical_lenient);
    let protected_dirs = vec![
        canonical_lenient(&crate::vault::backup::backup_dir(&Default::default())),
        canonical_lenient(&crate::vault::backup::backup_dir(&backup_settings)),
    ];
    *cache = Some(Cached { stamp, vault_dir: vault_dir.clone(), protected_dirs: protected_dirs.clone() });
    Ok(LocalAccess { vault_dir, protected_dirs })
}

/// Only checks that the vault is unlocked (listing and searching folders).
pub fn require_unlocked(auth_state: &AuthState) -> Result<(), String> {
    let mgr = lock_auth(auth_state)?;
    mgr.unlocked_key()
        .map(|_| ())
        .map_err(|_| tr!("Magazyn poświadczeń jest zablokowany", "The credential store is locked").to_string())
}

impl LocalAccess {
    /// A file or folder that is read, written or created: refused when it is protected data.
    pub fn check(&self, path: impl AsRef<Path>) -> Result<(), String> {
        let p = canonical_lenient(path.as_ref());
        if self.is_protected(&p) {
            return Err(protected_error(path.as_ref()));
        }
        Ok(())
    }

    /// A path that is deleted: additionally refused when it contains protected data.
    pub fn check_delete(&self, path: impl AsRef<Path>) -> Result<(), String> {
        self.check(&path)?;
        let p = canonical_lenient(path.as_ref());
        let contains = |inner: &PathBuf| starts_with(inner, &p);
        if self.vault_dir.iter().chain(self.protected_dirs.iter()).any(contains) {
            return Err(protected_error(path.as_ref()));
        }
        Ok(())
    }

    fn is_protected(&self, p: &Path) -> bool {
        if self.protected_dirs.iter().any(|d| starts_with(p, d)) {
            return true;
        }
        let Some(vault_dir) = &self.vault_dir else { return false };
        let in_vault_dir = p.parent().is_some_and(|parent| same(parent, vault_dir));
        in_vault_dir
            && p.file_name().map(|n| n.to_string_lossy().to_lowercase()).is_some_and(|name| {
                name.starts_with("vault.json") || name == "display.json" || name.starts_with(".vault.json")
            })
    }
}

fn protected_error(path: &Path) -> String {
    tr!(
        "'{}' to dane programu RemoteFlow (sejf, kopie zapasowe lub ustawienia) – nie można ich otwierać ani zmieniać z tego okna.",
        "'{}' is RemoteFlow's own data (vault, backups or settings) – it cannot be opened or changed from this window.",
        path.display()
    )
}

/// Canonical form of a path that may not exist yet: the longest existing ancestor is resolved
/// (symbolic links, `..`), the rest is appended. A link elsewhere cannot hide a protected file.
pub fn canonical_lenient(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().map(|d| d.join(path)).unwrap_or_else(|_| path.to_path_buf())
    };
    let mut existing = absolute.clone();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(c) = existing.canonicalize() {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return normalize(&out);
        }
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => return normalize(&absolute),
        }
    }
}

/// Removes `.` and resolves `..` lexically (only in the not-yet-existing tail).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Path comparison – case-insensitive on Windows (NTFS), as the file system itself.
fn key(p: &Path) -> String {
    let s = p.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn same(a: &Path, b: &Path) -> bool {
    key(a) == key(b)
}

/// `inner` is `outer` or lies inside it (whole components only).
fn starts_with(inner: &Path, outer: &Path) -> bool {
    let (i, o) = (key(inner), key(outer));
    i == o || (i.starts_with(&o) && matches!(i.as_bytes().get(o.len()), Some(b'/') | Some(b'\\')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn access(dir: &Path) -> LocalAccess {
        LocalAccess {
            vault_dir: Some(canonical_lenient(dir)),
            protected_dirs: vec![canonical_lenient(&dir.join("backups")), canonical_lenient(&dir.join("my-backups"))],
        }
    }

    #[test]
    fn protects_the_vault_and_backups() {
        let dir = std::env::temp_dir().join(format!("rf-localfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("backups")).unwrap();
        std::fs::write(dir.join("vault.json"), "{}").unwrap();
        let a = access(&dir);

        for p in ["vault.json", "VAULT.JSON.bak_1", "vault.json.tmp", "display.json", "backups/x.json", "my-backups/new", "backups"] {
            assert!(a.check(dir.join(p)).is_err(), "{p}");
        }
        // `..` and a not-yet-existing tail cannot get around it
        assert!(a.check(dir.join("sub/../vault.json")).is_err());
        assert!(a.check(dir.join("nope/../backups/a")).is_err());
        // Other files next to the vault and elsewhere are fine (e.g. a portable copy's folder)
        for p in ["notes.txt", "vault.json2/../readme.md", "backupsX/a", "sub/vault.json"] {
            assert!(a.check(dir.join(p)).is_ok(), "{p}");
        }
        // Deleting the folder that holds the vault is refused, a sibling folder is fine
        assert!(a.check_delete(&dir).is_err());
        assert!(a.check_delete(dir.parent().unwrap()).is_err());
        std::fs::create_dir_all(dir.join("other")).unwrap();
        assert!(a.check_delete(dir.join("other")).is_ok());

        #[cfg(unix)]
        {
            // A link to the vault is resolved
            std::os::unix::fs::symlink(dir.join("vault.json"), dir.join("other/link.json")).unwrap();
            assert!(a.check(dir.join("other/link.json")).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
