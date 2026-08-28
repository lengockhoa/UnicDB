// src/ui/__tests__/consoleTabs.test.ts — TASK-AF-004 (cycle AF) host-side tests.
//
// Covers the multi-tab console registry, history persistence (Memento), and
// the EXPLAIN / EXPLAIN ANALYZE + destructive-confirm gate:
//
//   #1 create/switch/close tabs keeps buffers isolated
//   #2 close last tab → fresh empty tab, no crash
//   #3 runStatement executes only the statement at cursor
//   #5 history: successful run appends; recall cycles up/down
//   #6 history capped at 200
//   #7 history persists across panel reload via Memento
//   #8 EXPLAIN runs plan query (no ANALYZE) without confirm
//   #9 EXPLAIN ANALYZE requires destructive confirm
//
// Pattern mirror: src/ui/__tests__/consolePanel.test.ts (vi.mock("vscode")).
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";

// ---- Test doubles ----------------------------------------------------------

class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

interface MockPanel {
  viewType: string;
  title: string;
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
  panels: [] as Array<Record<string, unknown>>,
}));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn((_viewType: string, _title: string) => {
      const panel: Record<string, unknown> = {
        viewType: _viewType,
        title: _title,
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => String(u)),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(() => {
          panel["disposed"] = true;
          const listeners = (panel["onDidDispose"] as unknown as {
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
    showSaveDialog: vi.fn(),
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    fs: {
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
    getConfiguration: vi.fn(() => ({
      get: vi.fn(<T>(_k: string, d?: T) => d),
    })),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}`, scheme: "file" }),
    joinPath: vi.fn((u: unknown, ...parts: string[]) => ({
      toString: () => `${String(u)}/${parts.join("/")}`,
      fsPath: [...parts].join("/"),
    })),
  },
  ViewColumn: { Active: 1, Beside: 2 },
  EventEmitter: vi.fn(),
}));

// Import AFTER mocks are registered.
import { ConsolePanel } from "../consolePanel";

const extUri = { toString: () => "/ext", fsPath: "/ext", scheme: "file" } as never;

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    // Always yield at least one macrotask before checking. The run callback
    // is invoked synchronously, while history is appended after awaiting its
    // promise; checking first would return before that continuation settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (cond()) return;
  }
}

function consolePanels(): MockPanel[] {
  return state.panels.filter(
    (p) => (p as { viewType?: string }).viewType === "vsdb.console",
  ) as unknown as MockPanel[];
}

function panelHarness(): { panel: MockPanel; handler: (msg: unknown) => void } {
  const panel = consolePanels()[consolePanels().length - 1];
  return {
    panel,
    handler: (panel.webview.onDidReceiveMessage as unknown as {
      mock: { calls: Array<[(msg: unknown) => void]> };
    }).mock.calls[0][0],
  };
}

beforeEach(() => {
  state.panels.length = 0;
  vi.clearAllMocks();
});

// ============================================================================
// #1 — happy: tab isolation across create/switch/close
// ============================================================================
describe("ConsolePanel — tab registry (case 1)", () => {
  it("#1 create/switch/close keeps buffers isolated; closing active activates neighbor", () => {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();

    const initial = panel.listTabs();
    expect(initial.length).toBe(1);
    const tabA = initial[0];

    const tabB = panel.createTab("queries-b");
    const tabC = panel.createTab("queries-c");
    expect(panel.listTabs().length).toBe(3);

    panel.setBuffer(tabA.id, "SELECT 1;");
    panel.setBuffer(tabB.id, "SELECT 2;");
    panel.setBuffer(tabC.id, "SELECT 3;");

    panel.setBuffer(tabB.id, "SELECT 22;");
    panel.switchTab(tabC.id);
    expect(panel.getActiveBuffer()).toBe("SELECT 3;");
    panel.switchTab(tabB.id);
    expect(panel.getActiveBuffer()).toBe("SELECT 22;");

    panel.closeTab(tabB.id);
    const remaining = panel.listTabs();
    expect(remaining.length).toBe(2);
    expect(remaining.map((t) => t.id).sort()).toEqual(
      [tabA.id, tabC.id].sort(),
    );
    expect(panel.getActiveTabId()).toBe(tabA.id);
    expect(panel.getActiveBuffer()).toBe("SELECT 1;");
    expect(panel.getBuffer(tabC.id)).toBe("SELECT 3;");
  });
});

// ============================================================================
// #2 — edge: closing the last tab creates a fresh empty one
// ============================================================================
describe("ConsolePanel — close last tab (case 2)", () => {
  it("#2 closing the only tab spawns a fresh empty tab; registry stays >=1", () => {
    const panel = new ConsolePanel({ extensionUri: extUri, onRun: vi.fn() });
    panel.show();
    const only = panel.listTabs()[0];
    panel.setBuffer(only.id, "SELECT secret;");
    panel.closeTab(only.id);
    const after = panel.listTabs();
    expect(after.length).toBe(1);
    expect(after[0].id).not.toBe(only.id);
    expect(panel.getActiveBuffer()).toBe("");
    expect(panel.getBuffer(after[0].id)).toBe("");
  });
});

// ============================================================================
// #3 — runStatement executes ONLY the indexed statement
// ============================================================================
describe("ConsolePanel — runStatement (case 3)", () => {
  it("#3 splitStatements index N runs only that statement; runner spy is called once with the index slice", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({ extensionUri: extUri, onRun });
    panel.show();
    const { handler } = panelHarness();
    const tabId = panel.listTabs()[0].id;
    panel.setBuffer(tabId, "SELECT 1;\nSELECT 2;\nSELECT 3;");
    handler({ type: "runStatement", tabId, index: 1 });
    await until(() => onRun.mock.calls.length > 0);
    expect(onRun).toHaveBeenCalledTimes(1);
    // splitStatements strips the trailing `;` terminator (verified in
    // statementParser.test.ts Test #1).
    expect(onRun.mock.calls[0][0]).toBe("SELECT 2");
  });
});

// ============================================================================
// #5 — history: successful run appends; recall cycles up/down
// ============================================================================
describe("ConsolePanel — history (case 5)", () => {
  it("#5 successful runs append in last-first order; recall cycles up then down", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      memento: new FakeMemento() as never,
    });
    panel.show();
    const { handler } = panelHarness();

    handler({ type: "runSelection", text: "SELECT a" });
    await until(() => onRun.mock.calls.length === 1);
    handler({ type: "runSelection", text: "SELECT b" });
    await until(() => onRun.mock.calls.length === 2);
    handler({ type: "runSelection", text: "SELECT c" });
    await until(() => onRun.mock.calls.length === 3);

    const hist = panel.getHistory();
    expect(hist.length).toBe(3);
    expect(hist[0]).toBe("SELECT c");
    expect(hist[1]).toBe("SELECT b");
    expect(hist[2]).toBe("SELECT a");

    // Recall semantics: positive offset walks older (1=newer than 0),
    expect(panel.recallHistory(0)).toBe("SELECT c");
    expect(panel.recallHistory(-1)).toBe("SELECT a");
    expect(panel.recallHistory(2)).toBe("SELECT a");
    expect(panel.recallHistory(99)).toBe("SELECT c");
  });
});

// ============================================================================
// #6 — history capped at 200
// ============================================================================
describe("ConsolePanel — history cap (case 6)", () => {
  it("#6 201st successful run evicts the oldest; list stays at 200", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      memento: new FakeMemento() as never,
    });
    panel.show();
    const { handler } = panelHarness();

    for (let i = 0; i < 201; i++) {
      handler({ type: "runSelection", text: `SELECT ${i}` });
    }
    await until(() => onRun.mock.calls.length === 201);

    const hist = panel.getHistory();
    expect(hist.length).toBe(200);
    expect(hist[0]).toBe("SELECT 200");
    expect(hist[199]).toBe("SELECT 1");
  });
});

// ============================================================================
// #7 — history persists across reload via Memento
// ============================================================================
describe("ConsolePanel — history persists (case 7)", () => {
  it("#7 re-opening the panel rehydrates history from Memento", async () => {
    const memento = new FakeMemento();
    const onRun = vi.fn().mockResolvedValue(undefined);
    const first = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      memento: memento as never,
    });
    first.show();
    const firstHandler = panelHarness().handler;
    firstHandler({ type: "runSelection", text: "SELECT saved_one" });
    await until(() => onRun.mock.calls.length === 1);
    firstHandler({ type: "runSelection", text: "SELECT saved_two" });
    await until(() => onRun.mock.calls.length === 2);

    const panels = consolePanels();
    panels[panels.length - 1].dispose();

    const second = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      memento: memento as never,
    });
    second.show();
    const rehydrated = second.getHistory();
    expect(rehydrated.length).toBe(2);
    expect(rehydrated[0]).toBe("SELECT saved_two");
    expect(rehydrated[1]).toBe("SELECT saved_one");
  });
});

// ============================================================================
// #8 — EXPLAIN (no ANALYZE) runs plan query without confirm
// ============================================================================
describe("ConsolePanel — explain (case 8)", () => {
  it("#8 EXPLAIN without ANALYZE: no destructive confirm; the plan query runs verbatim", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      memento: new FakeMemento() as never,
    });
    panel.show();
    const { handler } = panelHarness();
    handler({
      type: "explain",
      sql: "EXPLAIN SELECT * FROM t",
      analyze: false,
    });
    await until(() => onRun.mock.calls.length > 0);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0]).toBe("EXPLAIN SELECT * FROM t");
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });
});

// ============================================================================
// #9 — EXPLAIN ANALYZE requires destructive confirm
// ============================================================================
describe("ConsolePanel — explain analyze (case 9)", () => {
  it("#9 EXPLAIN ANALYZE denied → no execution; allowed → SQL runs verbatim", async () => {
    const onRun = vi.fn().mockResolvedValue(undefined);
    const panel = new ConsolePanel({
      extensionUri: extUri,
      onRun,
      memento: new FakeMemento() as never,
    });
    panel.show();
    const { handler } = panelHarness();

    // (a) Deny path: showWarningMessage resolves to undefined → no execution.
    (vscode.window.showWarningMessage as unknown as Mock).mockResolvedValueOnce(undefined);
    handler({
      type: "explain",
      sql: "EXPLAIN ANALYZE SELECT * FROM t",
      analyze: true,
    });
    await until(() =>
      (vscode.window.showWarningMessage as unknown as Mock).mock.calls.length > 0,
    );
    await Promise.resolve();
    expect(onRun).not.toHaveBeenCalled();

    // (b) Allow path: confirm resolves to "Run" → SQL reaches the runner.
    (vscode.window.showWarningMessage as unknown as Mock).mockResolvedValueOnce("Run");
    handler({
      type: "explain",
      sql: "EXPLAIN ANALYZE SELECT 1",
      analyze: true,
    });
    await until(() =>
      (vscode.window.showWarningMessage as unknown as Mock).mock.calls.length === 2,
    );
    await until(() => onRun.mock.calls.length > 0);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0]).toBe("EXPLAIN ANALYZE SELECT 1");
  });
});
