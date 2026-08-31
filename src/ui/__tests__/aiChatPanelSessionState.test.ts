// src/ui/__tests__/aiChatPanelSessionState.test.ts — TASK-AIX05-001
//
// OMP turn-lifecycle state (session_state wire kind): the omp engine path
// must post connecting → running → done transitions so the webview shows
// live session state, not just the static engine banner. `running` posts
// exactly ONCE per turn (first stream event). Crash → `error` state before
// the error bubble. Harness mirrors aiChatPanelEngine.test.ts.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps } from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";
import type { OmpChatEngine, OmpChatEvents } from "../../ai/omp/ompChatEngine";

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
    getConfiguration: vi.fn(() => ({
      get: vi.fn((key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(async () => undefined),
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

const agentState = vi.hoisted(() => ({
  runAgentMock: vi.fn() as Mock,
}));
vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return { ...actual, runAgent: agentState.runAgentMock };
});

import { AiChatPanel } from "../aiChatPanel";

const extUri = vscode.Uri.file("/ext");

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

function panelHarness(): { panel: MockPanel; handler: (msg: unknown) => void } {
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

interface SessionStateMsg {
  type: "session_state";
  state: "connecting" | "running" | "done" | "error";
  turnId: string;
}
function isSessionState(m: unknown): m is SessionStateMsg {
  return (
    !!m && typeof m === "object" && (m as { type?: string }).type === "session_state"
  );
}
function isError(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
function isInit(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isDone(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

function makeFakeEngine(
  behavior: (events: OmpChatEvents) => Promise<void> | void,
): OmpChatEngine {
  return {
    send: vi.fn(async (text: string, events: OmpChatEvents) => {
      await behavior(events);
      events.onDone?.();
    }),
    resume: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    cancel: vi.fn(() => undefined),
    attachTrace: vi.fn(() => undefined),
  };
}

function makeOmpPanel(engine: OmpChatEngine): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
  const factory: AdapterFactory = vi.fn(async () => null);
  const p = new AiChatPanel({
    extensionUri: extUri,
    deps: makeDeps(),
    adapterFactory: factory,
    acp: { start: vi.fn(async () => { throw new Error("acp.start must not run"); }) },
    ompChatEngine: engine,
  });
  p.show();
  const h = panelHarness();
  h.handler({ type: "ready" });
  return h;
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
  agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "x", stoppedOnBudget: false });
});

describe("AiChatPanel — session_state (TASK-AIX05-001)", () => {
  it("clean omp turn posts connecting → running → done in order", async () => {
    const engine = makeFakeEngine((events) => {
      events.onDelta?.("chunk1");
      events.onThought?.("thinking");
    });
    const { panel: p, handler } = makeOmpPanel(engine);
    handler({ type: "send", text: "hello" });
    await until(() => postedMessages(p).some(isDone));

    const states = postedMessages(p).filter(isSessionState);
    expect(states.map((s) => s.state)).toEqual(["connecting", "running", "done"]);
    // one turnId across the trio
    expect(new Set(states.map((s) => s.turnId)).size).toBe(1);
    expect(states[0]!.turnId.length).toBeGreaterThan(0);
  });

  it("running posted exactly once per turn despite multiple stream events", async () => {
    const engine = makeFakeEngine((events) => {
      events.onDelta?.("a");
      events.onDelta?.("b");
      events.onDelta?.("c");
      events.onThought?.("t");
      events.onToolStart?.("list_tables");
    });
    const { panel: p, handler } = makeOmpPanel(engine);
    handler({ type: "send", text: "hello" });
    await until(() => postedMessages(p).some(isDone));

    const running = postedMessages(p).filter(
      (m) => isSessionState(m) && m.state === "running",
    );
    expect(running).toHaveLength(1);
  });

  it("crash posts error state before the error bubble", async () => {
    const engine: OmpChatEngine = {
      send: vi.fn(async (_text: string, events: OmpChatEvents) => {
        events.onDelta?.("partial");
        events.onError?.("omp crashed");
      }),
      resume: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      cancel: vi.fn(() => undefined),
      attachTrace: vi.fn(() => undefined),
    };
    const { panel: p, handler } = makeOmpPanel(engine);
    handler({ type: "send", text: "crash" });
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));

    const states = postedMessages(p).filter(isSessionState);
    const errorIdx = states.findIndex((s) => s.state === "error");
    expect(errorIdx).toBeGreaterThan(-1);
    const errorMsgIdx = postedMessages(p).findIndex(isError);
    expect(errorMsgIdx).toBeGreaterThan(-1);
    expect(postedMessages(p).indexOf(states[errorIdx]!)).toBeLessThan(errorMsgIdx);
  });
});
