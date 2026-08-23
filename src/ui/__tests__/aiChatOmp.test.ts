// src/ui/__tests__/aiChatOmp.test.ts — TASK-004
// 7 test cases for the omp engine switch:
//   #1 happy: detect ok + spawn → set_host_tools once, prompt send, delta events,
//            assistant final + done
//   #2 happy: host_tool_call routed through fake rpc → executor invoked,
//            result frame written
//   #3 edge: detect → not-installed → builtin runAgent path + engine message once
//            with install hint
//   #4 edge: detect → version-too-old → builtin + update hint
//   #5 edge: fake onExit(1) mid-turn → error bubble + fallback builtin (no auto respawn)
//   #6 edge: send then stop → abort request sent, isTerminal:false agent_end does NOT end turn
//   #7 regression: builtin suite cycle K remains green (no omp deps → runAgent unchanged)
//
// Pattern mirror src/ui/__tests__/aiChatPanel.test.ts: vi.mock("vscode"),
// panelHarness. We inject a fake `omp` options so no real process spawns.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type {
  AgentDeps,
  AgentStep,
  AgentRunResult,
} from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";
import type { OmpDetection } from "../../ai/omp/detect";
import type { OmpRpcClient } from "../../ai/omp/rpc";

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

// ---- vscode mock --------------------------------------------------------------
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
}));

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

interface InitMsg { type: "init"; hasHistory: boolean }
interface DeltaMsg { type: "delta"; text: string }
interface AssistantMsg { type: "assistant"; text: string; markdown: boolean }
interface ErrorMsg { type: "error"; message: string }
interface DoneMsg { type: "done" }
interface EngineMsg {
  type: "engine";
  name: "omp" | "builtin";
  hint?: string;
}

const isInit = (m: unknown): m is InitMsg =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "init";
const isDelta = (m: unknown): m is DeltaMsg =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "delta";
const isAssistant = (m: unknown): m is AssistantMsg =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "assistant";
const isError = (m: unknown): m is ErrorMsg =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "error";
const isDone = (m: unknown): m is DoneMsg =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "done";
const isEngine = (m: unknown): m is EngineMsg =>
  !!m && typeof m === "object" && (m as { type?: string }).type === "engine";

// ---- Fake rpc + omp deps factory ---------------------------------------------

interface HostToolCallPayload {
  id: string;
  toolName: string;
  arguments: unknown;
}

interface FakeOmpHandle {
  rpc: OmpRpcClient;
  written: string[];
  requestMock: Mock;
  /** Push a non-response event into the listeners the panel subscribed to. */
  feedEvent(ev: Record<string, unknown>): void;
  /** Trigger onExit(code) on the spawned handle. */
  fireExit(code: number | null): void;
  /** Decode the most recent write, or {} if none. */
  lastWritten(): Record<string, unknown>;
  /** Decode all writes. */
  allWritten(): Array<Record<string, unknown>>;
}

interface FakeOmpDeps {
  detect: () => Promise<OmpDetection>;
  spawn: (cwd: string) => Promise<{
    rpc: OmpRpcClient;
    version: string;
    onExit(cb: (code: number | null) => void): void;
    kill(): void;
  }>;
  toolDefs: () => Record<string, unknown>[];
  toolExecutor: (name: string, args: unknown) => Promise<string>;
}

interface SpawnedSession {
  rpc: OmpRpcClient;
  written: string[];
  eventListeners: Array<(ev: Record<string, unknown>) => void>;
  hostToolHandler: ((call: HostToolCallPayload) => Promise<unknown>) | null;
  exitListeners: Array<(code: number | null) => void>;
  requestMock: Mock;
  handle: FakeOmpHandle;
}

function makeFakeOmpDeps(
  detection: OmpDetection,
  toolDefsResult: Record<string, unknown>[] = [{ name: "list_tables" }],
): { deps: FakeOmpDeps; sessions: SpawnedSession[] } {
  const sessions: SpawnedSession[] = [];

  const deps: FakeOmpDeps = {
    detect: vi.fn(async () => detection),
    spawn: vi.fn(async (_cwd: string) => {
      const written: string[] = [];
      const eventListeners: Array<(ev: Record<string, unknown>) => void> = [];
      const exitListeners: Array<(code: number | null) => void> = [];
      const requestMock = vi.fn(
        async (cmd: { type: string } & Record<string, unknown>) => {
          written.push(JSON.stringify(cmd));
          return {};
        },
      );

      let hostToolHandler:
        | ((call: HostToolCallPayload) => Promise<unknown>)
        | null = null;

      let sessionRef: SpawnedSession | null = null;

      const fakeRpc = {
        onEvent: (cb: (ev: Record<string, unknown>) => void) => {
          eventListeners.push(cb);
        },
        handleHostToolCall: (
          handler: (call: HostToolCallPayload) => Promise<unknown>,
        ) => {
          hostToolHandler = handler;
          if (sessionRef !== null) {
            sessionRef.hostToolHandler = handler;
          }
        },
        request: requestMock,
      } as unknown as OmpRpcClient;

      const handle: FakeOmpHandle = {
        rpc: fakeRpc,
        written,
        requestMock,
        feedEvent: (ev) => {
          // Mirror OmpRpcClient.handleLine: host_tool_call goes through the
          // registered handler, everything else through eventListeners.
          if (ev["type"] === "host_tool_call") {
            if (hostToolHandler !== null) {
              void hostToolHandler({
                id: ev["id"] as string,
                toolName: ev["toolName"] as string,
                arguments: ev["arguments"],
              }).then((result) => {
                written.push(
                  JSON.stringify({
                    type: "host_tool_result",
                    id: ev["id"],
                    result: { content: [{ type: "text", text: String(result) }] },
                    isError: false,
                  }),
                );
              });
            }
            return;
          }
          for (const cb of eventListeners) cb(ev);
        },
        fireExit: (code) => {
          for (const cb of exitListeners) cb(code);
        },
        lastWritten: () => {
          const last = written[written.length - 1];
          return last ? (JSON.parse(last) as Record<string, unknown>) : {};
        },
        allWritten: () =>
          written.map((w) => JSON.parse(w) as Record<string, unknown>),
      };
      const sessionEntry: SpawnedSession = {
        rpc: fakeRpc,
        written,
        eventListeners,
        hostToolHandler,
        exitListeners,
        requestMock,
        handle,
      };
      sessions.push(sessionEntry);
      sessionRef = sessionEntry;
      return {
        rpc: fakeRpc,
        version: "omp/18.0.1",
        onExit: (cb) => {
          exitListeners.push(cb);
        },
        kill: () => {
          /* noop */
        },
      };
    }),
    toolDefs: vi.fn(() => toolDefsResult),
    toolExecutor: vi.fn(async (_name: string, _args: unknown) => "tool-result"),
  };
  return { deps, sessions };
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

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

// =============================================================================
// #1 — happy: detect ok → set_host_tools once, prompt send, delta streaming,
// assistant final + done.
// =============================================================================
describe("AiChatPanel — omp engine happy path", () => {
  it("#1 detect ok: set_host_tools once, prompt send, delta events → assistant + done", async () => {
    const detection: OmpDetection = { available: true, ok: true, version: "18.0.1" };
    const { deps: ompDeps, sessions } = makeFakeOmpDeps(detection);
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      omp: ompDeps,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // Engine should be announced exactly once with name=omp.
    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(1);
    expect(engineMsgs[0]?.name).toBe("omp");
    // Spawn happens lazily on first send — wait for it.
    handler({ type: "send", text: "hello" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as SpawnedSession;
    expect(session).toBeDefined();
    await until(() =>
      session.written.some((w) => w.includes('"type":"set_host_tools"')),
    );

    // set_host_tools sent exactly once.
    const setHostTools = session.handle
      .allWritten()
      .filter((f) => f["type"] === "set_host_tools");
    expect(setHostTools).toHaveLength(1);
    const tools = setHostTools[0]?.["tools"] as Array<{ name: string }>;
    expect(Array.isArray(tools)).toBe(true);
    // prompt frame contains text — wait for it before asserting.
    await until(() =>
      session.handle
        .allWritten()
        .some((f) => f["type"] === "prompt"),
    );
    const prompts = session.handle.allWritten().filter((f) => f["type"] === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.["message"]).toBe("hello");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Feed streaming deltas + terminal agent_end → assistant final + done.
    session.handle.feedEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hi" },
    });
    session.handle.feedEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " there" },
    });
    session.handle.feedEvent({ type: "agent_end", isTerminal: true });

    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));
    const deltas = postedMessages(p).filter(isDelta) as DeltaMsg[];
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((d) => d.text).join("")).toBe("Hi there");

    const assistants = postedMessages(p).filter(isAssistant) as AssistantMsg[];
    expect(assistants[0]?.text).toBe("Hi there");
    expect(postedMessages(p).some(isDone)).toBe(true);
  });
});

// =============================================================================
// #2 — happy: host_tool_call routed through fake rpc → executor invoked,
// result frame written.
// =============================================================================
describe("AiChatPanel — host tool call", () => {
  it("#2 host_tool_call routed: toolExecutor invoked with name/args; result frame written", async () => {
    const detection: OmpDetection = { available: true, ok: true, version: "18.0.1" };
    const { deps: ompDeps, sessions } = makeFakeOmpDeps(detection);
    const toolExecutor = ompDeps.toolExecutor as Mock;
    toolExecutor.mockResolvedValueOnce("listed-ok");
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      omp: ompDeps,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // Spawn happens lazily on first send — wait for it.
    handler({ type: "send", text: "list" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as SpawnedSession;
    expect(session).toBeDefined();
    await until(() =>
      session.written.some((w) => w.includes('"type":"set_host_tools"')),
    );

    // Drive a host_tool_call frame via the rpc's event path (mimics real
    // omp wire flow: handleLine dispatches host_tool_call through the
    // registered handler, then writes host_tool_result back).
    session.handle.feedEvent({
      type: "host_tool_call",
      id: "x1",
      toolName: "list_tables",
      arguments: { schema: "public" },
    });
    // Allow the async handler chain to settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(toolExecutor).toHaveBeenCalledWith("list_tables", { schema: "public" });
    // Result frame written back through the transport.
    const resultFrames = session.handle
      .allWritten()
      .filter((f) => f["type"] === "host_tool_result");
    expect(resultFrames).toHaveLength(1);
    expect(resultFrames[0]?.["id"]).toBe("x1");
  });
});

// =============================================================================
// #3 — edge: detect not-installed → builtin runAgent path + engine message once
// with install hint.
// =============================================================================
describe("AiChatPanel — omp not-installed", () => {
  it("#3 detect not-installed: builtin runAgent + engine message (install hint) once", async () => {
    const detection: OmpDetection = { available: false, ok: false, reason: "not-installed" };
    const { deps: ompDeps } = makeFakeOmpDeps(detection);
    agentState.runAgentMock.mockImplementation(
      async (_input, _deps, cbs?: { onStep?: (s: AgentStep) => void }) => {
        cbs?.onStep?.({
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "t1", name: "list_tables", argumentsJson: "{}" }],
            },
            { role: "tool", toolCallId: "t1", content: "[]" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        });
        return makeRunResult([], "builtin-ok");
      },
    );

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      omp: ompDeps,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(1);
    expect(engineMsgs[0]?.name).toBe("builtin");
    expect(engineMsgs[0]?.hint).toMatch(/install/i);

    // spawn must NOT be called when detect fails.
    expect(ompDeps.spawn).not.toHaveBeenCalled();

    handler({ type: "send", text: "hi" });
    await until(() => postedMessages(p).some(isAssistant));
    expect(agentState.runAgentMock).toHaveBeenCalled();
    const assistants = postedMessages(p).filter(isAssistant) as AssistantMsg[];
    expect(assistants[0]?.text).toBe("builtin-ok");

    // Engine message must NOT be re-emitted on subsequent sends.
    const before = engineMsgs.length;
    handler({ type: "send", text: "again" });
    await until(() => postedMessages(p).filter(isAssistant).length > assistants.length);
    expect(postedMessages(p).filter(isEngine).length).toBe(before);
  });
});

// =============================================================================
// #4 — edge: detect → version-too-old → builtin + update hint.
// =============================================================================
describe("AiChatPanel — omp version too old", () => {
  it("#4 detect version-too-old: builtin + update hint", async () => {
    const detection: OmpDetection = {
      available: true,
      ok: false,
      version: "16.0.0",
      reason: "version-too-old",
    };
    const { deps: ompDeps } = makeFakeOmpDeps(detection);
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "ok"));

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      omp: ompDeps,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(1);
    expect(engineMsgs[0]?.name).toBe("builtin");
    expect(engineMsgs[0]?.hint).toMatch(/update/i);
    expect(ompDeps.spawn).not.toHaveBeenCalled();
  });
});

// =============================================================================
// #5 — edge: fake onExit(1) mid-turn → error bubble + fallback builtin;
// NO auto respawn.
// =============================================================================
describe("AiChatPanel — omp crash mid-turn", () => {
  it("#5 onExit(1) mid-turn: error bubble + done; no respawn; follow-up falls back to builtin", async () => {
    const detection: OmpDetection = { available: true, ok: true, version: "18.0.1" };
    const { deps: ompDeps, sessions } = makeFakeOmpDeps(detection);
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "builtin-fallback"));

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      omp: ompDeps,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // Spawn happens lazily on first send — wait for it.
    handler({ type: "send", text: "go" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as SpawnedSession;
    expect(session).toBeDefined();
    await until(() =>
      session.written.some((w) => w.includes('"type":"set_host_tools"')),
    );
    // Simulate crash mid-turn.
    session.handle.fireExit(1);

    // Expect error bubble + done.
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));
    const errs = postedMessages(p).filter(isError) as ErrorMsg[];
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]?.message).toMatch(/ended/i);

    // No second spawn() call — user retry would re-detect.
    const spawnCount = (ompDeps.spawn as Mock).mock.calls.length;
    expect(spawnCount).toBe(1);

    // After crash + done, a fresh send should fall back to builtin (runAgent called).
    const runsBefore = agentState.runAgentMock.mock.calls.length;
    handler({ type: "send", text: "after-crash" });
    await until(() => agentState.runAgentMock.mock.calls.length > runsBefore);
    expect(agentState.runAgentMock.mock.calls.length).toBeGreaterThan(runsBefore);
  });
});

// =============================================================================
// #6 — edge: send then stop → abort request sent; isTerminal:false agent_end
// does NOT end the turn.
// =============================================================================
describe("AiChatPanel — omp stop + terminal gating", () => {
  it("#6 stop in omp mode: abort request sent; isTerminal:false agent_end does not end turn", async () => {
    const detection: OmpDetection = { available: true, ok: true, version: "18.0.1" };
    const { deps: ompDeps, sessions } = makeFakeOmpDeps(detection);
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      omp: ompDeps,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    // Spawn happens lazily on first send — wait for it.
    handler({ type: "send", text: "do work" });
    await until(() => sessions.length > 0);
    const session = sessions[0] as SpawnedSession;
    expect(session).toBeDefined();
    await until(() =>
      session.written.some((w) => w.includes('"type":"set_host_tools"')),
    );
    // Wait for the prompt request too — otherwise the panel hasn't yet pushed
    // its turn resolver and the agent_end event below arrives with an empty
    // resolvers array.
    await until(() =>
      session.written.some((w) => w.includes('"type":"prompt"')),
    );
    // Allow microtasks to settle so the panel's runOmpTurn has reached the
    // `await new Promise(...)` line where it registers the resolver.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Feed some deltas + agent_end with isTerminal:false → turn MUST NOT end.
    session.handle.feedEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hi" },
    });
    session.handle.feedEvent({ type: "agent_end", isTerminal: false });
    await Promise.resolve();
    await Promise.resolve();

    expect(postedMessages(p).some(isDelta)).toBe(true);
    // Now user presses stop → abort request must be sent.
    handler({ type: "stop" });
    await until(() =>
      session.written.some((w) => w.includes('"type":"abort"')),
    );
    const aborts = session.handle.allWritten().filter((f) => f["type"] === "abort");
    expect(aborts).toHaveLength(1);

    // After stop: any further delta events must be gated (NOT posted).
    const deltasBefore = postedMessages(p).filter(isDelta).length;
    session.handle.feedEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "ignored" },
    });
    await Promise.resolve();
    expect(postedMessages(p).filter(isDelta).length).toBe(deltasBefore);

    // Done eventually posted when terminal agent_end arrives.
    session.handle.feedEvent({ type: "agent_end", isTerminal: true });
    await until(() => postedMessages(p).some(isDone));
    expect(postedMessages(p).some(isAssistant)).toBe(true);
    expect(postedMessages(p).some(isDone)).toBe(true);
  });
});

describe("AiChatPanel — builtin regression (no omp deps)", () => {
  it("#7 no omp deps: runAgent path unchanged (regression)", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "builtin"));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    handler({ type: "send", text: "ping" });
    await until(() => postedMessages(p).some(isAssistant));
    expect(agentState.runAgentMock).toHaveBeenCalled();
    // Without omp deps the panel still emits one engine=builtin announcement
    // on first ready (cycle K host tests are the cycle-K behavior guarantee).
    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(1);
    expect(engineMsgs[0]?.name).toBe("builtin");
    // No hint because no omp intent at all — install hint is reserved for
    // detection failure cases.
    expect(engineMsgs[0]?.hint).toBeUndefined();
  });
});
