// src/ai/fileDiff.ts
// TASK-AIX02-001 — pure unified diff over two texts (LCS line matching).
// NO vscode import. Deterministic: same inputs → same output.
// Consumers: AIX-02 fileOpsTool (preview surface) and permission cards.

export interface DiffOptions {
  /** Max rendered diff lines before truncation. Default 200. */
  maxLines?: number;
}

const CONTEXT = 3;
const DEFAULT_MAX_LINES = 200;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // "a\n" → ["a", ""]: the trailing "" is not a real line.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** LCS table (O(n*m)) — fine for file-sized inputs at preview time. */
function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

type Op = { kind: "same" | "add" | "del"; aIdx: number; bIdx: number };

function diffOps(a: string[], b: string[]): Op[] {
  const table = lcsTable(a, b);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", aIdx: i, bIdx: j });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "del", aIdx: i, bIdx: j });
      i++;
    } else {
      ops.push({ kind: "add", aIdx: i, bIdx: j });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "del", aIdx: i++, bIdx: j });
  while (j < b.length) ops.push({ kind: "add", aIdx: i, bIdx: j++ });
  return ops;
}

interface Hunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: string[];
}

/** Group ops into hunks with up to CONTEXT lines of surrounding context. */
function buildHunks(ops: Op[], a: string[], b: string[]): Hunk[] {
  const changed = ops.map((o) => o.kind !== "same");
  // Indices of changed ops worth showing (change ± context).
  const show = ops.map((_, idx) => {
    for (let k = idx - CONTEXT; k <= idx + CONTEXT; k++) {
      if (k >= 0 && k < changed.length && changed[k]) return true;
    }
    return false;
  });

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!show[idx]) {
      current = null;
      continue;
    }
    const op = ops[idx];
    if (current === null) {
      current = { aStart: op.aIdx, aCount: 0, bStart: op.bIdx, bCount: 0, lines: [] };
      hunks.push(current);
    }
    if (op.kind === "same") {
      current.aCount++;
      current.bCount++;
      current.lines.push(` ${a[op.aIdx]}`);
    } else if (op.kind === "del") {
      current.aCount++;
      current.lines.push(`-${a[op.aIdx]}`);
    } else {
      current.bCount++;
      current.lines.push(`+${b[op.bIdx]}`);
    }
  }
  return hunks;
}

/** True when the text is non-empty and does not end with a newline. */
function missingFinalNewline(text: string): boolean {
  return text.length > 0 && !text.endsWith("\n");
}

/**
 * Unified diff (git-style) between oldText and newText.
 * Returns "" when identical. Truncates to maxLines rendered lines with a
 * `… (N more lines)` marker. Emits `\ No newline at end of file` when the
 * affected side lacks a trailing newline.
 */
export function buildUnifiedDiff(
  oldText: string,
  newText: string,
  opts?: DiffOptions,
): string {
  if (oldText === newText) return "";
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  const hunks = buildHunks(ops, a, b);

  const out: string[] = [];
  let truncated = 0;
  for (const h of hunks) {
    if (out.length + h.lines.length + 1 > maxLines) {
      truncated += h.lines.length + 1;
      continue;
    }
    out.push(`@@ -${h.aStart + 1},${h.aCount} +${h.bStart + 1},${h.bCount} @@`);
    out.push(...h.lines);
  }
  if (missingFinalNewline(oldText) || missingFinalNewline(newText)) {
    if (out.length < maxLines) {
      out.push("\\ No newline at end of file");
    } else {
      truncated++;
    }
  }
  if (truncated > 0) {
    out.push(`… (${truncated} more lines)`);
  }
  return out.join("\n");
}

/** Line-level add/remove counts (replacements count as -1/+1). */
export function diffStats(oldText: string, newText: string): {
  added: number;
  removed: number;
} {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}
