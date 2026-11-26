//! Locks the vault after inactivity and when the operating-system session is locked (setting "Blokuj program po
//! wykryciu blokady systemu operacyjnego").
//!
//! * Windows: WTSQuerySessionInformation(WTSSessionInfoEx) → session flag LOCK/UNLOCK.
//! * Linux: logind `LockedHint` of the current session and the `GetActive` method of
//!   org.freedesktop.ScreenSaver / org.gnome.ScreenSaver (KDE, GNOME, Xfce, Cinnamon, ...).
//!
//! The state is polled every 2 s in a background thread. The vault is locked in the backend
//! (not in the web view, whose timers may be throttled while the screen is locked) and the UI
//! is notified with the `vault-auto-locked` event.

use crate::auth::{lock_if_idle, lock_on_os_session_lock, AuthState};
use tauri::{AppHandle, Emitter, Manager};

const POLL_EVERY: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;

    const WTS_CURRENT_SESSION: u32 = 0xFFFF_FFFF;
    const WTS_SESSION_INFO_EX: i32 = 25;
    const WTS_SESSIONSTATE_LOCK: i32 = 0;

    #[repr(C)]
    #[allow(non_snake_case)]
    pub(super) struct WtsInfoExLevel1W {
        SessionId: u32,
        SessionState: i32,
        SessionFlags: i32,
        WinStationName: [u16; 33],
        UserName: [u16; 21],
        DomainName: [u16; 18],
        LogonTime: i64,
        ConnectTime: i64,
        DisconnectTime: i64,
        LastInputTime: i64,
        CurrentTime: i64,
        IncomingBytes: u32,
        OutgoingBytes: u32,
        IncomingFrames: u32,
        OutgoingFrames: u32,
        IncomingCompressedBytes: u32,
        OutgoingCompressedBytes: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    pub(super) struct WtsInfoExW {
        Level: u32,
        Data: WtsInfoExLevel1W,
    }

    #[link(name = "wtsapi32")]
    unsafe extern "system" {
        fn WTSQuerySessionInformationW(
            server: *mut c_void,
            session_id: u32,
            info_class: i32,
            buffer: *mut *mut u16,
            bytes_returned: *mut u32,
        ) -> i32;
        fn WTSFreeMemory(memory: *mut c_void);
    }

    pub struct Monitor;

    impl Monitor {
        pub fn new() -> Self {
            Monitor
        }

        pub fn is_locked(&mut self) -> Option<bool> {
            let mut buffer: *mut u16 = std::ptr::null_mut();
            let mut bytes: u32 = 0;
            // SAFETY: documented Win32 API; the buffer is released with WTSFreeMemory.
            unsafe {
                let ok = WTSQuerySessionInformationW(
                    std::ptr::null_mut(),
                    WTS_CURRENT_SESSION,
                    WTS_SESSION_INFO_EX,
                    &mut buffer,
                    &mut bytes,
                );
                if ok == 0 || buffer.is_null() {
                    return None;
                }
                let result = if (bytes as usize) >= std::mem::size_of::<WtsInfoExW>() {
                    let info = &*(buffer as *const WtsInfoExW);
                    if info.Level == 1 {
                        Some(info.Data.SessionFlags == WTS_SESSIONSTATE_LOCK)
                    } else {
                        None
                    }
                } else {
                    None
                };
                WTSFreeMemory(buffer as *mut c_void);
                result
            }
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use zbus::blocking::{Connection, Proxy};
    use zbus::proxy::CacheProperties;

    pub struct Monitor {
        system: Option<Connection>,
        session: Option<Connection>,
    }

    impl Monitor {
        pub fn new() -> Self {
            Monitor { system: None, session: None }
        }

        fn proxy<'a>(conn: &'a Connection, dest: &'static str, path: &'static str, iface: &'static str) -> Option<Proxy<'a>> {
            zbus::blocking::proxy::Builder::new(conn)
                .destination(dest)
                .ok()?
                .path(path)
                .ok()?
                .interface(iface)
                .ok()?
                .cache_properties(CacheProperties::No)
                .build()
                .ok()
        }

        fn logind_locked(&mut self) -> Option<bool> {
            if self.system.is_none() {
                self.system = Connection::system().ok();
            }
            let conn = self.system.as_ref()?;
            let proxy = Self::proxy(
                conn,
                "org.freedesktop.login1",
                "/org/freedesktop/login1/session/auto",
                "org.freedesktop.login1.Session",
            )?;
            match proxy.get_property::<bool>("LockedHint") {
                Ok(v) => Some(v),
                Err(_) => None,
            }
        }

        fn screensaver_active(&mut self) -> Option<bool> {
            if self.session.is_none() {
                self.session = Connection::session().ok();
            }
            let conn = self.session.as_ref()?;
            let mut answered = false;
            for (dest, path, iface) in [
                ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver"),
                ("org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver"),
            ] {
                if let Some(proxy) = Self::proxy(conn, dest, path, iface) {
                    if let Ok(active) = proxy.call::<_, _, bool>("GetActive", &()) {
                        if active {
                            return Some(true);
                        }
                        answered = true;
                    }
                }
            }
            answered.then_some(false)
        }

        pub fn is_locked(&mut self) -> Option<bool> {
            let logind = self.logind_locked();
            let saver = self.screensaver_active();
            match (logind, saver) {
                (None, None) => {
                    // Connections may have been dropped (e.g. session bus restart) – retry next time.
                    self.system = None;
                    self.session = None;
                    None
                }
                (l, s) => Some(l.unwrap_or(false) || s.unwrap_or(false)),
            }
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
mod platform {
    pub struct Monitor;
    impl Monitor {
        pub fn new() -> Self {
            Monitor
        }
        pub fn is_locked(&mut self) -> Option<bool> {
            None
        }
    }
}

fn auto_lock_enabled() -> bool {
    crate::vault::storage::load_vault()
        .ok()
        .flatten()
        .map(|v| v.metadata.auto_lock_screen)
        .unwrap_or(false)
}

/// Starts the background thread watching the OS lock state.
pub fn start_monitor(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("remoteflow-os-lock".to_string())
        .spawn(move || {
            let mut monitor = platform::Monitor::new();
            let mut was_locked = false;
            let mut reported_unsupported = false;
            loop {
                std::thread::sleep(POLL_EVERY);
                let state = app.state::<AuthState>();

                // 1. Inactivity auto-lock (Ustawienia → Automatyczna blokada przy bezczynności)
                if let Some(pin_locked) = lock_if_idle(&state) {
                    eprintln!("[RemoteFlow] Brak aktywności – sejf zablokowany");
                    crate::session::rdp_embed::set_locked(&app, true);
                    let _ = app.emit("vault-auto-locked", pin_locked);
                }

                // 2. Operating-system session lock
                match monitor.is_locked() {
                    None => {
                        if !reported_unsupported {
                            eprintln!("[RemoteFlow] Nie można odczytać stanu blokady systemu – blokada razem z systemem niedostępna");
                            reported_unsupported = true;
                        }
                    }
                    Some(locked) => {
                        reported_unsupported = false;
                        if locked && !was_locked && auto_lock_enabled() {
                            if let Some(pin_locked) = lock_on_os_session_lock(&state) {
                                eprintln!("[RemoteFlow] Wykryto blokadę systemu – sejf zablokowany");
                                crate::session::rdp_embed::set_locked(&app, true);
                    let _ = app.emit("vault-auto-locked", pin_locked);
                            }
                        }
                        was_locked = locked;
                    }
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("[RemoteFlow] Nie udało się uruchomić monitora blokady systemu: {}", e);
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    fn struct_layout_matches_win32() {
        // sizeof(WTSINFOEXW) on x64 = Level (4) + padding (4) + WTSINFOEX_LEVEL1_W (224)
        assert_eq!(std::mem::size_of::<super::platform::WtsInfoExW>(), 232);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    /// Run inside `dbus-run-session` with the fake ScreenSaver service (see /tmp/lk).
    #[test]
    #[ignore]
    fn screensaver_state_is_read() {
        let mut m = super::platform::Monitor::new();
        std::fs::write("/tmp/lk/state", "0").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(m.is_locked(), Some(false));
        std::fs::write("/tmp/lk/state", "1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(m.is_locked(), Some(true));
    }
}
