use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::{STANDARD as BASE64, STANDARD_NO_PAD as BASE64_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// Canary used by vaults created before format v2 (no integrity MAC).
pub const CANARY_PHRASE_V1: &str = "REMOTELOCK_CANARY_V1";
/// Canary used by format v2. A vault whose canary decrypts to this value MUST carry a valid MAC,
/// so an attacker cannot silently downgrade a v2 vault to the legacy (unauthenticated) format.
pub const CANARY_PHRASE_V2: &str = "REMOTELOCK_CANARY_V2";
pub const CANARY_PHRASE_V3: &str = "REMOTELOCK_CANARY_V3";

/// Minimum length of a new Master Password / export password.
pub const MIN_MASTER_PASSWORD_LEN: usize = 8;

pub type SecretKey = Zeroizing<[u8; 32]>;

type HmacSha256 = Hmac<Sha256>;

pub fn generate_salt() -> [u8; 16] {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
}

fn argon2_derive(secret: &str, salt: &[u8], mem_kib: u32, iterations: u32) -> Result<SecretKey, String> {
    let params = Params::new(mem_kib, iterations, 2, Some(32))
        .map_err(|e| format!("Argon2 params error: {}", e))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(secret.as_bytes(), salt, key.as_mut())
        .map_err(|e| format!("Argon2 derivation error: {}", e))?;
    Ok(key)
}

/// Master key: Argon2id, 64 MiB, 3 iterations, 2 lanes.
pub fn derive_key(password: &str, salt: &[u8]) -> Result<SecretKey, String> {
    argon2_derive(password, salt, 64 * 1024, 3)
}

/// PIN key. The PIN-wrapped master key only ever lives in process memory (never on disk),
/// so the PIN cannot be brute-forced offline from vault.json.
pub fn derive_pin_key(pin: &str, salt: &[u8]) -> Result<SecretKey, String> {
    argon2_derive(pin, salt, 32 * 1024, 2)
}

pub fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; 12]), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("Cipher init error: {}", e))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("Encryption error: {}", e))?;

    Ok((ciphertext, nonce_bytes))
}

pub fn decrypt_bytes(key: &[u8; 32], ciphertext: &[u8], nonce_bytes: &[u8; 12]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("Cipher init error: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| tr!("Odszyfrowanie nie powiodło się (błędne hasło lub uszkodzone dane)", "Decryption failed (wrong password or corrupted data)").to_string())
}

/// Helper: encrypts string to base64 payload formatted as nonce (12B) + ciphertext
pub fn encrypt_string(key: &[u8; 32], text: &str) -> Result<String, String> {
    let (ciphertext, nonce) = encrypt_bytes(key, text.as_bytes())?;
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(combined))
}

/// Helper: decrypts base64 payload formatted as nonce (12B) + ciphertext to string
pub fn decrypt_string(key: &[u8; 32], payload_base64: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(payload_base64)
        .map_err(|e| tr!("Błąd dekodowania Base64: {}", "Base64 decoding error: {}", e))?;
    if bytes.len() < 12 + 16 {
        return Err(tr!("Nieprawidłowy format szyfrogramu", "Invalid ciphertext format").to_string());
    }

    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&bytes[0..12]);
    let ciphertext = &bytes[12..];

    // The plaintext buffer becomes the String itself (no extra copy left behind in memory)
    String::from_utf8(decrypt_bytes(key, ciphertext, &nonce)?).map_err(|e| {
        let msg = tr!("Odszyfrowana zawartość nie jest poprawnym ciągiem UTF-8: {}", "The decrypted content is not valid UTF-8: {}", e.utf8_error());
        let mut bytes = e.into_bytes();
        zeroize::Zeroize::zeroize(&mut bytes);
        msg
    })
}

/// Same as [`decrypt_string`], but the result is wiped from memory when dropped.
pub fn decrypt_string_z(key: &[u8; 32], payload_base64: &str) -> Result<Zeroizing<String>, String> {
    decrypt_string(key, payload_base64).map(Zeroizing::new)
}

/// Decrypts an optional encrypted field. `None`/empty -> `Ok(None)`.
pub fn decrypt_opt(key: &[u8; 32], field: &Option<String>) -> Result<Option<String>, String> {
    match field {
        Some(v) if !v.is_empty() => decrypt_string(key, v).map(Some),
        _ => Ok(None),
    }
}

/// Sub-key used for the vault integrity MAC (domain separated from the encryption key).
fn mac_subkey(key: &[u8; 32]) -> Result<SecretKey, String> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).map_err(|e| e.to_string())?;
    mac.update(b"remoteflow/vault-integrity-mac/v2");
    let out = mac.finalize().into_bytes();
    let mut sub = Zeroizing::new([0u8; 32]);
    sub.copy_from_slice(&out);
    Ok(sub)
}

/// HMAC-SHA256 over `data`, base64-encoded.
pub fn compute_mac(key: &[u8; 32], data: &[u8]) -> Result<String, String> {
    let sub = mac_subkey(key)?;
    let mut mac = <HmacSha256 as Mac>::new_from_slice(sub.as_ref()).map_err(|e| e.to_string())?;
    mac.update(data);
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

/// Constant-time MAC verification.
pub fn verify_mac(key: &[u8; 32], data: &[u8], mac_b64: &str) -> bool {
    let Ok(expected) = BASE64.decode(mac_b64) else {
        return false;
    };
    let Ok(sub) = mac_subkey(key) else {
        return false;
    };
    let Ok(mut mac) = <HmacSha256 as Mac>::new_from_slice(sub.as_ref()) else {
        return false;
    };
    mac.update(data);
    mac.verify_slice(&expected).is_ok()
}

/// OpenSSH-style fingerprint ("SHA256:<base64 without padding>") of a precomputed SHA-256 digest.
pub fn fingerprint_from_digest(digest: &[u8]) -> String {
    format!("SHA256:{}", BASE64_NO_PAD.encode(digest))
}

/// OpenSSH-style fingerprint of arbitrary bytes (e.g. DER certificate).
pub fn sha256_fingerprint(data: &[u8]) -> String {
    fingerprint_from_digest(&Sha256::digest(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_string() {
        let key = derive_key("correct horse battery", &generate_salt()).unwrap();
        let ct = encrypt_string(&key, "zażółć gęślą jaźń").unwrap();
        assert_eq!(decrypt_string(&key, &ct).unwrap(), "zażółć gęślą jaźń");
        let other = derive_key("wrong password!!", &generate_salt()).unwrap();
        assert!(decrypt_string(&other, &ct).is_err());
    }

    #[test]
    fn nonces_are_unique() {
        let key = Zeroizing::new([7u8; 32]);
        assert_ne!(encrypt_string(&key, "x").unwrap(), encrypt_string(&key, "x").unwrap());
    }

    #[test]
    fn mac_detects_tampering() {
        let key = Zeroizing::new([1u8; 32]);
        let mac = compute_mac(&key, b"hello").unwrap();
        assert!(verify_mac(&key, b"hello", &mac));
        assert!(!verify_mac(&key, b"hellO", &mac));
        assert!(!verify_mac(&Zeroizing::new([2u8; 32]), b"hello", &mac));
        assert!(!verify_mac(&key, b"hello", "not-base64!"));
    }

    #[test]
    fn short_ciphertext_rejected() {
        let key = Zeroizing::new([1u8; 32]);
        assert!(decrypt_string(&key, &BASE64.encode([0u8; 20])).is_err());
    }
}
