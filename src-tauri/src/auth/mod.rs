use crate::vault::cipher::{
    decrypt_bytes, decrypt_opt, decrypt_string, decrypt_string_z, derive_key, derive_pin_key,
    encrypt_bytes, encrypt_string, generate_salt, SecretKey, CANARY_PHRASE_V1, CANARY_PHRASE_V2,
    MIN_MASTER_PASSWORD_LEN, CANARY_PHRASE_V3,
};
use crate::vault::models::{
    Connection, Credential, DecryptedExportData, ExportPayload, Group, ImportSummary,
    KnownHostEntry, VaultData, VaultMetadata, VaultStatus,
};
use crate::vault::backup::{self, backup_while_locked};
use crate::vault::models::{BackupEntry, BackupSettings, UiSettings};
use crate::vault::storage::{
    delete_vault, get_vault_path, integrity_error, load_vault, load_vault_verified, lock_io,
    save_vault_signed, update_vault, vault_exists, verify_vault_mac, open_vault_envelope,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard};
use zeroize::Zeroizing;

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
pub fn vault_unlock_master(master_password: &str, accept_modified: Option<bool>, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    vault_unlock_master_impl(master_password, accept_modified, &state)
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
pub fn vault_lock(state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    Ok(())
}

#[tauri::command]
pub fn vault_lock_to_pin(state: tauri::State<'_, AuthState>) -> Result<bool, String> {
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
pub fn vault_unlock_pin(pin: &str, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    vault_unlock_pin_impl(pin, &state)
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
pub fn vault_get_data(state: tauri::State<'_, AuthState>) -> Result<VaultData, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let mut vault = load_vault_verified(key)?;
    // Not needed by the UI.
    vault.mac = None;
    vault.metadata.pin_encrypted_base64 = None;
    Ok(vault)
}

#[tauri::command]
pub fn vault_reveal_password(connection_id: &str, state: tauri::State<'_, AuthState>) -> Result<String, String> {
    vault_reveal_password_impl(connection_id, &state)
}

pub(crate) fn vault_reveal_password_impl(connection_id: &str, state: &AuthState) -> Result<String, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let vault = load_vault_verified(key)?;
    let conn = vault
        .connections
        .iter()
        .find(|c| c.id == connection_id)
        .ok_or(tr!("Nie znaleziono połączenia", "Connection not found"))?;

    if let Some(pwd) = decrypt_opt(key, &conn.password_encrypted)? {
        return Ok(pwd);
    }

    if let Some(cred_id) = &conn.credential_id {
        if let Some(cred) = vault.credentials.iter().find(|c| c.id == *cred_id) {
            if let Some(pwd) = decrypt_opt(key, &cred.password_encrypted)? {
                return Ok(pwd);
            }
        }
    }

    Ok(String::new())
}

#[tauri::command]
pub fn vault_save_connection(connection: Connection, raw_password: Option<String>, raw_private_key: Option<String>, raw_passphrase: Option<String>, state: tauri::State<'_, AuthState>) -> Result<Connection, String> {
    vault_save_connection_impl(connection, raw_password, raw_private_key, raw_passphrase, &state)
}

#[tauri::command]
pub fn vault_set_connection_password(connection_id: String, password: String, state: tauri::State<'_, AuthState>) -> Result<Connection, String> {
    vault_set_connection_password_impl(&connection_id, password, &state)
}

pub(crate) fn vault_set_connection_password_impl(connection_id: &str, password: String, state: &AuthState) -> Result<Connection, String> {
    let password = Zeroizing::new(password);
    if password.is_empty() {
        return Err(tr!("Wprowadź niepuste hasło", "Enter a non-empty password").into());
    }
    let mgr = lock_auth(state)?;
    let key = mgr.unlocked_key()?;
    let encrypted = encrypt_string(key, &password)?;
    update_vault(key, |v| {
        let conn = v.connections.iter_mut().find(|c| c.id == connection_id)
            .ok_or_else(|| tr!("Nie znaleziono połączenia", "Connection not found").to_string())?;
        conn.password_encrypted = Some(encrypted);
        conn.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(conn.clone())
    })
}

pub(crate) fn vault_save_connection_impl(mut connection: Connection, raw_password: Option<String>, raw_private_key: Option<String>, raw_passphrase: Option<String>, state: &AuthState) -> Result<Connection, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;

    seal_raw(key, raw_password, &mut connection.password_encrypted)?;
    seal_raw(key, raw_private_key, &mut connection.private_key_encrypted)?;
    seal_raw(key, raw_passphrase, &mut connection.private_key_passphrase_encrypted)?;

    let now = chrono::Utc::now().to_rfc3339();
    connection.updated_at = now.clone();
    if connection.created_at.is_empty() {
        connection.created_at = now;
    }

    let saved = connection.clone();
    update_vault(key, |v| {
        upsert_by_id(&mut v.connections, connection, |c| c.id.as_str());
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn vault_delete_connection(connection_id: &str, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        v.connections.retain(|c| c.id != connection_id);
        Ok(())
    })
}

#[tauri::command]
pub fn vault_clone_connection(connection_id: &str, state: tauri::State<'_, AuthState>) -> Result<Connection, String> {
    vault_clone_connection_impl(connection_id, &state)
}

pub(crate) fn vault_clone_connection_impl(connection_id: &str, state: &AuthState) -> Result<Connection, String> {
    let mgr = lock_auth(state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        let index = v.connections.iter().position(|c| c.id == connection_id)
            .ok_or_else(|| tr!("Nie znaleziono połączenia", "Connection not found").to_string())?;
        let mut copy = v.connections[index].clone();
        let names: std::collections::HashSet<_> = v.connections.iter().map(|c| c.name.to_lowercase()).collect();
        let label = tr!("kopia", "copy");
        let base = copy.name.clone();
        copy.name = format!("{} ({})", base, label);
        let mut number = 2;
        while names.contains(&copy.name.to_lowercase()) {
            copy.name = format!("{} ({} {})", base, label, number);
            number += 1;
        }
        copy.id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        copy.created_at = now.clone();
        copy.updated_at = now;
        // Secrets already use this vault's key. Copy ciphertext without exposing plaintext
        // to the frontend; the complete new vault is authenticated and encrypted on write.
        v.connections.insert(index + 1, copy.clone());
        Ok(copy)
    })
}

#[tauri::command]
pub fn vault_save_group(group: Group, state: tauri::State<'_, AuthState>) -> Result<Group, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let saved = group.clone();
    update_vault(key, |v| {
        upsert_by_id(&mut v.groups, group, |g| g.id.as_str());
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn vault_delete_group(group_id: &str, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        // Remove group and reassign orphaned connections to None
        v.groups.retain(|g| g.id != group_id);
        for conn in v.connections.iter_mut() {
            if conn.group_id.as_deref() == Some(group_id) {
                conn.group_id = None;
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn vault_export(export_password: Option<String>, allow_plaintext: Option<bool>, group_ids: Option<Vec<String>>, include_ungrouped: Option<bool>, state: tauri::State<'_, AuthState>) -> Result<String, String> {
    vault_export_impl(export_password, allow_plaintext, group_ids, include_ungrouped.unwrap_or(false), &state)
}

fn filter_export_scope(vault: &mut VaultData, group_ids: Option<&[String]>, include_ungrouped: bool) -> Result<(), String> {
    let Some(group_ids) = group_ids else { return Ok(()); }; // None means the complete vault.
    if group_ids.is_empty() && !include_ungrouped {
        return Err(tr!("Wybierz co najmniej jedną grupę lub połączenia bez grupy", "Select at least one group or ungrouped connections").into());
    }
    let parents: BTreeMap<_, _> = vault.groups.iter().map(|g| (g.id.clone(), g.parent_id.clone())).collect();
    if group_ids.iter().any(|id| !parents.contains_key(id)) {
        return Err(tr!("Wybrana grupa już nie istnieje. Wybierz zakres eksportu ponownie.", "A selected group no longer exists. Select the export scope again.").into());
    }
    let mut included: std::collections::BTreeSet<String> = group_ids.iter().cloned().collect();
    loop {
        let before = included.len();
        for group in &vault.groups {
            if group.parent_id.as_ref().is_some_and(|id| included.contains(id)) { included.insert(group.id.clone()); }
        }
        if included.len() == before { break; }
    }
    vault.connections.retain(|connection| match connection.group_id.as_ref() {
        Some(id) if parents.contains_key(id) => included.contains(id),
        _ => include_ungrouped,
    });
    let credentials: std::collections::BTreeSet<_> = vault.connections.iter().filter_map(|c| c.credential_id.clone()).collect();
    vault.credentials.retain(|credential| credentials.contains(&credential.id));
    // Preserve the parent folder chain, but never add its other connections or sibling groups.
    let mut folders = included.clone();
    for id in included {
        let mut current = parents.get(&id).and_then(|parent| parent.clone());
        while let Some(parent) = current {
            if !parents.contains_key(&parent) || !folders.insert(parent.clone()) { break; }
            current = parents.get(&parent).and_then(|next| next.clone());
        }
    }
    vault.groups.retain(|group| folders.contains(&group.id));
    Ok(())
}

pub(crate) fn vault_export_impl(export_password: Option<String>, allow_plaintext: Option<bool>, group_ids: Option<Vec<String>>, include_ungrouped: bool, state: &AuthState) -> Result<String, String> {
    let mgr = lock_auth(&state).map_err(|e| e.to_string())?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby wyeksportować dane", "The vault must be unlocked to export data").to_string())?;

    let mut vault = load_vault_verified(key)?;
    filter_export_scope(&mut vault, group_ids.as_deref(), include_ungrouped)?;
    let now = chrono::Utc::now().to_rfc3339();

    // Decrypt EVERY secret field. Any failure aborts the export instead of silently
    // writing ciphertext that could never be imported correctly.
    let mut clean_connections = Vec::with_capacity(vault.connections.len());
    for conn in &vault.connections {
        let mut clean = conn.clone();
        let ctx = |e: String| tr!("Nie udało się odszyfrować danych połączenia '{}': {}", "Could not decrypt the data of connection '{}': {}", conn.name, e);
        clean.password_encrypted = decrypt_opt(key, &conn.password_encrypted).map_err(ctx)?;
        clean.private_key_encrypted = decrypt_opt(key, &conn.private_key_encrypted).map_err(ctx)?;
        clean.private_key_passphrase_encrypted =
            decrypt_opt(key, &conn.private_key_passphrase_encrypted).map_err(ctx)?;
        clean_connections.push(clean);
    }
    let mut clean_credentials = Vec::with_capacity(vault.credentials.len());
    for cred in &vault.credentials {
        let mut clean = cred.clone();
        let ctx = |e: String| tr!("Nie udało się odszyfrować poświadczenia '{}': {}", "Could not decrypt credential '{}': {}", cred.name, e);
        clean.password_encrypted = decrypt_opt(key, &cred.password_encrypted).map_err(ctx)?;
        clean.private_key_encrypted = decrypt_opt(key, &cred.private_key_encrypted).map_err(ctx)?;
        clean.private_key_passphrase_encrypted =
            decrypt_opt(key, &cred.private_key_passphrase_encrypted).map_err(ctx)?;
        clean_credentials.push(clean);
    }

    if let Some(password) = export_password {
        let password = Zeroizing::new(password);
        check_new_password(&password, tr!("Hasło eksportu", "The export password"))?;

        let mut decrypted_data = DecryptedExportData {
            groups: vault.groups,
            connections: clean_connections,
            credentials: clean_credentials,
            exported_at: now.clone(),
        };
        let json_bytes = Zeroizing::new(
            serde_json::to_vec(&decrypted_data).map_err(|e| tr!("Błąd serializacji danych eksportu: {}", "Export data serialisation error: {}", e))?,
        );
        // The decrypted secrets are only needed in the serialised (wiped on drop) buffer
        {
            use zeroize::Zeroize;
            for c in &mut decrypted_data.connections {
                for secret in [&mut c.password_encrypted, &mut c.private_key_encrypted, &mut c.private_key_passphrase_encrypted].into_iter().flatten() {
                    secret.zeroize();
                }
            }
            for c in &mut decrypted_data.credentials {
                for secret in [&mut c.password_encrypted, &mut c.private_key_encrypted, &mut c.private_key_passphrase_encrypted].into_iter().flatten() {
                    secret.zeroize();
                }
            }
        }

        let salt = generate_salt();
        let export_key = derive_key(&password, &salt)?;
        let (ciphertext, nonce) = encrypt_bytes(&export_key, &json_bytes)?;

        let payload = ExportPayload {
            format: "remoteflow_export".to_string(),
            version: VAULT_FORMAT_VERSION,
            is_encrypted: true,
            salt_base64: Some(BASE64.encode(salt)),
            nonce_base64: Some(BASE64.encode(nonce)),
            ciphertext_base64: Some(BASE64.encode(ciphertext)),
            groups: None,
            connections: None,
            credentials: None,
            exported_at: now,
        };
        serde_json::to_string_pretty(&payload).map_err(|e| tr!("Błąd serializacji pliku eksportu: {}", "Export file serialisation error: {}", e))
    } else {
        if allow_plaintext != Some(true) {
            return Err(tr!("Eksport bez szyfrowania zapisuje wszystkie hasła i klucze jawnym tekstem – wymaga wyraźnego potwierdzenia", "An unencrypted export stores all passwords and keys in plain text – explicit confirmation is required").to_string());
        }
        let payload = ExportPayload {
            format: "remoteflow_export".to_string(),
            version: VAULT_FORMAT_VERSION,
            is_encrypted: false,
            salt_base64: None,
            nonce_base64: None,
            ciphertext_base64: None,
            groups: Some(vault.groups),
            connections: Some(clean_connections),
            credentials: Some(clean_credentials),
            exported_at: now,
        };
        serde_json::to_string_pretty(&payload).map_err(|e| tr!("Błąd serializacji pliku eksportu: {}", "Export file serialisation error: {}", e))
    }
}

#[tauri::command]
pub fn vault_import(payload_json: String, import_password: Option<String>, merge: bool, state: tauri::State<'_, AuthState>) -> Result<ImportSummary, String> {
    vault_import_impl(payload_json, import_password, merge, &state)
}

pub(crate) fn vault_import_impl(payload_json: String, import_password: Option<String>, merge: bool, state: &AuthState) -> Result<ImportSummary, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby zaimportować dane", "The vault must be unlocked to import data").to_string())?;

    let export_payload: ExportPayload =
        serde_json::from_str(&payload_json).map_err(|e| tr!("Błąd parsowania pliku importu: {}", "Import file parse error: {}", e))?;
    if export_payload.format != "remoteflow_export" {
        return Err(tr!("Nieobsługiwany format pliku importu", "Unsupported import file format").to_string());
    }
    // v1 exports: the passphrase field (and fields whose decryption failed) still hold
    // ciphertext of the source vault.
    let legacy = export_payload.version < 2;

    let (imported_groups, mut imported_connections, mut imported_credentials) = if export_payload.is_encrypted {
        let password = Zeroizing::new(import_password.ok_or(tr!("Plik importu jest zaszyfrowany. Wprowadź hasło.", "The import file is encrypted. Enter the password."))?);
        let salt_b64 = export_payload.salt_base64.ok_or(tr!("Brak soli w pliku importu", "The import file has no salt"))?;
        let nonce_b64 = export_payload.nonce_base64.ok_or(tr!("Brak nonce w pliku importu", "The import file has no nonce"))?;
        let ct_b64 = export_payload.ciphertext_base64.ok_or(tr!("Brak szyfrogramu w pliku importu", "The import file has no ciphertext"))?;

        let salt = BASE64.decode(salt_b64).map_err(|e| e.to_string())?;
        let nonce = decode_nonce(&nonce_b64)?;
        let ct = BASE64.decode(ct_b64).map_err(|e| e.to_string())?;

        let import_key = derive_key(&password, &salt)?;
        let decrypted_bytes = Zeroizing::new(
            decrypt_bytes(&import_key, &ct, &nonce)
                .map_err(|_| tr!("Błędne hasło pliku importu lub uszkodzone dane", "Wrong import file password or corrupted data").to_string())?,
        );
        let data: DecryptedExportData = serde_json::from_slice(&decrypted_bytes)
            .map_err(|e| tr!("Błąd parsowania odszyfrowanych danych: {}", "Error parsing the decrypted data: {}", e))?;
        (data.groups, data.connections, data.credentials)
    } else {
        (
            export_payload.groups.unwrap_or_default(),
            export_payload.connections.unwrap_or_default(),
            export_payload.credentials.unwrap_or_default(),
        )
    };

    for conn in imported_connections.iter_mut() {
        seal_connection(key, conn, legacy)?;
    }
    for cred in imported_credentials.iter_mut() {
        seal_credential(key, cred, legacy)?;
    }

    let summary = ImportSummary {
        groups_imported: imported_groups.len(),
        connections_imported: imported_connections.len(),
        credentials_imported: imported_credentials.len(),
        passwords_failed: 0,
    };

    update_vault(key, |v| {
        if !merge {
            // Replacing all connections – keep a restore point first.
            backup_while_locked(&v.metadata.backup, "pre-import", true)?;
        }
        if merge {
            for group in imported_groups {
                if !v.groups.iter().any(|g| g.id == group.id) {
                    v.groups.push(group);
                }
            }
            for conn in imported_connections {
                upsert_by_id(&mut v.connections, conn, |c| c.id.as_str());
            }
            for cred in imported_credentials {
                upsert_by_id(&mut v.credentials, cred, |c| c.id.as_str());
            }
        } else {
            v.groups = imported_groups;
            v.connections = imported_connections;
            // Legacy exports did not contain credentials – keep the existing ones then.
            if !legacy {
                v.credentials = imported_credentials;
            }
        }
        Ok(())
    })?;

    Ok(summary)
}

#[tauri::command]
pub fn vault_batch_import(
    groups: Vec<Group>,
    connections: Vec<Connection>,
    merge: bool,
    mremoteng: Option<crate::vault::mremoteng::MrngParams>,
    state: tauri::State<'_, AuthState>,
) -> Result<ImportSummary, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr
        .unlocked_key()
        .map_err(|_| tr!("Sejf musi być odblokowany, aby zaimportować połączenia", "The vault must be unlocked to import connections").to_string())?;

    let groups_count = groups.len();
    let conns_count = connections.len();

    // mRemoteNG: the password fields still hold mRemoteNG ciphertext – decrypt them here, so the
    // plaintext never passes through the UI.
    let mut encrypted_conns = connections;
    let mut passwords_failed = 0usize;
    if let Some(params) = &mremoteng {
        crate::vault::mremoteng::verify_password(params, None)?;
        for conn in encrypted_conns.iter_mut() {
            if let Some(raw) = conn.password_encrypted.take() {
                if raw.trim().is_empty() {
                    continue;
                }
                match crate::vault::mremoteng::decrypt_value(params, &raw) {
                    Some(plain) => conn.password_encrypted = Some(plain.to_string()),
                    None => passwords_failed += 1,
                }
            }
        }
    }

    // Every secret field is now plaintext – encrypt all of them with the vault key.
    for conn in encrypted_conns.iter_mut() {
        seal_connection(key, conn, false)?;
    }

    update_vault(key, |v| {
        if merge {
            for group in groups {
                if !v.groups.iter().any(|g| g.id == group.id) {
                    v.groups.push(group);
                }
            }
            for conn in encrypted_conns {
                upsert_by_id(&mut v.connections, conn, |c| c.id.as_str());
            }
        } else {
            v.groups = groups;
            v.connections = encrypted_conns;
        }
        Ok(())
    })?;

    Ok(ImportSummary {
        groups_imported: groups_count,
        connections_imported: conns_count,
        credentials_imported: 0,
        passwords_failed,
    })
}

#[tauri::command]
pub fn vault_reset(state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    // Non-destructive: the current file is renamed to vault.json.bak_<timestamp>.
    delete_vault()?;
    crate::vault::known_hosts::forget_verified();
    let mut mgr = lock_auth(&state)?;
    mgr.clear();
    Ok(build_status(None, &mgr, None))
}

#[tauri::command]
pub fn vault_get_credentials(state: tauri::State<'_, AuthState>) -> Result<Vec<Credential>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    Ok(load_vault_verified(key)?.credentials)
}

#[tauri::command]
pub fn vault_save_credential(
    mut credential: Credential,
    raw_password: Option<String>,
    raw_private_key: Option<String>,
    raw_passphrase: Option<String>,
    state: tauri::State<'_, AuthState>,
) -> Result<Credential, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;

    seal_raw(key, raw_password, &mut credential.password_encrypted)?;
    seal_raw(key, raw_private_key, &mut credential.private_key_encrypted)?;
    seal_raw(key, raw_passphrase, &mut credential.private_key_passphrase_encrypted)?;

    let now = chrono::Utc::now().to_rfc3339();
    credential.updated_at = now.clone();
    if credential.created_at.is_empty() {
        credential.created_at = now;
    }

    let saved = credential.clone();
    update_vault(key, |v| {
        upsert_by_id(&mut v.credentials, credential, |c| c.id.as_str());
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub fn vault_delete_credential(credential_id: &str, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        v.credentials.retain(|c| c.id != credential_id);
        for conn in v.connections.iter_mut() {
            if conn.credential_id.as_deref() == Some(credential_id) {
                conn.credential_id = None;
            }
        }
        Ok(())
    })
}

#[tauri::command]
pub fn vault_reveal_credential_password(
    credential_id: &str,
    state: tauri::State<'_, AuthState>,
) -> Result<String, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let vault = load_vault_verified(key)?;
    let cred = vault
        .credentials
        .iter()
        .find(|c| c.id == credential_id)
        .ok_or(tr!("Nie znaleziono poświadczenia", "Credential not found"))?;
    Ok(decrypt_opt(key, &cred.password_encrypted)?.unwrap_or_default())
}

/// Saves (or clears with `None`) the SFTP start folders of one connection.
#[tauri::command]
pub fn vault_set_connection_sftp_dirs(
    connection_id: String,
    local_dir: Option<String>,
    remote_dir: Option<String>,
    state: tauri::State<'_, AuthState>,
) -> Result<(), String> {
    let clean = |d: Option<String>| d.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        let conn = v
            .connections
            .iter_mut()
            .find(|c| c.id == connection_id)
            .ok_or(tr!("Nie znaleziono połączenia", "Connection not found"))?;
        conn.sftp_local_dir = clean(local_dir);
        conn.sftp_remote_dir = clean(remote_dir);
        if conn.protocol == "ssh" {
            // The legacy SFTP folder is replaced by the new fields.
            conn.default_download_dir = None;
        }
        conn.updated_at = chrono::Utc::now().to_rfc3339();
        Ok(())
    })
}

#[tauri::command]
pub fn vault_list_known_hosts(state: tauri::State<'_, AuthState>) -> Result<Vec<KnownHostEntry>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let vault = load_vault_verified(key)?;
    crate::vault::known_hosts::remember_verified(&vault.metadata.known_hosts);
    Ok(vault
        .metadata
        .known_hosts
        .into_iter()
        .map(|(id, fingerprint)| KnownHostEntry { id, fingerprint })
        .collect())
}

#[tauri::command]
pub fn vault_forget_known_host(id: String, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    update_vault(key, |v| {
        v.metadata.known_hosts.remove(&id);
        crate::vault::known_hosts::remember_verified(&v.metadata.known_hosts);
        Ok(())
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_imported_does_not_double_encrypt_own_ciphertext() {
        let key = Zeroizing::new([3u8; 32]);
        let own = encrypt_string(&key, "secret").unwrap();

        let mut field = Some(own.clone());
        seal_imported(&key, &mut field, true).unwrap();
        assert_eq!(field.as_deref(), Some(own.as_str()));

        let mut plain = Some("secret".to_string());
        seal_imported(&key, &mut plain, true).unwrap();
        assert_eq!(decrypt_string(&key, plain.as_ref().unwrap()).unwrap(), "secret");

        let mut empty = Some(String::new());
        seal_imported(&key, &mut empty, false).unwrap();
        assert!(empty.is_none());
    }

    #[test]
    fn idle_auto_lock() {
        let state: AuthState = Mutex::new(AuthManager::new());
        {
            let mut mgr = state.lock().unwrap();
            mgr.set_unlocked(Zeroizing::new([5u8; 32]));
            mgr.idle_timeout_mins = 1;
        }
        assert_eq!(lock_if_idle(&state), None, "fresh activity -> no lock");
        {
            let mut mgr = state.lock().unwrap();
            mgr.last_activity = std::time::Instant::now() - std::time::Duration::from_secs(61);
        }
        assert_eq!(lock_if_idle(&state), Some(false), "idle > timeout -> full lock (no PIN)");
        assert!(!state.lock().unwrap().is_unlocked);
        assert_eq!(lock_if_idle(&state), None, "already locked");

        // with PIN armed -> PIN lock; timeout 0 disables
        {
            let mut mgr = state.lock().unwrap();
            let key = Zeroizing::new([5u8; 32]);
            mgr.arm_pin(&key, "1234").unwrap();
            mgr.set_unlocked(key);
            mgr.idle_timeout_mins = 0;
            mgr.last_activity = std::time::Instant::now() - std::time::Duration::from_secs(3600);
        }
        assert_eq!(lock_if_idle(&state), None, "timeout 0 = disabled");
        state.lock().unwrap().idle_timeout_mins = 5;
        assert_eq!(lock_if_idle(&state), Some(true));
        assert!(state.lock().unwrap().is_pin_locked);
    }

    #[test]
    fn pin_wrap_roundtrip_and_wrong_pin() {
        let master = Zeroizing::new([9u8; 32]);
        let mut mgr = AuthManager::new();
        mgr.arm_pin(&master, "1234").unwrap();
        let wrap = mgr.pin_wrap.as_ref().unwrap();
        let ok = decrypt_bytes(&derive_pin_key("1234", &wrap.salt).unwrap(), &wrap.ciphertext, &wrap.nonce).unwrap();
        assert_eq!(ok.as_slice(), master.as_slice());
        assert!(decrypt_bytes(&derive_pin_key("1235", &wrap.salt).unwrap(), &wrap.ciphertext, &wrap.nonce).is_err());
    }
}

/// End-to-end tests of the vault lifecycle (uses a real vault.json next to the test binary).
#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::vault::known_hosts::{check_host, HostTrust};

    fn conn(id: &str, host: &str) -> Connection {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": "srv", "groupId": null, "credentialId": null, "protocol": "ssh",
            "host": host, "port": 22, "username": "root", "passwordEncrypted": null,
            "sshAuthType": "password", "privateKeyEncrypted": null, "privateKeyPassphraseEncrypted": null,
            "certificateContent": null, "portForwarding": [], "rdpSettings": null, "tags": [],
            "notes": null, "createdAt": "", "updatedAt": ""
        }))
        .unwrap()
    }

    fn raw_file() -> String {
        std::fs::read_to_string(get_vault_path()).unwrap()
    }

    #[test]
    fn connection_draft_can_be_saved_after_idle_unlock() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let mut draft = vault_save_connection_impl(
            conn("draft", "10.0.0.1"), Some("original-secret".into()), None, None, &state,
        ).unwrap();
        vault_set_pin_impl("1234", true, &state).unwrap();
        draft.name = "Unfinished edit".into();
        draft.host = "10.0.0.2".into();
        {
            let mut mgr = state.lock().unwrap();
            mgr.idle_timeout_mins = 1;
            mgr.last_activity = std::time::Instant::now() - std::time::Duration::from_secs(61);
        }
        let before = raw_file();
        assert_eq!(lock_if_idle(&state), Some(true));
        assert!(vault_save_connection_impl(draft.clone(), None, None, None, &state).is_err());
        assert_eq!(raw_file(), before, "a locked editor cannot write");
        assert!(vault_unlock_pin_impl("0000", &state).is_err());
        vault_unlock_pin_impl("1234", &state).unwrap();
        assert_eq!(lock_if_idle(&state), None, "unlock resets the inactivity timer");
        draft = vault_save_connection_impl(draft, None, None, None, &state).unwrap();
        assert_eq!(draft.host, "10.0.0.2");
        assert_eq!(vault_reveal_password_impl("draft", &state).unwrap(), "original-secret");

        // The same draft also survives switching from PIN to Master Password.
        vault_lock(&state);
        draft.notes = Some("Resumed after Master Password".into());
        assert!(vault_save_connection_impl(draft.clone(), Some("new-secret".into()), None, None, &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        let saved = vault_save_connection_impl(draft, Some("new-secret".into()), None, None, &state).unwrap();
        assert_eq!(saved.notes.as_deref(), Some("Resumed after Master Password"));
        assert_eq!(vault_reveal_password_impl("draft", &state).unwrap(), "new-secret");
        vault_lock(&state);
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("draft", &state).unwrap(), "new-secret");
        assert!(!raw_file().contains("new-secret"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn full_lifecycle() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());

        // --- init ---------------------------------------------------------------------------
        assert!(vault_init_impl("short", &state).is_err(), "min length enforced");
        vault_init_impl("password123", &state).unwrap();
        assert!(vault_init_impl("password123", &state).is_err(), "init must not overwrite an existing vault");

        // --- secrets ------------------------------------------------------------------------
        vault_save_connection_impl(
            conn("c1", "10.0.0.1"),
            Some("s3cret".into()),
            Some("KEY".into()),
            Some("phrase".into()),
            &state,
        )
        .unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");
        assert!(!raw_file().contains("s3cret"));

        // --- lock without PIN = full lock -----------------------------------------------------
        assert!(!vault_lock_to_pin_impl(&state).unwrap());
        assert!(vault_reveal_password_impl("c1", &state).is_err());
        assert!(vault_unlock_master_impl("wrongpass1", None, &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();

        // --- PIN: never stored as wrapped key on disk, limited attempts -------------------------
        vault_set_pin_impl("1234", true, &state).unwrap();
        let file = raw_file();
        assert!(!file.contains("pin_wrapped_master_key_base64"));
        assert!(!file.contains("pin_encrypted_base64"), "PIN configuration is inside the encrypted envelope");
        assert!(vault_unlock_pin_impl("1234", &state).is_err(), "PIN unlock only when PIN-locked");
        assert!(vault_lock_to_pin_impl(&state).unwrap());
        assert!(vault_unlock_pin_impl("0000", &state).unwrap_err().contains("Pozostało"));
        vault_unlock_pin_impl("1234", &state).unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        assert!(vault_lock_to_pin_impl(&state).unwrap());
        for _ in 0..2 {
            assert!(vault_unlock_pin_impl("9999", &state).is_err());
        }
        assert!(vault_unlock_pin_impl("9999", &state).unwrap_err().contains("Przekroczono"));
        assert!(vault_unlock_pin_impl("1234", &state).is_err(), "correct PIN rejected after lockout");
        // PIN is re-armed after a Master Password unlock (PIN read from the encrypted vault)
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert!(vault_lock_to_pin_impl(&state).unwrap());
        vault_unlock_pin_impl("1234", &state).unwrap();

        // --- integrity: external modification is detected ------------------------------------
        let original = raw_file();
        assert!(!original.contains("10.0.0.1"), "host addresses must be encrypted too");
        let mut tampered: serde_json::Value = serde_json::from_str(&original).unwrap();
        tampered["metadata"]["auto_lock_timeout_mins"] = serde_json::json!(999);
        std::fs::write(&path, tampered.to_string()).unwrap();
        assert!(vault_reveal_password_impl("c1", &state).unwrap_err().contains("VAULT_INTEGRITY_FAILED"));
        vault_lock(&state);
        assert!(vault_unlock_master_impl("password123", None, &state)
            .unwrap_err()
            .contains("VAULT_INTEGRITY_FAILED"));
        assert!(vault_unlock_master_impl("password123", Some(true), &state).is_err(), "encrypted envelopes always require integrity");
        std::fs::write(&path, original).unwrap();
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        // --- export / import ------------------------------------------------------------------
        assert!(vault_export_impl(None, None, None, false, &state).is_err(), "plaintext export needs confirmation");
        let plain = vault_export_impl(None, Some(true), None, false, &state).unwrap();
        assert!(plain.contains("s3cret") && plain.contains("phrase"));
        let enc = vault_export_impl(Some("exportpass1".into()), None, None, false, &state).unwrap();
        assert!(!enc.contains("s3cret"));
        let summary = vault_import_impl(enc, Some("exportpass1".into()), true, &state).unwrap();
        assert_eq!(summary.connections_imported, 1);
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        let v = load_vault_verified(&key).unwrap();
        let c = v.connections.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(decrypt_string(&key, c.private_key_passphrase_encrypted.as_ref().unwrap()).unwrap(), "phrase");
        assert_eq!(decrypt_string(&key, c.private_key_encrypted.as_ref().unwrap()).unwrap(), "KEY");

        // --- known hosts (TOFU) -----------------------------------------------------------------
        assert_eq!(check_host(Some(&key), "ssh", "Srv", 22, "SHA256:a").unwrap(), HostTrust::NewlyTrusted);
        assert_eq!(check_host(Some(&key), "ssh", "srv", 22, "SHA256:a").unwrap(), HostTrust::Known);
        assert!(check_host(Some(&key), "ssh", "srv", 22, "SHA256:b").unwrap_err().contains("MITM"));
        assert_eq!(check_host(None, "ssh", "srv", 22, "SHA256:a").unwrap(), HostTrust::Known);
        assert!(check_host(None, "ssh", "other", 22, "SHA256:a").is_err(), "no TOFU while locked");
        // A fingerprint planted in the file (MAC not updated) is ignored while locked: only the
        // list verified with the master key counts.
        let original = raw_file();
        let mut json: serde_json::Value = serde_json::from_str(&original).unwrap();
        json["metadata"]["knownHosts"]["ssh:srv:22"] = serde_json::Value::String("SHA256:evil".into());
        json["metadata"]["knownHosts"]["ssh:planted:22"] = serde_json::Value::String("SHA256:evil".into());
        std::fs::write(get_vault_path(), serde_json::to_string(&json).unwrap()).unwrap();
        assert!(check_host(None, "ssh", "srv", 22, "SHA256:evil").is_err());
        assert!(check_host(None, "ssh", "planted", 22, "SHA256:evil").is_err());
        assert_eq!(check_host(None, "ssh", "srv", 22, "SHA256:a").unwrap(), HostTrust::Known);
        std::fs::write(get_vault_path(), original).unwrap();

        // --- change master password ---------------------------------------------------------------
        vault_change_master_password_impl("password123", "newpassword9", &state).unwrap();
        vault_lock(&state);
        assert!(vault_unlock_master_impl("password123", None, &state).is_err());
        vault_unlock_master_impl("newpassword9", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        // A signed v2 vault is upgraded without losing data; its backup remains restorable.
        let migration_key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        let mut v2 = load_vault_verified(&migration_key).unwrap();
        v2.metadata.version = 2;
        let (ct, nonce) = encrypt_bytes(&migration_key, CANARY_PHRASE_V2.as_bytes()).unwrap();
        v2.metadata.canary_ciphertext_base64 = BASE64.encode(ct);
        v2.metadata.canary_nonce_base64 = BASE64.encode(nonce);
        v2.mac = None;
        v2.mac = Some(crate::vault::cipher::compute_mac(&migration_key, &serde_json::to_vec(&v2).unwrap()).unwrap());
        std::fs::write(&path, serde_json::to_string_pretty(&v2).unwrap()).unwrap();
        assert!(raw_file().contains("10.0.0.1"));
        vault_lock(&state);
        vault_unlock_master_impl("newpassword9", None, &state).unwrap();
        assert!(!raw_file().contains("10.0.0.1"));
        assert_eq!(load_vault_verified(&migration_key).unwrap().metadata.version, 3);
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret");

        // --- legacy v1 vault is migrated -----------------------------------------------------------
        let salt = generate_salt();
        let k1 = derive_key("legacypass1", &salt).unwrap();
        let (cct, cn) = encrypt_bytes(&k1, CANARY_PHRASE_V1.as_bytes()).unwrap();
        let mut c_legacy = conn("old", "10.1.1.1");
        c_legacy.password_encrypted = Some(encrypt_string(&k1, "oldpw").unwrap());
        let legacy = serde_json::json!({
            "metadata": {
                "version": 1, "salt_base64": BASE64.encode(salt),
                "canary_nonce_base64": BASE64.encode(cn), "canary_ciphertext_base64": BASE64.encode(cct),
                "pin_enabled": true, "pin_salt_base64": "AAAA", "pin_wrapped_master_key_base64": "AAAA",
                "pin_nonce_base64": "AAAA", "auto_lock_screen": true, "auto_lock_timeout_mins": 15,
                "max_pin_attempts": 3
            },
            "groups": [], "connections": [c_legacy]
        });
        std::fs::write(&path, serde_json::to_string_pretty(&legacy).unwrap()).unwrap();
        vault_lock(&state);
        let st = vault_unlock_master_impl("legacypass1", None, &state).unwrap();
        assert!(st.security_warning.unwrap().contains("PIN"));
        assert!(!st.pin_enabled);
        let file = raw_file();
        assert!(file.contains("\"mac\"") && !file.contains("pin_wrapped_master_key_base64"));
        assert_eq!(vault_reveal_password_impl("old", &state).unwrap(), "oldpw");
        // A migrated (v2) vault can no longer be downgraded by stripping the MAC.
        let stripped: serde_json::Value = serde_json::from_str(&file).unwrap();
        let mut stripped = stripped;
        stripped.as_object_mut().unwrap().remove("mac");
        std::fs::write(&path, stripped.to_string()).unwrap();
        vault_lock(&state);
        assert!(vault_unlock_master_impl("legacypass1", None, &state)
            .unwrap_err()
            .contains("VAULT_INTEGRITY_FAILED"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn backups_and_restore() {
        // Separate state; runs after/before full_lifecycle in the same process – serialise via a file lock.
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let backups = crate::vault::backup::backup_dir(&BackupSettings::default());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&backups);
        let state: AuthState = Mutex::new(AuthManager::new());

        vault_init_impl("password123", &state).unwrap();
        assert!(!raw_file().contains("\"backup\""), "default backup settings are not serialised (MAC compatibility)");
        vault_save_connection_impl(conn("b1", "10.0.0.9"), Some("first".into()), None, None, &state).unwrap();

        let settings = BackupSettings::default();
        let first = crate::vault::backup::create_backup(&settings, "manual", false).unwrap().unwrap();
        // unchanged vault -> no duplicate automatic backup
        assert!(crate::vault::backup::create_backup(&settings, "auto", true).unwrap().is_none());

        vault_save_connection_impl(conn("b1", "10.0.0.9"), Some("second".into()), None, None, &state).unwrap();
        vault_change_master_password_impl("password123", "otherpass99", &state).unwrap();
        let list = crate::vault::backup::list_backups(&settings);
        assert!(list.iter().any(|b| b.name.contains("pre-password-change")));

        // rotation
        let small = BackupSettings { keep: 2, ..BackupSettings::default() };
        crate::vault::backup::create_backup(&small, "manual", false).unwrap();
        assert_eq!(crate::vault::backup::list_backups(&small).len(), 2);
        // the very first backup was rotated away; make a fresh one of the current state to restore later
        let _ = first;

        // restore the pre-password-change backup -> old password + old secret
        let pre = crate::vault::backup::list_backups(&settings)
            .into_iter()
            .find(|b| b.name.contains("pre-password-change"))
            .unwrap();
        crate::vault::backup::restore_backup(&settings, &pre.name).unwrap();
        lock_auth(&state).unwrap().clear();
        assert!(vault_unlock_master_impl("otherpass99", None, &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("b1", &state).unwrap(), "second");
        assert!(crate::vault::backup::restore_backup(&settings, "../vault.json").is_err());

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&backups);
    }

    #[test]
    fn failed_pre_migration_backup_does_not_lock_the_user_out() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let backups = path.with_file_name("backups");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&backups);
        let _ = std::fs::remove_file(&backups);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        vault_save_connection_impl(conn("c1", "10.0.0.1"), Some("s3cret".into()), None, None, &state).unwrap();
        // Turn the file into a signed v2 vault (as written by RemoteFlow < 1.6.1)
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        let mut v2 = load_vault_verified(&key).unwrap();
        v2.metadata.version = 2;
        let (ct, nonce) = encrypt_bytes(&key, CANARY_PHRASE_V2.as_bytes()).unwrap();
        v2.metadata.canary_ciphertext_base64 = BASE64.encode(ct);
        v2.metadata.canary_nonce_base64 = BASE64.encode(nonce);
        v2.mac = None;
        v2.mac = Some(crate::vault::cipher::compute_mac(&key, &serde_json::to_vec(&v2).unwrap()).unwrap());
        std::fs::write(&path, serde_json::to_string_pretty(&v2).unwrap()).unwrap();
        vault_lock(&state);

        // The backup folder cannot be created (a file is in the way)
        let _ = std::fs::remove_dir_all(&backups);
        std::fs::write(&backups, b"not a folder").unwrap();
        let status = vault_unlock_master_impl("password123", None, &state).unwrap();
        assert!(status.security_warning.unwrap_or_default().contains("v3"), "the user is told why");
        assert!(raw_file().contains("10.0.0.1"), "not converted without a backup");
        assert_eq!(vault_reveal_password_impl("c1", &state).unwrap(), "s3cret", "the vault is usable");
        assert!(vault_save_connection_impl(conn("c2", "10.0.0.2"), None, None, None, &state).is_err(),
            "writing (= converting) still requires the backup");
        assert!(raw_file().contains("10.0.0.1"));

        // Once the backup works, the first write converts the vault and keeps a restorable copy
        std::fs::remove_file(&backups).unwrap();
        vault_save_connection_impl(conn("c2", "10.0.0.2"), None, None, None, &state).unwrap();
        assert!(!raw_file().contains("10.0.0.1"));
        let copies: Vec<_> = std::fs::read_dir(&backups).unwrap().flatten().collect();
        assert!(copies.iter().any(|e| e.file_name().to_string_lossy().contains("pre-migration-v3")));
        assert!(copies.iter().any(|e| std::fs::read_to_string(e.path()).unwrap().contains("10.0.0.1")));
        let _ = std::fs::remove_dir_all(&backups);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn prompted_password_is_encrypted_and_does_not_change_shared_credentials() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let mut first = conn("first", "server-a");
        first.credential_id = Some("shared".into());
        let mut second = conn("second", "server-b");
        second.credential_id = Some("shared".into());
        vault_save_connection_impl(first, None, None, None, &state).unwrap();
        vault_save_connection_impl(second, None, None, None, &state).unwrap();
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        update_vault(&key, |v| {
            v.credentials.push(serde_json::from_value(serde_json::json!({
                "id": "shared", "name": "shared", "username": "alice", "authType": "password",
                "createdAt": "", "updatedAt": ""
            })).unwrap());
            Ok(())
        }).unwrap();
        assert!(vault_set_connection_password_impl("first", "".into(), &state).is_err());
        assert!(vault_set_connection_password_impl("missing", "secret".into(), &state).is_err());
        let saved = vault_set_connection_password_impl("first", "new connection password".into(), &state).unwrap();
        assert_eq!(saved.host, "server-a");
        assert_eq!(saved.credential_id.as_deref(), Some("shared"));
        assert_eq!(vault_reveal_password_impl("first", &state).unwrap(), "new connection password");
        assert_eq!(vault_reveal_password_impl("second", &state).unwrap(), "");
        assert!(load_vault_verified(&key).unwrap().credentials[0].password_encrypted.is_none());
        assert!(!raw_file().contains("new connection password"));
        vault_lock(&state);
        assert!(vault_set_connection_password_impl("first", "other".into(), &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl("first", &state).unwrap(), "new connection password");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn cloned_connections_preserve_configuration_and_secrets_with_independent_ids() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let mut source = conn("source", "server.example");
        source.name = "Production database".into();
        source.group_id = Some("group-prod".into());
        source.credential_id = Some("shared".into());
        source.tags = vec!["production".into()];
        source.notes = Some("Keep these notes".into());
        source.sftp_remote_dir = Some("/srv/data".into());
        source.rdp_settings = Some(serde_json::from_value(serde_json::json!({
            "width": 1920, "height": 1080, "colorDepth": 32, "sound": true, "clipboard": true
        })).unwrap());
        source.port_forwarding.push(serde_json::from_value(serde_json::json!({
            "id": "forward", "forwardType": "local", "localPort": 8000,
            "remoteHost": "localhost", "remotePort": 80, "enabled": true
        })).unwrap());
        let source = vault_save_connection_impl(source, Some("clone secret".into()), Some("PRIVATE KEY".into()), Some("key phrase".into()), &state).unwrap();
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        update_vault(&key, |v| {
            v.credentials.push(serde_json::from_value(serde_json::json!({
                "id": "shared", "name": "shared", "username": "alice", "authType": "password", "createdAt": "", "updatedAt": ""
            })).unwrap());
            Ok(())
        }).unwrap();
        let first = vault_clone_connection_impl("source", &state).unwrap();
        let second = vault_clone_connection_impl("source", &state).unwrap();
        assert_ne!(source.id, first.id);
        assert_ne!(first.id, second.id);
        assert_ne!(first.name, second.name);
        assert!(first.name.starts_with(&source.name));
        assert!(second.name.ends_with(" 2)"));
        let canonical = |connection: &Connection| {
            let mut json = serde_json::to_value(connection).unwrap();
            for field in ["id", "name", "createdAt", "updatedAt"] { json.as_object_mut().unwrap().remove(field); }
            json
        };
        assert_eq!(canonical(&source), canonical(&first));
        assert_eq!(canonical(&source), canonical(&second));
        assert_eq!(vault_reveal_password_impl(&first.id, &state).unwrap(), "clone secret");
        assert_eq!(decrypt_string(&key, first.private_key_encrypted.as_ref().unwrap()).unwrap(), "PRIVATE KEY");
        assert_eq!(decrypt_string(&key, first.private_key_passphrase_encrypted.as_ref().unwrap()).unwrap(), "key phrase");
        assert!(vault_clone_connection_impl("missing", &state).is_err());
        let saved = load_vault_verified(&key).unwrap();
        assert_eq!(saved.connections.len(), 3);
        assert_eq!(saved.credentials.len(), 1);
        assert_eq!(serde_json::to_value(&source).unwrap(), serde_json::to_value(&saved.connections[0]).unwrap());
        vault_set_connection_password_impl(&first.id, "only the copy".into(), &state).unwrap();
        assert_eq!(vault_reveal_password_impl(&source.id, &state).unwrap(), "clone secret");
        assert!(!raw_file().contains("clone secret"));
        vault_lock(&state);
        assert!(vault_clone_connection_impl("source", &state).is_err());
        vault_unlock_master_impl("password123", None, &state).unwrap();
        assert_eq!(vault_reveal_password_impl(&first.id, &state).unwrap(), "only the copy");
        assert_eq!(vault_reveal_password_impl(&second.id, &state).unwrap(), "clone secret");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_scope_preserves_subtrees_without_leaking_other_connections_or_credentials() {
        let _serial = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let path = get_vault_path();
        let _ = std::fs::remove_file(&path);
        let state: AuthState = Mutex::new(AuthManager::new());
        vault_init_impl("password123", &state).unwrap();
        let key = lock_auth(&state).unwrap().unlocked_key().unwrap().clone();
        update_vault(&key, |v| {
            let group = |id: &str, parent: Option<&str>| Group {
                id: id.into(), name: id.into(), parent_id: parent.map(str::to_string), icon: None, color: None,
            };
            v.groups = vec![group("parent", None), group("child", Some("parent")), group("grandchild", Some("child")), group("other", None)];
            for (id, secret) in [("used", "used-profile-secret"), ("unrelated", "unrelated-profile-secret"), ("unused", "unused-profile-secret")] {
                v.credentials.push(serde_json::from_value(serde_json::json!({
                    "id": id, "name": id, "username": id, "authType": "password", "passwordEncrypted": encrypt_string(&key, secret).unwrap(),
                    "createdAt": "", "updatedAt": ""
                })).unwrap());
            }
            Ok(())
        }).unwrap();
        for (id, group, credential) in [
            ("parent-conn", Some("parent"), Some("unrelated")), ("child-conn", Some("child"), Some("used")),
            ("grandchild-conn", Some("grandchild"), Some("used")), ("other-conn", Some("other"), Some("unrelated")), ("root-conn", None, None),
        ] {
            let mut connection = conn(id, &format!("{}.example", id));
            connection.group_id = group.map(str::to_string);
            connection.credential_id = credential.map(str::to_string);
            vault_save_connection_impl(connection, Some(format!("{}-secret", id)), None, None, &state).unwrap();
        }
        let plain = |selection, root| -> ExportPayload {
            serde_json::from_str(&vault_export_impl(None, Some(true), selection, root, &state).unwrap()).unwrap()
        };
        let all = plain(None, false);
        assert_eq!(all.connections.unwrap().len(), 5);
        assert_eq!(all.credentials.unwrap().len(), 3);
        let subset = plain(Some(vec!["child".into(), "grandchild".into()]), false);
        assert_eq!(subset.connections.as_ref().unwrap().len(), 2);
        assert_eq!(subset.credentials.as_ref().unwrap().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["used"]);
        assert_eq!(subset.groups.unwrap().iter().map(|g| g.id.as_str()).collect::<Vec<_>>(), vec!["parent", "child", "grandchild"]);
        let parent = plain(Some(vec!["parent".into(), "child".into()]), false);
        assert_eq!(parent.connections.unwrap().len(), 3, "overlapping selections do not duplicate connections");
        let multiple = plain(Some(vec!["child".into(), "other".into()]), false);
        assert_eq!(multiple.connections.unwrap().len(), 3);
        let root = plain(Some(vec![]), true);
        assert_eq!(root.connections.unwrap()[0].id, "root-conn");
        assert!(root.groups.unwrap().is_empty());
        assert!(root.credentials.unwrap().is_empty());
        assert_eq!(plain(Some(vec!["child".into()]), true).connections.unwrap().len(), 3);
        assert!(vault_export_impl(None, Some(true), Some(vec![]), false, &state).is_err());
        assert!(vault_export_impl(None, Some(true), Some(vec!["missing".into()]), true, &state).is_err());
        assert!(vault_export_impl(None, None, Some(vec!["child".into()]), false, &state).is_err(), "plaintext still requires confirmation");
        // Excluded secrets are never decrypted, even if damaged.
        update_vault(&key, |v| {
            v.connections.iter_mut().find(|c| c.id == "other-conn").unwrap().password_encrypted = Some("broken".into());
            v.credentials.iter_mut().find(|c| c.id == "unrelated").unwrap().password_encrypted = Some("broken".into());
            Ok(())
        }).unwrap();
        let partial = vault_export_impl(None, Some(true), Some(vec!["child".into()]), false, &state).unwrap();
        assert!(!partial.contains("parent-conn") && !partial.contains("other-conn") && !partial.contains("root-conn"));
        assert!(!partial.contains("unrelated-profile-secret") && !partial.contains("unused-profile-secret"));
        let encrypted = vault_export_impl(Some("exportpass1".into()), None, Some(vec!["child".into()]), false, &state).unwrap();
        assert!(!encrypted.contains("child-conn-secret"));
        let summary = vault_import_impl(encrypted, Some("exportpass1".into()), false, &state).unwrap();
        assert_eq!((summary.connections_imported, summary.groups_imported, summary.credentials_imported), (2, 3, 1));
        assert_eq!(vault_reveal_password_impl("child-conn", &state).unwrap(), "child-conn-secret");
        assert!(vault_reveal_password_impl("other-conn", &state).is_err());
        let restored = load_vault_verified(&key).unwrap();
        assert_eq!(restored.groups.iter().find(|g| g.id == "child").unwrap().parent_id.as_deref(), Some("parent"));
        assert_eq!(decrypt_string(&key, restored.credentials[0].password_encrypted.as_ref().unwrap()).unwrap(), "used-profile-secret");
        vault_lock(&state);
        assert!(vault_export_impl(None, Some(true), None, false, &state).is_err());
        let _ = std::fs::remove_file(&path);
    }

    static TEST_SERIAL: Mutex<()> = Mutex::new(());

    fn vault_lock(state: &AuthState) {
        lock_auth(state).unwrap().clear();
    }
}

// ---------------------------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn vault_get_ui_settings(state: tauri::State<'_, AuthState>) -> Result<UiSettings, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    Ok(load_vault_verified(key)?.metadata.ui)
}

#[tauri::command]
pub fn vault_set_ui_settings(settings: UiSettings, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?.clone();
    drop(mgr);
    let mut settings = settings;
    settings.terminal_scrollback = settings.terminal_scrollback.clamp(
        crate::vault::models::MIN_TERMINAL_SCROLLBACK,
        crate::vault::models::MAX_TERMINAL_SCROLLBACK,
    );
    update_vault(&key, |v| {
        v.metadata.ui = settings;
        Ok(())
    })
}

#[tauri::command]
pub fn vault_get_backup_settings(state: tauri::State<'_, AuthState>) -> Result<BackupSettings, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    Ok(load_vault_verified(key)?.metadata.backup)
}

#[tauri::command]
pub fn vault_set_backup_settings(settings: BackupSettings, state: tauri::State<'_, AuthState>) -> Result<(), String> {
    let mut settings = settings;
    if settings.interval_hours == 0 || settings.interval_hours > backup::MAX_INTERVAL_HOURS {
        return Err(tr!("Interwał kopii musi wynosić od 1 do {} godzin", "The backup interval must be between 1 and {} hours", backup::MAX_INTERVAL_HOURS));
    }
    if settings.keep == 0 || settings.keep > backup::MAX_KEEP {
        return Err(tr!("Liczba przechowywanych kopii musi wynosić od 1 do {}", "The number of kept backups must be between 1 and {}", backup::MAX_KEEP));
    }
    settings.dir = settings.dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if let Some(dir) = &settings.dir {
        let path = std::path::Path::new(dir);
        if !path.is_absolute() {
            return Err(tr!("Katalog kopii zapasowych musi być ścieżką bezwzględną", "The backup folder must be an absolute path").to_string());
        }
    }

    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    if let Some(dir) = &settings.dir {
        // Only once the vault is unlocked; owner-only like the default backup folder
        crate::vault::storage::create_private_dir(std::path::Path::new(dir))
            .map_err(|e| tr!("Nie można utworzyć katalogu kopii: {}", "Cannot create the backup folder: {}", e))?;
    }
    update_vault(key, |v| {
        v.metadata.backup = settings;
        Ok(())
    })
}

#[tauri::command]
pub fn vault_backup_now(state: tauri::State<'_, AuthState>) -> Result<String, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let settings = load_vault_verified(key)?.metadata.backup;
    let path = backup::create_backup(&settings, "manual", false)?
        .ok_or_else(|| tr!("Brak pliku sejfu do skopiowania", "No vault file to back up").to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn vault_list_backups(state: tauri::State<'_, AuthState>) -> Result<Vec<BackupEntry>, String> {
    let mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let settings = load_vault_verified(key)?.metadata.backup;
    Ok(backup::list_backups(&settings))
}

/// Restores a backup and locks the application – the restored vault must be unlocked with the
/// Master Password that was valid when the backup was taken.
#[tauri::command]
pub fn vault_restore_backup(name: String, state: tauri::State<'_, AuthState>) -> Result<VaultStatus, String> {
    let mut mgr = lock_auth(&state)?;
    let key = mgr.unlocked_key()?;
    let settings = load_vault_verified(key)?.metadata.backup;
    backup::restore_backup(&settings, &name)?;
    crate::vault::known_hosts::forget_verified();
    mgr.clear();
    let vault = load_vault()?;
    Ok(build_status(vault.as_ref(), &mgr, None))
}
