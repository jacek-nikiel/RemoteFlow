//! Public-key login with keys in the OpenSSH format ("-----BEGIN OPENSSH PRIVATE KEY-----"),
//! decrypted and used in Rust instead of libssh2.
//!
//! On Windows libssh2 is built with WinCNG (Windows CNG), which reads only RSA keys in the old
//! PEM format and has no Ed25519 or ECDSA. The OpenSSH format is the default of every current
//! `ssh-keygen` (Windows included), so such keys could not be used at all. Here the key is parsed
//! and decrypted (bcrypt-pbkdf + AES) in memory, then:
//! - RSA: handed to libssh2 as an unencrypted PKCS#1 key in memory (WinCNG supports that and
//!   signs with rsa-sha2-256/512); the copy is wiped right after,
//! - Ed25519 / ECDSA: libssh2 sends the public key and asks this module for the signature
//!   (`libssh2_userauth_publickey` with a signing callback).
//! Nothing is written to disk.

use ssh_key::{private::KeypairData, PrivateKey};
use std::ffi::{c_int, c_uchar, c_void};

pub const OPENSSH_HEADER: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";

pub fn is_openssh_key(text: &str) -> bool {
    text.trim_start().starts_with(OPENSSH_HEADER)
}

pub fn is_putty_key(text: &str) -> bool {
    text.trim_start().starts_with("PuTTY-User-Key-File-")
}

/// Explains a key the program cannot use (or None).
pub fn unsupported_format_message(text: &str) -> Option<String> {
    if is_putty_key(text) {
        return Some(
            tr!(
                "Klucz w formacie PuTTY (.ppk) nie jest obsługiwany. Wyeksportuj go w PuTTYgen: Conversions → Export OpenSSH key (new format) i wklej wynik.",
                "Keys in the PuTTY format (.ppk) are not supported. Export the key in PuTTYgen: Conversions → Export OpenSSH key (new format) and paste the result."
            )
            .to_string(),
        );
    }
    None
}

/// Parses and (if needed) decrypts an OpenSSH private key.
pub fn decode(text: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    // Keys copied on Windows may use CR+LF line endings
    let normalized = zeroize::Zeroizing::new(text.trim().replace("\r\n", "\n"));
    let key = PrivateKey::from_openssh(normalized.as_bytes())
        .map_err(|e| tr!("Nie można odczytać klucza prywatnego OpenSSH: {}", "Cannot read the OpenSSH private key: {}", e))?;
    if !key.is_encrypted() {
        return Ok(key);
    }
    let pass = passphrase.filter(|p| !p.is_empty()).ok_or_else(|| {
        tr!(
            "Klucz prywatny jest chroniony hasłem – podaj hasło klucza (passphrase) w definicji połączenia.",
            "The private key is protected with a passphrase – enter the key passphrase in the connection settings."
        )
        .to_string()
    })?;
    key.decrypt(pass.as_bytes()).map_err(|_| {
        tr!(
            "Nieprawidłowe hasło klucza prywatnego (passphrase).",
            "Wrong private key passphrase."
        )
        .to_string()
    })
}

unsafe extern "C" {
    // Not bound by libssh2-sys; part of the libssh2 API.
    fn libssh2_userauth_publickey(
        session: *mut libssh2_sys::LIBSSH2_SESSION,
        username: *const std::ffi::c_char,
        pubkeydata: *const c_uchar,
        pubkeydata_len: usize,
        sign_callback: Option<
            unsafe extern "C" fn(
                *mut libssh2_sys::LIBSSH2_SESSION,
                *mut *mut c_uchar,
                *mut usize,
                *const c_uchar,
                usize,
                *mut *mut c_void,
            ) -> c_int,
        >,
        abstract_: *mut *mut c_void,
    ) -> c_int;
    // libssh2 frees the signature with the C allocator (default session allocator).
    fn malloc(size: usize) -> *mut c_void;
}

unsafe extern "C" fn sign_callback(
    _session: *mut libssh2_sys::LIBSSH2_SESSION,
    sig: *mut *mut c_uchar,
    sig_len: *mut usize,
    data: *const c_uchar,
    data_len: usize,
    abstract_: *mut *mut c_void,
) -> c_int {
    // SAFETY: libssh2 passes the `abstract` pointer given to `libssh2_userauth_publickey` (a
    // live `&PrivateKey` for the duration of that call) and valid data/out pointers.
    unsafe {
        use signature::Signer;
        if abstract_.is_null() || (*abstract_).is_null() || data.is_null() {
            return -1;
        }
        let key = &*((*abstract_) as *const PrivateKey);
        let message = std::slice::from_raw_parts(data, data_len);
        let Ok(signature) = key.try_sign(message) else {
            return -1;
        };
        let bytes = signature.as_bytes();
        let buf = malloc(bytes.len().max(1)) as *mut c_uchar;
        if buf.is_null() {
            return -1;
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, bytes.len());
        *sig = buf;
        *sig_len = bytes.len();
        0
    }
}

/// Public key (or certificate) blob in the SSH wire format.
fn public_blob(key: &PrivateKey, certificate: Option<&str>) -> Result<Vec<u8>, String> {
    if let Some(cert) = certificate.map(str::trim).filter(|c| !c.is_empty()) {
        let cert = ssh_key::Certificate::from_openssh(cert)
            .map_err(|e| tr!("Nieprawidłowy certyfikat SSH: {}", "Invalid SSH certificate: {}", e))?;
        return cert.to_bytes().map_err(|e| e.to_string());
    }
    key.public_key().to_bytes().map_err(|e| e.to_string())
}

/// RSA key from its components. (ssh-key 0.6's own conversion passes `p` twice instead of
/// `p` and `q`, so the key always fails validation.)
fn rsa_private_key(key: &ssh_key::private::RsaKeypair) -> Result<rsa::RsaPrivateKey, String> {
    let int = |m: &ssh_key::Mpint| {
        m.as_positive_bytes()
            .map(rsa::BigUint::from_bytes_be)
            .ok_or_else(|| "invalid RSA number".to_string())
    };
    rsa::RsaPrivateKey::from_components(
        int(&key.public.n)?,
        int(&key.public.e)?,
        int(&key.private.d)?,
        vec![int(&key.private.p)?, int(&key.private.q)?],
    )
    .map_err(|e| e.to_string())
}

/// Logs in with an OpenSSH-format key. Ok(true) = authenticated, Ok(false) = the server refused
/// the key, Err = the key could not be used (message for the user).
pub fn authenticate(
    sess: &ssh2::Session,
    username: &str,
    key_text: &str,
    passphrase: Option<&str>,
    certificate: Option<&str>,
) -> Result<bool, String> {
    let key = decode(key_text, passphrase)?;
    match key.key_data() {
        KeypairData::Rsa(rsa_keypair) => {
            use rsa::pkcs1::EncodeRsaPrivateKey;
            let rsa_key = rsa_private_key(rsa_keypair)
                .map_err(|e| tr!("Nie można użyć klucza RSA: {}", "Cannot use the RSA key: {}", e))?;
            let pem = rsa_key
                .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
                .map_err(|e| tr!("Nie można użyć klucza RSA: {}", "Cannot use the RSA key: {}", e))?;
            Ok(crate::session::ssh::pubkey_from_memory(sess, username, certificate, pem.as_str(), None))
        }
        KeypairData::Ed25519(_) | KeypairData::Ecdsa(_) => {
            let blob = public_blob(&key, certificate)?;
            let user = std::ffi::CString::new(username).map_err(|e| e.to_string())?;
            let mut ctx = &key as *const PrivateKey as *mut c_void;
            let mut raw = sess.raw();
            let rc = unsafe {
                libssh2_userauth_publickey(&mut *raw, user.as_ptr(), blob.as_ptr(), blob.len(), Some(sign_callback), &mut ctx)
            };
            drop(raw);
            Ok(rc == 0 && sess.authenticated())
        }
        other => Err(tr!(
            "Typ klucza {} nie jest obsługiwany.",
            "The key type {} is not supported.",
            other.algorithm().map(|a| a.to_string()).unwrap_or_else(|_| "?".into())
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_reports_passphrase_errors() {
        let mut rng = ssh_key::rand_core::OsRng;
        let key = PrivateKey::random(&mut rng, ssh_key::Algorithm::Ed25519).unwrap();
        let enc = key.encrypt(&mut rng, "Klucz-123").unwrap();
        let text = enc.to_openssh(ssh_key::LineEnding::CRLF).unwrap();
        assert!(is_openssh_key(&text));
        let ok = decode(&text, Some("Klucz-123")).unwrap();
        assert_eq!(ok.public_key(), key.public_key());
        assert!(decode(&text, Some("zle")).unwrap_err().to_lowercase().contains("pass"));
        assert!(decode(&text, None).is_err());
        assert!(unsupported_format_message("PuTTY-User-Key-File-3: ssh-ed25519\n").is_some());
        assert!(unsupported_format_message(&text).is_none());
    }
}
