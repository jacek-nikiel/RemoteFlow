//! SSH port forwarding: local (-L), dynamic SOCKS5 (-D) and remote (-R).
//!
//! All tunnels of one SSH connection share ONE dedicated SSH session (like OpenSSH): every
//! forwarded TCP connection is just a new channel inside it. The session is driven by a single
//! worker thread in non-blocking mode, which multiplexes all channels:
//! * no new SSH handshake / authentication per TCP connection (browsers open dozens of
//!   connections at once through SOCKS – with one SSH session each, `MaxStartups` on the server
//!   rejected them),
//! * TCP half-close is honoured in both directions (client EOF -> channel EOF, but the answer is
//!   still delivered; channel EOF -> `shutdown(Write)` on the socket),
//! * the number of forwarded connections and of helper threads is bounded.
//!
//! Helper threads are used only for steps that would block the worker: the SOCKS5 handshake
//! (reading the request from the client) and connecting to the local target of a -R tunnel.

use crate::session::ssh::{ssh_connect_raw, SshConnectionConfig};
use crate::vault::models::PortForwardRule;
use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Forwarded connections open at the same time (per SSH connection).
const MAX_CONNECTIONS: usize = 256;
/// SOCKS handshakes and -R target connects in progress at the same time.
const MAX_HELPERS: usize = 32;
/// Connections waiting for their channel to open.
const MAX_PENDING_OPENS: usize = 128;
const BUF_SIZE: usize = 32 * 1024;
const LIBSSH2_ERROR_EAGAIN: i32 = -37;
/// Give up opening a channel / closing it after this long.
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE_EVERY: Duration = Duration::from_secs(10);
const RECONNECT_BACKOFF: Duration = Duration::from_secs(5);
const BIND_RETRY_FOR: Duration = Duration::from_millis(1500);

/// Message for the terminal of the session (tunnel status / errors).
pub type Notify = Arc<dyn Fn(String) + Send + Sync>;

/// One tunnel as shown in the tunnels window of the session.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    /// "local" (-L), "remote" (-R) or "dynamic" (-D SOCKS5)
    pub kind: String,
    /// Port listened on: on this computer (-L, -D) or on the server (-R).
    pub port: u16,
    /// Target "host:port" (-L: reached by the server, -R: reached by this computer); none for -D.
    pub target: Option<String>,
    /// "active" (listening), "waiting" (-R: until the server connection is up) or "error"
    pub state: String,
    pub error: Option<String>,
    /// Forwarded connections open right now.
    pub connections: usize,
}

/// Tunnels of one SSH session – read by the `get_session_tunnels` command.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelsStatus {
    /// The SSH connection that carries the tunnels is up (it is opened at start and again on use).
    pub connected: bool,
    /// Why the tunnel connection is down (last error).
    pub error: Option<String>,
    pub tunnels: Vec<TunnelInfo>,
}

type SharedStatus = Arc<Mutex<TunnelsStatus>>;

fn update_status(status: &SharedStatus, f: impl FnOnce(&mut TunnelsStatus)) {
    if let Ok(mut s) = status.lock() {
        f(&mut s);
    }
}

pub struct TunnelHandle {
    shutdown_flag: Arc<AtomicBool>,
    /// Local -L / -D listeners, shared with the worker so that closing the session frees the
    /// ports at once – even while the worker is busy (e.g. connecting to the server). Before,
    /// they were released only when the worker noticed the flag, and an immediate reconnect
    /// failed with "address already in use".
    listeners: Arc<Mutex<Vec<LocalListener>>>,
    /// Local ports bound by this session and the tab title (for messages in other tabs).
    pub ports: Vec<u16>,
    pub title: String,
    status: SharedStatus,
}

impl TunnelHandle {
    pub fn status(&self) -> Option<TunnelsStatus> {
        self.status.lock().ok().map(|s| s.clone())
    }

    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::SeqCst);
        if let Ok(mut l) = self.listeners.lock() {
            l.clear();
        }
    }
}

/// Binds a local port. A port just released by a closing session may need a moment, so a busy
/// port is retried briefly.
fn bind_local(port: u16) -> std::io::Result<TcpListener> {
    let deadline = Instant::now() + BIND_RETRY_FOR;
    loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(100));
            }
            other => return other,
        }
    }
}

/// Message for a local port that could not be opened.
fn bind_error_message(port: u16, err: &std::io::Error, owners: &HashMap<u16, String>) -> String {
    if err.kind() != std::io::ErrorKind::AddrInUse {
        return tr!("Nie udało się otworzyć portu lokalnego {}: {}", "Could not open local port {}: {}", port, err);
    }
    if let Some(title) = owners.get(&port) {
        return tr!(
            "Port lokalny {} jest już używany przez tunel w karcie „{}”. Zamknij tamtą kartę albo zmień port lokalny w ustawieniach tunelu.",
            "Local port {} is already used by a tunnel in the tab \"{}\". Close that tab or change the local port in the tunnel settings.",
            port, title
        );
    }
    let hint = if cfg!(windows) { format!("netstat -ano | findstr :{port}") } else { format!("ss -ltnp | grep :{port}") };
    tr!(
        "Port lokalny {} jest zajęty przez inny program na tym komputerze. Zmień port lokalny w ustawieniach tunelu albo zamknij program, który go używa (sprawdzisz go poleceniem: {}).",
        "Local port {} is used by another program on this computer. Change the local port in the tunnel settings or close the program that uses it (find it with: {}).",
        port, hint
    )
}

fn ok_line(text: String) -> String {
    format!("\r\n\x1b[1;32m[RemoteFlow SSH]\x1b[0m {}\r\n", text)
}
fn err_line(text: String) -> String {
    format!("\r\n\x1b[1;31m[RemoteFlow SSH]\x1b[0m {}\r\n", text)
}

/// `owners`: local ports already used by tunnels of other open tabs (port → tab title).
pub fn start_tunnels(
    config: SshConnectionConfig,
    rules: Vec<PortForwardRule>,
    notify: Notify,
    title: String,
    owners: &HashMap<u16, String>,
) -> Option<TunnelHandle> {
    let rules: Vec<PortForwardRule> = rules.into_iter().filter(|r| r.enabled).collect();
    if rules.is_empty() {
        return None;
    }
    let shutdown = Arc::new(AtomicBool::new(false));

    // Local listeners are bound right away, so a busy port is reported immediately.
    let mut listeners = Vec::new();
    let mut remote_rules = Vec::new();
    let mut infos = Vec::new();
    for rule in rules {
        let tunnel = infos.len();
        let target_host = rule.remote_host.clone().filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "127.0.0.1".into());
        match rule.forward_type.as_str() {
            "local" | "dynamic" => {
                let dynamic = rule.forward_type == "dynamic";
                let target = if dynamic {
                    None
                } else {
                    let host = rule.remote_host.clone().filter(|h| !h.trim().is_empty()).unwrap_or_else(|| "127.0.0.1".into());
                    Some((host, rule.remote_port.unwrap_or(rule.local_port)))
                };
                match bind_local(rule.local_port) {
                    Ok(l) => {
                        let _ = l.set_nonblocking(true);
                        infos.push(TunnelInfo {
                            kind: rule.forward_type.clone(),
                            port: rule.local_port,
                            target: target.as_ref().map(|(h, p)| format!("{h}:{p}")),
                            state: "active".into(),
                            error: None,
                            connections: 0,
                        });
                        notify(ok_line(match &target {
                            Some((h, p)) => tr!(
                                "Tunel lokalny (-L): \x1b[36m127.0.0.1:{}\x1b[0m → \x1b[36m{}:{}\x1b[0m (przez serwer)",
                                "Local tunnel (-L): \x1b[36m127.0.0.1:{}\x1b[0m → \x1b[36m{}:{}\x1b[0m (via the server)",
                                rule.local_port, h, p
                            ),
                            None => tr!(
                                "Serwer SOCKS5 (-D): \x1b[36m127.0.0.1:{}\x1b[0m",
                                "SOCKS5 server (-D): \x1b[36m127.0.0.1:{}\x1b[0m",
                                rule.local_port
                            ),
                        }));
                        listeners.push(LocalListener { listener: l, target, tunnel });
                    }
                    Err(e) => {
                        let message = bind_error_message(rule.local_port, &e, owners);
                        infos.push(TunnelInfo {
                            kind: rule.forward_type.clone(),
                            port: rule.local_port,
                            target: target.as_ref().map(|(h, p)| format!("{h}:{p}")),
                            state: "error".into(),
                            error: Some(message.clone()),
                            connections: 0,
                        });
                        notify(err_line(message));
                    }
                }
            }
            "remote" => {
                let target_port = rule.remote_port.unwrap_or(80);
                infos.push(TunnelInfo {
                    kind: "remote".into(),
                    port: rule.local_port,
                    target: Some(format!("{target_host}:{target_port}")),
                    state: "waiting".into(),
                    error: None,
                    connections: 0,
                });
                remote_rules.push(RemoteRule { server_port: rule.local_port, target_host, target_port, tunnel });
            }
            _ => {}
        }
    }
    let status: SharedStatus = Arc::new(Mutex::new(TunnelsStatus { connected: false, error: None, tunnels: infos }));

    let ports: Vec<u16> = listeners.iter().filter_map(|l| l.listener.local_addr().ok().map(|a| a.port())).collect();
    let listeners = Arc::new(Mutex::new(listeners));
    let worker_shutdown = shutdown.clone();
    let worker_listeners = listeners.clone();
    let worker_status = status.clone();
    std::thread::spawn(move || {
        Worker::new(config, worker_listeners, remote_rules, notify, worker_shutdown, worker_status).run();
    });
    Some(TunnelHandle { shutdown_flag: shutdown, listeners, ports, title, status })
}

struct LocalListener {
    listener: TcpListener,
    /// `Some((host, port))` = -L target; `None` = SOCKS5 (target from the client).
    target: Option<(String, u16)>,
    /// Index in `TunnelsStatus::tunnels`
    tunnel: usize,
}

#[derive(Clone)]
struct RemoteRule {
    server_port: u16,
    target_host: String,
    target_port: u16,
    tunnel: usize,
}

/// A TCP client waiting for its channel.
struct PendingOpen {
    stream: TcpStream,
    host: String,
    port: u16,
    socks: bool,
    since: Instant,
    tunnel: usize,
}

enum Event {
    /// SOCKS5 handshake finished – open a channel to host:port.
    SocksRequest { stream: TcpStream, host: String, port: u16, tunnel: usize },
    /// -R: the local target of an incoming server connection is connected (or failed).
    RemoteTarget { id: u64, stream: Option<TcpStream> },
}

fn is_eagain(e: &ssh2::Error) -> bool {
    e.code() == ssh2::ErrorCode::Session(LIBSSH2_ERROR_EAGAIN)
}

/// Errors after which the SSH session itself is unusable.
fn is_fatal(e: &ssh2::Error) -> bool {
    matches!(
        e.code(),
        // SOCKET_SEND, SOCKET_DISCONNECT, SOCKET_TIMEOUT, SOCKET_RECV
        ssh2::ErrorCode::Session(-7) | ssh2::ErrorCode::Session(-13) | ssh2::ErrorCode::Session(-30) | ssh2::ErrorCode::Session(-43)
    )
}

/// RAII counter for helper threads.
struct HelperSlot(Arc<AtomicUsize>);
impl HelperSlot {
    fn try_acquire(counter: &Arc<AtomicUsize>) -> Option<Self> {
        let prev = counter.fetch_add(1, Ordering::SeqCst);
        if prev >= MAX_HELPERS {
            counter.fetch_sub(1, Ordering::SeqCst);
            None
        } else {
            Some(HelperSlot(counter.clone()))
        }
    }
}
impl Drop for HelperSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn socks_reply(stream: &mut TcpStream, code: u8) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
}

/// Reads the SOCKS5 greeting and CONNECT request (blocking, with timeouts) – runs in a helper thread.
fn socks_handshake(stream: &mut TcpStream) -> Option<(String, u16)> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut header = [0u8; 2];
    stream.read_exact(&mut header).ok()?;
    if header[0] != 5 {
        return None;
    }
    let mut methods = vec![0u8; header[1] as usize];
    stream.read_exact(&mut methods).ok()?;
    if !methods.contains(&0) {
        let _ = stream.write_all(&[5, 0xff]); // no acceptable method
        return None;
    }
    stream.write_all(&[5, 0]).ok()?;

    let mut req = [0u8; 4];
    stream.read_exact(&mut req).ok()?;
    if req[0] != 5 {
        return None;
    }
    if req[1] != 1 {
        let _ = stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]); // only CONNECT
        return None;
    }
    let host = match req[3] {
        1 => {
            let mut ip = [0u8; 4];
            stream.read_exact(&mut ip).ok()?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).ok()?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).ok()?;
            String::from_utf8_lossy(&name).to_string()
        }
        4 => {
            let mut ip = [0u8; 16];
            stream.read_exact(&mut ip).ok()?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => {
            let _ = stream.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]);
            return None;
        }
    };
    let mut port = [0u8; 2];
    stream.read_exact(&mut port).ok()?;
    Some((host, u16::from_be_bytes(port)))
}

/// One forwarded connection: a TCP socket and an SSH channel, both non-blocking.
pub(crate) struct Conn {
    /// Index in `TunnelsStatus::tunnels`
    tunnel: usize,
    tcp: TcpStream,
    ch: ssh2::Channel,
    to_ch: Vec<u8>,
    to_ch_off: usize,
    to_tcp: Vec<u8>,
    to_tcp_off: usize,
    /// The TCP client finished sending (half-close) – forwarded as channel EOF.
    tcp_eof: bool,
    eof_sent: bool,
    /// The server side finished sending – forwarded as shutdown(Write) on the socket.
    ch_eof: bool,
    tcp_shut: bool,
    failed: bool,
    /// When the server side finished (for a client that never closes its side).
    finished_at: Option<Instant>,
}

pub(crate) enum Pump {
    Idle,
    Active,
}

impl Conn {
    pub(crate) fn new(tcp: TcpStream, ch: ssh2::Channel, tunnel: usize) -> Self {
        let _ = tcp.set_nonblocking(true);
        let _ = tcp.set_nodelay(true);
        Conn {
            tunnel,
            tcp,
            ch,
            to_ch: Vec::new(),
            to_ch_off: 0,
            to_tcp: Vec::new(),
            to_tcp_off: 0,
            tcp_eof: false,
            eof_sent: false,
            ch_eof: false,
            tcp_shut: false,
            failed: false,
            finished_at: None,
        }
    }

    pub(crate) fn done(&self) -> bool {
        if self.failed {
            return true;
        }
        let up_done = self.tcp_eof && self.eof_sent;
        let down_done = self.ch_eof && self.tcp_shut;
        if up_done && down_done {
            return true;
        }
        // The server closed its side and the client got everything (and a shutdown), but the
        // client never closes its own side – do not keep it forever.
        down_done && self.finished_at.is_some_and(|t| t.elapsed() > Duration::from_secs(30))
    }

    /// Moves as much data as possible in both directions without blocking.
    pub(crate) fn pump(&mut self, buf: &mut [u8]) -> Result<Pump, ()> {
        let mut active = false;

        // TCP client -> channel
        loop {
            if self.to_ch_off >= self.to_ch.len() && !self.tcp_eof {
                match self.tcp.read(buf) {
                    Ok(0) => {
                        self.tcp_eof = true;
                        active = true;
                    }
                    Ok(n) => {
                        self.to_ch.clear();
                        self.to_ch.extend_from_slice(&buf[..n]);
                        self.to_ch_off = 0;
                        active = true;
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => {}
                    Err(_) => return Err(()),
                }
            }
            if self.to_ch_off >= self.to_ch.len() {
                break;
            }
            match self.ch.write(&self.to_ch[self.to_ch_off..]) {
                Ok(0) => break,
                Ok(n) => {
                    self.to_ch_off += n;
                    active = true;
                    if self.to_ch_off < self.to_ch.len() {
                        break; // channel window full – continue next round
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                Err(_) => return Err(()),
            }
        }
        if self.tcp_eof && !self.eof_sent && self.to_ch_off >= self.to_ch.len() {
            match self.ch.send_eof() {
                Ok(()) => {
                    self.eof_sent = true;
                    active = true;
                }
                Err(e) if is_eagain(&e) => {}
                Err(_) => self.eof_sent = true,
            }
        }

        // Channel -> TCP client
        loop {
            if self.to_tcp_off >= self.to_tcp.len() && !self.ch_eof {
                match self.ch.read(buf) {
                    Ok(0) => {
                        if self.ch.eof() {
                            self.ch_eof = true;
                            active = true;
                        }
                    }
                    Ok(n) => {
                        self.to_tcp.clear();
                        self.to_tcp.extend_from_slice(&buf[..n]);
                        self.to_tcp_off = 0;
                        active = true;
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => return Err(()),
                }
            }
            if self.to_tcp_off >= self.to_tcp.len() {
                break;
            }
            match self.tcp.write(&self.to_tcp[self.to_tcp_off..]) {
                Ok(0) => return Err(()),
                Ok(n) => {
                    self.to_tcp_off += n;
                    active = true;
                    if self.to_tcp_off < self.to_tcp.len() {
                        break;
                    }
                }
                Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::Interrupted => break,
                Err(_) => return Err(()),
            }
        }
        if self.ch_eof && !self.tcp_shut && self.to_tcp_off >= self.to_tcp.len() {
            let _ = self.tcp.shutdown(Shutdown::Write);
            self.tcp_shut = true;
            self.finished_at = Some(Instant::now());
            active = true;
        }

        Ok(if active { Pump::Active } else { Pump::Idle })
    }
}

/// Channel being closed (a non-blocking close needs several calls).
struct Closing {
    ch: ssh2::Channel,
    since: Instant,
}

struct Ssh {
    sess: ssh2::Session,
    /// -R listeners on the server
    remote_listeners: Vec<(ssh2::Listener, RemoteRule)>,
}

struct Worker {
    config: SshConnectionConfig,
    listeners: Arc<Mutex<Vec<LocalListener>>>,
    remote_rules: Vec<RemoteRule>,
    notify: Notify,
    shutdown: Arc<AtomicBool>,
    ssh: Option<Ssh>,
    last_attempt: Option<Instant>,
    connect_error_reported: bool,
    ever_connected: bool,
    pending: VecDeque<PendingOpen>,
    /// SOCKS clients waiting for a free helper thread (bursts larger than MAX_HELPERS)
    waiting_socks: VecDeque<(TcpStream, Instant, usize)>,
    conns: Vec<Conn>,
    closing: Vec<Closing>,
    /// -R: server channels waiting for their local target connection.
    awaiting_target: HashMap<u64, (ssh2::Channel, usize)>,
    next_id: u64,
    helpers: Arc<AtomicUsize>,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    status: SharedStatus,
    last_counts: Vec<usize>,
}

impl Worker {
    fn new(
        config: SshConnectionConfig,
        listeners: Arc<Mutex<Vec<LocalListener>>>,
        remote_rules: Vec<RemoteRule>,
        notify: Notify,
        shutdown: Arc<AtomicBool>,
        status: SharedStatus,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        Worker {
            config,
            listeners,
            remote_rules,
            notify,
            shutdown,
            ssh: None,
            last_attempt: None,
            connect_error_reported: false,
            ever_connected: false,
            pending: VecDeque::new(),
            waiting_socks: VecDeque::new(),
            conns: Vec::new(),
            closing: Vec::new(),
            awaiting_target: HashMap::new(),
            next_id: 0,
            helpers: Arc::new(AtomicUsize::new(0)),
            tx,
            rx,
            status,
            last_counts: Vec::new(),
        }
    }

    /// Open connections per tunnel, for the tunnels window (written only when they change).
    fn publish_counts(&mut self) {
        let len = self.status.lock().map(|s| s.tunnels.len()).unwrap_or(0);
        let mut counts = vec![0usize; len];
        for c in &self.conns {
            if let Some(n) = counts.get_mut(c.tunnel) {
                *n += 1;
            }
        }
        if counts != self.last_counts {
            update_status(&self.status, |s| {
                for (t, n) in s.tunnels.iter_mut().zip(&counts) {
                    t.connections = *n;
                }
            });
            self.last_counts = counts;
        }
    }

    fn busy(&self) -> usize {
        self.conns.len() + self.pending.len() + self.awaiting_target.len() + self.waiting_socks.len()
    }

    fn run(mut self) {
        let mut buf = vec![0u8; BUF_SIZE];
        let mut last_keepalive = Instant::now();
        let mut last_publish = Instant::now();
        // Connect right away: errors show up in the terminal at once and -R tunnels need it.
        self.ensure_connected();

        while !self.shutdown.load(Ordering::Relaxed) {
            let mut active = false;
            active |= self.accept_local();
            active |= self.handle_events();

            let need_session = !self.pending.is_empty() || !self.remote_rules.is_empty();
            if self.ssh.is_none() && need_session {
                self.ensure_connected();
                if self.ssh.is_none() {
                    // Clients that cannot be served now are refused instead of hanging
                    for mut p in self.pending.drain(..) {
                        if p.socks {
                            socks_reply(&mut p.stream, 1);
                        }
                    }
                }
            }

            if self.ssh.is_some() {
                let mut dead = false;
                active |= self.open_channels(&mut dead);
                active |= self.accept_remote(&mut dead);
                for c in self.conns.iter_mut() {
                    match c.pump(&mut buf) {
                        Ok(Pump::Active) => active = true,
                        Ok(Pump::Idle) => {}
                        Err(()) => c.failed = true,
                    }
                }
                // Finished connections: their channels are closed in the background
                let mut i = 0;
                while i < self.conns.len() {
                    if self.conns[i].done() {
                        let c = self.conns.swap_remove(i);
                        self.closing.push(Closing { ch: c.ch, since: Instant::now() });
                    } else {
                        i += 1;
                    }
                }
                self.closing.retain_mut(|c| match c.ch.close() {
                    Err(e) if is_eagain(&e) => c.since.elapsed() < CLOSE_TIMEOUT,
                    _ => false,
                });

                if last_keepalive.elapsed() >= KEEPALIVE_EVERY {
                    last_keepalive = Instant::now();
                    if let Some(ssh) = &self.ssh {
                        match ssh.sess.keepalive_send() {
                            Ok(_) => {}
                            Err(e) if is_eagain(&e) => {}
                            Err(_) => dead = true,
                        }
                    }
                }
                if dead {
                    self.drop_session();
                }
            }

            if last_publish.elapsed() >= Duration::from_millis(500) {
                last_publish = Instant::now();
                self.publish_counts();
            }

            if !active {
                let idle = self.conns.is_empty() && self.pending.is_empty() && self.waiting_socks.is_empty();
                std::thread::sleep(Duration::from_millis(if idle { 20 } else { 2 }));
            }
        }

        // Shutdown: stop listening locally and on the server, close everything.
        if let Ok(mut l) = self.listeners.lock() {
            l.clear();
        }
        if let Some(ssh) = self.ssh.take() {
            ssh.sess.set_blocking(true);
            ssh.sess.set_timeout(2000);
            for mut c in self.conns.drain(..) {
                let _ = c.ch.close();
            }
            drop(ssh.remote_listeners);
            let _ = ssh.sess.disconnect(None, "RemoteFlow tunnel closed", None);
        }
    }

    fn ensure_connected(&mut self) {
        if self.ssh.is_some() {
            return;
        }
        if self.last_attempt.is_some_and(|t| t.elapsed() < RECONNECT_BACKOFF) {
            return;
        }
        self.last_attempt = Some(Instant::now());
        match ssh_connect_raw(&self.config) {
            Ok(sess) => {
                // -R listeners are set up in blocking mode, then everything runs non-blocking.
                sess.set_blocking(true);
                sess.set_timeout(10_000);
                let mut remote_listeners = Vec::new();
                for rule in &self.remote_rules {
                    match sess.channel_forward_listen(rule.server_port, None, None) {
                        Ok((l, port)) => {
                            let tunnel = rule.tunnel;
                            update_status(&self.status, |s| {
                                if let Some(t) = s.tunnels.get_mut(tunnel) {
                                    t.state = "active".into();
                                    t.error = None;
                                }
                            });
                            (self.notify)(ok_line(tr!(
                                "Tunel zdalny (-R): \x1b[36mserwer:{}\x1b[0m → \x1b[36m{}:{}\x1b[0m (ten komputer)",
                                "Remote tunnel (-R): \x1b[36mserver:{}\x1b[0m → \x1b[36m{}:{}\x1b[0m (this computer)",
                                port, rule.target_host, rule.target_port
                            )));
                            remote_listeners.push((l, rule.clone()));
                        }
                        Err(e) => {
                            let message = tr!(
                                "Serwer nie pozwolił nasłuchiwać na porcie {} (-R): {}",
                                "The server refused to listen on port {} (-R): {}",
                                rule.server_port, e
                            );
                            let tunnel = rule.tunnel;
                            update_status(&self.status, |s| {
                                if let Some(t) = s.tunnels.get_mut(tunnel) {
                                    t.state = "error".into();
                                    t.error = Some(message.clone());
                                }
                            });
                            (self.notify)(err_line(message));
                        }
                    }
                }
                sess.set_timeout(0);
                sess.set_keepalive(true, 10);
                sess.set_blocking(false);
                if self.ever_connected && self.connect_error_reported {
                    (self.notify)(ok_line(tr!("Tunele połączone ponownie.", "Tunnels reconnected.").to_string()));
                }
                self.ever_connected = true;
                self.connect_error_reported = false;
                self.ssh = Some(Ssh { sess, remote_listeners });
                update_status(&self.status, |s| {
                    s.connected = true;
                    s.error = None;
                });
            }
            Err(e) => {
                let reason = e.to_string();
                update_status(&self.status, |s| {
                    s.connected = false;
                    s.error = Some(reason);
                });
                if !self.connect_error_reported {
                    (self.notify)(err_line(tr!(
                        "Tunele: nie udało się połączyć z serwerem ({}). Ponowna próba przy kolejnym połączeniu.",
                        "Tunnels: could not connect to the server ({}). Will retry with the next connection.",
                        e
                    )));
                    self.connect_error_reported = true;
                }
            }
        }
    }

    fn drop_session(&mut self) {
        (self.notify)(err_line(
            tr!(
                "Tunele: połączenie z serwerem zostało przerwane – zostanie nawiązane ponownie.",
                "Tunnels: the connection to the server was lost – it will be re-established."
            )
            .to_string(),
        ));
        self.connect_error_reported = true;
        self.conns.clear();
        self.closing.clear();
        self.awaiting_target.clear();
        self.ssh = None;
        self.last_attempt = None;
        update_status(&self.status, |s| {
            s.connected = false;
            s.error = Some(tr!("połączenie przerwane", "connection lost").to_string());
            for t in s.tunnels.iter_mut().filter(|t| t.kind == "remote" && t.state == "active") {
                t.state = "waiting".into();
            }
        });
    }

    /// Accepts new clients on the local -L / -D ports.
    fn accept_local(&mut self) -> bool {
        let mut active = false;
        let mut accepted = Vec::new();
        if let Ok(listeners) = self.listeners.lock() {
            for l in listeners.iter() {
                for _ in 0..16 {
                    match l.listener.accept() {
                        Ok((stream, _)) => accepted.push((stream, l.target.clone(), l.tunnel)),
                        Err(_) => break, // WouldBlock or a transient error
                    }
                }
            }
        }
        for (stream, target, tunnel) in accepted {
            {
                active = true;
                if self.busy() >= MAX_CONNECTIONS || self.pending.len() >= MAX_PENDING_OPENS {
                    drop(stream); // over the limit – refuse instead of exhausting resources
                    continue;
                }
                match target {
                    Some((host, port)) => {
                        self.pending.push_back(PendingOpen { stream, host, port, socks: false, since: Instant::now(), tunnel });
                    }
                    None => self.waiting_socks.push_back((stream, Instant::now(), tunnel)),
                }
            }
        }
        active |= self.start_socks_handshakes();
        active
    }

    /// Starts SOCKS handshakes for waiting clients as long as helper threads are free. A burst
    /// larger than the limit waits instead of being refused.
    fn start_socks_handshakes(&mut self) -> bool {
        let mut active = false;
        while let Some((_, since, _)) = self.waiting_socks.front() {
            if since.elapsed() > OPEN_TIMEOUT {
                self.waiting_socks.pop_front();
                continue;
            }
            let Some(slot) = HelperSlot::try_acquire(&self.helpers) else { break };
            let (stream, _, tunnel) = self.waiting_socks.pop_front().unwrap();
            let tx = self.tx.clone();
            std::thread::spawn(move || {
                let _slot = slot;
                let mut stream = stream;
                if let Some((host, port)) = socks_handshake(&mut stream) {
                    let _ = tx.send(Event::SocksRequest { stream, host, port, tunnel });
                }
            });
            active = true;
        }
        active
    }

    fn handle_events(&mut self) -> bool {
        let mut active = false;
        while let Ok(ev) = self.rx.try_recv() {
            active = true;
            match ev {
                Event::SocksRequest { mut stream, host, port, tunnel } => {
                    if self.pending.len() >= MAX_PENDING_OPENS {
                        socks_reply(&mut stream, 1);
                    } else {
                        self.pending.push_back(PendingOpen { stream, host, port, socks: true, since: Instant::now(), tunnel });
                    }
                }
                Event::RemoteTarget { id, stream } => {
                    if let Some((ch, tunnel)) = self.awaiting_target.remove(&id) {
                        match stream {
                            Some(s) => self.conns.push(Conn::new(s, ch, tunnel)),
                            None => self.closing.push(Closing { ch, since: Instant::now() }),
                        }
                    }
                }
            }
        }
        active
    }

    /// Opens channels for waiting clients. libssh2 can have only one channel open in progress,
    /// so they are opened one after another (each takes one round trip).
    fn open_channels(&mut self, dead: &mut bool) -> bool {
        let mut active = false;
        let Some(ssh) = &self.ssh else { return false };
        while let Some(p) = self.pending.front() {
            if p.since.elapsed() > OPEN_TIMEOUT {
                let mut p = self.pending.pop_front().unwrap();
                if p.socks {
                    socks_reply(&mut p.stream, 4); // host unreachable
                }
                continue;
            }
            match ssh.sess.channel_direct_tcpip(&p.host, p.port, None) {
                Ok(ch) => {
                    let mut p = self.pending.pop_front().unwrap();
                    if p.socks {
                        socks_reply(&mut p.stream, 0);
                    }
                    self.conns.push(Conn::new(p.stream, ch, p.tunnel));
                    active = true;
                }
                Err(e) if is_eagain(&e) => break,
                Err(e) => {
                    let mut p = self.pending.pop_front().unwrap();
                    if p.socks {
                        socks_reply(&mut p.stream, 5); // connection refused
                    }
                    eprintln!("[RemoteFlow Tunnel] direct-tcpip {}:{} failed: {}", p.host, p.port, e);
                    active = true;
                    if is_fatal(&e) {
                        *dead = true;
                        break;
                    }
                }
            }
        }
        active
    }

    /// -R: accepts connections the server forwards to us and connects them to the local target.
    fn accept_remote(&mut self, dead: &mut bool) -> bool {
        let mut active = false;
        let mut accepted: Vec<(ssh2::Channel, RemoteRule)> = Vec::new();
        if let Some(ssh) = &mut self.ssh {
            for (listener, rule) in ssh.remote_listeners.iter_mut() {
                match listener.accept() {
                    Ok(ch) => accepted.push((ch, rule.clone())),
                    Err(e) if is_eagain(&e) => {}
                    Err(e) => {
                        if is_fatal(&e) {
                            *dead = true;
                        }
                    }
                }
            }
        }
        for (ch, rule) in accepted {
            active = true;
            let slot = if self.busy() < MAX_CONNECTIONS { HelperSlot::try_acquire(&self.helpers) } else { None };
            let Some(slot) = slot else {
                self.closing.push(Closing { ch, since: Instant::now() });
                continue;
            };
            let id = self.next_id;
            self.next_id += 1;
            self.awaiting_target.insert(id, (ch, rule.tunnel));
            let tx = self.tx.clone();
            std::thread::spawn(move || {
                let _slot = slot;
                let stream = (rule.target_host.as_str(), rule.target_port)
                    .to_socket_addrs()
                    .ok()
                    .and_then(|mut addrs| addrs.find_map(|a| TcpStream::connect_timeout(&a, Duration::from_secs(5)).ok()));
                if stream.is_none() {
                    eprintln!(
                        "[RemoteFlow Tunnel] -R: cannot connect to local target {}:{}",
                        rule.target_host, rule.target_port
                    );
                }
                let _ = tx.send(Event::RemoteTarget { id, stream });
            });
        }
        active
    }
}

// ---------------------------------------------------------------------------------------------
// Integration test – needs the local test sshd on 127.0.0.1:2222 (`cargo test -- --ignored`)
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tunnel_e2e {
    use super::*;
    use crate::session::ssh::HostKeyVerifier;
    use crate::vault::known_hosts::HostTrust;

    fn config() -> SshConnectionConfig {
        SshConnectionConfig {
            auth_type: "password".into(),
            certificate: None,
            host: "127.0.0.1".into(),
            port: 2222,
            username: "rftest".into(),
            password: Some("Test-Pass-123".into()),
            private_key: None,
            passphrase: None,
            host_key_verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
            jump: None,
        }
    }

    fn rule(kind: &str, local: u16, host: Option<&str>, port: Option<u16>) -> PortForwardRule {
        PortForwardRule {
            id: format!("t-{}", local),
            forward_type: kind.into(),
            local_port: local,
            remote_host: host.map(|h| h.to_string()),
            remote_port: port,
            enabled: true,
        }
    }

    /// Test server: reads the whole request until the client half-closes, waits a moment and
    /// answers "OK:<request length>" – the answer only arrives if half-close is handled right.
    fn start_half_close_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut s = s;
                    let mut req = Vec::new();
                    let _ = s.read_to_end(&mut req);
                    std::thread::sleep(Duration::from_millis(100));
                    let _ = s.write_all(format!("OK:{}", req.len()).as_bytes());
                });
            }
        });
        port
    }

    fn request(stream: &mut TcpStream, body: &[u8]) -> String {
        stream.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        stream.write_all(body).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        resp
    }

    fn socks_connect(proxy: u16, port: u16) -> TcpStream {
        let mut s = TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        s.write_all(&[5, 1, 0]).unwrap();
        let mut r = [0u8; 2];
        s.read_exact(&mut r).unwrap();
        assert_eq!(r, [5, 0]);
        let mut req = vec![5, 1, 0, 3, 9];
        req.extend_from_slice(b"127.0.0.1");
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).unwrap();
        let mut rep = [0u8; 10];
        s.read_exact(&mut rep).unwrap();
        assert_eq!(rep[1], 0, "SOCKS CONNECT failed");
        s
    }

    /// SSH server that accepts TCP but never answers – the tunnel worker stays busy connecting.
    fn silent_server() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut keep = Vec::new();
            for c in l.incoming().flatten() {
                keep.push(c);
            }
        });
        port
    }

    fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    /// Closing a session frees its local ports at once, even while the worker is still busy
    /// connecting (reconnect used to fail with "address already in use"); a busy port gets a
    /// message naming the tab or the other program.
    #[test]
    fn local_ports_are_freed_on_shutdown_and_conflicts_are_explained() {
        let mut cfg = config();
        cfg.port = silent_server();
        let port = free_port();
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let log2 = log.clone();
        let notify: Notify = Arc::new(move |m| log2.lock().unwrap().push(m));

        let first = start_tunnels(cfg.clone(), vec![rule("local", port, None, Some(80))], notify.clone(), "Serwer A".into(), &HashMap::new()).unwrap();
        assert_eq!(first.ports, vec![port]);

        // A second tab with the same local port: message names the first tab
        let owners: HashMap<u16, String> = first.ports.iter().map(|p| (*p, first.title.clone())).collect();
        let second = start_tunnels(cfg.clone(), vec![rule("local", port, None, Some(80))], notify.clone(), "Serwer B".into(), &owners).unwrap();
        assert!(second.ports.is_empty());
        assert!(log.lock().unwrap().join("").contains("Serwer A"), "{:?}", log.lock().unwrap());
        // The tunnels window shows the failed tunnel with the same message
        let st = second.status().unwrap();
        assert_eq!(st.tunnels.len(), 1);
        assert_eq!(st.tunnels[0].state, "error");
        assert!(st.tunnels[0].error.as_deref().is_some_and(|e| e.contains("Serwer A")));
        assert_eq!(first.status().unwrap().tunnels[0].state, "active");
        second.shutdown();

        // Reconnect: the port is free right after shutdown although the worker is still connecting
        let t0 = Instant::now();
        first.shutdown();
        let again = start_tunnels(cfg.clone(), vec![rule("local", port, None, Some(80))], notify.clone(), "Serwer A".into(), &HashMap::new()).unwrap();
        assert_eq!(again.ports, vec![port]);
        assert!(t0.elapsed() < Duration::from_millis(500), "{:?}", t0.elapsed());
        again.shutdown();

        // Port held by another program
        let foreign = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = foreign.local_addr().unwrap().port();
        log.lock().unwrap().clear();
        let h = start_tunnels(cfg, vec![rule("local", busy, None, Some(80))], notify, "Serwer C".into(), &HashMap::new()).unwrap();
        assert!(h.ports.is_empty());
        let text = log.lock().unwrap().join("");
        assert!(text.contains(&format!(":{busy}")) && !text.contains("os error"), "{text}");
        h.shutdown();
    }

    #[test]
    #[ignore]
    fn local_dynamic_and_remote_tunnels() {
        let target = start_half_close_server();
        let log: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log2 = log.clone();
        let notify: Notify = Arc::new(move |m| log2.lock().unwrap().push(m));
        let handle = start_tunnels(
            config(),
            vec![
                rule("local", 41001, Some("127.0.0.1"), Some(target)),
                rule("dynamic", 41002, None, None),
                rule("remote", 41003, Some("127.0.0.1"), Some(target)),
            ],
            notify,
            "test".into(),
            &HashMap::new(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(1500));

        // Status for the tunnels window
        let st = handle.status().unwrap();
        assert!(st.connected && st.error.is_none());
        let kinds: Vec<_> = st.tunnels.iter().map(|t| (t.kind.as_str(), t.port, t.state.as_str())).collect();
        assert_eq!(kinds, vec![("local", 41001, "active"), ("dynamic", 41002, "active"), ("remote", 41003, "active")]);
        assert_eq!(st.tunnels[0].target.as_deref(), Some(format!("127.0.0.1:{target}").as_str()));
        assert_eq!(st.tunnels[1].target, None);
        // An open forwarded connection is counted for its tunnel
        let held = TcpStream::connect(("127.0.0.1", 41001)).unwrap();
        std::thread::sleep(Duration::from_millis(1000));
        let counts: Vec<_> = handle.status().unwrap().tunnels.iter().map(|t| t.connections).collect();
        assert_eq!(counts, vec![1, 0, 0]);
        drop(held);

        // -L with half-close and a large request (many channel windows)
        let big = vec![b'x'; 3 * 1024 * 1024];
        let mut s = TcpStream::connect(("127.0.0.1", 41001)).unwrap();
        assert_eq!(request(&mut s, &big), format!("OK:{}", big.len()));

        // -D: 100 parallel connections through one SSH session (100 logins would hit MaxStartups;
        // more than MAX_HELPERS handshakes at once must wait, not be refused)
        let threads: Vec<_> = (0..100)
            .map(|i| {
                std::thread::spawn(move || {
                    let mut s = socks_connect(41002, target);
                    request(&mut s, format!("req-{}", i).as_bytes())
                })
            })
            .collect();
        for (i, t) in threads.into_iter().enumerate() {
            assert_eq!(t.join().unwrap(), format!("OK:{}", format!("req-{}", i).len()));
        }

        // -R: the server listens on 41003 and forwards to our target
        let mut s = TcpStream::connect(("127.0.0.1", 41003)).unwrap();
        assert_eq!(request(&mut s, b"via-server"), "OK:10");

        handle.shutdown();
        std::thread::sleep(Duration::from_millis(500));
        assert!(TcpStream::connect(("127.0.0.1", 41001)).is_err(), "listener closed on shutdown");
        let messages = log.lock().unwrap().join("");
        assert!(!messages.contains("[1;31m"), "no error messages: {}", messages);
    }
}
