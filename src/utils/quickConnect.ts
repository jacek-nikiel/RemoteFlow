/**
 * Quick Connect: parses what is typed in the command palette into a connection that is not
 * saved in the vault, e.g. `ssh root@10.0.0.15:2222`, `ssh -p 2222 deploy@web1`,
 * `rdp admin@srv01`, `root@10.0.0.15`, `[fe80::1]:22`.
 */
export interface QuickTarget {
  protocol: 'ssh' | 'rdp';
  username: string;
  host: string;
  port: number;
}

const DEFAULT_PORT = { ssh: 22, rdp: 3389 } as const;

const validHost = (h: string) =>
  /^[A-Za-z0-9.-]+$/.test(h) || /^[0-9A-Fa-f:.%]+$/.test(h); // name / IPv4 or IPv6 literal

export function parseQuickConnect(input: string): QuickTarget | null {
  let rest = input.trim();
  if (!rest) return null;
  let protocol: 'ssh' | 'rdp' | null = null;
  const m = /^(ssh|rdp)(?:\s+|:\/\/)(.*)$/i.exec(rest);
  if (m) {
    protocol = m[1].toLowerCase() as 'ssh' | 'rdp';
    rest = m[2].trim();
  }
  let port: number | null = null;
  // ssh -p 2222 user@host / ssh user@host -p 2222
  const pFlag = /(?:^|\s)-p\s*(\d{1,5})(?=\s|$)/.exec(rest);
  if (pFlag) {
    port = Number(pFlag[1]);
    rest = (rest.slice(0, pFlag.index) + ' ' + rest.slice(pFlag.index + pFlag[0].length)).trim();
  }
  // -l user
  let username = '';
  const lFlag = /(?:^|\s)-l\s*(\S+)(?=\s|$)/.exec(rest);
  if (lFlag) {
    username = lFlag[1];
    rest = (rest.slice(0, lFlag.index) + ' ' + rest.slice(lFlag.index + lFlag[0].length)).trim();
  }
  if (!rest || /\s/.test(rest)) return null;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    username = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!username) return null;
  }
  let host = rest;
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(rest);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else {
    const colons = (rest.match(/:/g) || []).length;
    if (colons === 1) {
      const [h, p] = rest.split(':');
      if (!/^\d{1,5}$/.test(p)) return null;
      host = h;
      port = Number(p);
    }
  }
  if (!host || !validHost(host)) return null;
  // Without "ssh"/"rdp" in front, only something that clearly is an address (a word alone is
  // a search for a saved connection)
  if (!protocol) {
    const looksLikeAddress = at >= 0 || port !== null || host.includes('.') || host.includes(':') || host === 'localhost';
    if (!looksLikeAddress) return null;
  }
  const proto = protocol ?? 'ssh';
  const finalPort = port ?? DEFAULT_PORT[proto];
  if (finalPort < 1 || finalPort > 65535) return null;
  return { protocol: proto, username, host, port: finalPort };
}

export const formatQuickTarget = (q: QuickTarget) =>
  `${q.protocol} ${q.username ? q.username + '@' : ''}${q.host.includes(':') ? `[${q.host}]` : q.host}${
    q.port !== DEFAULT_PORT[q.protocol] ? ':' + q.port : ''
  }`;
