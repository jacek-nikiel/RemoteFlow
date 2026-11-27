//! Jump host (ProxyJump, `ssh -J`). libssh2 can only run a session over a real socket, so the
//! target is reached through a `direct-tcpip` channel on the jump host that is joined to a
//! local loopback socket pair: the target session uses one end like a TCP connection, a helper
//! thread moves the data between the other end and the channel (the same pump as the -L/-D
//! tunnels). The helper owns the jump host session and ends when either side closes.

use crate::session::ssh::{ssh_connect_raw, JumpHost};
use crate::session::tunnels::{Conn, Pump};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Logs in to the jump host (and its own jump hosts) and opens `host:port` through it; the
/// returned socket is used like a direct TCP connection. Errors say which hop failed.
pub fn connect_via(jump: &JumpHost, host: &str, port: u16) -> Result<TcpStream, String> {
    let bastion = ssh_connect_raw(&jump.config)
        .map_err(|e| tr!("Serwer pośredniczący (jump host) „{}”: {}", "Jump host “{}”: {}", jump.name, e))?;
    open_through(bastion, host, port).map_err(|e| {
        tr!(
            "Serwer pośredniczący „{}” nie połączył się z {}: {}",
            "Jump host “{}” could not reach {}: {}",
            jump.name,
            crate::session::host_port(host, port),
            e
        )
    })
}

/// Local port that leads through the jump host to `host:port` – for programs that need a TCP
/// address (FreeRDP, mstsc). Every accepted connection logs in to the jump host on its own.
/// Only loopback clients are accepted; the port closes when the handle is dropped.
pub struct JumpForward {
    pub port: u16,
    stop: Arc<AtomicBool>,
}

impl Drop for JumpForward {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the blocking accept so the thread ends
        let _ = TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], self.port)), Duration::from_millis(300));
    }
}

pub fn forward(jump: JumpHost, host: String, port: u16, report: Arc<dyn Fn(String) + Send + Sync>) -> Result<JumpForward, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let local = listener.local_addr().map_err(|e| e.to_string())?.port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    std::thread::Builder::new()
        .name("rf-jump-fwd".into())
        .spawn(move || {
            for stream in listener.incoming() {
                if stop_thread.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                if !stream.peer_addr().map(|a| a.ip().is_loopback()).unwrap_or(false) {
                    continue;
                }
                let (jump, host, report) = (jump.clone(), host.clone(), report.clone());
                std::thread::spawn(move || match ssh_connect_raw(&jump.config) {
                    Ok(bastion) => match bastion.channel_direct_tcpip(&host, port, None) {
                        Ok(channel) => pump_until_closed(bastion, channel, stream),
                        Err(e) => report(tr!(
                            "Serwer pośredniczący „{}” nie połączył się z {}: {}",
                            "Jump host “{}” could not reach {}: {}",
                            jump.name,
                            crate::session::host_port(&host, port),
                            e
                        )),
                    },
                    Err(e) => report(tr!("Serwer pośredniczący (jump host) „{}”: {}", "Jump host “{}”: {}", jump.name, e)),
                });
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(JumpForward { port: local, stop })
}

/// Opens `host:port` through the (authenticated) jump host session and returns the local end
/// to be used as the target session's TCP stream.
pub fn open_through(bastion: ssh2::Session, host: &str, port: u16) -> Result<TcpStream, String> {
    let channel = bastion
        .channel_direct_tcpip(host, port, None)
        .map_err(|e| tr!("kanał do celu odrzucony ({})", "channel to the target refused ({})", e))?;

    // Loopback pair. Another local program could connect to the listener first – the accepted
    // peer must be exactly our own client socket.
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let client = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let client_addr = client.local_addr().map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let server = loop {
        match listener.accept() {
            Ok((s, peer)) if peer == client_addr => break s,
            Ok(_) => continue, // someone else – dropped
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    drop(listener);
    let _ = server.set_nonblocking(false);
    let _ = client.set_nodelay(true);

    std::thread::Builder::new()
        .name("rf-jump".into())
        .spawn(move || pump_until_closed(bastion, channel, server))
        .map_err(|e| e.to_string())?;
    Ok(client)
}

fn pump_until_closed(bastion: ssh2::Session, channel: ssh2::Channel, server: TcpStream) {
    bastion.set_blocking(false);
    bastion.set_keepalive(true, 15);
    let mut conn = Conn::new(server, channel, 0);
    let mut buf = vec![0u8; 32 * 1024];
    let mut idle_rounds = 0u32;
    let mut last_keepalive = Instant::now();
    loop {
        match conn.pump(&mut buf) {
            Ok(Pump::Active) => idle_rounds = 0,
            Ok(Pump::Idle) => {
                idle_rounds = idle_rounds.saturating_add(1);
                // Quick at first (interactive typing), then at most 5 ms between checks
                std::thread::sleep(Duration::from_millis(if idle_rounds < 50 { 1 } else { 5 }));
            }
            Err(()) => break,
        }
        if conn.done() {
            break;
        }
        if last_keepalive.elapsed() > Duration::from_secs(15) {
            last_keepalive = Instant::now();
            let _ = bastion.keepalive_send();
        }
    }
    drop(conn); // closes the socket; the channel and the jump host session go with the session
    bastion.set_blocking(true);
    bastion.set_timeout(2_000);
    let _ = bastion.disconnect(None, "", None);
}

/// Through a local test server (sshd on 127.0.0.1:2222, key in `RF_TEST_KEY`): the forwarded
/// port reaches the target – here the same sshd, whose banner is read.
/// `RF_TEST_KEY=/path/key cargo test --lib jump_forward -- --ignored`
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    #[ignore]
    fn jump_forward_reaches_target() {
        use crate::session::ssh::{HostKeyVerifier, SshConnectionConfig};
        use crate::vault::known_hosts::HostTrust;
        let key = std::fs::read_to_string(std::env::var("RF_TEST_KEY").unwrap()).unwrap();
        let jump = JumpHost {
            name: "bastion".into(),
            config: SshConnectionConfig {
                auth_type: "key".into(), certificate: None, host: "127.0.0.1".into(), port: 2222, username: "rftest".into(),
                password: None, private_key: Some(key), passphrase: None,
                host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))), jump: None,
            },
        };
        // Direct socket through the jump host
        let mut s = connect_via(&jump, "127.0.0.1", 2222).unwrap();
        let mut buf = [0u8; 7];
        s.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"SSH-2.0");
        // Local port for external programs
        let fwd = forward(jump, "127.0.0.1".into(), 2222, Arc::new(|e| panic!("{e}"))).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", fwd.port)).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let mut buf = [0u8; 7];
        c.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"SSH-2.0");
    }
}
