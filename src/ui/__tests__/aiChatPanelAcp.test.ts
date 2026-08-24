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

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

async function flush(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
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

function feedAgentMessageChunk(
  transport: FakeAcpTransport,
  delta: string,
): void {
  transport.feed(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", delta },
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
