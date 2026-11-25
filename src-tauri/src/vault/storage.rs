use crate::vault::cipher::{compute_mac, verify_mac, encrypt_string, decrypt_string_z, CANARY_PHRASE_V3, encrypt_bytes};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use zeroize::Zeroizing;
use crate::vault::models::VaultData;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Error code prefix the UI recognises when the vault file was modified outside the application.
pub const INTEGRITY_ERROR_CODE: &str = "VAULT_INTEGRITY_FAILED";

/// Serialises every read-modify-write cycle on vault.json (UI commands and session threads).
static VAULT_IO: Mutex<()> = Mutex::new(());
static VAULT_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn lock_io() -> MutexGuard<'static, ()> {
    VAULT_IO.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".remoteflow_write_probe_{}", std::process::id()));
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Marker file that turns a copy of the program into a portable one (vault next to the program).
pub const PORTABLE_MARKER: &str = "remoteflow.portable";

/// Folder of the program as the user sees it: for an AppImage the folder of the .AppImage file
/// (the executable itself runs from a read-only mount), otherwise the folder of the executable.
pub(crate) fn program_dir() -> Option<PathBuf> {
    if let Some(appimage) = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()) {
        if let Some(dir) = Path::new(&appimage).parent() {
            return Some(dir.to_path_buf());
        }
    }
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

#[cfg_attr(test, allow(dead_code))]
fn resolve_vault_path() -> PathBuf {
    let config_dir = dirs::config_dir().map(|d| d.join("remoteflow"));
    choose_vault_path(program_dir().as_deref(), config_dir.as_deref(), std::env::current_dir().ok().as_deref())
}

/// Where the vault is:
/// 1. next to the program, if a vault is already there (portable copy, also older versions that
///    created the vault there whenever the folder was writable),
/// 2. the per-user configuration folder (%APPDATA%\remoteflow, ~/.config/remoteflow),
/// 3. the working folder (very early versions) – last, so a vault.json in whatever folder the
///    program is started from can never take the place of the user's own vault.
/// A NEW vault goes to the configuration folder; next to the program only for a portable copy,
/// i.e. when the folder contains the `remoteflow.portable` marker file (and is writable). Installed
/// copies therefore never keep data in the installation folder.
fn choose_vault_path(program_dir: Option<&Path>, config_dir: Option<&Path>, cwd: Option<&Path>) -> PathBuf {
    if let Some(p) = program_dir.map(|d| d.join("vault.json")).filter(|p| p.exists()) {
        return p;
    }
    if let Some(p) = config_dir.map(|d| d.join("vault.json")).filter(|p| p.exists()) {
        return p;
    }
    if let Some(p) = cwd.map(|d| d.join("vault.json")).filter(|p| p.exists()) {
        eprintln!("[RemoteFlow] Używam sejfu z katalogu roboczego: {:?}", p);
        return p;
    }
    if let Some(dir) = program_dir.filter(|d| d.join(PORTABLE_MARKER).is_file() && dir_is_writable(d)) {
        return dir.join("vault.json");
    }
    config_dir
        .map(|d| d.join("vault.json"))
        .or_else(|| program_dir.map(|d| d.join("vault.json")))
        .unwrap_or_else(|| PathBuf::from("vault.json"))
}

/// The vault location is resolved once per process so it cannot change while the app runs.
/// Tests never touch the user's vault: they get their own folder in the system temp directory
/// (the normal lookup would find e.g. ~/.config/remoteflow/vault.json, and the tests delete the
/// vault and its backups).
#[cfg(test)]
fn vault_path_for_this_build() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("remoteflow-test-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    dir.join("vault.json")
}

#[cfg(not(test))]
fn vault_path_for_this_build() -> PathBuf {
    resolve_vault_path()
}

pub fn get_vault_path() -> PathBuf {
    VAULT_PATH
        .get_or_init(|| {
            let path = vault_path_for_this_build();
            // Vaults written by older versions may be world-readable (0644) – tighten them once
            restrict_file(&path);
            path
        })
        .clone()
}

/// Canonical bytes covered by the integrity MAC: the whole vault with the `mac` field cleared.
fn mac_payload(data: &VaultData) -> Result<Vec<u8>, String> {
    let mut copy = data.clone();
    copy.mac = None;
    serde_json::to_vec(&copy).map_err(|e| tr!("Błąd serializacji sejfu: {}", "Vault serialisation error: {}", e))
}

pub fn verify_vault_mac(data: &VaultData, key: &[u8; 32]) -> bool {
    match (&data.mac, mac_payload(data)) {
        (Some(mac), Ok(payload)) => verify_mac(key, &payload, mac),
        _ => false,
    }
}

fn sign_vault(data: &mut VaultData, key: &[u8; 32]) -> Result<(), String> {
    data.mac = None;
    let payload = mac_payload(data)?;
    data.mac = Some(compute_mac(key, &payload)?);
    Ok(())
}

/// Unix: limits a vault-related file to its owner (0600). Other local users must not be able to
/// copy vault.json (host list, user names, KDF salt) for an offline attack on the Master Password.
/// Windows: files live in the per-user profile (%APPDATA%) whose ACL already excludes other users.
pub(crate) fn restrict_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            if meta.is_file() && meta.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Creates a directory (and parents); a directory created here is made owner-only (0700) on Unix.
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let existed = dir.exists();
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    if !existed {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = existed;
    Ok(())
}

fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let f = opts.open(path)?;
    // A leftover temp file keeps its old mode on truncate – enforce 0600 explicitly
    restrict_file(path);
    Ok(f)
}

/// Writes the file atomically: temp file + fsync + rename, so a crash never leaves a half-written vault.
/// The file is created with owner-only permissions (0600 on Unix).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = create_private_dir(parent);
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = create_private_file(&tmp).map_err(|e| tr!("Błąd zapisu do pliku {:?}: {}", "Error writing file {:?}: {}", tmp, e))?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|e| tr!("Błąd zapisu do pliku {:?}: {}", "Error writing file {:?}: {}", tmp, e))?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        tr!("Błąd zapisu do pliku {:?}: {}", "Error writing file {:?}: {}", path, e)
    })
}

/// Signs the vault with the master key and writes it atomically.
/// Callers doing read-modify-write must hold [`lock_io`] (or use [`update_vault`]).
pub fn save_vault_signed(data: &mut VaultData, key: &[u8; 32]) -> Result<(), String> {
    data.encrypted_data = None;
    if data.metadata.version < 3 {
        // First write of a pre-v3 vault converts it: keep the old file restorable first (older
        // RemoteFlow versions cannot open v3). Callers hold the I/O lock.
        crate::vault::backup::backup_while_locked(&crate::vault::models::BackupSettings::default(), "pre-migration-v3", true)
            .map_err(|e| tr!(
                "Nie udało się utworzyć kopii sejfu przed zmianą formatu na v3 ({}). Zwolnij miejsce na dysku lub sprawdź uprawnienia folderu kopii.",
                "Could not back up the vault before converting it to format v3 ({}). Free disk space or check the permissions of the backup folder.",
                e
            ))?;
        let (ct, nonce) = encrypt_bytes(key, CANARY_PHRASE_V3.as_bytes())?;
        data.metadata.version = 3;
        data.metadata.canary_nonce_base64 = BASE64.encode(nonce);
        data.metadata.canary_ciphertext_base64 = BASE64.encode(ct);
    }
    sign_vault(data, key)?;
    // Encrypt connection names, hosts, usernames, notes, groups and trusted identities too.
    // Only bootstrap / lock / backup settings remain in the authenticated public header, so
    // the backup scheduler can still copy the encrypted file while the vault is locked.
    let plaintext = Zeroizing::new(serde_json::to_string(data).map_err(|e| e.to_string())?);
    let mut envelope = data.clone();
    envelope.groups.clear();
    envelope.connections.clear();
    envelope.credentials.clear();
    envelope.metadata.known_hosts.clear();
    envelope.metadata.global_download_dir = None;
    envelope.metadata.pin_encrypted_base64 = None;
    envelope.encrypted_data = Some(encrypt_string(key, &plaintext)?);
    sign_vault(&mut envelope, key)?;
    let json = serde_json::to_string_pretty(&envelope).map_err(|e| tr!("Błąd serializacji sejfu: {}", "Vault serialisation error: {}", e))?;
    write_atomic(&get_vault_path(), json.as_bytes())
}

/// Reads the vault WITHOUT integrity verification. Use only before unlock (status screen,
/// salt/canary lookup) or for non-security-relevant data.
pub fn load_vault() -> Result<Option<VaultData>, String> {
    let path = get_vault_path();
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&path).map_err(|e| tr!("Błąd odczytu pliku {:?}: {}", "Error reading file {:?}: {}", path, e))?;
    let data: VaultData =
        serde_json::from_str(&content).map_err(|e| tr!("Błąd parsowania pliku sejfu: {}", "Vault file parse error: {}", e))?;
    Ok(Some(data))
}

pub fn integrity_error() -> String {
    format!(
        "{}: Plik sejfu został zmodyfikowany poza aplikacją (niezgodna suma kontrolna HMAC). \
         Ze względów bezpieczeństwa dane nie zostały użyte.",
        INTEGRITY_ERROR_CODE
    )
}

/// Reads the vault and verifies its integrity MAC with the master key.
pub fn load_vault_verified(key: &[u8; 32]) -> Result<VaultData, String> {
    let data = load_vault()?.ok_or(tr!("Sejf nie istnieje", "The vault does not exist"))?;
    let data = open_vault_envelope(data, key)?;
    if !verify_vault_mac(&data, key) {
        return Err(integrity_error());
    }
    Ok(data)
}

/// Opens only authenticated v3 envelopes; legacy plaintext vaults are verified by their caller.
/// Damaged encrypted data cannot be accepted with the legacy "accept modified" recovery option.
pub fn open_vault_envelope(data: VaultData, key: &[u8; 32]) -> Result<VaultData, String> {
    match data.encrypted_data.as_deref() {
        Some(ciphertext) => {
            if !verify_vault_mac(&data, key) { return Err(integrity_error()); }
            let plaintext = decrypt_string_z(key, ciphertext).map_err(|_| integrity_error())?;
            let opened: VaultData = serde_json::from_str(&plaintext).map_err(|_| integrity_error())?;
            if opened.encrypted_data.is_some() || opened.metadata.version != 3 || !verify_vault_mac(&opened, key) {
                return Err(integrity_error());
            }
            Ok(opened)
        }
        None if data.metadata.version >= 3 => Err(integrity_error()),
        None => Ok(data),
    }
}

/// Verified read-modify-write of the vault under the global I/O lock.
pub fn update_vault<T>(
    key: &[u8; 32],
    f: impl FnOnce(&mut VaultData) -> Result<T, String>,
) -> Result<T, String> {
    let _guard = lock_io();
    let mut data = load_vault_verified(key)?;
    let result = f(&mut data)?;
    save_vault_signed(&mut data, key)?;
    Ok(result)
}

pub fn vault_exists() -> bool {
    get_vault_path().exists()
}

pub fn delete_vault() -> Result<(), String> {
    let _guard = lock_io();
    let path = get_vault_path();
    if path.exists() {
        let backup_path = reset_backup_path(&path);
        fs::rename(&path, &backup_path).map_err(|e| tr!("Nie udało się utworzyć kopii sejfu: {}", "Could not back up the vault: {}", e))?;
    }
    Ok(())
}

/// `vault.json.bak_<milliseconds>` that does not exist yet: `rename` replaces an existing file on
/// Unix, so two resets close together must never reuse a name (the first copy would be lost).
fn reset_backup_path(path: &Path) -> PathBuf {
    let stamp = chrono::Utc::now().timestamp_millis();
    let mut candidate = path.with_extension(format!("json.bak_{stamp}"));
    let mut n = 1;
    while candidate.exists() {
        candidate = path.with_extension(format!("json.bak_{stamp}_{n}"));
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn reset_backup_names_never_collide() {
        let dir = std::env::temp_dir().join(format!("rf-reset-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let vault = dir.join("vault.json");
        let mut names = std::collections::HashSet::new();
        for i in 0..5 {
            fs::write(&vault, format!("vault {i}")).unwrap();
            let target = reset_backup_path(&vault);
            assert!(!target.exists());
            fs::rename(&vault, &target).unwrap();
            assert!(names.insert(target));
        }
        // Every reset kept its own copy
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 5);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tests_use_a_private_vault_path() {
        let p = get_vault_path();
        assert!(p.starts_with(std::env::temp_dir()), "{:?}", p);
        assert!(p.to_string_lossy().contains("remoteflow-test-"));
        if let Some(cfg) = dirs::config_dir() {
            assert!(!p.starts_with(cfg));
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn vault_files_are_owner_only() {
        let dir = std::env::temp_dir().join(format!("rf-perm-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let file = dir.join("sub").join("vault.json");
        // Simulate a leftover world-readable temp file
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(file.with_extension("json.tmp"), b"old").unwrap();
        fs::set_permissions(file.with_extension("json.tmp"), fs::Permissions::from_mode(0o644)).unwrap();

        write_atomic(&file, b"{}").unwrap();
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);

        // An existing 0644 file is tightened
        let other = dir.join("old.json");
        fs::write(&other, b"x").unwrap();
        fs::set_permissions(&other, fs::Permissions::from_mode(0o644)).unwrap();
        restrict_file(&other);
        assert_eq!(fs::metadata(&other).unwrap().permissions().mode() & 0o777, 0o600);

        // A directory created by us is 0700
        let new_dir = dir.join("backups");
        create_private_dir(&new_dir).unwrap();
        assert_eq!(fs::metadata(&new_dir).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_location_rules() {
        let base = std::env::temp_dir().join(format!("rf-vault-loc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (prog, conf, cwd) = (base.join("prog"), base.join("conf"), base.join("cwd"));
        for d in [&prog, &conf, &cwd] {
            fs::create_dir_all(d).unwrap();
        }
        let choose = || choose_vault_path(Some(&prog), Some(&conf), Some(&cwd));
        // New vault: configuration folder, even though the program folder is writable
        assert_eq!(choose(), conf.join("vault.json"));
        // A vault.json in the working folder does not win over the user's vault
        fs::write(cwd.join("vault.json"), "{}").unwrap();
        assert_eq!(choose(), cwd.join("vault.json"), "only when nothing else exists (very old versions)");
        fs::write(conf.join("vault.json"), "{}").unwrap();
        assert_eq!(choose(), conf.join("vault.json"));
        // Existing vault next to the program (portable copy / older versions) is kept
        fs::write(prog.join("vault.json"), "{}").unwrap();
        assert_eq!(choose(), prog.join("vault.json"));
        // Portable marker: a new vault next to the program
        let _ = fs::remove_file(prog.join("vault.json"));
        let _ = fs::remove_file(conf.join("vault.json"));
        let _ = fs::remove_file(cwd.join("vault.json"));
        fs::write(prog.join(PORTABLE_MARKER), "").unwrap();
        assert_eq!(choose(), prog.join("vault.json"));
        let _ = fs::remove_dir_all(&base);
    }
}
