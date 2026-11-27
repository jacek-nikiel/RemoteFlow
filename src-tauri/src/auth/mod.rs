use crate::vault::cipher::{
    decrypt_bytes, decrypt_string, decrypt_string_z, derive_key, derive_pin_key, encrypt_bytes,
    encrypt_string, generate_salt, SecretKey, CANARY_PHRASE_V1, CANARY_PHRASE_V2,
    MIN_MASTER_PASSWORD_LEN, CANARY_PHRASE_V3
};
use crate::vault::models::{
    Connection, Credential, Group, VaultData, VaultMetadata, VaultStatus, BackupSettings
};
use crate::vault::backup::backup_while_locked;
use crate::vault::storage::{
    delete_vault, get_vault_path, integrity_error, load_vault, load_vault_verified, lock_io,
    save_vault_signed, update_vault, vault_exists, verify_vault_mac, open_vault_envelope
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

mod import_sources;
mod settings_cmds;
mod transfer;
mod vault_cmds;
#[cfg(test)]
mod tests;

pub use import_sources::*;
pub use settings_cmds::*;
pub use transfer::*;
pub use vault_cmds::*;

const VAULT_FORMAT_VERSION: u32 = 3;
const DEFAULT_MAX_PIN_ATTEMPTS: u32 = 3;
const MIN_PIN_LEN: usize = 4;
const MAX_PIN_LEN: usize = 12;

#[tauri::command]
pub fn vault_get_path() -> Result<String, String> {
    Ok(get_vault_path().to_string_lossy().to_string())
}

/// Master key wrapped with a PIN-derived key. Exists ONLY in process memory: it is rebuilt after
/// every Master Password unlock and dropped on full lock, app exit or too many wrong PINs.
struct PinWrap {
    salt: [u8; 16],
    nonce: [u8; 12],
    ciphertext: Vec<u8>,
}

pub struct AuthManager {
    pub master_key: Option<SecretKey>,
    pub is_unlocked: bool,
    pub is_pin_locked: bool,
    pub failed_pin_attempts: u32,
    pin_wrap: Option<PinWrap>,
    max_pin_attempts: u32,
    /// Last user interaction reported by the UI (keyboard / mouse inside the app).
    last_activity: std::time::Instant,
    /// Inactivity auto-lock in minutes (0 = disabled), cached from the verified vault.
    idle_timeout_mins: u32,
}

impl AuthManager {
    pub fn new() -> Self {
        Self {
            master_key: None,
            is_unlocked: false,
            is_pin_locked: false,
            failed_pin_attempts: 0,
            pin_wrap: None,
            max_pin_attempts: DEFAULT_MAX_PIN_ATTEMPTS,
            last_activity: std::time::Instant::now(),
            idle_timeout_mins: 15,
        }
    }

    /// Master key, available only while the vault is fully unlocked.
    pub fn unlocked_key(&self) -> Result<&SecretKey, String> {
        if !self.is_unlocked {
            return Err(tr!("Sejf jest zablokowany", "The vault is locked").to_string());
        }
        self.master_key.as_ref().ok_or_else(|| tr!("Sejf jest zablokowany", "The vault is locked").to_string())
    }

    fn clear(&mut self) {
        self.master_key = None;
        self.is_unlocked = false;
        self.is_pin_locked = false;
        self.failed_pin_attempts = 0;
        self.pin_wrap = None;
    }

    fn set_unlocked(&mut self, key: SecretKey) {
        self.last_activity = std::time::Instant::now();
        self.master_key = Some(key);
        self.is_unlocked = true;
        self.is_pin_locked = false;
        self.failed_pin_attempts = 0;
    }

    fn arm_pin(&mut self, master_key: &[u8; 32], pin: &str) -> Result<(), String> {
        let salt = generate_salt();
        let pin_key = derive_pin_key(pin, &salt)?;
        let (ciphertext, nonce) = encrypt_bytes(&pin_key, master_key)?;
        self.pin_wrap = Some(PinWrap { salt, nonce, ciphertext });
        Ok(())
    }
}

pub type AuthState = Mutex<AuthManager>;

pub fn lock_auth(state: &AuthState) -> Result<MutexGuard<'_, AuthManager>, String> {
    state.lock().map_err(|e| e.to_string())
}

fn sanitize_max_attempts(v: u32) -> u32 {
    if v == 0 {
        DEFAULT_MAX_PIN_ATTEMPTS
    } else {
        v.min(10)
    }
}

fn build_status(vault: Option<&VaultData>, mgr: &AuthManager, warning: Option<String>) -> VaultStatus {
    match vault {
        None => VaultStatus {
            is_initialized: false,
            is_unlocked: false,
            is_pin_locked: false,
            pin_enabled: false,
            auto_lock_screen: true,
            auto_lock_timeout_mins: 15,
            failed_pin_attempts: 0,
            connections_count: 0,
            groups_count: 0,
            credentials_count: 0,
            security_warning: warning,
        },
        Some(v) => VaultStatus {
            is_initialized: true,
            is_unlocked: mgr.is_unlocked,
            is_pin_locked: mgr.is_pin_locked,
            pin_enabled: v.metadata.pin_enabled,
            auto_lock_screen: v.metadata.auto_lock_screen,
            auto_lock_timeout_mins: v.metadata.auto_lock_timeout_mins,
            failed_pin_attempts: mgr.failed_pin_attempts,
            connections_count: v.connections.len(),
            groups_count: v.groups.len(),
            credentials_count: v.credentials.len(),
            security_warning: warning,
        },
    }
}

fn decode_nonce(b64: &str) -> Result<[u8; 12], String> {
    let bytes = BASE64.decode(b64).map_err(|e| tr!("Błąd dekodowania nonce: {}", "Nonce decoding error: {}", e))?;
    if bytes.len() != 12 {
        return Err(tr!("Niepoprawna długość nonce", "Invalid nonce length").to_string());
    }
    let mut out = [0u8; 12];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Decrypts the password-verification canary. Returns the canary phrase (v1 or v2).
fn open_canary(key: &[u8; 32], metadata: &VaultMetadata) -> Result<Zeroizing<Vec<u8>>, String> {
    let nonce = decode_nonce(&metadata.canary_nonce_base64)?;
    let ct = BASE64
        .decode(&metadata.canary_ciphertext_base64)
        .map_err(|e| tr!("Błąd dekodowania szyfrogramu: {}", "Ciphertext decoding error: {}", e))?;
    decrypt_bytes(key, &ct, &nonce)
        .map(Zeroizing::new)
        .map_err(|_| tr!("Nieprawidłowe Master Password", "Invalid Master Password").to_string())
}

fn set_current_canary(key: &[u8; 32], metadata: &mut VaultMetadata) -> Result<(), String> {
    let (ct, nonce) = encrypt_bytes(key, CANARY_PHRASE_V3.as_bytes())?;
    metadata.canary_nonce_base64 = BASE64.encode(nonce);
    metadata.canary_ciphertext_base64 = BASE64.encode(ct);
    metadata.version = VAULT_FORMAT_VERSION;
    Ok(())
}

fn clear_pin_metadata(metadata: &mut VaultMetadata) {
    metadata.pin_enabled = false;
    metadata.pin_encrypted_base64 = None;
    metadata.pin_salt_base64 = None;
    metadata.pin_wrapped_master_key_base64 = None;
    metadata.pin_nonce_base64 = None;
}

fn check_new_password(password: &str, what: &str) -> Result<(), String> {
    if password.chars().count() < MIN_MASTER_PASSWORD_LEN {
        return Err(tr!("{} musi mieć co najmniej {} znaków", "{} must be at least {} characters long", what, MIN_MASTER_PASSWORD_LEN));
    }
    Ok(())
}

/// Encrypts a freshly entered secret into `field` (`Some("")` clears the field, `None` keeps it).
fn seal_raw(key: &[u8; 32], raw: Option<String>, field: &mut Option<String>) -> Result<(), String> {
    if let Some(value) = raw {
        let value = Zeroizing::new(value);
        *field = if value.is_empty() { None } else { Some(encrypt_string(key, &value)?) };
    }
    Ok(())
}

/// Encrypts an imported plaintext field. For legacy (v1) exports some fields may already contain
/// ciphertext produced with *this* vault's key – those are detected by successful AEAD decryption
/// and kept as they are instead of being double-encrypted.
fn seal_imported(key: &[u8; 32], field: &mut Option<String>, may_be_ciphertext: bool) -> Result<(), String> {
    if let Some(value) = field.take() {
        let value = Zeroizing::new(value);
        if value.is_empty() {
            *field = None;
        } else if may_be_ciphertext && decrypt_string(key, &value).is_ok() {
            *field = Some(value.to_string());
        } else {
            *field = Some(encrypt_string(key, &value)?);
        }
    }
    Ok(())
}

fn seal_connection(key: &[u8; 32], conn: &mut Connection, may_be_ciphertext: bool) -> Result<(), String> {
    seal_imported(key, &mut conn.password_encrypted, may_be_ciphertext)?;
    seal_imported(key, &mut conn.private_key_encrypted, may_be_ciphertext)?;
    seal_imported(key, &mut conn.private_key_passphrase_encrypted, may_be_ciphertext)
}

fn seal_credential(key: &[u8; 32], cred: &mut Credential, may_be_ciphertext: bool) -> Result<(), String> {
    seal_imported(key, &mut cred.password_encrypted, may_be_ciphertext)?;
    seal_imported(key, &mut cred.private_key_encrypted, may_be_ciphertext)?;
    seal_imported(key, &mut cred.private_key_passphrase_encrypted, may_be_ciphertext)
}

fn upsert_by_id<T: Clone>(list: &mut Vec<T>, item: T, id_of: impl Fn(&T) -> &str) {
    let id = id_of(&item).to_string();
    if let Some(idx) = list.iter().position(|x| id_of(x) == id) {
        list[idx] = item;
    } else {
        list.push(item);
    }
}

#[tauri::command]
pub fn vault_get_status(state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    let mgr = lock_auth(&state)?;
    let vault = if mgr.is_unlocked { Some(load_vault_verified(mgr.unlocked_key()?)?) }
        else if vault_exists() { load_vault()? } else { None };
    Ok(build_status(vault.as_ref(), &mgr, None))
}

#[tauri::command]
pub fn vault_init(master_password: &str, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    vault_init_impl(master_password, &state)
}

pub(crate) fn vault_init_impl(master_password: &str, state: &AuthState) -> Result<VaultStatus, String> {
    if vault_exists() {
        return Err(tr!("Sejf już istnieje – aby utworzyć nowy, najpierw zresetuj obecny", "The vault already exists – reset the current one to create a new one").to_string());
    }
    check_new_password(master_password, "Master Password")?;

    let salt = generate_salt();
    let key = derive_key(master_password, &salt)?;

    let mut metadata = VaultMetadata {
        version: VAULT_FORMAT_VERSION,
        salt_base64: BASE64.encode(salt),
        canary_nonce_base64: String::new(),
        canary_ciphertext_base64: String::new(),
        pin_enabled: false,
        pin_encrypted_base64: None,
        pin_salt_base64: None,
        pin_wrapped_master_key_base64: None,
        pin_nonce_base64: None,
        auto_lock_screen: true,
        auto_lock_timeout_mins: 15,
        max_pin_attempts: DEFAULT_MAX_PIN_ATTEMPTS,
        global_download_dir: None,
        known_hosts: BTreeMap::new(),
        backup: Default::default(),
        ui: Default::default(),
        saved_workspace: None,
    };
    set_current_canary(&key, &mut metadata)?;

    // Default starter folders for mRemoteNG-like experience
    let default_groups = vec![
        Group {
            id: "group-prod".to_string(),
            name: "Produkcja (Linux/SSH)".to_string(),
            parent_id: None,
            icon: Some("server".to_string()),
            color: Some("#ef4444".to_string()),
        },
        Group {
            id: "group-rdp".to_string(),
            name: "Serwery Windows (RDP)".to_string(),
            parent_id: None,
            icon: Some("monitor".to_string()),
            color: Some("#3b82f6".to_string()),
        },
        Group {
            id: "group-tunnels".to_string(),
            name: "Tunele & Bastion".to_string(),
            parent_id: None,
            icon: Some("network".to_string()),
            color: Some("#10b981".to_string()),
        },
    ];

    let mut data = VaultData {
        metadata,
        groups: default_groups,
        connections: Vec::new(),
        credentials: Vec::new(),
        mac: None,
        encrypted_data: None,
    };

    {
        let _io = lock_io();
        if vault_exists() {
            return Err(tr!("Sejf już istnieje", "The vault already exists").to_string());
        }
        save_vault_signed(&mut data, &key)?;
    }

    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    mgr.max_pin_attempts = DEFAULT_MAX_PIN_ATTEMPTS;
    mgr.idle_timeout_mins = data.metadata.auto_lock_timeout_mins;
    mgr.set_unlocked(key);
    Ok(build_status(Some(&data), &mgr, None))
}

#[tauri::command]
pub fn vault_unlock_master(
    master_password: &str,
    accept_modified: Option<bool>,
    state: tauri::State<'_, AuthState>,
    app: tauri::AppHandle,
) -> Result<VaultStatus, String> {
    let status = vault_unlock_master_impl(master_password, accept_modified, &state)?;
    crate::session::rdp_embed::set_locked(&app, false);
    Ok(status)
}

pub(crate) fn vault_unlock_master_impl(master_password: &str, accept_modified: Option<bool>, state: &AuthState) -> Result<VaultStatus, String> {
    let initial = load_vault()?.ok_or(tr!("Sejf nie został jeszcze zainicjalizowany", "The vault has not been initialised yet"))?;
    let salt = BASE64
        .decode(&initial.metadata.salt_base64)
        .map_err(|e| tr!("Błąd dekodowania soli: {}", "Salt decoding error: {}", e))?;
    // Slow KDF outside of any lock.
    let key = derive_key(master_password, &salt)?;

    let mut warnings: Vec<String> = Vec::new();
    let vault = {
        let _io = lock_io();
        let vault = load_vault()?.ok_or(tr!("Sejf nie istnieje", "The vault does not exist"))?;
        if vault.metadata.salt_base64 != initial.metadata.salt_base64 {
            return Err(tr!("Plik sejfu zmienił się podczas odblokowywania – spróbuj ponownie", "The vault file changed while unlocking – try again").to_string());
        }

        let canary = open_canary(&key, &vault.metadata)?;
        if canary.as_slice() == CANARY_PHRASE_V3.as_bytes() && vault.encrypted_data.is_none() {
            return Err(integrity_error());
        }
        let mut vault = open_vault_envelope(vault, &key)?;
        let migrating = vault.metadata.version < 3;
        let mut dirty = migrating;

        if canary.as_slice() == CANARY_PHRASE_V2.as_bytes() || canary.as_slice() == CANARY_PHRASE_V3.as_bytes() {
            if !verify_vault_mac(&vault, &key) {
                if accept_modified != Some(true) {
                    return Err(integrity_error());
                }
                // User explicitly accepted the modified file: keep data, but reset every
                // security-relevant setting that an attacker could have planted.
                clear_pin_metadata(&mut vault.metadata);
                vault.metadata.auto_lock_screen = true;
                vault.metadata.auto_lock_timeout_mins = 15;
                vault.metadata.max_pin_attempts = DEFAULT_MAX_PIN_ATTEMPTS;
                vault.metadata.known_hosts.clear();
                warnings.push(
                    "Zaakceptowano zmiany wprowadzone w pliku sejfu poza aplikacją. Kod PIN, automatyczną blokadę \
                     i listę zaufanych hostów przywrócono do ustawień domyślnych. Sprawdź adresy swoich połączeń."
                        .to_string(),
                );
                dirty = true;
            }
        } else if canary.as_slice() == CANARY_PHRASE_V1.as_bytes() {
            // Legacy vault (v1): no integrity protection, PIN-wrapped master key stored on disk.
            let had_pin = vault.metadata.pin_enabled || vault.metadata.pin_wrapped_master_key_base64.is_some();
            clear_pin_metadata(&mut vault.metadata);
            set_current_canary(&key, &mut vault.metadata)?;
            if had_pin {
                warnings.push(
                    "Sejf zaktualizowano do formatu v3 (szyfrowanie danych połączeń i ochrona integralności). Ze względów bezpieczeństwa \
                     kod PIN został wyłączony – ustaw go ponownie w Ustawieniach."
                        .to_string(),
                );
            }
            dirty = true;
        } else {
            return Err(tr!("Nieprawidłowe Master Password (weryfikacja tokena nie powiodła się)", "Invalid Master Password (token verification failed)").to_string());
        }

        if dirty {
            // Keep the file exactly as it was before migration / accepting external changes.
            let reason = if migrating { "pre-migration-v3" } else { "pre-accept-modified" };
            match backup_while_locked(&BackupSettings::default(), reason, true) {
                Ok(_) => save_vault_signed(&mut vault, &key)?,
                // A v2 vault stays readable without migration: unlock it and convert it on the
                // first write (which retries the copy, see `save_vault_signed`) instead of locking
                // the user out because of a full disk or a read-only backup folder.
                Err(e) if migrating && canary.as_slice() == CANARY_PHRASE_V2.as_bytes() => {
                    eprintln!("[RemoteFlow] Kopia przed migracją do v3 nie powiodła się: {}", e);
                    warnings.push(tr!(
                        "Nie udało się utworzyć kopii sejfu przed zmianą formatu na v3 ({}). Sejf został odblokowany w dotychczasowym formacie; zapis zmian wymaga udanej kopii – zwolnij miejsce na dysku lub sprawdź uprawnienia folderu kopii.",
                        "Could not back up the vault before converting it to format v3 ({}). The vault was unlocked in its current format; saving changes requires a successful backup – free disk space or check the permissions of the backup folder.",
                        e
                    ));
                }
                Err(e) => return Err(e),
            }
        }
        vault
    };

    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    mgr.max_pin_attempts = sanitize_max_attempts(vault.metadata.max_pin_attempts);
    mgr.idle_timeout_mins = vault.metadata.auto_lock_timeout_mins;
    if vault.metadata.pin_enabled {
        if let Some(enc) = &vault.metadata.pin_encrypted_base64 {
            match decrypt_string_z(&key, enc) {
                Ok(pin) => {
                    if let Err(e) = mgr.arm_pin(&key, &pin) {
                        eprintln!("[RemoteFlow] Nie udało się przygotować blokady PIN: {}", e);
                    }
                }
                Err(e) => eprintln!("[RemoteFlow] Nie udało się odczytać kodu PIN: {}", e),
            }
        }
    }
    mgr.set_unlocked(key);
    // Verified list of trusted hosts – used for reconnects while the vault is locked later
    crate::vault::known_hosts::remember_verified(&vault.metadata.known_hosts);

    let warning = if warnings.is_empty() { None } else { Some(warnings.join("\n")) };
    Ok(build_status(Some(&vault), &mgr, warning))
}

#[tauri::command]
pub fn vault_lock(state: tauri::State<'_, AuthState>, app: tauri::AppHandle) -> Result<(), String> {
    crate::session::rdp_embed::set_locked(&app, true);
    crate::session::adhoc::clear();
    forget_scans();
    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    Ok(())
}

#[tauri::command]
pub fn vault_lock_to_pin(state: tauri::State<'_, AuthState>, app: tauri::AppHandle) -> Result<bool, String> {
    crate::session::rdp_embed::set_locked(&app, true);
    vault_lock_to_pin_impl(&state)
}

pub(crate) fn vault_lock_to_pin_impl(state: &AuthState) -> Result<bool, String> {
    let mut mgr = lock_auth(&state)?;
    if mgr.is_pin_locked && mgr.pin_wrap.is_some() {
        return Ok(true);
    }
    if mgr.is_unlocked && mgr.pin_wrap.is_some() {
        // Plain master key leaves memory; only the PIN-wrapped copy remains.
        mgr.master_key = None;
        mgr.is_unlocked = false;
        mgr.is_pin_locked = true;
        mgr.failed_pin_attempts = 0;
        return Ok(true);
    }
    // PIN not configured: full lock.
    mgr.clear();
    Ok(false)
}

/// Called when the operating-system session gets locked. Locks to PIN when a PIN is armed,
/// otherwise fully. Returns `None` if the vault was not unlocked, `Some(pin_locked)` otherwise.
pub fn lock_on_os_session_lock(state: &AuthState) -> Option<bool> {
    let mut mgr = lock_auth(state).ok()?;
    if !mgr.is_unlocked {
        return None;
    }
    if mgr.pin_wrap.is_some() {
        mgr.master_key = None;
        mgr.is_unlocked = false;
        mgr.is_pin_locked = true;
        mgr.failed_pin_attempts = 0;
        Some(true)
    } else {
        mgr.clear();
        Some(false)
    }
}

#[tauri::command]
pub fn vault_unlock_pin(pin: &str, state: tauri::State<'_, AuthState>, app: tauri::AppHandle) -> Result<VaultStatus, String> {
    let status = vault_unlock_pin_impl(pin, &state)?;
    crate::session::rdp_embed::set_locked(&app, false);
    Ok(status)
}

pub(crate) fn vault_unlock_pin_impl(pin: &str, state: &AuthState) -> Result<VaultStatus, String> {
    let mut mgr = lock_auth(&state)?;
    if !mgr.is_pin_locked || mgr.pin_wrap.is_none() {
        return Err(tr!("Blokada PIN nie jest aktywna – wymagane jest Master Password", "PIN lock is not active – the Master Password is required").to_string());
    }

    let unwrapped = {
        let wrap = mgr.pin_wrap.as_ref().expect("checked above");
        let pin_key = derive_pin_key(pin, &wrap.salt)?;
        decrypt_bytes(&pin_key, &wrap.ciphertext, &wrap.nonce).map(Zeroizing::new)
    };

    match unwrapped {
        Ok(bytes) if bytes.len() == 32 => {
            let mut key = Zeroizing::new([0u8; 32]);
            key.copy_from_slice(&bytes);
            let vault = load_vault_verified(&key)?;
            mgr.set_unlocked(key);
            Ok(build_status(Some(&vault), &mgr, None))
        }
        _ => {
            mgr.failed_pin_attempts += 1;
            let attempts = mgr.failed_pin_attempts;
            let max_attempts = mgr.max_pin_attempts;
            if attempts >= max_attempts {
                // Drop the PIN-wrapped key entirely – only the Master Password can unlock now.
                mgr.clear();
                return Err(tr!(
                    "Przekroczono limit {} prób PIN! Wymagane jest podanie Master Password.", "Too many PIN attempts ({})! The Master Password is required.",
                    max_attempts
                ));
            }
            Err(tr!("Nieprawidłowy PIN! Pozostało prób: {}", "Wrong PIN! Attempts left: {}", max_attempts - attempts))
        }
    }
}

#[tauri::command]
pub fn vault_set_pin(pin: &str, enable: bool, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    vault_set_pin_impl(pin, enable, &state)
}

pub(crate) fn vault_set_pin_impl(pin: &str, enable: bool, state: &AuthState) -> Result<VaultStatus, String> {
    let mut mgr = lock_auth(&state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby zmienić konfigurację PIN", "The vault must be unlocked to change the PIN settings").to_string())?
        .clone();

    let vault = if enable {
        let len = pin.chars().count();
        if !(MIN_PIN_LEN..=MAX_PIN_LEN).contains(&len) || !pin.chars().all(|c| c.is_ascii_digit()) {
            return Err(tr!("PIN musi składać się z {}-{} cyfr", "The PIN must have {}-{} digits", MIN_PIN_LEN, MAX_PIN_LEN));
        }
        let pin_encrypted = encrypt_string(&key, pin)?;
        let vault = update_vault(&key, |v| {
            clear_pin_metadata(&mut v.metadata);
            v.metadata.pin_enabled = true;
            v.metadata.pin_encrypted_base64 = Some(pin_encrypted);
            Ok(v.clone())
        })?;
        mgr.arm_pin(&key, pin)?;
        vault
    } else {
        let vault = update_vault(&key, |v| {
            clear_pin_metadata(&mut v.metadata);
            Ok(v.clone())
        })?;
        mgr.pin_wrap = None;
        vault
    };

    Ok(build_status(Some(&vault), &mgr, None))
}

#[tauri::command]
pub fn vault_update_security_settings(
    auto_lock_screen: bool,
    auto_lock_timeout_mins: u32,
    state: tauri::State<'_, AuthState>,
) -> Result<(), String> {
    let mut mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?.clone();
    update_vault(&key, |v| {
        v.metadata.auto_lock_screen = auto_lock_screen;
        v.metadata.auto_lock_timeout_mins = auto_lock_timeout_mins;
        Ok(())
    })?;
    mgr.idle_timeout_mins = auto_lock_timeout_mins;
    mgr.last_activity = std::time::Instant::now();
    Ok(())
}

/// The UI reports user activity (throttled) – used by the inactivity auto-lock.
#[tauri::command]
pub fn vault_touch_activity(state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mut mgr = lock_auth(&state)?;
    if mgr.is_unlocked {
        mgr.last_activity = std::time::Instant::now();
    }
    Ok(())
}

/// Inactivity auto-lock, checked periodically by the backend monitor (works even when the web
/// view's timers are throttled, e.g. minimised window). Returns `Some(pin_locked)` if it locked.
pub fn lock_if_idle(state: &AuthState) -> Option<bool> {
    let idle = {
        let mgr = lock_auth(state).ok()?;
        if !mgr.is_unlocked || mgr.idle_timeout_mins == 0 {
            return None;
        }
        mgr.last_activity.elapsed() >= std::time::Duration::from_secs(u64::from(mgr.idle_timeout_mins) * 60)
    };
    if idle {
        lock_on_os_session_lock(state)
    } else {
        None
    }
}

#[tauri::command]
pub fn vault_reset(state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    // Non-destructive: the current file is renamed to vault.json.bak_<timestamp>.
    delete_vault()?;
    crate::vault::known_hosts::forget_verified();
    crate::session::adhoc::clear();
    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    Ok(build_status(None, &mgr, None))
}

#[tauri::command]
pub fn vault_change_master_password(current_password: &str, new_password: &str, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    vault_change_master_password_impl(current_password, new_password, &state)
}

pub(crate) fn vault_change_master_password_impl(current_password: &str, new_password: &str, state: &AuthState) -> Result<VaultStatus, String> {
    check_new_password(new_password, "Nowe Master Password")?;
    {
        let mgr = lock_auth(&state)?;
        mgr.unlocked_key()?;
    }

    let initial = load_vault()?.ok_or(tr!("Sejf nie istnieje", "The vault does not exist"))?;
    let old_salt = BASE64
        .decode(&initial.metadata.salt_base64)
        .map_err(|e| tr!("Błąd dekodowania soli: {}", "Salt decoding error: {}", e))?;
    let old_key = derive_key(current_password, &old_salt)?;
    let new_salt = generate_salt();
    let new_key = derive_key(new_password, &new_salt)?;

    fn reencrypt_field(old_k: &[u8; 32], new_k: &[u8; 32], field: &mut Option<String>) -> Result<(), String> {
        if let Some(val) = field {
            if !val.is_empty() {
                let plain = decrypt_string_z(old_k, val)?;
                *field = Some(encrypt_string(new_k, &plain)?);
            }
        }
        Ok(())
    }

    let vault = {
        let _io = lock_io();
        let vault = load_vault()?.ok_or(tr!("Sejf nie istnieje", "The vault does not exist"))?;
        if vault.metadata.salt_base64 != initial.metadata.salt_base64 {
            return Err(tr!("Plik sejfu zmienił się w trakcie operacji – spróbuj ponownie", "The vault file changed during the operation – try again").to_string());
        }

        // 1. Verify current password (canary) and file integrity.
        let canary =
            open_canary(&old_key, &vault.metadata).map_err(|_| tr!("Obecne Master Password jest nieprawidłowe", "The current Master Password is incorrect").to_string())?;
        let mut vault = open_vault_envelope(vault, &old_key)?;
        if ![CANARY_PHRASE_V2.as_bytes(), CANARY_PHRASE_V3.as_bytes()].contains(&canary.as_slice()) || !verify_vault_mac(&vault, &old_key) {
            return Err(integrity_error());
        }

        // 2. Re-encrypt all connection and credential secrets.
        for conn in vault.connections.iter_mut() {
            reencrypt_field(&old_key, &new_key, &mut conn.password_encrypted)?;
            reencrypt_field(&old_key, &new_key, &mut conn.private_key_encrypted)?;
            reencrypt_field(&old_key, &new_key, &mut conn.private_key_passphrase_encrypted)?;
        }
        for cred in vault.credentials.iter_mut() {
            reencrypt_field(&old_key, &new_key, &mut cred.password_encrypted)?;
            reencrypt_field(&old_key, &new_key, &mut cred.private_key_encrypted)?;
            reencrypt_field(&old_key, &new_key, &mut cred.private_key_passphrase_encrypted)?;
        }

        // 3. New salt + canary, PIN reset.
        vault.metadata.salt_base64 = BASE64.encode(new_salt);
        set_current_canary(&new_key, &mut vault.metadata)?;
        clear_pin_metadata(&mut vault.metadata);

        // 4. Restore point (old password), then atomic, signed write.
        backup_while_locked(&vault.metadata.backup, "pre-password-change", false)?;
        save_vault_signed(&mut vault, &new_key)?;
        vault
    };

    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    mgr.max_pin_attempts = sanitize_max_attempts(vault.metadata.max_pin_attempts);
    mgr.idle_timeout_mins = vault.metadata.auto_lock_timeout_mins;
    mgr.set_unlocked(new_key);
    Ok(build_status(Some(&vault), &mgr, None))
}
