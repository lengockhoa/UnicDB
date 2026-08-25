// src/ui/__tests__/aiChatPanelAcp.test.ts — TASK-004 ACP permission
// coordinator + panel session wiring.
//
// 6 cases covering: assistant text + permission_request routing; allow +
// deny with opaque IDs; late/duplicate/disposed responses ignored;
// default-deny on stop/dispose/exit/replacement/timeout; builtin regression
// after legacy rpc/process migration; no apiKey crosses the ACP path.
//
// Fake ACP-shaped deps:
//   - start(ompPath, cwd) returns a FakeAcpSession backed by an AcpTransport
//     whose `feed(line)` routes into a real AcpClient (so server requests
//     fire the panel's AcpServerRequestHandler with correlated IDs).
//
// These tests are pure unit — no child process spawn, no real omp.
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

/**
 * TASK-012 (B11): ensureAcpSession() now binds a real `node:http` listener
 * (McpBridge) before calling `acp.start()`. `server.listen()`'s callback
 * fires on I/O-completion, a macrotask — draining only the microtask queue
 * (plain `await Promise.resolve()`) never observes it, so `until`/`flush`
 * yield via `setImmediate` instead. setImmediate always drains any pending
 * microtasks first, so every assertion that previously relied on pure
 * microtask-tick counts still holds — this is a strict superset wait.
 *
 * The reference is captured at module load time, BEFORE any test can call
 * `vi.useFakeTimers()` (which replaces `globalThis.setImmediate` with a
 * fake that never fires without an explicit `advanceTimersByTimeAsync`).
 * Using the captured original keeps `until`/`flush` real-I/O-driven even
 * inside a fake-timers test (see "#5d timeout").
 */
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

interface PermissionRequestMsg {
  type: "permission_request";
  requestId: string;
  tool: { id: string; name: string; detail: string };
  options: Array<{ optionId: string; label: string }>;
}

function isPermissionRequest(m: unknown): m is PermissionRequestMsg {
  return (
    !!m &&
    typeof m === "object" &&
    (m as { type?: string }).type === "permission_request"
  );
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
  /** Fire the registered exit listeners — simulates real child process exit. */
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
        // Mirrors AcpProcess's post-handshake child-exit watchdog: when the
        // fake child "exits", dispose the AcpClient exactly once. That fires
        // AcpClient.onClose listeners (panel.cancelAllPending), which writes
        // a cancelled result per pending request before the transport is
        // closed. We deliberately do NOT close the transport here so writes
        // from onClose listeners actually reach `transport.written` for
        // assertions — the real AcpProcess disposes the client which closes
        // the transport last, but `FakeAcpTransport.write` only drops when
        // `close()` is explicitly called.
        emitChildExit(code: number | null = 0): void {
          const listeners = session.exitListeners.slice();
          session.exitListeners.length = 0;
          for (const cb of listeners) cb(code);
        },
      };
      // Production wiring (AcpProcess.onChildExit → disposeClient → acp.dispose).
      session.exitListeners.push((_code) => {
        acp.dispose();
      });
      sessions.push(session);
      return {
        acp,
        sessionId: "sess-1",
        version: "18.0.1",
        dispose: () => {
          session.disposeCalls += 1;
          transport.close();
          acp.dispose();
        },
      };
    },
  };
}

function feedPermissionRequest(
  transport: FakeAcpTransport,
  id: number,
  options: Array<{ optionId: string; label: string }>,
  toolName = "x",
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall: { id: `tool-${id}`, name: toolName, detail: "" },
        options,
      },
    }),
  );
}

// ACP `agent_message_chunk` carries `content: {type:"text", text}` — the
// SAME envelope `user_message_chunk` already uses (TASK-007 B2 fix). This
// fake must encode the real protocol, not the removed `delta` shape.
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

/** Find the `id` of the most recently written `session/prompt` request. */
function lastPromptRequestId(transport: FakeAcpTransport): unknown {
  const frames = transport.allWritten().filter((f) => f["method"] === "session/prompt");
  const last = frames[frames.length - 1];
  return last?.["id"];
}

/** Feed the `session/prompt` JSON-RPC RESPONSE — this is what settles a
 * turn in real ACP (`{stopReason: "end_turn" | "cancelled" | ...}`), never
 * a `session/update` notification. */
function respondPrompt(
  transport: FakeAcpTransport,
  id: unknown,
  stopReason: string,
): void {
  transport.feed(
    JSON.stringify({ jsonrpc: "2.0", id, result: { stopReason } }),
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
function feedPermissionRequestWithArgs(
  transport: FakeAcpTransport,
  id: number,
  options: Array<{ optionId: string; label: string }>,
  toolCall: Record<string, unknown>,
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "sess-1",
        toolCall,
        options,
      },
    }),
  );
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

// ============================================================================
// #1 — session/update assistant text posts delta only; permission request
// posts exactly one opaque pending request; agent_thought_chunk is ignored.
// ============================================================================
describe("AiChatPanel — ACP session/update routing", () => {
  it("#1 routes session/update deltas, posts one opaque permission_request, ignores agent_thought_chunk", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));

    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();

    feedAgentThoughtChunk(session.transport, "secret reasoning");
    feedAgentMessageChunk(session.transport, "Hello");
    feedAgentMessageChunk(session.transport, " world");
    await until(() =>
      postedMessages(p).some(
        (m) => isDelta(m) && (m as { text?: string }).text === " world",
      ),
    );

    const deltas = postedMessages(p).filter(isDelta);
    expect(deltas.map((d) => (d as { text: string }).text).join("")).toBe(
      "Hello world",
    );
    expect(JSON.stringify(postedMessages(p))).not.toMatch(/secret reasoning/);

    feedPermissionRequest(session.transport, 7, [
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ], "<b>run_sql</b>");
    await until(() => postedMessages(p).some(isPermissionRequest));
    const requests = postedMessages(p).filter(isPermissionRequest);
    expect(requests).toHaveLength(1);
    const req = requests[0] as PermissionRequestMsg;
    expect(typeof req.requestId).toBe("string");
    expect(req.requestId.length).toBeGreaterThan(0);
    expect(req.tool.name).toBe("<b>run_sql</b>");
    expect(req.options.map((o) => o.optionId)).toEqual(["allow-once", "deny"]);
    const reqJson = JSON.stringify(requests);
    expect(reqJson).not.toMatch(/api_?key/i);
    expect(reqJson).not.toMatch(/sk-[a-z0-9]/i);
  });
});

// ============================================================================
// #2 — Allow posts exactly one ACP result for matching opaque ID using a
// listed option.
// ============================================================================
describe("AiChatPanel — ACP permission Allow", () => {
  it("#2 Allow posts exactly one ACP result for matching opaque ID with the chosen listed option", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 11, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));
    const requestId = (postedMessages(p).find(isPermissionRequest) as PermissionRequestMsg)
      .requestId;

    handler({ type: "permission_response", requestId, optionId: "allow" });
    await until(() =>
      session.transport
        .allWritten()
        .some(
          (f) =>
            f["id"] === 11 &&
            f["result"] !== undefined &&
            JSON.stringify(f["result"]).includes("selected"),
        ),
    );

    const resultFrames = session.transport
      .allWritten()
      .filter((f) => f["id"] === 11);
    expect(resultFrames).toHaveLength(1);
    const result = resultFrames[0]!["result"] as {
      outcome: { outcome: string; optionId?: string };
    };
    expect(result.outcome.outcome).toBe("selected");
    expect(result.outcome.optionId).toBe("allow");
  });
});

// ============================================================================
// #3 — Deny posts exactly one ACP cancelled result for the matching opaque ID;
// no optionId is forwarded.
// ============================================================================
describe("AiChatPanel — ACP permission Deny", () => {
  it("#3 Deny posts exactly one ACP cancelled result for matching opaque ID; no optionId", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 22, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));
    const requestId = (postedMessages(p).find(isPermissionRequest) as PermissionRequestMsg)
      .requestId;

    handler({ type: "permission_response", requestId });
    await until(() =>
      session.transport
        .allWritten()
        .some(
          (f) =>
            f["id"] === 22 &&
            f["result"] !== undefined &&
            JSON.stringify(f["result"]).includes("cancelled"),
        ),
    );

    const resultFrames = session.transport
      .allWritten()
      .filter((f) => f["id"] === 22);
    expect(resultFrames).toHaveLength(1);
    const result = resultFrames[0]!["result"] as {
      outcome: { outcome: string; optionId?: string };
    };
    expect(result.outcome.outcome).toBe("cancelled");
    expect(result.outcome.optionId).toBeUndefined();
  });
});

// ============================================================================
// #4 — duplicate / disposed / out-of-scope / late webview responses are
// ignored; only the first matching response writes an ACP result.
// ============================================================================
describe("AiChatPanel — permission response deduplication", () => {
  it("#4 duplicate / out-of-scope / late webview responses are ignored", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 30, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));
    const requestId = (postedMessages(p).find(isPermissionRequest) as PermissionRequestMsg)
      .requestId;

    handler({ type: "permission_response", requestId, optionId: "allow" });
    await flush(20);
    handler({ type: "permission_response", requestId, optionId: "allow" });
    handler({
      type: "permission_response",
      requestId: "unknown",
      optionId: "allow",
    });
    handler({ type: "permission_response", requestId });
    await flush(20);

    const resultFrames = session.transport
      .allWritten()
      .filter((f) => f["id"] === 30);
    expect(resultFrames).toHaveLength(1);
    const errs = postedMessages(p).filter(isError);
    expect(errs).toHaveLength(0);
  });
});

// ============================================================================
// #5 — stop / dispose / exit / replacement / timeout settle every pending
// request with one cancelled ACP result.
// ============================================================================
describe("AiChatPanel — permission default-deny coordinator", () => {
  it("#5a stop: every pending request gets one cancelled ACP result, late writes ignored", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 41, [
      { optionId: "allow", label: "Allow" },
    ]);
    feedPermissionRequest(session.transport, 42, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(
      () => postedMessages(p).filter(isPermissionRequest).length === 2,
    );

    handler({ type: "stop" });
    await until(
      () =>
        session.transport.allWritten().filter((f) => f["id"] === 41).length ===
          1 &&
        session.transport.allWritten().filter((f) => f["id"] === 42).length ===
          1,
    );

    const r1 = session.transport
      .allWritten()
      .filter((f) => f["id"] === 41)[0]!["result"] as {
      outcome: { outcome: string };
    };
    const r2 = session.transport
      .allWritten()
      .filter((f) => f["id"] === 42)[0]!["result"] as {
      outcome: { outcome: string };
    };
    expect(r1.outcome.outcome).toBe("cancelled");
    expect(r2.outcome.outcome).toBe("cancelled");

    // Late responses ignored.
    for (const r of postedMessages(p).filter(isPermissionRequest)) {
      handler({
        type: "permission_response",
        requestId: r.requestId,
        optionId: "allow",
      });
    }
    await flush(20);
    expect(
      session.transport.allWritten().filter((f) => f["id"] === 41).length,
    ).toBe(1);
  });
  it("#5b process exit: pending requests settled with cancelled ACP result", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 51, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));
    // Process exit: simulate the real `omp acp` child exiting after handshake.
    // The fake's exit listener mirrors AcpProcess.onChildExit → disposeClient
    // → acp.dispose → onClose fires → panel.cancelAllPending. This is the
    // production default-deny path; it must NOT cheat by calling
    // `session.acp.dispose()` directly.
    session.emitChildExit(0);
    await until(
      () =>
        session.transport.allWritten().filter((f) => f["id"] === 51).length ===
        1,
    );
    const r = session.transport
      .allWritten()
      .filter((f) => f["id"] === 51)[0]!["result"] as {
      outcome: { outcome: string };
    };
    expect(r.outcome.outcome).toBe("cancelled");

  });
  it("#5c panel dispose: pending requests settled with cancelled ACP result", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 61, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));

    panel.dispose();
    await flush(20);
    const resultFrames = session.transport
      .allWritten()
      .filter((f) => f["id"] === 61);
    expect(resultFrames).toHaveLength(1);
    const r = resultFrames[0]!["result"] as { outcome: { outcome: string } };
    expect(r.outcome.outcome).toBe("cancelled");
  });

  it("#5d timeout: pending requests settled with cancelled ACP result", async () => {
    vi.useFakeTimers();
    try {
      agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
      const { start, sessions } = makeFakeAcpDeps();
      const panel = new AiChatPanel(
        {
          extensionUri: extUri,
          deps: makeDeps(),
          adapterFactory: vi.fn(async () => null),
          acp: { start },
        },
        { permissionTimeoutMs: 30 },
      );
      panel.show();
      const { panel: p, handler } = panelHarness();
      handler({ type: "ready" });
      await until(() => postedMessages(p).some((m) => isInit(m)));
      handler({ type: "send", text: "go" });
      await until(() => sessions.length > 0);
      const session = sessions[0] as FakeAcpSession;
      await flush();
      feedPermissionRequest(session.transport, 71, [
        { optionId: "allow", label: "Allow" },
      ]);
      await until(() => postedMessages(p).some(isPermissionRequest));
      // Drive fake timers past the permission timeout (30ms).
      await vi.advanceTimersByTimeAsync(60);
      const resultFrames = session.transport
        .allWritten()
        .filter((f) => f["id"] === 71);
      expect(resultFrames.length).toBeGreaterThanOrEqual(1);
      const r = resultFrames[0]!["result"] as {
        outcome: { outcome: string };
      };
      expect(r.outcome.outcome).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#5e replacement: second send settles prior pending requests with cancelled result", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "first" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 81, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));

    handler({ type: "send", text: "second" });
    await until(
      () =>
        session.transport.allWritten().filter((f) => f["id"] === 81).length ===
        1,
    );
    const r = session.transport
      .allWritten()
      .filter((f) => f["id"] === 81)[0]!["result"] as {
      outcome: { outcome: string };
    };
    expect(r.outcome.outcome).toBe("cancelled");
  });

  it("#5f unlisted optionId is treated as deny (default-deny)", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();
    feedPermissionRequest(session.transport, 91, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));
    const requestId = (postedMessages(p).find(isPermissionRequest) as PermissionRequestMsg)
      .requestId;

    handler({
      type: "permission_response",
      requestId,
      optionId: "rogue-option",
    });
    await until(
      () =>
        session.transport.allWritten().filter((f) => f["id"] === 91).length ===
        1,
    );
    const r = session.transport
      .allWritten()
      .filter((f) => f["id"] === 91)[0]!["result"] as {
      outcome: { outcome: string };
    };
    expect(r.outcome.outcome).toBe("cancelled");
  });
});

// ============================================================================
// #6 — builtin fallback path still posts final assistant + done; legacy
// RPC/process code removed (regression).
// ============================================================================
describe("AiChatPanel — builtin fallback regression (TASK-004 #6)", () => {
  it("#6 no acp deps: builtin runAgent path still posts final assistant + done", async () => {
    agentState.runAgentMock.mockImplementation(async () =>
      makeRunResult([], "builtin-final"),
    );
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "hi" });
    await until(() => postedMessages(p).some((m) => isAssistant(m)));
    await until(() => postedMessages(p).some(isDone));
    expect(agentState.runAgentMock).toHaveBeenCalled();
    const assistants = postedMessages(p).filter(
      (m) => isAssistant(m),
    ) as Array<{ text: string }>;
    expect(assistants[0]?.text).toBe("builtin-final");
    expect(postedMessages(p).some(isDone)).toBe(true);
  });
});

// ============================================================================
// TASK-001 #6 — Host builds the detail string via the sanitizer; opaque
// requestId stays host-generated; options untouched.
// ============================================================================
describe("AiChatPanel — permission detail sanitizer (TASK-001 #6)", () => {
  it("#6a posted permission_request carries built detail + opaque ID unchanged", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();

    feedPermissionRequestWithArgs(session.transport, 100, [
      { optionId: "allow-once", label: "Allow once" },
      { optionId: "deny", label: "Deny" },
    ], {
      id: "tool-server-xyz",
      name: "describe_table",
      arguments: { schema: "public", table: "users", api_key: "sk-1" },
    });
    await until(() => postedMessages(p).some(isPermissionRequest));

    const reqs = postedMessages(p).filter(isPermissionRequest);
    expect(reqs).toHaveLength(1);
    const req = reqs[0] as PermissionRequestMsg;
    expect(req.requestId.startsWith("req-")).toBe(true);
    expect(req.requestId).not.toBe("tool-server-xyz");
    expect(req.tool.id).toBe("tool-server-xyz");
    expect(req.tool.name).toBe("describe_table");
    expect(req.tool.detail).toContain("[redacted]");
    expect(req.tool.detail).not.toContain("sk-1");
    expect(req.tool.detail).toContain("public");
    expect(req.tool.detail).toContain("users");
    expect(req.options.map((o) => o.optionId)).toEqual([
      "allow-once",
      "deny",
    ]);
    expect(req.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Deny",
    ]);
  });

  it("#6b run_sql toolCall renders SQL preview in posted detail", async () => {
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
    await until(() => postedMessages(p).some((m) => isInit(m)));
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await flush();

    feedPermissionRequestWithArgs(session.transport, 101, [
      { optionId: "allow", label: "Allow" },
    ], {
      id: "t1",
      name: "run_sql",
      arguments: { sql: "SELECT 1 FROM t" },
    });
    await until(() => postedMessages(p).some(isPermissionRequest));
    const req = postedMessages(p).find(isPermissionRequest) as PermissionRequestMsg;
    expect(req.tool.detail).toBe("SQL:\nSELECT 1 FROM t");
  });
});

// ============================================================================
// TASK-007 — ACP turn lifecycle. The turn settles on the `session/prompt`
// RESPONSE ({stopReason}), never on a `session/update` notification (ACP has
// no `agent_end`/`turn_complete` kind). agent_message_chunk carries
// `content: {type:"text", text}` — same envelope user_message_chunk already
// uses. 14 cases from TASK-007.md §Test Cases.
// ============================================================================
describe("AiChatPanel — ACP turn lifecycle (TASK-007)", () => {
  function schemaAdapter(): {
    listSchemas: Mock;
    listTables: Mock;
    listViews: Mock;
    listColumns: Mock;
  } {
    return {
      listSchemas: vi.fn(async () => [{ name: "public" }]),
      listTables: vi.fn(async (schema: string) =>
        schema === "public" ? [{ name: "users", schema: "public" }] : [],
      ),
      listViews: vi.fn(async () => []),
      listColumns: vi.fn(async () => [
        { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
      ]),
    };
  }

  // ---- Happy #1 — full ACP turn: delta, assistant, done — in order, once each.
  it("Happy#1 full ACP turn: delta(\"Hi\") then assistant(\"Hi\", markdown) then done, in order, exactly once each", async () => {
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
    await until(() => postedMessages(p).some(isDelta));
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");

    await until(() => postedMessages(p).some(isDone));
    const posted = postedMessages(p);
    const deltas = posted.filter(isDelta);
    const assistants = posted.filter(isAssistant);
    const dones = posted.filter(isDone);
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as { text: string }).text).toBe("Hi");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: "Hi", markdown: true });
    expect(dones).toHaveLength(1);
    const deltaIdx = posted.findIndex(isDelta);
    const assistantIdx = posted.findIndex(isAssistant);
    const doneIdx = posted.findIndex(isDone);
    expect(deltaIdx).toBeLessThan(assistantIdx);
    expect(assistantIdx).toBeLessThan(doneIdx);
  });

  // ---- Happy #2 — history append.
  it("Happy#2 history append: after the turn, history ends with {role:assistant, content:'Hi'}", async () => {
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

    const history = (panel as unknown as { history: Array<{ role: string; content: string }> })
      .history;
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "Hi" });
  });

  // ---- Edge (cancel stopReason) — no assistant history entry.
  it("Edge cancel: response {stopReason:'cancelled'} posts done, no assistant history entry", async () => {
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
    feedAgentMessageChunk(session.transport, "partial");
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "cancelled");
    await until(() => postedMessages(p).some(isDone));

    expect(postedMessages(p).some(isAssistant)).toBe(false);
    const history = (panel as unknown as { history: unknown[] }).history;
    expect(history).toHaveLength(0);
  });

  // ---- Edge (concurrency) — Stop mid-stream.
  it("Edge concurrency: Stop mid-stream sends session/cancel once, settles pending resolvers, posts done exactly once, no late assistant", async () => {
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
    feedAgentMessageChunk(session.transport, "streaming...");
    await until(() => postedMessages(p).some(isDelta));

    handler({ type: "stop" });
    await until(() => postedMessages(p).some(isDone));

    const cancelFrames = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/cancel");
    expect(cancelFrames).toHaveLength(1);
    expect(postedMessages(p).filter(isDone)).toHaveLength(1);
    expect(postedMessages(p).some(isAssistant)).toBe(false);

    // A late server response arriving AFTER Stop settled the turn MUST NOT
    // post a second done or a late assistant.
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await flush(20);
    expect(postedMessages(p).filter(isDone)).toHaveLength(1);
    expect(postedMessages(p).some(isAssistant)).toBe(false);
  });

  // ---- Edge (state reset) — token resets between turns; resume_list works.
  it("Edge state reset: token===null between turns; resume_list is handled after a completed turn, not swallowed", async () => {
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
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));

    expect((panel as unknown as { token: unknown }).token).toBeNull();

    handler({ type: "resume_list" });
    await until(() =>
      session.transport.written.some((l) => JSON.parse(l)["method"] === "session/list"),
    );
    const listReq = session.transport.allWritten().find((f) => f["method"] === "session/list");
    expect(listReq).toBeDefined();
    session.transport.feed(
      JSON.stringify({ jsonrpc: "2.0", id: listReq!["id"], result: { sessions: [] } }),
    );
    await until(() =>
      postedMessages(p).some((m) => (m as { type?: string }).type === "resume_sessions"),
    );
    expect(
      postedMessages(p).some((m) => (m as { type?: string }).type === "resume_sessions"),
    ).toBe(true);
  });

  // ---- Edge (lifecycle) — panel disposed mid-turn (via webview onDidDispose,
  // i.e. the user closes the tab — NOT the explicit AiChatPanel.dispose()).
  it("Edge lifecycle: closing the panel tab mid-turn cancels pending permissions + disposes the ACP session", async () => {
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
    await flush();
    feedPermissionRequest(session.transport, 201, [
      { optionId: "allow", label: "Allow" },
    ]);
    await until(() => postedMessages(p).some(isPermissionRequest));

    // Simulate the user closing the webview tab directly — this fires the
    // vscode onDidDispose event WITHOUT going through AiChatPanel.dispose().
    p.dispose();
    await flush(20);

    const resultFrames = session.transport.allWritten().filter((f) => f["id"] === 201);
    expect(resultFrames).toHaveLength(1);
    const r = resultFrames[0]!["result"] as { outcome: { outcome: string } };
    expect(r.outcome.outcome).toBe("cancelled");
    // The ACP session was torn down — dispose() called on the handle.
    expect(session.disposeCalls).toBeGreaterThanOrEqual(1);
  });

  // ---- Edge (empty stream) — zero chunks then end_turn: no blank bubble.
  it("Edge empty stream: zero chunks then end_turn does not post a blank assistant bubble; done still posted", async () => {
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
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));

    expect(postedMessages(p).some(isAssistant)).toBe(false);
    expect(postedMessages(p).filter(isDone)).toHaveLength(1);
  });

  // ---- Edge (cache) — two turns, same connection: introspection runs once.
  it("Edge cache: two turns on the same connection introspect the schema once, not twice", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const adapter = schemaAdapter();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => adapter),
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
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).filter(isDone).length >= 1);

    handler({ type: "send", text: "second" });
    await until(
      () =>
        session.transport.allWritten().filter((f) => f["method"] === "session/prompt").length >=
        2,
    );
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).filter(isDone).length >= 2);

    expect(adapter.listSchemas).toHaveBeenCalledTimes(1);
  });

  // ---- R (B1) — turn settles on the response alone; no notification needed.
  it("R(B1) regression: session/prompt response alone (no terminal notification) settles the turn", async () => {
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
    // No `agent_end`/`turn_complete` notification is ever fed — only the
    // session/prompt response. Pre-fix, this hangs forever.
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");

    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));
    expect(postedMessages(p).find(isAssistant)).toMatchObject({ text: "Hi" });
  });

  // ---- R (B2) — content.text with no delta field still streams.
  it("R(B2) regression: agent_message_chunk with content.text and no delta field posts delta(text)", async () => {
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
    // Deliberately no `delta` key anywhere in this frame.
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "sess-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no-delta-field" } },
        },
      }),
    );
    await until(() => postedMessages(p).some(isDelta));
    expect((postedMessages(p).find(isDelta) as { text: string }).text).toBe("no-delta-field");
  });

  // ---- R (B9) — ACP prompt payload carries schema context.
  it("R(B9) regression: session/prompt text carries the schema DDL context, not just the raw user text", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const { start, sessions } = makeFakeAcpDeps();
    const adapter = schemaAdapter();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => adapter),
      acp: { start },
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "list users" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as FakeAcpSession;
    await until(() => lastPromptRequestId(session.transport) !== undefined);

    const promptFrame = session.transport
      .allWritten()
      .find((f) => f["method"] === "session/prompt")!;
    const params = promptFrame["params"] as { prompt: Array<{ type: string; text: string }> };
    const sentText = params.prompt[0]?.text ?? "";
    expect(sentText).toContain("CREATE TABLE public.users");
    expect(sentText).toContain("list users");
  });

  // ---- Negative-path regression pin: stale cycle-L kinds (agent_end /
  // turn_complete) are UNKNOWN update kinds in real ACP and MUST be ignored
  // — they never drive turn completion. Labelled per TASK-007 acceptance:
  // this is a negative-path assertion, not a fake that drives a turn.
  it("Regression pin: unknown update kinds agent_end/turn_complete are ignored, never settle the turn", async () => {
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

    for (const kind of ["agent_end", "turn_complete"]) {
      session.transport.feed(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "sess-1", update: { sessionUpdate: kind } },
        }),
      );
    }
    await flush(20);
    expect(postedMessages(p).some(isDone)).toBe(false);

    // Only the real terminal signal — the session/prompt response — settles it.
    respondPrompt(session.transport, lastPromptRequestId(session.transport), "end_turn");
    await until(() => postedMessages(p).some(isDone));
    expect(postedMessages(p).filter(isDone)).toHaveLength(1);
  });
});

// ---- message narrowing helpers ---------------------------------------------

function isInit(m: unknown): m is { type: "init"; hasHistory: boolean } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isDelta(m: unknown): m is { type: "delta"; text: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "delta";
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
function isError(m: unknown): m is { type: "error"; message: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
