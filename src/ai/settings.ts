// src/ai/settings.ts
// Pure types + validators cho AI config. NO vscode import (webview-importable).
//
// Spec: docs/AI_HANDOFF/tasks/TASK-001.md §Spec (normative, frozen).

export type AiCompletionMethod = "responses" | "chat/completions";
export type AiModelRole = "work" | "smart";

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
    },
  };
}

const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 600000;
const MAX_STEPS_MIN = 1;
const MAX_STEPS_MAX = 100;

const AI_MODEL_ROLES: readonly AiModelRole[] = ["work", "smart"];

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

  // models
  const models = s.models;
  if (!models || typeof models !== "object") {
    errors.push("models must define both work and smart roles");
  } else {
    for (const role of AI_MODEL_ROLES) {
      if (!(role in models)) {
        errors.push("models must define both work and smart roles");
        break;
      }
    }
    for (const role of AI_MODEL_ROLES) {
      const m = models[role];
      if (!m || typeof m !== "object" || typeof m.modelId !== "string" || m.modelId.trim() === "") {
        errors.push(`Model is required for role: ${role}`);
      }
    }
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
  return {
    baseUrl: cfg.baseUrl,
    method: cfg.method,
    timeoutMs: cfg.timeoutMs,
    maxSteps: cfg.maxSteps,
    models: {
      work: { modelId: cfg.models.work.modelId, vision: cfg.models.work.vision },
      smart: { modelId: cfg.models.smart.modelId, vision: cfg.models.smart.vision },
    },
  };
}
