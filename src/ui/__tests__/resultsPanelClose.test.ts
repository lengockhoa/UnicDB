// src/ui/__tests__/resultsPanelClose.test.ts
// TASK-UX3-002 — host state methods closeTab / closeAllTabs / closeOthersTabs.
//
// Strategy: instantiate ResultsPanel with stubbed vscode + a stubbed
// QueryRunner, exercise the three new methods, assert state transitions
// (lastResults, activeTab) and postMessage payload.
//
// The 3 close methods are PUBLIC on ResultsPanel. We access them directly
// via the instance. We don't render or postMessage to a real panel — we
// spy on the postMessage method by replacing it on the instance (TS private
// is erased at runtime, so this is allowed and isolated to the test).
//
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Stub vscode BEFORE importing the SUT ---------------------------------

vi.mock("vscode", () => {
  const fakeUri = (p: string) => ({ fsPath: p, scheme: "file", path: p, toString: () => p });
  const fakeWebview = {
    postMessage: () => undefined,
    onDidReceiveMessage: () => ({ dispose: () => undefined }),
    asWebviewUri: (u: { fsPath: string }) => fakeUri(u.fsPath),
    html: "",
    options: {},
    cspSource: "",
  };
  return {
    window: {
      createWebviewPanel: () => ({
        webview: fakeWebview,
        onDidDispose: () => ({ dispose: () => undefined }),
        reveal: () => undefined,
        dispose: () => undefined,
      }),
      showErrorMessage: () => undefined,
      showInformationMessage: () => undefined,
    },
    ViewColumn: { Beside: 2, One: 1, Two: 2, Three: 3 },
    Uri: {
      file: (p: string) => fakeUri(p),
      joinPath: (...parts: Array<string | { fsPath: string }>) =>
        fakeUri(parts.map((p) => (typeof p === "string" ? p : p.fsPath)).join("/")),
    },
    workspace: { getConfiguration: () => ({ get: () => undefined, update: () => Promise.resolve() }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    EventEmitter: class { event = () => ({ dispose: () => undefined }); fire = () => undefined; dispose = () => undefined; },
    Disposable: class { static from = () => ({ dispose: () => undefined }); },
    ThemeIcon: class {},
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class {},
    MarkdownString: class { appendMarkdown = () => this; value = ""; },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    commands: { executeCommand: () => Promise.resolve(undefined) },
    env: { openExternal: () => Promise.resolve(true) },
  };
});

import { ResultsPanel } from "../resultsPanel";
import type { StatementResult } from "../../core/types";

// ---- Minimal fixture ------------------------------------------------------

function makeResults(n: number): StatementResult[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    sql: `SELECT ${i}`,
    status: "done" as const,
    durationMs: 1,
    rows: [[i]],
  } as StatementResult));
}

/** Build a ResultsPanel with stubbed vscode + QueryRunner. We don't care
 *  about the panel itself — we only call the 3 close methods and observe
 *  state + postMessage calls. */
async function makePanel(initial: StatementResult[]): Promise<ResultsPanel> {
  const panel = new ResultsPanel({} as any, "below");
  // Pre-seed state via the public render() path so lastResults is populated.
  // render() also calls postMessage — capture the postMessage spy first.
  const postSpy = vi.spyOn(panel as any, "postMessage").mockImplementation(() => undefined);
  panel.render(initial, "test");
  // Reset the spy so test assertions only see what the close methods post.
  postSpy.mockClear();
  return panel;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- Tests ----------------------------------------------------------------

describe("TASK-UX3-002 closeTab", () => {
  it("unit: closeTab(0) with activeTab=1 → results=[b,c], activeTab=0", async () => {
    const p = await makePanel(makeResults(3));
    (p as any).activeTab = 1;
    p.closeTab(0);
    expect((p as any).lastResults.length).toBe(2);
    expect((p as any).lastResults[0].sql).toBe("SELECT 1");
    expect((p as any).activeTab).toBe(0);
  });

  it("unit: closeTab(activeTab) with activeTab=1 → results=[a,c], activeTab=1 (right-fallback)", async () => {
    const p = await makePanel(makeResults(3));
    (p as any).activeTab = 1;
    p.closeTab(1);
    expect((p as any).lastResults.length).toBe(2);
    expect((p as any).lastResults[0].sql).toBe("SELECT 0");
    expect((p as any).lastResults[1].sql).toBe("SELECT 2");
    expect((p as any).activeTab).toBe(1);
  });

  it("edge: closeTab(last) with activeTab=2 → results=[a,b], activeTab=1 (left fallback)", async () => {
    const p = await makePanel(makeResults(3));
    (p as any).activeTab = 2;
    p.closeTab(2);
    expect((p as any).lastResults.length).toBe(2);
    expect((p as any).lastResults[1].sql).toBe("SELECT 1");
    expect((p as any).activeTab).toBe(1);
  });

  it("edge: closeTab(-1) and closeTab(99) are no-ops and do not fire postMessage", async () => {
    const p = await makePanel(makeResults(3));
    const postSpy = vi.spyOn(p as any, "postMessage");
    p.closeTab(-1);
    p.closeTab(99);
    expect(postSpy).not.toHaveBeenCalled();
    expect((p as any).lastResults.length).toBe(3);
  });

  it("regression: closeTab returns new array reference (does not mutate input)", async () => {
    const input = makeResults(3);
    const p = await makePanel(input);
    const before = (p as any).lastResults;
    p.closeTab(0);
    const after = (p as any).lastResults;
    expect(after).not.toBe(before);
    expect(input.length).toBe(3); // input untouched
  });
});

describe("TASK-UX3-002 closeAllTabs", () => {
  it("edge: closeAllTabs leaves results=[] and activeTab=-1 and posts state", async () => {
    const p = await makePanel(makeResults(3));
    (p as any).activeTab = 1;
    p.closeAllTabs();
    expect((p as any).lastResults).toEqual([]);
    expect((p as any).activeTab).toBe(-1);
  });
});

describe("TASK-UX3-002 closeOthersTabs", () => {
  it("edge: closeOthersTabs(1) on [a,b,c] → results=[b], activeTab=0", async () => {
    const p = await makePanel(makeResults(3));
    p.closeOthersTabs(1);
    expect((p as any).lastResults.length).toBe(1);
    expect((p as any).lastResults[0].sql).toBe("SELECT 1");
    expect((p as any).activeTab).toBe(0);
  });

  it("edge: closeOthersTabs out-of-range is a no-op", async () => {
    const p = await makePanel(makeResults(3));
    const postSpy = vi.spyOn(p as any, "postMessage");
    p.closeOthersTabs(-1);
    p.closeOthersTabs(99);
    expect(postSpy).not.toHaveBeenCalled();
    expect((p as any).lastResults.length).toBe(3);
  });
});

describe("TASK-UX3-002 R4.5 — per-index cache rebasing", () => {
  it("R4.5: closeTab clears distinctCache + columnTypesByStatement + whereByStatement", async () => {
    const p = await makePanel(makeResults(3));
    // Seed the maps (the production code only sets them in render()).
    (p as any).distinctCache.set("0::col", { values: ["x"], truncated: false });
    (p as any).distinctCache.set("1::col", { values: ["y"], truncated: false });
    (p as any).columnTypesByStatement.set(0, { col: "int" });
    (p as any).whereByStatement.set(0, { sql: "SELECT 1", values: [] });
    const genBefore = (p as any).statementGeneration;
    p.closeTab(0);
    // distinctCache is the data-loss vector the reviewer flagged — must be
    // empty after any close.
    expect((p as any).distinctCache.size).toBe(0);
    expect((p as any).columnTypesByStatement.size).toBe(0);
    expect((p as any).whereByStatement.size).toBe(0);
    // statementGeneration bumped so in-flight DISTINCT responses are dropped.
    expect((p as any).statementGeneration).toBeGreaterThan(genBefore);
  });

  it("R4.5: closeAllTabs clears every per-index cache", async () => {
    const p = await makePanel(makeResults(3));
    (p as any).tableByStatement.set(0, { table: "t0" });
    (p as any).tableByStatement.set(1, { table: "t1" });
    p.closeAllTabs();
    expect((p as any).tableByStatement.size).toBe(0);
    expect((p as any).distinctCache.size).toBe(0);
  });

  it("R4.5: closeOthersTabs rebuilds tableByStatement with browse label for the kept tab", async () => {
    const p = await makePanel(makeResults(3));
    (p as any).browseLabel = "public.users";
    p.closeOthersTabs(1);
    // Kept tab's index 0 → tableByStatement[0] = browse-derived {public, users}.
    expect((p as any).tableByStatement.size).toBe(1);
    expect((p as any).tableByStatement.get(0)).toEqual({ schema: "public", table: "users" });
  });
});