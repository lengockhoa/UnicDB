// src/ai/omp/detect.ts — TASK-003: omp detection + version gate + fallback decision.
import { exec } from "node:child_process";
import { promisify } from "node:util";

export const MIN_OMP_VERSION = "17.0.0";
export const OMP_INSTALL_HINT = "curl -fsSL https://omp.sh/install | sh";
export const OMP_UPDATE_HINT = "omp update";

export interface OmpDetection {
  available: boolean; // binary runs and returns a version string we could read
  ok: boolean; // available && version >= MIN_OMP_VERSION
  path?: string; // from `which omp` output
  version?: string; // parsed "omp/18.0.1" → "18.0.1"
  reason?: string; // "not-installed" | "version-too-old" | "version-unknown" | "spawn-failed"
}

export type ExecFn = (cmd: string) => Promise<string>;

/**
 * Semantic compare of two version strings, segment by segment.
 * Non-numeric tails are ignored: "18.0.1-beta.2" compares as "18.0.1".
 * Returns -1 / 0 / 1 like Array#sort comparator.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSegments(a);
  const pb = parseSegments(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

function parseSegments(v: string): number[] {
  const head = v.split("-")[0]; // drop non-numeric tail
  return head
    .split(".")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/** Parse "omp/18.0.1 darwin/arm64" → "18.0.1". Unparseable → undefined. */
function parseVersion(raw: string): string | undefined {
  const m = raw.match(/omp\/(\d+(?:\.\d+)*)/);
  return m ? m[1] : undefined;
}

/** Default execFn: promisified child_process.exec. */
async function defaultExecFn(cmd: string): Promise<string> {
  const execP = promisify(exec);
  const { stdout } = await execP(cmd);
  return stdout;
}

/**
 * Locate the omp binary, read its version, and decide whether to use it
 * or fall back to the built-in engine.
 *
 * - ENOENT (and other spawn failures) → available=false, reason "not-installed".
 *   Never throws.
 * - Version parses below MIN_OMP_VERSION → ok=false, reason "version-too-old".
 * - Version output is garbage → ok=false, reason "version-unknown".
 */
export async function detectOmp(
  execFn: ExecFn = defaultExecFn,
): Promise<OmpDetection> {
  let path: string | undefined;
  try {
    const out = await execFn("which omp");
    path = out.trim() || undefined;
  } catch {
    return { available: false, ok: false, reason: "not-installed" };
  }

  let version: string | undefined;
  try {
    const raw = await execFn(`${path} --version`);
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

  if (compareVersions(version, MIN_OMP_VERSION) < 0) {
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
