// src/ai/__tests__/commitGenCommand.test.ts
// Unit tests for src/ai/commitGenCommand.ts (pure) — TASK-GC-007 §Test Cases #1..#7
// No vscode import. All interactions go through injected ports (fake ports only).
import { describe, it, expect, vi } from "vitest";
import type {
  CommitGenDeps,
  CommitDiffInputLike,
  OmpOneShot,
} from "../commitGenCommand";
import { runGenerateCommitMessage } from "../commitGenCommand";
import type { AiSettings, AiConfig } from "../settings";
import type { EngineChoice } from "../engineChoice";
import type { OmpDetection } from "../omp/detect";
import type { ProviderRequest, ProviderResult } from "../provider";

// ---- fake builders ----------------------------------------------------------

function fakeSettings(over: Partial<AiSettings["models"]["lite"]> = {}): AiSettings {
  return {
    baseUrl: "https://example.com/v1",
    method: "chat/completions",
    timeoutMs: 60_000,
    maxSteps: 12,
    models: {
      work: { modelId: "w", vision: true },
      smart: { modelId: "s", vision: false },
      autocomplete: { modelId: "", vision: false },
      lite: { modelId: "m", vision: false, engine: "builtin", ...over },
    },
    engine: "builtin",
  };
}

function fakeConfig(s: AiSettings = fakeSettings()): AiConfig {
  return { ...s, apiKey: "sk-fake" };
}

function fakeDiff(): CommitDiffInputLike {
  return {
    repoName: "UnicDB",
    branch: "main",
    files: ["src/a.ts"],
    diffText: "+// new",
  };
}

/** Provider-port fake that returns a canned ProviderResult. */
function fakeBuiltinComplete(
  result: ProviderResult | Error,
): CommitGenDeps["builtinComplete"] {
  return (async (_cfg: AiConfig, _req: ProviderRequest) => {
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as CommitGenDeps["builtinComplete"];
}

/** Omp one-shot adapter fake. */
function fakeOmpOneShot(text: string): OmpOneShot {
  return { generate: async () => text };
}

// ============================================================================
// Test #1 — happy path: builtin
// ============================================================================
describe("ai/commitGenCommand — Test #1 builtin happy path", () => {
  it("injects sanitized message into the input box via the builtin provider", async () => {
    const settings = fakeSettings({ modelId: "gpt-mini", engine: "builtin" });
    const cfg = fakeConfig(settings);
    const rawText = "```\nfeat(db): add index\n```";
    const built: ProviderResult = {
      text: rawText,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    const builtinComplete = vi.fn(fakeBuiltinComplete(built));
    const setInputBox = vi.fn();
    const showInfo = vi.fn();
    const showError = vi.fn();
    const showSettingsToast = vi.fn().mockResolvedValue(undefined);
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => cfg) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete: builtinComplete as never,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox,
      showInfo,
      showError,
      showSettingsToast,
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(1);
    const reqArg = builtinComplete.mock.calls[0][1] as ProviderRequest;
    expect(reqArg.modelId).toBe("gpt-mini");
    expect(reqArg.maxOutputTokens).toBe(300);
    expect(reqArg.temperature).toBe(0.2);
    expect(reqArg.messages).toHaveLength(2);
    expect(reqArg.messages[0].role).toBe("system");
    expect(reqArg.messages[1].role).toBe("user");

    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(db): add index");
    expect(showInfo).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(showSettingsToast).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Test #2 — happy path: omp
// ============================================================================
describe("ai/commitGenCommand — Test #2 omp happy path", () => {
  it("routes through the omp engine and injects the sanitized message", async () => {
    const settings = fakeSettings({ modelId: "lite-1", engine: "omp" });
    const detection: OmpDetection = {
      available: true,
      ok: true,
      path: "/usr/bin/omp",
      version: "18.0.1",
    };
    const choice: EngineChoice = {
      engine: "omp",
      requiresConfig: false,
      path: "/usr/bin/omp",
      version: "18.0.1",
    };
    const oneShot = fakeOmpOneShot("feat(api): wire commit gen");
    const generate = vi.spyOn(oneShot, "generate");

    const resolveEngine = vi.fn(
      (_i: { detection: OmpDetection; config: unknown }) => choice,
    );
    const buildOmpEngine = vi.fn(async (_c: EngineChoice) => oneShot);

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => fakeConfig(settings)) as never,
      detectOmp: (async () => detection) as never,
      resolveEngine: resolveEngine as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete: (async () => ({
        text: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      })) as never,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox: vi.fn(),
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(resolveEngine).toHaveBeenCalledTimes(1);
    expect(resolveEngine.mock.calls[0][0].detection).toEqual(detection);
    expect(buildOmpEngine).toHaveBeenCalledTimes(1);
    expect(buildOmpEngine).toHaveBeenCalledWith(choice);
    expect(generate).toHaveBeenCalledTimes(1);
    const promptArg = generate.mock.calls[0][0];
    expect(Array.isArray(promptArg)).toBe(true);
    const messages = promptArg as Array<{ role: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");

    const setInputBox = deps.setInputBox as unknown as ReturnType<typeof vi.fn>;
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(api): wire commit gen");
  });
});

// ============================================================================
// Test #3 — edge: Lite model not configured
// ============================================================================
describe("ai/commitGenCommand — Test #3 lite model not configured", () => {
  it("shows the frozen settings toast and never collects a diff", async () => {
    const settings = fakeSettings({ modelId: "", engine: "omp" });
    const showSettingsToast = vi.fn().mockResolvedValue(undefined);
    const openSettings = vi.fn();
    const collectDiff = vi.fn(async () => fakeDiff());
    const builtinComplete = vi.fn(async () => ({
      text: "",
      toolCalls: [],
      finishReason: "stop" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => null) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete: builtinComplete as never,
      collectDiff: collectDiff as never,
      setInputBox: vi.fn(),
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast,
      openSettings,
    };

    await runGenerateCommitMessage(deps);

    expect(showSettingsToast).toHaveBeenCalledTimes(1);
    expect(showSettingsToast).toHaveBeenCalledWith(
      "Configure the Lite Model in UnicDB AI Settings to use Generate Commit Message",
      "Open Settings",
    );

    expect(collectDiff).not.toHaveBeenCalled();
    expect(builtinComplete).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(deps.setInputBox).not.toHaveBeenCalled();
  });

  it("calls openSettings() when the user picks the Open Settings action", async () => {
    const settings = fakeSettings({ modelId: "", engine: "omp" });
    const showSettingsToast = vi.fn().mockResolvedValue("Open Settings");
    const openSettings = vi.fn();

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => null) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: (async () => fakeOmpOneShot("")) as never,
      builtinComplete: (async () => ({
        text: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      })) as never,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox: vi.fn(),
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast,
      openSettings,
    };

    await runGenerateCommitMessage(deps);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Test #4 — edge: no changes
// ============================================================================
describe("ai/commitGenCommand — Test #4 no changes to summarize", () => {
  it("shows the empty-diff info toast and never calls the provider or omp", async () => {
    const settings = fakeSettings({ modelId: "lite", engine: "omp" });
    const showInfo = vi.fn();
    const builtinComplete = vi.fn(async () => ({
      text: "",
      toolCalls: [],
      finishReason: "stop" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => fakeConfig(settings)) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete: builtinComplete as never,
      collectDiff: (async () => null) as never,
      setInputBox: vi.fn(),
      showInfo,
      showError: vi.fn(),
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(showInfo).toHaveBeenCalledTimes(1);
    expect(showInfo).toHaveBeenCalledWith("UnicDB: no changes to summarize.");
    expect(builtinComplete).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(deps.setInputBox).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Test #5 — edge: builtin chosen but global config missing
// ============================================================================
describe("ai/commitGenCommand — Test #5 builtin chosen but no global config", () => {
  it("shows the base-URL settings toast and never calls the provider", async () => {
    const settings = fakeSettings({ modelId: "lite", engine: "builtin" });
    const showSettingsToast = vi.fn().mockResolvedValue(undefined);
    const builtinComplete = vi.fn(fakeBuiltinComplete({
      text: "should-not-be-used",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => null) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox: vi.fn(),
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast,
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(showSettingsToast).toHaveBeenCalledTimes(1);
    const [msg, action] = showSettingsToast.mock.calls[0];
    expect(msg).toContain("base URL");
    expect(msg).toContain("API key");
    expect(action).toBe("Open Settings");
    expect(builtinComplete).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(deps.setInputBox).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Test #6 — edge: provider throws
// ============================================================================
describe("ai/commitGenCommand — Test #6 provider throws", () => {
  it("surfaces the error via showError and never writes the input box", async () => {
    const settings = fakeSettings({ modelId: "lite", engine: "builtin" });
    const cfg = fakeConfig(settings);
    const showError = vi.fn();
    const setInputBox = vi.fn();
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => cfg) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete: fakeBuiltinComplete(new Error("network exploded")),
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox,
      showInfo: vi.fn(),
      showError,
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("network exploded");
    expect(setInputBox).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Test #7 — edge: omp down while lite.engine is omp
// ============================================================================
describe("ai/commitGenCommand — Test #7 omp down while lite.engine is omp", () => {
  it("does NOT silently fall back to builtin — shows error with hint", async () => {
    const settings = fakeSettings({ modelId: "lite", engine: "omp" });
    const detection: OmpDetection = {
      available: false,
      ok: false,
      reason: "not-installed",
    };
    const choice: EngineChoice = {
      engine: "builtin",
      requiresConfig: true,
      hint: "curl -fsSL https://omp.sh/install | sh",
    };
    const showError = vi.fn();
    const builtinComplete = vi.fn(fakeBuiltinComplete({
      text: "should-not-be-used",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => fakeConfig(settings)) as never,
      detectOmp: (async () => detection) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) =>
        choice) as never,
      buildOmpEngine,
      builtinComplete,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox: vi.fn(),
      showInfo: vi.fn(),
      showError,
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(showError).toHaveBeenCalledTimes(1);
    const errMsg = showError.mock.calls[0][0] as string;
    expect(errMsg).toContain("omp engine unavailable");
    expect(errMsg).toContain("curl -fsSL https://omp.sh/install | sh");

    expect(builtinComplete).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(deps.setInputBox).not.toHaveBeenCalled();
  });
});
