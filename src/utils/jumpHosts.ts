import { Connection } from '../types';

/** The jump host chain of a connection (ids, nearest first); stops at a loop or a missing one. */
export function jumpChain(connections: Connection[], conn: Pick<Connection, 'id' | 'jumpHostId'>): Connection[] {
  const out: Connection[] = [];
  const seen = new Set<string>([conn.id]);
  let next = conn.jumpHostId;
  while (next && !seen.has(next) && out.length < 16) {
    const c = connections.find((x) => x.id === next);
    if (!c) break;
    out.push(c);
    seen.add(c.id);
    next = c.jumpHostId;
  }
  return out;
}

/** SSH connections that can be the jump host of `selfId` (never itself or one that goes through it). */
export function jumpHostCandidates(connections: Connection[], selfId: string | null): Connection[] {
  return connections
    .filter((c) => c.protocol === 'ssh' && c.id !== selfId && !c.id.startsWith('adhoc-'))
    .filter((c) => !selfId || !jumpChain(connections, c).some((x) => x.id === selfId))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}
