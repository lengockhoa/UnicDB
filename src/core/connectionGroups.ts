// src/core/connectionGroups.ts
// DBX-05 TASK-DBX05-001 — pure helpers for connection folder grouping/colors.
// No vscode import. Deterministic: same folder name always maps to the same
// palette color so tree icons are stable across reloads.

/** Fixed 8-color palette for folder icons (hex, VS Code dark-theme friendly). */
export const GROUP_COLOR_PALETTE: readonly string[] = [
  "#4fc1ff",
  "#f14c4c",
  "#f5a623",
  "#3fb950",
  "#bc8cff",
  "#ff7b72",
  "#79c0ff",
  "#d2a8ff",
] as const;

/**
 * Stable 32-bit hash (FNV-1a) of a folder name — deterministic across
 * sessions, no dependency on Node's crypto.
 */
function folderHash(folder: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < folder.length; i++) {
    h ^= folder.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministically pick a palette color for a folder name. */
export function assignColor(folder: string): string {
  return GROUP_COLOR_PALETTE[folderHash(folder) % GROUP_COLOR_PALETTE.length];
}

/** Sorted unique folder names across connections; missing/empty folders excluded. */
export function listGroups(
  connections: ReadonlyArray<{ folder?: string }>,
): string[] {
  const names = new Set<string>();
  for (const c of connections) {
    if (typeof c.folder === "string" && c.folder.trim().length > 0) {
      names.add(c.folder);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface ConnectionGroup<T> {
  /** `undefined` = ungrouped bucket (always LAST). */
  folder: string | undefined;
  items: T[];
}

/**
 * Group connections by folder. Groups sorted alphabetically; the ungrouped
 * bucket (folder === undefined) is last. Items keep their input order.
 */
export function groupConnections<T extends { folder?: string }>(
  connections: readonly T[],
): ConnectionGroup<T>[] {
  const map = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const c of connections) {
    if (typeof c.folder === "string" && c.folder.trim().length > 0) {
      const bucket = map.get(c.folder);
      if (bucket) bucket.push(c);
      else map.set(c.folder, [c]);
    } else {
      ungrouped.push(c);
    }
  }
  const folders = [...map.keys()].sort((a, b) => a.localeCompare(b));
  const out: ConnectionGroup<T>[] = folders.map((folder) => ({
    folder,
    items: map.get(folder) as T[],
  }));
  if (ungrouped.length > 0) out.push({ folder: undefined, items: ungrouped });
  return out;
}
