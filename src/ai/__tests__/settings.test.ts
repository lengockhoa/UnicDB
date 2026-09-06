// src/ai/__tests__/settings.test.ts
// Unit tests cho src/ai/settings.ts (pure) — TASK-001 §Test Cases #1..#7
// + Cycle AIC §4 (autocomplete role is allowed to be empty).
import { describe, it, expect } from "vitest";
import {
  defaultAiSettings,
  aiSettingsErrors,
  normalizeBaseUrl,
  redactAiConfig,
} from "../settings";
import type { AiSettings, AiConfig, AiEngine } from "../settings";

describe("ai/settings — defaults + validation + helpers", () => {
  it("Test #1 — defaultAiSettings exact literal (work + smart + autocomplete)", () => {
    expect(defaultAiSettings()).toEqual({
      baseUrl: "https://api.openai.com/v1",
      method: "chat/completions",
      timeoutMs: 60000,
      maxSteps: 12,
      models: {
        work: { modelId: "", vision: true },
        smart: { modelId: "", vision: false },
        autocomplete: { modelId: "", vision: false },
        lite: { modelId: "", vision: false, engine: "omp" },
      },
      engine: "builtin",
    });
  });

  it("GC #1 — defaultAiSettings has 4 roles; lite defaults to omp engine; work/smart/autocomplete have NO engine key", () => {
    const d = defaultAiSettings();
    expect(Object.keys(d.models).sort()).toEqual(
      ["autocomplete", "lite", "smart", "work"].sort(),
    );
    expect(d.models.lite).toEqual({ modelId: "", vision: false, engine: "omp" });
    // work/smart/autocomplete must NOT have engine key (per-model engine opt-in).
    expect("engine" in d.models.work).toBe(false);
    expect("engine" in d.models.smart).toBe(false);
    expect("engine" in d.models.autocomplete).toBe(false);
    // Global engine stays "builtin".
    expect(d.engine).toBe("builtin");
  });

  it("Test #2 — valid (all three roles populated) → no errors", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
        autocomplete: { modelId: "vendor/free-fast-sql", vision: false },
        lite: { modelId: "", vision: false, engine: "omp" },
      },
    };
    expect(aiSettingsErrors(s)).toEqual([]);
  });

  it("Test #2b (Cycle AIC regression) — empty autocomplete role is valid", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
        autocomplete: { modelId: "", vision: false },
        lite: { modelId: "", vision: false, engine: "omp" },
      },
    };
    expect(aiSettingsErrors(s)).toEqual([]);
  });

  it("Test #3 — invalid settings produce exact 5 messages", () => {
    const invalid = {
      baseUrl: "",
      method: "x" as unknown as AiSettings["method"],
      timeoutMs: 10,
      maxSteps: 0,
      models: {
        work: { modelId: "", vision: true },
        smart: { modelId: "ok", vision: false },
        autocomplete: { modelId: "", vision: false },
        lite: { modelId: "", vision: false, engine: "omp" },
      },
      engine: "builtin",
    } as AiSettings;
    const errs = aiSettingsErrors(invalid);
    expect(errs).toHaveLength(5);
    expect(errs).toEqual(
      expect.arrayContaining([
        "Base URL is required",
        "Method must be responses or chat/completions",
        "Timeout must be between 1000 and 600000 ms",
        "Max steps must be between 1 and 100",
        "Model is required for role: work",
      ]),
    );
  });

  function base2(): AiSettings {
    return {
      baseUrl: "http://localhost:8080/v1",
      method: "responses",
      timeoutMs: 10000,
      maxSteps: 10,
      models: {
        work: { modelId: "m", vision: true },
        smart: { modelId: "m", vision: false },
        autocomplete: { modelId: "", vision: false },
        lite: { modelId: "", vision: false, engine: "omp" },
      },
      engine: "builtin",
    };
  }
  it("Test #4 — bounds inclusive", () => {
    const base: AiSettings = base2();
    expect(aiSettingsErrors(base)).toEqual([]);
    const tLower: AiSettings = { ...base, timeoutMs: 999 };
    expect(aiSettingsErrors(tLower)).toContain(
      "Timeout must be between 1000 and 600000 ms",
    );
    const tUpper: AiSettings = { ...base, timeoutMs: 600001 };
    expect(aiSettingsErrors(tUpper)).toContain(
      "Timeout must be between 1000 and 600000 ms",
    );

    const sLower: AiSettings = { ...base, maxSteps: 0 };
    expect(aiSettingsErrors(sLower)).toContain(
      "Max steps must be between 1 and 100",
    );
    const sUpper: AiSettings = { ...base, maxSteps: 101 };
    expect(aiSettingsErrors(sUpper)).toContain(
      "Max steps must be between 1 and 100",
    );

    // Upper boundary OK.
    expect(
      aiSettingsErrors({ ...base, timeoutMs: 600000, maxSteps: 100 }),
    ).toEqual([]);
  });

  it("Test #4b (R1 fix regression) — null/non-object role entry or non-string modelId is rejected", () => {
    const bad1 = { ...base2(), models: { work: null, smart: { modelId: "m", vision: false }, autocomplete: { modelId: "", vision: false } } } as unknown as AiSettings;
    expect(aiSettingsErrors(bad1)).toContain("Model is required for role: work");
    const bad2 = { ...base2(), models: { work: { modelId: 42, vision: true }, smart: { modelId: "m", vision: false }, autocomplete: { modelId: "", vision: false } } } as unknown as AiSettings;
    expect(aiSettingsErrors(bad2)).toContain("Model is required for role: work");
  });

  it("Test #5 — apiKey must not be stored in settings (defense-in-depth)", () => {
    const leak = {
      ...defaultAiSettings(),
      apiKey: "sk-x",
    } as unknown as AiSettings;
    const errs = aiSettingsErrors(leak);
    expect(errs).toContain("apiKey must not be stored in settings");
  });

  it("Test #6 — normalizeBaseUrl strips trailing slashes; no scheme validation", () => {
    expect(normalizeBaseUrl(" https://x/v1/ ")).toBe("https://x/v1");
    expect(normalizeBaseUrl("https://x/v1///")).toBe("https://x/v1");
    expect(normalizeBaseUrl("https://x")).toBe("https://x");
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl("   ")).toBe("");
    expect(normalizeBaseUrl("not-a-url")).toBe("not-a-url");
  });

  it("Test #7 — redactAiConfig strips apiKey only, preserves all three roles", () => {
    const cfg: AiConfig = {
      ...defaultAiSettings(),
      apiKey: "sk-very-secret",
    };
    cfg.models.autocomplete = { modelId: "vendor/free-fast-sql", vision: false };
    const red = redactAiConfig(cfg);
    expect(Object.keys(red).sort()).toEqual(
      ["baseUrl", "engine", "maxSteps", "method", "models", "timeoutMs"].sort(),
    );
    expect((red as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(red.baseUrl).toBe(cfg.baseUrl);
    expect(red.method).toBe(cfg.method);
    expect(red.timeoutMs).toBe(cfg.timeoutMs);
    expect(red.maxSteps).toBe(cfg.maxSteps);
    expect(red.models).toEqual(cfg.models);
    expect(red.engine).toBe("builtin");
    expect(red.models.autocomplete.modelId).toBe("vendor/free-fast-sql");
  });

  it("Test #7b (Cycle AIC regression) — redactAiConfig tolerates missing autocomplete in input", () => {
    const cfg = {
      baseUrl: "https://x",
      method: "chat/completions" as const,
      timeoutMs: 60000,
      maxSteps: 12,
      models: {
        work: { modelId: "m", vision: true },
        smart: { modelId: "m", vision: false },
      },
      engine: "builtin" as const,
      apiKey: "sk-x",
    } as unknown as AiConfig;
    const red = redactAiConfig(cfg);
    expect(red.models.autocomplete).toEqual({ modelId: "", vision: false });
  });

  // ---- TASK-GC-001: lite role + per-model engine ----------------------

  it("GC #2 — valid 4-role settings (lite populated) → no errors", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
        autocomplete: { modelId: "vendor/free-fast-sql", vision: false },
        lite: { modelId: "vendor/lite-fast", vision: false, engine: "omp" },
      },
    };
    expect(aiSettingsErrors(s)).toEqual([]);
  });

  it("GC #3 — empty lite modelId is valid (feature disabled, same precedent as autocomplete)", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
        autocomplete: { modelId: "", vision: false },
        lite: { modelId: "", vision: false, engine: "omp" },
      },
    };
    const errs = aiSettingsErrors(s);
    expect(errs).not.toContain("Model is required for role: lite");
    expect(errs).toEqual([]);
  });

  it("GC #4 — lite engine 'groq' is rejected with exact error message", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
        autocomplete: { modelId: "", vision: false },
        lite: { modelId: "vendor/lite-fast", vision: false, engine: "groq" as AiEngine },
      },
    };
    const errs = aiSettingsErrors(s);
    expect(errs).toContain("Engine must be builtin or omp");
  });

  it("GC #5 — global engine 'x' is rejected (still validated)", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      engine: "x" as AiEngine,
    };
    const errs = aiSettingsErrors(s);
    expect(errs).toContain("Engine must be builtin or omp");
  });

  it("GC #8 — redactAiConfig preserves lite.modelId/vision/engine and omits apiKey", () => {
    const cfg: AiConfig = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
        autocomplete: { modelId: "vendor/free-fast-sql", vision: false },
        lite: { modelId: "vendor/lite-fast", vision: false, engine: "omp" },
      },
      apiKey: "sk-very-secret",
    };
    const red = redactAiConfig(cfg);
    expect((red as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    expect(red.models.lite).toEqual({
      modelId: "vendor/lite-fast",
      vision: false,
      engine: "omp",
    });
    // work/smart/autocomplete must NOT have an engine key (preserving undefined).
    expect("engine" in red.models.work).toBe(false);
    expect("engine" in red.models.smart).toBe(false);
    expect("engine" in red.models.autocomplete).toBe(false);
  });
});
