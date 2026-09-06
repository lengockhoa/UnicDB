// src/ui/__tests__/resultsPanelViewProvider.test.ts
// TASK-RP-001 — bottom-panel WebviewViewProvider conversion. 6 TDD cases
// that lock the new shell: implement vscode.WebviewViewProvider, register
// via vscode.window.registerWebviewViewProvider, never call
// createWebviewPanel, and stop reading the UnicDB.resultsPlacement setting
// or registering onDidChangeConfiguration.
import { describe, it, expect, vi, beforeEach } from "vitest";

type MessageHandler = (msg: unknown) => void;
type DisposeHandler = () => void;
type ChangeVisibilityHandler = (e: { visible: boolean }) => void;

class FakeWebview {
  html = "";
  cspSource = "vscode-webview://test";
  options: { enableScripts?: boolean; retainContextWhenHidden?: boolean; localResourceRoots?: unknown[] } = {};
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  asWebviewUriCalls: unknown[] = [];
  onDidReceiveMessage = (h: MessageHandler) => {
    this.handler = h;
    return { dispose: () => undefined };
  };
  asWebviewUri = (u: unknown) => {
    this.asWebviewUriCalls.push(u);
    return u;
  };
  /** Test-only: dispatch a message into the host handler. */
  dispatch(msg: unknown) {
    if (this.handler) this.handler(msg);
  }
  private handler: MessageHandler | null = null;
}

class FakeWebviewView {
  webview = new FakeWebview();
  description: string | undefined;
  title: string | undefined;
  viewType = "UnicDB.results";
  visible = true;
  /** Disposable spy for the view's dispose(). */
  dispose = vi.fn();
  private didDisposeHandlers: DisposeHandler[] = [];
  private didChangeVisibilityHandlers: ChangeVisibilityHandler[] = [];
  onDidDispose(h: DisposeHandler) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  onDidChangeVisibility(h: ChangeVisibilityHandler) {
    this.didChangeVisibilityHandlers.push(h);
    return { dispose: () => undefined };
  }
  fireDidDispose() {
    for (const h of this.didDisposeHandlers) h();
  }
}

const registeredProviders: Array<{
  viewId: string;
  provider: { resolveWebviewView: (view: unknown, ctx: unknown, token: unknown) => unknown };
  options?: unknown;
}> = [];

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        fsPath: parts
          .map((p: unknown) => {
            if (typeof p === "string") return p;
            if (!p) return "";
            const obj = p as { fsPath?: string; path?: string };
            return obj.fsPath ?? obj.path ?? "";
          })
          .join("/"),
        path: parts
          .map((p: unknown) => {
            if (typeof p === "string") return p;
            if (!p) return "";
            const obj = p as { fsPath?: string; path?: string };
            return obj.fsPath ?? obj.path ?? "";
          })
          .join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      createWebviewPanel: vi.fn(() => {
        throw new Error("createWebviewPanel should not be called in the new shell");
      }),
      registerWebviewViewProvider: vi.fn(
        (viewId: string, provider: unknown, options?: unknown) => {
          registeredProviders.push({
            viewId,
            provider: provider as { resolveWebviewView: (view: unknown, ctx: unknown, token: unknown) => unknown },
            options,
          });
          return { dispose: vi.fn() };
        },
      ),
      showErrorMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
    },
    commands: {
      executeCommand: vi.fn(async (_cmd: string, ..._rest: unknown[]) => undefined),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string, def?: unknown) => def,
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
    CancellationToken: class {},
    EventEmitter: class {
      event = () => ({ dispose: () => undefined });
    },
  };
});

import * as vscode from "vscode";
import { ResultsPanel, type SaveContext } from "../resultsPanel";
import type { QueryRunner, StatementResult } from "../../core/queryRunner";
import type { DbTransaction } from "../../adapters/types";

function makeRunnerStub(): QueryRunner {
  return {
    loadMore: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
    isCancelled: vi.fn(() => false),
  } as unknown as QueryRunner;
}

function makeStatementResult(
  index: number,
  rows: unknown[][],
  sql = "SELECT 1",
): StatementResult {
  return {
    index,
    sql,
    status: "done",
    result: {
      columns: rows[0]?.map((_, i) => `c${i}`) ?? [],
      rows,
      rowCount: rows.length,
      durationMs: 0,
    },
    durationMs: 0,
  };
}

beforeEach(() => {
  registeredProviders.length = 0;
  vi.clearAllMocks();
});

describe("ResultsPanel — WebviewViewProvider shell (TASK-RP-001)", () => {
  // ---- Case 1 — happy ---------------------------------------------------
  it("case 1: resolveWebviewView wires html, options and message handler; ready handshake posts state", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    panel.setExtensionUri({ fsPath: "/ext", path: "/ext" } as unknown as vscode.Uri);

    // Render BEFORE resolve — buffered state.
    panel.render(
      [makeStatementResult(0, [[1]], "q at T")],
      "q at T",
    );

    // Resolve the view.
    const view = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown): unknown;
    }).resolveWebviewView(view, {}, {});

    // options wired
    expect(view.webview.options.enableScripts).toBe(true);
    const lrr = view.webview.options.localResourceRoots as Array<{ path?: string; fsPath?: string }>;
    expect(Array.isArray(lrr)).toBe(true);
    expect(lrr.length).toBeGreaterThan(0);
    // Either path or fsPath must contain "dist" — the URI mock uses `path`.
    expect(
      lrr.some((r) =>
        (typeof r.path === "string" && r.path.includes("dist")) ||
        (typeof r.fsPath === "string" && r.fsPath.includes("dist")),
      ),
    ).toBe(true);

    // html contains CSP and the script tag for dist/webview.js. The mock
    // asWebviewUri is identity, so the URI strings embedded in the HTML
    // are URI objects; assert via the captured asWebviewUri calls instead
    // of substring matching on the stringified object.
    expect(view.webview.html).toContain("Content-Security-Policy");
    const joinedUris = view.webview.asWebviewUriCalls.map((u) => {
      const obj = u as { fsPath?: string; path?: string };
      return obj.fsPath ?? obj.path ?? String(u);
    });
    expect(
      joinedUris.some((s) => typeof s === "string" && s.includes("dist/webview.js")),
    ).toBe(true);

    // ready handshake posts state + transactionStatus.
    view.webview.postMessage.mockClear();
    view.webview.dispatch({ type: "ready" });

    const calls = view.webview.postMessage.mock.calls.map((c) => c[0]) as Array<Record<string, unknown>>;
    const state = calls.find((m) => m.type === "state") as Record<string, unknown> | undefined;
    const tx = calls.find((m) => m.type === "transactionStatus") as Record<string, unknown> | undefined;
    expect(state).toBeDefined();
    expect(state!.header).toBe("q at T");
    expect(state!.busy).toBe(false);
    expect(Array.isArray(state!.results)).toBe(true);
    expect((state!.results as unknown[]).length).toBe(1);
    expect(tx).toBeDefined();
    expect(tx!.open).toBe(false);
  });

  // ---- Case 2 — edge: lifecycle ordering ---------------------------------
  it("case 2: render before the view exists never posts; buffered state delivered once after resolve+ready", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    panel.setExtensionUri({ fsPath: "/ext", path: "/ext" } as unknown as vscode.Uri);

    // Render before any view exists.
    panel.render(
      [makeStatementResult(0, [[1, "a"], [2, "b"]])],
      "hdr",
    );

    // Between render() and resolveWebviewView() nothing must have been posted
    // to a webview (none exists yet). The createWebviewPanel mock throws on
    // use, so any accidental call would have surfaced as a thrown error here.
    // No assertion needed beyond "we got here without an exception".

    const view = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown): unknown;
    }).resolveWebviewView(view, {}, {});

    view.webview.postMessage.mockClear();
    view.webview.dispatch({ type: "ready" });

    const stateCalls = view.webview.postMessage.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === "state",
    );
    expect(stateCalls).toHaveLength(1);
    const rows = (
      (stateCalls[0]![0] as { results: StatementResult[] }).results[0]!.result!.rows
    );
    expect(rows).toEqual([[1, "a"], [2, "b"]]);
  });

  // ---- Case 3 — edge: concurrency (stale continuation across dispose) ----
  it("case 3: dispose mid-requery suppresses stale continuation into a re-created view", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    panel.setExtensionUri({ fsPath: "/ext", path: "/ext" } as unknown as vscode.Uri);

    const viewA = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown): unknown;
    }).resolveWebviewView(viewA, {}, {});
    viewA.webview.dispatch({ type: "ready" });
    viewA.webview.postMessage.mockClear();

    // Runner's runSql returns a controllable deferred promise.
    const deferred = Promise.withResolvers<unknown>();
    (runner as unknown as { runSql: (...args: unknown[]) => Promise<unknown> }).runSql =
      vi.fn(() => deferred.promise);

    // Trigger requery via dispatch — picks up `lastResults[index]` (a done
    // entry) and runs the SQL through the deferred.
    viewA.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
    });
    // Flush a few microtasks so the deferred is in-flight.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Mid-flight: simulate viewA being disposed (epoch bump + view cleared).
    viewA.fireDidDispose();

    // A NEW view resolves after dispose — this is the recreate scenario.
    const viewB = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown): unknown;
    }).resolveWebviewView(viewB, {}, {});
    viewB.webview.dispatch({ type: "ready" });
    viewB.webview.postMessage.mockClear();

    const showErr = vi.mocked(vscode.window.showErrorMessage);
    showErr.mockClear();

    // The deferred requery now resolves — must NOT post into viewB.
    deferred.resolve({
      results: [
        { columns: ["x"], rows: [[42]], rowCount: 1, durationMs: 0 },
      ],
    });
    for (let i = 0; i < 60; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(viewB.webview.postMessage).not.toHaveBeenCalled();
    expect(showErr).not.toHaveBeenCalled();
  });

  // ---- Case 4 — regression: show() focuses the bottom panel, not editor --
  it("case 4: show() never creates an editor-area WebviewPanel; reveals via UnicDB-results.focus", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });

    const cwvpMock = vi.mocked(vscode.window.createWebviewPanel);
    const execMock = vi.mocked(vscode.commands.executeCommand);
    cwvpMock.mockClear();
    execMock.mockClear();

    panel.show();
    panel.show();

    expect(cwvpMock).not.toHaveBeenCalled();
    const focusCalls = execMock.mock.calls.filter(
      (c) => c[0] === "UnicDB-results.focus",
    );
    expect(focusCalls).toHaveLength(2);
  });

  // ---- Case 5 — unit: dispose teardown ----------------------------------
  it("case 5: dispose() disposes the live view and rolls back an open transaction", async () => {
    const rollback = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    const transaction: DbTransaction = {
      commit,
      rollback,
      runQuery: vi.fn(async () => ({ results: [] })),
    };

    const runner = makeRunnerStub();
    (runner as unknown as {
      beginTransaction: () => Promise<DbTransaction>;
    }).beginTransaction = vi.fn(async () => transaction);

    const saveContext: SaveContext = {
      getDriver: () => "postgres",
      getManualCommit: () => true,
      listPkColumns: vi.fn(async () => ["id"]),
    };

    const panel = new ResultsPanel({ runner, saveContext });
    panel.setExtensionUri({ fsPath: "/ext", path: "/ext" } as unknown as vscode.Uri);

    const view = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown): unknown;
    }).resolveWebviewView(view, {}, {});
    view.webview.dispatch({ type: "ready" });

    // Seed a result row whose FROM clause parses to a real table so
    // saveEdits opens a manual transaction (Postgres + manualCommit +
    // edits present + tableByStatement has an entry).
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM public.t WHERE id = 1",
          status: "done",
          result: { columns: ["id", "name"], rows: [[1, "a"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );

    // Dispatch saveEdits to open a manual transaction. This routes
    // through handleSaveEdits → runner.beginTransaction() → assigns the
    // returned handle to this.transaction.
    const saveP = (panel as unknown as {
      handleMessage: (m: unknown) => Promise<void>;
    }).handleMessage({
      type: "saveEdits",
      index: 0,
      tableName: "t",
      pkColumns: ["id"],
      edits: [
        { rowId: 0, colIndex: 1, value: "b" },
      ],
      serverIndexByRowId: { "0": 0 },
    });

    // Flush microtasks so the manual transaction is opened.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await saveP;

    // Sanity: the manual transaction is now open.
    expect(
      (runner as unknown as { beginTransaction: ReturnType<typeof vi.fn> }).beginTransaction,
    ).toHaveBeenCalled();

    // Now dispose.
    panel.dispose();

    // view reference was cleared, rollback awaited. WebviewView has no
    // `dispose()` method on the view itself — VS Code tears the view down
    // via the bottom-panel container and `onDidDispose` fires; the host
    // just clears its references.
    expect((panel as unknown as { view: unknown }).view).toBeNull();
    expect(rollback).toHaveBeenCalled();

    // Subsequent postMessage is a no-op (no throw, no further call into the
    // disposed view). The view's webview.postMessage is a vi.fn we can
    // observe.
    view.webview.postMessage.mockClear();
    // Trigger another post attempt by calling render — guarded by the
    // disposed-view state.
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM public.t WHERE id = 1",
          status: "done",
          result: { columns: ["id", "name"], rows: [[1, "b"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    // After dispose(), the internal `view` is cleared; postMessage targets
    // nothing, so the previously-captured webview.postMessage spy is
    // unchanged.
    expect(view.webview.postMessage).not.toHaveBeenCalled();
  });

  // ---- Case 6 — unit: removed API ----------------------------------------
  it("case 6: constructor no longer accepts resultsPlacement/viewColumn and no config listener is registered", () => {
    const onCfgMock = vi.mocked(vscode.workspace.onDidChangeConfiguration);
    const getCfgMock = vi.mocked(vscode.workspace.getConfiguration);
    onCfgMock.mockClear();
    getCfgMock.mockClear();

    const runner = makeRunnerStub();
    const saveContext: SaveContext = {
      getDriver: () => null,
      listPkColumns: vi.fn(async () => []),
    };
    // Cast through `any` to silence the excess-property check — the
    // task requirement is that the runtime ignores these keys.
    const panel = new ResultsPanel({
      runner,
      saveContext,
      // @ts-expect-error — testing that legacy options are ignored.
      resultsPlacement: "beside",
      // @ts-expect-error — testing that legacy options are ignored.
      viewColumn: vscode.ViewColumn.Active,
    } as unknown as { runner: QueryRunner; saveContext: SaveContext });

    panel.setExtensionUri({ fsPath: "/ext", path: "/ext" } as unknown as vscode.Uri);
    const view = new FakeWebviewView();
    (panel as unknown as {
      resolveWebviewView(v: unknown): unknown;
    }).resolveWebviewView(view, {}, {});
    view.webview.dispatch({ type: "ready" });
    panel.show();

    // No config listener was registered.
    expect(onCfgMock).not.toHaveBeenCalled();
    // No getConfiguration call during show/render.
    expect(getCfgMock).not.toHaveBeenCalled();
  });
});
