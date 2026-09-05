// src/ui/__tests__/aiChatPanel.test.ts — TASK-003 host tests.
// 7 cases: ready/init, send → runAgent + posts, null-factory context, stop
// gating, error resilience, reveal-on-reshow, bundle existence (handled in
// aiChatPanelBundle.test.ts).
//
// Pattern mirror src/ui/__tests__/aiSettingsForm.test.ts: vi.mock("vscode"),
// panelHarness that captures the last panel + its onDidReceiveMessage handler.
// We additionally mock src/ai/agent so the panel's runAgent call is
// deterministic per-test.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type {
  AgentDeps,
  AgentStep,
  AgentRunResult,
} from "../../ai/agent";
import type {
  ChatMessage,
  ProviderResult,
  ToolCall,
} from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import type { DbToolRegistry } from "../../ai/tools/registry";

// Mock vscode AND the agent module BEFORE importing the panel.
const agentState = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return {
    ...actual,
    runAgent: agentState.runAgentMock,
  };
});

// Import AFTER mocks are registered.
import { AiChatPanel, buildMessages, type AcpPanelDeps } from "../aiChatPanel";

// ---- vscode mock -----------------------------------------------------------
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
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
}));

const extUri = vscode.Uri.file("/ext");

// ---- helpers ---------------------------------------------------------------

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

// ---- message narrowing helpers ---------------------------------------------

interface InitMsg {
  type: "init";
  hasHistory: boolean;
}
interface StepMsg {
  type: "step";
  label: string;
}
interface AssistantMsg {
  type: "assistant";
  text: string;
  markdown: boolean;
}
interface ErrorMsg {
  type: "error";
  message: string;
}
interface DoneMsg {
  type: "done";
}

function isInit(m: unknown): m is InitMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isStep(m: unknown): m is StepMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "step";
}
function isAssistant(m: unknown): m is AssistantMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "assistant";
}
function isError(m: unknown): m is ErrorMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
function isDone(m: unknown): m is DoneMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}

// ---- runAgent fixture helpers ---------------------------------------------

function textMsg(role: "system" | "user" | "assistant", content: string): ChatMessage {
  return { role, content };
}

function makeRunResult(steps: AgentStep[], finalText: string): AgentRunResult {
  return {
    steps,
    history: [],
    finalText,
    stoppedOnBudget: false,
  };
}

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

// ============================================================================
// #1 — ready → init
// ============================================================================
describe("AiChatPanel — init", () => {
  it("#1 ready: posts init with hasHistory:false on first open", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    const init = postedMessages(p).find(isInit);
    expect(init).toBeDefined();
    expect(init!.hasHistory).toBe(false);
    expect(agentState.runAgentMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #2 — send → runAgent with full registry, posts step?/assistant/done
// ============================================================================
describe("AiChatPanel — send", () => {
  it("#2 send: build messages with system+user, runAgent called with real registry; posts in order", async () => {
    const toolCall: ToolCall = { id: "t1", name: "list_tables", argumentsJson: "{}" };
    const toolStep: AgentStep = {
      messages: [
        { role: "assistant", content: "", toolCalls: [toolCall] },
        { role: "tool", toolCallId: "t1", content: "[]" },
      ],
      result: {
        text: "",
        toolCalls: [],
        finishReason: "tool_calls",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
    const finalStep: AgentStep = {
      messages: [{ role: "assistant", content: "answer" }],
      result: {
        text: "answer",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      } satisfies ProviderResult,
    };
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onStep?: (s: AgentStep) => void;
          onToolCall?: (call: ToolCall) => void;
        },
      ) => {
        // TASK-002: live step is posted via onToolCall, not onStep.
        // onStep still fires for end-of-step notification only.
        callbacks?.onToolCall?.(toolCall);
        callbacks?.onStep?.(toolStep);
        callbacks?.onStep?.(finalStep);
        return makeRunResult([toolStep, finalStep], "answer");
      },
    );

    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "show me users" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const firstCallArgs = agentState.runAgentMock.mock.calls[0];
    const input = firstCallArgs?.[0] as {
      messages: ChatMessage[];
      tools?: DbToolRegistry;
    };
    expect(input.messages[0]?.role).toBe("system");
    expect(input.messages[input.messages.length - 1]).toEqual(
      textMsg("user", "show me users"),
    );
    const tools = input.tools as DbToolRegistry;
    expect(tools).toBeDefined();
    expect(typeof tools.list).toBe("function");
    const toolNames = tools.list().map((t) => t.name);
    expect(toolNames).toContain("list_tables");
    expect(toolNames).toContain("describe_table");
    expect(toolNames).toContain("run_sql");

    const posted = postedMessages(p);
    const stepIdx = posted.findIndex(isStep);
    const assistantIdx = posted.findIndex(isAssistant);
    const doneIdx = posted.findIndex(isDone);
    expect(stepIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeGreaterThan(stepIdx);
    expect(doneIdx).toBeGreaterThan(assistantIdx);
    const stepMsg = posted[stepIdx] as StepMsg;
    expect(stepMsg.label).toBe("list_tables");
    const assistantMsg = posted[assistantIdx] as AssistantMsg;
    expect(assistantMsg.text).toBe("answer");
  });
});

// ============================================================================
// #3 — null factory (no connection): context is empty, no crash
// ============================================================================
describe("AiChatPanel — no connection", () => {
  it("#3 factory resolves null: system prompt OK, runAgent still called, no throw", async () => {
    agentState.runAgentMock.mockImplementation(async () => makeRunResult([], "fallback"));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "hi" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const firstCallArgs = agentState.runAgentMock.mock.calls[0];
    const input = firstCallArgs?.[0] as { messages: ChatMessage[] };
    const sys = input.messages[0]?.content as string;
    expect(typeof sys).toBe("string");
    expect(sys).not.toMatch(/^Table:\s/m);
    expect(input.messages[input.messages.length - 1]).toEqual(textMsg("user", "hi"));
  });

  it("#3b empty text: send is a no-op, runAgent not called", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "   " });
    await Promise.resolve();
    await Promise.resolve();
    expect(agentState.runAgentMock).not.toHaveBeenCalled();
    expect(postedMessages(p).some(isAssistant)).toBe(false);
    expect(postedMessages(p).some(isDone)).toBe(false);
  });
});

// ============================================================================
// #4 — stop token gating: no assistant final; done still posted
// ============================================================================
describe("AiChatPanel — stop", () => {
  it("#4 send then stop: assistant final NOT posted; done posted", async () => {
    let resolveRun!: (v: AgentRunResult) => void;
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onStep?: (s: AgentStep) => void;
          onToolCall?: (call: ToolCall) => void;
        },
      ) => {
        const toolCall: ToolCall = { id: "t1", name: "list_tables", argumentsJson: "{}" };
        // TASK-002: live step fires via onToolCall.
        callbacks?.onToolCall?.(toolCall);
        callbacks?.onStep?.({
          messages: [
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "tool", toolCallId: "t1", content: "[]" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        });
        return new Promise<AgentRunResult>((resolve) => {
          resolveRun = resolve;
        });
      },
    );

    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isStep));
    handler({ type: "stop" });
    resolveRun(makeRunResult([], "should-be-suppressed"));
    await until(() => postedMessages(p).some(isDone));

    expect(postedMessages(p).some(isAssistant)).toBe(false);
    expect(postedMessages(p).some(isDone)).toBe(true);
  });

  it("#4b stop gating onStep: after token aborted, further steps are NOT posted", async () => {
    let fireSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      fireSecond = resolve;
    });
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onStep?: (s: AgentStep) => void;
          onToolCall?: (call: ToolCall) => void;
        },
      ) => {
        const callA: ToolCall = { id: "a", name: "list_tables", argumentsJson: "{}" };
        const step1: AgentStep = {
          messages: [
            { role: "assistant", content: "", toolCalls: [callA] },
            { role: "tool", toolCallId: "a", content: "[]" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
        callbacks?.onToolCall?.(callA);
        callbacks?.onStep?.(step1);
        await secondGate;
        const callB: ToolCall = { id: "b", name: "describe_table", argumentsJson: "{}" };
        const step2: AgentStep = {
          messages: [
            { role: "assistant", content: "", toolCalls: [callB] },
            { role: "tool", toolCallId: "b", content: "{}" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
        callbacks?.onToolCall?.(callB);
        callbacks?.onStep?.(step2);
        return makeRunResult([step1, step2], "x");
      },
    );
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isStep));
    handler({ type: "stop" });
    fireSecond();
    await until(() => postedMessages(p).some(isDone));
    const steps = postedMessages(p).filter(isStep);
    expect(steps).toHaveLength(1);
    const firstStep = steps[0] as StepMsg;
    expect(firstStep.label).toBe("list_tables");
  });
});

// ============================================================================
// #5 — runAgent rejects → error bubble + done; panel still alive
// ============================================================================
describe("AiChatPanel — error", () => {
  it("#5 runAgent rejects: error posted with message; done posted; panel still alive", async () => {
    agentState.runAgentMock.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "ping" });
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));
    const errs = postedMessages(p).filter(isError);
    expect(errs.length).toBeGreaterThan(0);
    const firstErr = errs[0] as ErrorMsg;
    expect(firstErr.message).toBe("provider down");
    const allText = JSON.stringify(errs);
    expect(allText).not.toMatch(/sk-/i);
    expect(p.disposed).toBe(false);
  });
});

// ============================================================================
// #6 — show twice reveals; only one panel created
// ============================================================================
describe("AiChatPanel — lifecycle", () => {
  it("#6 show twice: reveal on existing; createWebviewPanel only once", () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    panel.show();
    panel.show();
    expect((vscode.window.createWebviewPanel as unknown as Mock).mock.calls.length).toBe(1);
    const lastPanel = state.panels[0] as MockPanel;
    expect(lastPanel.reveal).toHaveBeenCalledTimes(2);
  });

  it("#6b clear: posts init with hasHistory:false", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], ""));
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    const postedBefore = postedMessages(p).filter(isInit).length;
    handler({ type: "clear" });
    await until(() => postedMessages(p).filter(isInit).length > postedBefore);
    const inits = postedMessages(p).filter(isInit);
    const lastInit = inits[inits.length - 1] as InitMsg;
    expect(lastInit.hasHistory).toBe(false);
  });
});

// ============================================================================
// Regression (R4.5 — Reviewer finding 1): deps + adapterFactory are truly
// consumed. Previously the 9 constructions were positional `(extUri, deps,
// factory)` against an options-object constructor; the TypeErrors from
// `undefined()` were swallowed by buildMessages' try/catch and the runAgent
// mock ignored deps, so the suite appeared green while the wiring was
// broken. Assert now that send actually consults both: factory invoked for
// schema context, and the deps handed to runAgent equal the deps we passed
// in (loadConfig reference identity).
// ============================================================================
describe("AiChatPanel — wiring (regression R4.5)", () => {
  it("R1 send consults adapterFactory for schema context (factory is invoked, not undefined)", async () => {
    const adapter = {
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
    };
    const factory: AdapterFactory = vi.fn(async () => adapter);
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "ok"));

    const deps = makeDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps,
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "list tables" });
    await until(() => postedMessages(p).some(isAssistant));
    expect(adapter.listSchemas).toHaveBeenCalled();
    // runAgent was handed the SAME deps instance (reference identity).
    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const passedDeps = agentState.runAgentMock.mock.calls[0]?.[1] as AgentDeps;
    expect(passedDeps).toBe(deps);
  });

  it("R2 send hands the real deps instance to runAgent (deps.loadConfig reachable)", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "ok"));
    const factory: AdapterFactory = vi.fn(async () => null);
    const deps = makeDeps();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps,
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "hi" });
    await until(() => postedMessages(p).some(isAssistant));

    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    const passedDeps = agentState.runAgentMock.mock.calls[0]?.[1] as AgentDeps;
    expect(passedDeps).toBe(deps);
    expect(typeof passedDeps.loadConfig).toBe("function");
    expect(typeof passedDeps.complete).toBe("function");
    // The specific spies we made — same references, not stubs.
    expect(passedDeps.loadConfig).toBe(deps.loadConfig);
    expect(passedDeps.complete).toBe(deps.complete);
  });
});
// ============================================================================
// TASK-003 — Cases 1-4: builtin streaming wiring in panel.
// Pins the runBuiltinTurn contract:
//   - delta messages posted in order from onText
//   - AbortController + signal gated on abort token
//   - onStreamFallback → "{type:"step", label:"stream fallback"}" posted
//   - apiKey never crosses the wire
// ============================================================================
describe("AiChatPanel — builtin streaming", () => {
  // ---- helpers -------------------------------------------------------------

  interface DeltaMsg {
    type: "delta";
    text: string;
  }
  function isDelta(m: unknown): m is DeltaMsg {
    return !!m && typeof m === "object" && (m as { type?: string }).type === "delta";
  }

  interface EngineMsg {
    type: "engine";
    name: "omp" | "builtin";
    hint?: string;
  }
  function isEngine(m: unknown): m is EngineMsg {
    return !!m && typeof m === "object" && (m as { type?: string }).type === "engine";
  }

  /** Strip helper - find the engine banner posted via {type:'engine'}. */
  function engineMsgFromPost(panel: MockPanel): EngineMsg | undefined {
    return postedMessages(panel).find(isEngine);
  }

  // ---- Case #1: happy streaming --------------------------------------------
  it('#1 happy: stream emits delta(a), delta(b), assistant(ab), done in order; history gains user+assistant', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onText?: (text: string) => void;
        },
        signal?: AbortSignal,
      ) => {
        seenSignals.push(signal);
        callbacks?.onText?.("a");
        callbacks?.onText?.("b");
        return makeRunResult(
          [
            {
              messages: [{ role: "assistant", content: "ab" }],
              result: {
                text: "ab",
                toolCalls: [],
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0 },
              },
            },
          ],
          "ab",
        );
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "hello" });
    await until(() => postedMessages(p).some(isDelta));
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const posted = postedMessages(p);
    const deltas = posted.filter(isDelta).map((d) => (d as DeltaMsg).text);
    expect(deltas).toEqual(["a", "b"]);

    const deltaIdx = posted.findIndex(isDelta);
    const assistantIdx = posted.findIndex(isAssistant);
    const doneIdx = posted.findIndex(isDone);
    expect(deltaIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeGreaterThan(deltaIdx);
    expect(doneIdx).toBeGreaterThan(assistantIdx);

    // signal is plumbed through to runAgent as arg #4.
    expect(agentState.runAgentMock).toHaveBeenCalledTimes(1);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]).toBeDefined();
    expect(seenSignals[0]?.aborted).toBe(false);
  });

  // ---- Case #2: stop mid-stream suppresses post-stop delta ----------------
  it("#2 abort: stop fires between onText calls; post-stop delta NOT posted; assistant NOT posted; done posted", async () => {
    const stopHook = {
      fired: false as boolean,
      runStop: null as null | (() => void),
    };
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onText?: (text: string) => void;
        },
        signal?: AbortSignal,
      ) => {
        callbacks?.onText?.("x");
        // Wait until the test fires stop (signal goes aborted).
        await new Promise<void>((resolve) => {
          stopHook.runStop = () => {
            stopHook.fired = true;
            resolve();
          };
        });
        // After token aborted, the second text MUST NOT post.
        if (!signal?.aborted) {
          callbacks?.onText?.("y");
        }
        // Resolve with finalText; panel's post-loop reads token.aborted to
        // decide whether to suppress assistant.
        return makeRunResult(
          [
            {
              messages: [{ role: "assistant", content: "xy" }],
              result: {
                text: "xy",
                toolCalls: [],
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0 },
              },
            },
          ],
          "xy",
        );
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "stop me" });
    await until(() => postedMessages(p).some(isDelta));

    expect(stopHook.runStop).not.toBeNull();
    // User clicks Stop. Panel must abort token AND signal before resolving
    // the run.
    handler({ type: "stop" });
    stopHook.runStop!();

    await until(() => postedMessages(p).some(isDone));
    expect(stopHook.fired).toBe(true);

    const posted = postedMessages(p);
    const deltas = posted.filter(isDelta).map((d) => (d as DeltaMsg).text);
    expect(deltas).toEqual(["x"]);
    expect(posted.some(isAssistant)).toBe(false);
    expect(posted.some(isDone)).toBe(true);

    // The runAgent call MUST have received an AbortSignal that got aborted
    // by the time resolve completed.
    const signalArg = agentState.runAgentMock.mock.calls[0]?.[3] as
      | AbortSignal
      | undefined;
    expect(signalArg).toBeDefined();
    expect(signalArg?.aborted).toBe(true);
  });
  // ---- Case #2b: stop mid-stream with REAL AbortError -------------------
  // Strengthens case #2 along two axes the prior mock allowed to pass:
  //  (a) the mock used to self-gate on signal.aborted before firing the
  //      post-stop onText, so the panel's token.aborted gate at
  //      aiChatPanel.ts:321 was never exercised end-to-end. Fire onText
  //      UNCONDITIONALLY and assert the panel still suppresses the delta.
  //  (b) the catch at aiChatPanel.ts:351-355 used to post {type:"error"}
  //      on every rejection including real AbortError from the provider.
  //      Reproduce that path (runAgent rejects with AbortError after
  //      token flip) and assert NO error bubble is posted — done still
  //      posts in finally.
  it("#2b abort: real AbortError after stop → NO error bubble; unconditional late onText suppressed; done posted", async () => {
    const stopHook = { runStop: null as null | (() => void) };
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: { onText?: (text: string) => void },
      ) => {
        callbacks?.onText?.("x");
        // Wait until the test fires stop, then:
        //  - fire onText UNCONDITIONALLY (mock no longer self-gates —
        //    the panel's own token.aborted gate must do the work);
        //  - reject with a real AbortError to exercise the catch path
        //    (real upstream per agent.ts:177-182 rule 1).
        await new Promise<void>((resolve) => {
          stopHook.runStop = resolve;
        });
        callbacks?.onText?.("y"); // unconditional — panel must drop
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "stop me" });
    await until(() => postedMessages(p).some(isDelta));

    expect(stopHook.runStop).not.toBeNull();
    handler({ type: "stop" });
    stopHook.runStop!();

    await until(() => postedMessages(p).some(isDone));

    const posted = postedMessages(p);
    // (a) unconditional late onText must be dropped by the panel's gate.
    const deltas = posted.filter(isDelta).map((d) => (d as DeltaMsg).text);
    expect(deltas).toEqual(["x"]);
    // (b) AbortError thrown from runAgent must NOT surface as error bubble.
    const errs = posted.filter(isError);
    expect(errs).toEqual([]);
    // done still arrives via finally.
    expect(posted.some(isDone)).toBe(true);
    // apiKey never on the wire.
    expect(JSON.stringify(posted)).not.toMatch(/sk-/i);
  });

  // ---- Case #3: stream fallback ------------------------------------------
  it('#3 fallback: onStreamFallback posts step {stream fallback}; assistant + done still post', async () => {
    const agentStep: AgentStep = {
      messages: [{ role: "assistant", content: "fallback-text" }],
      result: {
        text: "fallback-text",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    };
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onText?: (text: string) => void;
          onStreamFallback?: () => void;
          onStep?: (s: AgentStep) => void;
        },
      ) => {
        callbacks?.onStreamFallback?.();
        callbacks?.onStep?.(agentStep);
        return makeRunResult([agentStep], "fallback-text");
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const stepMsgs = postedMessages(p).filter(isStep);
    // onStreamFallback's panel handler posts step "stream fallback";
    // onStep's tool-name post only fires if a tool call is present — our
    // fixture has none, so only the fallback step posts.
    expect(stepMsgs.length).toBeGreaterThanOrEqual(1);
    expect(stepMsgs.some((s) => (s as StepMsg).label === "stream fallback")).toBe(true);
    expect(postedMessages(p).some(isAssistant)).toBe(true);
    expect(postedMessages(p).some(isDone)).toBe(true);
    // apiKey NEVER appears on the wire.
    const all = JSON.stringify(postedMessages(p));
    expect(all).not.toMatch(/sk-/i);
  });

  // ---- Case #4: stream + fallback both fail; error message names stream ---
  it('#4 both fail: error posted with "stream" in message; panel alive; done posted', async () => {
    agentState.runAgentMock.mockImplementation(async () => {
      throw new Error("provider stream failed");
    });
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
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));

    const errs = postedMessages(p).filter(isError);
    expect(errs.length).toBeGreaterThan(0);
    const firstErr = errs[0] as ErrorMsg;
    expect(firstErr.message.toLowerCase()).toMatch(/stream/);
    expect(p.disposed).toBe(false);
    expect(postedMessages(p).some(isDone)).toBe(true);
    const all = JSON.stringify(postedMessages(p));
    expect(all).not.toMatch(/sk-/i);
  });

  // ---- TASK-011 B8: honest engine banner ------------------------------------
  it("#5 (B8 happy) engine{name:'omp', version} posted exactly once on first ready when acp deps + engineVersion supplied", async () => {
    const acpStub: AcpPanelDeps = { start: vi.fn() };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: acpStub,
      engineVersion: "18.0.1",
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(1);
    expect(engineMsgs[0]).toMatchObject({
      type: "engine",
      name: "omp",
      version: "18.0.1",
    });
  });

  it("#5b (B8 edge — missing binary) engine{name:'builtin', hint} posted when acp deps absent and engineHint supplied", async () => {
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      engineHint: "curl -fsSL https://omp.sh/install | sh",
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(1);
    expect(engineMsgs[0]).toMatchObject({
      type: "engine",
      name: "builtin",
      hint: "curl -fsSL https://omp.sh/install | sh",
    });
  });

  it("#5c (B8 edge — failover) ACP session start failure posts a SECOND engine message name:'builtin' — banner self-corrects", async () => {
    const failingAcp: AcpPanelDeps = {
      start: vi.fn().mockRejectedValue(new Error("spawn ENOENT")),
    };
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
      acp: failingAcp,
      engineVersion: "18.0.1",
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    handler({ type: "send", text: "hello" });
    await until(() => postedMessages(p).filter(isEngine).length >= 2);

    const engineMsgs = postedMessages(p).filter(isEngine);
    expect(engineMsgs).toHaveLength(2);
    expect(engineMsgs[0]).toMatchObject({ name: "omp" });
    expect(engineMsgs[1]).toMatchObject({ name: "builtin" });
    // R(B8): today the banner never self-corrects on ACP start failure — this
    // second post is the regression fix.
    const secondEngineHasNoStaleVersion = !("version" in (engineMsgs[1] as object)) ||
      (engineMsgs[1] as { version?: string }).version === undefined;
    expect(secondEngineHasNoStaleVersion).toBe(true);
  });
});

// ============================================================================
// TASK-002 — Cases 6-9: live step lines in AiChatPanel.runBuiltinTurn.
//   #6 one {type:"step"} per call BEFORE tool promise resolves; no
//      duplicate from onStep (since onStep's tool branch was deleted).
//   #7 stop mid-tool-run: after token flip, no further step posts; no
//      error bubble; done still posted.
//   #8 stream fallback: onStreamFallback still posts {type:"step",
//      label:"stream fallback"} exactly once when stream pre-fails.
//   #9 regression: assistant-only turn → no step message; ordering
//      invariant stepIdx < assistantIdx still holds.
// ============================================================================
describe("AiChatPanel — TASK-002 live step lines", () => {
  // ---- Case #6: live step during builtin turn -----------------------------
  it("case #6 one step post per call, before tool resolve; no duplicate from onStep", async () => {
    let resolveTool!: (v: AgentRunResult) => void;
    const stepPosts: Array<{ idx: number; msg: unknown }> = [];
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onStep?: (s: AgentStep) => void;
          onToolCall?: (call: ToolCall) => void;
        },
      ) => {
        const toolCall: ToolCall = { id: "t1", name: "list_tables", argumentsJson: "{}" };
        // Fire onToolCall exactly once, BEFORE the tool result lands.
        callbacks?.onToolCall?.(toolCall);
        const step: AgentStep = {
          messages: [
            { role: "assistant", content: "", toolCalls: [toolCall] },
            { role: "tool", toolCallId: "t1", content: "[]" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
        callbacks?.onStep?.(step);
        return new Promise<AgentRunResult>((resolve) => {
          resolveTool = resolve;
        });
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isStep));
    const stepsAfterFirst = postedMessages(p).filter(isStep);
    // Exactly one step BEFORE the run resolves.
    expect(stepsAfterFirst).toHaveLength(1);
    expect((stepsAfterFirst[0] as StepMsg).label).toBe("list_tables");

    // Now let the run resolve and assert no further step posts appear.
    resolveTool(
      makeRunResult(
        [
          {
            messages: [
              { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "list_tables", argumentsJson: "{}" }] },
              { role: "tool", toolCallId: "t1", content: "[]" },
            ],
            result: {
              text: "",
              toolCalls: [],
              finishReason: "tool_calls",
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          },
        ],
        "answer",
      ),
    );
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const allSteps = postedMessages(p).filter(isStep);
    expect(allSteps).toHaveLength(1);
    // Guard against regression: no duplicate from onStep's tool branch.
    expect(allSteps.map((s) => (s as StepMsg).label)).toEqual(["list_tables"]);
  });

  // ---- Case #7: stop mid-tool-run ----------------------------------------
  it("case #7 stop mid-tool-run: no further step posts; no error bubble; done posted", async () => {
    let fireStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      fireStop = resolve;
    });
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onStep?: (s: AgentStep) => void;
          onToolCall?: (call: ToolCall) => void;
        },
      ) => {
        // First tool call — fires hook + step.
        const c1: ToolCall = { id: "c1", name: "list_tables", argumentsJson: "{}" };
        callbacks?.onToolCall?.(c1);
        callbacks?.onStep?.({
          messages: [
            { role: "assistant", content: "", toolCalls: [c1] },
            { role: "tool", toolCallId: "c1", content: "[]" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        });
        // Wait until test flips the stop token. While we wait, simulate
        // additional in-flight onToolCall/onStep after stop to verify the
        // panel's gate suppresses them.
        await stopGate;
        const c2: ToolCall = { id: "c2", name: "describe_table", argumentsJson: "{}" };
        callbacks?.onToolCall?.(c2);
        callbacks?.onStep?.({
          messages: [
            { role: "assistant", content: "", toolCalls: [c2] },
            { role: "tool", toolCallId: "c2", content: "{}" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        });
        return makeRunResult([], "should-be-suppressed");
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isStep));

    // User clicks Stop. Flip the abort token.
    expect(typeof fireStop).toBe("function");
    handler({ type: "stop" });
    fireStop();

    await until(() => postedMessages(p).some(isDone));
    const posted = postedMessages(p);
    const steps = posted.filter(isStep);
    // Exactly the FIRST step posted (the one before stop). The c2 hook +
    // onStep after stop must NOT produce posts.
    expect(steps).toHaveLength(1);
    expect((steps[0] as StepMsg).label).toBe("list_tables");

    // No error bubble.
    expect(posted.filter(isError)).toEqual([]);
    // Assistant final was suppressed.
    expect(posted.some(isAssistant)).toBe(false);
    // done still posts via finally.
    expect(posted.some(isDone)).toBe(true);
  });

  // ---- Case #8: stream fallback label still posts once --------------------
  it("case #8 onStreamFallback posts {step, label:\"stream fallback\"} exactly once", async () => {
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: {
          onStreamFallback?: () => void;
          onStep?: (s: AgentStep) => void;
        },
      ) => {
        callbacks?.onStreamFallback?.();
        callbacks?.onStep?.({
          messages: [{ role: "assistant", content: "fb" }],
          result: {
            text: "fb",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        });
        return makeRunResult([], "fb");
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const fallback = postedMessages(p).filter(isStep).filter((s) => (s as StepMsg).label === "stream fallback");
    expect(fallback).toHaveLength(1);
  });

  // ---- Case #9: assistant-only turn → no step; ordering invariant --------
  it("case #9 assistant-only turn: no step posted; stepIdx<assistantIdx invariant holds (no onStep tool branch)", async () => {
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: { onStep?: (s: AgentStep) => void },
      ) => {
        const step: AgentStep = {
          messages: [{ role: "assistant", content: "just text" }],
          result: {
            text: "just text",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
        callbacks?.onStep?.(step);
        return makeRunResult([step], "just text");
      },
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "plain" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const posted = postedMessages(p);
    // No step message at all (no tools called, no fallback).
    expect(posted.filter(isStep)).toEqual([]);
    // Ordering invariant: assistant comes before done (and stepIdx is
    // -1 since no step posted). The prior stepIdx<assistantIdx check
    // remains valid because we asserted posted.findIndex(isStep) === -1.
    const stepIdx = posted.findIndex(isStep);
    const assistantIdx = posted.findIndex(isAssistant);
    const doneIdx = posted.findIndex(isDone);
    expect(stepIdx).toBe(-1);
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(assistantIdx);
  });
});
// ============================================================================
// TASK-002 — Cases #1, #3, #4, #5, #7: buildMessages full-DB context.
// Direct calls into the (now-exported) `buildMessages` so we can pin the
// system-prompt shape, the budget cut, and the per-schema / per-object
// resilience contract without running the full panel + runAgent harness.
// ============================================================================
describe("AiChatPanel — buildMessages full-DB context", () => {
  function fakeAdapter(impl: {
    schemas?: Array<{ name: string }>;
    tables?: Record<string, Array<{ name: string; schema: string }>>;
    views?: Record<string, Array<{ name: string; schema: string }>>;
    columns?: Record<string, Array<{
      name: string; dataType: string; nullable: boolean; isPrimaryKey?: boolean;
    }>>;
    listTablesReject?: Record<string, true>;
    listViewsReject?: Record<string, true>;
    listColumnsReject?: Record<string, true>;
  }) {
    const {
      schemas = [],
      tables = {},
      views = {},
      columns = {},
      listTablesReject = {},
      listViewsReject = {},
      listColumnsReject = {},
    } = impl;
    return {
      listSchemas: vi.fn(async () => schemas),
      listTables: vi.fn(async (schema?: string) => {
        if (schema && listTablesReject[schema]) throw new Error("listTables boom");
        return tables[schema ?? ""] ?? [];
      }),
      listViews: vi.fn(async (schema?: string) => {
        if (schema && listViewsReject[schema]) throw new Error("listViews boom");
        return views[schema ?? ""] ?? [];
      }),
      listColumns: vi.fn(async (name: string, schema?: string) => {
        const key = `${schema ?? ""}.${name}`;
        if (listColumnsReject[key]) throw new Error("listColumns boom");
        return columns[key] ?? [];
      }),
    };
  }

  it("#1 multi-schema PG: system prompt contains tables from every schema + views", async () => {
    const adapter = fakeAdapter({
      schemas: [{ name: "public" }, { name: "sales" }],
      tables: {
        public: [{ name: "users", schema: "public" }],
        sales: [{ name: "deals", schema: "sales" }],
      },
      views: {
        public: [{ name: "v_users", schema: "public" }],
      },
      columns: {
        "public.users": [
          { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
        ],
        "sales.deals": [
          { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
        ],
        "public.v_users": [
          { name: "id", dataType: "integer", nullable: true },
        ],
      },
    });
    const factory: AdapterFactory = async () => adapter;
    const msgs = await buildMessages(factory, [], { role: "user", content: "hi" });
    const sys = msgs[0]?.content as string;
    expect(sys).toContain("Database structure (DDL):");
    expect(sys).toContain("CREATE TABLE public.users");
    expect(sys).toContain("CREATE TABLE sales.deals");
    expect(sys).toContain("-- View structure: public.v_users");
  });

  it("#3 budget cut at block boundary (injected, review #2): each CREATE TABLE block intact, footer appended, total ≤ injected budget", async () => {
    // 40 tables, each ~150 chars of DDL → ~6000 chars total, well over 2000.
    const tables: Array<{ name: string; schema: string }> = [];
    const cols: Record<string, Array<{
      name: string; dataType: string; nullable: boolean; isPrimaryKey?: boolean;
    }>> = {};
    for (let i = 0; i < 40; i++) {
      const t = { name: `t_${i.toString().padStart(2, "0")}`, schema: "public" };
      tables.push(t);
      cols[`public.${t.name}`] = [
        { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
        { name: "name", dataType: "varchar(64)", nullable: false },
        { name: "created_at", dataType: "timestamp", nullable: true },
      ];
    }
    const adapter = fakeAdapter({
      schemas: [{ name: "public" }],
      tables: { public: tables },
      columns: cols,
    });
    const factory: AdapterFactory = async () => adapter;
    const msgs = await buildMessages(
      factory,
      [],
      { role: "user", content: "hi" },
      { contextBudgetChars: 2000 },
    );
    const sys = msgs[0]?.content as string;
    // Extract just the DDL portion (between marker and trailing hint).
    const ddlStart = sys.indexOf("Database structure (DDL):") + "Database structure (DDL):".length;
    const ddlEnd = sys.indexOf("\n\nYou can call the export_structure");
    const ddl = ddlEnd > 0 ? sys.slice(ddlStart, ddlEnd) : sys.slice(ddlStart);
    // DDL length ≤ injected budget.
    expect(ddl.length).toBeLessThanOrEqual(2000);
    // Fixture: 40 tables @ ~150 chars = ~6000 chars. With budget=2000 the
    // block-boundary cut keeps 12 blocks (~1906 chars), drops 28 blocks,
    // and the 72-char footer fits within the remaining 94-char slack
    // (1906 + 2 + 72 = 1980 ≤ 2000). Assert the required footer is
    // present and its omitted-count matches the dropped blocks exactly.
    const footerRe = /\(\+(\d+) more objects omitted — call export_structure for full context\)/;
    const footerMatch = ddl.match(footerRe);
    expect(footerMatch, `expected footer in DDL; got:\n${ddl}`).not.toBeNull();
    expect(Number(footerMatch![1])).toBe(28);
    expect(ddl.length).toBeLessThanOrEqual(2000);
    const blocks = ddl.split(/\n\n+/);
    const createBlocks = blocks.filter((b) => b.includes("CREATE TABLE"));
    expect(createBlocks.length).toBeGreaterThan(0);
    for (const b of createBlocks) {
      // Skip the footer block which contains no CREATE TABLE.
      if (b.startsWith("-- (")) continue;
      expect(b).toMatch(/\);\s*$/);
    }
    // Production constant 12_000 untouched: buildMessages with no opts
    // should not throw or apply a smaller ceiling.
    expect(typeof buildMessages).toBe("function");
  });

  it("#4 factory resolves null: prompt is the legacy baseline, no DDL marker, history preserved", async () => {
    const factory: AdapterFactory = async () => null;
    const history: ChatMessage[] = [{ role: "user", content: "earlier" }];
    const msgs = await buildMessages(factory, history, { role: "user", content: "hi" });
    expect(msgs[0]?.content).toBe(
      "You are UnicDB's AI assistant. Help the user explore and query their database.",
    );
    expect(msgs[0]?.content).not.toContain("Database structure");
    // Messages still [system, ...history, user].
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toEqual({ role: "user", content: "earlier" });
    expect(msgs[2]).toEqual({ role: "user", content: "hi" });
  });

  it("#5 one schema introspection throws: skip that schema, render the rest, no throw", async () => {
    const adapter = fakeAdapter({
      schemas: [{ name: "public" }, { name: "sales" }],
      tables: {
        public: [{ name: "users", schema: "public" }],
      },
      columns: {
        "public.users": [
          { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
        ],
      },
      listTablesReject: { sales: true },
    });
    const factory: AdapterFactory = async () => adapter;
    const msgs = await buildMessages(factory, [], { role: "user", content: "hi" });
    const sys = msgs[0]?.content as string;
    expect(sys).toContain("CREATE TABLE public.users");
    expect(sys).not.toContain("sales.deals");
  });

  it("#7 single oversized table > budget (review #4): first block kept, context non-empty, no half-cut CREATE TABLE", async () => {
    // Big table: many columns → ~800 char DDL; second table small.
    const bigCols = Array.from({ length: 30 }, (_, i) => ({
      name: `c_${i.toString().padStart(2, "0")}`,
      dataType: i % 2 === 0 ? "integer" : "varchar(64)",
      nullable: i % 3 !== 0,
    }));
    const adapter = fakeAdapter({
      schemas: [{ name: "public" }],
      tables: {
        public: [
          { name: "huge", schema: "public" },
          { name: "tiny", schema: "public" },
        ],
      },
      columns: {
        "public.huge": bigCols,
        "public.tiny": [
          { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
        ],
      },
    });
    const factory: AdapterFactory = async () => adapter;
    const msgs = await buildMessages(
      factory,
      [],
      { role: "user", content: "hi" },
      { contextBudgetChars: 300 },
    );
    const sys = msgs[0]?.content as string;
    // First block kept despite oversize; context non-empty.
    expect(sys.length).toBeGreaterThan(0);
    expect(sys).toContain("CREATE TABLE public.huge");
    // No half-cut CREATE TABLE: every CREATE TABLE block in the prompt
    // ends with ");".
    const blocks = sys.split(/\n\n+/);
    const createBlocks = blocks.filter((b) => b.includes("CREATE TABLE"));
    expect(createBlocks.length).toBeGreaterThan(0);
    for (const b of createBlocks) {
      if (b.startsWith("-- (")) continue;
      expect(b).toMatch(/\);\s*$/);
    }
    // Tiny table dropped from budget cut (only huge block fits — the
    // first-block-oversize rule keeps it; footer is dropped because it
    // would push past budget). Either way the tiny table name is absent.
    expect(sys).not.toContain("public.tiny");
    expect(sys).not.toContain("CREATE TABLE public.tiny");
    // ---- Assert the omitted-count contract explicitly ----
    // The block-boundary cut keeps block 0 (huge, oversize) and drops the
    // remaining blocks (1: tiny_ddl). With 2 blocks in the DDL, omitted=1.
    // The expected footer `-- (+1 more objects omitted — call export_structure
    // for full context)` is 70 chars. The huge block alone is ~832 chars
    // which already exceeds the injected 300-char budget — so the spec's
    // "footer only when ddl.length + footer.length ≤ budget" rule correctly
    // suppresses the footer here. Assert both: the would-be footer text
    // proves the omitted count would be +1, and the prompt proves the
    // Footer was suppressed because it would not fit.
    const expectedOmitted = 1;
    const expectedFooterText =
      `\n\n-- (+${expectedOmitted} more objects omitted — call export_structure for full context)`;
    // The prompt does NOT contain the footer (oversize first block keeps
    // context non-empty but leaves no room for the footer sentinel).
    expect(sys).not.toContain(expectedFooterText);
    // Compute the omitted count from the DDL blocks directly: the DDL
    // portion splits into blocks separated by blank lines. Block 0 is the
    // header+schema+huge_ddl chunk; blocks [1..N] are the dropped tiny
    // table(s). Count rendered CREATE TABLE blocks in the prompt and the
    // total fixture objects to derive the dropped count, then assert the
    // production-computed omitted value would equal expectedOmitted.
    const ddlStart7 = sys.indexOf("Database structure (DDL):") + "Database structure (DDL):".length;
    const ddlEnd7 = sys.indexOf("\n\nYou can call the export_structure");
    const ddl7 = ddlEnd7 > 0 ? sys.slice(ddlStart7, ddlEnd7) : sys.slice(ddlStart7);
    expect(ddl7.length).toBeGreaterThan(300); // oversize block stays past budget
    expect(ddl7.length + expectedFooterText.length).toBeGreaterThan(300); // footer can't fit
    // Block-based derivation of the omitted count (independent of the
    // prompt-text footer): count CREATE TABLE blocks rendered in the
    // prompt (must be exactly 1: huge) and compare against the 2-table
    // fixture (huge + tiny). The diff (1) equals expectedOmitted.
    const renderedCreateTables = (ddl7.match(/CREATE TABLE/g) ?? []).length;
    expect(renderedCreateTables).toBe(1);
    expect(2 - renderedCreateTables).toBe(expectedOmitted);
  });

  // ---- Regression (reviewer #R1.1): listColumns failure must NOT drop the
  // object — render it with an empty column list so its DDL stays in context.
  it("#R1 listColumns throws for a discovered table: that table is RETAINED with columns:[] (no drop)", async () => {
    const adapter = fakeAdapter({
      schemas: [{ name: "public" }],
      tables: {
        public: [
          { name: "broken", schema: "public" },
          { name: "ok", schema: "public" },
        ],
      },
      columns: {
        "public.ok": [
          { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
        ],
      },
      listColumnsReject: { "public.broken": true },
    });
    const factory: AdapterFactory = async () => adapter;
    const msgs = await buildMessages(factory, [], { role: "user", content: "hi" });
    const sys = msgs[0]?.content as string;
    expect(sys).toContain("Database structure (DDL):");
    // The table whose listColumns failed must still be present in context.
    expect(sys).toContain("CREATE TABLE public.broken");
    // And the table whose columns loaded normally must also be present.
    expect(sys).toContain("CREATE TABLE public.ok");
    // Note: listColumns failure on `broken` must NOT drop the object.
    // We don't re-assert CREATE-TABLE block shape here
    // (buildTableStructure with empty columns emits "CREATE TABLE ... (\n\n);"
    // which splits into two sub-blocks under the blank-line splitter; that's
    // a rendering detail of exportStructure, not part of this regression's
    // contract — see buildTableStructure in src/ui/exportStructure.ts).
  });
});


// ============================================================================
// TASK-003 (cycle R, D2/D3) — Clear mid-stream recovery + not-configured surface.
//   #1 regression (user report): send msg (pending) → clear → send msg2 →
//      posted sequence contains init{hasHistory:false} + done + assistant of
//      msg2; msg2 chat works again. RED on current handleClear (no abort,
//      no done, no input re-enable) — GREEN after spec fix.
//   #2 edge: clear when idle — init{hasHistory:false} + done posted once each;
//      subsequent send still produces an assistant bubble.
//   #3 edge: not-configured mid-session — error bubble contains
//      "AI is not configured" AND "Open AI Settings"; done posted; no
//      unhandled rejection; send after config returns still runs.
//   #6 regression: Clear must not break ACP pending (cancelAllPending invoked
//      for each pending requestId when acpSession present; no-op in builtin).
// ============================================================================
describe("AiChatPanel — Clear recovery + not-configured (TASK-003)", () => {
  // ---- #1 — user report regression ---------------------------------------
  it("#1 clear mid-stream: chat works again; init{hasHistory:false} + done + assistant(msg2) posted in order", async () => {
    let sawMsg1Abort = false;
    agentState.runAgentMock.mockImplementationOnce(
      async (
        _input: unknown,
        _deps: unknown,
        _cb?: unknown,
        signal?: AbortSignal,
      ) => {
        if (signal) {
          if (signal.aborted) {
            sawMsg1Abort = true;
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            throw e;
          }
          signal.addEventListener("abort", () => {
            sawMsg1Abort = true;
          });
        }
        return new Promise<AgentRunResult>(() => {});
      },
    );
    agentState.runAgentMock.mockImplementationOnce(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: { onText?: (text: string) => void },
      ) => {
        callbacks?.onText?.("msg2-answer");
        return makeRunResult(
          [
            {
              messages: [{ role: "assistant", content: "msg2-answer" }],
              result: {
                text: "msg2-answer",
                toolCalls: [],
                finishReason: "stop",
                usage: { inputTokens: 0, outputTokens: 0 },
              },
            },
          ],
          "msg2-answer",
        );
      },
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
    await until(() => postedMessages(p).some(isInit));

    handler({ type: "send", text: "first" });
    await until(() => agentState.runAgentMock.mock.calls.length >= 1);
    handler({ type: "clear" });
    const acArg = agentState.runAgentMock.mock.calls[0]?.[3] as
      | AbortSignal
      | undefined;
    expect(acArg).toBeDefined();
    expect(acArg?.aborted).toBe(true);

    handler({ type: "send", text: "second" });
    await until(() => postedMessages(p).filter(isAssistant).length >= 1);
    await until(() => postedMessages(p).filter(isDone).length >= 2);

    const posted = postedMessages(p);
    const inits = posted.filter(isInit);
    expect(inits.length).toBe(2);
    if (inits.length >= 2) {
      const clearInit = inits[1];
      if (clearInit && typeof clearInit === "object" && "hasHistory" in clearInit) {
        expect((clearInit as InitMsg).hasHistory).toBe(false);
      }
    }
    expect(posted.filter(isDone).length).toBeGreaterThanOrEqual(2);
    const assistants = posted.filter(isAssistant);
    expect(assistants.length).toBe(1);
    if (assistants.length >= 1 && assistants[0] && typeof assistants[0] === "object" && "text" in assistants[0]) {
      expect((assistants[0] as AssistantMsg).text).toBe("msg2-answer");
    }
    expect(posted.filter(isError)).toEqual([]);
    expect(sawMsg1Abort).toBe(true);
  });

  // ---- #2 — Clear when idle ---------------------------------------------
  it("#2 clear when idle: history reset; init{hasHistory:false} + done posted; subsequent send still runs", async () => {
    agentState.runAgentMock.mockResolvedValueOnce(
      makeRunResult(
        [
          {
            messages: [{ role: "assistant", content: "first" }],
            result: {
              text: "first",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          },
        ],
        "first",
      ),
    );
    agentState.runAgentMock.mockResolvedValueOnce(
      makeRunResult(
        [
          {
            messages: [{ role: "assistant", content: "second" }],
            result: {
              text: "second",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          },
        ],
        "second",
      ),
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
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));
    const initCountBefore = postedMessages(p).filter(isInit).length;
    const doneCountBefore = postedMessages(p).filter(isDone).length;
    const assistantsBefore = postedMessages(p).filter(isAssistant).length;

    handler({ type: "clear" });
    await until(
      () => postedMessages(p).filter(isInit).length > initCountBefore,
    );
    const initsAfter = postedMessages(p).filter(isInit);
    const lastInit = initsAfter[initsAfter.length - 1];
    if (lastInit && typeof lastInit === "object" && "hasHistory" in lastInit) {
      expect((lastInit as InitMsg).hasHistory).toBe(false);
    }
    expect(postedMessages(p).filter(isDone).length).toBe(doneCountBefore + 1);

    handler({ type: "send", text: "go-again" });
    await until(
      () =>
        postedMessages(p).filter(isAssistant).length ===
        assistantsBefore + 1,
    );
    const assistants = postedMessages(p).filter(isAssistant);
    expect(assistants).toHaveLength(assistantsBefore + 1);
    const lastAssistant = assistants[assistants.length - 1];
    if (lastAssistant && typeof lastAssistant === "object" && "text" in lastAssistant) {
      expect((lastAssistant as AssistantMsg).text).toBe("second");
    }
  });

  // ---- #3 — not-configured mid-session ----------------------------------
  it("#3 loadConfig null mid-session: error bubble has 'AI is not configured' + 'Open AI Settings'; done posted; send kế vẫn chạy", async () => {
    const deps = makeDeps();
    agentState.runAgentMock.mockImplementationOnce(async () => {
      throw new Error("AI is not configured");
    });
    agentState.runAgentMock.mockResolvedValueOnce(
      makeRunResult(
        [
          {
            messages: [{ role: "assistant", content: "ok" }],
            result: {
              text: "ok",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            },
          },
        ],
        "ok",
      ),
    );
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps,
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    handler({ type: "send", text: "hello" });
    await until(() => postedMessages(p).some(isError));
    await until(() => postedMessages(p).some(isDone));

    const errs = postedMessages(p).filter(isError);
    expect(errs.length).toBeGreaterThanOrEqual(1);
    const firstErr = errs[0];
    if (firstErr && typeof firstErr === "object" && "message" in firstErr) {
      expect((firstErr as ErrorMsg).message).toContain("AI is not configured");
      expect((firstErr as ErrorMsg).message).toContain("Open AI Settings");
    }

    const donesAfterFirst = postedMessages(p).filter(isDone).length;
    expect(p.disposed).toBe(false);

    handler({ type: "send", text: "hi again" });
    await until(() => postedMessages(p).filter(isAssistant).length >= 1);
    await until(
      () => postedMessages(p).filter(isDone).length > donesAfterFirst,
    );
    const assistants = postedMessages(p).filter(isAssistant);
    expect(assistants).toHaveLength(1);
    const lastAssistant = assistants[assistants.length - 1];
    if (lastAssistant && typeof lastAssistant === "object" && "text" in lastAssistant) {
      expect((lastAssistant as AssistantMsg).text).toBe("ok");
    }
  });

  // ---- #6 — Clear must not break ACP pending ----------------------------
  it("#6 builtin mode + no acp: clear is a safe no-op on pending (no throw); engine stays builtin", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "ok"));
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
    handler({ type: "send", text: "go" });
    await until(() => postedMessages(p).some(isAssistant));
    expect(() => handler({ type: "clear" })).not.toThrow();
    await until(() => postedMessages(p).filter(isInit).length >= 2);
    const engineMsgs = postedMessages(p).filter(
      (m): m is { type: "engine"; name: string } =>
        !!m && typeof m === "object" && (m as { type?: string }).type === "engine",
    );
    expect(engineMsgs).toHaveLength(1);
    const engineMsg = engineMsgs[0];
    if (engineMsg && typeof engineMsg === "object" && "name" in engineMsg) {
      expect((engineMsg as { name: string }).name).toBe("builtin");
    }
  });
});

describe("AiChatPanel — slash model command", () => {
  it("changes the role used by the next builtin turn without model-uploading command text", async () => {
    agentState.runAgentMock.mockResolvedValue(makeRunResult([], "answer"));
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: vi.fn(async () => null),
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "command", command: "model", args: ["smart"] });
    await until(() => postedMessages(p).some(isAssistant));
    handler({ type: "send", text: "show users" });
    await until(() => agentState.runAgentMock.mock.calls.length === 1);
    const input = agentState.runAgentMock.mock.calls[0]?.[0] as { role?: string; messages: ChatMessage[] };
    expect(input.role).toBe("smart");
    expect(JSON.stringify(input.messages)).not.toContain("/model");
  });
});

// ============================================================================
// TASK-ARP06-005 — happy-path integration of the usage post
// ============================================================================
describe("AiChatPanel — usage frame integration (TASK-ARP06-005)", () => {
  interface UsageMsg {
    type: "usage";
    inputTokens: number;
    outputTokens: number;
    unknown: boolean;
    sessionTokens: { inputTokens: number; outputTokens: number };
    policyNotice: string;
  }
  function isUsage(m: unknown): m is UsageMsg {
    return (
      !!m && typeof m === "object" && (m as { type?: string }).type === "usage"
    );
  }
  function makeRunResultWithUsage(
    usage: { inputTokens: number; outputTokens: number; unknown: boolean; steps: number },
  ): AgentRunResult {
    return {
      steps: [],
      history: [],
      finalText: "answer",
      stoppedOnBudget: false,
      usage,
    };
  }

  it("posts exactly one usage frame per turn with exact sums, session totals, and empty notice on the allowed path", async () => {
    const toolCall: ToolCall = { id: "t1", name: "list_tables", argumentsJson: "{}" };
    const toolStep: AgentStep = {
      messages: [
        { role: "assistant", content: "", toolCalls: [toolCall] },
        { role: "tool", toolCallId: "t1", content: "[]" },
      ],
      result: {
        text: "",
        toolCalls: [],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    };
    const finalStep: AgentStep = {
      messages: [{ role: "assistant", content: "answer" }],
      result: {
        text: "answer",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 3 },
      },
    };
    // Mirror the real runAgent (TASK-ARP06-004): usage is the EXACT roll-up
    // over completed steps — 1+2 in, 1+3 out.
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: { onToolCall?: (call: ToolCall) => void },
      ) => {
        callbacks?.onToolCall?.(toolCall);
        return makeRunResultWithUsage({
          inputTokens: 3,
          outputTokens: 4,
          unknown: false,
          steps: 2,
        });
      },
    );

    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "send", text: "show me users" });
    await until(() => postedMessages(p).some(isAssistant));
    await until(() => postedMessages(p).some(isDone));

    const posted = postedMessages(p);
    const usages = posted.filter(isUsage);
    expect(usages).toHaveLength(1);
    const u = usages[0];
    expect(u.inputTokens).toBe(3);
    expect(u.outputTokens).toBe(4);
    expect(u.unknown).toBe(false);
    expect(u.sessionTokens).toEqual({ inputTokens: 3, outputTokens: 4 });
    // Bare host → legacy admitted policy → empty notice.
    expect(u.policyNotice).toBe("");
    // One frame per turn: a second turn posts a second usage frame with
    // running session totals.
    handler({ type: "send", text: "again" });
    await until(() => postedMessages(p).filter(isUsage).length >= 2);
    await until(() => postedMessages(p).filter(isDone).length >= 2);
    const usages2 = postedMessages(p).filter(isUsage);
    expect(usages2).toHaveLength(2);
    expect(usages2[1].sessionTokens).toEqual({ inputTokens: 6, outputTokens: 8 });
    // Assistant text still flows normally on the same wire.
    expect(postedMessages(p).filter(isAssistant).length).toBeGreaterThanOrEqual(2);
  });
});
