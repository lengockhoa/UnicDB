// src/ai/claudeCode/detect.ts — TASK-002: claude (Anthropic Claude Code) detection + version gate + fallback decision.
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { compareVersions } from "../omp/detect";

export const MIN_CLAUDE_CODE_VERSION = "1.0.0";
export const CLAUDE_CODE_INSTALL_HINT = "npm install -g @anthropic-ai/claude-code";

export interface ClaudeCodeDetection {
  available: boolean; // binary runs and returns a version string we could read
  ok: boolean; // available && version >= MIN_CLAUDE_CODE_VERSION
  path?: string; // from `which claude` output
  version?: string; // parsed "2.0.1 (Claude Code)" → "2.0.1"
  reason?: string; // "not-installed" | "version-too-old" | "version-unknown" | "spawn-failed"
}

export type ExecFn = (cmd: string) => Promise<string>;

/**
 * Parse "2.0.1 (Claude Code)" → "2.0.1". Unparseable → undefined.
 * Matches the first dotted version token anywhere in the output.
 */
function parseVersion(raw: string): string | undefined {
  const m = raw.match(/(\d+(?:\.\d+)+)/);
  return m ? m[1] : undefined;
}

/** Default execFn: promisified child_process.exec. */
async function defaultExecFn(cmd: string): Promise<string> {
  const execP = promisify(exec);
  const { stdout } = await execP(cmd);
  return stdout;
}

/**
 * TASK-006 (B12): the locator command differs per platform — `which` does
 * not exist on Windows.
 */
function locateCommand(): string {
  return process.platform === "win32" ? "where claude" : "which claude";
}

/**
 * TASK-006 (B12): `ExecFn` takes a single shell command string, so the path
 * still round-trips through a shell — but an unquoted path with spaces
 * (e.g. `/opt/my apps/claude`) previously split into multiple shell tokens.
 * Quote it so it is passed through as a single argv entry instead of being
 * shell-concatenated word-by-word.
 */
function quoteForShell(path: string): string {
  if (!/\s/.test(path)) return path;
  return `"${path.replace(/"/g, '\\"')}"`;
}

/**
 * Locate the claude binary, read its version, and decide whether to use it
 * or fall back to the built-in engine.
 *
 * - ENOENT (and other spawn failures) → available=false, reason "not-installed".
 *   Never throws.
 * - Version parses below MIN_CLAUDE_CODE_VERSION → ok=false, reason "version-too-old".
 * - Version output is garbage → ok=false, reason "version-unknown".
 */
export async function detectClaudeCode(
  execFn: ExecFn = defaultExecFn,
): Promise<ClaudeCodeDetection> {
  let path: string | undefined;
  try {
    const out = await execFn(locateCommand());
    // `where` can print multiple matches, one per line; take the first.
    const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
    path = first?.trim() || undefined;
  } catch {
    return { available: false, ok: false, reason: "not-installed" };
  }

  let version: string | undefined;
  try {
    const raw = await execFn(`${quoteForShell(path ?? "")} --version`);
    version = parseVersion(raw);
  } catch {
    return {
      available: false,
      ok: false,
      path,
      reason: "spawn-failed",
    };
  }

  if (!version) {
    return {
      available: true,
      ok: false,
      path,
      reason: "version-unknown",
    };
  }

  if (compareVersions(version, MIN_CLAUDE_CODE_VERSION) < 0) {
    return {
      available: true,
      ok: false,
      path,
      version,
      reason: "version-too-old",
    };
  }

  return { available: true, ok: true, path, version };
}