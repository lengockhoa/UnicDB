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

function fakeSettings(
  over: Partial<Pick<AiSettings, "engine"> & { lite: Partial<AiSettings["models"]["lite"]> }> = {},
): AiSettings {
  return {
    baseUrl: "https://example.com/v1",
    method: "chat/completions",
    timeoutMs: 60_000,
    maxSteps: 12,
    models: {
      work: { modelId: "w", vision: true },
      smart: { modelId: "s", vision: false },
      autocomplete: { modelId: "", vision: false },
      lite: { modelId: "m", vision: false, ...over.lite },
    },
    engine: over.engine ?? "builtin",
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

/** Provider-port fake with no canned value (returns empty text). */
function providerResult(text: string): ProviderResult {
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/**
 * Provider-port fake returning results by call index (last one repeats).
 * An `Error` entry is thrown so the branch's existing catch path runs.
 */
function fakeBuiltinSequence(
  results: readonly (ProviderResult | Error)[],
): CommitGenDeps["builtinComplete"] {
  let index = 0;
  return (async () => {
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as CommitGenDeps["builtinComplete"];
}

/** Omp one-shot fake returning strings by call index (last one repeats). */
function fakeOmpSequence(texts: readonly string[]): OmpOneShot {
  let index = 0;
  return {
    generate: async () => {
      const text = texts[Math.min(index, texts.length - 1)];
      index += 1;
      return text;
    },
  };
}

/** A 72-char lowercase-hex blob — the "carried bug" fixture (SPEC §10). */
const HEX_BLOB_72 = "deadbeef".repeat(9);

/**
 * Build a builtin-engine deps skeleton; individual ports can be overridden.
 * Keeps every guard-flow test focused on the port under assertion.
 */
function makeDeps(over: Partial<CommitGenDeps> = {}): CommitGenDeps {
  const settings = fakeSettings({ engine: "builtin", lite: { modelId: "lite" } });
  const cfg = fakeConfig(settings);
  return {
    loadSettings: (async () => settings) as never,
    loadConfig: (async () => cfg) as never,
    detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
    resolveEngine: ((_i: unknown) => ({
      engine: "builtin",
      requiresConfig: true,
    })) as never,
    buildOmpEngine: (async () => fakeOmpOneShot("")) as never,
    builtinComplete: (async () => providerResult("")) as never,
    collectDiff: (async () => fakeDiff()) as never,
    setInputBox: vi.fn(),
    showInfo: vi.fn(),
    showError: vi.fn(),
    showSettingsToast: vi.fn().mockResolvedValue(undefined),
    openSettings: vi.fn(),
    ...over,
  };
}

// ============================================================================
// Test #1 — happy path: builtin
// ============================================================================
describe("ai/commitGenCommand — Test #1 builtin happy path", () => {
  it("injects sanitized message into the input box via the builtin provider", async () => {
    const settings = fakeSettings({ engine: "builtin", lite: { modelId: "gpt-mini" } });
    const cfg = fakeConfig(settings);
    const rawText = "```\nfeat(db): thêm chỉ mục cho bảng users\n```";
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
    expect(setInputBox).toHaveBeenCalledWith("feat(db): thêm chỉ mục cho bảng users");
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
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "lite-1" } });
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
    const oneShot = fakeOmpOneShot("feat(api): nối commit gen vào omp");
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
    expect(buildOmpEngine).toHaveBeenCalledWith(choice, "lite-1");
    expect(generate).toHaveBeenCalledTimes(1);
    const promptArg = generate.mock.calls[0][0];
    expect(typeof promptArg).toBe("string");
    expect(promptArg).toContain("You generate git commit messages");
    expect(promptArg).toContain("Conventional Commits");
    expect(promptArg).toContain("tiếng Việt");
    expect(promptArg).toContain("Repo: UnicDB");
    expect(promptArg).toContain("src/a.ts");
    expect(promptArg).toContain("+// new");
    expect(promptArg).not.toContain("[object Object]");

    const setInputBox = deps.setInputBox as unknown as ReturnType<typeof vi.fn>;
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(api): nối commit gen vào omp");
  });
});

// ============================================================================
// Test #3 — edge: Lite model not configured
// ============================================================================
describe("ai/commitGenCommand — Test #3 lite model not configured", () => {
  it("shows the frozen settings toast and never collects a diff", async () => {
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "" } });
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
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "" } });
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
  it("shows the empty-diff error and never calls the provider or omp", async () => {
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "lite" } });
    const showError = vi.fn();
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
      showInfo: vi.fn(),
      showError,
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("nothing to commit");
    expect(showError.mock.calls[0][0]).toContain("no staged or unstaged changes");
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
    const settings = fakeSettings({ engine: "builtin", lite: { modelId: "lite" } });
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
    const settings = fakeSettings({ engine: "builtin", lite: { modelId: "lite" } });
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
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "lite" } });
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

// ============================================================================
// Test #8 — defence: builtin provider returns a non-string `text`
// ============================================================================
describe("ai/commitGenCommand — Test #8 builtin returns non-string text", () => {
  it("surfaces a structured Error and never writes the input box", async () => {
    const settings = fakeSettings({ engine: "builtin", lite: { modelId: "lite" } });
    const cfg = fakeConfig(settings);
    const built = {
      text: { junk: "object" }, // violates ProviderResult.text: string
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as ProviderResult;
    const builtinComplete = vi.fn(fakeBuiltinComplete(built));
    const setInputBox = vi.fn();
    const showError = vi.fn();

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => cfg) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: ((_i: { detection: OmpDetection; config: unknown }) => ({
        engine: "builtin",
        requiresConfig: true,
      })) as never,
      buildOmpEngine: (async () => fakeOmpOneShot("")) as never,
      builtinComplete: builtinComplete as never,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox,
      showInfo: vi.fn(),
      showError,
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("non-string");
    expect(setInputBox).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Test #9 — defence: omp one-shot returns a non-string
// ============================================================================
describe("ai/commitGenCommand — Test #9 omp one-shot returns non-string", () => {
  it("surfaces a structured Error and never writes the input box", async () => {
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "lite" } });
    const detection: OmpDetection = { available: true, ok: true, path: "/usr/bin/omp", version: "18.0.1" };
    const choice: EngineChoice = { engine: "omp", requiresConfig: false, path: "/usr/bin/omp", version: "18.0.1" };
    const oneShot: OmpOneShot = {
      generate: (async () => ({ oops: "object" }) as unknown as string),
    };
    const resolveEngine = vi.fn(() => choice);
    const buildOmpEngine = vi.fn(async () => oneShot);
    const setInputBox = vi.fn();
    const showError = vi.fn();

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
      setInputBox,
      showInfo: vi.fn(),
      showError,
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(buildOmpEngine).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("non-string");
    expect(setInputBox).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Test #10 — settings.engine === "claude-code" honored (falls back to
// builtin + surfaces the engine-specific hint)
// ============================================================================
describe("ai/commitGenCommand — Test #10 settings.engine = claude-code / codex", () => {
  it("claude-code: routes through builtinComplete AND emits the engine-specific toast", async () => {
    const settings = fakeSettings({ engine: "claude-code", lite: { modelId: "lite" } });
    const cfg = fakeConfig(settings);
    const resolveEngine = vi.fn(() => ({
      engine: "builtin",
      requiresConfig: false,
      hint: "npm i -g @anthropic-ai/claude-code",
    }));
    const builtinComplete = vi.fn(fakeBuiltinComplete({
      text: "feat(api): dự phòng qua builtin",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const showSettingsToast = vi.fn().mockResolvedValue(undefined);

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => cfg) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: resolveEngine as never,
      buildOmpEngine: (async () => fakeOmpOneShot("")) as never,
      builtinComplete,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox,
      showInfo: vi.fn(),
      showError,
      showSettingsToast,
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(resolveEngine).toHaveBeenCalledTimes(1);
    expect(builtinComplete).toHaveBeenCalledTimes(1);
    // The user's selection was honored in the sense that the engine setting
    // was the input to resolveEngine — but the runtime routed through the
    // builtin provider and surfaced a diagnostic toast with the install hint.
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(api): dự phòng qua builtin");
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("claude-code engine unavailable");
    expect(showError.mock.calls[0][0]).toContain(
      "npm i -g @anthropic-ai/claude-code",
    );
    expect(showSettingsToast).not.toHaveBeenCalled();
  });

  it("codex: same fallback contract, codex install hint surfaced", async () => {
    const settings = fakeSettings({ engine: "codex", lite: { modelId: "lite" } });
    const cfg = fakeConfig(settings);
    const resolveEngine = vi.fn(() => ({
      engine: "builtin",
      requiresConfig: false,
      hint: "npm i -g @openai/codex",
    }));
    const builtinComplete = vi.fn(fakeBuiltinComplete({
      text: "feat(api): dự phòng qua codex",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const setInputBox = vi.fn();
    const showError = vi.fn();

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => cfg) as never,
      detectOmp: (async () => ({ ok: false } as OmpDetection)) as never,
      resolveEngine: resolveEngine as never,
      buildOmpEngine: (async () => fakeOmpOneShot("")) as never,
      builtinComplete,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox,
      showInfo: vi.fn(),
      showError,
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(api): dự phòng qua codex");
    expect(showError.mock.calls[0][0]).toContain("codex engine unavailable");
    expect(showError.mock.calls[0][0]).toContain("npm i -g @openai/codex");
  });
});

// ============================================================================
// Guard flow — SPEC §8.4 / §8.5. The guard runs AFTER sanitize in every
// engine branch; invalid non-empty retries exactly once; terminal invalid
// surfaces the frozen toast and never touches the input box.
// ============================================================================
describe("ai/commitGenCommand — guard flow (SPEC §8.4/§8.5)", () => {
  // Row 2 — happy retry (builtin): garbage attempt 1 → VN attempt 2.
  it("builtin: retries once with the corrective prompt and injects attempt 2", async () => {
    const builtinComplete = vi.fn(
      fakeBuiltinSequence([
        providerResult(HEX_BLOB_72),
        providerResult("fix(db): sửa lỗi truy vấn chậm"),
      ]),
    );
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const deps = makeDeps({
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(2);
    const req2 = builtinComplete.mock.calls[1][1] as ProviderRequest;
    expect(req2.modelId).toBe("lite");
    expect(req2.maxOutputTokens).toBe(300);
    expect(req2.temperature).toBe(0.2);
    const userContent = req2.messages[1].content as string;
    expect(userContent).toContain("was rejected for these reasons");
    expect(userContent).toContain("unbroken-blob");
    expect(userContent).toContain("Vietnamese");
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("fix(db): sửa lỗi truy vấn chậm");
    expect(showError).not.toHaveBeenCalled();
  });

  // Row 3a — happy retry (omp): reasoning-leak attempt 1 → VN attempt 2.
  it("omp: retries once through the same engine and injects attempt 2", async () => {
    const settings = fakeSettings({ engine: "omp", lite: { modelId: "lite-1" } });
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
    const oneShot = fakeOmpSequence([
      "We need to examine the staged diff carefully",
      "feat(db): bổ sung chỉ mục cho bảng users",
    ]);
    const generate = vi.spyOn(oneShot, "generate");
    const buildOmpEngine = vi.fn(async () => oneShot);
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const deps = makeDeps({
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => fakeConfig(settings)) as never,
      detectOmp: (async () => detection) as never,
      resolveEngine: ((_i: unknown) => choice) as never,
      buildOmpEngine: buildOmpEngine as never,
      setInputBox,
      showError,
    });

    await runGenerateCommitMessage(deps);

    expect(buildOmpEngine).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(2);
    // Attempt 2 must carry the corrective retry prompt (serialized).
    const prompt2 = generate.mock.calls[1][0];
    expect(typeof prompt2).toBe("string");
    expect(prompt2).toContain("was rejected for these reasons");
    expect(prompt2).toContain("reasoning-marker");
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(db): bổ sung chỉ mục cho bảng users");
    expect(showError).not.toHaveBeenCalled();
  });

  // Row 3b — happy retry (claude-code fallback): hint toast fires exactly
  // once even though the engine is called twice.
  it("claude-code fallback: retries once and emits the hint toast only once", async () => {
    const settings = fakeSettings({ engine: "claude-code", lite: { modelId: "lite" } });
    const cfg = fakeConfig(settings);
    const builtinComplete = vi.fn(
      fakeBuiltinSequence([
        providerResult(HEX_BLOB_72),
        providerResult("fix(ui): sửa nhãn nút sparkle"),
      ]),
    );
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const deps = makeDeps({
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => cfg) as never,
      resolveEngine: (() => ({
        engine: "builtin",
        requiresConfig: false,
        hint: "npm i -g @anthropic-ai/claude-code",
      })) as never,
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(2);
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("fix(ui): sửa nhãn nút sparkle");
    // Hint fires once (attempt 1), NOT again on the retry attempt.
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("claude-code engine unavailable");
    expect(showError.mock.calls[0][0]).toContain("npm i -g @anthropic-ai/claude-code");
  });

  // Row 4 — terminal invalid (72-hex blob ×2): block, frozen toast, no inject.
  it("builtin: garbage twice blocks with the frozen toast and never injects", async () => {
    const builtinComplete = vi.fn(
      fakeBuiltinSequence([providerResult(HEX_BLOB_72), providerResult(HEX_BLOB_72)]),
    );
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const writeDebugArtifact = vi.fn(() => "/tmp/guard-rejected.txt");
    const deps = makeDeps({
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
      writeDebugArtifact: writeDebugArtifact as never,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(2);
    expect(setInputBox).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    const errMsg = showError.mock.calls[0][0] as string;
    expect(errMsg).toContain("failed validation");
    expect(errMsg).toContain("Retried once");
    expect(errMsg).toContain("unbroken-blob");
    expect(errMsg).toContain(HEX_BLOB_72);
    expect(writeDebugArtifact).toHaveBeenCalledTimes(1);
    const dump = writeDebugArtifact.mock.calls[0][0] as {
      label: string;
      body: string;
      context?: Record<string, unknown>;
    };
    expect(dump.label).toBe("commit-gen-guard-rejected");
    expect(dump.body).toBe(HEX_BLOB_72);
    expect(dump.context?.engine).toBe("builtin");
  });

  // Row 5 — length edge: an over-100-word message fails the cap on both
  // attempts. Multiline so the body survives sanitize's 72-char subject clamp
  // (a single line can never reach 100 words after that clamp).
  it("builtin: an over-100-word message fails twice with message-too-long", async () => {
    const longMessage =
      "feat(db): sửa truy vấn chậm\n\n" + new Array(120).fill("từ").join(" ");
    const builtinComplete = vi.fn(
      fakeBuiltinSequence([providerResult(longMessage), providerResult(longMessage)]),
    );
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const deps = makeDeps({
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(2);
    expect(setInputBox).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("message-too-long");
  });

  // Row 6a — empty on attempt 1: no retry, existing empty diagnostic.
  it("builtin: an empty attempt 1 shows the existing empty diagnostic and does NOT retry", async () => {
    const builtinComplete = vi.fn(fakeBuiltinSequence([providerResult("")]));
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const deps = makeDeps({
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(1);
    expect(setInputBox).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    const errMsg = showError.mock.calls[0][0] as string;
    expect(errMsg).toContain("provider returned no commit message text");
    expect(errMsg).not.toContain("failed validation");
  });

  // Row 6b — garbage then empty on attempt 2: same empty diagnostic with the
  // last raw, no guard toast, no third engine call.
  it("builtin: garbage then empty on attempt 2 falls into the empty diagnostic (no third call)", async () => {
    const builtinComplete = vi.fn(
      fakeBuiltinSequence([providerResult(HEX_BLOB_72), providerResult("")]),
    );
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const writeDebugArtifact = vi.fn(() => "/tmp/empty.txt");
    const deps = makeDeps({
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
      writeDebugArtifact: writeDebugArtifact as never,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(2);
    expect(setInputBox).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    const errMsg = showError.mock.calls[0][0] as string;
    expect(errMsg).toContain("provider returned no commit message text");
    expect(errMsg).not.toContain("failed validation");
    expect(writeDebugArtifact).toHaveBeenCalledTimes(1);
    const dump = writeDebugArtifact.mock.calls[0][0] as { label: string; body: string };
    expect(dump.label).toBe("commit-gen-empty");
    expect(dump.body).toBe("");
  });

  // Row 7 — transport: attempt 2 throws; the branch's existing catch wins.
  it("builtin: a throw on attempt 2 is mapped by the existing provider-error catch", async () => {
    const builtinComplete = vi.fn(
      fakeBuiltinSequence([
        providerResult(HEX_BLOB_72),
        new Error("network exploded"),
      ]),
    );
    const setInputBox = vi.fn();
    const showError = vi.fn();
    const deps = makeDeps({
      builtinComplete: builtinComplete as never,
      setInputBox,
      showError,
    });

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(2);
    expect(setInputBox).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError.mock.calls[0][0]).toContain("network exploded");
    expect(showError.mock.calls[0][0]).not.toContain("failed validation");
  });
});
