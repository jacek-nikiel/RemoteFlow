//! PuTTY private keys (.ppk, format 2 and 3) converted to the OpenSSH format in memory, so a
//! key made with PuTTYgen works without exporting it by hand. Ed25519, ECDSA (P-256/384/521)
//! and RSA keys; encrypted keys (AES-256-CBC; key from SHA-1 in format 2, Argon2 in format 3).
//! The MAC is always checked – a wrong passphrase or a damaged file is reported, never used.

use hmac::{Hmac, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

#[derive(Debug, PartialEq, Eq)]
pub enum PpkError {
    /// The key is encrypted and no passphrase was given.
    NeedsPassphrase,
    /// Wrong passphrase (or a damaged file – the MAC does not match).
    WrongPassphrase,
    Unsupported(String),
    Invalid(String),
}

impl PpkError {
    pub fn message(&self) -> String {
        match self {
            PpkError::NeedsPassphrase => tr!(
                "Klucz PuTTY (.ppk) jest zaszyfrowany – podaj hasło klucza.",
                "The PuTTY key (.ppk) is encrypted – enter the key passphrase."
            )
            .to_string(),
            PpkError::WrongPassphrase => tr!(
                "Nieprawidłowe hasło klucza PuTTY (.ppk) albo uszkodzony plik.",
                "Wrong PuTTY key (.ppk) passphrase or a damaged file."
            )
            .to_string(),
            PpkError::Unsupported(what) => tr!("Nieobsługiwany klucz PuTTY: {}", "Unsupported PuTTY key: {}", what),
            PpkError::Invalid(what) => tr!("Nieprawidłowy plik klucza PuTTY: {}", "Invalid PuTTY key file: {}", what),
        }
    }
}

pub fn is_ppk(text: &str) -> bool {
    text.trim_start().starts_with("PuTTY-User-Key-File-")
}

/// Encrypted PPK (asks for a passphrase).
pub fn is_encrypted(text: &str) -> bool {
    text.lines().any(|l| l.trim().strip_prefix("Encryption:").is_some_and(|v| v.trim() != "none"))
}

struct Ppk {
    version: u8,
    algorithm: String,
    encryption: String,
    comment: String,
    public: Vec<u8>,
    private: Vec<u8>,
    mac: Vec<u8>,
    argon: Option<(argon2::Algorithm, u32, u32, u32, Vec<u8>)>,
}

impl Drop for Ppk {
    fn drop(&mut self) {
        self.private.zeroize();
    }
}

fn hex_decode(s: String) -> Result<Vec<u8>, ()> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(());
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2).ok_or(())?, 16).map_err(|_| ())).collect()
}

fn invalid(what: &str) -> PpkError {
    PpkError::Invalid(what.to_string())
}

fn parse(text: &str) -> Result<Ppk, PpkError> {
    use base64::Engine;
    let mut lines = text.lines().map(str::trim_end);
    fn header<'a>(lines: &mut impl Iterator<Item = &'a str>) -> Result<(String, String), PpkError> {
        let line = lines.next().ok_or_else(|| invalid("truncated"))?;
        let (k, v) = line.split_once(':').ok_or_else(|| invalid(line))?;
        Ok((k.trim().to_string(), v.trim().to_string()))
    }
    let (first, algorithm) = header(&mut lines)?;
    let version = match first.as_str() {
        "PuTTY-User-Key-File-2" => 2,
        "PuTTY-User-Key-File-3" => 3,
        other if other.starts_with("PuTTY-User-Key-File-") => return Err(PpkError::Unsupported(other.to_string())),
        _ => return Err(invalid("header")),
    };
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut public = None;
    let mut private = None;
    loop {
        let (k, v) = match header(&mut lines) {
            Ok(kv) => kv,
            Err(_) => break,
        };
        if k == "Public-Lines" || k == "Private-Lines" {
            let n: usize = v.parse().map_err(|_| invalid(&k))?;
            if n > 1000 {
                return Err(invalid(&k));
            }
            let mut b64 = String::new();
            for _ in 0..n {
                b64.push_str(lines.next().ok_or_else(|| invalid("truncated"))?.trim());
            }
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()).map_err(|_| invalid(&k))?;
            if k == "Public-Lines" {
                public = Some(bytes);
            } else {
                private = Some(bytes);
            }
        } else {
            fields.push((k, v));
        }
    }
    let get = |name: &str| fields.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    let encryption = get("Encryption").ok_or_else(|| invalid("Encryption"))?;
    let mac = hex_decode(get("Private-MAC").ok_or_else(|| invalid("Private-MAC"))?).map_err(|_| invalid("Private-MAC"))?;
    let argon = if version == 3 && encryption != "none" {
        let alg = match get("Key-Derivation").as_deref() {
            Some("Argon2id") => argon2::Algorithm::Argon2id,
            Some("Argon2i") => argon2::Algorithm::Argon2i,
            Some("Argon2d") => argon2::Algorithm::Argon2d,
            other => return Err(PpkError::Unsupported(other.unwrap_or("Key-Derivation").to_string())),
        };
        let num = |name: &str| -> Result<u32, PpkError> { get(name).and_then(|v| v.parse().ok()).ok_or_else(|| invalid(name)) };
        let salt = hex_decode(get("Argon2-Salt").ok_or_else(|| invalid("Argon2-Salt"))?).map_err(|_| invalid("Argon2-Salt"))?;
        let (memory, passes, parallelism) = (num("Argon2-Memory")?, num("Argon2-Passes")?, num("Argon2-Parallelism")?);
        // Limits against a file that would take minutes or gigabytes to open (PuTTY uses 8 MiB)
        if memory > 1024 * 1024 || passes > 1000 || parallelism > 64 {
            return Err(invalid("Argon2 parameters"));
        }
        Some((alg, memory, passes, parallelism, salt))
    } else {
        None
    };
    Ok(Ppk {
        version,
        algorithm,
        encryption,
        comment: get("Comment").unwrap_or_default(),
        public: public.ok_or_else(|| invalid("Public-Lines"))?,
        private: private.ok_or_else(|| invalid("Private-Lines"))?,
        mac,
        argon,
    })
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Reads SSH strings / mpints from a blob.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn string(&mut self) -> Result<&'a [u8], PpkError> {
        if self.0.len() < 4 {
            return Err(invalid("key data"));
        }
        let len = u32::from_be_bytes([self.0[0], self.0[1], self.0[2], self.0[3]]) as usize;
        if self.0.len() < 4 + len {
            return Err(invalid("key data"));
        }
        let (s, rest) = self.0[4..].split_at(len);
        self.0 = rest;
        Ok(s)
    }
}

/// Decrypts (when needed) and checks the private blob; returns it without the padding check.
fn private_blob(ppk: &Ppk, passphrase: Option<&str>) -> Result<Zeroizing<Vec<u8>>, PpkError> {
    let mut blob = Zeroizing::new(ppk.private.clone());
    let encrypted = match ppk.encryption.as_str() {
        "none" => false,
        "aes256-cbc" => true,
        other => return Err(PpkError::Unsupported(other.to_string())),
    };
    let pass = if encrypted {
        Zeroizing::new(passphrase.filter(|p| !p.is_empty()).ok_or(PpkError::NeedsPassphrase)?.as_bytes().to_vec())
    } else {
        Zeroizing::new(Vec::new())
    };

    let mut mac_key = Zeroizing::new(Vec::new());
    if encrypted {
        let (key, iv) = if ppk.version == 3 {
            let (alg, memory, passes, parallelism, salt) = ppk.argon.as_ref().ok_or_else(|| invalid("Key-Derivation"))?;
            let params = argon2::Params::new(*memory, *passes, *parallelism, Some(80)).map_err(|_| invalid("Argon2 parameters"))?;
            let mut out = Zeroizing::new([0u8; 80]);
            argon2::Argon2::new(*alg, argon2::Version::V0x13, params)
                .hash_password_into(&pass, salt, out.as_mut())
                .map_err(|_| invalid("Argon2"))?;
            mac_key.extend_from_slice(&out[48..80]);
            (out[..32].to_vec(), out[32..48].to_vec())
        } else {
            let mut key = Vec::with_capacity(40);
            for seq in [0u32, 1] {
                let mut h = Sha1::new();
                h.update(seq.to_be_bytes());
                h.update(&*pass);
                key.extend_from_slice(&h.finalize());
            }
            key.truncate(32);
            (key, vec![0u8; 16])
        };
        let key = Zeroizing::new(key);
        if blob.len() % 16 != 0 {
            return Err(invalid("Private-Lines"));
        }
        use cbc::cipher::{BlockDecryptMut, KeyIvInit};
        cbc::Decryptor::<aes::Aes256>::new_from_slices(&key, &iv)
            .map_err(|_| invalid("key"))?
            .decrypt_padded_mut::<cbc::cipher::block_padding::NoPadding>(&mut blob)
            .map_err(|_| PpkError::WrongPassphrase)?;
    }

    let mut data = Vec::new();
    put_string(&mut data, ppk.algorithm.as_bytes());
    put_string(&mut data, ppk.encryption.as_bytes());
    put_string(&mut data, ppk.comment.as_bytes());
    put_string(&mut data, &ppk.public);
    put_string(&mut data, &blob);
    let ok = if ppk.version == 3 {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&mac_key).map_err(|_| invalid("MAC"))?;
        mac.update(&data);
        mac.verify_slice(&ppk.mac).is_ok()
    } else {
        let mut h = Sha1::new();
        h.update(b"putty-private-key-file-mac-key");
        h.update(&*pass);
        let key = Zeroizing::new(h.finalize().to_vec());
        let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(&key).map_err(|_| invalid("MAC"))?;
        mac.update(&data);
        mac.verify_slice(&ppk.mac).is_ok()
    };
    data.zeroize();
    if !ok {
        return Err(if encrypted { PpkError::WrongPassphrase } else { invalid("MAC") });
    }
    Ok(blob)
}

/// The key as an OpenSSH private key, unencrypted (`export_passphrase` None) or encrypted again.
pub fn to_openssh(text: &str, passphrase: Option<&str>, export_passphrase: Option<&str>) -> Result<Zeroizing<String>, PpkError> {
    let ppk = parse(text)?;
    let private = private_blob(&ppk, passphrase)?;
    let mut public = Reader(&ppk.public);
    let mut secret = Reader(&private);
    let kind = public.string()?;
    if kind != ppk.algorithm.as_bytes() {
        return Err(invalid("algorithm"));
    }

    // OpenSSH keypair: string type, public parts, private parts
    let mut keypair = Zeroizing::new(Vec::new());
    put_string(&mut keypair, kind);
    match ppk.algorithm.as_str() {
        "ssh-ed25519" => {
            let pk = public.string()?;
            let sk = secret.string()?;
            if pk.len() != 32 || sk.len() != 32 {
                return Err(invalid("ed25519"));
            }
            put_string(&mut keypair, pk);
            let mut both = Zeroizing::new(sk.to_vec());
            both.extend_from_slice(pk);
            put_string(&mut keypair, &both);
        }
        "ssh-rsa" => {
            let e = public.string()?;
            let n = public.string()?;
            let (d, p, q, iqmp) = (secret.string()?, secret.string()?, secret.string()?, secret.string()?);
            for part in [n, e, d, iqmp, p, q] {
                put_string(&mut keypair, part);
            }
        }
        alg if alg.starts_with("ecdsa-sha2-nistp") => {
            let curve = public.string()?;
            let point = public.string()?;
            let scalar = secret.string()?;
            put_string(&mut keypair, curve);
            put_string(&mut keypair, point);
            put_string(&mut keypair, scalar);
        }
        other => return Err(PpkError::Unsupported(other.to_string())),
    }

    // openssh-key-v1, not encrypted
    let mut section = Zeroizing::new(Vec::new());
    let check: u32 = rand::random();
    section.extend_from_slice(&check.to_be_bytes());
    section.extend_from_slice(&check.to_be_bytes());
    section.extend_from_slice(&keypair);
    put_string(&mut section, ppk.comment.as_bytes());
    let mut pad = 1u8;
    while section.len() % 8 != 0 {
        section.push(pad);
        pad += 1;
    }
    let mut bin = Zeroizing::new(b"openssh-key-v1\0".to_vec());
    put_string(&mut bin, b"none");
    put_string(&mut bin, b"none");
    put_string(&mut bin, b"");
    bin.extend_from_slice(&1u32.to_be_bytes());
    put_string(&mut bin, &ppk.public);
    put_string(&mut bin, &section);

    let mut key = ssh_key::PrivateKey::from_bytes(&bin).map_err(|e| invalid(&e.to_string()))?;
    // The public half rebuilt from the private data must be the file's public key
    if key.public_key().to_bytes().map_err(|e| invalid(&e.to_string()))? != ppk.public {
        return Err(invalid("public key"));
    }
    if let Some(pass) = export_passphrase.filter(|p| !p.is_empty()) {
        key = key.encrypt(&mut rand::rngs::OsRng, pass).map_err(|e| invalid(&e.to_string()))?;
    }
    key.to_openssh(ssh_key::LineEnding::LF).map_err(|e| invalid(&e.to_string()))
}

/// Test keys are generated at run time with `puttygen` (PuTTY tools) into a temporary folder,
/// so no private key is kept in the repository. Without `puttygen` the tests are skipped.
#[cfg(test)]
pub(crate) mod test_keys {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    pub const PASS: &str = "Test-Pass-1";
    /// (name, puttygen -t, -b, PPK version, encrypted)
    const KEYS: [(&str, &str, Option<&str>, u8, bool); 8] = [
        ("ed25519-v3", "ed25519", None, 3, false),
        ("ed25519-v2", "ed25519", None, 2, false),
        ("rsa-v3", "rsa", Some("2048"), 3, false),
        ("ecdsa-v3", "ecdsa", Some("256"), 3, false),
        ("ed25519-v3-enc", "ed25519", None, 3, true),
        ("rsa-v3-enc", "rsa", Some("2048"), 3, true),
        ("rsa-v2-enc", "rsa", Some("2048"), 2, true),
        ("ecdsa-v3-enc", "ecdsa", Some("256"), 3, true),
    ];

    pub struct Keys {
        pub dir: PathBuf,
    }

    impl Keys {
        pub fn ppk(&self, name: &str) -> String {
            std::fs::read_to_string(self.dir.join(format!("{name}.ppk"))).unwrap()
        }
        pub fn public(&self, name: &str) -> String {
            std::fs::read_to_string(self.dir.join(format!("{name}.pub"))).unwrap()
        }
    }

    impl Drop for Keys {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn run(cmd: &mut Command) {
        let out = cmd.output().expect("puttygen");
        assert!(out.status.success(), "puttygen: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// All variants (v2/v3, RSA/Ed25519/ECDSA, plain/encrypted); None when puttygen is missing.
    pub fn generate(tag: &str) -> Option<Keys> {
        if Command::new("puttygen").arg("--version").output().is_err() {
            eprintln!("puttygen not found – PPK tests skipped");
            return None;
        }
        let dir = std::env::temp_dir().join(format!("rf-ppk-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let keys = Keys { dir: dir.clone() };
        let empty = dir.join("empty");
        let pass = dir.join("pass");
        std::fs::write(&empty, "").unwrap();
        std::fs::write(&pass, format!("{PASS}\n")).unwrap();
        for (name, kind, bits, version, enc) in KEYS {
            let ppk = dir.join(format!("{name}.ppk"));
            let pw: &Path = if enc { &pass } else { &empty };
            let mut c = Command::new("puttygen");
            c.args(["-q", "-t", kind]);
            if let Some(b) = bits {
                c.args(["-b", b]);
            }
            c.arg("-o").arg(&ppk).arg("--new-passphrase").arg(pw).args(["--ppk-param", &format!("version={version}")]);
            run(&mut c);
            run(Command::new("puttygen").arg(&ppk).arg("--old-passphrase").arg(pw).args(["-O", "public-openssh", "-o"]).arg(dir.join(format!("{name}.pub"))));
        }
        Some(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::test_keys::{generate, PASS};
    use super::*;

    /// "ssh-ed25519 AAAA… comment" – type and key only
    fn public_line(text: &str) -> String {
        text.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn converts_all_variants() {
        let Some(keys) = generate("all") else { return };
        for name in ["ed25519-v3", "ed25519-v2", "rsa-v3", "ecdsa-v3", "ed25519-v3-enc", "rsa-v3-enc", "rsa-v2-enc", "ecdsa-v3-enc"] {
            let ppk = keys.ppk(name);
            let pass = name.ends_with("-enc").then_some(PASS);
            assert_eq!(is_encrypted(&ppk), pass.is_some(), "{name}");
            let openssh = to_openssh(&ppk, pass, None).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            let key = ssh_key::PrivateKey::from_openssh(openssh.as_str()).unwrap();
            assert!(!key.is_encrypted());
            assert_eq!(public_line(&key.public_key().to_openssh().unwrap()), public_line(&keys.public(name)), "{name}");
        }
    }

    #[test]
    fn passphrase_errors_and_reencryption() {
        let Some(keys) = generate("pass") else { return };
        let ppk = keys.ppk("ed25519-v3-enc");
        assert_eq!(to_openssh(&ppk, None, None).unwrap_err(), PpkError::NeedsPassphrase);
        assert_eq!(to_openssh(&ppk, Some("wrong"), None).unwrap_err(), PpkError::WrongPassphrase);
        assert_eq!(to_openssh(&keys.ppk("rsa-v2-enc"), Some("wrong"), None).unwrap_err(), PpkError::WrongPassphrase);
        let enc = to_openssh(&ppk, Some(PASS), Some("new-pass")).unwrap();
        let key = ssh_key::PrivateKey::from_openssh(enc.as_str()).unwrap();
        assert!(key.is_encrypted());
        assert!(key.decrypt("new-pass").is_ok());
    }

    #[test]
    fn damaged_file_is_refused() {
        assert!(!is_ppk("-----BEGIN OPENSSH PRIVATE KEY-----"));
        let Some(keys) = generate("damaged") else { return };
        let ppk = keys.ppk("ed25519-v3");
        let mac_line = ppk.lines().find(|l| l.starts_with("Private-MAC:")).unwrap();
        let damaged = ppk.replace(mac_line, "Private-MAC: 00");
        assert!(matches!(to_openssh(&damaged, None, None), Err(PpkError::Invalid(_))));
        assert!(is_ppk(&ppk));
    }
}

/// Logs in to a local test server with freshly generated PuTTY keys. sshd on 127.0.0.1:2222,
/// user rftest; RF_TEST_AUTHORIZED_KEYS = that user's authorized_keys file (writable, the keys are
/// appended for the test and removed afterwards): `cargo test --lib ppk_login -- --ignored`.
#[cfg(test)]
mod login_tests {
    #[test]
    #[ignore]
    fn ppk_login() {
        use crate::session::ssh::{HostKeyVerifier, SshConnectionConfig};
        use crate::vault::known_hosts::HostTrust;
        let auth = std::env::var("RF_TEST_AUTHORIZED_KEYS").expect("RF_TEST_AUTHORIZED_KEYS");
        let keys = super::test_keys::generate("login").expect("puttygen");
        let original = std::fs::read_to_string(&auth).unwrap_or_default();
        let cases = [("ed25519-v3-enc", Some(super::test_keys::PASS)), ("rsa-v2-enc", Some(super::test_keys::PASS)), ("ecdsa-v3", None)];
        let mut added = original.clone();
        for (name, _) in cases {
            added.push_str(keys.public(name).trim());
            added.push('\n');
        }
        std::fs::write(&auth, added).unwrap();
        let result = std::panic::catch_unwind(|| {
            for (name, pass) in cases {
                let cfg = SshConnectionConfig {
                    auth_type: "key".into(), certificate: None, host: "127.0.0.1".into(), port: 2222, username: "rftest".into(),
                    password: None, private_key: Some(keys.ppk(name)), passphrase: pass.map(String::from),
                    host_key_verifier: HostKeyVerifier(std::sync::Arc::new(|_| Ok(HostTrust::Known))), jump: None,
                };
                let sess = crate::session::ssh::ssh_connect_raw(&cfg).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(sess.authenticated(), "{name}");
            }
        });
        std::fs::write(&auth, original).unwrap();
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }
}
