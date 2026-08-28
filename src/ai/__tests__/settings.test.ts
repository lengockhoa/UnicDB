// src/ai/__tests__/settings.test.ts
// Unit tests cho src/ai/settings.ts (pure) — TASK-001 §Test Cases #1..#7.
import { describe, it, expect } from "vitest";
import {
  defaultAiSettings,
  aiSettingsErrors,
  normalizeBaseUrl,
  redactAiConfig,
} from "../settings";
import type { AiSettings, AiConfig } from "../settings";

describe("ai/settings — defaults + validation + helpers", () => {
  it("Test #1 — defaultAiSettings exact literal", () => {
    expect(defaultAiSettings()).toEqual({
      baseUrl: "https://api.openai.com/v1",
      method: "chat/completions",
      timeoutMs: 60000,
      maxSteps: 12,
      models: {
        work: { modelId: "", vision: true },
        smart: { modelId: "", vision: false },
      },
      engine: "builtin",
    });
  });

  it("Test #2 — valid → no errors", () => {
    const s: AiSettings = {
      ...defaultAiSettings(),
      models: {
        work: { modelId: "gpt-4o-mini", vision: true },
        smart: { modelId: "gpt-4o", vision: false },
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
      },
      engine: "builtin",
    };
  }
  it("Test #4 — bounds inclusive", () => {
    const base: AiSettings = {
      baseUrl: "http://localhost:8080/v1",
      method: "responses",
      timeoutMs: 1000,
      maxSteps: 1,
      models: {
        work: { modelId: "m", vision: true },
        smart: { modelId: "m", vision: false },
      },
      engine: "builtin",
    };
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
    const bad1 = { ...base2(), models: { work: null, smart: { modelId: "m", vision: false } } } as unknown as AiSettings;
    expect(aiSettingsErrors(bad1)).toContain("Model is required for role: work");
    const bad2 = { ...base2(), models: { work: { modelId: 42, vision: true }, smart: { modelId: "m", vision: false } } } as unknown as AiSettings;
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

  it("Test #7 — redactAiConfig strips apiKey only", () => {
    const cfg: AiConfig = {
      ...defaultAiSettings(),
      apiKey: "sk-very-secret",
    };
    const red = redactAiConfig(cfg);
    expect(Object.keys(red).sort()).toEqual(
      ["baseUrl", "engine", "maxSteps", "method", "models", "timeoutMs"].sort(),
    );
    expect((red as unknown as Record<string, unknown>).apiKey).toBeUndefined();
    // Sanity: the 6 settings fields equal default.
    expect(red.baseUrl).toBe(cfg.baseUrl);
    expect(red.method).toBe(cfg.method);
    expect(red.timeoutMs).toBe(cfg.timeoutMs);
    expect(red.maxSteps).toBe(cfg.maxSteps);
    expect(red.models).toEqual(cfg.models);
    expect(red.engine).toBe("builtin");
  });
});
