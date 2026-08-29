// src/ai/settings.ts
// Pure types + validators cho AI config. NO vscode import (webview-importable).
//
// Spec: docs/AI_HANDOFF/tasks/TASK-001.md §Spec (normative, frozen).

export type AiCompletionMethod = "responses" | "chat/completions";
/**
 * Cycle AIC — adds a third, free-form OpenAI-compatible model role used only
 * for SQL ghost-text autocomplete. An empty `modelId` means the feature is
 * disabled (NOT invalid); work/smart remain required.
 */
export type AiModelRole = "work" | "smart" | "autocomplete";
/**
 * Cycle AE TASK-003 §Engine selection — chat engine routing.
 * `"builtin"` runs `runAgent` against `provider.completeStream`. `"omp"`
 * delegates to `OmpChatEngine.send` (the hostMcp bridge + ACP session).
 * Default is `"builtin"` for back-compat with every existing config.
 */
export type AiEngine = "builtin" | "omp";

export interface AiModelConfig {
  modelId: string;
  vision: boolean;
}

export interface AiSettings {
  baseUrl: string; // e.g. "https://api.openai.com/v1"
  method: AiCompletionMethod;
  timeoutMs: number; // 1000..600000
  maxSteps: number; // 1..100 — agent step budget (consumed by TASK-003)
  models: Record<AiModelRole, AiModelConfig>;
  /** Cycle AE — chat engine selection. Default "builtin". */
  engine: AiEngine;
}

export interface AiConfig extends AiSettings {
  apiKey: string;
}

/** Defaults — Spec literal; deep-equal in test #1. */
export function defaultAiSettings(): AiSettings {
  return {
    baseUrl: "https://api.openai.com/v1",
    method: "chat/completions",
    timeoutMs: 60000,
    maxSteps: 12,
    models: {
      work: { modelId: "", vision: true },
      smart: { modelId: "", vision: false },
      autocomplete: { modelId: "", vision: false },
    },
    engine: "builtin",
  };
}

const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 600000;
const MAX_STEPS_MIN = 1;
const MAX_STEPS_MAX = 100;
const AI_MODEL_ROLES: readonly AiModelRole[] = ["work", "smart", "autocomplete"];


/**
 * Validate `AiSettings`. Returns list of error messages (empty ⇒ valid).
 * Spec messages are exact strings; order-insensitive.
 */
export function aiSettingsErrors(s: AiSettings): string[] {
  const errors: string[] = [];

  // Defense-in-depth: settings-shaped object must NOT carry apiKey.
  if (typeof (s as unknown as Record<string, unknown>).apiKey === "string") {
    errors.push("apiKey must not be stored in settings");
  }

  // baseUrl
  const baseUrl = s.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    errors.push("Base URL is required");
  } else if (!/^https?:\/\//i.test(baseUrl.trim())) {
    errors.push("Base URL must start with http:// or https://");
  }

  // method
  if (s.method !== "responses" && s.method !== "chat/completions") {
    errors.push("Method must be responses or chat/completions");
  }

  // timeoutMs
  if (typeof s.timeoutMs !== "number" || s.timeoutMs < TIMEOUT_MIN || s.timeoutMs > TIMEOUT_MAX) {
    errors.push("Timeout must be between 1000 and 600000 ms");
  }

  // maxSteps
  if (typeof s.maxSteps !== "number" || s.maxSteps < MAX_STEPS_MIN || s.maxSteps > MAX_STEPS_MAX) {
    errors.push("Max steps must be between 1 and 100");
  }

  // models — Cycle AIC: autocomplete is allowed to be empty (means feature
  // disabled). work + smart remain required.
  const models = s.models;
  if (!models || typeof models !== "object") {
    errors.push("models must define work, smart, and autocomplete roles");
  } else {
    for (const role of AI_MODEL_ROLES) {
      if (!(role in models)) {
        errors.push("models must define work, smart, and autocomplete roles");
        break;
      }
    }
    for (const role of AI_MODEL_ROLES) {
      const m = models[role];
      if (!m || typeof m !== "object" || typeof m.modelId !== "string" || m.modelId.trim() === "") {
        if (role === "autocomplete") {
          // Empty autocomplete = feature disabled, not invalid. Skip the
          // error so legacy two-role valid configs aren't blocked.
          continue;
        }
        errors.push(`Model is required for role: ${role}`);
      }
    }
  }

  // engine (cycle AE) — undefined / anything other than the two legal
  // values is rejected so a mis-saved config can't silently degrade to
  // the wrong engine.
  if (s.engine !== "builtin" && s.engine !== "omp") {
    errors.push("Engine must be builtin or omp");
  }

  return errors;
}

/** Trim + strip ALL trailing `/`. No scheme validation here (see aiSettingsErrors). */
export function normalizeBaseUrl(url: string): string {
  if (typeof url !== "string") return "";
  const trimmed = url.trim();
  // Strip trailing slashes; empty input stays empty.
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped;
}

/** Strip apiKey only — return settings-shape. */
export function redactAiConfig(cfg: AiConfig): AiSettings {
  const engine: AiEngine = cfg.engine === "omp" ? "omp" : "builtin";
  return {
    baseUrl: cfg.baseUrl,
    method: cfg.method,
    timeoutMs: cfg.timeoutMs,
    maxSteps: cfg.maxSteps,
    models: {
      work: { modelId: cfg.models.work.modelId, vision: cfg.models.work.vision },
      smart: { modelId: cfg.models.smart.modelId, vision: cfg.models.smart.vision },
      autocomplete: {
        modelId: cfg.models.autocomplete?.modelId ?? "",
        vision: cfg.models.autocomplete?.vision ?? false,
      },
    },
    engine,
  };
}
