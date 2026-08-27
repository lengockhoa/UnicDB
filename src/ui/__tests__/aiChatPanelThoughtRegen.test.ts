// src/ui/__tests__/aiChatPanelThoughtRegen.test.ts — TASK-001
// Host-side contract for `thought` (host → webview, live agent reasoning) and
// `regenerate` (webview → host, rerun-last-prompt).
//
// Mirrors the harness pattern from aiChatPanelAcp.test.ts: same FakeAcpDeps,
// FakeAcpTransport, feedAgentThoughtChunk, feedAgentMessageChunk,
// respondPrompt, panelHarness, until/flush. Tests are pure unit (no
// child-process spawn, no real omp).

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type {
  AgentDeps,
  AgentStep,
  AgentRunResult,
} from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";
import {
  AcpClient,
  type AcpTransport,
} from "../../ai/omp/acp";
import type { AcpProcessHandle } from "../../ai/omp/acpProcess";

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

// ---- vscode mock (mirrors aiChatPanelAcp.test.ts) ------------------------
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
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: undefined },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

const extUri = vscode.Uri.file("/ext");

const realSetImmediate = globalThis.setImmediate.bind(globalThis);
function tick(): Promise<void> {
  return new Promise((resolve) => realSetImmediate(resolve));
}
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
}
async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
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

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

function makeRunResult(steps: AgentStep[], finalText: string): AgentRunResult {
  return { steps, history: [], finalText, stoppedOnBudget: false };
}

class FakeAcpTransport implements AcpTransport {
  written: string[] = [];
  private listeners: Array<(line: string) => void> = [];
  private closed = false;
  write(line: string): void {
    if (this.closed) return;
    this.written.push(line);
  }
  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }
  close(): void {
    this.closed = true;
    this.listeners.length = 0;
  }
  feed(line: string): void {
    for (const cb of this.listeners.slice()) cb(line);
  }
  allWritten(): Array<Record<string, unknown>> {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

interface FakeAcpSession {
  acp: AcpClient;
  transport: FakeAcpTransport;
  exitListeners: Array<(code: number | null) => void>;
  disposeCalls: number;
  stderrTail: string;
  emitChildExit(code?: number | null): void;
}

interface FakeAcpDeps {
  start: (ompPath: string, cwd: string) => Promise<AcpProcessHandle>;
  sessions: FakeAcpSession[];
}

function makeFakeAcpDeps(): FakeAcpDeps {
  const sessions: FakeAcpSession[] = [];
  return {
    sessions,
    start: async (_ompPath: string, _cwd: string): Promise<AcpProcessHandle> => {
      const transport = new FakeAcpTransport();
      const acp = new AcpClient(transport);
      const session: FakeAcpSession = {
        acp,
        transport,
        exitListeners: [],
        disposeCalls: 0,
        stderrTail: "",
        emitChildExit(code: number | null = 0): void {
          const listeners = session.exitListeners.slice();
          session.exitListeners.length = 0;
          for (const cb of listeners) cb(code);
        },
      };
      session.exitListeners.push((_code) => {
        acp.dispose();
      });
      sessions.push(session);
      return {
        acp,
        sessionId: "sess-1",
        version: "18.0.1",
        getStderrTail: () => session.stderrTail,
        dispose: () => {
          session.disposeCalls += 1;
          transport.close();
          acp.dispose();
        },
      };
    },
  };
}

function feedAgentMessageChunk(
  transport: FakeAcpTransport,
  text: string,
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    }),
  );
}

function feedAgentThoughtChunk(
  transport: FakeAcpTransport,
  chunk: string,
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_thought_chunk", chunk },
      },
    }),
  );
}

function respondPrompt(
  transport: FakeAcpTransport,
  id: unknown,
  stopReason: string,
): void {
  transport.feed(
    JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } }),
  );
}

function lastPromptRequestId(transport: FakeAcpTransport): unknown {
  const frames = transport.allWritten().filter((f) => f["method"] === "session/prompt");
  const last = frames[frames.length - 1];
  return last?.["id"];
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

function isInit(m: unknown): m is { type: "init"; hasHistory: boolean } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isDelta(m: unknown): m is { type: "delta"; text: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "delta";
}
function isThought(m: unknown): m is { type: "thought"; text: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "thought";
}
function isAssistant(
  m: unknown,
): m is { type: "assistant"; text: string; markdown: boolean } {
  return (
    !!m && typeof m === "object" && (m as { type?: string }).type === "assistant"
  );
}
function isDone(m: unknown): m is { type: "done" } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}

interface PanelInternals {
  history: Array<{ role: string; content: string }>;
}
function internals(panel: AiChatPanel): PanelInternals {
  return panel as unknown as PanelInternals;
}

describe("AiChatPanel — thought forwarding (TASK-001 #2)", () => {
  it("#2 mid-turn agent_thought_chunk posts exactly one {type:'thought', text:chunk}; no delta side-effect", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    feedAgentThoughtChunk(session.transport, "thinking hard");
    await until(() => postedMessages(p).some(isThought));

    const thoughts = postedMessages(p).filter(isThought);
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toEqual({ type: "thought", text: "thinking hard" });
    expect(postedMessages(p).filter(isDelta)).toHaveLength(0);
    const asJson = JSON.stringify(thoughts);
    expect(asJson).not.toMatch(/api_?key/i);
    expect(asJson).not.toMatch(/sk-[a-z0-9]/i);
  });
});

describe("AiChatPanel — thought chunk malformed (TASK-001 #3)", () => {
  it("#3a no chunk field: zero thought posts", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_thought_chunk" },
        },
      }),
    );
    await flush(10);
    expect(postedMessages(p).filter(isThought)).toHaveLength(0);
  });

  it("#3b empty string chunk: zero thought posts, no throw", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    feedAgentThoughtChunk(session.transport, "");
    await flush(10);
    expect(postedMessages(p).filter(isThought)).toHaveLength(0);
  });
});

describe("AiChatPanel — thought after turn settled (TASK-001 #4)", () => {
  it("#4 late thought after done: dropped silently, no thought post", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    feedAgentMessageChunk(session.transport, "Hi");
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));

    feedAgentThoughtChunk(session.transport, "should-be-dropped");
    await flush(10);

    expect(postedMessages(p).filter(isThought)).toHaveLength(0);
    expect(postedMessages(p).filter(isDelta)).toHaveLength(1);
  });
});

describe("AiChatPanel — thought does not enter history or buffer (TASK-001 #5)", () => {
  it("#5 after a turn with 3 thought chunks + assistant text, history = [user, assistant]", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    feedAgentThoughtChunk(session.transport, "step 1");
    feedAgentThoughtChunk(session.transport, " step 2");
    feedAgentThoughtChunk(session.transport, " step 3");
    feedAgentMessageChunk(session.transport, "final answer");
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));

    const hist = internals(panel).history;
    expect(hist).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "final answer" },
    ]);
    const asJson = JSON.stringify(hist);
    expect(asJson).not.toContain("step 1");
    expect(asJson).not.toContain("step 2");
    expect(asJson).not.toContain("step 3");
    const assistants = postedMessages(p).filter(isAssistant);
    expect(assistants).toHaveLength(1);
    expect((assistants[0] as { text: string }).text).toBe("final answer");
  });
});

describe("AiChatPanel — regenerate while busy (TASK-001 #6)", () => {
  it("#6 in-flight regenerate: no second session/prompt, no duplicate turn", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "first" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    handler({ type: "regenerate" });
    await flush(10);

    const prompts = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/prompt");
    expect(prompts).toHaveLength(1);

    feedAgentMessageChunk(session.transport, "first answer");
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));
    expect(postedMessages(p).filter(isDone)).toHaveLength(1);
    expect(postedMessages(p).filter(isAssistant)).toHaveLength(1);
  });
});

describe("AiChatPanel — regenerate with empty history (TASK-001 #7)", () => {
  it("#7 fresh panel: regenerate is a no-op", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const beforeCount = postedMessages(p).length;
    expect(() => handler({ type: "regenerate" })).not.toThrow();
    await flush(10);
    expect(postedMessages(p).length).toBe(beforeCount);
  });
});

describe("AiChatPanel — regenerate reruns last user message (TASK-001 #8)", () => {
  it("#8 completed turn q1->a1 then regenerate: session/prompt re-sent with q1; history tail unchanged", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "q1" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);
    feedAgentMessageChunk(session.transport, "a1");
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));

    const histBefore = internals(panel).history.map((m) => m.content);
    expect(histBefore).toEqual(["q1", "a1"]);

    handler({ type: "regenerate" });
    await until(() =>
      session.transport
        .allWritten()
        .filter((f) => f["method"] === "session/prompt").length === 2,
    );

    const prompts = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/prompt");
    expect(prompts).toHaveLength(2);
    const secondParams = prompts[1]!["params"] as {
      prompt: Array<{ type: string; text: string }>;
    };
    const sentText = secondParams.prompt[0]?.text ?? "";
    expect(sentText).toContain("q1");

    feedAgentMessageChunk(session.transport, "a2");
    respondPrompt(
      session.transport,
      lastPromptRequestId(session.transport),
      "end_turn",
    );
    await until(() => postedMessages(p).filter(isDone).length === 2);

    const histAfter = internals(panel).history.map((m) => m.content);
    expect(histAfter).toEqual(["q1", "a2"]);
  });
});

describe("AiChatPanel — regenerate after stopped turn (TASK-001 #9)", () => {
  it("#9 history ends with [user]: regenerate re-sends the stopped user message", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "first" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);
    feedAgentMessageChunk(session.transport, "partial");
    handler({ type: "stop" });
    await until(() => postedMessages(p).some(isDone));

    const histBefore = internals(panel).history;
    expect(histBefore).toEqual([]);

    handler({ type: "regenerate" });
    await until(() =>
      session.transport
        .allWritten()
        .filter((f) => f["method"] === "session/prompt").length === 2,
    );

    const prompts = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/prompt");
    expect(prompts).toHaveLength(2);
    const secondParams = prompts[1]!["params"] as {
      prompt: Array<{ type: string; text: string }>;
    };
    const sentText = secondParams.prompt[0]?.text ?? "";
    expect(sentText).toContain("first");
  });
});

describe("AiChatPanel — thought forwarding regression (TASK-001 #10)", () => {
  it("#10 deltas + thought + permission all routed correctly; unknown kinds ignored", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    feedAgentThoughtChunk(session.transport, "reasoning aloud");
    feedAgentMessageChunk(session.transport, "Hello");
    feedAgentMessageChunk(session.transport, " world");
    await until(() =>
      postedMessages(p).some(
        (m) => isDelta(m) && (m as { text: string }).text === " world",
      ),
    );

    const deltas = postedMessages(p).filter(isDelta);
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe(
      "Hello world",
    );

    const thoughts = postedMessages(p).filter(isThought);
    expect(thoughts).toHaveLength(1);
    expect((thoughts[0] as { text: string }).text).toBe("reasoning aloud");

    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_end" },
        },
      }),
    );
    await flush(10);
    expect(postedMessages(p).filter(isThought)).toHaveLength(1);

    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "sess-1",
          toolCall: { id: "tool-7", name: "x", detail: "" },
          options: [{ optionId: "allow-once", label: "Allow once" }],
        },
      }),
    );
    await until(() =>
      postedMessages(p).some(
        (m) =>
          !!m &&
          typeof m === "object" &&
          (m as { type?: string }).type === "permission_request",
      ),
    );
    const reqs = postedMessages(p).filter(
      (m) =>
        !!m &&
        typeof m === "object" &&
        (m as { type?: string }).type === "permission_request",
    );
    expect(reqs).toHaveLength(1);
  });
});
