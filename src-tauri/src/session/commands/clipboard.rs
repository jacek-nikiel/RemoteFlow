//! System clipboard: text, passwords (cleared after 30 s), file lists.

use crate::session::*;

#[cfg(target_os = "linux")]
fn decode_file_uri(uri: &str) -> Option<String> {
    let raw = uri.strip_prefix("file://")?;
    let mut bytes = Vec::with_capacity(raw.len());
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h1), Some(h2)) = (
                (b[i + 1] as char).to_digit(16),
                (b[i + 2] as char).to_digit(16),
            ) {
                bytes.push(((h1 << 4) | h2) as u8);
                i += 3;
                continue;
            }
        }
        bytes.push(b[i]);
        i += 1;
    }
    String::from_utf8(bytes).ok()
}

#[tauri::command]
pub async fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let tx_cell = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
            let tx_clone = tx_cell.clone();
            clip.request_text(move |_clip, text| {
                if let Some(sender) = tx_clone.borrow_mut().take() {
                    let s = text.map(|t| t.to_string()).unwrap_or_default();
                    let _ = sender.send(s);
                }
            });
        });

        let mut text = tokio::time::timeout(std::time::Duration::from_millis(450), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

        if text.is_empty() {
            text = tokio::task::spawn_blocking(linux_clipboard::read_text)
                .await
                .unwrap_or_default();
        }

        Ok(text)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let text = tokio::task::spawn_blocking(winproc::clipboard_get_text)
            .await
            .unwrap_or_default();
        Ok(text)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        Ok(String::new())
    }
}

#[tauri::command]
pub async fn clipboard_write_text(text: String, app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        // GTK clipboard of the window first, then a system helper (Wayland/X11) – see
        // linux_clipboard.rs. The helper runs after GTK so both hold the same text.
        let text_for_gtk = text.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let _ = app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            clip.set_text(&text_for_gtk);
            clip.store();
            let _ = tx.send(());
        });
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), rx).await;

        let _ = tokio::task::spawn_blocking(move || linux_clipboard::write_text(&text)).await;

        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let _ = tokio::task::spawn_blocking(move || winproc::clipboard_set_text(&text)).await;
        Ok(())
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (text, app);
        Ok(())
    }
}

/// How long a copied password stays on the clipboard.
const SECRET_CLIPBOARD_SECS: u64 = 30;
static SECRET_CLIPBOARD_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Copies a password: on Windows kept out of the clipboard history and cloud sync; after
/// 30 seconds the clipboard is cleared if it still holds this password (and no newer one was copied).
#[tauri::command]
pub async fn clipboard_write_secret(text: String, app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let secret = zeroize::Zeroizing::new(text);
    #[cfg(target_os = "windows")]
    {
        let copy = secret.clone();
        tokio::task::spawn_blocking(move || winproc::clipboard_set_secret(&copy)).await.map_err(|e| e.to_string())??;
    }
    #[cfg(not(target_os = "windows"))]
    clipboard_write_text(secret.to_string(), app.clone()).await?;

    let generation = SECRET_CLIPBOARD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(SECRET_CLIPBOARD_SECS)).await;
        if SECRET_CLIPBOARD_GENERATION.load(Ordering::SeqCst) != generation || secret.is_empty() {
            return;
        }
        let current = zeroize::Zeroizing::new(clipboard_read_text(app.clone()).await.unwrap_or_default());
        if *current != *secret {
            return; // the user copied something else meanwhile
        }
        #[cfg(target_os = "windows")]
        {
            let _ = app;
            let _ = tokio::task::spawn_blocking(winproc::clipboard_clear).await;
        }
        #[cfg(not(target_os = "windows"))]
        let _ = clipboard_write_text(String::new(), app).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn clipboard_read_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let _ = app.run_on_main_thread(move || {
            let clip = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let tx_cell = std::rc::Rc::new(std::cell::RefCell::new(Some(tx)));
            let tx_clone = tx_cell.clone();
            clip.request_uris(move |_clip, uris| {
                if let Some(sender) = tx_clone.borrow_mut().take() {
                    let list: Vec<String> = uris.iter().map(|u| u.to_string()).collect();
                    let _ = sender.send(list);
                }
            });
        });

        let uris = tokio::time::timeout(std::time::Duration::from_millis(450), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();

        let home_str = dirs::home_dir()
            .map(|h| h.to_string_lossy().trim_end_matches('/').to_string())
            .unwrap_or_default();

        let mut paths = Vec::new();
        for uri in uris {
            if let Some(p) = decode_file_uri(&uri) {
                let clean = p.trim_end_matches('/').to_string();
                if !clean.is_empty()
                    && clean != "/"
                    && clean != home_str
                    && std::path::Path::new(&clean).exists()
                    && !paths.contains(&clean)
                {
                    paths.push(clean);
                }
            }
        }

        if paths.is_empty() {
            if let Ok(text) = clipboard_read_text(app).await {
                for line in text.lines() {
                    let trimmed = line.trim();
                    if let Some(p) = decode_file_uri(trimmed) {
                        let clean = p.trim_end_matches('/').to_string();
                        if !clean.is_empty()
                            && clean != "/"
                            && clean != home_str
                            && std::path::Path::new(&clean).exists()
                            && !paths.contains(&clean)
                        {
                            paths.push(clean);
                        }
                    } else if trimmed.starts_with('/') && !trimmed.contains('\0') {
                        let clean = trimmed.trim_end_matches('/').to_string();
                        if !clean.is_empty()
                            && clean != "/"
                            && clean != home_str
                            && std::path::Path::new(&clean).exists()
                            && !paths.contains(&clean)
                        {
                            paths.push(clean);
                        }
                    }
                }
            }
        }

        Ok(paths)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        let paths = tokio::task::spawn_blocking(winproc::clipboard_get_files)
            .await
            .unwrap_or_default();
        Ok(paths)
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}
