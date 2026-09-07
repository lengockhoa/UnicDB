// src/ai/engineChoice.ts — TASK-007 (P0.3): settings-driven engine-resolution policy.
//
// Pure (no vscode / fs / net / child_process) — webview + unit-test importable.
//
// Two call shapes:
//
// 1. Explicit P0.3 mode:
//    `resolveEngine({ engine, detections, config })`
//    Honors the user-selected engine ("builtin" | "omp" | "claude-code" |
//    "codex"). The selected engine is authoritative: a healthy selection wins,
//    and an unavailable selection falls back to `builtin` with a reason-keyed
//    hint (version-too-old → update hint if defined, else install hint;
//    otherwise → selected-engine install hint). The previously installed but
//    non-selected agents never override the user's choice.
//
// 2. Legacy mode (preserved until TASK-012 migrates extension callers):
//    `resolveEngine({ detection, config })` — no `engine`, no `detections`.
//    Retains the locked omp-first behavior from TASK-AIX05-003.
//
// Hard rule: an unknown `engine` value (e.g. a migrated "copilot") fails closed
// to `builtin` with NO unsafe external engine string leaking into the result
// and NO selected-engine hint (we don't know which install command applies).
import type { AiEngine } from "./settings";
import {
  OMP_INSTALL_HINT,
  OMP_UPDATE_HINT,
  type OmpDetection,
} from "./omp/detect";
import {
  CLAUDE_CODE_INSTALL_HINT,
  type ClaudeCodeDetection,
} from "./claudeCode/detect";
import {
  CODEX_INSTALL_HINT,
  type CodexDetection,
} from "./codex/detect";

/** Shared detection fields across the three non-builtin agents. Each
 * `detectX()` module returns its own typed shape; this is the narrowest
 * projection resolveEngine actually consumes for P0.3. */
export interface AgentDetection {
  available?: boolean;
  ok: boolean;
  reason?: string;
  path?: string;
  version?: string;
}

/** Per-engine detections dictionary. The three keys mirror the non-builtin
 * `AiEngine` members. */
export type AgentDetections = Partial<
  Record<Exclude<AiEngine, "builtin">, AgentDetection>
>;

export interface EngineChoice {
  engine: AiEngine;
  /** true ⇒ caller must have a valid AI config (or must route to settings). */
  requiresConfig: boolean;
  /** Selected-engine hint — only set when engine resolves to `builtin` AND the
   * explicit policy was engaged. Format: install command (or update command
   * for `omp` when reason="version-too-old"). */
  hint?: string;
  /** Detected binary version — only set for non-builtin engines that resolved. */
  version?: string;
  /** Resolved binary path — only set for non-builtin engines that resolved. */
  path?: string;
}

/** Input contract to `resolveEngine`. Both `engine` and `detections` are
 * optional; if both are omitted, the legacy omp-first path is used. */
export interface ResolveEngineInput {
  /** User's configured engine preference (raw `UnicDB.ai.engine`). */
  engine?: unknown;
  /** Selected-engine detections dictionary. */
  detections?: AgentDetections;
  /** Legacy single-engine OMP detection shape — preserved until TASK-012. */
  detection?: OmpDetection;
  /** Result of `AiConfigStore.loadConfig()` — opaque to this module; only
   * its null-ness matters. */
  config: unknown | null;
}

const AI_ENGINE_VALUES: readonly AiEngine[] = [
  "builtin",
  "omp",
  "claude-code",
  "codex",
];

function isKnownAiEngine(value: unknown): value is AiEngine {
  return (
    typeof value === "string" &&
    (AI_ENGINE_VALUES as readonly string[]).includes(value)
  );
}

function requiresConfig(config: unknown | null): boolean {
  return config === null || config === undefined;
}

/** Per-engine install/update hint. For `omp` the rule is strict:
 * `version-too-old` → `OMP_UPDATE_HINT`, otherwise → `OMP_INSTALL_HINT`. The
 * other two agents don't export an update hint yet, so their install hint is
 * reused for both cases (matches the caller's install/update semantics). */
function hintForEngine(
  engine: Exclude<AiEngine, "builtin">,
  reason: string | undefined,
): string {
  if (engine === "omp") {
    return reason === "version-too-old" ? OMP_UPDATE_HINT : OMP_INSTALL_HINT;
  }
  if (engine === "claude-code") return CLAUDE_CODE_INSTALL_HINT;
  return CODEX_INSTALL_HINT;
}

/** Narrow an OmpDetection / ClaudeCodeDetection / CodexDetection shape to the
 * AgentDetection projection used by resolveEngine. All three shapes carry the
 * four fields we care about (ok, reason, path, version). */
function projectAgent(d: OmpDetection | ClaudeCodeDetection | CodexDetection): AgentDetection {
  return {
    available: d.available,
    ok: d.ok,
    reason: d.reason,
    path: d.path,
    version: d.version,
  };
}

export function resolveEngine(input: ResolveEngineInput): EngineChoice {
  const { engine, detections, detection, config } = input;

  // Legacy mode: only the single-engine OMP `detection` field was provided
  // (no explicit `engine` / `detections`). Preserve TASK-AIX05-003 behavior
  // until TASK-012 migrates callers.
  const explicitEngaged = engine !== undefined || detections !== undefined;
  if (!explicitEngaged) {
    return resolveOmpLegacy(detection, config);
  }

  // Unknown / migrated / non-string `engine` value — fail closed to builtin
  // with no unsafe external engine string and no selected-engine hint.
  if (!isKnownAiEngine(engine)) {
    return { engine: "builtin", requiresConfig: requiresConfig(config) };
  }

  // Explicit `builtin`: user has opted into the AI provider engine. Config is
  // optional (user may not have saved one yet — they would see the
  // "Configure AI settings" interstitial). Nonselected installed agents must
  // NOT override this choice.
  if (engine === "builtin") {
    return { engine: "builtin", requiresConfig: requiresConfig(config) };
  }

  // Explicit non-builtin selection. Resolve its detection:
  //   - prefer the typed detections dictionary,
  //   - fall back to the legacy single-engine OMP `detection` field if the
  //     selection is "omp" (preserves the existing call shape's effect when
  //     TASK-012 migrates callers).
  const selected: AgentDetection | undefined =
    detections?.[engine] ??
    (engine === "omp" && detection !== undefined
      ? projectAgent(detection)
      : undefined);

  if (selected?.ok) {
    const choice: EngineChoice = { engine, requiresConfig: false };
    if (selected.version) choice.version = selected.version;
    if (selected.path) choice.path = selected.path;
    return choice;
  }

  // Selected non-builtin engine is unavailable — fall back to builtin with
  // a reason-keyed hint for the selected engine.
  return {
    engine: "builtin",
    requiresConfig: requiresConfig(config),
    hint: hintForEngine(engine, selected?.reason),
  };
}

/** TASK-AIX05-003 omp-first legacy behavior, preserved until TASK-012. */
function resolveOmpLegacy(
  detection: OmpDetection | undefined,
  config: unknown | null,
): EngineChoice {
  if (detection?.ok) {
    const choice: EngineChoice = { engine: "omp", requiresConfig: false };
    if (detection.version) choice.version = detection.version;
    if (detection.path) choice.path = detection.path;
    return choice;
  }
  // AIX-05 reason → hint map: `version-too-old` is the only reason we surface
  // the update hint for. Any other reason (including a missing `detection`
  // object entirely — caller omitted the legacy field) defaults to install.
  const hint =
    detection && detection.reason === "version-too-old"
      ? OMP_UPDATE_HINT
      : OMP_INSTALL_HINT;
  return {
    engine: "builtin",
    requiresConfig: requiresConfig(config),
    hint,
  };
}

// Unused export marker — keeps `ClaudeCodeDetection`/`CodexDetection` types
// tree-shake-correct without changing the public surface.
export type _LegacyDetectionTypes = ClaudeCodeDetection | CodexDetection;
