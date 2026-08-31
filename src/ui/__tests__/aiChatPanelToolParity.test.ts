// src/ui/__tests__/aiChatPanelToolParity.test.ts — TASK-AIX05-004
//
// AIX-05 invariant: the OMP/MCP path and the builtin path must register
// the SAME gate-wrapped tool set so permission cards and tool
// availability never diverge. AiChatPanel exposes a single
// `registerStandardToolset` helper called from both code paths; the test
// drives it twice and asserts the resulting tool-name sets are equal
// (plan_change must appear on both).
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps } from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";
import type { OmpChatEngine, OmpChatEvents } from "../../ai/omp/ompChatEngine";
import { createDbTools, DbToolRegistry } from "../../ai/tools/registry";

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
  webview: { postMessage: Mock; onDidReceiveMessage: Mock; asWebviewUri: Mock; cspSource: string; html: string };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}
const state = vi.hoisted(() => ({ panels: [] as MockPanel[] }));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const p: MockPanel = {
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
          p.disposed = true;
          const ls = (p.onDidDispose as unknown as { mock: { calls: Array<[() => void]> } }).mock.calls;
          for (const [cb] of ls) cb();
        }),
        visible: true,
        disposed: false,
      };
      state.panels.push(p);
      return p;
    }),
    showInformationMessage: vi.fn(async () => undefined),
  },
  workspace: {
    getConfiguration: vi.fn(() => ({
      get: vi.fn((_k: string, d?: unknown) => d),
      update: vi.fn(async () => undefined),
    })),
  },
  Uri: { file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }) },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn().mockImplementation(() => new FakeEventEmitter<unknown>()),
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

const agentState = vi.hoisted(() => ({ runAgentMock: vi.fn() as Mock }));
vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return { ...actual, runAgent: agentState.runAgentMock };
});

import { AiChatPanel } from "../aiChatPanel";

const extUri = vscode.Uri.file("/ext");
function makeDeps(): AgentDeps {
  return { loadConfig: vi.fn(async () => null), complete: vi.fn() };
}

/** Build a panel that owns a real DbToolRegistry and exercises its
 *  `registerStandardToolset` method via a typed cast. Two registries
 *  (builtin + OMP/MCP) MUST end up identical. */
function exerciseStandardToolset(
  fakeEngine: OmpChatEngine,
  regBuiltin: DbToolRegistry,
  regOmp: DbToolRegistry,
): void {
  const factory: AdapterFactory = vi.fn(async () => null);
  const panel = new AiChatPanel({
    extensionUri: extUri,
    deps: makeDeps(),
    adapterFactory: factory,
    acp: { start: vi.fn(async () => { throw new Error("acp.start must not run"); }) },
    ompChatEngine: fakeEngine,
  });
  const helper = (panel as unknown as {
    registerStandardToolset(r: DbToolRegistry): void;
  }).registerStandardToolset.bind(panel);
  helper(regBuiltin);
  helper(regOmp);
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
  agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "x", stoppedOnBudget: false });
});

describe("AiChatPanel — toolset parity (TASK-AIX05-004)", () => {
  it("builtin and OMP/MCP registries expose the same gate-wrapped tool names (incl. plan_change)", () => {
    const fakeEngine: OmpChatEngine = {
      send: vi.fn(async (_t: string, _e: OmpChatEvents) => undefined),
      resume: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
      cancel: vi.fn(() => undefined),
    };
    const regBuiltin = createDbTools(vi.fn(async () => null));
    const regOmp = createDbTools(vi.fn(async () => null));
    exerciseStandardToolset(fakeEngine, regBuiltin, regOmp);

    const builtins = new Set(regBuiltin.list().map((t) => t.name));
    const omps = new Set(regOmp.list().map((t) => t.name));
    expect(builtins.size).toBeGreaterThan(0);
    expect(builtins).toEqual(omps);
    expect(builtins.has("plan_change")).toBe(true);
  });
});
