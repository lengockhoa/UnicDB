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
import type { AiSettings, AiConfig, AiEngine } from "./settings";
import type { AgentDetections, EngineChoice } from "./engineChoice";
import type { OmpDetection } from "./omp/detect";
import type { ChatMessage, ProviderRequest, ProviderResult } from "./provider";
import {
  buildCommitPrompt,
  buildRetryCommitPrompt,
  sanitizeCommitMessage,
  serializeCommitPrompt,
} from "./commitMessage";
import {
  checkCommitMessage,
  type CommitMessageIssue,
} from "./commitMessageGuard";

// ---- frozen strings ---------------------------------------------------------
export const TOAST_NO_LITE =
  "Configure the Lite Model in UnicDB AI Settings to use Generate Commit Message";
export const ACTION_OPEN_SETTINGS = "Open Settings";
export const TOAST_NO_CHANGES =
  "UnicDB: nothing to commit — this Git repo has no staged or unstaged changes. Stage or modify at least one file, then click again.";
export const TOAST_NO_BACKEND_CONFIG =
  "Configure the AI backend (base URL + API key) in UnicDB AI Settings";
export const ERROR_ENGINE_UNAVAILABLE_PREFIX = "UnicDB: ";
export const ERROR_ENGINE_UNAVAILABLE_SUFFIX = " engine unavailable — ";
export const ERROR_OMP_UNAVAILABLE_PREFIX = "UnicDB: omp engine unavailable — ";
export const ERROR_NON_STRING_TEXT_BUILTIN =
  "commit-gen: builtin provider returned non-string text";
export const ERROR_NON_STRING_TEXT_OMP =
  "commit-gen: omp one-shot returned non-string";

// Guard-flow frozen strings (SPEC §8.5). The terminal toast is assembled from
// these two constants plus the last raw preview and an optional debug-dump path.
export const ERROR_COMMIT_GUARD_FAILED_PREFIX =
  "UnicDB: generated commit message failed validation";
export const ERROR_COMMIT_GUARD_RETRY_NOTE =
  "Retried once and still invalid — nothing was injected into the commit box.";

// Progress/cancel frozen strings (SPEC FR-002 / §8.2). Stage text is reported
// through `deps.report`; the in-progress toast is shown by the host when the
// single-flight gate refuses a second run.
export const COMMIT_GEN_TIMEOUT_MS = 120_000;
export const TOAST_GENERATION_IN_PROGRESS =
  "UnicDB: a commit message is already being generated — wait for it to finish or cancel it.";
export const PROGRESS_COLLECTING_DIFF = "Collecting diff…";
export const PROGRESS_CONTACTING_MODEL = "Contacting model…";
export const PROGRESS_VALIDATING = "Validating message…";
export const PROGRESS_RETRYING = "Retrying with corrective prompt…";

// ---- guard + retry-1 orchestration (SPEC §8.4) ------------------------------
/**
 * Outcome of the sanitize → guard → (retry once) pipeline.
 *
 * - `ok`               — a sanitized, guard-approved message is ready to inject.
 * - `kind: "empty"`    — the model produced no usable text (after sanitize).
 *                        NEVER retried: the caller keeps the existing empty
 *                        diagnostic and dump. `raw` is the offending raw text.
 * - `kind: "invalid"`  — non-empty but guard-rejected twice. The caller shows
 *                        the frozen §8.5 toast and does NOT inject.
 */
export type GuardOutcome =
  | { ok: true; message: string }
  | { ok: false; kind: "empty"; raw: string }
  | {
      ok: false;
      kind: "invalid";
      raw: string;
      message: string;
      reasons: readonly CommitMessageIssue[];
    };

/**
 * Run the sanitize → guard pipeline with at most one corrective retry.
 *
 * Pure: touches no ports and never imports `vscode`. `call` is a per-branch
 * closure that performs one engine request for the given messages — any throw
 * (transport, non-string payload) propagates to the caller's existing catch so
 * the branch-specific error mapping is preserved. An empty sanitized message is
 * never retried (SPEC FR-007); a non-empty guard failure triggers exactly one
 * retry through `buildRetryCommitPrompt(prompt, message, reasons)`.
 */
export async function generateWithGuard(
  call: (messages: readonly ChatMessage[]) => Promise<string>,
  prompt: readonly ChatMessage[],
): Promise<GuardOutcome> {
  const raw = await call(prompt);
  const message = sanitizeCommitMessage(raw);
  const first = checkCommitMessage(message);
  if (first.ok) {
    return { ok: true, message };
  }
  if (message.length === 0) {
    // Empty (whitespace-only / stripped) — no retry.
    return { ok: false, kind: "empty", raw };
  }

  const retryPrompt = buildRetryCommitPrompt(prompt, message, first.reasons);
  const raw2 = await call(retryPrompt);
  const message2 = sanitizeCommitMessage(raw2);
  const second = checkCommitMessage(message2);
  if (second.ok) {
    return { ok: true, message: message2 };
  }
  if (message2.length === 0) {
    return { ok: false, kind: "empty", raw: raw2 };
  }
  return {
    ok: false,
    kind: "invalid",
    raw: raw2,
    message: message2,
    reasons: second.reasons,
  };
}

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
  /** Cancel the in-flight turn (SPEC FR-005). The host wires this to the
   *  progress cancellation token; a cancelled turn settles the driver with
   *  `commit-gen: cancelled` and the flow returns silently. */
  cancel?(): void;
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
  resolveEngine(input: {
    engine?: unknown;
    detections?: AgentDetections;
    detection?: OmpDetection;
    config: unknown | null;
  }): EngineChoice;
  /** Build the omp one-shot adapter with the selected Lite model. */
  buildOmpEngine(choice: EngineChoice, modelId: string): Promise<OmpOneShot>;
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
  /**
   * Optional debug dump: persist a raw provider payload to disk so the user
   * can paste it back for diagnosis. Returns the absolute file path, or
   * undefined if writing was skipped (e.g. body is empty).
   */
  writeDebugArtifact?(input: {
    label: string;
    body: string;
    context?: Record<string, unknown>;
  }): string | undefined;
  /** Progress stage reporter (SPEC FR-002). Receives the frozen
   *  `PROGRESS_*` strings; absent ⇒ stages are skipped. */
  report?(message: string): void;
  /** Cancellation poll (SPEC FR-002). Checked at the post-diff and
   *  post-outcome checkpoints; `true` ⇒ silent return (no toast, no
   *  injection). */
  isCancelled?(): boolean;
  /** Cancellation signal forwarded onto `ProviderRequest.signal` so a
   *  cancel reaches the in-flight fetch (SPEC FR-003). The host wires it
   *  from the progress token via an AbortController. */
  signal?: AbortSignal;
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
 *   3. Resolve the engine via `resolveEngine({ engine: settings.engine, … })`.
 *      The user's choice is the single source of truth:
 *        - resolves to "omp"     → buildOmpEngine + oneShot.generate
 *        - resolves to "builtin" → loadConfig + builtinComplete
 *        - selected engine unavailable → showError with the engine-specific
 *          install/update hint from resolveEngine (no silent fallback).
 *      Defend the typed contract: both builtinComplete and oneShot.generate
 *      MUST return a string. If a port ever violates it, surface a structured
 *      Error rather than letting the object reach the sanitizer / input box.
 *   4. Guard + retry + inject (SPEC §8.4): run the engine string through
 *      `generateWithGuard` (sanitize → `checkCommitMessage`). A guard pass
 *      injects; an empty sanitized message (either attempt) keeps the existing
 *      empty-diagnostic path with the `commit-gen-empty` dump and is NEVER
 *      retried; a non-empty guard failure retries exactly once through
 *      `buildRetryCommitPrompt` on the SAME port/model. A second failure shows
 *      the frozen §8.5 toast, optionally dumps `commit-gen-guard-rejected`, and
 *      leaves the input box untouched. Any engine throw (either attempt)
 *      propagates to the branch's existing catch — no retry on throw.
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
  deps.report?.(PROGRESS_COLLECTING_DIFF);
  const diff = await deps.collectDiff();
  if (diff === null) {
    deps.showError(TOAST_NO_CHANGES);
    return;
  }
  // Cancel checkpoint (SPEC FR-002): a cancel that landed while the diff was
  // being collected closes the flow silently — no engine call, no toast.
  if (deps.isCancelled?.()) {
    return;
  }

  // 3. Engine selection. The global `settings.engine` is the single source
  // of truth — chat panel and the Generate Commit Message sparkle share it.
  // Per-model engine override was removed; the Lite section in the AI
  // Settings form no longer exposes an Engine dropdown.
  //   "omp"         → resolveEngine keeps it if the binary is installed.
  //   "builtin"     → always honored; config may be missing (toast opens Settings).
  //   "claude-code" / "codex" → no commit-gen adapter today; resolveEngine
  //     returns builtin + an install hint so the user can see exactly why
  //     their selection was rejected instead of being silently swapped.
  const selectedEngine: AiEngine = settings.engine;
  const prompt = buildCommitPrompt({
    repoName: diff.repoName,
    ...(diff.branch !== undefined ? { branch: diff.branch } : {}),
    files: diff.files,
    diffText: diff.diffText,
  });
  let outcome: GuardOutcome | null = null;
  let cfg: AiConfig | null = null;
  deps.report?.(PROGRESS_CONTACTING_MODEL);
  // Cancel channel (SPEC FR-003): forward the host's signal onto every
  // ProviderRequest so a cancel reaches the in-flight fetch. When the host
  // supplies none, a fresh non-aborting signal keeps the field populated.
  const requestSignal: AbortSignal = deps.signal ?? new AbortController().signal;
  // Engine routing — closed three-way classification so the validator
  // (`aiSettingsErrors`) gates unknown values upstream. If a future cycle
  // adds a dedicated adapter for one of those engines, add the branch here
  // AND update the JSDoc above to match.
  if (selectedEngine === "omp") {
    const detection = await deps.detectOmp();
    const choice = deps.resolveEngine({
      engine: selectedEngine,
      detection,
      config: null,
    });
    if (choice.engine !== "omp") {
      const hint = choice.hint ?? "install omp";
      deps.showError(`${ERROR_OMP_UNAVAILABLE_PREFIX}${hint}`);
      return;
    }
    try {
      const oneShot = await deps.buildOmpEngine(choice, lite.modelId);
      let attempt = 0;
      outcome = await generateWithGuard(async (messages) => {
        attempt += 1;
        if (attempt > 1) {
          deps.report?.(PROGRESS_RETRYING);
        }
        const raw = await oneShot.generate(serializeCommitPrompt(messages));
        if (typeof raw !== "string") {
          throw new Error(ERROR_NON_STRING_TEXT_OMP);
        }
        return raw;
      }, prompt);
    } catch (e) {
      if (deps.isCancelled?.()) {
        return;
      }
      deps.showError(`UnicDB: omp error — ${(e as Error).message ?? String(e)}`);
      return;
    }
  } else if (selectedEngine === "builtin") {
    // resolveEngine is bypassed for "builtin" because the engine is always
    // honored when selected — the only question is whether the global
    // backend config is populated.
    cfg = await deps.loadConfig();
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
      let attempt = 0;
      outcome = await generateWithGuard(async (messages) => {
        attempt += 1;
        if (attempt > 1) {
          deps.report?.(PROGRESS_RETRYING);
        }
        const result = await deps.builtinComplete(cfg as AiConfig, {
          modelId: lite.modelId,
          messages: [...messages],
          maxOutputTokens: 300,
          temperature: 0.2,
          signal: requestSignal,
        });
        if (typeof result.text !== "string") {
          throw new Error(ERROR_NON_STRING_TEXT_BUILTIN);
        }
        return result.text;
      }, prompt);
    } catch (e) {
      if (deps.isCancelled?.()) {
        return;
      }
      const err = e as Error & { bodySnippet?: string };
      const detail = err.bodySnippet ? `: ${err.bodySnippet}` : "";
      deps.showError(`UnicDB: provider error — ${err.message ?? String(e)}${detail}`);
      return;
    }
  } else {
    // "claude-code" | "codex" — commit-gen only ships omp + builtin today.
    // resolveEngine hands us back "builtin" with a selected-engine install
    // hint when the user's choice isn't usable, so we still run the request
    // through the OpenAI-compatible backend AND tell them why their engine
    // selection wasn't honored.
    const cfgForChoice = await deps.loadConfig();
    if (cfgForChoice === null) {
      const action = await deps.showSettingsToast(
        TOAST_NO_BACKEND_CONFIG,
        ACTION_OPEN_SETTINGS,
      );
      if (action === ACTION_OPEN_SETTINGS) {
        deps.openSettings();
      }
      return;
    }
    cfg = cfgForChoice;
    const choice = deps.resolveEngine({
      engine: selectedEngine,
      detections: {},
      config: cfg,
    });
    const hint = choice.hint;
    const hintSuffix = hint ? ` (${hint})` : "";
    // The hint toast is informational: it explains why the user's engine
    // selection wasn't honored. Fire it exactly ONCE — after the first
    // successful engine string, before inject — and never again on the guard
    // retry (the retry reuses the same fallback provider, so a second toast
    // would be noise and would break the observed count === 1 contract).
    let hintShown = false;
    try {
      let attempt = 0;
      outcome = await generateWithGuard(async (messages) => {
        attempt += 1;
        if (attempt > 1) {
          deps.report?.(PROGRESS_RETRYING);
        }
        const result = await deps.builtinComplete(cfg as AiConfig, {
          modelId: lite.modelId,
          messages: [...messages],
          maxOutputTokens: 300,
          temperature: 0.2,
          signal: requestSignal,
        });
        if (typeof result.text !== "string") {
          throw new Error(ERROR_NON_STRING_TEXT_BUILTIN);
        }
        if (hint && !hintShown) {
          hintShown = true;
          deps.showError(
            `${ERROR_ENGINE_UNAVAILABLE_PREFIX}${selectedEngine}${ERROR_ENGINE_UNAVAILABLE_SUFFIX}${hint}`,
          );
          // We still inject the sanitized message — the user explicitly asked
          // for a generated git message and we can produce one. The toast is
          // informational so they know their engine selection didn't take.
        }
        return result.text;
      }, prompt);
    } catch (e) {
      if (deps.isCancelled?.()) {
        return;
      }
      const err = e as Error & { bodySnippet?: string };
      const detail = err.bodySnippet ? `: ${err.bodySnippet}` : "";
      deps.showError(
        `UnicDB: ${selectedEngine} commit-gen fell back to provider error — ${err.message ?? String(e)}${detail}${hintSuffix}`,
      );
      return;
    }
  }

  // 4. Guard verdict. `outcome` is always set: every branch either returns
  // early on error or assigns it above.
  deps.report?.(PROGRESS_VALIDATING);
  // Post-outcome cancel checkpoint (SPEC FR-002): a cancel that landed while
  // the engine ran (including mid-retry) closes silently — no injection, no
  // toast — even when the outcome itself is usable.
  if (deps.isCancelled?.()) {
    return;
  }
  if (outcome !== null && outcome.ok) {
    deps.setInputBox(outcome.message);
    return;
  }
  if (outcome !== null && outcome.kind === "invalid") {
    // Non-empty, guard-rejected twice. Surface the frozen §8.5 toast and,
    // when available, dump the last raw payload for diagnosis. We do NOT call
    // setInputBox — the commit box must not be overwritten with garbage.
    const preview = outcome.raw.slice(0, 240).replace(/\s+/g, " ");
    const debugFile = deps.writeDebugArtifact?.({
      label: "commit-gen-guard-rejected",
      body: outcome.raw,
      context: { engine: selectedEngine, reasons: outcome.reasons },
    });
    const fileNote = debugFile ? ` Debug dump: ${debugFile}` : "";
    deps.showError(
      `${ERROR_COMMIT_GUARD_FAILED_PREFIX} (reasons: ${outcome.reasons.join(", ")}). ` +
        `${ERROR_COMMIT_GUARD_RETRY_NOTE} Raw preview: "${preview}".${fileNote}`,
    );
    return;
  }

  // Empty (either attempt): keep the existing empty-diagnostic path verbatim —
  // same toast text, same `commit-gen-empty` dump using the last raw text.
  const rawProviderText = outcome !== null ? outcome.raw : "";
  const rawLen = rawProviderText.length;
  const rawPreview = rawProviderText.slice(0, 240).replace(/\s+/g, " ");
  const debugFile = deps.writeDebugArtifact?.({
    label: "commit-gen-empty",
    body: rawProviderText,
    context: {
      engine: selectedEngine,
      baseUrl: cfg?.baseUrl ?? "",
      method: cfg?.method ?? "",
      // The exact request body so the user can compare against Kilo Code's
      // working call for the same Lite Model — usually the diff is one of:
      //   (a) stream: false hint ignored → switch to stream:true
      //   (b) max_output_tokens name / cap mismatch
      //   (c) extra fields the Lite Model proxy doesn't recognize
      requestBody: JSON.stringify(
        cfg
          ? {
              model: lite.modelId,
              input:
                "<<see prompt from buildCommitPrompt — captured by provider>>",
              max_output_tokens: 300,
              temperature: 0.2,
              stream: false,
            }
          : null,
        null,
        2,
      ),
    },
  });
  const fileNote = debugFile ? ` Debug dump: ${debugFile}` : "";
  deps.showError(
    `UnicDB: provider returned no commit message text (raw length ${rawLen}). ` +
      `Preview: "${rawPreview}". Check Lite Model config.${fileNote}`,
  );
}
