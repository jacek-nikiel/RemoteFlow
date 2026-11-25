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
