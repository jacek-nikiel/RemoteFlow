import { Group } from '../types';

/** Ids of all subfolders of `id` (any depth), cycle-safe. */
export function descendantGroupIds(groups: Group[], id: string): Set<string> {
  const result = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const g of groups) {
      if (g.parentId === current && !result.has(g.id) && g.id !== id) {
        result.add(g.id);
        stack.push(g.id);
      }
    }
  }
  return result;
}

/**
 * Folders with every cycle in the parent chain broken (one folder of the cycle moves to the top
 * level) – the same rule as the backend (vault::models::group_tree::break_cycles), so a cycle can
 * never hide a branch of the tree or make the tree recurse endlessly.
 */
export function withoutGroupCycles(groups: Group[]): Group[] {
  const parents = new Map(groups.map((g) => [g.id, g.parentId] as const));
  let changed = false;
  const result = groups.map((g) => {
    const seen = new Set<string>();
    let current = parents.get(g.id) ?? null;
    while (current) {
      if (current === g.id) {
        parents.set(g.id, null);
        changed = true;
        return { ...g, parentId: null };
      }
      if (seen.has(current)) break;
      seen.add(current);
      current = parents.get(current) ?? null;
    }
    return g;
  });
  return changed ? result : groups;
}
