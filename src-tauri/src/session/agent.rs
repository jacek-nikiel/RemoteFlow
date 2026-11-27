//! SSH agent: FIDO2 / U2F security keys (`sk-ssh-ed25519@openssh.com`,
//! `sk-ecdsa-sha2-nistp256@openssh.com`, e.g. YubiKey) held by the OpenSSH agent.
//!
//! libssh2 logs in with agent keys itself, but for security keys it keeps only the signature
//! and drops the flags and counter that follow it, so the server refuses the login. Those keys
//! are therefore signed here: the agent is asked directly (Unix socket `SSH_AUTH_SOCK`, Windows
//! named pipe of the OpenSSH agent) and the complete signature goes to libssh2 through its
//! signing-callback login. The agent (or the system, on Windows) asks for the touch / PIN.

use std::cell::RefCell;
use std::ffi::{c_int, c_uchar, c_void};
use std::io::{Read, Write};
use std::sync::Arc;

const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const SIGN_RESPONSE: u8 = 14;
const MAX_REPLY: usize = 256 * 1024;

pub type Notice = Arc<dyn Fn(String) + Send + Sync>;

thread_local! {
    /// Where "touch your security key" is shown (the terminal of the connecting tab).
    static NOTICE: RefCell<Option<Notice>> = const { RefCell::new(None) };
}

/// Sets the notice target for SSH logins made on this thread.
pub fn set_notice(notice: Option<Notice>) {
    NOTICE.with(|n| *n.borrow_mut() = notice);
}

fn notify(text: String) {
    NOTICE.with(|n| {
        if let Some(f) = n.borrow().as_ref() {
            f(text);
        }
    });
}

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

pub struct Agent {
    stream: Box<dyn Stream>,
}

fn read_string<'a>(buf: &mut &'a [u8]) -> Option<&'a [u8]> {
    if buf.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + len {
        return None;
    }
    let s = &buf[4..4 + len];
    *buf = &buf[4 + len..];
    Some(s)
}

fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

/// Key type of a public key blob ("ssh-ed25519", "sk-ssh-ed25519@openssh.com", …).
pub fn key_type(blob: &[u8]) -> Option<String> {
    let mut b = blob;
    read_string(&mut b).map(|t| String::from_utf8_lossy(t).into_owned())
}

pub fn is_security_key(blob: &[u8]) -> bool {
    key_type(blob).is_some_and(|t| t.starts_with("sk-"))
}

impl Agent {
    /// The OpenSSH agent of this user, if one is running.
    pub fn connect() -> Option<Agent> {
        #[cfg(unix)]
        {
            let path = std::env::var_os("SSH_AUTH_SOCK")?;
            let s = std::os::unix::net::UnixStream::connect(path).ok()?;
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(120)));
            Some(Agent { stream: Box::new(s) })
        }
        #[cfg(windows)]
        {
            let path = std::env::var("SSH_AUTH_SOCK")
                .ok()
                .filter(|p| p.starts_with(r"\\.\pipe\"))
                .unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".to_string());
            let f = std::fs::OpenOptions::new().read(true).write(true).open(path).ok()?;
            Some(Agent { stream: Box::new(f) })
        }
        #[cfg(not(any(unix, windows)))]
        {
            None
        }
    }

    fn request(&mut self, msg: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut frame = Vec::with_capacity(msg.len() + 4);
        put_string(&mut frame, msg);
        self.stream.write_all(&frame)?;
        self.stream.flush()?;
        let mut len = [0u8; 4];
        self.stream.read_exact(&mut len)?;
        let len = u32::from_be_bytes(len) as usize;
        if len == 0 || len > MAX_REPLY {
            return Err(std::io::Error::other("agent reply too large"));
        }
        let mut reply = vec![0u8; len];
        self.stream.read_exact(&mut reply)?;
        Ok(reply)
    }

    /// Public key blobs and comments.
    pub fn identities(&mut self) -> std::io::Result<Vec<(Vec<u8>, String)>> {
        let reply = self.request(&[REQUEST_IDENTITIES])?;
        if reply.first() != Some(&IDENTITIES_ANSWER) || reply.len() < 5 {
            return Err(std::io::Error::other("agent: unexpected answer"));
        }
        let count = u32::from_be_bytes([reply[1], reply[2], reply[3], reply[4]]) as usize;
        let mut rest = &reply[5..];
        let mut out = Vec::new();
        for _ in 0..count.min(1000) {
            let (Some(blob), Some(comment)) = (read_string(&mut rest), read_string(&mut rest)) else { break };
            out.push((blob.to_vec(), String::from_utf8_lossy(comment).into_owned()));
        }
        Ok(out)
    }

    /// The agent's signature blob: string type, then the type-specific data.
    pub fn sign(&mut self, blob: &[u8], data: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut msg = vec![SIGN_REQUEST];
        put_string(&mut msg, blob);
        put_string(&mut msg, data);
        msg.extend_from_slice(&0u32.to_be_bytes());
        let reply = self.request(&msg)?;
        if reply.first() != Some(&SIGN_RESPONSE) {
            // SSH_AGENT_FAILURE: not touched in time, wrong PIN, key removed …
            return Err(std::io::Error::other("agent refused to sign"));
        }
        let mut rest = &reply[1..];
        read_string(&mut rest).map(<[u8]>::to_vec).ok_or_else(|| std::io::Error::other("agent: bad signature"))
    }
}

struct SignContext<'a> {
    agent: &'a mut Agent,
    blob: &'a [u8],
    failed: bool,
}

unsafe extern "C" {
    fn libssh2_userauth_publickey(
        session: *mut libssh2_sys::LIBSSH2_SESSION,
        username: *const std::ffi::c_char,
        pubkeydata: *const c_uchar,
        pubkeydata_len: usize,
        sign_callback: Option<
            unsafe extern "C" fn(*mut libssh2_sys::LIBSSH2_SESSION, *mut *mut c_uchar, *mut usize, *const c_uchar, usize, *mut *mut c_void) -> c_int,
        >,
        abstract_: *mut *mut c_void,
    ) -> c_int;
    fn malloc(size: usize) -> *mut c_void;
}

/// For security keys libssh2 writes `string(type)` itself and then exactly these bytes:
/// `string(signature) byte(flags) uint32(counter)` – everything after the type.
unsafe extern "C" fn sk_sign_callback(
    _session: *mut libssh2_sys::LIBSSH2_SESSION,
    sig: *mut *mut c_uchar,
    sig_len: *mut usize,
    data: *const c_uchar,
    data_len: usize,
    abstract_: *mut *mut c_void,
) -> c_int {
    // SAFETY: `abstract_` points to the live `SignContext` given to `libssh2_userauth_publickey`
    // for the duration of that call; data/out pointers are valid as documented by libssh2.
    unsafe {
        if abstract_.is_null() || (*abstract_).is_null() || data.is_null() {
            return -1;
        }
        let ctx = &mut *((*abstract_) as *mut SignContext);
        let message = std::slice::from_raw_parts(data, data_len);
        let Ok(full) = ctx.agent.sign(ctx.blob, message) else {
            ctx.failed = true;
            return -1;
        };
        let mut rest = full.as_slice();
        if read_string(&mut rest).is_none() || rest.is_empty() {
            ctx.failed = true;
            return -1;
        }
        let buf = malloc(rest.len()) as *mut c_uchar;
        if buf.is_null() {
            return -1;
        }
        std::ptr::copy_nonoverlapping(rest.as_ptr(), buf, rest.len());
        *sig = buf;
        *sig_len = rest.len();
        0
    }
}

/// Agent login. Ordinary keys go through libssh2's agent support (also Pageant); security
/// keys are signed here (see the module comment). Ok(true) = logged in.
pub fn authenticate(sess: &ssh2::Session, username: &str) -> Result<bool, String> {
    // 1. Ordinary agent keys, without touching the security keys (each attempt would ask for a touch)
    if let Ok(mut agent) = sess.agent() {
        if agent.connect().is_ok() && agent.list_identities().is_ok() {
            for id in agent.identities().unwrap_or_default() {
                if is_security_key(id.blob()) {
                    continue;
                }
                if agent.userauth(username, &id).is_ok() && sess.authenticated() {
                    let _ = agent.disconnect();
                    return Ok(true);
                }
            }
            let _ = agent.disconnect();
        }
    }
    // 2. Security keys from the OpenSSH agent
    let Some(mut agent) = Agent::connect() else { return Ok(false) };
    let keys = agent.identities().map_err(|e| e.to_string())?;
    let user = std::ffi::CString::new(username).map_err(|e| e.to_string())?;
    let mut refused = false;
    for (blob, comment) in keys.iter().filter(|(b, _)| is_security_key(b)) {
        notify(tr!(
            "\r\n\x1b[1;33m🔑 Dotknij klucza bezpieczeństwa ({})…\x1b[0m\r\n",
            "\r\n\x1b[1;33m🔑 Touch your security key ({})…\x1b[0m\r\n",
            if comment.is_empty() { key_type(blob).unwrap_or_default() } else { comment.clone() }
        ));
        let mut ctx = SignContext { agent: &mut agent, blob, failed: false };
        let mut ctx_ptr = &mut ctx as *mut SignContext as *mut c_void;
        let mut raw = sess.raw();
        // SAFETY: valid session, NUL-terminated user name, blob and a context that outlives the call.
        let rc = unsafe {
            libssh2_userauth_publickey(&mut *raw, user.as_ptr(), blob.as_ptr(), blob.len(), Some(sk_sign_callback), &mut ctx_ptr)
        };
        drop(raw);
        if rc == 0 && sess.authenticated() {
            return Ok(true);
        }
        refused |= ctx.failed;
    }
    if refused {
        return Err(tr!(
            "Klucz bezpieczeństwa (FIDO2) nie podpisał logowania – nie dotknięto go w czasie, podano zły PIN albo agent go odrzucił.",
            "The security key (FIDO2) did not sign the login – it was not touched in time, the PIN was wrong or the agent refused."
        )
        .to_string());
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_types() {
        let mut blob = Vec::new();
        put_string(&mut blob, b"sk-ssh-ed25519@openssh.com");
        put_string(&mut blob, &[1u8; 32]);
        assert!(is_security_key(&blob));
        let mut plain = Vec::new();
        put_string(&mut plain, b"ssh-ed25519");
        assert!(!is_security_key(&plain));
        assert!(!is_security_key(&[0, 0]));
    }
}
