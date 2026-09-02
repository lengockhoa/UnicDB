// src/ui/__tests__/aiChatPanelPlan.test.ts — TASK-AIX04-003
//
// Host-level consent flow for the plan_change card:
//   1. plan_change ok envelope → change_plan card posted + pendingPlan set
//   2. plan_approve → drift re-check → confirmDangerousStatements →
//      sequential apply with per-statement progress → done/partial report
//   3. confirm denied → denied tool_result, ZERO runQuery
//   4. drift at approve → stale card + error, ZERO runQuery
//   5. mid-run failure → applied/failedAt report
//   6. plan_reject → pendingPlan cleared, ZERO runQuery
//
// Pattern mirrors aiChatPanel.test.ts: vi.mock("vscode"), vi.mock the
// consent gate so the vscode modal is never touched, and drive the panel
// through the fake webview handler.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type {
  AgentDeps,
  AgentRunResult,
} from "../../ai/agent";
import type {
  ChatMessage,
  ToolCall,
} from "../../ai/provider";
import type { AdapterFactory } from "../../ai/tools/types";
import { AiChatPanel } from "../aiChatPanel";

const consentState = vi.hoisted(() => ({
  confirmMock: vi.fn(),
}));

vi.mock("../confirmDangerous", () => ({
  confirmDangerousStatements: consentState.confirmMock,
  RED_DETAIL_CAP: 2000,
  AMBER_DETAIL_CAP: 500,
}));

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
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    setStatusBarMessage: vi.fn(),
    createStatusBarItem: vi.fn(() => ({
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      text: "",
      command: undefined,
    })),
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
      clear: vi.fn(),
    })),
    createTreeView: vi.fn(() => ({
      onDidChangeSelection: vi.fn(() => ({ dispose: () => {} })),
      reveal: vi.fn(),
      dispose: vi.fn(),
      visible: true,
    })),
    registerWebviewPanelSerializer: vi.fn(),
    registerTreeDataProvider: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: () => {} })),
    onDidCloseTerminal: vi.fn(() => ({ dispose: () => {} })),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn(() => undefined),
      update: vi.fn(),
      has: vi.fn(() => false),
    })),
    workspaceFolders: [],
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    fs: { readFile: vi.fn() },
  },
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p })),
    joinPath: vi.fn(() => ({ fsPath: "/ext/dist" })),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn(() => ({ dispose: () => {} })),
  },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
  ViewColumn: { Active: 1 },
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

interface PlanMsg {
  type: "change_plan";
  plan: { drifted: boolean; statements: unknown[] };
}
function isPlan(m: unknown): m is PlanMsg {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "change_plan";
}
function isToolResult(m: unknown): m is { type: "tool_result"; status: string; summary: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "tool_result";
}
function isAssistant(m: unknown): m is { type: "assistant"; text: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "assistant";
}
function isError(m: unknown): m is { type: "error"; message: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
function isDone(m: unknown): m is { type: "done" } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
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

/** Fake adapter with runQuery + listColumns. */
function makeAdapter(opts: {
  columns?: string[];
  failAt?: number; // 1-based statement index that throws
  runCalls?: { current: number };
}) {
  return {
    runQuery: async (_sql: string) => {
      if (opts.runCalls) opts.runCalls.current += 1;
      const n = opts.runCalls?.current ?? 1;
      if (opts.failAt !== undefined && n === opts.failAt) {
        throw new Error(`boom at ${n}`);
      }
      return { results: [] };
    },
    listColumns: async () =>
      (opts.columns ?? ["a", "b"]).map((name) => ({
        name,
        dataType: "int",
        nullable: true,
      })),
  };
}

const planEnvelope = (opts?: {
  drift?: string[];
  drifted?: boolean;
}): string =>
  JSON.stringify({
    ok: true,
    plan: {
      intent: "add column c",
      statements: [
        { sql: "UPDATE users SET b = 1 WHERE a = 2", tier: "amber", dangerNote: "" },
        { sql: "DELETE FROM users WHERE a = 1", tier: "amber", dangerNote: "" },
      ],
      drift: opts?.drift ?? [],
      drifted: opts?.drifted ?? false,
      targetSchema: "public",
      targetTable: "users",
    },
  });

/** Send a turn whose only tool result is the plan envelope. */
function runTurnWithPlan(panel: MockPanel, envelope: string): void {
  const toolCall: ToolCall = { id: "t1", name: "plan_change", argumentsJson: "{}" };
  agentState.runAgentMock.mockImplementation(
    async (
      _input: unknown,
      _deps: unknown,
      callbacks?: {
        onToolResult?: (call: ToolCall, outcome: { status: string; resultText: string }) => void;
        onStep?: (s: unknown) => void;
      },
    ) => {
      callbacks?.onToolResult?.(toolCall, { status: "ok", resultText: envelope });
      return makeRunResult("Here is the plan.");
    },
  );
  void panel.webview.postMessage; // panel wired through harness handler instead
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
  consentState.confirmMock.mockReset();
});

describe("AiChatPanel — plan_change consent flow", () => {
  it("posts change_plan card from a plan_change ok envelope (no plain tool_result)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    const plan = postedMessages(p).find(isPlan)!;
    expect(plan.plan.drifted).toBe(false);
    expect(plan.plan.statements).toHaveLength(2);
    // No plain tool_result for the plan envelope.
    expect(postedMessages(p).filter(isToolResult)).toHaveLength(0);
  });

  it("approve on safe plan: consent gate called, statements applied with progress, done", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls }));
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() =>
      postedMessages(p).some(
        (m) => isAssistant(m) && m.text.includes("Plan applied"),
      ),
    );

    expect(consentState.confirmMock).toHaveBeenCalledTimes(1);
    expect(runCalls.current).toBe(2);
    const done = postedMessages(p).filter(isAssistant).pop()!;
    expect(done.text).toContain("2/2");
  });

  it("approve with consent denied: denied tool_result, ZERO runQuery", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls }));
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(false);
    handler({ type: "plan_approve" });
    await until(() => postedMessages(p).some((m) => isToolResult(m) && m.status === "denied"));

    expect(runCalls.current).toBe(0);
    const denied = postedMessages(p).find((m) => isToolResult(m) && m.status === "denied")!;
    expect(denied.summary).toContain("rejected by user");
  });

  it("drift at approve: stale card + error, ZERO runQuery", async () => {
    const runCalls = { current: 0 };
    // Live schema only has [a] — plan claims b/c → drift.
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ columns: ["a"], runCalls }));
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() => postedMessages(p).some(isError));

    expect(consentState.confirmMock).not.toHaveBeenCalled();
    expect(runCalls.current).toBe(0);
    const stale = postedMessages(p).filter(isPlan);
    expect(stale[stale.length - 1]!.plan.drifted).toBe(true);
  });

  it("mid-run failure: applied/failedAt report", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls, failAt: 2 }));
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() =>
      postedMessages(p).some(
        (m) => isAssistant(m) && m.text.includes("Plan apply stopped"),
      ),
    );

    expect(runCalls.current).toBe(2); // first ran, second threw
    const report = postedMessages(p).filter(isAssistant).pop()!;
    expect(report.text).toContain("1/2");
    expect(report.text).toContain("boom at 2");
  });

  it("cancel mid-apply: cancelledAfter report, remaining counted", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls }));
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    // Stop flips the in-turn abort token → the runner stops BEFORE the
    // next statement and reports applied/cancelledAfter/remaining.
    handler({ type: "stop" });
    await until(() =>
      postedMessages(p).some(
        (m) => isAssistant(m) && m.text.includes("Plan apply cancelled"),
      ),
    );

    const report = postedMessages(p).filter(isAssistant).pop()!;
    expect(report.text).toContain("cancelled");
    expect(report.text).toContain("remaining");
  });

  it("plan_reject: no apply, no consent call, zero runQuery", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls }));
    const panel = new AiChatPanel({ extensionUri: extUri, deps: makeDeps(), adapterFactory: factory });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    handler({ type: "plan_reject" });
    // Second approve after reject must not apply anything.
    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() => postedMessages(p).some((m) => isToolResult(m) && m.status === "denied"));

    expect(consentState.confirmMock).not.toHaveBeenCalled();
    expect(runCalls.current).toBe(0);
  });
});

// =============================================================================
// TASK-CL-002 — ARP-07 invalidation wiring: plan-apply execute fires the seam
// PER successful statement (not per batch). Partial failure / denied / drift
// / null adapter → callback NEVER fires for failed/never-run statements.
// =============================================================================
describe("AiChatPanel — TASK-CL-002 ARP-07 invalidation seam (plan-apply)", () => {
  it("#6 happy: full success → onSchemaDdl called 2× (per applied statement, in order)", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls }));
    const onSchemaDdl = vi.fn();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      onSchemaDdl,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() =>
      postedMessages(p).some((m) => isAssistant(m) && m.text.includes("Plan applied")),
    );

    expect(runCalls.current).toBe(2);
    expect(onSchemaDdl).toHaveBeenCalledTimes(2);
    // Per-statement firing — each call gets exactly one applied sql.
    const sql0 = (onSchemaDdl.mock.calls[0]![0] as readonly string[])[0];
    const sql1 = (onSchemaDdl.mock.calls[1]![0] as readonly string[])[0];
    expect(sql0).toBe("UPDATE users SET b = 1 WHERE a = 2");
    expect(sql1).toBe("DELETE FROM users WHERE a = 1");
  });

  it("#7 partial failure: execute throws at statement 2 → callback fired exactly 1× (applied prefix only)", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls, failAt: 2 }));
    const onSchemaDdl = vi.fn();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      onSchemaDdl,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() =>
      postedMessages(p).some((m) => isAssistant(m) && m.text.includes("Plan apply stopped")),
    );

    expect(runCalls.current).toBe(2); // first ran, second threw
    // Only the applied statement should fire the seam.
    expect(onSchemaDdl).toHaveBeenCalledTimes(1);
    const sql0 = (onSchemaDdl.mock.calls[0]![0] as readonly string[])[0];
    expect(sql0).toBe("UPDATE users SET b = 1 WHERE a = 2");
    // Existing contract preserved.
    const report = postedMessages(p).filter(isAssistant).pop()!;
    expect(report.text).toContain("Plan apply stopped");
  });

  it("#8 no connection: apply-time adapter null → zero callbacks; existing contract preserved", async () => {
    // Drift re-check calls listColumns; we need it to succeed so we get to
    // the apply step. runQuery then runs against `null` adapter — the
    // execute wrapper throws "No active database connection." on the first
    // statement, runRenameStatements returns the error outcome, and the
    // panel posts "Plan apply stopped: applied 0/2".
    let listColsCalls = 0;
    const factory: AdapterFactory = vi.fn(async () => ({
      listColumns: async () => {
        listColsCalls += 1;
        return [
          { name: "a", dataType: "int", nullable: true },
          { name: "b", dataType: "int", nullable: true },
        ];
      },
      // Throw from runQuery so the execute wrapper's `await adapter.runQuery`
      // rejects — exactly like a real "no connection" / dropped-driver failure.
      runQuery: async () => {
        throw new Error("No active database connection.");
      },
    }));
    const onSchemaDdl = vi.fn();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      onSchemaDdl,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() =>
      postedMessages(p).some(
        (m) => isAssistant(m) && m.text.includes("Plan apply stopped"),
      ),
    );

    // Drift re-check used listColumns but runQuery never ran successfully.
    expect(listColsCalls).toBeGreaterThan(0);
    expect(onSchemaDdl).toHaveBeenCalledTimes(0);
    // Existing "Plan apply stopped: applied 0/2" contract preserved.
    const stops = postedMessages(p).filter(
      (m) => isAssistant(m) && m.text.includes("Plan apply stopped"),
    );
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[stops.length - 1]!.text).toContain("0/2");
  });

  it("#9a consent denied → ZERO runQuery AND zero onSchemaDdl calls", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ runCalls }));
    const onSchemaDdl = vi.fn();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      onSchemaDdl,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(false);
    handler({ type: "plan_approve" });
    await until(() => postedMessages(p).some((m) => isToolResult(m) && m.status === "denied"));

    expect(runCalls.current).toBe(0);
    expect(onSchemaDdl).toHaveBeenCalledTimes(0);
  });

  it("#9b drift at approve → ZERO runQuery AND zero onSchemaDdl calls", async () => {
    const runCalls = { current: 0 };
    const factory: AdapterFactory = vi.fn(async () => makeAdapter({ columns: ["a"], runCalls }));
    const onSchemaDdl = vi.fn();
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      onSchemaDdl,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some((m) => (m as { type?: string }).type === "init"));
    runTurnWithPlan(p, planEnvelope());
    handler({ type: "send", text: "plan the migration" });
    await until(() => postedMessages(p).some(isPlan));

    consentState.confirmMock.mockResolvedValue(true);
    handler({ type: "plan_approve" });
    await until(() => postedMessages(p).some(isError));

    expect(runCalls.current).toBe(0);
    expect(onSchemaDdl).toHaveBeenCalledTimes(0);
  });
});
