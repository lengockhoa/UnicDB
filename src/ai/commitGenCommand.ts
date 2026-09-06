// src/ai/commitGenCommand.ts — TASK-GC-007
//
// Pure orchestration behind the SCM sparkle: collect the diff (GC-002),
// resolve the Lite Model + engine (GC-001), generate the message (GC-003
// via builtin provider or omp one-shot), and inject the sanitized text
// into `repository.inputBox.value`. Every vscode interaction is a port —
// this module never imports `vscode`. Privacy invariant: apiKey /
// credentials never appear in any prompt or log line.
//
// Frozen strings (PLAN §1): see TOAST_NO_LITE / TOAST_NO_CHANGES /
// TOAST_NO_BACKEND_CONFIG / ERROR_OMP_UNAVAILABLE.
import type { AiSettings, AiConfig } from "./settings";
import type { EngineChoice } from "./engineChoice";
import type { OmpDetection } from "./omp/detect";
import type { ProviderRequest, ProviderResult } from "./provider";
import { buildCommitPrompt, sanitizeCommitMessage } from "./commitMessage";

// ---- frozen strings ---------------------------------------------------------
export const TOAST_NO_LITE =
  "Configure the Lite Model in UnicDB AI Settings to use Generate Commit Message";
export const ACTION_OPEN_SETTINGS = "Open Settings";
export const TOAST_NO_CHANGES = "UnicDB: no changes to summarize.";
export const TOAST_NO_BACKEND_CONFIG =
  "Configure the AI backend (base URL + API key) in UnicDB AI Settings";
export const ERROR_OMP_UNAVAILABLE_PREFIX = "UnicDB: omp engine unavailable — ";

// ---- structural types -------------------------------------------------------

/** Structural subset of the GC-002 `CommitDiffInput` used by the prompt
 * builder. Keeps this module's imports stable and lets unit tests pass a
 * minimum-shape fake. */
export interface CommitDiffInputLike {
  repoName: string;
  branch?: string;
  files: readonly string[];
  diffText: string;
}

/** One-shot omp chat engine. The host wires this from `createOmpChatEngine`
 * (src/ai/omp/ompChatEngine.ts) by collecting `onDelta` into a buffer and
 * resolving when the turn ends. */
export interface OmpOneShot {
  generate(prompt: string): Promise<string>;
}

// ---- injected ports ---------------------------------------------------------

export interface CommitGenDeps {
  /** Settings without apiKey. null ⇒ feature disabled or store empty. */
  loadSettings(): Promise<AiSettings | null>;
  /** Full config (settings + apiKey). null when EITHER store is empty. */
  loadConfig(): Promise<AiConfig | null>;
  /** Detect the local `omp` binary / version. */
  detectOmp(): Promise<OmpDetection>;
  /** Pure engine-resolution policy (GC-001 / engineChoice.ts). */
  resolveEngine(input: { detection: OmpDetection; config: unknown | null }): EngineChoice;
  /** Build the omp one-shot adapter. Pure factory — no global state. */
  buildOmpEngine(choice: EngineChoice): Promise<OmpOneShot>;
  /** Provider-port for the builtin path. Mirrors `createProviderClient(...).complete`. */
  builtinComplete(cfg: AiConfig, req: ProviderRequest): Promise<ProviderResult>;
  /** GC-002 collection port. null ⇒ no changes to summarize. */
  collectDiff(): Promise<CommitDiffInputLike | null>;
  /** Inject the generated message into the SCM input box. */
  setInputBox(message: string): void;
  /** Light info toast. */
  showInfo(m: string): void;
  /** Error toast. */
  showError(m: string): void;
  /** Settings toast with a single action button. Returns the chosen action
   *  label (the same string passed in) or undefined if dismissed. */
  showSettingsToast(m: string, action: string): Promise<string | undefined>;
  /** Open the AI Settings panel — invoked when the user picks the action. */
  openSettings(): void;
}

// ---- main entry -------------------------------------------------------------

/**
 * Run the Generate Commit Message flow. Pure / single-shot — no global
 * state. The host (`src/extension.ts`) supplies real vscode-backed deps;
 * tests inject fakes.
 *
 * Frozen flow (PLAN §2):
 *   1. settings = loadSettings(); if null or lite.modelId empty → settings
 *      toast; if action picked → openSettings(); return.
 *   2. diff = collectDiff(); null → info toast; return.
 *   3. engine = settings.models.lite.engine ?? "omp"
 *        "omp"     → resolveEngine; if engine !== "omp" → error+hint; else
 *                    sanitize(await buildOmpEngine(choice).generate(prompt))
 *        "builtin" → loadConfig; null → settings toast; else
 *                    sanitize(builtinComplete(cfg, request).text)
 *   4. setInputBox(message) (only on success).
 */
export async function runGenerateCommitMessage(deps: CommitGenDeps): Promise<void> {
  // 1. Lite model must be configured.
  const settings = await deps.loadSettings();
  const lite = settings?.models?.lite;
  if (!settings || !lite || !lite.modelId || lite.modelId.trim() === "") {
    const action = await deps.showSettingsToast(TOAST_NO_LITE, ACTION_OPEN_SETTINGS);
    if (action === ACTION_OPEN_SETTINGS) {
      deps.openSettings();
    }
    return;
  }

  // 2. Diff must exist.
  const diff = await deps.collectDiff();
  if (diff === null) {
    deps.showInfo(TOAST_NO_CHANGES);
    return;
  }

  // 3. Engine selection.
  const engine: "omp" | "builtin" = lite.engine ?? "omp";
  const prompt = buildCommitPrompt({
    repoName: diff.repoName,
    ...(diff.branch !== undefined ? { branch: diff.branch } : {}),
    files: diff.files,
    diffText: diff.diffText,
  });

  let message = "";
  if (engine === "omp") {
    const detection = await deps.detectOmp();
    const choice = deps.resolveEngine({ detection, config: null });
    if (choice.engine !== "omp") {
      const hint = choice.hint ?? "install omp";
      deps.showError(`${ERROR_OMP_UNAVAILABLE_PREFIX}${hint}`);
      return;
    }
    try {
      const oneShot = await deps.buildOmpEngine(choice);
      const raw = await oneShot.generate(prompt as unknown as string);
      message = sanitizeCommitMessage(raw);
    } catch (e) {
      deps.showError(`UnicDB: omp error — ${(e as Error).message ?? String(e)}`);
      return;
    }
  } else {
    // "builtin"
    const cfg = await deps.loadConfig();
    if (cfg === null) {
      const action = await deps.showSettingsToast(
        TOAST_NO_BACKEND_CONFIG,
        ACTION_OPEN_SETTINGS,
      );
      if (action === ACTION_OPEN_SETTINGS) {
        deps.openSettings();
      }
      return;
    }
    try {
      const result = await deps.builtinComplete(cfg, {
        modelId: lite.modelId,
        messages: prompt,
        maxOutputTokens: 300,
        temperature: 0.2,
      });
      message = sanitizeCommitMessage(result.text);
    } catch (e) {
      deps.showError(`UnicDB: provider error — ${(e as Error).message ?? String(e)}`);
      return;
    }
  }

  // 4. Inject only on success.
  if (message.length > 0) {
    deps.setInputBox(message);
  }
}
