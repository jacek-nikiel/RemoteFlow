//! Reading connections from other programs: OpenSSH (`~/.ssh/config`), PuTTY (saved sessions)
//! and WinSCP (saved sites). Only parsing lives here – it works on text, so it is tested on every
//! platform; reading the Windows registry (`reg export`) and saving into the vault are in
//! `auth::import_sources`.

use crate::vault::models::PortForwardRule;
use serde::Serialize;
use std::collections::HashMap;
use zeroize::Zeroizing;

/// A connection found in another program, before it is imported.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    /// Unique within one scan.
    pub key: String,
    pub name: String,
    /// Folder path inside the source (WinSCP); empty = top level.
    pub folder: Vec<String>,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_file: Option<String>,
    /// `key` of the candidate used as the jump host.
    pub jump: Option<String>,
    pub forwards: Vec<PortForwardRule>,
    pub has_password: bool,
    /// What could not be taken over (shown in the list).
    pub notes: Vec<String>,
    /// Same protocol, host, port and user as a saved connection (filled in by the scan).
    pub exists: bool,
    /// Added only as somebody's jump host (not a session of its own in the source).
    pub implicit: bool,
    #[serde(skip)]
    pub password: Option<Zeroizing<String>>,
}

impl ImportCandidate {
    fn new(key: String, name: String, host: String, port: u16, username: String) -> Self {
        ImportCandidate {
            key,
            name,
            folder: Vec::new(),
            protocol: "ssh".into(),
            host,
            port,
            username,
            key_file: None,
            jump: None,
            forwards: Vec::new(),
            has_password: false,
            notes: Vec::new(),
            exists: false,
            implicit: false,
            password: None,
        }
    }
}

fn rule(kind: &str, local_port: u16, remote: Option<(String, u16)>) -> PortForwardRule {
    PortForwardRule {
        id: format!("pf-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
        forward_type: kind.into(),
        local_port,
        remote_host: remote.as_ref().map(|r| r.0.clone()),
        remote_port: remote.map(|r| r.1),
        enabled: true,
    }
}

/// "8080", "127.0.0.1:8080", "[::1]:8080" → 8080
fn last_port(s: &str) -> Option<u16> {
    s.rsplit(':').next()?.trim().parse().ok()
}

/// "db:5432", "[fe80::1]:22" → ("db", 5432)
fn host_port(s: &str) -> Option<(String, u16)> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        let (h, p) = rest.split_once("]:")?;
        return Some((h.to_string(), p.parse().ok()?));
    }
    let (h, p) = s.rsplit_once(':')?;
    Some((h.to_string(), p.parse().ok()?))
}

/// "user@host:port" (port optional) → (user, host, port)
fn user_host_port(s: &str, default_port: u16) -> (String, String, u16) {
    let (user, rest) = match s.rsplit_once('@') {
        Some((u, r)) => (u.to_string(), r),
        None => (String::new(), s),
    };
    if let Some(inner) = rest.strip_prefix('[') {
        if let Some((h, p)) = inner.split_once(']') {
            let port = p.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(default_port);
            return (user, h.to_string(), port);
        }
    }
    match rest.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => (user, h.to_string(), p.parse().unwrap_or(default_port)),
        _ => (user, rest.to_string(), default_port),
    }
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 {
            if let (Some(a), Some(b)) = (
                bytes.get(i + 1).and_then(|c| (*c as char).to_digit(16)),
                bytes.get(i + 2).and_then(|c| (*c as char).to_digit(16)),
            ) {
                out.push((a * 16 + b) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// =================================================================================================
// OpenSSH client configuration
// =================================================================================================

pub mod ssh_config {
    use super::*;

    struct Block {
        patterns: Vec<String>,
        /// Lower-case keyword → values (each line's arguments).
        options: Vec<(String, Vec<String>)>,
    }

    /// Splits a line into keyword and arguments ("Key value", "Key=value", quoted arguments).
    fn split_line(line: &str) -> Option<(String, Vec<String>)> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (kw, rest) = match line.find(|c: char| c.is_whitespace() || c == '=') {
            Some(i) => (&line[..i], line[i..].trim_start_matches(|c: char| c.is_whitespace()).trim_start_matches('=').trim()),
            None => (line, ""),
        };
        let mut args = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        let mut any = false;
        for c in rest.chars() {
            match c {
                '"' => {
                    quoted = !quoted;
                    any = true;
                }
                c if c.is_whitespace() && !quoted => {
                    if any || !cur.is_empty() {
                        args.push(std::mem::take(&mut cur));
                        any = false;
                    }
                }
                c => cur.push(c),
            }
        }
        if any || !cur.is_empty() {
            args.push(cur);
        }
        Some((kw.to_ascii_lowercase(), args))
    }

    /// Glob match with `*` and `?` (case-insensitive, as OpenSSH does for host names). Linear
    /// backtracking (only the last `*` is retried), so no pattern can make it slow.
    fn glob(pattern: &str, text: &str) -> bool {
        let p: Vec<char> = pattern.to_lowercase().chars().collect();
        let t: Vec<char> = text.to_lowercase().chars().collect();
        let (mut pi, mut ti) = (0usize, 0usize);
        let mut star: Option<(usize, usize)> = None;
        while ti < t.len() {
            if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
                pi += 1;
                ti += 1;
            } else if pi < p.len() && p[pi] == '*' {
                star = Some((pi, ti));
                pi += 1;
            } else if let Some((sp, st)) = star {
                pi = sp + 1;
                ti = st + 1;
                star = Some((sp, st + 1));
            } else {
                return false;
            }
        }
        while pi < p.len() && p[pi] == '*' {
            pi += 1;
        }
        pi == p.len()
    }

    fn block_matches(patterns: &[String], host: &str) -> bool {
        let mut matched = false;
        for p in patterns {
            if let Some(neg) = p.strip_prefix('!') {
                if glob(neg, host) {
                    return false;
                }
            } else if glob(p, host) {
                matched = true;
            }
        }
        matched
    }

    /// Reads the file and its `Include`s. `load(path)` returns the text of a file (or None) and
    /// `expand(pattern)` the files a (possibly wildcard) path stands for.
    fn collect(
        text: &str,
        blocks: &mut Vec<Block>,
        load: &dyn Fn(&str) -> Option<String>,
        expand: &dyn Fn(&str) -> Vec<String>,
        depth: u32,
        in_match: &mut bool,
        budget: &mut u32,
    ) {
        for line in text.lines() {
            let Some((kw, args)) = split_line(line) else { continue };
            match kw.as_str() {
                "host" => {
                    *in_match = false;
                    blocks.push(Block { patterns: args, options: Vec::new() });
                }
                "match" => {
                    // Conditions (exec, user, …) cannot be evaluated here – its options are skipped
                    *in_match = true;
                }
                "include" if depth < 8 => {
                    for pattern in &args {
                        for file in expand(pattern) {
                            // At most 256 included files in all (a file including itself through
                            // a wildcard would otherwise multiply at every level)
                            if *budget == 0 {
                                return;
                            }
                            *budget -= 1;
                            if let Some(inner) = load(&file) {
                                collect(&inner, blocks, load, expand, depth + 1, in_match, budget);
                            }
                        }
                    }
                }
                _ if *in_match => {}
                _ => match blocks.last_mut() {
                    Some(b) => b.options.push((kw, args)),
                    // Before the first Host: applies to every host
                    None => blocks.push(Block { patterns: vec!["*".into()], options: vec![(kw, args)] }),
                },
            }
        }
    }

    pub struct Env<'a> {
        pub home: &'a str,
        pub local_user: &'a str,
        pub load: &'a dyn Fn(&str) -> Option<String>,
        pub expand: &'a dyn Fn(&str) -> Vec<String>,
    }

    fn expand_tokens(value: &str, env: &Env, alias: &str, host: &str, user: &str, port: u16) -> String {
        let mut v = value.to_string();
        if let Some(rest) = v.strip_prefix("~/") {
            v = format!("{}/{}", env.home.trim_end_matches(['/', '\\']), rest);
        }
        v.replace("%d", env.home)
            .replace("%u", env.local_user)
            .replace("%h", host)
            .replace("%n", alias)
            .replace("%r", user)
            .replace("%p", &port.to_string())
            .replace("%%", "%")
    }

    pub fn parse(text: &str, env: &Env) -> (Vec<ImportCandidate>, Vec<String>) {
        let mut blocks = Vec::new();
        let mut in_match = false;
        collect(text, &mut blocks, env.load, env.expand, 0, &mut in_match, &mut 256);
        let mut warnings = Vec::new();

        // Concrete aliases (no wildcards, not negated), in file order
        let mut aliases: Vec<String> = Vec::new();
        for b in &blocks {
            for p in &b.patterns {
                if !p.contains(['*', '?']) && !p.starts_with('!') && !aliases.iter().any(|a| a.eq_ignore_ascii_case(p)) {
                    aliases.push(p.clone());
                }
            }
        }

        let mut out: Vec<ImportCandidate> = Vec::new();
        let mut extra_jumps: Vec<ImportCandidate> = Vec::new();
        for alias in &aliases {
            // First value of each keyword wins; LocalForward & co. accumulate
            let mut first: HashMap<String, Vec<String>> = HashMap::new();
            let mut forwards: Vec<(String, Vec<String>)> = Vec::new();
            for b in blocks.iter().filter(|b| block_matches(&b.patterns, alias)) {
                for (kw, args) in &b.options {
                    if matches!(kw.as_str(), "localforward" | "remoteforward" | "dynamicforward") {
                        forwards.push((kw.clone(), args.clone()));
                    } else {
                        first.entry(kw.clone()).or_insert_with(|| args.clone());
                    }
                }
            }
            let get = |k: &str| first.get(k).and_then(|v| v.first()).cloned();
            let host_raw = get("hostname").unwrap_or_else(|| alias.clone());
            let host = host_raw.replace("%h", alias).replace("%%", "%");
            let port = get("port").and_then(|p| p.parse().ok()).unwrap_or(22);
            let user = get("user").unwrap_or_default();
            let mut c = ImportCandidate::new(format!("ssh:{alias}"), alias.clone(), host.clone(), port, user.clone());
            if let Some(id) = get("identityfile") {
                c.key_file = Some(expand_tokens(&id, env, alias, &host, &user, port));
            }
            for (kw, args) in forwards {
                let r = match (kw.as_str(), args.as_slice()) {
                    ("localforward", [l, r, ..]) => last_port(l).zip(host_port(r)).map(|(p, t)| rule("local", p, Some(t))),
                    ("remoteforward", [l, r, ..]) => last_port(l).zip(host_port(r)).map(|(p, t)| rule("remote", p, Some(t))),
                    ("dynamicforward", [l, ..]) => last_port(l).map(|p| rule("dynamic", p, None)),
                    _ => None,
                };
                match r {
                    Some(r) => c.forwards.push(r),
                    None => c.notes.push(format!("{} {}", kw, args.join(" "))),
                }
            }
            // ProxyJump a,b: through a, then b, then this host
            let jump_spec = get("proxyjump").filter(|v| !v.eq_ignore_ascii_case("none")).or_else(|| {
                // ProxyCommand ssh -W %h:%p bastion → the same as ProxyJump bastion
                let cmd = first.get("proxycommand")?.join(" ");
                if cmd.eq_ignore_ascii_case("none") {
                    return None;
                }
                let words: Vec<&str> = cmd.split_whitespace().collect();
                if words.first().is_some_and(|w| w.ends_with("ssh") || w.ends_with("ssh.exe")) && words.contains(&"-W") {
                    words.last().map(|s| s.to_string())
                } else {
                    c.notes.push(format!("ProxyCommand {cmd}"));
                    None
                }
            });
            if let Some(spec) = jump_spec {
                let mut prev: Option<String> = None;
                for hop in spec.split(',').map(str::trim).filter(|h| !h.is_empty()) {
                    let key = if let Some(a) = aliases.iter().find(|a| a.eq_ignore_ascii_case(hop)) {
                        format!("ssh:{a}")
                    } else {
                        let (u, h, p) = user_host_port(hop, 22);
                        let key = format!("jump:{}@{}:{}", u, h, p);
                        if !extra_jumps.iter().any(|j| j.key == key) {
                            let mut j = ImportCandidate::new(key.clone(), h.clone(), h, p, u);
                            j.implicit = true;
                            extra_jumps.push(j);
                        }
                        key
                    };
                    if let Some(p) = &prev {
                        // A later hop goes through the previous one (unless it has its own route)
                        if let Some(j) = extra_jumps.iter_mut().find(|j| j.key == key) {
                            j.jump.get_or_insert_with(|| p.clone());
                        } else {
                            // A saved Host of its own – its route is not changed for everybody
                            c.notes.push(format!("ProxyJump {spec}"));
                        }
                    }
                    prev = Some(key);
                }
                c.jump = prev;
            }
            for (kw, label) in [("certificatefile", "CertificateFile"), ("localcommand", "LocalCommand"), ("remotecommand", "RemoteCommand")] {
                if first.contains_key(kw) {
                    c.notes.push(label.to_string());
                }
            }
            out.push(c);
        }
        if blocks.iter().any(|b| b.patterns.iter().all(|p| p.contains(['*', '?']))) && aliases.is_empty() {
            warnings.push("only wildcard Host entries".into());
        }
        out.extend(extra_jumps);
        (out, warnings)
    }
}

// =================================================================================================
// Windows registry export (.reg, as written by `reg export`) and key=value files
// =================================================================================================

/// Sections of a .reg file: key path → (value name → value). Strings and dwords only.
pub fn parse_reg(text: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut out: Vec<(String, HashMap<String, String>)> = Vec::new();
    let mut pending = String::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        // Long hex values continue on the next line after a backslash
        if let Some(cont) = line.strip_suffix('\\') {
            pending.push_str(cont.trim());
            continue;
        }
        let line = if pending.is_empty() { line.trim().to_string() } else { std::mem::take(&mut pending) + line.trim() };
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            out.push((section.to_string(), HashMap::new()));
            continue;
        }
        let Some(rest) = line.strip_prefix('"') else { continue };
        let mut name = String::new();
        let mut chars = rest.chars();
        let mut closed = false;
        while let Some(c) = chars.next() {
            match c {
                '\\' => {
                    if let Some(n) = chars.next() {
                        name.push(n);
                    }
                }
                '"' => {
                    closed = true;
                    break;
                }
                c => name.push(c),
            }
        }
        if !closed {
            continue;
        }
        let value_part: String = chars.collect();
        let Some(value) = value_part.strip_prefix('=') else { continue };
        let parsed = if let Some(s) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
            let mut v = String::new();
            let mut it = s.chars();
            while let Some(c) = it.next() {
                if c == '\\' {
                    if let Some(n) = it.next() {
                        v.push(n);
                    }
                } else {
                    v.push(c);
                }
            }
            Some(v)
        } else if let Some(hex) = value.strip_prefix("dword:") {
            u32::from_str_radix(hex.trim(), 16).ok().map(|n| n.to_string())
        } else {
            None
        };
        if let (Some(v), Some((_, map))) = (parsed, out.last_mut()) {
            map.insert(name, v);
        }
    }
    out
}

/// `[Section]` + `key=value` (WinSCP.ini).
pub fn parse_ini(text: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut out: Vec<(String, HashMap<String, String>)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(section) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            out.push((section.to_string(), HashMap::new()));
        } else if let (Some((k, v)), Some((_, map))) = (line.split_once('='), out.last_mut()) {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    out
}

/// .reg files written by `reg export` are UTF-16 LE with a BOM.
pub fn decode_reg_bytes(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).trim_start_matches('\u{feff}').to_string()
    }
}

// =================================================================================================
// PuTTY
// =================================================================================================

pub mod putty {
    use super::*;

    /// "L8080=localhost:80,4D1080,R2222=127.0.0.1:22"
    pub fn forwards(spec: &str) -> Vec<PortForwardRule> {
        let mut out = Vec::new();
        for item in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let item = item.trim_start_matches(['4', '6']);
            let (kind, rest) = item.split_at(1.min(item.len()));
            let r = match kind {
                "L" | "R" => rest.split_once('=').and_then(|(src, dst)| last_port(src).zip(host_port(dst))).map(|(p, t)| {
                    rule(if kind == "L" { "local" } else { "remote" }, p, Some(t))
                }),
                "D" => last_port(rest.trim_end_matches('=')).map(|p| rule("dynamic", p, None)),
                _ => None,
            };
            out.extend(r);
        }
        out
    }

    /// One saved session (`name` already decoded).
    pub fn candidate(name: &str, v: &HashMap<String, String>) -> Option<ImportCandidate> {
        if name == "Default Settings" {
            return None;
        }
        let protocol = v.get("Protocol").map(String::as_str).unwrap_or("ssh");
        if protocol != "ssh" {
            return None;
        }
        let host_raw = v.get("HostName").map(|s| s.trim().to_string()).filter(|s| !s.is_empty())?;
        let port = v.get("PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22);
        let (u, host, port) = user_host_port(&host_raw, port);
        let user = v.get("UserName").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or(u);
        let mut c = ImportCandidate::new(format!("putty:{name}"), name.to_string(), host, port, user);
        c.key_file = v.get("PublicKeyFile").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(spec) = v.get("PortForwardings") {
            c.forwards = forwards(spec);
        }
        if v.get("ProxyMethod").is_some_and(|m| m != "0") {
            c.notes.push("Proxy".into());
        }
        Some(c)
    }

    /// Sessions from `reg export HKCU\Software\SimonTatham\PuTTY\Sessions`.
    pub fn from_reg(text: &str) -> Vec<ImportCandidate> {
        parse_reg(text)
            .into_iter()
            .filter_map(|(section, values)| {
                let (_, name) = section.rsplit_once("\\Sessions\\")?;
                candidate(&percent_decode(name), &values)
            })
            .collect()
    }

    /// One file of `~/.putty/sessions` (PuTTY on Linux / macOS).
    pub fn from_session_file(file_name: &str, text: &str) -> Option<ImportCandidate> {
        let values: HashMap<String, String> = text
            .lines()
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .collect();
        candidate(&percent_decode(file_name), &values)
    }
}

// =================================================================================================
// WinSCP
// =================================================================================================

pub mod winscp {
    use super::*;

    const MAGIC: u8 = 0xA3;
    const FLAG: u8 = 0xFF;

    /// WinSCP's stored-password obfuscation (not encryption – reversible without a key; with a
    /// WinSCP master password set they are encrypted and cannot be read). `key` = user + host.
    pub fn decrypt_password(hex: &str, key: &str) -> Option<Zeroizing<String>> {
        let nibbles: Vec<u8> = hex.chars().map(|c| c.to_digit(16).map(|d| d as u8)).collect::<Option<_>>()?;
        let mut pos = 0usize;
        let mut next = || -> Option<u8> {
            let (a, b) = (*nibbles.get(pos)?, *nibbles.get(pos + 1)?);
            pos += 2;
            Some(!(((a << 4) | b) ^ MAGIC))
        };
        let flag = next()?;
        let length = if flag == FLAG {
            next()?;
            next()?
        } else {
            flag
        };
        let skip = next()? as usize;
        for _ in 0..skip {
            next()?;
        }
        let mut bytes = Zeroizing::new(Vec::with_capacity(length as usize));
        for _ in 0..length {
            bytes.push(next()?);
        }
        let text = Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned());
        if flag == FLAG {
            text.strip_prefix(key).map(|p| Zeroizing::new(p.to_string()))
        } else {
            Some(text)
        }
    }

    fn is_ssh(v: &HashMap<String, String>) -> bool {
        // FSProtocol: 0 SCP, 1 SFTP with SCP fallback, 2 SFTP (default); 5+ FTP, WebDAV, S3
        v.get("FSProtocol").map(|p| matches!(p.as_str(), "0" | "1" | "2")).unwrap_or(true)
    }

    fn get(v: &HashMap<String, String>, k: &str) -> Option<String> {
        v.get(k).map(|s| percent_decode(s).trim().to_string()).filter(|s| !s.is_empty())
    }

    /// Sites from WinSCP.ini or `reg export HKCU\Software\Martin Prikryl\WinSCP 2`.
    pub fn from_sections(sections: Vec<(String, HashMap<String, String>)>) -> (Vec<ImportCandidate>, Vec<String>) {
        let master = sections
            .iter()
            .any(|(s, v)| s.ends_with("Configuration\\Security") && v.get("UseMasterPassword").is_some_and(|x| x == "1"));
        let mut warnings = Vec::new();
        if master {
            warnings.push("master-password".into());
        }
        let mut out: Vec<ImportCandidate> = Vec::new();
        let mut tunnels: Vec<ImportCandidate> = Vec::new();
        for (section, v) in &sections {
            let Some(name) = section.rsplit_once("Sessions\\").map(|(_, n)| percent_decode(n)) else { continue };
            if name == "Default Settings" || !is_ssh(v) {
                continue;
            }
            let Some(host) = get(v, "HostName") else { continue };
            let port = get(v, "PortNumber").and_then(|p| p.parse().ok()).unwrap_or(22);
            let user = get(v, "UserName").unwrap_or_default();
            let mut parts: Vec<String> = name.split('/').map(str::to_string).filter(|s| !s.is_empty()).collect();
            let site = parts.pop().unwrap_or_else(|| host.clone());
            let mut c = ImportCandidate::new(format!("winscp:{name}"), site, host.clone(), port, user.clone());
            c.folder = parts;
            c.key_file = get(v, "PublicKeyFile");
            if !master {
                if let Some(pw) = v.get("Password").filter(|p| !p.is_empty()) {
                    match decrypt_password(pw, &format!("{user}{host}")) {
                        Some(p) => {
                            c.has_password = !p.is_empty();
                            c.password = Some(p);
                        }
                        None => c.notes.push("password".into()),
                    }
                }
            }
            // SSH tunnel = jump host
            if v.get("Tunnel").is_some_and(|t| t == "1") {
                if let Some(th) = get(v, "TunnelHostName") {
                    let tp = get(v, "TunnelPortNumber").and_then(|p| p.parse().ok()).unwrap_or(22);
                    let tu = get(v, "TunnelUserName").unwrap_or_default();
                    let key = format!("jump:{tu}@{th}:{tp}");
                    if !tunnels.iter().any(|t| t.key == key) {
                        let mut t = ImportCandidate::new(key.clone(), th.clone(), th.clone(), tp, tu.clone());
                        t.implicit = true;
                        t.folder = c.folder.clone();
                        t.key_file = get(v, "TunnelPublicKeyFile");
                        if !master {
                            if let Some(pw) = v.get("TunnelPassword").filter(|p| !p.is_empty()) {
                                if let Some(p) = decrypt_password(pw, &format!("{tu}{th}")) {
                                    t.has_password = !p.is_empty();
                                    t.password = Some(p);
                                }
                            }
                        }
                        tunnels.push(t);
                    }
                    c.jump = Some(key);
                }
            }
            out.push(c);
        }
        out.extend(tunnels);
        (out, warnings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_include_loop_is_bounded() {
        // "Include *" matching the file itself: without a budget 3 files would multiply at every level
        let loads = std::cell::Cell::new(0u32);
        let load = |_: &str| -> Option<String> {
            loads.set(loads.get() + 1);
            Some("Include *\nHost h\n  HostName x\n".into())
        };
        let expand = |_: &str| vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let env = ssh_config::Env { home: "/home/u", local_user: "u", load: &load, expand: &expand };
        let (c, _) = ssh_config::parse("Include *\n", &env);
        assert!(loads.get() <= 256, "{}", loads.get());
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn ssh_config_glob_is_fast() {
        let t0 = std::time::Instant::now();
        let text = format!("Host *a*a*a*a*a*a*a*a*a*a*a*b\n  User x\nHost {}\n  HostName y\n", "a".repeat(60));
        let load = |_: &str| -> Option<String> { None };
        let expand = |_: &str| Vec::new();
        let env = ssh_config::Env { home: "/home/u", local_user: "u", load: &load, expand: &expand };
        let (c, _) = ssh_config::parse(&text, &env);
        assert_eq!(c.len(), 1);
        assert_ne!(c[0].username, "x"); // the pattern needs a final "b"
        assert!(t0.elapsed() < std::time::Duration::from_secs(1));
    }

    #[test]
    fn ssh_config_parsing() {
        let main = r#"
# global
User deploy
Include conf.d/*

Host web1 web2
    HostName %h.example.com
    Port 2222
    IdentityFile ~/.ssh/id_web
    LocalForward 127.0.0.1:8080 localhost:80
    DynamicForward 1080

Host db
    HostName 10.0.0.5
    User postgres
    ProxyJump bastion

Host bastion
    HostName bastion.example.com
    User jump

Host far
    HostName 10.9.9.9
    ProxyJump admin@gw.example.com:2200,bastion

Host *.internal !skip.internal
    User internal

Host old
    HostName 10.1.1.1
    ProxyCommand ssh -W %h:%p bastion

Match exec "true"
    User ignored
"#;
        let load = |p: &str| -> Option<String> {
            (p == "/home/u/.ssh/conf.d/extra").then(|| "Host extra\n  HostName 192.168.1.9\n".to_string())
        };
        let expand = |p: &str| -> Vec<String> {
            if p == "conf.d/*" { vec!["/home/u/.ssh/conf.d/extra".into()] } else { vec![] }
        };
        let env = ssh_config::Env { home: "/home/u", local_user: "u", load: &load, expand: &expand };
        let (c, _) = ssh_config::parse(main, &env);
        let by = |k: &str| c.iter().find(|x| x.key == k).unwrap_or_else(|| panic!("{k}"));
        let extra = by("ssh:extra");
        assert_eq!((extra.host.as_str(), extra.username.as_str()), ("192.168.1.9", "deploy"));
        let w = by("ssh:web2");
        assert_eq!((w.host.as_str(), w.port, w.username.as_str()), ("web2.example.com", 2222, "deploy"));
        assert_eq!(w.key_file.as_deref(), Some("/home/u/.ssh/id_web"));
        assert_eq!(w.forwards.len(), 2);
        assert_eq!(w.forwards[0].forward_type, "local");
        assert_eq!((w.forwards[0].local_port, w.forwards[0].remote_host.as_deref(), w.forwards[0].remote_port), (8080, Some("localhost"), Some(80)));
        // The global User applies before the host's own (first value wins)
        assert_eq!(by("ssh:db").username, "deploy");
        assert_eq!(by("ssh:db").jump.as_deref(), Some("ssh:bastion"));
        assert_eq!(by("ssh:old").jump.as_deref(), Some("ssh:bastion"));
        let far = by("ssh:far");
        assert_eq!(far.jump.as_deref(), Some("ssh:bastion"));
        let gw = by("jump:admin@gw.example.com:2200");
        assert!(gw.implicit);
        assert!(!c.iter().any(|x| x.key.contains("internal") || x.name == "*"));
    }

    #[test]
    fn reg_and_putty() {
        let reg = "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings]\r\n\"HostName\"=\"\"\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\prod%20web]\r\n\"HostName\"=\"root@10.0.0.1\"\r\n\"PortNumber\"=dword:00000016\r\n\"Protocol\"=\"ssh\"\r\n\"PublicKeyFile\"=\"C:\\\\Users\\\\me\\\\key.ppk\"\r\n\"PortForwardings\"=\"L8080=localhost:80,4D1080,R2222=127.0.0.1:22\"\r\n\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\tel]\r\n\"HostName\"=\"x\"\r\n\"Protocol\"=\"telnet\"\r\n";
        let c = putty::from_reg(reg);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].name.as_str(), c[0].host.as_str(), c[0].port, c[0].username.as_str()), ("prod web", "10.0.0.1", 22, "root"));
        assert_eq!(c[0].key_file.as_deref(), Some("C:\\Users\\me\\key.ppk"));
        let kinds: Vec<&str> = c[0].forwards.iter().map(|f| f.forward_type.as_str()).collect();
        assert_eq!(kinds, ["local", "dynamic", "remote"]);
        // UTF-16 LE with BOM, as reg export writes it
        let mut bytes = vec![0xFF, 0xFE];
        for u in reg.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(putty::from_reg(&decode_reg_bytes(&bytes)).len(), 1);
        let f = putty::from_session_file("lin%20box", "HostName=10.0.0.2\nPortNumber=2200\nUserName=me\nProtocol=ssh\n").unwrap();
        assert_eq!((f.name.as_str(), f.port, f.username.as_str()), ("lin box", 2200, "me"));
    }

    /// WinSCP's own scheme, written here only to check that reading inverts it.
    fn winscp_encrypt(pass: &str, key: &str) -> String {
        let enc = |b: u8| format!("{:02X}", !b ^ 0xA3);
        let data = format!("{key}{pass}");
        let mut s = enc(0xFF) + &enc(0) + &enc(data.len() as u8) + &enc(2) + &enc(0x11) + &enc(0x22);
        for b in data.bytes() {
            s += &enc(b);
        }
        s
    }

    #[test]
    fn winscp_sites() {
        let pw = winscp_encrypt("S3cret!", "adminsrv.example.com");
        let tpw = winscp_encrypt("Tunnel-pw", "jumpgw");
        assert_eq!(winscp::decrypt_password(&pw, "adminsrv.example.com").as_deref().map(|s| s.as_str()), Some("S3cret!"));
        let ini = format!(
            "[Configuration\\Security]\nUseMasterPassword=0\n[Sessions\\Prod/Web/srv%20one]\nHostName=srv.example.com\nUserName=admin\nPassword={pw}\nPublicKeyFile=C:%5CKeys%5Cid.ppk\nTunnel=1\nTunnelHostName=gw\nTunnelUserName=jump\nTunnelPassword={tpw}\n[Sessions\\ftp]\nHostName=f\nFSProtocol=5\n"
        );
        let (c, warnings) = winscp::from_sections(parse_ini(&ini));
        assert!(warnings.is_empty());
        assert_eq!(c.len(), 2);
        let s = &c[0];
        assert_eq!((s.name.as_str(), s.folder.clone()), ("srv one", vec!["Prod".to_string(), "Web".to_string()]));
        assert_eq!(s.key_file.as_deref(), Some("C:\\Keys\\id.ppk"));
        assert_eq!(s.password.as_deref().map(|p| p.as_str()), Some("S3cret!"));
        assert_eq!(s.jump.as_deref(), Some("jump:jump@gw:22"));
        assert_eq!(c[1].password.as_deref().map(|p| p.as_str()), Some("Tunnel-pw"));
        let (m, w) = winscp::from_sections(parse_ini(&ini.replace("UseMasterPassword=0", "UseMasterPassword=1")));
        assert_eq!(w, vec!["master-password".to_string()]);
        assert!(m[0].password.is_none());
    }
}
