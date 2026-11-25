//! Windows-only helpers.
//!
//! Every helper process is started with `CREATE_NO_WINDOW`. Without it each PowerShell call
//! opened a visible console window that stole focus from the app; the returning focus fired the
//! RDP tab's clipboard sync, which started PowerShell again – an endless loop of console windows
//! that also kept the RDP session from being established.

#[cfg(target_os = "windows")]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn hidden_command(program: &str) -> Command {
        let mut cmd = Command::new(program);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// Runs a PowerShell script without a console window. Output is forced to UTF-8 so paths with
    /// Polish characters are not garbled by the OEM code page.
    pub fn powershell(script: &str) -> Option<String> {
        let full = format!(
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; {}",
            script
        );
        let out = hidden_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-Command", full.as_str()])
            .stdin(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Prefix for WinForms dialogs: a top-most owner so the dialog is not hidden behind the app.
    pub const DIALOG_PRELUDE: &str = "Add-Type -AssemblyName System.Windows.Forms; \
        $owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false};";

    // Native clipboard access (no child processes at all).
    pub fn clipboard_get_text() -> String {
        clipboard_win::get_clipboard_string().unwrap_or_default()
    }

    pub fn clipboard_set_text(text: &str) {
        let _ = clipboard_win::set_clipboard_string(text);
    }

    /// Text that is a password: marked so that Windows keeps it out of the clipboard history
    /// (Win+V) and cloud clipboard sync, and clipboard monitors ignore it (the formats password
    /// managers use; older Windows versions simply ignore them).
    pub fn clipboard_set_secret(text: &str) -> Result<(), String> {
        let _clip = clipboard_win::Clipboard::new_attempts(10)
            .map_err(|e| tr!("Nie można otworzyć schowka: {:?}", "Cannot open the clipboard: {:?}", e))?;
        clipboard_win::raw::set_string_with(text, clipboard_win::options::DoClear)
            .map_err(|e| tr!("Nie można zapisać tekstu w schowku: {:?}", "Cannot put the text on the clipboard: {:?}", e))?;
        let zero = 0u32.to_le_bytes();
        for name in ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"] {
            if let Some(fmt) = clipboard_win::raw::register_format(name) {
                let _ = clipboard_win::raw::set_without_clear(fmt.get(), &zero);
            }
        }
        Ok(())
    }

    /// Empties the clipboard.
    pub fn clipboard_clear() {
        if let Ok(_clip) = clipboard_win::Clipboard::new_attempts(10) {
            let _ = clipboard_win::raw::empty();
        }
    }

    /// Replaces the clipboard content with a file list (CF_HDROP) + "Preferred DropEffect = copy",
    /// so Explorer pastes (copies) the files.
    pub fn clipboard_set_files(paths: &[String]) -> Result<(), String> {
        let _clip = clipboard_win::Clipboard::new_attempts(10)
            .map_err(|e| tr!("Nie można otworzyć schowka: {:?}", "Cannot open the clipboard: {:?}", e))?;
        clipboard_win::raw::set_file_list_with(paths, clipboard_win::options::DoClear)
            .map_err(|e| tr!("Nie można zapisać listy plików w schowku: {:?}", "Cannot put the file list on the clipboard: {:?}", e))?;
        if let Some(fmt) = clipboard_win::raw::register_format("Preferred DropEffect") {
            const DROPEFFECT_COPY: u32 = 1;
            let _ = clipboard_win::raw::set_without_clear(fmt.get(), &DROPEFFECT_COPY.to_le_bytes());
        }
        Ok(())
    }

    /// Clipboard sequence number – changes on every clipboard modification.
    pub fn clipboard_sequence() -> Option<u32> {
        clipboard_win::raw::seq_num().map(|n| n.get())
    }

    pub fn clipboard_get_files() -> Vec<String> {
        clipboard_win::get_clipboard::<Vec<String>, _>(clipboard_win::formats::FileList).unwrap_or_default()
    }
}

#[cfg(target_os = "windows")]
pub use imp::*;
