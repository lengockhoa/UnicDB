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
import { AiChatPanel } from "../aiChatPanel";

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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
        callbacks?: { onStep?: (s: AgentStep) => void },
      ) => {
        callbacks?.onStep?.(toolStep);
        callbacks?.onStep?.(finalStep);
        return makeRunResult([toolStep, finalStep], "answer");
      },
    );

    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
        callbacks?: { onStep?: (s: AgentStep) => void },
      ) => {
        const toolCall: ToolCall = { id: "t1", name: "list_tables", argumentsJson: "{}" };
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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
        callbacks?: { onStep?: (s: AgentStep) => void },
      ) => {
        const step1: AgentStep = {
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "a", name: "list_tables", argumentsJson: "{}" }],
            },
            { role: "tool", toolCallId: "a", content: "[]" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
        callbacks?.onStep?.(step1);
        await secondGate;
        const step2: AgentStep = {
          messages: [
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "b", name: "describe_table", argumentsJson: "{}" }],
            },
            { role: "tool", toolCallId: "b", content: "{}" },
          ],
          result: {
            text: "",
            toolCalls: [],
            finishReason: "tool_calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        };
        callbacks?.onStep?.(step2);
        return makeRunResult([step1, step2], "x");
      },
    );
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
    const panel = new AiChatPanel(extUri, makeDeps(), factory);
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
