// src/ai/engineChoice.ts — TASK-011 (B3): pure engine-resolution policy.
//
// Locked decision #2: omp is the default AI engine and opening chat requires
// no configuration. `commandOpenAiChat` (src/extension.ts) previously gated
// on `aiStore.loadConfig()` being non-null BEFORE ever looking at whether omp
// itself was usable — so a machine with a perfectly good omp install still
// hit the "Configure AI settings first." interstitial. This module extracts
// the decision into a pure function (no `vscode` import) so it is testable
// without the extension host, and so `commandOpenAiChat` contains no engine
// policy of its own — only vscode-bound orchestration (showing the panel,
// opening settings).
//
// Rule: omp ok ⇒ always the engine (even when a full OpenAI-compatible
// config is ALSO present — omp wins, config is left untouched). Only when
// omp is unavailable/too old does the builtin provider engine apply, and
// ONLY THEN does the caller need a valid AI config.
import { OMP_INSTALL_HINT, OMP_UPDATE_HINT, type OmpDetection } from "./omp/detect";

export interface EngineChoice {
  engine: "omp" | "builtin";
  /** true ⇒ caller must have a valid AI config (or must route to settings). */
  requiresConfig: boolean;
  /** OMP_INSTALL_HINT | OMP_UPDATE_HINT — only set when engine is "builtin"
   * and omp was at least attempted (absent vs too old changes which hint). */
  hint?: string;
  /** Detected omp version — only set when engine is "omp". */
  version?: string;
}

export function resolveEngine(input: {
  detection: OmpDetection;
  /** Result of `AiConfigStore.loadConfig()` — opaque to this module; only
   * its null-ness matters. */
  config: unknown | null;
}): EngineChoice {
  const { detection, config } = input;

  if (detection.ok) {
    // omp usable — wins regardless of config (locked decision #2). Zero
    // config required.
    const choice: EngineChoice = { engine: "omp", requiresConfig: false };
    if (detection.version) choice.version = detection.version;
    return choice;
  }

  // omp unusable — fall back to the builtin provider, which DOES need a
  // valid config. `detection.available` distinguishes "binary found but too
  // old / unreadable version" (OMP_UPDATE_HINT) from "binary not found at
  // all" (OMP_INSTALL_HINT).
  const hint = detection.available ? OMP_UPDATE_HINT : OMP_INSTALL_HINT;
  return {
    engine: "builtin",
    requiresConfig: config === null || config === undefined,
    hint,
  };
}
