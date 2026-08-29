// src/ai/config.ts
// AiConfigStore — vscode-backed persistence for AI config.
//   - Settings (5 fields) → globalState as a structured object.
//   - apiKey → SecretStorage.
//
// Spec: docs/AI_HANDOFF/tasks/TASK-001.md §Spec (normative, frozen).
// Pattern: src/core/connectionManager.ts (SecretStorage + Memento, metadata-last).
import * as vscode from "vscode";
import {
  aiSettingsErrors,
  defaultAiSettings,
  type AiSettings,
  type AiConfig,
} from "./settings";

export const KEY_AI_SETTINGS = "vsdb.ai.settings";
export const KEY_AI_API_KEY = "vsdb.ai.apiKey";

export class AiConfigStore {
  private readonly ctx: vscode.ExtensionContext;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
  }

  /** Settings from globalState; null when nothing stored or stored value is invalid. */
  async loadSettings(): Promise<AiSettings | null> {
    const raw = this.ctx.globalState.get<unknown>(KEY_AI_SETTINGS);
    if (raw === undefined || raw === null) return null;
    // Some host envs (or migration paths) may store a JSON string; tolerate it.
    let parsed: unknown = raw;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return null;
      }
    }
    if (!parsed || typeof parsed !== "object") return null;
    // Cycle AE — legacy migration: configs persisted before the `engine`
    // field was added have no engine key. Normalize to "builtin" BEFORE
    // validation so `aiSettingsErrors()` does NOT flag the saved config
    // as invalid. Without this, every pre-cycle-AE user's settings load
    // returns null and the panel falls through to its empty-state flow.

    // Cycle AIC — same idea for the new `autocomplete` role: pre-AIC
    // configs lack it; add `{ modelId: "", vision: false }` so the
    const obj = parsed as Record<string, unknown>;
    if (obj.engine === undefined) {
      obj.engine = "builtin";
      parsed = obj;
    }


    const modelsObj = obj.models as Record<string, unknown> | undefined;
    if (modelsObj && typeof modelsObj === "object" && modelsObj.autocomplete === undefined) {
      modelsObj.autocomplete = { modelId: "", vision: false };
      obj.models = modelsObj;
      parsed = obj;
    }
    // Defense-in-depth: re-validate against the schema. Corrupted store ⇒ null.
    try {
      const errors = aiSettingsErrors(parsed as AiSettings);
      if (errors.length > 0) return null;
    } catch {
      return null;
    }
    return parsed as AiSettings;
  }

  /** Secret from SecretStorage; undefined when absent / storage error. */
  async loadApiKey(): Promise<string | undefined> {
    try {
      const v = await this.ctx.secrets.get(KEY_AI_API_KEY);
      return v ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Merge fresh (no cache). null when EITHER store empty. */
  async loadConfig(): Promise<AiConfig | null> {
    const [s, k] = await Promise.all([this.loadSettings(), this.loadApiKey()]);
    if (!s) return null;
    if (k === undefined) return null;
    return { ...s, apiKey: k };
  }

  /**
   * Save settings + apiKey.
   * Ordering (normative):
   *   1) validate settings ⇒ throw, persist nothing
   *   2) reject empty apiKey ⇒ throw, persist nothing
   *   3) secrets.store(KEY_AI_API_KEY, apiKey) — if rejects ⇒ throw, persist nothing
   *   4) globalState.update(KEY_AI_SETTINGS, object with the 5 settings fields only)
   */
  async save(settings: AiSettings, apiKey: string): Promise<void> {
    const settingsErrors = aiSettingsErrors(settings);
    if (settingsErrors.length > 0) {
      throw new Error(settingsErrors[0]);
    }
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new Error("API key is required");
    }

    // SECRETS FIRST. If this rejects, metadata MUST NOT be persisted.
    await this.ctx.secrets.store(KEY_AI_API_KEY, apiKey);

    // Exclude apiKey by construction — settings object is the validated AiSettings literal,
    // no extra fields. Strip any defense-in-depth extras just in case.
    const toPersist: AiSettings = {
      baseUrl: settings.baseUrl,
      method: settings.method,
      timeoutMs: settings.timeoutMs,
      maxSteps: settings.maxSteps,
      models: {
        work: {
          modelId: settings.models.work.modelId,
          vision: settings.models.work.vision,
        },
        smart: {
          modelId: settings.models.smart.modelId,
          vision: settings.models.smart.vision,
        },
        autocomplete: {
          modelId: settings.models.autocomplete?.modelId ?? "",
          vision: settings.models.autocomplete?.vision ?? false,
        },
      },
      engine: settings.engine,
    };

    await this.ctx.globalState.update(KEY_AI_SETTINGS, toPersist);
  }

  /** Clear both stores — idempotent. */
  async clear(): Promise<void> {
    try {
      await this.ctx.secrets.delete(KEY_AI_API_KEY);
    } catch {
      // ignore: design §8 fallback posture (mirror ConnectionManager)
    }
    await this.ctx.globalState.update(KEY_AI_SETTINGS, undefined);
  }

  // Expose for tests / wave-3 form defaults without re-import.
  static defaults(): AiSettings {
    return defaultAiSettings();
  }
}
