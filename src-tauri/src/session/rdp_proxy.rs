//! Local WebSocket <-> RDP bridge for the IronRDP WebAssembly client (RDCleanPath protocol).
//!
//! Security properties:
//! * listens on 127.0.0.1 only and accepts a client only with the per-session random token,
//! * always connects to the target configured in the vault (the `destination` requested by the
//!   client is ignored),
//! * pins the RDP server's TLS certificate (trust on first use, see `known_hosts`).

use crate::session::ssh::HostKeyVerifier;
use crate::vault::cipher::sha256_fingerprint;
use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::time::timeout;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// SSH login to the jump host(s) plus the channel to the RDP server.
const JUMP_TIMEOUT: Duration = Duration::from_secs(60);

static RDP_RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Failed to initialize Tokio runtime for RDP proxy")
});

/// Reports proxy failures to the UI (the release build on Windows has no console for eprintln!).
pub type ErrorReporter = Arc<dyn Fn(String) + Send + Sync>;

pub struct RdpProxyHandle {
    pub port: u16,
    shutdown_tx: broadcast::Sender<()>,
}

impl RdpProxyHandle {
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(());
    }
}

/// Jump host route of an RDP connection: the jump host and the real target host and port.
#[derive(Clone)]
pub struct RdpJump {
    pub jump: crate::session::ssh::JumpHost,
    pub host: String,
    pub port: u16,
}

#[derive(Clone)]
struct ProxyContext {
    target: String,
    jump: Option<RdpJump>,
    token: Arc<String>,
    verifier: HostKeyVerifier,
    report: ErrorReporter,
}

impl ProxyContext {
    fn fail(&self, msg: String) {
        eprintln!("[RemoteFlow RDP Proxy] {}", msg);
        (self.report)(msg);
    }
}

pub fn start_rdp_proxy(
    target_host: String,
    target_port: u16,
    token: String,
    verifier: HostKeyVerifier,
    report: ErrorReporter,
    jump: Option<crate::session::ssh::JumpHost>,
) -> Result<RdpProxyHandle, String> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| tr!("Błąd wiązania lokalnego proxy RDP: {}", "Error binding the local RDP proxy: {}", e))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| tr!("Błąd konfiguracji gniazda proxy RDP: {}", "RDP proxy socket configuration error: {}", e))?;

    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();

    let (shutdown_tx, _) = broadcast::channel::<()>(1);
    let mut shutdown = shutdown_tx.subscribe();
    let ctx = ProxyContext {
        target: crate::session::host_port(&target_host, target_port),
        jump: jump.map(|jump| RdpJump { jump, host: target_host.clone(), port: target_port }),
        token: Arc::new(token),
        verifier,
        report,
    };

    eprintln!("[RemoteFlow RDP Proxy] Uruchomiono proxy na 127.0.0.1:{} -> {}", port, ctx.target);

    RDP_RUNTIME.spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                ctx.fail(tr!("Błąd uruchamiania lokalnego proxy RDP: {}", "Error starting the local RDP proxy: {}", e));
                return;
            }
        };

        let mut clients = tokio::task::JoinSet::new();
        let capacity = Arc::new(tokio::sync::Semaphore::new(32));
        loop {
            tokio::select! {
                _ = shutdown.recv() => {
                    eprintln!("[RemoteFlow RDP Proxy] Zamykanie proxy na porcie {}", port);
                    break;
                }
                accept_res = listener.accept() => {
                    match accept_res {
                        Ok((stream, client_addr)) => {
                            if !client_addr.ip().is_loopback() {
                                continue;
                            }
                            let ctx = ctx.clone();
                            let Ok(permit) = capacity.clone().try_acquire_owned() else { continue; };
                            clients.spawn(async move {
                                let _permit = permit;
                                handle_client(stream, ctx).await;
                            });
                        }
                        Err(e) => {
                            ctx.fail(tr!("Błąd przyjmowania połączenia przez proxy RDP: {}", "RDP proxy accept error: {}", e));
                            break;
                        }
                    }
                }
                _ = clients.join_next(), if !clients.is_empty() => {}
            }
        }
        clients.abort_all();
        while clients.join_next().await.is_some() {}
    });

    Ok(RdpProxyHandle { port, shutdown_tx })
}

/// Accepts the certificate chain *during the handshake* (RDP servers almost always use self-signed
/// certificates); the leaf is pinned by its SHA-256 fingerprint right after the handshake.
/// Handshake signatures ARE verified, so a server cannot present a pinned certificate without
/// holding its private key.
#[derive(Debug)]
struct PinnedAfterHandshake(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for PinnedAfterHandshake {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &rustls_pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls_pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls_pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn make_tls_connector() -> Result<tokio_rustls::TlsConnector, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| tr!("Błąd konfiguracji TLS: {}", "TLS configuration error: {}", e))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedAfterHandshake(provider)))
        .with_no_client_auth();
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}

async fn read_tpkt(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| tr!("Błąd odczytu nagłówka TPKT: {}", "TPKT header read error: {}", e))?;

    if header[0] != 3 {
        return Err(tr!("Nieprawidłowy nagłówek TPKT (0x{:02x} != 0x03)", "Invalid TPKT header (0x{:02x} != 0x03)", header[0]));
    }

    let length = u16::from_be_bytes([header[2], header[3]]) as usize;
    if length < 4 {
        return Err(tr!("Nieprawidłowa długość TPKT: {}", "Invalid TPKT length: {}", length));
    }

    let mut packet = vec![0u8; length];
    packet[..4].copy_from_slice(&header);
    stream
        .read_exact(&mut packet[4..])
        .await
        .map_err(|e| tr!("Błąd odczytu ciała TPKT: {}", "TPKT body read error: {}", e))?;

    Ok(packet)
}

/// Any bidirectional async byte stream (rustls or native-tls).
trait IoStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> IoStream for T {}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TlsMode {
    /// rustls: TLS 1.2/1.3, AEAD suites only.
    Modern,
    /// System TLS (Schannel / OpenSSL): additionally TLS 1.0/1.1 and CBC suites.
    Legacy,
}

enum HandshakeError {
    /// TLS negotiation failed – worth retrying in the other mode.
    Tls(String),
    /// Anything else (network, X.224) – retrying makes no sense.
    Fatal(String),
}

type HandshakeResult = (Box<dyn IoStream>, Vec<u8>, Vec<Vec<u8>>);

/// TCP connect, X.224 Connection Request/Confirm and TLS handshake with the configured server.
async fn rdp_handshake(target: &str, jump: Option<&RdpJump>, x224_req: &[u8], mode: TlsMode) -> Result<HandshakeResult, HandshakeError> {
    let mut tcp = match jump {
        Some(route) => {
            // Through the jump host (SSH login + channel are blocking – off the async threads)
            let route = route.clone();
            let opened = timeout(JUMP_TIMEOUT, tokio::task::spawn_blocking(move || {
                crate::session::jump::connect_via(&route.jump, &route.host, route.port)
            }))
            .await;
            match opened {
                Ok(Ok(Ok(std_stream))) => {
                    let _ = std_stream.set_nonblocking(true);
                    let t = TcpStream::from_std(std_stream).map_err(|e| HandshakeError::Fatal(e.to_string()))?;
                    let _ = t.set_nodelay(true);
                    t
                }
                Ok(Ok(Err(e))) => return Err(HandshakeError::Fatal(e)),
                Ok(Err(e)) => return Err(HandshakeError::Fatal(e.to_string())),
                Err(_) => {
                    return Err(HandshakeError::Fatal(tr!(
                        "Serwer pośredniczący nie zestawił połączenia z {} w {} s.",
                        "The jump host did not reach {} within {} s.",
                        target,
                        JUMP_TIMEOUT.as_secs()
                    )))
                }
            }
        }
        None => match timeout(CONNECT_TIMEOUT, TcpStream::connect(target)).await {
            Ok(Ok(t)) => {
                let _ = t.set_nodelay(true);
                t
            }
            Ok(Err(e)) => {
                return Err(HandshakeError::Fatal(tr!(
                    "Nie można połączyć się z serwerem RDP {}: {}", "Cannot connect to RDP server {}: {}",
                    target, e
                )))
            }
            Err(_) => {
                return Err(HandshakeError::Fatal(tr!(
                    "Serwer RDP {} nie odpowiada (limit {} s). Sprawdź adres, port i zaporę sieciową.", "RDP server {} does not respond (timeout {} s). Check the address, port and firewall.",
                    target,
                    CONNECT_TIMEOUT.as_secs()
                )))
            }
        },
    };

    tcp.write_all(x224_req)
        .await
        .map_err(|e| HandshakeError::Fatal(tr!("Błąd wysyłania X.224 do serwera RDP: {}", "Error sending X.224 to the RDP server: {}", e)))?;
    let _ = tcp.flush().await;

    let x224_resp = match timeout(HANDSHAKE_TIMEOUT, read_tpkt(&mut tcp)).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(HandshakeError::Fatal(tr!("Błąd negocjacji X.224 z serwerem RDP: {}", "X.224 negotiation error with the RDP server: {}", e))),
        Err(_) => return Err(HandshakeError::Fatal(tr!("Serwer RDP nie odpowiedział na żądanie X.224", "The RDP server did not answer the X.224 request").to_string())),
    };

    match mode {
        TlsMode::Modern => {
            let connector = make_tls_connector().map_err(HandshakeError::Fatal)?;
            let server_name = rustls_pki_types::ServerName::try_from("rdp-server".to_string())
                .expect("static server name is valid");
            let stream = match timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, tcp)).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(HandshakeError::Tls(e.to_string())),
                Err(_) => return Err(HandshakeError::Tls("przekroczono limit czasu".to_string())),
            };
            let chain: Vec<Vec<u8>> = stream
                .get_ref()
                .1
                .peer_certificates()
                .unwrap_or(&[])
                .iter()
                .map(|cert| cert.as_ref().to_vec())
                .collect();
            Ok((Box::new(stream), x224_resp, chain))
        }
        TlsMode::Legacy => {
            // Certificate is not validated by the TLS stack (RDP servers use self-signed certs);
            // it is pinned by fingerprint right after the handshake, exactly like in modern mode.
            // The stack still verifies the handshake signature against the presented certificate.
            let connector = native_tls::TlsConnector::builder()
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true)
                .use_sni(false)
                .min_protocol_version(Some(native_tls::Protocol::Tlsv10))
                .build()
                .map_err(|e| HandshakeError::Fatal(tr!("Błąd konfiguracji TLS systemowego: {}", "System TLS configuration error: {}", e)))?;
            let connector = tokio_native_tls::TlsConnector::from(connector);
            let stream = match timeout(HANDSHAKE_TIMEOUT, connector.connect("rdp-server", tcp)).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return Err(HandshakeError::Tls(e.to_string())),
                Err(_) => return Err(HandshakeError::Tls("przekroczono limit czasu".to_string())),
            };
            let leaf = stream
                .get_ref()
                .peer_certificate()
                .ok()
                .flatten()
                .and_then(|c| c.to_der().ok())
                .ok_or_else(|| HandshakeError::Fatal(tr!("Serwer RDP nie przedstawił certyfikatu TLS", "The RDP server did not present a TLS certificate").to_string()))?;
            eprintln!("[RemoteFlow RDP Proxy] Połączono z {} w trybie zgodności TLS", target);
            Ok((Box::new(stream), x224_resp, vec![leaf]))
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Reads the presented identity without credentials or establishing trust.
pub async fn probe_certificate(host: &str, port: u16, jump: Option<crate::session::ssh::JumpHost>) -> Result<String, String> {
    const REQUEST: [u8; 19] = [3, 0, 0, 19, 14, 224, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0];
    let target = crate::session::host_port(host, port);
    let route = jump.map(|jump| RdpJump { jump, host: host.to_string(), port });
    let result = match rdp_handshake(&target, route.as_ref(), &REQUEST, TlsMode::Modern).await {
        Err(HandshakeError::Tls(_)) => rdp_handshake(&target, route.as_ref(), &REQUEST, TlsMode::Legacy).await,
        other => other,
    };
    match result {
        Ok((_stream, _, chain)) => chain.first().map(|cert| sha256_fingerprint(cert))
            .ok_or_else(|| tr!("Serwer RDP nie przedstawił certyfikatu TLS", "The RDP server did not present a TLS certificate").into()),
        Err(HandshakeError::Tls(e) | HandshakeError::Fatal(e)) => Err(e),
    }
}

async fn send_error_pdu<S>(ws_sink: &mut S, pdu: ironrdp_rdcleanpath::RDCleanPathPdu)
where
    S: SinkExt<Message> + Unpin,
{
    if let Ok(der) = pdu.to_der() {
        let _ = ws_sink.send(Message::Binary(der.into())).await;
    }
    let _ = ws_sink.close().await;
}

async fn handle_client(ws_tcp: TcpStream, ctx: ProxyContext) {
    // Screen updates are many small WebSocket frames – do not let Nagle delay them
    let _ = ws_tcp.set_nodelay(true);
    let ws = match timeout(HANDSHAKE_TIMEOUT, accept_hdr_async(ws_tcp, |req: &Request, mut resp: Response| {
        if let Some(proto) = req.headers().get("Sec-WebSocket-Protocol") {
            resp.headers_mut().insert("Sec-WebSocket-Protocol", proto.clone());
        }
        Ok(resp)
    }))
    .await
    {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            eprintln!("[RemoteFlow RDP Proxy] Błąd handshake WebSocket: {}", e);
            return;
        }
        Err(_) => return,
    };

    let (mut ws_sink, mut ws_stream) = ws.split();

    let first_msg = match timeout(HANDSHAKE_TIMEOUT, ws_stream.next()).await {
        Ok(Some(Ok(msg))) => msg,
        Ok(Some(Err(e))) => {
            eprintln!("[RemoteFlow RDP Proxy] Błąd odczytu pierwszej wiadomości WS: {}", e);
            return;
        }
        _ => return,
    };

    let first_bytes = match &first_msg {
        Message::Binary(bin) => bin.to_vec(),
        _ => {
            eprintln!("[RemoteFlow RDP Proxy] Pierwsza wiadomość nie zawiera danych binarnych");
            return;
        }
    };

    // Only the RDCleanPath protocol is supported (the former raw-TCP fallback was an open relay).
    let pdu = match ironrdp_rdcleanpath::RDCleanPathPdu::from_der(&first_bytes) {
        Ok(p) => p,
        Err(e) => {
            ctx.fail(tr!("Nieprawidłowe żądanie klienta RDP (RDCleanPath): {}", "Invalid RDP client request (RDCleanPath): {}", e));
            send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_http_error(400)).await;
            return;
        }
    };

    // 0. Authorise the local client with the per-session token.
    let token_ok = pdu
        .proxy_auth
        .as_deref()
        .map(|t| constant_time_eq(t.as_bytes(), ctx.token.as_bytes()))
        .unwrap_or(false);
    if !token_ok {
        eprintln!("[RemoteFlow RDP Proxy] Odrzucono klienta bez poprawnego tokenu sesji");
        send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_http_error(401)).await;
        return;
    }

    if let Some(dest) = &pdu.destination {
        if !dest.eq_ignore_ascii_case(&ctx.target) {
            eprintln!(
                "[RemoteFlow RDP Proxy] Klient żądał celu {}, używam skonfigurowanego {}",
                dest, ctx.target
            );
        }
    }

    let x224_req = match pdu.x224_connection_pdu {
        Some(octets) => octets.as_bytes().to_vec(),
        None => {
            ctx.fail(tr!("Żądanie RDCleanPath bez pakietu X.224", "RDCleanPath request without an X.224 packet").to_string());
            send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_http_error(400)).await;
            return;
        }
    };

    // 1-3. TCP + X.224 + TLS. Modern TLS (rustls) first; if the server rejects it (e.g. Windows
    //      Server 2012 offers no ECDHE-RSA-AES-GCM suite and resets the connection – os error
    //      10054), retry the whole sequence with the system TLS stack, which supports the older
    //      CBC suites / TLS 1.0-1.1 that such servers need.
    let (tls_stream, x224_resp, chain) = match rdp_handshake(&ctx.target, ctx.jump.as_ref(), &x224_req, TlsMode::Modern).await {
        Ok(r) => r,
        Err(HandshakeError::Tls(modern_err)) => {
            eprintln!(
                "[RemoteFlow RDP Proxy] TLS (rustls) odrzucony przez {}: {} – próba trybu zgodności (TLS systemowy)",
                ctx.target, modern_err
            );
            match rdp_handshake(&ctx.target, ctx.jump.as_ref(), &x224_req, TlsMode::Legacy).await {
                Ok(r) => r,
                Err(HandshakeError::Tls(legacy_err)) | Err(HandshakeError::Fatal(legacy_err)) => {
                    ctx.fail(format!(
                        "Nie udało się zestawić TLS z serwerem RDP {}.\n• tryb nowoczesny: {}\n• tryb zgodności: {}\n\
                         Serwer może obsługiwać tylko TLS 1.0 lub przestarzałe szyfry. Zainstaluj na serwerze \
                         aktualizacje włączające TLS 1.2 dla RDP albo użyj zewnętrznego klienta RDP.",
                        ctx.target, modern_err, legacy_err
                    ));
                    send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_general_error()).await;
                    return;
                }
            }
        }
        Err(HandshakeError::Fatal(e)) => {
            ctx.fail(e);
            send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_general_error()).await;
            return;
        }
    };

    // 4. Certificate pinning (TOFU) before any credentials flow through the tunnel.
    let Some(leaf) = chain.first() else {
        ctx.fail(tr!("Serwer RDP nie przedstawił certyfikatu TLS", "The RDP server did not present a TLS certificate").to_string());
        send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_general_error()).await;
        return;
    };
    let fingerprint = sha256_fingerprint(leaf);
    let verifier = ctx.verifier.clone();
    let verdict = tokio::task::spawn_blocking(move || (verifier.0)(&fingerprint))
        .await
        .unwrap_or_else(|e| Err(tr!("Błąd weryfikacji certyfikatu: {}", "Certificate verification error: {}", e)));
    if let Err(e) = verdict {
        ctx.fail(e);
        send_error_pdu(&mut ws_sink, ironrdp_rdcleanpath::RDCleanPathPdu::new_general_error()).await;
        return;
    }

    // 5. RDCleanPath response back to the WebAssembly client.
    let response_der =
        match ironrdp_rdcleanpath::RDCleanPathPdu::new_response(ctx.target.clone(), x224_resp, chain)
            .and_then(|p| p.to_der())
        {
            Ok(d) => d,
            Err(e) => {
                ctx.fail(tr!("Błąd budowania odpowiedzi RDCleanPath: {}", "Error building the RDCleanPath response: {}", e));
                return;
            }
        };

    if let Err(e) = ws_sink.send(Message::Binary(response_der.into())).await {
        eprintln!("[RemoteFlow RDP Proxy] Błąd wysyłania odpowiedzi RDCleanPath: {}", e);
        return;
    }

    // 6. Bridge TLS stream <-> WebSocket.
    let (mut tls_read, mut tls_write) = tokio::io::split(tls_stream);
    let (ws_out_tx, mut ws_out_rx) = tokio::sync::mpsc::channel::<Message>(512);

    let ws_writer = async {
        while let Some(msg) = ws_out_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
    };

    let ws_out_tx_pong = ws_out_tx.clone();
    let ws_to_tls = async {
        while let Some(msg_res) = ws_stream.next().await {
            match msg_res {
                Ok(Message::Binary(bin)) => {
                    if tls_write.write_all(&bin).await.is_err() || tls_write.flush().await.is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(p)) => {
                    let _ = ws_out_tx_pong.send(Message::Pong(p)).await;
                }
                Err(_) => break,
                _ => {}
            }
        }
        let _ = tls_write.shutdown().await;
    };

    let tls_to_ws = async {
        let mut buf = vec![0u8; 65536];
        loop {
            match tls_read.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if ws_out_tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    };

    tokio::select! {
        _ = ws_writer => {},
        _ = ws_to_tls => {},
        _ = tls_to_ws => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::known_hosts::HostTrust;

    #[tokio::test]
    async fn shutdown_closes_an_accepted_client_waiting_for_authentication() {
        let proxy = start_rdp_proxy("127.0.0.1".into(), 9, "secret".into(),
            HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))), Arc::new(|_| {}), None).unwrap();
        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{}", proxy.port)).await.unwrap();
        proxy.shutdown();
        let message = timeout(Duration::from_secs(2), client.next()).await.expect("accepted clients must stop too");
        assert!(!matches!(message, Some(Ok(Message::Binary(_)))));
    }

    fn ctx_for(port: u16) -> ProxyContext {
        ProxyContext {
            target: format!("127.0.0.1:{}", port),
            jump: None,
            token: Arc::new("t".to_string()),
            verifier: HostKeyVerifier(Arc::new(|_| Ok(HostTrust::Known))),
            report: Arc::new(|_| {}),
        }
    }

    const X224_CR: [u8; 11] = [0x03, 0, 0, 0x0b, 0x06, 0xe0, 0, 0, 0, 0, 0];

    async fn roundtrip(stream: Box<dyn IoStream>) -> Vec<u8> {
        let (mut r, mut w) = tokio::io::split(stream);
        w.write_all(b"ping").await.unwrap();
        w.flush().await.unwrap();
        let mut buf = vec![0u8; 64];
        let n = r.read(&mut buf).await.unwrap();
        buf.truncate(n);
        buf
    }

    /// Requires the helper TLS servers from /tmp/rdptest (ignored by default).
    #[tokio::test]
    #[ignore]
    async fn legacy_server_needs_fallback() {
        // Server with only ECDHE-RSA-AES-CBC (like Windows Server 2012): rustls must fail ...
        let ctx = ctx_for(33891);
        assert!(matches!(rdp_handshake(&ctx.target, None, &X224_CR, TlsMode::Modern).await, Err(HandshakeError::Tls(_))));
        // ... and the system TLS fallback must succeed.
        let (stream, x224, chain) = rdp_handshake(&ctx.target, None, &X224_CR, TlsMode::Legacy).await.ok().expect("legacy ok");
        assert_eq!(x224.len(), 19);
        assert_eq!(chain.len(), 1);
        assert_eq!(roundtrip(stream).await, b"ECHO:ping");
    }

    #[tokio::test]
    #[ignore]
    async fn modern_server_uses_rustls() {
        let ctx = ctx_for(33892);
        let (stream, _, chain) = rdp_handshake(&ctx.target, None, &X224_CR, TlsMode::Modern).await.ok().expect("modern ok");
        assert!(!chain.is_empty());
        assert_eq!(roundtrip(stream).await, b"ECHO:ping");
    }
}
