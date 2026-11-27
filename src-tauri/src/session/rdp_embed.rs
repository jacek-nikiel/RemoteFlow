//! Linux (X11 / XWayland): an RDP session drawn by FreeRDP *inside* the RemoteFlow window.
//!
//! The embedded IronRDP client (WebAssembly) decodes RemoteFX on one thread and cannot use H.264,
//! so large screen changes are slow. FreeRDP is native (multi-threaded, H.264 through /gfx) and
//! can draw into another X11 window (`/parent-window:<id>`). For every session a native GDK child
//! window ("container") is placed over the session area of the web view; the frontend keeps its
//! position, size and visibility in sync (it is hidden while a dialog covers the area or the tab is
//! not visible, because a native window always stays above the web content).
//!
//! Requires an X11 display: on Wayland the setting starts RemoteFlow through XWayland
//! (`GDK_BACKEND=x11`, see `display.rs`).

use serde::Deserialize;

/// Area of the session in CSS pixels, relative to the web view.
#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct EmbedRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::EmbedRect;
    use gtk::glib::object::Cast;
    use gtk::prelude::*;
    use x11::xlib;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{AppHandle, Manager};

    static X11: AtomicBool = AtomicBool::new(false);
    /// The vault is locked (lock screen shown): no container may be visible, whatever the page
    /// reports – its visibility check runs on timers that the web view throttles when the window
    /// is minimised or the screen is locked.
    static LOCKED: AtomicBool = AtomicBool::new(false);

    /// Hides every container at once when the vault is locked; unlocking lets the page show them
    /// again with its next update.
    pub fn set_locked(app: &AppHandle, locked: bool) {
        LOCKED.store(locked, Ordering::SeqCst);
        if !locked {
            return;
        }
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let windows: Vec<gdk::Window> = CONTAINERS.with(|c| c.borrow().values().cloned().collect());
            WANTED.with(|w| w.borrow_mut().values_mut().for_each(|v| *v = false));
            for window in windows.iter().filter(|w| w.is_visible()) {
                take_focus_back(&app_main, Some(window));
                window.hide();
            }
        });
    }

    thread_local! {
        /// Container windows by session id (GDK objects live on the GTK main thread only).
        static CONTAINERS: RefCell<HashMap<String, gdk::Window>> = RefCell::new(HashMap::new());
        /// Hidden containers of closed sessions, reused by new ones. GDK windows are never
        /// destroyed: destroying a container that had FreeRDP's (foreign) window inside crashed
        /// GDK's X event handling shortly afterwards.
        static POOL: RefCell<Vec<gdk::Window>> = const { RefCell::new(Vec::new()) };
        /// Sessions whose area is visible in the UI (frontend `update`). The container itself is
        /// shown only once FreeRDP's window exists in it – until then the page shows its own
        /// "connecting" placeholder. Showing an empty native window earlier exposed whatever was
        /// drawn there before (e.g. the SSH terminal of the previous tab) and appeared before the
        /// web view had even repainted the new tab.
        static WANTED: RefCell<HashMap<String, bool>> = RefCell::new(HashMap::new());
        /// The keyboard-focus watcher runs while containers exist.
        static WATCHING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    // --- keyboard focus ------------------------------------------------------------------------
    // FreeRDP's window is a child of the RemoteFlow window, so X11 delivers keys to it only when it
    // has the input focus. The pointer entering the session area gives it the focus (while the
    // RemoteFlow window is active); a click on the web content takes it back (frontend →
    // `release_focus`), as does hiding the session (dialog, other tab).

    thread_local! {
        /// Own X connection for the focus calls. Using GDK's connection for round trips
        /// (XGetInputFocus, XQueryTree) crashed GDK's event handling; the input focus is
        /// server-wide, so a separate connection sees and changes the same state.
        static XDPY: std::cell::Cell<*mut xlib::Display> = const { std::cell::Cell::new(std::ptr::null_mut()) };
    }

    unsafe extern "C" fn ignore_x_error(_: *mut xlib::Display, _: *mut xlib::XErrorEvent) -> i32 {
        0
    }

    /// Runs Xlib calls on the own connection with X errors ignored (a window may vanish at any
    /// time – FreeRDP exiting); the previous (GDK) error handler is restored afterwards.
    fn with_x<R>(f: impl FnOnce(*mut xlib::Display) -> R) -> Option<R> {
        let dpy = XDPY.with(|c| {
            if c.get().is_null() {
                c.set(unsafe { xlib::XOpenDisplay(std::ptr::null()) });
            }
            c.get()
        });
        if dpy.is_null() {
            return None;
        }
        unsafe {
            let previous = xlib::XSetErrorHandler(Some(ignore_x_error));
            let r = f(dpy);
            xlib::XSync(dpy, xlib::False);
            xlib::XSetErrorHandler(previous);
            Some(r)
        }
    }

    fn xid_of(w: &gdk::Window) -> Option<xlib::Window> {
        w.downcast_ref::<gdkx11::X11Window>().map(|x| x.xid())
    }

    /// FreeRDP's own window inside a container (topmost child).
    fn inner_window(dpy: *mut xlib::Display, container: xlib::Window) -> Option<xlib::Window> {
        unsafe {
            let mut root = 0;
            let mut parent = 0;
            let mut children: *mut xlib::Window = std::ptr::null_mut();
            let mut n: u32 = 0;
            if xlib::XQueryTree(dpy, container, &mut root, &mut parent, &mut children, &mut n) == 0 {
                return None;
            }
            let result = if n > 0 && !children.is_null() { Some(*children.add(n as usize - 1)) } else { None };
            if !children.is_null() {
                xlib::XFree(children as *mut _);
            }
            result
        }
    }

    /// FreeRDP's window of this session inside the container, if it already exists. A reused
    /// container can still hold the window of the previous process (reconnect) – and X11 may
    /// even give the new window the same id – so the window is matched by its `_NET_WM_PID`.
    fn session_window(session_id: &str, container: &gdk::Window) -> Option<xlib::Window> {
        let cx = xid_of(container)?;
        let pid = super::process_of(session_id)?;
        with_x(|dpy| unsafe {
            let atom = xlib::XInternAtom(dpy, c"_NET_WM_PID".as_ptr(), xlib::True);
            if atom == 0 {
                return None;
            }
            let mut root = 0;
            let mut parent = 0;
            let mut children: *mut xlib::Window = std::ptr::null_mut();
            let mut n: u32 = 0;
            if xlib::XQueryTree(dpy, cx, &mut root, &mut parent, &mut children, &mut n) == 0 || children.is_null() {
                return None;
            }
            let list = std::slice::from_raw_parts(children, n as usize).to_vec();
            xlib::XFree(children as *mut _);
            list.into_iter().rev().find(|&w| {
                let mut actual_type = 0;
                let mut format = 0;
                let mut items = 0;
                let mut after = 0;
                let mut data: *mut u8 = std::ptr::null_mut();
                let ok = xlib::XGetWindowProperty(
                    dpy, w, atom, 0, 1, xlib::False, xlib::XA_CARDINAL,
                    &mut actual_type, &mut format, &mut items, &mut after, &mut data,
                ) == 0;
                let found = ok && !data.is_null() && format == 32 && items == 1 && *(data as *const std::os::raw::c_ulong) as u32 == pid;
                if !data.is_null() {
                    xlib::XFree(data as *mut _);
                }
                found
            })
        })
        .flatten()
    }

    /// Shows the container when the UI wants it and FreeRDP's window is ready.
    fn show_if_ready(session_id: &str, window: &gdk::Window) {
        let wanted = WANTED.with(|w| w.borrow().get(session_id).copied().unwrap_or(false));
        if wanted && !LOCKED.load(Ordering::SeqCst) && !window.is_visible() && session_window(session_id, window).is_some() {
            window.show();
            window.raise();
        }
    }

    fn current_focus(dpy: *mut xlib::Display) -> xlib::Window {
        let mut focus: xlib::Window = 0;
        let mut revert = 0;
        unsafe { xlib::XGetInputFocus(dpy, &mut focus, &mut revert) };
        focus
    }

    /// Is `w` the container or a window inside it?
    fn is_within(dpy: *mut xlib::Display, container: xlib::Window, mut w: xlib::Window) -> bool {
        for _ in 0..8 {
            if w == container {
                return true;
            }
            if w <= 1 {
                return false;
            }
            unsafe {
                let mut root = 0;
                let mut parent = 0;
                let mut children: *mut xlib::Window = std::ptr::null_mut();
                let mut n: u32 = 0;
                if xlib::XQueryTree(dpy, w, &mut root, &mut parent, &mut children, &mut n) == 0 {
                    return false;
                }
                if !children.is_null() {
                    xlib::XFree(children as *mut _);
                }
                if parent == 0 || parent == root {
                    return false;
                }
                w = parent;
            }
        }
        false
    }

    /// Gives the keyboard back to the RemoteFlow window if a session container has it.
    fn take_focus_back(app: &AppHandle, only: Option<&gdk::Window>) {
        let Some((top, _, _)) = host(app) else { return };
        let Some(top_xid) = xid_of(&top) else { return };
        let containers: Vec<xlib::Window> = CONTAINERS.with(|c| {
            c.borrow()
                .values()
                .filter(|w| only.is_none_or(|o| o == *w))
                .filter_map(xid_of)
                .collect()
        });
        if containers.is_empty() {
            return;
        }
        with_x(|dpy| {
            let focus = current_focus(dpy);
            if containers.iter().any(|&cx| is_within(dpy, cx, focus)) {
                unsafe { xlib::XSetInputFocus(dpy, top_xid, xlib::RevertToParent, xlib::CurrentTime) };
            }
        });
    }

    pub fn release_focus(app: &AppHandle) {
        take_focus_back(app, None);
    }

    fn watch_focus(app: &AppHandle) {
        if WATCHING.with(|w| w.replace(true)) {
            return;
        }
        let app = app.clone();
        gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            let entries: Vec<(String, gdk::Window)> =
                CONTAINERS.with(|c| c.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect());
            if entries.is_empty() {
                WATCHING.with(|w| w.set(false));
                return gtk::glib::ControlFlow::Break;
            }
            for (sid, win) in &entries {
                show_if_ready(sid, win);
            }
            let containers: Vec<gdk::Window> = entries.into_iter().map(|(_, w)| w).collect();
            let active = app
                .get_webview_window("main")
                .and_then(|w| w.gtk_window().ok())
                .is_some_and(|w| w.is_active());
            if !active {
                return gtk::glib::ControlFlow::Continue;
            }
            for win in containers.iter().filter(|w| w.is_visible()) {
                let Some(pointer) = win.display().default_seat().and_then(|s| s.pointer()) else { continue };
                let (_, x, y, _) = win.device_position(&pointer);
                if x < 0 || y < 0 || x >= win.width() || y >= win.height() {
                    continue;
                }
                let Some(cx) = xid_of(win) else { continue };
                with_x(|dpy| {
                    if let Some(inner) = inner_window(dpy, cx) {
                        if current_focus(dpy) != inner {
                            unsafe { xlib::XSetInputFocus(dpy, inner, xlib::RevertToParent, xlib::CurrentTime) };
                        }
                    }
                });
            }
            gtk::glib::ControlFlow::Continue
        });
    }

    /// Called from `setup` (GTK main thread): remembers whether the window runs on X11.
    pub fn init() {
        let x11 = gdk::Display::default().is_some_and(|d| d.type_().name() == "GdkX11Display");
        X11.store(x11, Ordering::Relaxed);
    }

    pub fn is_x11() -> bool {
        X11.load(Ordering::Relaxed)
    }

    /// Top-level GDK window of the main window and the offset of the web view inside it.
    fn host(app: &AppHandle) -> Option<(gdk::Window, i32, i32)> {
        let win = app.get_webview_window("main")?;
        let top = win.gtk_window().ok()?.window()?;
        let (ox, oy) = win
            .default_vbox()
            .ok()
            .map(|vb| {
                let a = vb.allocation();
                (a.x().max(0), a.y().max(0))
            })
            .unwrap_or((0, 0));
        Some((top, ox, oy))
    }

    fn px(v: f64) -> i32 {
        v.round().clamp(-100_000.0, 100_000.0) as i32
    }

    /// Creates (or reuses) the container of a session; returns its X11 id and the scale factor.
    /// Must run on the GTK main thread.
    pub fn create(app: &AppHandle, session_id: &str, rect: EmbedRect) -> Result<(u64, i32), String> {
        let (top, ox, oy) = host(app).ok_or("no main window")?;
        if top.display().type_().name() != "GdkX11Display" {
            return Err("X11 required".into());
        }
        let w = px(rect.width).max(1);
        let h = px(rect.height).max(1);
        let existing = CONTAINERS
            .with(|c| c.borrow().get(session_id).cloned())
            .or_else(|| POOL.with(|p| p.borrow_mut().pop()));
        if let Some(w) = &existing {
            CONTAINERS.with(|c| c.borrow_mut().insert(session_id.to_string(), w.clone()));
        }
        let window = existing.unwrap_or_else(|| {
            let attr = gdk::WindowAttr {
                window_type: gdk::WindowType::Child,
                wclass: gdk::WindowWindowClass::InputOutput,
                x: Some(px(rect.x) + ox),
                y: Some(px(rect.y) + oy),
                width: w,
                height: h,
                ..Default::default()
            };
            let window = gdk::Window::new(Some(&top), &attr);
            window.ensure_native();
            CONTAINERS.with(|c| c.borrow_mut().insert(session_id.to_string(), window.clone()));
            window
        });
        // Not shown yet: `show_if_ready` maps it once FreeRDP's window exists and the UI wants it.
        window.hide();
        window.move_resize(px(rect.x) + ox, px(rect.y) + oy, w, h);
        // Opaque background set directly on the X window (GDK 3 may leave native child windows
        // without one, so the area would keep the previous pixels while FreeRDP starts).
        // GDK and this helper use separate X connections – finish GDK's requests first.
        window.display().sync();
        if let Some(xid) = xid_of(&window) {
            with_x(|dpy| unsafe { xlib::XSetWindowBackground(dpy, xid, 0) });
        }
        WANTED.with(|w| w.borrow_mut().insert(session_id.to_string(), false));
        watch_focus(app);
        let xid = window
            .downcast_ref::<gdkx11::X11Window>()
            .map(|x| x.xid() as u64)
            .ok_or("not an X11 window")?;
        Ok((xid, window.scale_factor().max(1)))
    }

    /// Position, size and visibility of a container. Must run on the GTK main thread.
    pub fn update(app: &AppHandle, session_id: &str, rect: EmbedRect, visible: bool) {
        let Some(window) = CONTAINERS.with(|c| c.borrow().get(session_id).cloned()) else { return };
        let visible = visible && rect.width >= 2.0 && rect.height >= 2.0 && !LOCKED.load(Ordering::SeqCst);
        WANTED.with(|w| w.borrow_mut().insert(session_id.to_string(), visible));
        if !visible {
            if window.is_visible() {
                take_focus_back(app, Some(&window));
                window.hide();
            }
            return;
        }
        let (ox, oy) = host(app).map(|(_, x, y)| (x, y)).unwrap_or((0, 0));
        window.move_resize(px(rect.x) + ox, px(rect.y) + oy, px(rect.width).max(1), px(rect.height).max(1));
        if window.is_visible() {
            window.raise();
        } else {
            show_if_ready(session_id, &window);
        }
    }

    pub fn destroy(app: &AppHandle, session_id: &str) {
        let Some(window) = CONTAINERS.with(|c| c.borrow().get(session_id).cloned()) else { return };
        take_focus_back(app, Some(&window));
        CONTAINERS.with(|c| c.borrow_mut().remove(session_id));
        WANTED.with(|w| w.borrow_mut().remove(session_id));
        window.hide();
        POOL.with(|p| p.borrow_mut().push(window));
    }
}

#[cfg(target_os = "linux")]
pub use imp::{init, is_x11, set_locked};

/// Locked vault: hide every embedded FreeRDP window at once (only Linux X11 embeds them).
#[cfg(not(target_os = "linux"))]
pub fn set_locked(_app: &tauri::AppHandle, _locked: bool) {}

#[cfg(not(target_os = "linux"))]
pub fn init() {}
#[cfg(not(target_os = "linux"))]
pub fn is_x11() -> bool {
    false
}

/// Is an X11 FreeRDP client installed?
pub fn xfreerdp_installed() -> bool {
    #[cfg(target_os = "linux")]
    {
        ["xfreerdp3", "xfreerdp"].iter().any(|b| {
            std::process::Command::new("which")
                .arg(b)
                .output()
                .is_ok_and(|o| o.status.success())
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// FreeRDP process drawing in each session container (set by `rdp::spawn_rdp_session`).
static PROCESSES: std::sync::Mutex<Option<std::collections::HashMap<String, u32>>> = std::sync::Mutex::new(None);

pub fn register_process(session_id: &str, pid: u32) {
    if let Ok(mut map) = PROCESSES.lock() {
        map.get_or_insert_with(Default::default).insert(session_id.to_string(), pid);
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn process_of(session_id: &str) -> Option<u32> {
    PROCESSES.lock().ok()?.as_ref()?.get(session_id).copied()
}

fn forget_process(session_id: &str) {
    if let Ok(mut map) = PROCESSES.lock() {
        if let Some(m) = map.as_mut() {
            m.remove(session_id);
        }
    }
}

/// Removes the container of a session (any thread).
pub fn destroy_container(app: &tauri::AppHandle, session_id: &str) {
    forget_process(session_id);
    #[cfg(target_os = "linux")]
    {
        let sid = session_id.to_string();
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || imp::destroy(&app_main, &sid));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, session_id);
    }
}

/// Starts (or restarts) FreeRDP drawing inside the RemoteFlow window for a session tab.
#[tauri::command]
pub async fn rdp_embed_start(
    session_id: String,
    connection_id: String,
    title: String,
    rect: EmbedRect,
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, crate::auth::AuthState>,
    session_state: tauri::State<'_, super::SessionState>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        if !is_x11() {
            return Err(tr!(
                "Osadzony FreeRDP wymaga X11 – uruchom RemoteFlow ponownie po włączeniu opcji w Ustawieniach.",
                "Embedded FreeRDP requires X11 – restart RemoteFlow after enabling the option in Settings."
            )
            .to_string());
        }
        let mut config = super::rdp_config_for_connection(&auth_state, &connection_id, title, None, &app)?;

        let (tx, rx) = tokio::sync::oneshot::channel();
        let app_main = app.clone();
        let sid = session_id.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(imp::create(&app_main, &sid, rect));
        })
        .map_err(|e| e.to_string())?;
        let (xid, scale) = rx.await.map_err(|e| e.to_string())??;

        config.embed = Some(super::rdp::EmbedTarget {
            parent_xid: xid,
            width: (rect.width.max(1.0) as u32) * scale as u32,
            height: (rect.height.max(1.0) as u32) * scale as u32,
        });

        let (kill_tx, kill_rx) = std::sync::mpsc::channel();
        {
            let mut mgr = session_state.lock().map_err(|e| e.to_string())?;
            if let Some(old) = mgr.rdp_embed_killers.insert(session_id.clone(), kill_tx) {
                let _ = old.send(());
            }
        }
        super::rdp::spawn_rdp_session(session_id, config, kill_rx, app);
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session_id, connection_id, title, rect, app, auth_state, session_state);
        Err("Linux only".into())
    }
}

/// Keeps the container over the session area (called by the frontend on layout changes).
#[tauri::command]
pub fn rdp_embed_update(session_id: String, rect: EmbedRect, visible: bool, app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || imp::update(&app_main, &session_id, rect, visible));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (session_id, rect, visible, app);
    }
}

/// Ends the FreeRDP process of a tab and removes its container.
#[tauri::command]
pub fn rdp_embed_stop(
    session_id: String,
    app: tauri::AppHandle,
    session_state: tauri::State<'_, super::SessionState>,
) -> Result<(), String> {
    if let Some(kill) = session_state.lock().map_err(|e| e.to_string())?.rdp_embed_killers.remove(&session_id) {
        let _ = kill.send(());
    }
    destroy_container(&app, &session_id);
    Ok(())
}

/// Gives the keyboard back to the RemoteFlow window (the user clicked the web content).
#[tauri::command]
pub fn rdp_embed_release_focus(app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    {
        let app_main = app.clone();
        let _ = app.run_on_main_thread(move || imp::release_focus(&app_main));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
    }
}
