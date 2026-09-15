// src/ai/__tests__/capabilities.test.ts — TASK-CHATV2-002
//
// TDD coverage for the host-authoritative engine capability vocabulary
// (`src/ai/capabilities.ts`).
//
// Every expectation below is anchored to the frozen CHATV2-001 baseline
// (`docs/AI_HANDOFF/notes/chatv2-baseline.md` §1 capability matrix). A cell the
// audit recorded `unknown` (claude-code thought/bypass, codex tools/permissions)
// is advertised `false` here — parity is never inferred from a provider name.
//
// The module is PURE (no `vscode`, no fs, no net), so no harness mock is needed.
import { describe, it, expect } from "vitest";
import {
  resolveEngineCapabilities,
  AI_ENGINE_NAMES,
  type AiEngineName,
  type ChatModelRole,
  type EngineCapabilityInput,
  type EngineCapabilitySnapshot,
} from "../capabilities";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Active role configured WITH vision (the default settings shape). */
const WORK_VISION: readonly ChatModelRole[] = [
  { role: "work", modelId: "unic-sonnet", vision: true },
];
/** Active role configured WITHOUT vision. */
const WORK_NO_VISION: readonly ChatModelRole[] = [
  { role: "work", modelId: "unic-lite", vision: false },
];

const POLICY_ALLOW = {
  dbContext: true,
  workspaceContext: true,
  bypassAllowed: true,
} as const;

const POLICY_DENY_BYPASS = {
  dbContext: true,
  workspaceContext: true,
  bypassAllowed: false,
} as const;

/** Ready adapter + vision role + permissive policy: the "happy" snapshot. */
function snap(
  engine: AiEngineName,
  over: Partial<EngineCapabilityInput> = {},
): EngineCapabilitySnapshot {
  return resolveEngineCapabilities({
    engine,
    adapter: { state: "ready" },
    modelRoles: WORK_VISION,
    activeRole: "work",
    policy: POLICY_ALLOW,
    savedTranscriptResume: false,
    ...over,
  });
}

const SUPPORT_KEYS = [
  "bypassPermissions",
  "dbMentions",
  "engineCommands",
  "exportTranscript",
  "imageInput",
  "modelRoles",
  "nativeSessionResume",
  "permissions",
  "savedTranscriptResume",
  "streamText",
  "streamThought",
  "toolTimeline",
  "workspaceMentions",
] as const;

// ============================================================================
// #1 (unit) — all four snapshots match baseline evidence exactly
// ============================================================================
describe("resolveEngineCapabilities — four-engine matrix (TASK-CHATV2-002)", () => {
  // Baseline `docs/AI_HANDOFF/notes/chatv2-baseline.md` §1. `unknown` cells
  // (claude-code thought + bypass, codex tools + permissions) are `false`.
  const EXPECTED: Record<
    AiEngineName,
    { displayName: string; supports: EngineCapabilitySnapshot["supports"] }
  > = {
    builtin: {
      displayName: "Builtin",
      supports: {
        streamText: true,
        // AgentCallbacks exposes no onThought (baseline §1.1).
        streamThought: false,
        toolTimeline: true,
        imageInput: true,
        // No host session store (baseline §1.1).
        nativeSessionResume: false,
        savedTranscriptResume: false,
        // No provider command registry (baseline §1.1).
        engineCommands: false,
        permissions: true,
        bypassPermissions: true,
        modelRoles: true,
        workspaceMentions: true,
        dbMentions: true,
        exportTranscript: true,
      },
    },
    omp: {
      displayName: "OMP",
      supports: {
        streamText: true,
        streamThought: true,
        toolTimeline: true,
        // Panel forces visionCapable=false for omp (baseline §1.1).
        imageInput: false,
        nativeSessionResume: true,
        savedTranscriptResume: false,
        engineCommands: false,
        permissions: true,
        bypassPermissions: true,
        // omp owns its own model selection (baseline §1.1).
        modelRoles: false,
        workspaceMentions: true,
        dbMentions: true,
        exportTranscript: true,
      },
    },
    "claude-code": {
      displayName: "Claude Code",
      supports: {
        streamText: true,
        // onThought declared but never emitted (baseline §1.2).
        streamThought: false,
        toolTimeline: true,
        imageInput: true,
        nativeSessionResume: false,
        savedTranscriptResume: false,
        engineCommands: false,
        permissions: true,
        // No engine-level bypass toggle (baseline §1.2).
        bypassPermissions: false,
        modelRoles: false,
        workspaceMentions: true,
        dbMentions: true,
        exportTranscript: true,
      },
    },
    codex: {
      displayName: "Codex",
      supports: {
        streamText: true,
        streamThought: true,
        // No tool frame emitted (baseline §1.2).
        toolTimeline: false,
        imageInput: true,
        nativeSessionResume: false,
        savedTranscriptResume: false,
        engineCommands: false,
        // No approval/permission parsing (baseline §1.2).
        permissions: false,
        bypassPermissions: false,
        modelRoles: false,
        workspaceMentions: true,
        dbMentions: true,
        exportTranscript: true,
      },
    },
  };

  it("#1 every engine resolves engine/displayName/status/supports exactly", () => {
    for (const engine of AI_ENGINE_NAMES) {
      const s = snap(engine);
      const expected = EXPECTED[engine];
      expect(s.engine).toBe(engine);
      expect(s.displayName).toBe(expected.displayName);
      expect(s.status).toBe("ready");
      expect(s.supports).toEqual(expected.supports);
      // Nothing unavailable → no reason copy rides along.
      expect(s.reasonUnavailable).toBeUndefined();
    }
  });

  it("#1b supports is a closed 13-key object — no extra capability field", () => {
    const s = snap("omp");
    expect(Object.keys(s.supports).sort()).toEqual([...SUPPORT_KEYS]);
  });

  it("#1c display names come from a fixed allowlist (never raw input)", () => {
    const names = AI_ENGINE_NAMES.map((e) => snap(e).displayName);
    expect(names).toEqual(["Builtin", "OMP", "Claude Code", "Codex"]);
  });
});

// ============================================================================
// #2 (edge) — unavailable adapter
// ============================================================================
describe("resolveEngineCapabilities — unavailable adapter", () => {
  it("#2 unavailable adapter → status unavailable, safe reason, engine actions false", () => {
    const s = snap("omp", {
      adapter: { state: "unavailable", reason: "not-installed" },
    });
    expect(s.status).toBe("unavailable");
    expect(typeof s.reasonUnavailable).toBe("string");
    expect((s.reasonUnavailable ?? "").length).toBeGreaterThan(0);
    expect((s.reasonUnavailable ?? "").length).toBeLessThanOrEqual(160);
    // Every engine-dependent action is false.
    expect(s.supports.streamText).toBe(false);
    expect(s.supports.streamThought).toBe(false);
    expect(s.supports.toolTimeline).toBe(false);
    expect(s.supports.imageInput).toBe(false);
    expect(s.supports.nativeSessionResume).toBe(false);
    expect(s.supports.permissions).toBe(false);
    expect(s.supports.bypassPermissions).toBe(false);
    expect(s.supports.modelRoles).toBe(false);
    expect(s.supports.engineCommands).toBe(false);
  });

  it("#2b reasonUnavailable never echoes a raw / hostile adapter reason", () => {
    const hostile = "/opt/secret path/omp --apiKey=sk-live-9d2";
    const s = snap("omp", {
      adapter: { state: "unavailable", reason: hostile },
    });
    expect(s.reasonUnavailable).not.toContain(hostile);
    expect(s.reasonUnavailable).not.toContain("sk-live-9d2");
    expect(s.reasonUnavailable).not.toContain("/opt");
    expect(s.reasonUnavailable).toBe(
      "This engine is not available in the current workspace.",
    );
  });

  it("#2c known reason keys map to distinct safe copy", () => {
    const notInstalled = snap("omp", {
      adapter: { state: "unavailable", reason: "not-installed" },
    }).reasonUnavailable;
    const tooOld = snap("omp", {
      adapter: { state: "unavailable", reason: "version-too-old" },
    }).reasonUnavailable;
    expect(notInstalled).toBeDefined();
    expect(tooOld).toBeDefined();
    expect(notInstalled).not.toBe(tooOld);
    for (const copy of [notInstalled!, tooOld!]) {
      expect(copy.length).toBeLessThanOrEqual(160);
      expect(copy).not.toMatch(/api[_-]?key|secret|password|token/i);
    }
  });

  it("#2d host/policy features survive an unavailable engine (they are not engine features)", () => {
    const s = snap("codex", {
      adapter: { state: "unavailable", reason: "version-too-old" },
      savedTranscriptResume: true,
    });
    expect(s.supports.exportTranscript).toBe(true);
    expect(s.supports.savedTranscriptResume).toBe(true);
    expect(s.supports.dbMentions).toBe(true);
    expect(s.supports.workspaceMentions).toBe(true);
  });
});

// ============================================================================
// #3 (edge) — image support requires adapter AND active-model vision
// ============================================================================
describe("resolveEngineCapabilities — imageInput gate", () => {
  it("#3 vision model false → imageInput false even when transport can carry images", () => {
    for (const engine of ["builtin", "claude-code", "codex"] as const) {
      expect(snap(engine, { modelRoles: WORK_NO_VISION }).supports.imageInput).toBe(
        false,
      );
    }
  });

  it("#3b vision model true → imageInput follows the adapter's transport", () => {
    expect(snap("builtin").supports.imageInput).toBe(true);
    expect(snap("claude-code").supports.imageInput).toBe(true);
    expect(snap("codex").supports.imageInput).toBe(true);
    // omp never advertises image input (engine is the belt).
    expect(snap("omp").supports.imageInput).toBe(false);
    expect(snap("omp", { modelRoles: WORK_NO_VISION }).supports.imageInput).toBe(
      false,
    );
  });

  it("#3c no configured roles → no active vision → imageInput false", () => {
    expect(snap("codex", { modelRoles: [] }).supports.imageInput).toBe(false);
  });
});

// ============================================================================
// #4 (security) — bypass requires engine support AND effective policy
// ============================================================================
describe("resolveEngineCapabilities — bypass policy", () => {
  it("#4 policy denies bypass → bypassPermissions false for an engine that supports it", () => {
    const s = snap("builtin", { policy: POLICY_DENY_BYPASS });
    expect(s.supports.bypassPermissions).toBe(false);
    // A denied bypass never removes the engine's ask-first permission path.
    expect(s.supports.permissions).toBe(true);
  });

  it("#4b engine without a bypass control → false even when policy allows", () => {
    expect(snap("claude-code").supports.bypassPermissions).toBe(false);
    expect(snap("codex").supports.bypassPermissions).toBe(false);
  });

  it("#4c engine support + allowed policy → true (builtin/omp)", () => {
    expect(snap("builtin").supports.bypassPermissions).toBe(true);
    expect(snap("omp").supports.bypassPermissions).toBe(true);
  });

  it("#4d destructive SQL / workspace-trust gates are NOT representable in the snapshot", () => {
    const s = snap("builtin");
    const keys = Object.keys(s.supports);
    expect(keys.some((k) => /sql|destructive|trust|confirm/i.test(k))).toBe(false);
    // A caller mutating the returned bypass flag cannot re-enable it.
    expect(() => {
      (s.supports as { bypassPermissions: boolean }).bypassPermissions = true;
    }).toThrow();
    expect(Object.isFrozen(s.supports)).toBe(true);
  });
});

// ============================================================================
// #5 (regression) — native provider resume is never advertised unproven
// ============================================================================
describe("resolveEngineCapabilities — native resume", () => {
  it("#5 claude-code / codex never advertise provider-native resume", () => {
    expect(snap("claude-code").supports.nativeSessionResume).toBe(false);
    expect(snap("codex").supports.nativeSessionResume).toBe(false);
  });

  it("#5b claude-code / codex never advertise provider-native resume even when 'ready' on every adapter state", () => {
    for (const state of ["ready", "starting"] as const) {
      for (const engine of ["claude-code", "codex"] as const) {
        const s = snap(engine, { adapter: { state } });
        expect(s.supports.nativeSessionResume).toBe(false);
      }
    }
  });

  it("#5c saved UnicDB transcript resume is independent of engine + native resume", () => {
    for (const engine of AI_ENGINE_NAMES) {
      const s = snap(engine, { savedTranscriptResume: true });
      expect(s.supports.savedTranscriptResume).toBe(true);
      expect(s.supports.nativeSessionResume).toBe(
        engine === "omp", // only omp proves native resume in the baseline
      );
    }
  });
});

// ============================================================================
// #6 (boundary) — empty model roles
// ============================================================================
describe("resolveEngineCapabilities — empty model roles", () => {
  it("#6 empty roles → valid empty list and modelRoles=false", () => {
    const s = snap("builtin", { modelRoles: [] });
    expect(s.modelRoles).toEqual([]);
    expect(Array.isArray(s.modelRoles)).toBe(true);
    expect(s.supports.modelRoles).toBe(false);
  });

  it("#6b configured roles → frozen list carrying only role/modelId/vision", () => {
    const roles: ChatModelRole[] = [
      { role: "work", modelId: "unic-sonnet", vision: true },
      { role: "smart", modelId: "unic-opus", vision: false },
    ];
    const s = snap("builtin", { modelRoles: roles });
    expect(s.modelRoles).toEqual(roles);
    expect(s.supports.modelRoles).toBe(true);
    expect(Object.isFrozen(s.modelRoles)).toBe(true);
    expect(s.modelRoles.every((r) => Object.isFrozen(r))).toBe(true);
    expect(Object.keys(s.modelRoles[0]!).sort()).toEqual([
      "modelId",
      "role",
      "vision",
    ]);
  });

  it("#6c omp does not forward host role selection even with configured roles", () => {
    expect(snap("omp").supports.modelRoles).toBe(false);
  });
});

// ============================================================================
// status + commands + snapshot shape
// ============================================================================
describe("resolveEngineCapabilities — status, commands and shape", () => {
  it("starting adapter → status starting, engine actions stay advertised", () => {
    const s = snap("omp", { adapter: { state: "starting" } });
    expect(s.status).toBe("starting");
    expect(s.supports.streamText).toBe(true);
  });

  it("fallback → status fallback with safe reason, effective engine capabilities kept", () => {
    const s = snap("builtin", { fallbackFrom: "omp" });
    expect(s.status).toBe("fallback");
    expect(s.engine).toBe("builtin");
    expect(s.reasonUnavailable).toBeDefined();
    expect((s.reasonUnavailable ?? "").length).toBeLessThanOrEqual(160);
    expect(s.supports.streamText).toBe(true);
  });

  it("fallbackFrom equal to the effective engine is not a fallback", () => {
    expect(snap("builtin", { fallbackFrom: "builtin" }).status).toBe("ready");
  });

  it("unavailable outranks fallback", () => {
    const s = snap("builtin", {
      fallbackFrom: "omp",
      adapter: { state: "unavailable", reason: "not-installed" },
    });
    expect(s.status).toBe("unavailable");
  });

  it("commands are semantic descriptors from the implemented host registry", () => {
    const s = snap("builtin");
    expect(s.commands.length).toBeGreaterThan(0);
    expect(Object.isFrozen(s.commands)).toBe(true);
    for (const c of s.commands) {
      expect(c.source).toBe("universal");
      expect(typeof c.id).toBe("string");
      expect(typeof c.name).toBe("string");
      expect(c.name.startsWith("/")).toBe(false);
      expect(typeof c.description).toBe("string");
      expect(typeof c.available).toBe("boolean");
      // Never a raw CLI/provider command string.
      expect(c.id).not.toMatch(/[\s;|&$`]/);
    }
  });

  it("commands are capability-gated per engine (/resume is omp-only)", () => {
    const omp = snap("omp").commands.find((c) => c.id === "resume");
    const claude = snap("claude-code").commands.find((c) => c.id === "resume");
    expect(omp?.available).toBe(true);
    expect(claude?.available).toBe(false);
    expect(claude?.reason).toBeDefined();
  });

  it("dbMentions / workspaceMentions follow the effective policy decision", () => {
    const s = snap("builtin", {
      policy: { dbContext: false, workspaceContext: true, bypassAllowed: false },
    });
    expect(s.supports.dbMentions).toBe(false);
    expect(s.supports.workspaceMentions).toBe(true);
  });

  it("snapshot has exactly the specified fields and no sensitive/raw payload", () => {
    const s = snap("omp");
    expect(Object.keys(s).sort()).toEqual([
      "commands",
      "displayName",
      "engine",
      "modelRoles",
      "status",
      "supports",
    ]);
    const blob = JSON.stringify(s);
    expect(blob).not.toMatch(
      /api[_-]?key|password|connectionString|rawStderr|rawTrace|base64|secret|credential|permissionToken/i,
    );
    expect(blob).not.toContain("/opt/");
  });

  it("snapshot and its arrays are frozen", () => {
    const s = snap("omp");
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.commands)).toBe(true);
    expect(Object.isFrozen(s.modelRoles)).toBe(true);
  });

  it("unknown engine literal fails closed (exhaustive switch never-guard)", () => {
    expect(() =>
      resolveEngineCapabilities({
        engine: "copilot" as unknown as AiEngineName,
        adapter: { state: "ready" },
      }),
    ).toThrow(/engine/i);
  });

  it("input is not mutated by resolution", () => {
    const input: EngineCapabilityInput = {
      engine: "builtin",
      adapter: { state: "ready" },
      modelRoles: WORK_VISION,
      activeRole: "work",
      policy: POLICY_ALLOW,
    };
    const before = JSON.stringify(input);
    resolveEngineCapabilities(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
