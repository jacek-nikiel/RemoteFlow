//! How this copy of RemoteFlow was installed, and updates of portable copies.
//!
//! Installed copies are updated by the updater plugin: it runs the system installer (Windows
//! NSIS/MSI), replaces the AppImage or installs the package (Linux). A portable copy (a loose
//! remoteflow.exe / binary, e.g. on a USB drive) must not do that – on Windows the installer would
//! put a second, separate copy in the installation folder. Portable copies download the portable
//! build instead (`{os}-{arch}-portable` entry of latest.json, signed like every package), and the
//! program file is replaced in place:
//! - Windows: a running .exe cannot be overwritten but can be renamed, so the old file becomes
//!   `remoteflow.exe.old` (removed at the next start) and the new one takes its name,
//! - Linux: the new file is renamed over the old one (the running process keeps the old inode).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallInfo {
    /// The updater plugin can install new versions in place (installer / AppImage / package).
    pub can_self_update: bool,
    /// "nsis" | "msi" | "appimage" | "package" | "pacman" | "portable"
    pub kind: &'static str,
}

fn has_marker(program_dir: Option<&Path>) -> bool {
    program_dir.is_some_and(|d| d.join(crate::vault::storage::PORTABLE_MARKER).is_file())
}

/// pacman's database of installed packages (Arch Linux and derivatives).
const PACMAN_LOCAL_DB: &str = "/var/lib/pacman/local";

/// The program file belongs to a pacman package (the release's .pkg.tar.zst or an AUR package):
/// a `remoteflow*` entry of the local database lists it in its `files`.
fn owned_by_pacman(db: &Path, exe: &Path) -> bool {
    let Ok(rel) = exe.strip_prefix("/") else { return false };
    let rel = rel.to_string_lossy();
    let Ok(entries) = std::fs::read_dir(db) else { return false };
    entries.flatten().any(|entry| {
        entry.file_name().to_string_lossy().starts_with("remoteflow")
            && std::fs::read_to_string(entry.path().join("files")).is_ok_and(|files| files.lines().any(|line| line == rel))
    })
}

fn classify(
    program_dir: Option<&Path>,
    exe: Option<&Path>,
    appimage: bool,
    program_files: &[&Path],
    pacman_db: Option<&Path>,
) -> InstallInfo {
    let portable = InstallInfo { can_self_update: false, kind: "portable" };
    if cfg!(windows) {
        // Explicit portable mode (also used for the vault location)
        if has_marker(program_dir) {
            return portable;
        }
        let Some(dir) = program_dir else { return portable };
        // NSIS (per-user or per-machine) leaves its uninstaller next to the program
        if dir.join("uninstall.exe").is_file() {
            return InstallInfo { can_self_update: true, kind: "nsis" };
        }
        // MSI installs into Program Files
        if program_files.iter().any(|pf| dir.starts_with(pf)) {
            return InstallInfo { can_self_update: true, kind: "msi" };
        }
        portable
    } else {
        // An AppImage is replaced as a whole by the updater – also in portable mode (marker next
        // to the .AppImage file): it stays a single file in the same place
        if appimage {
            return InstallInfo { can_self_update: true, kind: "appimage" };
        }
        if has_marker(program_dir) {
            return portable;
        }
        // .deb / .rpm / pacman install the program into /usr/bin
        if let Some(exe) = exe.filter(|e| e.starts_with("/usr/")) {
            // The updater plugin knows only .deb / .rpm / AppImage – a pacman package is updated
            // with pacman (the notice links to the releases page)
            if pacman_db.is_some_and(|db| owned_by_pacman(db, exe)) {
                return InstallInfo { can_self_update: false, kind: "pacman" };
            }
            return InstallInfo { can_self_update: true, kind: "package" };
        }
        portable
    }
}

fn install_info() -> InstallInfo {
    let exe = std::env::current_exe().ok();
    let appimage = std::env::var_os("APPIMAGE").is_some_and(|v| !v.is_empty());
    let pf: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|k| std::env::var_os(k).map(PathBuf::from))
        .collect();
    let pf_refs: Vec<&Path> = pf.iter().map(|p| p.as_path()).collect();
    classify(
        crate::vault::storage::program_dir().as_deref(),
        exe.as_deref(),
        appimage,
        &pf_refs,
        Some(Path::new(PACMAN_LOCAL_DB)),
    )
}

#[tauri::command]
pub fn app_install_info() -> InstallInfo {
    install_info()
}

/// latest.json entry with the portable build for this system, e.g. `windows-x86_64-portable`.
fn portable_target() -> String {
    let os = if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };
    format!("{os}-{}-portable", std::env::consts::ARCH)
}

/// The program file to replace. On Linux `current_exe` ends with " (deleted)" once the file was
/// replaced while running.
fn program_file() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let text = exe.to_string_lossy();
    Ok(match text.strip_suffix(" (deleted)") {
        Some(s) => PathBuf::from(s),
        None => exe,
    })
}

fn old_file(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".old");
    exe.with_file_name(name)
}

fn temp_file(exe: &Path) -> PathBuf {
    exe.with_file_name(".remoteflow-update.tmp")
}

/// Puts `bytes` in place of `exe`; on failure the old program file stays.
fn replace_program_file(exe: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = temp_file(exe);
    let not_writable = |e: std::io::Error| {
        tr!(
            "Nie można zapisać nowej wersji w folderze programu ({}). Pobierz ją ze strony wydań i zastąp plik ręcznie.",
            "Cannot save the new version in the program folder ({}). Download it from the releases page and replace the file manually.",
            e
        )
    };
    std::fs::write(&tmp, bytes).map_err(not_writable)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(exe).map(|m| m.permissions().mode()).unwrap_or(0o755) | 0o111;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    if cfg!(windows) {
        let old = old_file(exe);
        let _ = std::fs::remove_file(&old);
        if let Err(e) = std::fs::rename(exe, &old) {
            let _ = std::fs::remove_file(&tmp);
            return Err(not_writable(e));
        }
        if let Err(e) = std::fs::rename(&tmp, exe) {
            let _ = std::fs::rename(&old, exe); // put the old version back
            let _ = std::fs::remove_file(&tmp);
            return Err(not_writable(e));
        }
    } else if let Err(e) = std::fs::rename(&tmp, exe) {
        let _ = std::fs::remove_file(&tmp);
        return Err(not_writable(e));
    }
    Ok(())
}

/// Removes leftovers of a portable update (the previous program file on Windows). The old process
/// may still be closing, so removal is retried for a few seconds.
pub fn cleanup_after_update() {
    let Ok(exe) = program_file() else { return };
    let tmp = temp_file(&exe);
    let old = old_file(&exe);
    if !tmp.exists() && !old.exists() {
        return;
    }
    std::thread::spawn(move || {
        let _ = std::fs::remove_file(&tmp);
        for _ in 0..20 {
            if !old.exists() || std::fs::remove_file(&old).is_ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableUpdate {
    pub version: String,
    pub current_version: String,
    pub notes: String,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

async fn find_portable_update(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    if install_info().kind != "portable" {
        return Err("not a portable copy".into());
    }
    app.updater_builder()
        .target(portable_target())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())
}

/// Checks for a portable build newer than this copy. None = up to date (or the latest release has
/// no portable build for this system).
#[tauri::command]
pub async fn portable_update_check(app: tauri::AppHandle) -> Result<Option<PortableUpdate>, String> {
    Ok(find_portable_update(&app).await?.map(|u| PortableUpdate {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
        date: u.date.map(|d| d.to_string()),
    }))
}

/// Downloads the portable build (the updater verifies its signature), replaces the program file
/// and starts the new version.
#[tauri::command]
pub async fn portable_update_install(app: tauri::AppHandle, on_progress: Channel<DownloadProgress>) -> Result<(), String> {
    let update = find_portable_update(&app)
        .await?
        .ok_or_else(|| tr!("Brak nowszej wersji przenośnej.", "No newer portable version.").to_string())?;
    let exe = program_file()?;
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = on_progress.send(DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    replace_program_file(&exe, &bytes)?;
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    std::process::Command::new(&exe).args(args).spawn().map_err(|e| {
        tr!(
            "Nowa wersja jest zapisana, ale nie udało się jej uruchomić: {}",
            "The new version is saved but could not be started: {}",
            e
        )
    })?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("rf-install-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn install_kinds() {
        let base = temp_dir("kinds");
        let exe = base.join("remoteflow");
        if cfg!(windows) {
            assert_eq!(classify(Some(&base), Some(&exe), false, &[], None).kind, "portable");
            std::fs::write(base.join("uninstall.exe"), "").unwrap();
            assert_eq!(classify(Some(&base), Some(&exe), false, &[], None).kind, "nsis");
            std::fs::remove_file(base.join("uninstall.exe")).unwrap();
            assert_eq!(classify(Some(&base), Some(&exe), false, &[base.parent().unwrap()], None).kind, "msi");
            // The portable marker wins
            std::fs::write(base.join(crate::vault::storage::PORTABLE_MARKER), "").unwrap();
            assert_eq!(classify(Some(&base), Some(&exe), false, &[base.parent().unwrap()], None).kind, "portable");
        } else {
            assert_eq!(classify(Some(&base), Some(&exe), false, &[], None).kind, "portable");
            assert!(classify(Some(&base), Some(&exe), true, &[], None).can_self_update);
            assert_eq!(classify(Some(Path::new("/usr/bin")), Some(Path::new("/usr/bin/remoteflow")), false, &[], None).kind, "package");
            // Marker: a loose binary is portable, an AppImage is still replaced as a whole
            std::fs::write(base.join(crate::vault::storage::PORTABLE_MARKER), "").unwrap();
            let info = classify(Some(&base), Some(&exe), false, &[], None);
            assert_eq!(info, InstallInfo { can_self_update: false, kind: "portable" });
            assert_eq!(classify(Some(&base), Some(&exe), true, &[], None).kind, "appimage");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn pacman_package() {
        let db = temp_dir("pacman");
        let exe = Path::new("/usr/bin/remoteflow");
        let kind = |db: &Path| classify(Some(Path::new("/usr/bin")), Some(exe), false, &[], Some(db)).kind;
        // No database entry (e.g. Debian with pacman installed): still a .deb / .rpm
        assert_eq!(kind(&db), "package");
        assert_eq!(kind(Path::new("/nonexistent/pacman/local")), "package");
        // Another package's entry does not count
        std::fs::create_dir_all(db.join("other-1.0-1")).unwrap();
        std::fs::write(db.join("other-1.0-1/files"), "%FILES%\nusr/\nusr/bin/\nusr/bin/remoteflow\n").unwrap();
        assert_eq!(kind(&db), "package");
        // Our package (or an AUR one) listing the program file
        std::fs::create_dir_all(db.join("remoteflow-bin-1.16.0-1")).unwrap();
        std::fs::write(db.join("remoteflow-bin-1.16.0-1/files"), "%FILES%\nusr/\nusr/bin/\nusr/bin/remoteflow\n").unwrap();
        assert_eq!(kind(&db), "pacman");
        assert!(!classify(Some(Path::new("/usr/bin")), Some(exe), false, &[], Some(&db)).can_self_update);
        // Outside /usr (portable copy) the database is not consulted
        let home_exe = db.join("remoteflow");
        assert_eq!(classify(Some(&db), Some(&home_exe), false, &[], Some(&db)).kind, "portable");
        let _ = std::fs::remove_dir_all(&db);
    }

    #[test]
    fn replaces_the_program_file() {
        let base = temp_dir("replace");
        let exe = base.join(if cfg!(windows) { "remoteflow.exe" } else { "remoteflow" });
        std::fs::write(&exe, b"old version").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        replace_program_file(&exe, b"new version").unwrap();
        assert_eq!(std::fs::read(&exe).unwrap(), b"new version");
        assert!(!temp_file(&exe).exists());
        if cfg!(windows) {
            assert_eq!(std::fs::read(old_file(&exe)).unwrap(), b"old version");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // executable bit kept / added
            assert_eq!(std::fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o711);
        }
        let os = if cfg!(windows) { "windows" } else { "linux" };
        assert_eq!(portable_target(), format!("{os}-{}-portable", std::env::consts::ARCH));
        let _ = std::fs::remove_dir_all(&base);
    }
}
