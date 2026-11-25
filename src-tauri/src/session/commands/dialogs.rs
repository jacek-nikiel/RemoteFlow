//! Native dialogs (folder, SSH key and certificate files) and window commands.

#[cfg(target_os = "windows")]
use crate::session::winproc;
use serde::Serialize;

#[tauri::command]
pub async fn pick_local_folder() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            let script = tr!(
                "{} $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Wybierz katalog'; if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.SelectedPath }}", "{} $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Choose a folder'; if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.SelectedPath }}",
                winproc::DIALOG_PRELUDE
            );
            if let Some(out) = winproc::powershell(&script) {
                let s = out.trim().to_string();
                if !s.is_empty() {
                    return Ok(Some(s));
                }
            }
            return Ok(None);
        }

        #[cfg(not(target_os = "windows"))]
        {
            let home = dirs::home_dir()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string());

            if let Ok(out) = std::process::Command::new("kdialog")
                .arg("--getexistingdirectory")
                .arg(&home)
                .arg("--title")
                .arg(tr!("Wybierz katalog do przesłania", "Choose a folder to upload"))
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            if let Ok(out) = std::process::Command::new("zenity")
                .arg("--file-selection")
                .arg("--directory")
                .arg(tr!("--title=Wybierz katalog do przesłania", "--title=Choose a folder to upload"))
                .arg(format!("--filename={}/", home))
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            Ok(None)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Native "open file" dialog (blocking). Not exposed to the UI as a command: the UI never gets
/// to choose which local file the backend reads.
fn pick_file_dialog(title: Option<String>) -> Result<Option<String>, String> {
    {
        let dialog_title = title.unwrap_or_else(|| tr!("Wybierz plik klucza prywatnego SSH", "Choose the SSH private key file").to_string());
        #[cfg(target_os = "windows")]
        {
            let script = format!(
                "{} $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Multiselect = $false; $f.Title = '{}'; if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.FileName }}",
                winproc::DIALOG_PRELUDE,
                dialog_title.replace('\'', "''")
            );
            if let Some(out) = winproc::powershell(&script) {
                let s = out.trim().to_string();
                if !s.is_empty() {
                    return Ok(Some(s));
                }
            }
            return Ok(None);
        }

        #[cfg(not(target_os = "windows"))]
        {
            let home = dirs::home_dir()
                .map(|h| h.join(".ssh").to_string_lossy().to_string())
                .unwrap_or_else(|| "/".to_string());

            if let Ok(out) = std::process::Command::new("kdialog")
                .arg("--getopenfilename")
                .arg(&home)
                .arg("--title")
                .arg(&dialog_title)
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            if let Ok(out) = std::process::Command::new("zenity")
                .arg("--file-selection")
                .arg(format!("--title={}", dialog_title))
                .arg(format!("--filename={}/", home))
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(s));
                    }
                }
                return Ok(None);
            }

            Ok(None)
        }
    }
}

/// Native "Save as" dialog (blocking). `None` = cancelled. Without a dialog program on Linux
/// (zenity / kdialog) the file goes to the downloads folder under a free name.
fn save_file_dialog(title: &str, default_name: &str, filter_name: &str, extension: &str) -> Result<Option<std::path::PathBuf>, String> {
    #[cfg(target_os = "windows")]
    {
        let q = |v: &str| v.replace('\'', "''");
        let script = format!(
            "{} $f = New-Object System.Windows.Forms.SaveFileDialog; $f.Title = '{}'; $f.FileName = '{}'; \
             $f.Filter = '{} (*.{ext})|*.{ext}|{} (*.*)|*.*'; $f.DefaultExt = '{ext}'; $f.AddExtension = $true; $f.OverwritePrompt = $true; \
             if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $f.FileName }}",
            winproc::DIALOG_PRELUDE,
            q(title),
            q(default_name),
            q(filter_name),
            q(tr!("Wszystkie pliki", "All files")),
            ext = extension
        );
        let chosen = winproc::powershell(&script).map(|o| o.trim().to_string()).filter(|s| !s.is_empty());
        return Ok(chosen.map(std::path::PathBuf::from));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let start_dir = dirs::document_dir().or_else(dirs::home_dir).unwrap_or_else(|| std::path::PathBuf::from("/"));
        let start = start_dir.join(default_name);
        let pattern = format!("*.{extension}");
        let finish = |out: std::process::Output| -> Option<std::path::PathBuf> {
            if !out.status.success() {
                return None;
            }
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() {
                return None;
            }
            let mut p = std::path::PathBuf::from(s);
            if p.extension().is_none() {
                p.set_extension(extension);
            }
            Some(p)
        };

        if let Ok(out) = std::process::Command::new("kdialog")
            .arg("--getsavefilename")
            .arg(&start)
            .arg(format!("{pattern}|{filter_name}"))
            .arg("--title")
            .arg(title)
            .output()
        {
            return Ok(finish(out));
        }
        if let Ok(out) = std::process::Command::new("zenity")
            .arg("--file-selection")
            .arg("--save")
            .arg(format!("--title={title}"))
            .arg(format!("--filename={}", start.display()))
            .arg(format!("--file-filter={filter_name} | {pattern}"))
            .output()
        {
            return Ok(finish(out));
        }

        // No dialog program: the downloads folder, never overwriting an existing file
        let dir = dirs::download_dir().or_else(dirs::home_dir).ok_or_else(|| {
            tr!("Nie znaleziono okna zapisu (zainstaluj zenity lub kdialog)", "No save dialog found (install zenity or kdialog)").to_string()
        })?;
        let stem = std::path::Path::new(default_name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut candidate = dir.join(default_name);
        let mut n = 1;
        while candidate.exists() {
            candidate = dir.join(format!("{stem} ({n}).{extension}"));
            n += 1;
        }
        Ok(Some(candidate))
    }
}

/// Saves a file the user exports (vault export, .rdp file) where they choose in the native
/// "Save as" dialog; returns the path, `None` when cancelled. The program's own data (vault,
/// backups) cannot be overwritten this way. Written owner-only on Unix – an export may hold
/// passwords in plain text.
#[tauri::command]
pub async fn save_file_as(
    default_name: String,
    content: String,
    filter_name: String,
    extension: String,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
) -> Result<Option<String>, String> {
    let access = crate::session::localfs::local_access(&auth_state)?;
    let extension: String = extension.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    let default_name: String = default_name.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).collect();
    let content = zeroize::Zeroizing::new(content);
    tokio::task::spawn_blocking(move || {
        let title = tr!("Zapisz plik", "Save file");
        let Some(path) = save_file_dialog(title, &default_name, &filter_name, &extension)? else {
            return Ok(None);
        };
        access.check(&path)?;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(&path)
            .map_err(|e| tr!("Nie można zapisać pliku '{}': {}", "Cannot save the file '{}': {}", path.display(), e))?;
        std::io::Write::write_all(&mut file, content.as_bytes())
            .map_err(|e| tr!("Nie można zapisać pliku '{}': {}", "Cannot save the file '{}': {}", path.display(), e))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct PickedKeyFile {
    pub path: String,
    pub content: String,
}

const MAX_KEY_FILE_BYTES: u64 = 64 * 1024;

/// Checks that a file chosen as an SSH private key really looks like one.
pub(crate) fn read_private_key_file(path: &std::path::Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    if !meta.is_file() || meta.len() > MAX_KEY_FILE_BYTES {
        return Err(tr!("Wybrany plik nie jest kluczem prywatnym SSH", "The selected file is not an SSH private key").to_string());
    }
    let content = std::fs::read_to_string(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    let looks_like_key = content.contains("PRIVATE KEY-----") || content.starts_with("PuTTY-User-Key-File-");
    if !looks_like_key {
        return Err(tr!("Wybrany plik nie jest kluczem prywatnym SSH", "The selected file is not an SSH private key").to_string());
    }
    Ok(content)
}

/// Opens the native file dialog and returns the chosen SSH private key. Replaces the former
/// `read_local_text_file(path)` command, which let the web layer read ANY file it named
/// (e.g. ~/.ssh/id_rsa) – a script injected into the UI could have stolen keys that way.
/// Now only a file the user explicitly picks in the system dialog is read.
#[tauri::command]
pub async fn pick_private_key_file(title: Option<String>) -> Result<Option<PickedKeyFile>, String> {
    tokio::task::spawn_blocking(move || {
        let Some(path) = pick_file_dialog(title)? else {
            return Ok(None);
        };
        let content = read_private_key_file(std::path::Path::new(&path))?;
        Ok(Some(PickedKeyFile { path, content }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Checks that a file chosen as an SSH certificate really is an OpenSSH certificate
/// (`ssh-ed25519-cert-v01@openssh.com AAAA… comment`).
pub(crate) fn read_certificate(path: &std::path::Path) -> Result<String, String> {
    let not_cert = || {
        tr!(
            "Wybrany plik nie jest certyfikatem SSH (oczekiwano pliku …-cert.pub)",
            "The selected file is not an SSH certificate (expected a …-cert.pub file)"
        )
        .to_string()
    };
    let meta = std::fs::metadata(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    if !meta.is_file() || meta.len() > MAX_KEY_FILE_BYTES {
        return Err(not_cert());
    }
    let content = std::fs::read_to_string(path).map_err(|e| tr!("Błąd odczytu pliku '{}': {}", "Error reading file '{}': {}", path.display(), e))?;
    if !looks_like_ssh_certificate(&content) {
        return Err(not_cert());
    }
    Ok(content.trim().to_string())
}

fn looks_like_ssh_certificate(content: &str) -> bool {
    let mut parts = content.split_whitespace();
    let kind = parts.next().unwrap_or("");
    kind.ends_with("-cert-v01@openssh.com") && parts.next().is_some_and(|b| b.starts_with("AAAA"))
}

/// Opens the native file dialog and returns the chosen SSH certificate (…-cert.pub).
#[tauri::command]
pub async fn pick_ssh_certificate_file(title: Option<String>) -> Result<Option<PickedKeyFile>, String> {
    tokio::task::spawn_blocking(move || {
        let title = title.unwrap_or_else(|| tr!("Wybierz plik certyfikatu SSH", "Choose the SSH certificate file").to_string());
        let Some(path) = pick_file_dialog(Some(title))? else {
            return Ok(None);
        };
        let content = read_certificate(std::path::Path::new(&path))?;
        Ok(Some(PickedKeyFile { path, content }))
    })
    .await
    .map_err(|e| e.to_string())?
}


/// Exits the application after the user confirmed it in the UI (the window close request is
/// intercepted by the frontend, so the window cannot simply be destroyed by the OS).
#[tauri::command]
pub fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn app_maximize_window(window: tauri::Window) -> Result<(), String> {
    window.maximize().map_err(|e| e.to_string())
}
