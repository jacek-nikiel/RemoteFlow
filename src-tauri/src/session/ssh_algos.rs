//! Diagnosis of "Unable to exchange encryption keys" (libssh2 KEX failure): the server and
//! RemoteFlow have no algorithm in common. libssh2 does not report what the server offered, so a
//! short separate connection reads the server's KEXINIT (sent unencrypted right after the
//! version banners) and the lists are compared with what this build of libssh2 supports.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Algorithm lists offered by the server (client→server direction for ciphers/MACs).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ServerAlgorithms {
    pub kex: Vec<String>,
    pub host_key: Vec<String>,
    pub cipher: Vec<String>,
    pub mac: Vec<String>,
}

const MSG_KEXINIT: u8 = 20;
const MAX_PACKET: usize = 64 * 1024;

fn read_name_list(buf: &[u8], pos: &mut usize) -> Option<Vec<String>> {
    let len = u32::from_be_bytes(buf.get(*pos..*pos + 4)?.try_into().ok()?) as usize;
    *pos += 4;
    let raw = buf.get(*pos..*pos + len)?;
    *pos += len;
    let text = std::str::from_utf8(raw).ok()?;
    Some(text.split(',').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Parses the payload of SSH_MSG_KEXINIT (RFC 4253, 7.1).
pub fn parse_kexinit(payload: &[u8]) -> Option<ServerAlgorithms> {
    if payload.first() != Some(&MSG_KEXINIT) || payload.len() < 17 {
        return None;
    }
    let mut pos = 17; // message code + 16-byte cookie
    let kex = read_name_list(payload, &mut pos)?;
    let host_key = read_name_list(payload, &mut pos)?;
    let cipher = read_name_list(payload, &mut pos)?;
    let _cipher_sc = read_name_list(payload, &mut pos)?;
    let mac = read_name_list(payload, &mut pos)?;
    Some(ServerAlgorithms { kex, host_key, cipher, mac })
}

/// Connects, exchanges version banners and reads the server's first packet (KEXINIT).
pub fn probe(addr: SocketAddr, timeout: Duration) -> Result<ServerAlgorithms, String> {
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    s.write_all(b"SSH-2.0-RemoteFlow_probe\r\n").map_err(|e| e.to_string())?;

    // Server version line (it may be preceded by other text lines, RFC 4253, 4.2)
    let mut line = Vec::new();
    let mut total = 0usize;
    loop {
        let mut b = [0u8; 1];
        s.read_exact(&mut b).map_err(|e| e.to_string())?;
        total += 1;
        if total > 16 * 1024 {
            return Err("no SSH banner".into());
        }
        if b[0] == b'\n' {
            let is_banner = line.starts_with(b"SSH-");
            line.clear();
            if is_banner {
                break;
            }
        } else {
            line.push(b[0]);
        }
    }

    let mut head = [0u8; 5];
    s.read_exact(&mut head).map_err(|e| e.to_string())?;
    let packet_len = u32::from_be_bytes([head[0], head[1], head[2], head[3]]) as usize;
    let padding = head[4] as usize;
    if packet_len < 1 + padding || packet_len > MAX_PACKET {
        return Err("invalid SSH packet".into());
    }
    let mut rest = vec![0u8; packet_len - 1];
    s.read_exact(&mut rest).map_err(|e| e.to_string())?;
    let payload = &rest[..packet_len - 1 - padding];
    parse_kexinit(payload).ok_or_else(|| "no KEXINIT".into())
}

/// Markers that are not real algorithms (extension negotiation, strict KEX).
fn is_pseudo(name: &str) -> bool {
    name.starts_with("ext-info-") || name.starts_with("kex-strict-")
}

/// Categories without a common algorithm: (label, server list, our list).
pub fn missing_common<'a>(
    server: &'a ServerAlgorithms,
    ours: &'a [(&'static str, Vec<String>)],
) -> Vec<(&'static str, Vec<&'a str>, Vec<&'a str>)> {
    let server_lists = [&server.kex, &server.host_key, &server.cipher, &server.mac];
    let mut out = Vec::new();
    for ((label, our), theirs) in ours.iter().zip(server_lists) {
        let theirs: Vec<&str> = theirs.iter().map(String::as_str).filter(|n| !is_pseudo(n)).collect();
        let our: Vec<&str> = our.iter().map(String::as_str).filter(|n| !is_pseudo(n)).collect();
        if theirs.is_empty() || our.is_empty() {
            continue;
        }
        if !theirs.iter().any(|t| our.contains(t)) {
            out.push((*label, theirs, our));
        }
    }
    out
}

/// Algorithms this build of libssh2 supports, in the order of `ServerAlgorithms`.
pub fn supported(sess: &ssh2::Session) -> Vec<(&'static str, Vec<String>)> {
    use ssh2::MethodType;
    let list = |t| sess.supported_algs(t).map(|v| v.into_iter().map(str::to_string).collect()).unwrap_or_default();
    vec![
        ("kex", list(MethodType::Kex)),
        ("hostkey", list(MethodType::HostKey)),
        ("cipher", list(MethodType::CryptCs)),
        ("mac", list(MethodType::MacCs)),
    ]
}

fn label(kind: &str) -> String {
    match kind {
        "kex" => tr!("wymiana kluczy (KexAlgorithms)", "key exchange (KexAlgorithms)").to_string(),
        "hostkey" => tr!("klucz hosta (HostKeyAlgorithms)", "host key (HostKeyAlgorithms)").to_string(),
        "cipher" => tr!("szyfr (Ciphers)", "cipher (Ciphers)").to_string(),
        _ => tr!("integralność (MACs)", "integrity (MACs)").to_string(),
    }
}

/// Readable explanation, or None when every category has a common algorithm (other cause).
pub fn explain(server: &ServerAlgorithms, ours: &[(&'static str, Vec<String>)]) -> Option<String> {
    let missing = missing_common(server, ours);
    if missing.is_empty() {
        return None;
    }
    let mut text = tr!(
        "Serwer i RemoteFlow nie mają wspólnego algorytmu:",
        "The server and RemoteFlow have no algorithm in common:"
    )
    .to_string();
    for (kind, theirs, our) in missing {
        text.push_str(&tr!(
            "\n• {} – serwer: {}; RemoteFlow: {}",
            "\n• {} – server: {}; RemoteFlow: {}",
            label(kind),
            theirs.join(", "),
            our.join(", ")
        ));
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_list(items: &[&str]) -> Vec<u8> {
        let s = items.join(",");
        let mut v = (s.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(s.as_bytes());
        v
    }

    pub(super) fn kexinit(kex: &[&str], hostkey: &[&str], cipher: &[&str], mac: &[&str]) -> Vec<u8> {
        let mut p = vec![MSG_KEXINIT];
        p.extend_from_slice(&[7u8; 16]);
        for l in [kex, hostkey, cipher, cipher, mac, mac, &["none"][..], &["none"][..], &[][..], &[][..]] {
            p.extend(name_list(l));
        }
        p.push(0);
        p.extend_from_slice(&[0, 0, 0, 0]);
        p
    }

    #[test]
    fn parses_kexinit_and_finds_missing_categories() {
        let payload = kexinit(
            &["sntrup761x25519-sha512@openssh.com", "curve25519-sha256", "ext-info-s", "kex-strict-s-v00@openssh.com"],
            &["ssh-ed25519"],
            &["chacha20-poly1305@openssh.com", "aes256-ctr"],
            &["hmac-sha2-256-etm@openssh.com"],
        );
        let server = parse_kexinit(&payload).unwrap();
        assert_eq!(server.kex.len(), 4);
        assert_eq!(server.host_key, vec!["ssh-ed25519"]);
        let ours = vec![
            ("kex", vec!["diffie-hellman-group14-sha256".to_string(), "ext-info-c".to_string()]),
            ("hostkey", vec!["rsa-sha2-512".to_string(), "ssh-rsa".to_string()]),
            ("cipher", vec!["aes256-ctr".to_string()]),
            ("mac", vec!["hmac-sha2-256-etm@openssh.com".to_string()]),
        ];
        let missing = missing_common(&server, &ours);
        assert_eq!(missing.iter().map(|m| m.0).collect::<Vec<_>>(), vec!["kex", "hostkey"]);
        // Pseudo-algorithms are not listed
        assert_eq!(missing[0].1, vec!["sntrup761x25519-sha512@openssh.com", "curve25519-sha256"]);
        assert_eq!(missing[0].2, vec!["diffie-hellman-group14-sha256"]);
        let text = explain(&server, &ours).unwrap();
        assert!(text.contains("curve25519-sha256") && text.contains("ssh-ed25519"), "{text}");
        // Everything in common – no explanation (the failure has another cause)
        let ours_ok = vec![
            ("kex", vec!["curve25519-sha256".to_string()]),
            ("hostkey", vec!["ssh-ed25519".to_string()]),
            ("cipher", vec!["aes256-ctr".to_string()]),
            ("mac", vec!["hmac-sha2-256-etm@openssh.com".to_string()]),
        ];
        assert!(explain(&server, &ours_ok).is_none());
        assert!(parse_kexinit(&[21, 0]).is_none());
    }

    /// Needs a local sshd on 127.0.0.1:2224 limited to an algorithm libssh2 lacks, e.g.
    /// `KexAlgorithms sntrup761x25519-sha512@openssh.com`.
    #[test]
    #[ignore]
    fn handshake_error_names_the_algorithms() {
        use crate::session::ssh::{ssh_connect_raw, HostKeyVerifier, SshConnectionConfig};
        use crate::vault::known_hosts::HostTrust;
        let cfg = SshConnectionConfig {
            auth_type: "password".into(), certificate: None, host: "127.0.0.1".into(), port: 2224,
            username: "rftest".into(), password: Some("x".into()), private_key: None, passphrase: None,
            host_key_verifier: HostKeyVerifier(std::sync::Arc::new(|_| Ok(HostTrust::Known))),
            jump: None,
        };
        let err = ssh_connect_raw(&cfg).err().expect("handshake must fail");
        eprintln!("{err}");
        assert!(err.contains("sntrup761x25519-sha512@openssh.com"), "{err}");
        assert!(err.contains("diffie-hellman-group14-sha256"), "{err}");
    }

    #[test]
    fn probe_reads_kexinit_from_a_server() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut c, _) = listener.accept().unwrap();
            c.write_all(b"Welcome text line\r\nSSH-2.0-OpenSSH_10.0\r\n").unwrap();
            let payload = kexinit(&["mlkem768x25519-sha256"], &["ssh-ed25519"], &["aes128-gcm@openssh.com"], &["hmac-sha2-512"]);
            let padding = 8 - ((payload.len() + 5) % 8) + 8;
            let mut pkt = ((payload.len() + padding + 1) as u32).to_be_bytes().to_vec();
            pkt.push(padding as u8);
            pkt.extend(&payload);
            pkt.extend(vec![0u8; padding]);
            c.write_all(&pkt).unwrap();
            let mut banner = [0u8; 26];
            let _ = c.read(&mut banner);
        });
        let algos = probe(addr, Duration::from_secs(3)).unwrap();
        assert_eq!(algos.kex, vec!["mlkem768x25519-sha256"]);
        assert_eq!(algos.cipher, vec!["aes128-gcm@openssh.com"]);
        assert_eq!(algos.mac, vec!["hmac-sha2-512"]);
        server.join().unwrap();
    }
}
