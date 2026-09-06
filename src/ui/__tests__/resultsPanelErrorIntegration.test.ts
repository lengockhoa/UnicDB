// src/ui/__tests__/resultsPanelErrorIntegration.test.ts
//
// TASK-UX2-004 — host-side integration of the error visibility surface.
//
// End-to-end pin of the chain wired by this task:
//
//   first-connect failure:
//     adapterProvider rejects → executeAll throws →
//     runStatements outer catch → runner.runFailed(reason) →
//     onUpdate fires → panel.render(results, header) →
//     statusBar.setErrorBadge(reason)
//
//   post-connect runQuery error:
//     adapter.runQuery rejects → executeAll per-statement try/catch →
//     StatementResult with status="error" → onUpdate fires →
//     panel.render(results, header) → statusBar.setErrorBadge(reason)
//
//   healthy run completion:
//     statusBar.setErrorBadge(null) clears any prior badge.
//
//   regression:
//     healthy SELECT → classifyPanelKind returns "grid" (no card).
//
// The test imports `runStatements` from extension.ts (exported for this
// purpose) and exercises the outer catch directly. vscode is mocked so
// `confirmDangerousStatements` and `panel.show()` can resolve.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";

type MessageHandler = (msg: unknown) => void;

class FakeWebview {
  html = "";
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  onDidReceiveMessage = (h: MessageHandler) => {
    this.handler = h;
    return { dispose: () => undefined };
  };
  asWebviewUri = (u: unknown) => u;
  get cspSource() {
    return this.csp;
  }
  dispatch(msg: unknown) {
    if (this.handler) this.handler(msg);
  }
  private handler: MessageHandler | null = null;
  private csp = "vscode-resource:webview";
}

class FakeWebviewView {
  webview = new FakeWebview();
  description: string | undefined;
  title: string | undefined;
  viewType = "UnicDB.results";
  visible = true;
  private didDisposeHandlers: Array<() => void> = [];
  onDidDispose(h: () => void) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  fireDidDispose() {
    for (const h of this.didDisposeHandlers) h();
  }
  dispose() {}
}
class FakeWebviewPanel {
  webview = new FakeWebview();
  visible = true;
  private didDisposeHandlers: (() => void)[] = [];
  constructor(
    public viewType: string,
    public title: string,
    public viewColumn: number,
    public options: unknown,
  ) {}
  reveal() {}
  onDidReceiveMessage(_h: MessageHandler) {
    return { dispose: () => undefined };
  }
  onDidDispose(h: () => void) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  dispose() {
    for (const h of this.didDisposeHandlers) h();
  }
}

const providerStore: Array<{
  viewId: string;
  provider: { resolveWebviewView: (view: unknown) => unknown };
}> = [];
const lastView: { current: FakeWebviewView | null } = { current: null };
const lastPanel: { current: FakeWebviewPanel | null } = { current: null };

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        path: parts.map((p) => stringPart(p)).join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      registerWebviewViewProvider: (
        viewId: string,
        provider: { resolveWebviewView: (view: unknown) => unknown },
        _options?: unknown,
      ) => {
        providerStore.push({ viewId, provider });
        lastView.current = null;
        lastPanel.current = null;
        return { dispose: () => undefined };
      },
      showErrorMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
    },

    commands: {
      executeCommand: vi.fn(async (cmd: string, ..._rest: unknown[]) => {
        if (cmd === "UnicDB.results.focus" && providerStore.length > 0) {
          if (lastView.current && !(lastView.current as unknown as { isDisposed?: boolean }).isDisposed) {
            return undefined;
          }
          const provider = providerStore[providerStore.length - 1]!.provider;
          const v = new FakeWebviewView();
          (provider as { resolveWebviewView: (v: unknown) => unknown }).resolveWebviewView(v);
          lastView.current = v;
          lastPanel.current = v as unknown as FakeWebviewPanel;
        }
        return undefined;
      }),
    },

    workspace: {
      // confirmDangerousStatements reads two getConfiguration keys:
      //   UnicDB.confirmDestructive  (default true)
      //   UnicDB.admin.confirmGrant  (default true)
      // For SELECT 1 (a safe statement) neither prompt is shown, so the
      // get() function only needs to return undefined for these keys.
      getConfiguration: vi.fn(() => ({
        get: (_key: string, def?: unknown) => def,
      })),
      // TASK-RP-001 — UnicDB.resultsPlacement was removed in this wave; the
      // old auto-recreate config listener no longer exists. The mock keeps
      // onDidChangeConfiguration around so unrelated tests that incidentally
      // touch it don't crash.
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
  };
});

function stringPart(p: unknown): string {
  if (typeof p === "string") return p;
  if (p && typeof p === "object" && "fsPath" in (p as Record<string, unknown>)) {
    return String((p as { fsPath: unknown }).fsPath);
  }
  if (p && typeof p === "object" && "path" in (p as Record<string, unknown>)) {
    return String((p as { path: unknown }).path);
  }
  return String(p);
}

import * as vscode from "vscode";
import { runStatements } from "../../extension";
import { ResultsPanel } from "../resultsPanel";
import {
  QueryRunner,
  type StatementResult,
} from "../../core/queryRunner";
import type { StatusBarWrapper } from "../statusBar";
import type { ParsedStatement } from "../../config/types";
import type { ConnectionManager } from "../../core/connectionManager";
import type { DbAdapter, RunResult, QueryResult } from "../../adapters/types";
import { classifyPanelKind } from "../ddlStatusCard";

// ---- Test fixtures ---------------------------------------------------------

function stmt(text: string, start = 0, end = text.length): ParsedStatement {
  return { text, start, end };
}

function qresult(
  columns: string[],
  rows: unknown[][],
  rowCount: number | null = rows.length,
): QueryResult {
  return { columns, rows, rowCount, durationMs: 0 };
}

function okResult(columns: string[], rows: unknown[][]): RunResult {
  return { results: [qresult(columns, rows)] };
}

function makeAdapter(
  runImpl: (sql: string) => Promise<RunResult>,
): DbAdapter & { runQuerySpy: ReturnType<typeof vi.fn> } {
  const runQuerySpy = vi.fn(runImpl);
  return {
    runQuerySpy,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runQuery: runQuerySpy,
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    testConnection: vi.fn(async () => {}),
  } as unknown as DbAdapter & { runQuerySpy: ReturnType<typeof vi.fn> };
}

interface FakeMgrOptions {
  /** Adapter returned by `getAdapter()`. `null` means reject. */
  adapterOrThrow?: DbAdapter | Error;
  activeDriver?: "postgres" | "mysql" | "mssql" | "bigquery";
  activeId?: string;
}

/** Minimal ConnectionManager stand-in. Only the surface that
 *  `runStatements` (and its callees) touches is mocked. */
function makeMgr(opts: FakeMgrOptions = {}): ConnectionManager {
  const driver = opts.activeDriver ?? "postgres";
  const id = opts.activeId ?? "c1";
  const active = { id, name: "Test PG", driver };
  return {
    getActive: vi.fn(() => active),
    getAdapter: vi.fn(async () => {
      if (opts.adapterOrThrow instanceof Error) throw opts.adapterOrThrow;
      if (opts.adapterOrThrow) return opts.adapterOrThrow;
      throw new Error("no adapter configured");
    }),
  } as unknown as ConnectionManager;
}

interface FakeStatusBar extends StatusBarWrapper {
  setErrorBadge: ReturnType<typeof vi.fn>;
  item: { dispose: ReturnType<typeof vi.fn>; text: string };
  dispose: ReturnType<typeof vi.fn>;
}

function makeStatusBar(): FakeStatusBar {
  const fn = vi.fn();
  return {
    setErrorBadge: fn,
    item: { text: "", dispose: vi.fn() } as FakeStatusBar["item"],
    dispose: vi.fn(),
  };
}

/** Real ResultsPanel — render() actually emits postMessage. The test inspects
 *  the emitted state messages to verify which card path was chosen. */
function makePanel(runner: QueryRunner): ResultsPanel {
  return new ResultsPanel({ runner });
}

beforeEach(() => {
  lastView.current = null;
  providerStore.length = 0;
  lastPanel.current = null;
  vi.clearAllMocks();
});

// ---- The 4 integration cases ----------------------------------------------

describe("ResultsPanel error integration — TASK-UX2-004", () => {
  it("case 1 — first-connect failure: outer catch calls runner.runFailed(reason) → onUpdate → panel renders synthetic tab", async () => {
    // First-connect failure = the QueryRunner's adapterProvider rejects before
    // any statement runs. `mgr.getAdapter()` is a SEPARATE channel used only
    // by `applyKeywordQualify`; the runner uses its OWN adapterProvider
    // (passed at construction). The outer catch in runStatements picks up
    // the throw from `runner.run(...)` and forwards the message verbatim.
    const reason = "ECONNREFUSED 127.0.0.1:5432";
    const mgr = makeMgr({ adapterOrThrow: new Error("unreachable — mgr unused here") });
    const runner = new QueryRunner(async () => {
      throw new Error(reason);
    });
    const panel = makePanel(runner);
    const renderSpy = vi.spyOn(panel, "render");
    const statusBar = makeStatusBar();
    const setBadgeSpy = vi.spyOn(statusBar, "setErrorBadge");
    const runFailedSpy = vi.spyOn(runner, "runFailed");

    const stmts: ParsedStatement[] = [stmt("SELECT 1", 0, 8)];

    await runStatements(mgr, runner, panel, statusBar, stmts);

    // 1. The outer catch invoked runner.runFailed(reason).
    expect(runFailedSpy).toHaveBeenCalledTimes(1);
    expect(runFailedSpy).toHaveBeenCalledWith(reason);

    // 2. The synthetic row landed in runner.results with the expected shape.
    //    Note: runner.run() pre-fills results with "running" rows BEFORE
    //    awaiting the adapterProvider, so the throw leaves one running row
    //    in `this.results` and `runFailed` appends ONE synthetic row on top.
    const finalResults = runner.getResults();
    expect(finalResults.length).toBeGreaterThanOrEqual(2);
    const synth = finalResults[finalResults.length - 1];
    expect(synth.status).toBe("error");
    expect(synth.error).toBe(reason);
    expect(synth.sql).toBe("(connection)");
    expect(synth.durationMs).toBe(0);

    // 3. panel.render was called at least once with the synthetic row.
    //    The first render may be the post-settle; the outer-catch path fires
    //    onUpdate synchronously, then runFailed → another onUpdate. Either
    //    way, the LAST render carries the synthetic tab.
    expect(renderSpy).toHaveBeenCalled();
    const lastRenderResults = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0];
    expect(lastRenderResults.some((r: StatementResult) => r.sql === "(connection)")).toBe(true);

    // 4. Status bar error badge was set to the reason.
    expect(setBadgeSpy).toHaveBeenCalledWith(reason);
  });

  it("case 2 — post-connect runQuery error: per-statement error row → panel renders error card (not empty grid)", async () => {
    // Adapter is reachable but runQuery rejects with a pg-style syntax error.
    const pgErr = 'ERROR: syntax error at or near "FROM"\nLINE 1: SELECT FROM';
    const adapter = makeAdapter(async () => {
      throw new Error(pgErr);
    });
    const mgr = makeMgr({ adapterOrThrow: adapter });
    const runner = new QueryRunner(async () => adapter);
    const panel = makePanel(runner);
    const renderSpy = vi.spyOn(panel, "render");
    const statusBar = makeStatusBar();
    const setBadgeSpy = vi.spyOn(statusBar, "setErrorBadge");

    const stmts: ParsedStatement[] = [stmt("SELECT FROM", 0, 11)];

    await runStatements(mgr, runner, panel, statusBar, stmts);

    // 1. The error row reached runner.results.
    const finalResults = runner.getResults();
    expect(finalResults).toHaveLength(1);
    expect(finalResults[0].status).toBe("error");
    expect(finalResults[0].error).toBe(pgErr);

    // 2. The render path classifies the row as a card (TASK-UX2-001 fix) —
    //    NOT an empty grid. This is the integration's critical assertion:
    //    the card body must reach the webview.
    const cardKind = classifyPanelKind(finalResults[0]);
    expect(cardKind).toBe("card");

    // 3. panel.render was called at least once with the error row in the
    //    results array.
    expect(renderSpy).toHaveBeenCalled();
    const lastRenderResults = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0];
    expect(lastRenderResults.some((r: StatementResult) => r.status === "error")).toBe(true);

    // 4. Status bar badge set.
    expect(setBadgeSpy).toHaveBeenCalledWith(pgErr);
  });

  it("case 3 — status bar error badge set on first error, cleared (null) on next healthy run", async () => {
    const adapter = makeAdapter(async (sql: string) => okResult(["x"], [[sql]]));
    const connError = "ECONNREFUSED 127.0.0.1:5432";

    // ---- Run 1: first-connect failure (badge set to reason) ----
    // The outer catch picks up the throw from the QueryRunner's
    // adapterProvider; `mgr.getAdapter()` is a separate channel used only
    // by applyKeywordQualify.
    const mgrFail = makeMgr({ adapterOrThrow: new Error("unreachable") });
    const runner1 = new QueryRunner(async () => {
      throw new Error(connError);
    });
    const panel1 = makePanel(runner1);
    const statusBar1 = makeStatusBar();
    await runStatements(mgrFail, runner1, panel1, statusBar1, [
      stmt("SELECT 1", 0, 8),
    ]);
    expect(statusBar1.setErrorBadge).toHaveBeenLastCalledWith(connError);

    // ---- Run 2: healthy SELECT on a fresh runner (badge cleared to null) ----
    const mgrOk = makeMgr({ adapterOrThrow: adapter });
    const runner2 = new QueryRunner(async () => adapter);
    const panel2 = makePanel(runner2);
    const statusBar2 = makeStatusBar();
    await runStatements(mgrOk, runner2, panel2, statusBar2, [
      stmt("SELECT 2", 0, 8),
    ]);

    // The healthy path MUST call setErrorBadge(null) to clear the badge.
    // Find the last call (could include any others from the success path).
    const calls = statusBar2.setErrorBadge.mock.calls;
    expect(calls.some((args) => args[0] === null)).toBe(true);
    // And it must NOT have set a non-null reason on the healthy run.
    expect(calls.every((args) => args[0] === null)).toBe(true);
  });

  it("case 4 — regression: healthy SELECT still renders the grid; no error card", async () => {
    const adapter = makeAdapter(async () => okResult(["n"], [[1], [2]]));
    const mgr = makeMgr({ adapterOrThrow: adapter });
    const runner = new QueryRunner(async () => adapter);
    const panel = makePanel(runner);
    const renderSpy = vi.spyOn(panel, "render");
    const statusBar = makeStatusBar();

    await runStatements(mgr, runner, panel, statusBar, [stmt("SELECT 1", 0, 8)]);

    // 1. No error rows.
    const finalResults = runner.getResults();
    expect(finalResults).toHaveLength(1);
    expect(finalResults[0].status).toBe("done");
    expect(finalResults[0].error).toBeUndefined();

    // 2. classifyPanelKind returns "grid" — the legacy AG Grid path is
    //    preserved. No card.
    expect(classifyPanelKind(finalResults[0])).toBe("grid");

    // 3. panel.render was called with the success row.
    expect(renderSpy).toHaveBeenCalled();
    const lastRenderResults = renderSpy.mock.calls[renderSpy.mock.calls.length - 1][0];
    expect(lastRenderResults.some((r: StatementResult) => r.status === "done")).toBe(true);

    // 4. The status bar badge is cleared (setErrorBadge(null)) — healthy
    //    path always clears any prior error.
    expect(statusBar.setErrorBadge).toHaveBeenCalledWith(null);
    // And never set to a non-null reason on the healthy path.
    expect(
      statusBar.setErrorBadge.mock.calls.every((args) => args[0] === null),
    ).toBe(true);
  });
});
