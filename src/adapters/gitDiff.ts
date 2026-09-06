// src/adapters/gitDiff.ts
//
// TASK-GC-002 — git diff source adapter (vscode.git extension API).
//
// Pure/structural everywhere except `getGitApi()`, which is the only function
// that imports the real `vscode` module. Consumers (GC-007) compose this with
// `pickRepository()` + `collectCommitDiff()` + `repo.inputBox.value` to drive
// the "Generate Commit Message" SCM sparkle.
//
// Frozen strings/values: see `docs/AI_HANDOFF/PLAN.md` §1 + TASK-GC-002.
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Structural types — real vscode.git `Repository` instances satisfy these
// without any `any`. We deliberately avoid importing the real `vscode.git`
// d.ts so unit tests can construct fakes cheaply.
// ---------------------------------------------------------------------------

export interface GitUriLike {
  fsPath: string;
}

export interface GitChangeLike {
  uri: GitUriLike;
}

export interface GitRepositoryLike {
  rootUri: GitUriLike;
  /** `diff(true)` = staged (index vs HEAD); `diff()` = unstaged (working tree vs index). */
  diff(cached?: boolean): Promise<string>;
  state: {
    HEAD?: { name?: string };
    indexChanges: readonly GitChangeLike[];
    workingTreeChanges: readonly GitChangeLike[];
    mergeChanges?: readonly GitChangeLike[];
  };
  inputBox: { value: string };
}

export interface GitApiLike {
  repositories: readonly GitRepositoryLike[];
}

export interface CommitDiffInput {
  repoName: string;
  branch?: string;
  files: string[];
  diffText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes (UTF-16 code units) of diff text carried into the prompt. */
export const GIT_DIFF_MAX_BYTES = 12_288;

const TRUNCATION_MARKER = "\n… [diff truncated]";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Last path segment of a fsPath (POSIX or Windows mixed). */
export function repoNameFromFsPath(fsPath: string): string {
  if (!fsPath) return "";
  // Normalize backslashes for Windows-pasted root paths.
  const normalized = fsPath.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function toRelativePath(rootFsPath: string, absoluteFsPath: string): string {
  const root = rootFsPath.replace(/\\/g, "/").replace(/\/+$/, "");
  let abs = absoluteFsPath.replace(/\\/g, "/");
  if (abs.startsWith(root + "/")) abs = abs.slice(root.length + 1);
  else if (abs.startsWith(root)) abs = abs.slice(root.length).replace(/^\/+/, "");
  return abs;
}

/**
 * Truncate `text` so that the returned value has at most `GIT_DIFF_MAX_BYTES`
 * UTF-16 code units, appending a human-readable marker.
 */
export function truncateDiff(text: string): string {
  if (text.length <= GIT_DIFF_MAX_BYTES) return text;
  // Reserve room for the marker line so callers can rely on `endsWith`.
  const markerLen = TRUNCATION_MARKER.length;
  const head = text.slice(0, Math.max(0, GIT_DIFF_MAX_BYTES - markerLen));
  return head + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// Repository / API seams
// ---------------------------------------------------------------------------

/** Multi-repo picker is out of scope (PLAN §2). Returns `repositories[0]`. */
export function pickRepository(api: GitApiLike | undefined): GitRepositoryLike | null {
  if (!api || api.repositories.length === 0) return null;
  return api.repositories[0];
}

/**
 * The only vscode-bound function in this module. Returns the vscode.git
 * extension's API(1) when available, otherwise `undefined`.
 */
export function getGitApi(): GitApiLike | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(id: number): GitApiLike }>("vscode.git");
  if (!ext) return undefined;
  if (ext.isActive === false) return undefined;
  if (!ext.exports || typeof ext.exports.getAPI !== "function") return undefined;
  return ext.exports.getAPI(1);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Collect a prompt-ready `CommitDiffInput` from the given git repository.
 *
 * Algorithm (frozen, PLAN §2):
 *   1. staged   = await repo.diff(true); if staged.trim() non-empty → use it.
 *   2. else     = await repo.diff();      if that trims empty → return null.
 *   3. files    = deduped repo-relative paths from state.indexChanges +
 *                 state.workingTreeChanges + state.mergeChanges.
 *   4. repoName = basename of rootUri.fsPath.
 *   5. branch   = state.HEAD?.name when present, else undefined.
 *   6. diffText = the chosen diff, truncated at GIT_DIFF_MAX_BYTES.
 */
export async function collectCommitDiff(
  repo: GitRepositoryLike,
): Promise<CommitDiffInput | null> {
  const stagedRaw = await repo.diff(true);
  let chosen: string;
  if (typeof stagedRaw === "string" && stagedRaw.trim().length > 0) {
    chosen = stagedRaw;
  } else {
    const unstagedRaw = await repo.diff(false);
    if (typeof unstagedRaw !== "string" || unstagedRaw.trim().length === 0) {
      return null;
    }
    chosen = unstagedRaw;
  }

  const state = repo.state ?? ({} as GitRepositoryLike["state"]);
  const seen = new Set<string>();
  const files: string[] = [];
  const rootFsPath = repo.rootUri?.fsPath ?? "";
  const push = (change: GitChangeLike | undefined) => {
    if (!change || !change.uri || typeof change.uri.fsPath !== "string") return;
    const rel = toRelativePath(rootFsPath, change.uri.fsPath);
    if (!rel || seen.has(rel)) return;
    seen.add(rel);
    files.push(rel);
  };
  for (const c of state.indexChanges ?? []) push(c);
  for (const c of state.workingTreeChanges ?? []) push(c);
  for (const c of state.mergeChanges ?? []) push(c);

  const branch = state.HEAD && typeof state.HEAD.name === "string" ? state.HEAD.name : undefined;

  return {
    repoName: repoNameFromFsPath(rootFsPath),
    branch,
    files,
    diffText: truncateDiff(chosen),
  };
}