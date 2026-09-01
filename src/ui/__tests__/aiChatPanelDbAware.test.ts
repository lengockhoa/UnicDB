// src/ui/__tests__/aiChatPanelDbAware.test.ts — cycle AD TASK-001 TDD
// Host permission gate for the DB-aware tools (acceptance criteria 7 + 12)
// plus the cycle-AA DDL-only regression with the new tools in the registry.
//
// TASK-AIX03-102 — cases 1..4: panel observes
// ConnectionManager.onDidChangeRecoveryStatus, fail-closes in-flight turns on
// `recovering`/`failed`, ignores `recovered`, and swallows listener throws.

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: (...parts: unknown[]) => ({
      toString: () => parts.map((p) => String(p)).join("/"),
    }),
  },
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel = {
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => u),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(() => {
          (panel as { disposed: boolean }).disposed = true;
        }),
        visible: true,
        disposed: false,
      };
      // Push into the hoisted registry the new tests read.
      recoveryState.panels.push(panel as never);
      return panel;
    }),
  },
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: undefined },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import {
  AiChatPanel,
  DbToolPermissionGate,
  DB_TOOL_DENIED_MESSAGE,
  buildMessages,
  toolShapeSummary,
  summarizeToolOutcomeCard,
} from "../aiChatPanel";
import type { AgentDeps } from "../../ai/agent";
import type { ConnectionRecoveryStatus } from "../../core/connectionManager";
import type { OmpChatEngine } from "../../ai/omp/ompChatEngine";
import { createDbAwareTools } from "../../ai/tools/dbAwareTools";
import type { AgentTool } from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";
import type { DbAdapter } from "../../adapters/types";

function fakeTool(name = "run_readonly_query"): {
  tool: AgentTool;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    tool: {
      name,
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async (args: Record<string, unknown>) => {
        calls.push(args);
        return "TOOL-RAN";
      },
    },
  };
}

describe("DbToolPermissionGate", () => {
  it("posts a permission_request card on invocation", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("permission_request");
    expect(posted[0].tool.name).toBe("run_readonly_query");
    expect(posted[0].options.map((o: any) => o.optionId)).toEqual([
      "allow-once",
      "allow-session",
      "deny",
    ]);
    gate.respond(posted[0].requestId, "deny");
    await p;
  });

  it("Allow once runs the tool and returns its result", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    expect(await p).toBe("TOOL-RAN");
    expect(calls).toHaveLength(1);
  });

  it("Allow once does NOT persist — the next call re-asks", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const wrapped = gate.wrap(tool);
    const p1 = wrapped.execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    await p1;
    const p2 = wrapped.execute({});
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    gate.respond(posted[1].requestId, "deny");
    await p2;
  });

  it("Allow session skips the card for later calls of the same tool", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const wrapped = gate.wrap(tool);
    const p1 = wrapped.execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-session");
    await p1;
    expect(await wrapped.execute({})).toBe("TOOL-RAN");
    expect(posted).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("AIX-03: deny also posts a visible tool_result card", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    gate.respond(posted[0].requestId, "deny");
    const res = await p;
    expect(res).toBe(DB_TOOL_DENIED_MESSAGE);
    expect(calls).toHaveLength(0);
    const card = posted.find((m) => m.type === "tool_result");
    expect(card).toBeDefined();
    expect(card.tool).toBe("run_readonly_query");
    expect(card.status).toBe("denied");
    expect(card.summary).toContain("denied");
  });

  it("AIX-03: toolShapeSummary never leaks serialized sample row bytes", () => {
    const leaked = JSON.stringify({
      schema: { columns: [{ name: "email", type: "text" }] },
      count: 42,
      sample: "id | email\n---\n1 | secret@corp.example\n(1 of 3 rows)",
      relationships: [],
    });
    const card = toolShapeSummary(leaked);
    expect(card).not.toContain("secret@corp.example");
    expect(card).not.toContain("email");
    expect(card).toMatch(/JSON report/);
    // Table (multi-line) → line count only.
    expect(toolShapeSummary("id | email\n1 | a@b.c\n2 | d@e.f\n(2 of 9 rows)")).toBe(
      "4 lines (capped)",
    );
    // Opaque one-liner → token-capped.
    expect(toolShapeSummary("ok")).toBe("ok");
    // Top-level failure envelopes are NOT rendered as successes.
    const badId = JSON.stringify({ error: "bad_identifier", detail: "x" });
    expect(toolShapeSummary(badId)).toContain("JSON error");
    expect(toolShapeSummary(badId)).not.toContain("parts ok");
    const diagFail = JSON.stringify({ ok: false, class: "syntax", detail: "near FROM" });
    expect(toolShapeSummary(diagFail)).toBe("JSON report: ok=false");
  });

  it("AIX-03: summarizeToolOutcomeCard formats tool + status + shape", () => {
    expect(summarizeToolOutcomeCard("count_rows", "ok", "JSON report: 4 fields")).toBe(
      "✓ count_rows — JSON report: 4 fields",
    );
    expect(summarizeToolOutcomeCard("run_readonly_query", "failed", "boom")).toBe(
      "✗ run_readonly_query — failed: boom",
    );
    expect(summarizeToolOutcomeCard("count_rows", "denied", "")).toBe(
      "✗ count_rows — denied by user",
    );
  });

  it("AIX-03: allow posts ok outcome after run via describe/onToolResult flow", async () => {
    // The gate itself doesn't post ok — the agent loop does. Here we just
    // verify allow-only flow posts NO tool_result (card comes from
    // onToolResult in the panel during a real turn).
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    await p;
    expect(posted.find((m) => m.type === "tool_result")).toBeUndefined();
  });

  it("Deny returns the denial message and never runs the tool", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "deny");
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it("default-denies an unknown optionId", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "hacked-option");
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it("default-denies a missing optionId", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, undefined);
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
  });

  it("default-denies on timeout", async () => {
    vi.useFakeTimers();
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m), { timeoutMs: 1000 });
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    vi.advanceTimersByTime(1001);
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
    vi.useRealTimers();
  });

  it("cancelAll default-denies every outstanding request", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.cancelAll();
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
  });

  it("ignores a duplicate/late response", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    gate.respond(posted[0].requestId, "deny");
    expect(await p).toBe("TOOL-RAN");
    expect(calls).toHaveLength(1);
  });

  it("wraps all five DB-aware tools without changing their names", () => {
    const factory: AdapterFactory = async () => null;
    const gate = new DbToolPermissionGate(() => {});
    const names = createDbAwareTools(factory).map((t) => gate.wrap(t).name);
    expect(names).toEqual([
      "list_table_data_sample",
      "count_rows",
      "run_readonly_query",
      "explain_query",
      "get_table_relationships",
    ]);
  });
});

describe("cycle-AA regression: buildMessages stays DDL-only with DB-aware tools registered", () => {
  it("never calls runQuery and never leaks row bytes", async () => {
    const SENTINEL = "SENTINEL-ROW-DATA-AD";
    const runQuery = vi.fn(async () => ({
      results: [
        { columns: ["c"], rows: [[SENTINEL]], rowCount: 1, durationMs: 1 },
      ],
    }));
    const adapter = {
      runQuery,
      listSchemas: vi.fn(async () => [{ name: "public" }]),
      listTables: vi.fn(async () => [{ schema: "public", name: "users" }]),
      listViews: vi.fn(async () => []),
      listColumns: vi.fn(async () => [
        { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
      ]),
    } as unknown as DbAdapter;
    const factory: AdapterFactory = async () => adapter;

    // Tools exist in the registry for this turn; context build must ignore them.
    const tools = createDbAwareTools(factory);
    expect(tools).toHaveLength(5);

    const msgs = await buildMessages(factory, [], {
      role: "user",
      content: "hi",
    });
    const blob = JSON.stringify(msgs);
    expect(runQuery).not.toHaveBeenCalled();
    expect(blob).not.toContain(SENTINEL);
    expect(blob).toContain("users");
  });
});

// ============================================================================
// TASK-AIX03-102 — RLX-03 consumer seam: AiChatPanel observes
// ConnectionManager.onDidChangeRecoveryStatus and fail-closes an in-flight turn
// on `recovering` / `failed`; `recovered` is a no-op.
// ============================================================================

/**
 * Fake `vscode.Event<ConnectionRecoveryStatus>` — holds registered listeners
 * so the test can fire arbitrary statuses, inspect the exact listener count,
 * and recover the disposable the panel owns.
 */
function makeFakeRecoveryEvent(): {
  event: ((listener: (s: ConnectionRecoveryStatus) => void) => { dispose: () => void });
  fire: (s: ConnectionRecoveryStatus) => void;
  listenerCount: () => number;
  disposeSpies: Array<() => void>;
} {
  const listeners: Array<(s: ConnectionRecoveryStatus) => void> = [];
  const disposeSpies: Array<() => void> = [];
  return {
    event: (listener) => {
      listeners.push(listener);
      const d = vi.fn(() => {});
      disposeSpies.push(d);
      return { dispose: d };
    },
    fire: (s) => {
      for (const l of listeners.slice()) l(s);
    },
    listenerCount: () => listeners.length,
    disposeSpies,
  };
}

interface MockPanel2 {
  webview: {
    html: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const recoveryState = vi.hoisted(() => ({
  panels: [] as MockPanel2[],
  onDisposeCalls: 0,
}));

beforeEach(() => {
  recoveryState.panels.length = 0;
});

/** Poll a condition with real time slices (panel turns are multi-await). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Minimal valid AiConfig the fake deps.loadConfig can return. */
function fakeAiConfig() {
  return {
    baseUrl: "https://api.test/v1",
    method: "chat/completions" as const,
    timeoutMs: 60_000,
    maxSteps: 3,
    models: {
      work: { modelId: "m", vision: true },
      smart: { modelId: "m", vision: false },
      autocomplete: { modelId: "", vision: false },
    },
    engine: "builtin" as const,
    apiKey: "k",
  };
}

describe("AiChatPanel — recovery subscription seam (TASK-AIX03-102 case 1)", () => {
  it("subscribes to onDidChangeRecoveryStatus; `recovering` posts session_state:error and never an error bubble", () => {
    const fakeEv = makeFakeRecoveryEvent();
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: { fsPath: "/ext", toString: () => "file:///ext" } as never,
      deps: { loadConfig: vi.fn(async () => null), complete: vi.fn() } as AgentDeps,
      adapterFactory: factory,
      onDidChangeRecoveryStatus: fakeEv.event as never,
    });
    panel.show();
    // Force the panel into engine=="builtin" so handleStop reaches the
    // session_state post path used by all turn shapes. Without this,
    // handleReady hasn't run yet and the engine field stays undefined,
    // making the session_state:error skip its posted branch.
    (panel as unknown as { engine: string }).engine = "builtin";
    const mp = recoveryState.panels[recoveryState.panels.length - 1] as MockPanel2;

    // Exactly one listener — no fan-out, no duplicate subscription.
    expect(fakeEv.listenerCount()).toBe(1);
    // Fire the canonical `recovering` status from a fake ConnectionManager.
    fakeEv.fire({
      connectionId: "c1",
      state: "recovering",
      attempt: 1,
      maxAttempts: 2,
    });
    // Inspect what was posted AFTER the fire.
    const posted = mp.webview.postMessage.mock.calls.map((c) => c[0]);
    // Single session_state:error posted; no fabricated error bubble.
    const errorStates = posted.filter(
      (m) => (m as { type?: string }).type === "session_state" && (m as { state?: string }).state === "error",
    );
    const errorBubbles = posted.filter((m) => (m as { type?: string }).type === "error");
    expect(errorStates).toHaveLength(1);
    expect(errorBubbles).toHaveLength(0);
  });
});

describe("AiChatPanel — recovery/builtin turn (TASK-AIX03-102 case 2)", () => {
  it("`recovering` during a builtin turn aborts the AbortController, cancels the pending DbToolPermissionGate request, and posts session_state:error", async () => {
    const fakeEv = makeFakeRecoveryEvent();
    const factory: AdapterFactory = vi.fn(async () => null);
    // Deferred builtin turn: step 1 asks for the gated tool; step 2 blocks
    // on `streamGate` until the test releases it, so the turn is genuinely
    // in flight (pending permission card) when `recovering` fires.
    let releaseStream: (() => void) | null = null;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let providerSteps = 0;
    const agentDeps: AgentDeps = {
      loadConfig: vi.fn(async () => fakeAiConfig()),
      complete: vi.fn(async () => {
        providerSteps += 1;
        if (providerSteps === 1) {
          return {
            text: "",
            toolCalls: [
              {
                id: "tc-1",
                name: "run_readonly_query",
                argumentsJson: JSON.stringify({ sql: "SELECT 1" }),
              },
            ],
            finishReason: "tool_calls" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        // Later steps: hold until released (recovery lands first).
        await streamGate;
        return {
          text: "",
          toolCalls: [],
          finishReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }),
    } as unknown as AgentDeps;
    const panel = new AiChatPanel({
      extensionUri: { fsPath: "/ext", toString: () => "file:///ext" } as never,
      deps: agentDeps,
      adapterFactory: factory,
      onDidChangeRecoveryStatus: fakeEv.event as never,
    });
    panel.show();
    const mp = recoveryState.panels[recoveryState.panels.length - 1] as MockPanel2;
    // Drive a REAL builtin turn through the webview `send` message (the
    // same path the production webview uses). `ready` first so handleSend
    // routes to the builtin engine (options.acp is absent → builtin).
    const handleMessage = mp.webview.onDidReceiveMessage.mock
      .calls[0]![0] as unknown as (msg: unknown) => void;
    void handleMessage({ type: "ready" });
    const panelHandle = (panel as unknown as { engine: string | null });
    await until(() => panelHandle.engine === "builtin");
    void handleMessage({ type: "send", text: "run a query" });
    // Wait until the turn is truly in flight: the gate card for the
    // DB-aware tool has been posted (pending permission request exists).
    await until(() =>
      mp.webview.postMessage.mock.calls.some(
        (c) => (c[0] as { type?: string }).type === "permission_request",
      ),
    );
    const permRequest = mp.webview.postMessage.mock.calls
      .map((c) => c[0] as { type: string; requestId: string })
      .find((m) => m.type === "permission_request")!;
    // The panel's AbortController + ChatAbortToken exist mid-turn.
    const handle = (panel as unknown as {
      currentAbort: AbortController | null;
      token: { aborted: boolean } | null;
    });
    expect(handle.currentAbort).toBeInstanceOf(AbortController);
    expect(handle.token).not.toBeNull();
    const abortSpy = vi.spyOn(handle.currentAbort!, "abort");
    // Fire `recovering` mid-turn — the panel must fail-close.
    fakeEv.fire({
      connectionId: "c1",
      state: "recovering",
      attempt: 1,
      maxAttempts: 2,
    });
    // (a) The builtin branch of handleStop aborted the per-turn controller.
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(handle.token?.aborted).toBe(true);
    // (b) The pending DbToolPermissionGate request was cancelled by
    // handleStop → cancelAll: a late webview respond for the cancelled id
    // is ignored (the gate already default-denied it).
    const gate = (panel as unknown as {
      dbToolGate: DbToolPermissionGate;
    }).dbToolGate;
    expect(gate.respond(permRequest.requestId, "allow-once")).toBe(false);
    // Release the blocked provider step so the aborted turn can unwind,
    // then wait for the turn's finally to clear the token.
    releaseStream?.();
    await until(() => handle.token === null);
    // (c) The visible failure surface is the existing session_state:error —
    // posted exactly once by the recovery path, never an error bubble.
    const posted = mp.webview.postMessage.mock.calls.map((c) => c[0]) as Array<{
      type: string;
      state?: string;
      status?: string;
    }>;
    const errorStates = posted.filter(
      (m) => m.type === "session_state" && m.state === "error",
    );
    expect(errorStates).toHaveLength(1);
    expect(posted.filter((m) => m.type === "error")).toHaveLength(0);
    // The denial card for the cancelled gate request is visible.
    const deniedCards = posted.filter(
      (m) => m.type === "tool_result" && m.status === "denied",
    );
    expect(deniedCards.length).toBeGreaterThanOrEqual(1);
  });
});

describe("AiChatPanel — recovery/no-op (TASK-AIX03-102 case 2b)", () => {
  it("`recovered` after `recovering` cancels nothing and mutates no visible state", () => {
    const fakeEv = makeFakeRecoveryEvent();
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: { fsPath: "/ext", toString: () => "file:///ext" } as never,
      deps: { loadConfig: vi.fn(async () => null), complete: vi.fn() } as AgentDeps,
      adapterFactory: factory,
      onDidChangeRecoveryStatus: fakeEv.event as never,
    });
    panel.show();
    const mp = recoveryState.panels[recoveryState.panels.length - 1] as MockPanel2;
    const handle = (panel as unknown as {
      currentAbort: AbortController | null;
      token: { aborted: boolean } | null;
      engine: "builtin" | "omp" | "acp";
    });
    handle.engine = "builtin";
    handle.token = { aborted: false };
    handle.currentAbort = new AbortController();
    const abortSpy = vi.spyOn(handle.currentAbort, "abort");
    // First `recovering` settles the panel into error state.
    fakeEv.fire({
      connectionId: "c1",
      state: "recovering",
      attempt: 1,
      maxAttempts: 2,
    });
    const postedAfterRecovering = mp.webview.postMessage.mock.calls.map((c) => c[0]).slice();
    // Now emit `recovered` — must be a no-op.
    fakeEv.fire({
      connectionId: "c1",
      state: "recovered",
      attempt: 2,
      maxAttempts: 2,
    });
    // No additional abort() call.
    expect(abortSpy).toHaveBeenCalledTimes(1);
    // No new posted messages; the prior session_state:error remains the last state.
    const allPosted = mp.webview.postMessage.mock.calls.map((c) => c[0]);
    expect(allPosted).toEqual(postedAfterRecovering);
  });
});

describe("AiChatPanel — recovery/OMP turn (TASK-AIX03-102 case 3)", () => {
  it("`failed` during an OMP engine turn calls ompChatEngine.cancel() and posts session_state:error", () => {
    const fakeEv = makeFakeRecoveryEvent();
    const cancel = vi.fn();
    const engine = { cancel } as unknown as OmpChatEngine;
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: { fsPath: "/ext", toString: () => "file:///ext" } as never,
      deps: { loadConfig: vi.fn(async () => null), complete: vi.fn() } as AgentDeps,
      adapterFactory: factory,
      ompChatEngine: engine,
      onDidChangeRecoveryStatus: fakeEv.event as never,
    });
    panel.show();
    // Drive the panel into engine==="omp" without a real session — direct
    // field assignment is sufficient; handleStop branches on engine.
    (panel as unknown as { engine: string }).engine = "omp";
    const mp = recoveryState.panels[recoveryState.panels.length - 1] as MockPanel2;
    fakeEv.fire({
      connectionId: "c1",
      state: "failed",
      attempt: 2,
      maxAttempts: 2,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    const posted = mp.webview.postMessage.mock.calls.map((c) => c[0]);
    const errorStates = posted.filter(
      (m) => (m as { type?: string }).type === "session_state" && (m as { state?: string }).state === "error",
    );
    const errorBubbles = posted.filter((m) => (m as { type?: string }).type === "error");
    expect(errorStates).toHaveLength(1);
    expect(errorBubbles).toHaveLength(0);
  });
});

describe("AiChatPanel — listener containment (TASK-AIX03-102 case 4)", () => {
  it("recovery listener throws → the throw is swallowed at the subscription boundary; no message reaches the webview", async () => {
    const fakeEv = makeFakeRecoveryEvent();
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: { fsPath: "/ext", toString: () => "file:///ext" } as never,
      deps: { loadConfig: vi.fn(async () => null), complete: vi.fn() } as AgentDeps,
      adapterFactory: factory,
      onDidChangeRecoveryStatus: fakeEv.event as never,
    });
    panel.show();
    const mp = recoveryState.panels[recoveryState.panels.length - 1] as MockPanel2;
    // Provoke a REAL throw through the registered callback: arm the panel's
    // internals exactly like the busy-builtin case, then replace the
    // instance's DbToolPermissionGate with one whose cancelAll() throws
    // synchronously on entry. `handleRecoveryStatus` → `handleStop()` →
    // `dbToolGate.cancelAll()` → throw — the subscription's try/catch must
    // swallow it BEFORE `postSessionState("error")` runs, so NOTHING is
    // posted to the webview and nothing escapes to the emitter.
    const handle = (panel as unknown as {
      engine: "builtin" | "omp" | "acp";
      token: { aborted: boolean } | null;
      currentAbort: AbortController | null;
      dbToolGate: { cancelAll: () => void };
    });
    handle.engine = "builtin";
    handle.token = { aborted: false };
    handle.currentAbort = new AbortController();
    handle.dbToolGate = {
      cancelAll: () => {
        throw new Error("boom");
      },
    };
    const postedBefore = mp.webview.postMessage.mock.calls.length;
    let threw = false;
    try {
      fakeEv.fire({
        connectionId: "c1",
        state: "failed",
        attempt: 2,
        maxAttempts: 2,
      });
    } catch {
      threw = true;
    }
    // Emission never throws to the ConnectionManager emitter.
    expect(threw).toBe(false);
    // The swallow path emits NOTHING — not even session_state — because the
    // throw happened before postSessionState ran.
    expect(mp.webview.postMessage.mock.calls.length).toBe(postedBefore);
    // Sanity: the throwing gate was actually reached (the test exercises the
    // swallow path, not a vacuous fire).
    expect(handle.token?.aborted).toBe(true);
    // Give any stray async post a microtask to land, then re-assert nothing.
    await Promise.resolve();
    expect(mp.webview.postMessage.mock.calls.length).toBe(postedBefore);
  });
});
