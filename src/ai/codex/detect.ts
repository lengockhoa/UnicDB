// src/ai/codex/detect.ts — TASK-003: codex (OpenAI Codex CLI) detection + version gate + fallback decision.
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { compareVersions } from "../omp/detect";

export const MIN_CODEX_VERSION = "0.20.0";
export const CODEX_INSTALL_HINT = "npm install -g @openai/codex";

export interface CodexDetection {
  available: boolean; // binary runs and returns a version string we could read
  ok: boolean; // available && version >= MIN_CODEX_VERSION
  path?: string; // from `which codex` output
  version?: string; // parsed "codex-cli 0.42.0" → "0.42.0"
  reason?: string; // "not-installed" | "version-too-old" | "version-unknown" | "spawn-failed"
}

export type ExecFn = (cmd: string) => Promise<string>;

/**
 * Parse "codex-cli 0.42.0" → "0.42.0". Unparseable → undefined.
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
  return process.platform === "win32" ? "where codex" : "which codex";
}

/**
 * TASK-006 (B12): `ExecFn` takes a single shell command string, so the path
 * still round-trips through a shell — but an unquoted path with spaces
 * (e.g. `/opt/my apps/codex`) previously split into multiple shell tokens.
 * Quote it so it is passed through as a single argv entry instead of being
 * shell-concatenated word-by-word.
 */
function quoteForShell(path: string): string {
  if (!/\s/.test(path)) return path;
  return `"${path.replace(/"/g, '\\"')}"`;
}

/**
 * Locate the codex binary, read its version, and decide whether to use it
 * or fall back to the built-in engine.
 *
 * - ENOENT (and other spawn failures) → available=false, reason "not-installed".
 *   Never throws.
 * - Version parses below MIN_CODEX_VERSION → ok=false, reason "version-too-old".
 * - Version output is garbage → ok=false, reason "version-unknown".
 */
export async function detectCodex(
  execFn: ExecFn = defaultExecFn,
): Promise<CodexDetection> {
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

  if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
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
