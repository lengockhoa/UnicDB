// src/ai/grounding/fileSearch.ts — TASK-AIX01-002
// Pure bounded search over pre-read file contents (host owns fs). Binary
// and secret-bearing files are excluded; the model never sees them.

export const MAX_FILE_HITS = 8;
export const MAX_CONTEXT_LINES = 40;

export interface GroundedFile {
  path: string;
  content: string;
}

export interface FileHit {
  path: string;
  startLine: number;
  endLine: number;
  lineText: string;
  score: number;
}

export interface SearchQuery {
  terms: string[];
  glob?: string;
}

export interface SearchResult {
  hits: FileHit[];
  excluded: string[];
}

const BINARY_PROBE_BYTES = 8 * 1024;
const SECRET_PATTERNS: ReadonlyArray<{ name: string; rx: RegExp }> = [
  { name: "aws-access-key", rx: /AKIA[0-9A-Z]{12,}/ },
  { name: "private-key", rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "github-token", rx: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "anthropic-key", rx: /sk-ant-[A-Za-z0-9_-]{12,}/ },
  { name: "slack-token", rx: /xox[bp]-[A-Za-z0-9-]{10,}/ },
];

export function isProbablyBinary(content: string): boolean {
  return content.slice(0, BINARY_PROBE_BYTES).includes("\u0000");
}

export function containsSecretHeuristic(content: string): boolean {
  return SECRET_PATTERNS.some(({ rx }) => rx.test(content));
}

/** Minimal `*` / `**` / `?` glob matcher. `**` matches zero or more path
 *  segments INCLUDING the empty segment after the prefix, so `src/**`
 *  matches both `src/a.ts` and `src/sub/a.ts`. `*` matches any chars
 *  except `/`. */
export function matchesGlob(path: string, glob: string): boolean {
  // Split the glob on `**` so each side can be built independently and
  // joined with `.*`; a leading `**` must accept zero segments, so the
  // left side is rendered as `.*` only when the glob starts with `**`
  // (not a leading literal).
  const parts = glob.split("**");
  const rendered = parts
    .map((part) => {
      // Within each part, translate `*` (no slash) and `?` (single char).
      const partRe = part
        .split("*")
        .map((p) =>
          p
            .split("?")
            .map((q) => q.replace(/[.+^$|()\[\]{}\\]/g, "\\$&"))
            .join("[^/]"),
        )
        .join("[^/]*");
      return partRe;
    })
    .join(".*");
  return new RegExp(`^${rendered}$`).test(path);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    n += 1;
    from = i + needle.length;
  }
  return n;
}

function fileMatches(file: GroundedFile, terms: readonly string[]): { start: number; end: number; score: number } | null {
  if (terms.length === 0) return null;
  const lowered = file.content.toLowerCase();
  let first = -1;
  let last = -1;
  let score = 0;
  for (const t of terms) {
    const tl = t.toLowerCase();
    if (tl.length === 0) continue;
    const occ = countOccurrences(lowered, tl);
    if (occ === 0) continue;
    score += occ;
    const firstIdx = lowered.indexOf(tl);
    const lastIdx = lowered.lastIndexOf(tl);
    const startLine = file.content.slice(0, firstIdx).split("\n").length;
    const endLine = file.content.slice(0, lastIdx + tl.length - 1).split("\n").length;
    if (first === -1 || startLine < first) first = startLine;
    if (last === -1 || endLine > last) last = endLine;
  }
  if (score === 0) return null;
  return { start: first, end: last, score };
}

export function searchWorkspaceFiles(
  files: readonly GroundedFile[],
  query: SearchQuery,
): SearchResult {
  if (query.terms.length === 0) return { hits: [], excluded: [] };
  const excluded: string[] = [];
  const candidates: Array<{ hit: Omit<FileHit, "lineText">; lineText: string }> = [];
  for (const f of files) {
    if (query.glob && !matchesGlob(f.path, query.glob)) continue;
    if (isProbablyBinary(f.content) || containsSecretHeuristic(f.content)) {
      excluded.push(f.path);
      continue;
    }
    const m = fileMatches(f, query.terms);
    if (!m) continue;
    const lines = f.content.split("\n");
    const start = Math.max(1, m.start - 1);
    const end = Math.min(lines.length, m.end + 1);
    const lineText = lines.slice(start - 1, end).join("\n");
    candidates.push({ hit: { path: f.path, startLine: start, endLine: end, score: m.score }, lineText });
  }
  candidates.sort((a, b) => {
    if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
    if (a.hit.path !== b.hit.path) return a.hit.path < b.hit.path ? -1 : 1;
    return a.hit.startLine - b.hit.startLine;
  });

  const hits: FileHit[] = [];
  let totalLines = 0;
  for (const c of candidates) {
    if (hits.length >= MAX_FILE_HITS) break;
    const lineCount = c.hit.endLine - c.hit.startLine + 1;
    const remaining = MAX_CONTEXT_LINES - totalLines;
    if (remaining <= 0) break;
    if (lineCount > remaining) {
      const adjustedEnd = c.hit.startLine + remaining - 1;
      const lines = c.lineText.split("\n");
      hits.push({
        path: c.hit.path,
        startLine: c.hit.startLine,
        endLine: adjustedEnd,
        score: c.hit.score,
        lineText: lines.slice(0, remaining).join("\n"),
      });
      totalLines += remaining;
    } else {
      hits.push({ ...c.hit, lineText: c.lineText });
      totalLines += lineCount;
    }
  }
  return { hits, excluded };
}
