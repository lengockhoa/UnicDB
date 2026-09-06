// src/ui/__tests__/commitGenIntegration.test.ts
// TASK-GC-008 — Integration / regression net for the Generate Commit Message
// cycle. Locks the cross-cycle contract end-to-end:
//
//   1. Manifest scan — package.json contributes.commands + menus["scm/title"]
//      agree on the frozen command id, title, category, icon, group, and
//      `when` clause (PLAN §1 frozen strings).
//   2. UX contract via the REAL handler — runGenerateCommitMessage (no
//      monkey-patching of internal modules) routes the lite model through
//      the injected engine ports: builtin path → setInputBox receives a
//      sanitized conventional message; omp path → buildOmpEngine used;
//      disabled-Lite → frozen toast + Open Settings action wired to
//      openSettings; empty diff → info toast and zero engine calls.
//   3. Sanitizer boundary via the real `sanitizeCommitMessage` — a 90-char
//      subject wrapped in ``` fences comes out fence-free and ≤72 chars
//      (regression net for the GC-003 sanitizer).
//
// Imports only public exports from GC-001/002/003/007 — no deep private-symbol
// pokes. Ports are faked (vi.fn), no vscode host is required.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  runGenerateCommitMessage,
  TOAST_NO_LITE,
  TOAST_NO_CHANGES,
  ACTION_OPEN_SETTINGS,
} from "../../ai/commitGenCommand";
import type {
  CommitGenDeps,
  CommitDiffInputLike,
  OmpOneShot,
} from "../../ai/commitGenCommand";
import {
  sanitizeCommitMessage,
  COMMIT_SUBJECT_MAX_CHARS,
} from "../../ai/commitMessage";
import type { AiSettings, AiConfig } from "../../ai/settings";
import type { EngineChoice } from "../../ai/engineChoice";
import type { OmpDetection } from "../../ai/omp/detect";
import type { ProviderRequest, ProviderResult } from "../../ai/provider";

// ---- frozen strings (mirror PLAN §1 table) --------------------------------
const NEW_COMMAND_ID = "UnicDB.generateCommitMessage";
const NEW_COMMAND_TITLE = "Generate Commit Message";
const NEW_COMMAND_CATEGORY = "UnicDB";
const NEW_COMMAND_ICON = "$(sparkle)";
const SCM_GROUP = "navigation";
const SCM_WHEN = "scmProvider == git && scmProviderHasChanges";

// ---- helpers ---------------------------------------------------------------

type Manifest = {
  contributes: {
    commands?: Array<Record<string, unknown>>;
    menus?: Record<string, Array<Record<string, unknown>> | undefined>;
  };
};

function loadManifest(): Manifest {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  return JSON.parse(raw) as Manifest;
}

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
    diffText: "+// new line",
  };
}

function fakeOmpOneShot(text: string): OmpOneShot {
  return { generate: async () => text };
}

function providerOk(text: string): ProviderResult {
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

// =============================================================================
// 1. Manifest scan — command + scm/title menu agree on the frozen id/shape.
// =============================================================================
describe("TASK-GC-008 #1 manifest ↔ command id agreement", () => {
  it("command entry has $(sparkle)/title/category, and the menu entry exists in scm/title with the frozen when clause", () => {
    const json = loadManifest();
    const commands = json.contributes.commands ?? [];
    const menus = json.contributes.menus ?? {};

    // Command declared with the exact frozen shape.
    const entry = commands.find((c) => c.command === NEW_COMMAND_ID);
    expect(entry).toBeDefined();
    expect(entry).toEqual({
      command: NEW_COMMAND_ID,
      title: NEW_COMMAND_TITLE,
      category: NEW_COMMAND_CATEGORY,
      icon: NEW_COMMAND_ICON,
    });

    // Menu entry in scm/title — command id matches and the when clause is
    // frozen verbatim per PLAN §1.
    const scmTitle = menus["scm/title"];
    expect(Array.isArray(scmTitle)).toBe(true);
    const menuEntry = (scmTitle as Array<Record<string, unknown>>).find(
      (m) => m.command === NEW_COMMAND_ID,
    );
    expect(menuEntry).toBeDefined();
    expect(menuEntry!.group).toBe(SCM_GROUP);
    expect(menuEntry!.when).toBe(SCM_WHEN);
  });
});

// =============================================================================
// 2. UX contract via the real handler — Test #2 builtin end-to-end.
// =============================================================================
describe("TASK-GC-008 #2 end-to-end builtin via the real handler", () => {
  it("injects the sanitized conventional message derived from the diff + provider reply", async () => {
    const settings = fakeSettings({ modelId: "gpt-mini", engine: "builtin" });
    const cfg = fakeConfig(settings);
    // Provider reply is fenced + has a trailing space — the sanitizer
    // (commitMessage.ts) must strip the fence and trim.
    const providerReply = "```\nfeat(db): add index\n```";

    const builtinComplete = vi.fn(
      async (_cfg: AiConfig, _req: ProviderRequest) => providerOk(providerReply),
    );
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));
    const setInputBox = vi.fn();

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
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    // The provider port was called with the Lite modelId.
    expect(builtinComplete).toHaveBeenCalledTimes(1);
    const reqArg = builtinComplete.mock.calls[0][1] as ProviderRequest;
    expect(reqArg.modelId).toBe("gpt-mini");

    // The omp port was NOT called.
    expect(buildOmpEngine).not.toHaveBeenCalled();

    // setInputBox received the SANITIZED message (fence stripped).
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(db): add index");
  });
});

// =============================================================================
// 3. Disabled-Lite UX contract — Test #3 (missing config edge).
// =============================================================================
describe("TASK-GC-008 #3 disabled-Lite UX contract", () => {
  it("shows the frozen toast + action, and openSettings() runs when the action resolves", async () => {
    const settings = fakeSettings({ modelId: "", engine: "omp" });

    const showSettingsToast = vi
      .fn()
      .mockResolvedValueOnce(ACTION_OPEN_SETTINGS);
    const openSettings = vi.fn();
    const collectDiff = vi.fn(async () => fakeDiff());
    const builtinComplete = vi.fn(async () =>
      providerOk("should-not-be-used"),
    );
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot(""));
    const setInputBox = vi.fn();

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
      setInputBox,
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast,
      openSettings,
    };

    await runGenerateCommitMessage(deps);

    // Frozen toast string + frozen action label, exact.
    expect(showSettingsToast).toHaveBeenCalledTimes(1);
    expect(showSettingsToast).toHaveBeenCalledWith(
      TOAST_NO_LITE,
      ACTION_OPEN_SETTINGS,
    );
    expect(TOAST_NO_LITE).toBe(
      "Configure the Lite Model in UnicDB AI Settings to use Generate Commit Message",
    );
    expect(ACTION_OPEN_SETTINGS).toBe("Open Settings");

    // Action was picked → openSettings ran.
    expect(openSettings).toHaveBeenCalledTimes(1);

    // Nothing downstream of the disabled-Lite guard fires.
    expect(collectDiff).not.toHaveBeenCalled();
    expect(builtinComplete).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(setInputBox).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 4. Empty diff cuts the chain — Test #4 (empty edge).
// =============================================================================
describe("TASK-GC-008 #4 empty diff cuts the chain", () => {
  it("shows the empty-diff info toast and never invokes either engine port", async () => {
    const settings = fakeSettings({ modelId: "lite-1", engine: "builtin" });
    const showInfo = vi.fn();
    const builtinComplete = vi.fn(async () => providerOk("unused"));
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot("unused"));
    const setInputBox = vi.fn();

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
      setInputBox,
      showInfo,
      showError: vi.fn(),
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(showInfo).toHaveBeenCalledTimes(1);
    expect(showInfo).toHaveBeenCalledWith(TOAST_NO_CHANGES);
    expect(TOAST_NO_CHANGES).toBe("UnicDB: no changes to summarize.");

    expect(builtinComplete).not.toHaveBeenCalled();
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(setInputBox).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 5. Engine routing — Test #5 (routing edge).
// =============================================================================
describe("TASK-GC-008 #5 engine routing switches with config", () => {
  it("omp-engine lite routes through buildOmpEngine and never touches builtinComplete", async () => {
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

    const resolveEngine = vi.fn(
      (_i: { detection: OmpDetection; config: unknown }) => choice,
    );
    const oneShot = fakeOmpOneShot("feat(api): route through omp");
    const buildOmpEngine = vi.fn(async (_c: EngineChoice) => oneShot);
    const builtinComplete = vi.fn(async () => providerOk("never-used"));
    const setInputBox = vi.fn();

    const deps: CommitGenDeps = {
      loadSettings: (async () => settings) as never,
      loadConfig: (async () => fakeConfig(settings)) as never,
      detectOmp: (async () => detection) as never,
      resolveEngine: resolveEngine as never,
      buildOmpEngine: buildOmpEngine as never,
      builtinComplete: builtinComplete as never,
      collectDiff: (async () => fakeDiff()) as never,
      setInputBox,
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(buildOmpEngine).toHaveBeenCalledTimes(1);
    expect(buildOmpEngine).toHaveBeenCalledWith(choice);
    expect(builtinComplete).not.toHaveBeenCalled();
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith("feat(api): route through omp");
  });

  it("builtin-engine lite routes through builtinComplete and never touches buildOmpEngine", async () => {
    const settings = fakeSettings({ modelId: "lite-1", engine: "builtin" });
    const cfg = fakeConfig(settings);

    const builtinComplete = vi.fn(
      async (_cfg: AiConfig, _req: ProviderRequest) =>
        providerOk("feat(api): route through builtin"),
    );
    const buildOmpEngine = vi.fn(async () => fakeOmpOneShot("never-used"));
    const setInputBox = vi.fn();

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
      showInfo: vi.fn(),
      showError: vi.fn(),
      showSettingsToast: vi.fn().mockResolvedValue(undefined),
      openSettings: vi.fn(),
    };

    await runGenerateCommitMessage(deps);

    expect(builtinComplete).toHaveBeenCalledTimes(1);
    expect(buildOmpEngine).not.toHaveBeenCalled();
    expect(setInputBox).toHaveBeenCalledTimes(1);
    expect(setInputBox).toHaveBeenCalledWith(
      "feat(api): route through builtin",
    );
  });
});

// =============================================================================
// 6. Sanitizer boundary — Test #6 (regression net via the real module).
// =============================================================================
describe("TASK-GC-008 #6 sanitizer boundary via the real module", () => {
  it("a 90-char fenced subject comes out ≤72 chars and fence-free", () => {
    // Build a subject that is exactly 90 chars long, wrap in ``` fences,
    // and confirm the sanitizer strips the fence + clamps the first line.
    const subject90 = "feat(db): " + "x".repeat(90 - "feat(db): ".length);
    expect(subject90.length).toBe(90);
    const fenced = "```\n" + subject90 + "\n```";

    const out = sanitizeCommitMessage(fenced);

    // 1. No ``` fences anywhere in the output.
    expect(out.includes("```")).toBe(false);

    // 2. The injected first line (the subject) is ≤72 chars — this is the
    //    exact COMMIT_SUBJECT_MAX_CHARS constant exported by the real
    //    sanitizer module.
    const firstLine = out.split("\n", 1)[0];
    expect(firstLine.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX_CHARS);
    expect(COMMIT_SUBJECT_MAX_CHARS).toBe(72);

    // 3. The subject's content is a prefix of the original 90-char string
    //    (the sanitizer does not invent characters — it only clamps).
    expect(subject90.startsWith(firstLine)).toBe(true);
    expect(firstLine.length).toBe(72);
  });
});