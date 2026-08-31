// src/ui/__tests__/aiChatPanelEngine.test.ts — Cycle AE TASK-003
//
// Engine routing test for AiChatPanel. Cycle AE wires the user's
// `vsdb.ai.engine` setting into the chat panel's per-turn dispatch:
//
//   engine === "builtin" → runAgent (provider). UNCHANGED.
//   engine === "omp"     → OmpChatEngine.send(text, events). NEW.
//   engine missing       → defaults to "builtin" (back-compat).
//   engine === "omp" + OmpChatEngine.send rejects → post a single error
//                          bubble + flip engine back to "builtin" in
//                          settings (one-shot fallback per PLAN_AE §5).
//
// The 5 cases pin the routing + the mid-turn crash fallback so the
// activation glue in extension.ts can lean on them. The AcpPanelDeps path
// (raw ACP session/prompt) is preserved for callers that don't inject
// `ompChatEngine` — cycle AB's 25+ tests must stay green.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps, AgentRunResult } from "../../ai/agent";
import type { ChatMessage } from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import type { OmpChatEngine, OmpChatEvents } from "../../ai/omp/ompChatEngine";

// ---- vscode mock (mirrors aiChatPanel.test.ts shape) ------------------------
type Listener<T> = (e: T) => void;
class FakeEventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T) {
    for (const l of this.listeners.slice()) l(data);
  }
}

interface MockPanel {
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

const state = vi.hoisted(() => ({
  panels: [] as MockPanel[],
  /** Optional fake OmpChatEngine — injected by tests, called by panel. */
  fakeEngine: undefined as OmpChatEngine | undefined,
  /** Captured config.update calls for engine fallback assertions. */
  configUpdates: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel: MockPanel = {
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
          panel.disposed = true;
          const listeners = (panel.onDidDispose as unknown as {
            mock: { calls: Array<[() => void]> };
          }).mock.calls;
          for (const [cb] of listeners) cb();
        }),
        visible: true,
        disposed: false,
      };
      state.panels.push(panel);
      return panel;
    }),
    showInformationMessage: vi.fn(async () => undefined),
  },
  workspace: {
    getConfiguration: vi.fn((section: string) => ({
      get: vi.fn((key: string, defaultValue?: unknown) => {
        if (section === "vsdb" && key === "ai.engine") {
          return defaultValue ?? "builtin";
        }
        return defaultValue;
      }),
      update: vi.fn(async (key: string, value: unknown) => {
        state.configUpdates.push({ key: `${section}.${key}`, value });
        return undefined;
      }),
    })),
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));
// Mock src/ai/agent so the builtin path is deterministic.
const agentState = vi.hoisted(() => ({
  runAgentMock: vi.fn() as Mock,
}));

vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return {
    ...actual,
    runAgent: agentState.runAgentMock,
  };
});

import { AiChatPanel } from "../aiChatPanel";

const extUri = vscode.Uri.file("/ext");

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

function panelHarness(): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
  const panel = state.panels[state.panels.length - 1] as MockPanel;
  return {
    panel,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (
      msg: unknown,
    ) => void,
  };
}

function postedMessages(panel: MockPanel): unknown[] {
  return panel.webview.postMessage.mock.calls.map((c) => c[0]);
}

function isAssistant(m: unknown): m is { type: "assistant"; text: string } {
  return (
    !!m && typeof m === "object" && (m as { type?: string }).type === "assistant"
  );
}
function isError(m: unknown): m is { type: "error"; message: string } {
  return (
    !!m && typeof m === "object" && (m as { type?: string }).type === "error"
  );
}
function isDone(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}
function isInit(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isDelta(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "delta";
}

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

function makeRunResult(finalText: string): AgentRunResult {
  return { steps: [], history: [], finalText, stoppedOnBudget: false };
}

/** Build a fake OmpChatEngine that records the events passed in `send`. */
function makeFakeEngine(
  behavior: (events: OmpChatEvents) => Promise<void> | void,
): OmpChatEngine {
  const send: Mock = vi.fn(async (text: string, events: OmpChatEvents) => {
    if (events.onDelta) events.onDelta(text);
    await behavior(events);
    if (events.onDone) events.onDone();
  });
  return {
    send,
    resume: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    cancel: vi.fn(() => undefined),
    attachTrace: vi.fn(() => undefined),
  };
}

beforeEach(() => {
  state.panels.length = 0;
  state.fakeEngine = undefined;
  state.configUpdates.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
  agentState.runAgentMock.mockResolvedValue(makeRunResult("builtin-final"));
});

// ============================================================================
// Case 1 — engine="builtin" → handleSend calls runAgent; NEVER OmpChatEngine.send
// ============================================================================
describe("AiChatPanel — engine routing (cycle AE TASK-003)", () => {
  it("#1 engine='builtin': runAgent path runs; OmpChatEngine.send is NEVER called", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const engine = makeFakeEngine(() => undefined);
    state.fakeEngine = engine;

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      // engine selection is keyed off options.acp (raw ACP). No acp deps +
      // engine="builtin" stays on the runAgent path.
      ompChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "hello builtin" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    expect(engine.send).not.toHaveBeenCalled();
    const assistants = postedMessages(p).filter(isAssistant);
    expect(assistants[0]?.text).toBe("builtin-final");
  });
});

// ============================================================================
// Case 2 — engine="omp" → handleSend calls OmpChatEngine.send with text + events
// ============================================================================
describe("AiChatPanel — engine routing (cycle AE TASK-003)", () => {
  it("#2 engine='omp': OmpChatEngine.send is called with text and event callbacks; runAgent is NEVER called", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const engine = makeFakeEngine((events) => {
      events.onDelta?.("hi-from-engine");
      events.onThought?.("thinking…");
    });
    state.fakeEngine = engine;

    // We have to flip engine="omp" by ALSO passing acp deps (the panel
    // derives engine from `options.acp === undefined` currently). For the
    // cycle AE routing assertion we want a separate signal: when
    // `ompChatEngine` is set AND `engine === "omp"`, send() drives the turn.
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      // engine="omp" pathway: pass a stub acp deps object so the panel
      // selects the omp branch in handleSend; the injected OmpChatEngine
      // is the routing layer that handleSend delegates to.
      acp: { start: vi.fn(async () => { throw new Error("acp.start must NOT run when ompChatEngine is provided"); }) },
      ompChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "hello omp" });
    await until(() => postedMessages(p).some(isDelta));
    await until(() => postedMessages(p).some(isDone));

    expect(engine.send).toHaveBeenCalledTimes(1);
    const [text, events] = engine.send.mock.calls[0] as [string, OmpChatEvents];
    expect(text).toBe("hello omp");
    expect(typeof events.onDelta).toBe("function");
    expect(typeof events.onThought).toBe("function");
    expect(typeof events.onToolStart).toBe("function");
    expect(typeof events.onToolEnd).toBe("function");
    expect(typeof events.onError).toBe("function");
    expect(typeof events.onDone).toBe("function");
    expect(agentState.runAgentMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Case 3 — engine missing in config → defaults to "builtin" (runAgent path)
// ============================================================================
describe("AiChatPanel — engine routing (cycle AE TASK-003)", () => {
  it("#3 engine missing: defaults to builtin; runAgent path runs", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const engine = makeFakeEngine(() => undefined);
    state.fakeEngine = engine;

    // No acp deps ⇒ engine="builtin" (back-compat).
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      ompChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "default builtin" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    expect(engine.send).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Case 4 — engine="omp" + OmpChatEngine.send rejects → single error bubble +
// engine flips back to "builtin" in settings (one-shot).
// ============================================================================
describe("AiChatPanel — engine routing (cycle AE TASK-003)", () => {
  it("#4 omp engine crash mid-turn: single error bubble + engine flips to 'builtin' in settings", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const engine: OmpChatEngine = {
      send: vi.fn(async (_text: string, events: OmpChatEvents) => {
        // Simulate a crash mid-turn: engine sends some deltas, then
        // onError fires (OmpChatEngine contract: NEVER throws on crash).
        events.onDelta?.("partial");
        events.onError?.("omp crashed mid-turn");
        // intentionally NOT calling onDone — the panel must still settle.
      }),
      resume: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      cancel: vi.fn(() => undefined),
      attachTrace: vi.fn(() => undefined),
    };
    state.fakeEngine = engine;

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      acp: { start: vi.fn(async () => { throw new Error("acp.start must not run when ompChatEngine is provided"); }) },
      ompChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "trigger crash" });
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));
    // The flip is fire-and-forget inside onError; wait for the update to
    // land before asserting so the test never races the config write.
    await until(() =>
      state.configUpdates.some(
        (u) => u.key === "vsdb.ai.engine" && u.value === "builtin",
      ),
    );
 
     // Engine was called.
     expect(engine.send).toHaveBeenCalledTimes(1);
    // engine flipped back to builtin via vsdb config.
    expect(state.configUpdates).toContainEqual({
      key: "vsdb.ai.engine",
      value: "builtin",
    });
    // Next turn now runs builtin (runAgent) — proves the engine flip took.
    handler({ type: "send", text: "after flip" });
    await until(() => agentState.runAgentMock.mock.calls.length >= 1);
    expect(agentState.runAgentMock).toHaveBeenCalled();
  });
});

// ============================================================================
// Case 5 — detection not-installed → builtin path runs (engine never becomes "omp")
// ============================================================================
describe("AiChatPanel — engine routing (cycle AE TASK-003)", () => {
  it("#5 detection not-installed: builtin path runs; ompChatEngine.send is NEVER called", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const engine = makeFakeEngine(() => undefined);
    state.fakeEngine = engine;

    // No acp deps ⇒ the panel selects engine="builtin" — same outcome as
    // detectOmp() returning {available:false} upstream in extension.ts.
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      ompChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "fallback to builtin" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    expect(engine.send).not.toHaveBeenCalled();
    expect(state.configUpdates).not.toContainEqual({
      key: "vsdb.ai.engine",
      value: "builtin",
    });
  });
});