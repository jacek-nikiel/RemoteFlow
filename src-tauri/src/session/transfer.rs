//! Two-pane SFTP file manager backend (local ⇄ remote).
//!
//! * Browsing operations (list, mkdir, delete, search) reuse a cached SFTP session per
//!   connection, so navigating directories does not open a new SSH connection every time.
//!   Idle sessions are closed after a few minutes; a dead session is re-established once.
//! * Transfers (upload / download of many files and folders) use their own SSH connection, so
//!   browsing stays responsive during a long copy. Progress is reported to the UI with the
//!   `sftp-transfer-progress` event. A transfer can be cancelled: the flag is checked between
//!   files and after every block of data; a partly downloaded file is discarded (the existing
//!   local file stays untouched), a partly uploaded remote file is deleted.

use crate::session::sftp::SftpFileEntry;
use crate::session::ssh::SshConnectionConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub const MAX_DEPTH: u32 = 32;
const SEARCH_MAX_RESULTS: usize = 500;
const SEARCH_MAX_DIRS: usize = 20_000;
const SEARCH_MAX_DEPTH: u32 = 12;

// ---------------------------------------------------------------------------------------------
// Cached browsing sessions
// ---------------------------------------------------------------------------------------------

struct Pooled {
    identity: [u8; 32],
    _sess: ssh2::Session,
    sftp: ssh2::Sftp,
    last_used: Instant,
}

type Slot = Arc<Mutex<Option<Pooled>>>;
static POOL: LazyLock<Mutex<HashMap<String, Slot>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn slot_for(key: &str) -> Slot {
    let mut pool = POOL.lock().unwrap_or_else(|p| p.into_inner());
    // Close idle sessions of other connections (only if nobody is using them right now).
    pool.retain(|k, slot| {
        if k == key {
            return true;
        }
        match slot.try_lock() {
            Ok(mut guard) => {
                if guard.as_ref().map(|p| p.last_used.elapsed() > POOL_IDLE_TIMEOUT).unwrap_or(true) {
                    *guard = None;
                    false
                } else {
                    true
                }
            }
            Err(_) => true,
        }
    });
    pool.entry(key.to_string()).or_default().clone()
}

/// Drops the cached session of a connection (e.g. when the SFTP window is closed).
pub fn release_pooled(key: &str) {
    let mut pool = POOL.lock().unwrap_or_else(|p| p.into_inner());
    pool.remove(key);
}

/// Runs `op` on a cached SFTP session for `key`, reconnecting once if the session died.
pub fn with_pooled_sftp<T>(
    key: &str,
    config: &SshConnectionConfig,
    op: impl Fn(&ssh2::Sftp) -> Result<T, String>,
) -> Result<T, String> {
    let slot = slot_for(key);
    let mut guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    let identity = config_identity(config);
    for attempt in 0..2 {
        if guard.as_ref().map(|p| p.identity != identity || p.last_used.elapsed() > POOL_IDLE_TIMEOUT).unwrap_or(false) {
            *guard = None;
        }
        if guard.is_none() {
            let (sess, sftp) = crate::session::sftp::sftp_connect(config)?;
            *guard = Some(Pooled { identity, _sess: sess, sftp, last_used: Instant::now() });
        }
        let pooled = guard.as_mut().expect("just set");
        match op(&pooled.sftp) {
            Ok(v) => {
                pooled.last_used = Instant::now();
                return Ok(v);
            }
            Err(e) => {
                // Distinguish "operation failed" from "connection is gone".
                let alive = pooled.sftp.realpath(Path::new(".")).is_ok();
                if alive || attempt == 1 {
                    pooled.last_used = Instant::now();
                    return Err(e);
                }
                *guard = None;
            }
        }
    }
    unreachable!("loop returns on the second attempt")
}

fn config_identity(config: &SshConnectionConfig) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(config.port.to_be_bytes());
    for field in [Some(config.host.as_str()), Some(config.username.as_str()), Some(config.auth_type.as_str()),
        config.password.as_deref(), config.private_key.as_deref(), config.passphrase.as_deref(), config.certificate.as_deref()] {
        hash.update([u8::from(field.is_some())]);
        let bytes = field.unwrap_or_default().as_bytes();
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    // A different jump host (or its credentials) is a different connection
    if let Some(jump) = &config.jump {
        hash.update(b"jump");
        hash.update(config_identity(&jump.config));
    }
    hash.finalize().into()
}

#[cfg(test)]
mod pool_identity_tests {
    use super::*;
    use crate::session::ssh::HostKeyVerifier;
    use crate::vault::known_hosts::HostTrust;

    #[test]
    fn changing_destination_or_credentials_invalidates_pooled_session() {
        let config = SshConnectionConfig {
            host: "server-a".into(), port: 22, username: "alice".into(), auth_type: "password".into(),
            password: Some("old".into()), private_key: None, passphrase: None, certificate: None,
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
            jump: None,
        };
        let original = config_identity(&config);
        assert_eq!(original, config_identity(&config.clone()));
        let changes: [fn(&mut SshConnectionConfig); 7] = [
            |c| c.host = "server-b".into(), |c| c.port = 2222, |c| c.username = "bob".into(),
            |c| c.password = Some("new".into()), |c| c.auth_type = "agent".into(),
            |c| c.private_key = Some("key".into()), |c| c.certificate = Some("cert".into()),
        ];
        for change in changes {
            let mut changed = config.clone(); change(&mut changed);
            assert_ne!(original, config_identity(&changed));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/// Server paths are always Unix-style. On Windows `Path::join` (used by `ssh2::Sftp::readdir`
/// and by us) inserts `\` – e.g. `/etc\apport` – so the separators are normalised before a
/// remote path is shown or sent back to the UI. (ssh2 itself already converts `\` to `/` when
/// it sends a path to the server, so a `\` can never be part of a remote name on Windows.)
pub fn remote_path_string(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() }
}

/// `follow`: a symbolic link is shown with the type / size of its target (one extra `stat`
/// round trip per link); without it (recursive search) the link's own data is used.
fn remote_entry(sftp: Option<&ssh2::Sftp>, path: &Path, stat: &ssh2::FileStat) -> Option<SftpFileEntry> {
    let name = path.file_name()?.to_str()?.to_string();
    if name == "." || name == ".." {
        return None;
    }
    let is_link = is_remote_symlink(stat);
    let target = match (is_link, sftp) {
        (true, Some(sftp)) => sftp.stat(path).ok(), // None = broken link
        _ => None,
    };
    let st = target.as_ref().unwrap_or(stat);
    Some(SftpFileEntry {
        name,
        path: remote_path_string(path),
        is_dir: st.is_dir(),
        size: if st.is_dir() { 0 } else { st.size.unwrap_or(0) },
        modified: st.mtime.unwrap_or(0),
        permissions: st.perm.unwrap_or(0),
        is_link,
    })
}

pub fn is_remote_symlink(stat: &ssh2::FileStat) -> bool {
    stat.file_type() == ssh2::FileType::Symlink
}

/// Windows: entries that are both hidden and system – e.g. the legacy junctions in the user
/// profile ("Application Data", "Moje dokumenty"...), which Explorer hides and which cannot be
/// opened anyway.
fn is_hidden_system(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        let a = meta.file_attributes();
        a & HIDDEN != 0 && a & SYSTEM != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

/// One entry of a local folder. Symbolic links are shown with the type / size of their target
/// (a broken link as an empty file) and marked `is_link`.
pub(crate) fn local_entry(path: &Path) -> Option<SftpFileEntry> {
    let link_meta = std::fs::symlink_metadata(path).ok()?;
    if is_hidden_system(&link_meta) {
        return None;
    }
    let is_link = link_meta.file_type().is_symlink();
    let meta = if is_link { std::fs::metadata(path).unwrap_or(link_meta) } else { link_meta };
    let name = path.file_name()?.to_string_lossy().to_string();
    Some(SftpFileEntry {
        name,
        path: display_path(path),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0),
        permissions: 0,
        is_link,
    })
}

/// Path for display / round-tripping to the UI: strips the Windows verbatim prefix (`\\?\`)
/// that `canonicalize()` adds.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
}

/// A single file/folder name coming from the UI or from the remote server must not contain
/// path separators or be "." / "..".
pub fn sanitize_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty()
        || n == "."
        || n == ".."
        || n.contains('/')
        || n.contains('\\')
        || n.chars().any(|c| c.is_control())
    {
        return Err(tr!("Niedozwolona nazwa: '{}'", "Name not allowed: '{}'", name));
    }
    #[cfg(target_os = "windows")]
    if n.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err(tr!("Nazwa zawiera znaki niedozwolone w Windows: '{}'", "The name contains characters not allowed in Windows: '{}'", name));
    }
    Ok(n.to_string())
}

pub fn remote_join(dir: &str, name: &str) -> PathBuf {
    let base = if dir.is_empty() { "." } else { dir };
    Path::new(base).join(name)
}

// ---------------------------------------------------------------------------------------------
// Browsing / searching
// ---------------------------------------------------------------------------------------------

pub fn remote_list(sftp: &ssh2::Sftp, remote_path: &str) -> Result<(String, Vec<SftpFileEntry>), String> {
    let target = if remote_path.is_empty() || remote_path == "." || remote_path == "~" {
        sftp.realpath(Path::new(".")).unwrap_or_else(|_| PathBuf::from("/"))
    } else {
        PathBuf::from(remote_path)
    };
    let current = remote_path_string(&target);
    let entries = sftp
        .readdir(&target)
        .map_err(|e| tr!("Błąd odczytu katalogu '{}': {}", "Error reading folder '{}': {}", current, e))?;
    let mut result: Vec<SftpFileEntry> = entries.iter().filter_map(|(p, st)| remote_entry(Some(sftp), p, st)).collect();
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((current, result))
}

pub fn remote_delete(sftp: &ssh2::Sftp, remote_path: &str) -> Result<(), String> {
    let p = Path::new(remote_path);
    let stat = sftp.lstat(p).map_err(|e| tr!("Nie można odczytać '{}': {}", "Cannot read '{}': {}", remote_path, e))?;
    if stat.is_dir() && !is_remote_symlink(&stat) {
        delete_remote_dir(sftp, p, 0)
    } else {
        sftp.unlink(p).map_err(|e| tr!("Błąd usuwania '{}': {}", "Error deleting '{}': {}", remote_path, e))
    }
}

fn delete_remote_dir(sftp: &ssh2::Sftp, dir: &Path, depth: u32) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(tr!("Zbyt głębokie zagnieżdżenie: {}", "Nesting too deep: {}", remote_path_string(dir)));
    }
    let entries = sftp.readdir(dir).map_err(|e| tr!("Błąd odczytu '{}': {}", "Error reading '{}': {}", remote_path_string(dir), e))?;
    for (path, stat) in entries {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name == "." || name == ".." {
            continue;
        }
        if stat.is_dir() && !is_remote_symlink(&stat) {
            delete_remote_dir(sftp, &path, depth + 1)?;
        } else {
            sftp.unlink(&path).map_err(|e| tr!("Błąd usuwania '{}': {}", "Error deleting '{}': {}", remote_path_string(&path), e))?;
        }
    }
    sftp.rmdir(dir).map_err(|e| tr!("Błąd usuwania katalogu '{}': {}", "Error deleting folder '{}': {}", remote_path_string(dir), e))
}

pub fn remote_mkdir(sftp: &ssh2::Sftp, parent: &str, name: &str) -> Result<String, String> {
    let name = sanitize_name(name)?;
    let target = remote_join(parent, &name);
    sftp.mkdir(&target, 0o755)
        .map_err(|e| tr!("Błąd tworzenia katalogu '{}': {}", "Error creating folder '{}': {}", remote_path_string(&target), e))?;
    Ok(remote_path_string(&target))
}

/// Creates a new, empty file on the server (never overwrites: fails when the name exists).
pub fn remote_mkfile(sftp: &ssh2::Sftp, parent: &str, name: &str) -> Result<String, String> {
    let name = sanitize_name(name)?;
    let target = remote_join(parent, &name);
    if sftp.lstat(&target).is_ok() {
        return Err(tr!("'{}' już istnieje", "'{}' already exists", remote_path_string(&target)));
    }
    sftp.open_mode(&target, ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE, 0o644, ssh2::OpenType::File)
        .map_err(|e| tr!("Błąd tworzenia pliku '{}': {}", "Error creating file '{}': {}", remote_path_string(&target), e))?;
    Ok(remote_path_string(&target))
}

/// Creates a new, empty local file (never overwrites).
pub fn local_mkfile(parent: &str, name: &str) -> Result<String, String> {
    let name = sanitize_name(name)?;
    let base = if parent.trim().is_empty() {
        dirs::home_dir().ok_or(tr!("Brak katalogu domowego", "No home folder"))?
    } else {
        PathBuf::from(parent)
    };
    let target = base.join(name);
    std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            tr!("'{}' już istnieje", "'{}' already exists", display_path(&target))
        } else {
            tr!("Błąd tworzenia pliku '{}': {}", "Error creating file '{}': {}", display_path(&target), e)
        }
    })?;
    Ok(display_path(&target))
}

pub fn local_mkdir(parent: &str, name: &str) -> Result<String, String> {
    let name = sanitize_name(name)?;
    let base = if parent.trim().is_empty() {
        dirs::home_dir().ok_or(tr!("Brak katalogu domowego", "No home folder"))?
    } else {
        PathBuf::from(parent)
    };
    let target = base.join(name);
    if target.exists() {
        return Err(tr!("'{}' już istnieje", "'{}' already exists", display_path(&target)));
    }
    std::fs::create_dir(&target).map_err(|e| tr!("Błąd tworzenia katalogu '{}': {}", "Error creating folder '{}': {}", display_path(&target), e))?;
    Ok(display_path(&target))
}

/// Error prefix of `local_delete` when the trash is not available (the window then offers a
/// permanent delete).
pub const TRASH_UNAVAILABLE: &str = "TRASH_UNAVAILABLE:";

/// Refuses paths whose deletion would be a disaster rather than a mistake: filesystem / drive
/// roots and the user's home folder.
fn check_deletable(p: &Path) -> Result<(), String> {
    let is_root = p.parent().is_none() || p.components().count() <= 1;
    let is_home = dirs::home_dir().is_some_and(|h| h == p);
    if is_root || is_home || !p.is_absolute() {
        return Err(tr!("Tego folderu nie można usunąć: {}", "This folder cannot be deleted: {}", display_path(p)));
    }
    Ok(())
}

#[cfg(not(windows))]
fn move_to_trash(p: &Path) -> Result<(), String> {
    trash::delete(p).map_err(|e| e.to_string())
}

/// Moves a file or folder to the Recycle Bin through PowerShell (the VB.NET FileSystem API, i.e.
/// the Windows shell).
///
/// Done in-process (IFileOperation), recycling is a rename of the user's file into
/// `$Recycle.Bin` under a random name – behaviour-based antivirus (e.g. F-Secure DeepGuard,
/// "CryptoRansomwareBehavior") blocks an unknown, unsigned program doing that. Done by the
/// signed system PowerShell it is an ordinary shell operation.
///
/// Only paths on fixed drives are recycled: elsewhere (network share, removable disk) Windows has
/// no Recycle Bin and would delete permanently – the caller then asks the user. The path goes in
/// an environment variable as base64, so no character in it can change the script.
#[cfg(windows)]
fn move_to_trash(p: &Path) -> Result<(), String> {
    use base64::Engine;
    const SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
        try { \
          $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:RF_TRASH_PATH)); \
          $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($p)); \
          if ($drive.DriveType -ne 'Fixed') { exit 3 }; \
          Add-Type -AssemblyName Microsoft.VisualBasic; \
          if (Test-Path -LiteralPath $p -PathType Container) { \
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') \
          } else { \
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') \
          } \
        } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }";
    let encoded = base64::engine::general_purpose::STANDARD.encode(p.to_string_lossy().as_bytes());
    let out = crate::session::winproc::hidden_command("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("RF_TRASH_PATH", encoded)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    match out.status.code() {
        Some(0) if !p.exists() => Ok(()),
        Some(0) => Err(tr!("element nadal istnieje", "the item still exists").to_string()),
        Some(3) => Err(tr!("na tym dysku nie ma Kosza", "this drive has no Recycle Bin").to_string()),
        _ => {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if msg.is_empty() { format!("PowerShell: {}", out.status) } else { msg })
        }
    }
}

/// Deletes a local file or folder: to the Recycle Bin / trash, or permanently (`permanent`).
/// A symbolic link is removed itself – its target is never touched.
pub fn local_delete(path: &str, permanent: bool) -> Result<(), String> {
    let p = PathBuf::from(path);
    check_deletable(&p)?;
    let meta = std::fs::symlink_metadata(&p).map_err(|e| tr!("Nie można odczytać '{}': {}", "Cannot read '{}': {}", path, e))?;
    if !permanent {
        return move_to_trash(&p).map_err(|e| {
            format!(
                "{TRASH_UNAVAILABLE}{}",
                tr!("Nie można przenieść '{}' do kosza: {}", "Cannot move '{}' to the trash: {}", path, e)
            )
        });
    }
    let result = if meta.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    result.map_err(|e| tr!("Błąd usuwania '{}': {}", "Error deleting '{}': {}", path, e))
}

pub fn remote_search(sftp: &ssh2::Sftp, root: &str, query: &str) -> Result<Vec<SftpFileEntry>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = if root.is_empty() {
        sftp.realpath(Path::new(".")).unwrap_or_else(|_| PathBuf::from("/"))
    } else {
        PathBuf::from(root)
    };
    let mut results = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root_path, 0u32)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > SEARCH_MAX_DIRS || results.len() >= SEARCH_MAX_RESULTS {
            break;
        }
        let Ok(entries) = sftp.readdir(&dir) else { continue };
        for (path, stat) in entries {
            // Links are listed but never followed while searching (loops, huge trees)
            let Some(entry) = remote_entry(None, &path, &stat) else { continue };
            if entry.is_dir && !entry.is_link && depth < SEARCH_MAX_DEPTH {
                queue.push_back((path.clone(), depth + 1));
            }
            if entry.name.to_lowercase().contains(&q) {
                results.push(entry);
                if results.len() >= SEARCH_MAX_RESULTS {
                    break;
                }
            }
        }
    }
    Ok(results)
}

pub fn local_search(root: &str, query: &str) -> Result<Vec<SftpFileEntry>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = if root.trim().is_empty() {
        dirs::home_dir().ok_or(tr!("Brak katalogu domowego", "No home folder"))?
    } else {
        PathBuf::from(root)
    };
    let mut results = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root_path, 0u32)]);
    let mut visited = 0usize;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > SEARCH_MAX_DIRS || results.len() >= SEARCH_MAX_RESULTS {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for item in rd.flatten() {
            let path = item.path();
            let Some(entry) = local_entry(&path) else { continue };
            if entry.is_dir && !entry.is_link && depth < SEARCH_MAX_DEPTH {
                queue.push_back((path.clone(), depth + 1));
            }
            if entry.name.to_lowercase().contains(&q) {
                results.push(entry);
                if results.len() >= SEARCH_MAX_RESULTS {
                    break;
                }
            }
        }
    }
    Ok(results)
}

// ---------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Serialize)]
pub struct TransferSummary {
    pub files: u32,
    pub folders: u32,
    pub bytes: u64,
    pub failed: u32,
    /// First few error messages (for the UI).
    pub errors: Vec<String>,
    /// Links to folders inside a transferred folder – not followed (could loop or pull in a huge
    /// tree). Links to files, and a link selected directly, are transferred with their content.
    #[serde(rename = "skippedLinks")]
    pub skipped_links: u32,
    /// The user stopped the transfer; the counters say what was finished before that.
    pub cancelled: bool,
}

impl TransferSummary {
    fn fail(&mut self, msg: String) {
        self.failed += 1;
        if self.errors.len() < 5 {
            self.errors.push(msg);
        }
    }
}

/// Progress callback: (files done, name of the item being transferred, bytes transferred so far).
pub type Progress<'a> = &'a mut dyn FnMut(u32, &str, u64);

/// Set by the user to stop a transfer.
pub type Cancel<'a> = &'a AtomicBool;

fn cancelled_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")
}

/// Copies in blocks; checks the cancel flag and reports the bytes copied after every block.
fn copy_with_progress(
    reader: &mut dyn std::io::Read,
    writer: &mut dyn std::io::Write,
    cancel: Cancel,
    on_block: &mut dyn FnMut(u64),
) -> std::io::Result<u64> {
    let mut buf = vec![0u8; 128 * 1024];
    let mut total = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled_error());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        total += n as u64;
        on_block(total);
    }
    writer.flush()?;
    Ok(total)
}

fn upload_one(
    sftp: &ssh2::Sftp,
    local: &Path,
    remote_dir: &Path,
    depth: u32,
    sum: &mut TransferSummary,
    progress: Progress,
    cancel: Cancel,
) {
    if cancel.load(Ordering::Relaxed) {
        sum.cancelled = true;
        return;
    }
    if depth > MAX_DEPTH {
        sum.fail(tr!("Zbyt głębokie zagnieżdżenie: {}", "Nesting too deep: {}", display_path(local)));
        return;
    }
    let Ok(link_meta) = std::fs::symlink_metadata(local) else {
        sum.fail(tr!("Nie można odczytać: {}", "Cannot read: {}", display_path(local)));
        return;
    };
    // Symbolic links are transferred with the content of their target. A link to a folder
    // inside a transferred folder is not followed (loops / huge trees) – it is counted instead.
    let meta = if link_meta.file_type().is_symlink() {
        match std::fs::metadata(local) {
            Ok(m) if m.is_dir() && depth > 0 => {
                sum.skipped_links += 1;
                return;
            }
            Ok(m) => m,
            Err(_) => {
                sum.fail(tr!("Uszkodzone dowiązanie: {}", "Broken link: {}", display_path(local)));
                return;
            }
        }
    } else {
        link_meta
    };
    let name = match local.file_name() {
        Some(n) => n.to_string_lossy().to_string(),
        None => {
            sum.fail(tr!("Nieprawidłowa ścieżka: {}", "Invalid path: {}", display_path(local)));
            return;
        }
    };
    let target = remote_dir.join(&name);

    if meta.is_dir() {
        if sftp.stat(&target).map(|s| s.is_dir()).unwrap_or(false) || sftp.mkdir(&target, 0o755).is_ok() {
            sum.folders += 1;
        } else {
            sum.fail(tr!("Nie można utworzyć katalogu zdalnego {}", "Cannot create remote folder {}", remote_path_string(&target)));
            return;
        }
        match std::fs::read_dir(local) {
            Ok(rd) => {
                for item in rd.flatten() {
                    upload_one(sftp, &item.path(), &target, depth + 1, sum, progress, cancel);
                    if sum.cancelled {
                        return;
                    }
                }
            }
            Err(e) => sum.fail(tr!("Błąd odczytu katalogu {}: {}", "Error reading folder {}: {}", display_path(local), e)),
        }
    } else if meta.is_file() {
        let (files, base) = (sum.files, sum.bytes);
        progress(files, &name, base);
        let result = File::open(local)
            .map_err(|e| tr!("Błąd otwierania {}: {}", "Error opening {}: {}", display_path(local), e))
            .and_then(|mut src| write_remote_file(sftp, &mut src, &target, cancel, &mut |done| progress(files, &name, base + done)));
        match result {
            Ok(n) => {
                sum.files += 1;
                sum.bytes += n;
            }
            Err(_) if cancel.load(Ordering::Relaxed) => sum.cancelled = true,
            Err(e) => sum.fail(e),
        }
    }
}

/// Uploads into a temporary file next to the target (`.name.rf-part`), which replaces the target
/// only when complete: an interrupted, cancelled or failed upload never leaves a truncated file,
/// and an existing file on the server keeps its previous content until then. A link on the
/// server is not replaced by a regular file – the file it points to is updated.
pub(crate) fn write_remote_file(
    sftp: &ssh2::Sftp,
    src: &mut dyn std::io::Read,
    target: &Path,
    cancel: Cancel,
    on_block: &mut dyn FnMut(u64),
) -> Result<u64, String> {
    let target = match sftp.lstat(target) {
        Ok(st) if is_remote_symlink(&st) => sftp.realpath(target).unwrap_or_else(|_| target.to_path_buf()),
        _ => target.to_path_buf(),
    };
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = target.with_file_name(format!(".{}.rf-part", name));
    // Leftover of an interrupted upload (only a regular file is removed)
    if sftp.lstat(&tmp).map(|st| st.is_file()).unwrap_or(false) {
        let _ = sftp.unlink(&tmp);
    }
    let mut dst = sftp
        .open_mode(&tmp, ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE, 0o644, ssh2::OpenType::File)
        .map_err(|e| tr!("Błąd tworzenia pliku zdalnego {}: {}", "Error creating remote file {}: {}", remote_path_string(&tmp), e))?;
    let result = copy_with_progress(src, &mut dst, cancel, on_block)
        .map_err(|e| tr!("Błąd przesyłania {}: {}", "Error uploading {}: {}", name, e))
        .and_then(|n| {
            drop(dst);
            replace_remote(sftp, &tmp, &target).map(|_| n)
        });
    if result.is_err() {
        // The target is untouched; only the temporary file is removed
        let _ = sftp.unlink(&tmp);
    }
    result
}

/// Puts a completely uploaded temporary file in place of `target`. SFTP (version 3, OpenSSH)
/// cannot rename over an existing file, so an existing target is first moved aside, the new
/// file renamed into place and only then the old one deleted; if that fails, the old file is
/// put back. The permissions of a replaced file are kept (e.g. executable scripts).
fn replace_remote(sftp: &ssh2::Sftp, tmp: &Path, target: &Path) -> Result<(), String> {
    let existing = sftp.stat(target).ok().filter(|st| !st.is_dir());
    if let Some(perm) = existing.as_ref().and_then(|st| st.perm) {
        let stat = ssh2::FileStat { size: None, uid: None, gid: None, perm: Some(perm & 0o7777), atime: None, mtime: None };
        let _ = sftp.setstat(tmp, stat);
    }
    let flags = Some(ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE);
    let save_err = |e: ssh2::Error| tr!("Błąd zapisu pliku zdalnego {}: {}", "Error saving remote file {}: {}", remote_path_string(target), e);
    match sftp.rename(tmp, target, flags) {
        Ok(()) => return Ok(()),
        Err(e) if existing.is_none() => return Err(save_err(e)),
        Err(_) => {}
    }
    let name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let old = target.with_file_name(format!(".{}.rf-old", name));
    if sftp.lstat(&old).map(|st| st.is_file()).unwrap_or(false) {
        let _ = sftp.unlink(&old);
    }
    sftp.rename(target, &old, flags).map_err(save_err)?;
    match sftp.rename(tmp, target, flags) {
        Ok(()) => {
            let _ = sftp.unlink(&old);
            Ok(())
        }
        Err(e) => {
            let _ = sftp.rename(&old, target, flags);
            Err(save_err(e))
        }
    }
}

pub fn upload_paths(
    config: &SshConnectionConfig,
    local_paths: &[String],
    remote_dir: &str,
    progress: Progress,
    cancel: Cancel,
) -> Result<TransferSummary, String> {
    let (_sess, sftp) = crate::session::sftp::sftp_connect(config)?;
    let remote_dir = if remote_dir.is_empty() || remote_dir == "~" {
        sftp.realpath(Path::new(".")).unwrap_or_else(|_| PathBuf::from("/"))
    } else {
        PathBuf::from(remote_dir)
    };
    let mut sum = TransferSummary::default();
    for lp in local_paths {
        upload_one(&sftp, Path::new(lp), &remote_dir, 0, &mut sum, progress, cancel);
        if sum.cancelled {
            break;
        }
    }
    Ok(sum)
}

fn download_one(
    sftp: &ssh2::Sftp,
    remote: &Path,
    stat: &ssh2::FileStat,
    local_dir: &Path,
    depth: u32,
    sum: &mut TransferSummary,
    progress: Progress,
    cancel: Cancel,
) {
    if cancel.load(Ordering::Relaxed) {
        sum.cancelled = true;
        return;
    }
    if depth > MAX_DEPTH {
        sum.fail(tr!("Zbyt głębokie zagnieżdżenie: {}", "Nesting too deep: {}", remote_path_string(remote)));
        return;
    }
    // Symbolic links: downloaded with the content of their target; a link to a folder inside a
    // downloaded folder is not followed (loops / huge trees) – it is counted instead.
    let target_stat;
    let stat = if is_remote_symlink(stat) {
        match sftp.stat(remote) {
            Ok(t) if t.is_dir() && depth > 0 => {
                sum.skipped_links += 1;
                return;
            }
            Ok(t) => {
                target_stat = t;
                &target_stat
            }
            Err(_) => {
                sum.fail(tr!("Uszkodzone dowiązanie: {}", "Broken link: {}", remote_path_string(remote)));
                return;
            }
        }
    } else {
        stat
    };
    let raw_name = remote.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    // Names come from the server – never let them escape the target folder.
    let name = match sanitize_name(&raw_name) {
        Ok(n) => n,
        Err(e) => {
            sum.fail(e);
            return;
        }
    };
    let target = local_dir.join(&name);
    // Never write through an existing local symbolic link: a link named like the downloaded
    // item would send the data wherever it points (outside the chosen folder).
    if is_local_link(&target) {
        sum.fail(tr!(
            "Pominięto {}: w katalogu docelowym jest dowiązanie symboliczne o tej nazwie",
            "Skipped {}: the target folder contains a symbolic link with this name",
            display_path(&target)
        ));
        return;
    }

    if stat.is_dir() {
        let created = if target.is_dir() { Ok(()) } else { std::fs::create_dir(&target) };
        if let Err(e) = created {
            sum.fail(tr!("Nie można utworzyć katalogu {}: {}", "Cannot create folder {}: {}", display_path(&target), e));
            return;
        }
        sum.folders += 1;
        match sftp.readdir(remote) {
            Ok(entries) => {
                for (path, child_stat) in entries {
                    let child_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if child_name == "." || child_name == ".." {
                        continue;
                    }
                    download_one(sftp, &path, &child_stat, &target, depth + 1, sum, progress, cancel);
                    if sum.cancelled {
                        return;
                    }
                }
            }
            Err(e) => sum.fail(tr!("Błąd odczytu katalogu zdalnego {}: {}", "Error reading remote folder {}: {}", remote_path_string(remote), e)),
        }
    } else {
        let (files, base) = (sum.files, sum.bytes);
        progress(files, &name, base);
        let result = sftp
            .open(remote)
            .map_err(|e| tr!("Nie można otworzyć {}: {}", "Cannot open {}: {}", remote_path_string(remote), e))
            .and_then(|mut src| download_to(&mut src, &target, &name, cancel, &mut |done| progress(files, &name, base + done)));
        match result {
            Ok(n) => {
                sum.files += 1;
                sum.bytes += n;
            }
            // The partial download was discarded by `download_to`; an existing file is untouched
            Err(_) if cancel.load(Ordering::Relaxed) => sum.cancelled = true,
            Err(e) => sum.fail(e),
        }
    }
}

fn is_local_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

/// Writes a downloaded file safely: into a new temporary file next to the target (created with
/// `create_new`, which never follows links) that replaces the target only when complete. A
/// rename replaces a directory entry and never follows a link, so even a link created in the
/// meantime cannot redirect the data; an interrupted download also leaves the old file intact.
fn download_to(
    src: &mut dyn std::io::Read,
    target: &Path,
    name: &str,
    cancel: Cancel,
    on_block: &mut dyn FnMut(u64),
) -> Result<u64, String> {
    let tmp = target.with_file_name(format!(".{}.rf-part", name));
    let _ = std::fs::remove_file(&tmp); // leftover of an interrupted download (or a planted link – only the link is removed)
    let result = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| tr!("Błąd tworzenia pliku {}: {}", "Error creating file {}: {}", display_path(target), e))
        .and_then(|mut dst| {
            copy_with_progress(src, &mut dst, cancel, on_block).map_err(|e| tr!("Błąd pobierania {}: {}", "Error downloading {}: {}", name, e))
        })
        .and_then(|n| {
            if is_local_link(target) {
                return Err(tr!(
                    "Pominięto {}: w katalogu docelowym jest dowiązanie symboliczne o tej nazwie",
                    "Skipped {}: the target folder contains a symbolic link with this name",
                    display_path(target)
                ));
            }
            std::fs::rename(&tmp, target)
                .map(|_| n)
                .map_err(|e| tr!("Błąd zapisu pliku {}: {}", "Error saving file {}: {}", display_path(target), e))
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub fn download_paths(
    config: &SshConnectionConfig,
    remote_paths: &[String],
    local_dir: &str,
    progress: Progress,
    cancel: Cancel,
) -> Result<TransferSummary, String> {
    let local_dir = if local_dir.trim().is_empty() {
        dirs::download_dir().or_else(dirs::home_dir).ok_or(tr!("Brak katalogu docelowego", "No target folder"))?
    } else {
        PathBuf::from(local_dir)
    };
    if !local_dir.is_dir() {
        return Err(tr!("Katalog docelowy nie istnieje: {}", "The target folder does not exist: {}", display_path(&local_dir)));
    }
    let (_sess, sftp) = crate::session::sftp::sftp_connect(config)?;
    let mut sum = TransferSummary::default();
    for rp in remote_paths {
        let p = Path::new(rp);
        match sftp.lstat(p) {
            Ok(stat) => download_one(&sftp, p, &stat, &local_dir, 0, &mut sum, progress, cancel),
            Err(e) => sum.fail(tr!("Nie można odczytać {}: {}", "Cannot read {}: {}", rp, e)),
        }
        if sum.cancelled {
            break;
        }
    }
    Ok(sum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_sanitised() {
        assert!(sanitize_name("raport.pdf").is_ok());
        assert!(sanitize_name("zażółć").is_ok());
        assert!(sanitize_name("..").is_err());
        assert!(sanitize_name("a/b").is_err());
        assert!(sanitize_name("a\\b").is_err());
        assert!(sanitize_name("").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn download_never_writes_through_links() {
        let base = std::env::temp_dir().join(format!("rf-dl-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("dst")).unwrap();
        std::fs::write(base.join("victim.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(base.join("victim.txt"), base.join("dst").join("raport.txt")).unwrap();
        let mut src: &[u8] = b"downloaded";
        let err = download_to(&mut src, &base.join("dst").join("raport.txt"), "raport.txt", &AtomicBool::new(false), &mut |_| {});
        assert!(err.is_err());
        assert_eq!(std::fs::read(base.join("victim.txt")).unwrap(), b"keep", "link target untouched");
        assert!(!base.join("dst").join(".raport.txt.rf-part").exists());
        // normal file: written and replaced atomically
        let mut src: &[u8] = b"new";
        std::fs::write(base.join("dst").join("a.txt"), b"old").unwrap();
        assert_eq!(download_to(&mut src, &base.join("dst").join("a.txt"), "a.txt", &AtomicBool::new(false), &mut |_| {}).unwrap(), 3);
        assert_eq!(std::fs::read(base.join("dst").join("a.txt")).unwrap(), b"new");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn remote_paths_use_forward_slashes() {
        let joined = Path::new("/etc").join("apport");
        assert_eq!(remote_path_string(&joined), "/etc/apport");
        assert_eq!(remote_path_string(Path::new("/")), "/");
    }

    #[test]
    fn verbatim_prefix_is_removed() {
        assert_eq!(display_path(Path::new(r"\\?\C:\Users\jan")), r"C:\Users\jan");
        assert_eq!(display_path(Path::new(r"\\?\UNC\srv\share")), r"\\srv\share");
        assert_eq!(display_path(Path::new("/home/jan")), "/home/jan");
    }

    #[test]
    fn local_mkdir_and_search() {
        let base = std::env::temp_dir().join(format!("rf-transfer-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("a").join("b")).unwrap();
        std::fs::write(base.join("a").join("b").join("Raport-2026.txt"), "x").unwrap();
        let created = local_mkdir(base.to_str().unwrap(), "Nowy katalog").unwrap();
        let file = local_mkfile(base.to_str().unwrap(), "notatka.txt").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"");
        assert!(local_mkfile(base.to_str().unwrap(), "notatka.txt").is_err(), "an existing file is never overwritten");
        assert!(local_mkfile(base.to_str().unwrap(), "../x.txt").is_err());
        std::fs::remove_file(&file).unwrap();
        assert!(Path::new(&created).is_dir());
        assert!(local_mkdir(base.to_str().unwrap(), "Nowy katalog").is_err());
        assert!(local_mkdir(base.to_str().unwrap(), "../x").is_err());
        let found = local_search(base.to_str().unwrap(), "raport").unwrap();
        assert_eq!(found.len(), 1);
        assert!(!found[0].is_dir);
        let _ = std::fs::remove_dir_all(&base);
    }
}

/// End-to-end test against a local sshd (127.0.0.1:2222, user rftest / Test-Pass-123).
#[cfg(test)]
pub(crate) mod sftp_e2e {
    use super::*;
    use crate::session::ssh::HostKeyVerifier;
    use crate::vault::known_hosts::HostTrust;

    pub(crate) fn config() -> SshConnectionConfig {
        SshConnectionConfig {
            auth_type: "password".into(),
            certificate: None,
            host: "127.0.0.1".into(),
            port: 2222,
            username: "rftest".into(),
            password: Some("Test-Pass-123".into()),
            private_key: None,
            passphrase: None,
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
            jump: None,
        }
    }

    /// Upload over an existing remote file: the old content stays until the new file is complete
    /// (also when the upload is cancelled), the replaced file keeps its permissions, a link on the
    /// server keeps pointing at the updated file, and no temporary files are left.
    #[test]
    #[ignore]
    fn upload_replaces_existing_file_only_when_complete() {
        let cfg = config();
        let base = std::env::temp_dir().join(format!("rf-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("skrypt.sh");
        std::fs::write(&file, vec![b'n'; 20 * 1024 * 1024]).unwrap();
        let remote_root = with_pooled_sftp("r", &cfg, |sftp| {
            let home = sftp.realpath(Path::new(".")).unwrap();
            let _ = remote_delete(sftp, &home.join("e2e-replace").to_string_lossy());
            remote_mkdir(sftp, &home.to_string_lossy(), "e2e-replace")
        })
        .unwrap();
        let remote_file = format!("{remote_root}/skrypt.sh");
        let read_remote = |p: &str| {
            with_pooled_sftp("r", &cfg, |sftp| {
                let mut f = sftp.open(Path::new(p)).map_err(|e| e.to_string())?;
                let mut v = Vec::new();
                std::io::Read::read_to_end(&mut f, &mut v).map_err(|e| e.to_string())?;
                Ok(v)
            })
            .unwrap()
        };
        with_pooled_sftp("r", &cfg, |sftp| {
            let mut f = sftp.create(Path::new(&remote_file)).map_err(|e| e.to_string())?;
            std::io::Write::write_all(&mut f, b"stara wersja").map_err(|e| e.to_string())?;
            drop(f);
            let st = ssh2::FileStat { size: None, uid: None, gid: None, perm: Some(0o750), atime: None, mtime: None };
            sftp.setstat(Path::new(&remote_file), st).map_err(|e| e.to_string())?;
            sftp.symlink(Path::new("skrypt.sh"), Path::new(&format!("{remote_root}/link.sh"))).map_err(|e| e.to_string())
        })
        .unwrap();

        // Cancelled in the middle: the old file is intact, no temporary file
        let cancel = AtomicBool::new(false);
        let mut progress = |_: u32, _: &str, bytes: u64| {
            if bytes > 2 * 1024 * 1024 {
                cancel.store(true, Ordering::SeqCst);
            }
        };
        let up = upload_paths(&cfg, &[file.to_string_lossy().to_string()], &remote_root, &mut progress, &cancel).unwrap();
        assert!(up.cancelled, "{up:?}");
        assert_eq!(read_remote(&remote_file), b"stara wersja");

        // Complete: replaced, permissions kept
        let up = upload_paths(&cfg, &[file.to_string_lossy().to_string()], &remote_root, &mut |_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!((up.files, up.failed), (1, 0), "{up:?}");
        assert_eq!(read_remote(&remote_file).len(), 20 * 1024 * 1024);
        let perm = with_pooled_sftp("r", &cfg, |sftp| sftp.stat(Path::new(&remote_file)).map_err(|e| e.to_string())).unwrap().perm.unwrap();
        assert_eq!(perm & 0o777, 0o750);

        // Upload under the link's name: the link stays, the file it points to is updated
        std::fs::write(base.join("link.sh"), b"przez link").unwrap();
        let up = upload_paths(&cfg, &[base.join("link.sh").to_string_lossy().to_string()], &remote_root, &mut |_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!((up.files, up.failed), (1, 0), "{up:?}");
        assert_eq!(read_remote(&remote_file), b"przez link");
        let (_, listing) = with_pooled_sftp("r", &cfg, |sftp| remote_list(sftp, &remote_root)).unwrap();
        let names: Vec<_> = listing.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["link.sh", "skrypt.sh"], "no temporary files: {names:?}");
        assert!(listing.iter().any(|e| e.name == "link.sh" && e.is_link), "{listing:?}");

        with_pooled_sftp("r", &cfg, |sftp| remote_delete(sftp, &remote_root)).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    /// "Przerwij": a cancelled upload deletes the unfinished remote file, a cancelled download
    /// leaves the existing local file untouched and no partial file behind.
    #[test]
    #[ignore]
    fn cancelled_transfers_leave_no_partial_files() {
        let cfg = config();
        let base = std::env::temp_dir().join(format!("rf-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let big = base.join("duzy.bin");
        std::fs::write(&big, vec![5u8; 40 * 1024 * 1024]).unwrap();
        let remote_root = with_pooled_sftp("c", &cfg, |sftp| {
            let home = sftp.realpath(Path::new(".")).unwrap();
            let _ = remote_delete(sftp, &home.join("e2e-cancel").to_string_lossy());
            remote_mkdir(sftp, &home.to_string_lossy(), "e2e-cancel")
        })
        .unwrap();

        // Upload: cancel after ~4 MB
        let cancel = AtomicBool::new(false);
        let mut progress = |_: u32, _: &str, bytes: u64| {
            if bytes > 4 * 1024 * 1024 {
                cancel.store(true, Ordering::SeqCst);
            }
        };
        let up = upload_paths(&cfg, &[big.to_string_lossy().to_string()], &remote_root, &mut progress, &cancel).unwrap();
        assert!(up.cancelled && up.files == 0 && up.failed == 0, "{up:?}");
        let (_, listing) = with_pooled_sftp("c", &cfg, |sftp| remote_list(sftp, &remote_root)).unwrap();
        assert!(listing.is_empty(), "partial remote file deleted: {listing:?}");

        // Full upload, then a cancelled download over an existing local file
        let up = upload_paths(&cfg, &[big.to_string_lossy().to_string()], &remote_root, &mut |_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(up.files, 1);
        let dst = base.join("dst");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("duzy.bin"), b"stara wersja").unwrap();
        let cancel = AtomicBool::new(false);
        let mut progress = |_: u32, _: &str, bytes: u64| {
            if bytes > 4 * 1024 * 1024 {
                cancel.store(true, Ordering::SeqCst);
            }
        };
        let down = download_paths(&cfg, &[format!("{remote_root}/duzy.bin")], dst.to_str().unwrap(), &mut progress, &cancel).unwrap();
        assert!(down.cancelled && down.files == 0 && down.failed == 0, "{down:?}");
        assert_eq!(std::fs::read(dst.join("duzy.bin")).unwrap(), b"stara wersja");
        let names: Vec<_> = std::fs::read_dir(&dst).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 1, "no .rf-part left: {names:?}");

        // Cancel before start: nothing happens
        let pre = AtomicBool::new(true);
        let down = download_paths(&cfg, &[format!("{remote_root}/duzy.bin")], dst.to_str().unwrap(), &mut |_, _, _| {}, &pre).unwrap();
        assert!(down.cancelled && down.files == 0);

        with_pooled_sftp("c", &cfg, |sftp| remote_delete(sftp, &remote_root)).unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[ignore]
    fn upload_search_download_delete() {
        let cfg = config();
        let base = std::env::temp_dir().join(format!("rf-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(src.join("projekt").join(".git")).unwrap();
        std::fs::write(src.join("projekt").join(".git").join("HEAD"), "ref").unwrap();
        std::fs::write(src.join("projekt").join("zażółć.txt"), vec![7u8; 700_000]).unwrap();
        std::fs::write(src.join("pojedynczy.bin"), b"abc").unwrap();

        // remote working folder
        let remote_root = with_pooled_sftp("k", &cfg, |sftp| {
            let home = sftp.realpath(Path::new(".")).unwrap();
            let _ = remote_delete(sftp, &home.join("e2e").to_string_lossy());
            remote_mkdir(sftp, &home.to_string_lossy(), "e2e")
        })
        .unwrap();

        let mut events = 0;
        let mut progress = |_: u32, _: &str, _: u64| events += 1;
        let up = upload_paths(
            &cfg,
            &[
                src.join("projekt").to_string_lossy().to_string(),
                src.join("pojedynczy.bin").to_string_lossy().to_string(),
            ],
            &remote_root,
            &mut progress,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(up.failed, 0, "{:?}", up.errors);
        assert_eq!(up.files, 3, ".git content is no longer skipped");
        assert_eq!(up.bytes, 700_000 + 3 + 3);
        assert!(events >= 3);

        let (_, listing) = with_pooled_sftp("k", &cfg, |sftp| remote_list(sftp, &remote_root)).unwrap();
        let names: Vec<_> = listing.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["projekt", "pojedynczy.bin"], "dirs first");

        let found = with_pooled_sftp("k", &cfg, |sftp| remote_search(sftp, &remote_root, "ZAŻÓŁĆ")).unwrap();
        assert_eq!(found.len(), 1);

        let dst = base.join("dst");
        std::fs::create_dir_all(&dst).unwrap();
        let down = download_paths(
            &cfg,
            &[format!("{}/projekt", remote_root), format!("{}/pojedynczy.bin", remote_root)],
            dst.to_str().unwrap(),
            &mut |_, _, _| {},
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(down.failed, 0, "{:?}", down.errors);
        assert_eq!(down.files, 3);
        assert_eq!(std::fs::read(dst.join("projekt").join("zażółć.txt")).unwrap().len(), 700_000);
        assert_eq!(std::fs::read(dst.join("pojedynczy.bin")).unwrap(), b"abc");

        // pooled session survives and is reused; delete recursively
        let n = with_pooled_sftp("k", &cfg, |sftp| {
            remote_delete(sftp, &format!("{}/projekt", remote_root))?;
            Ok(remote_list(sftp, &remote_root)?.1.len())
        })
        .unwrap();
        assert_eq!(n, 1);
        assert!(with_pooled_sftp("k", &cfg, |sftp| remote_mkdir(sftp, &remote_root, "../evil")).is_err());

        with_pooled_sftp("k", &cfg, |sftp| remote_delete(sftp, &remote_root)).unwrap();
        release_pooled("k");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    #[ignore]
    fn symlinks_are_listed_and_followed() {
        use std::os::unix::fs::symlink;
        let cfg = config();
        let base = std::env::temp_dir().join(format!("rf-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        std::fs::write(src.join("sub").join("b.txt"), b"bb").unwrap();
        symlink(src.join("a.txt"), src.join("la")).unwrap(); // link to a file
        symlink(src.join("sub"), src.join("ld")).unwrap(); // link to a folder
        symlink(src.join("missing"), src.join("lb")).unwrap(); // broken link
        symlink("..", src.join("sub").join("loop")).unwrap(); // loop

        // Local listing shows links with the type / size of the target
        let la = local_entry(&src.join("la")).unwrap();
        assert!(la.is_link && !la.is_dir && la.size == 5);
        let ld = local_entry(&src.join("ld")).unwrap();
        assert!(ld.is_link && ld.is_dir);
        let lb = local_entry(&src.join("lb")).unwrap();
        assert!(lb.is_link && !lb.is_dir);

        let remote_root = with_pooled_sftp("links", &cfg, |sftp| {
            let home = sftp.realpath(Path::new(".")).unwrap();
            let _ = remote_delete(sftp, &home.join("e2e-links").to_string_lossy());
            remote_mkdir(sftp, &home.to_string_lossy(), "e2e-links")
        })
        .unwrap();

        // Upload of the folder: file links copied with content, folder links inside not followed
        let up = upload_paths(&cfg, &[src.to_string_lossy().to_string()], &remote_root, &mut |_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(up.files, 3, "a.txt, la, sub/b.txt: {:?}", up.errors);
        assert_eq!(up.skipped_links, 2, "ld and sub/loop");
        assert_eq!(up.failed, 1, "broken link reported");
        // A folder link chosen directly is followed
        let up2 = upload_paths(&cfg, &[src.join("ld").to_string_lossy().to_string()], &remote_root, &mut |_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!((up2.files, up2.skipped_links, up2.failed), (1, 1, 0));

        // Remote links (the test server runs on this machine): listed and downloaded the same way
        let remote_src = PathBuf::from(format!("{}/src", remote_root));
        symlink("a.txt", remote_src.join("rl")).unwrap();
        symlink("sub", remote_src.join("rd")).unwrap();
        let (_, listing) = with_pooled_sftp("links", &cfg, |sftp| remote_list(sftp, &remote_src.to_string_lossy())).unwrap();
        let rl = listing.iter().find(|e| e.name == "rl").unwrap();
        assert!(rl.is_link && !rl.is_dir && rl.size == 5);
        let rd = listing.iter().find(|e| e.name == "rd").unwrap();
        assert!(rd.is_link && rd.is_dir);

        let dst = base.join("dst");
        std::fs::create_dir_all(&dst).unwrap();
        let down = download_paths(&cfg, &[remote_src.to_string_lossy().to_string()], dst.to_str().unwrap(), &mut |_, _, _| {}, &AtomicBool::new(false)).unwrap();
        assert_eq!(down.failed, 0, "{:?}", down.errors);
        assert_eq!(std::fs::read(dst.join("src").join("rl")).unwrap(), b"hello");
        assert_eq!(down.skipped_links, 1, "rd not followed inside a folder");

        with_pooled_sftp("links", &cfg, |sftp| remote_delete(sftp, &remote_root)).unwrap();
        release_pooled("links");
        let _ = std::fs::remove_dir_all(&base);
    }
}

#[cfg(test)]
mod local_delete_tests {
    use super::*;

    #[test]
    fn permanent_delete_keeps_link_targets_and_refuses_roots() {
        let base = std::env::temp_dir().join(format!("rf-localdel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let outside = base.join("outside");
        let dir = base.join("dir/sub");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(outside.join("keep.txt"), "keep").unwrap();
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, base.join("dir/link")).unwrap();
        let file = base.join("file.txt");
        std::fs::write(&file, "x").unwrap();

        local_delete(&file.to_string_lossy(), true).unwrap();
        assert!(!file.exists());
        local_delete(&base.join("dir").to_string_lossy(), true).unwrap();
        assert!(!base.join("dir").exists());
        // The folder a link inside pointed to is untouched
        assert_eq!(std::fs::read_to_string(outside.join("keep.txt")).unwrap(), "keep");

        assert!(local_delete("/", true).is_err());
        if let Some(home) = dirs::home_dir() {
            assert!(local_delete(&home.to_string_lossy(), true).is_err());
            assert!(home.exists());
        }
        assert!(local_delete("relative/path", true).is_err());
        assert!(local_delete(&base.join("missing").to_string_lossy(), true).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
