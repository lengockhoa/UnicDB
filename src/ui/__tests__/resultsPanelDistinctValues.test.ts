// src/ui/__tests__/resultsPanelDistinctValues.test.ts
//
// TASK-004 — host-side DISTINCT-values round trip (cases 1-6, 6b, 14, 15).
//
// Reuses the FakeWebview / FakeWebviewPanel + vi.mock("vscode") harness from
// resultsPanelServerFilter.test.ts. The host answers requestDistinctValues
// with a cached distinctValues reply (echoed index + column), drops late
// responses for replaced statements, and resolves declared column types via
// SaveContext.listColumnTypes for the (Blanks) predicate.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { QueryRunner, type RunResult } from "../../core/queryRunner";

type MessageHandler = (msg: unknown) => void;

class FakeWebview {
  html = "";
  private csp = "vscode-resource:webview";
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
  reveal(_col?: unknown) {}
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
        path: parts
          .map(
            (p: unknown) =>
              (p as { fsPath?: string; path?: string })?.fsPath ??
              (p as { path?: string })?.path ??
              "",
          )
          .join("/"),
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

    workspace: { onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
  };
});

import { ResultsPanel, type SaveContext } from "../resultsPanel";

function distinctMessages(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((m) => m.type === "distinctValues");
}

/** Wait until at least n distinctValues replies were posted. */
async function waitForDistinct(
  fake: FakeWebviewPanel,
  n: number,
): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (distinctMessages(fake).length >= n) return;
    await Promise.resolve();
  }
}

beforeEach(() => {
  lastView.current = null;
  providerStore.length = 0;
  lastPanel.current = null;
  vi.clearAllMocks();
});

interface PanelOpts {
  driver?: string | null;
  sql?: string;
  columns?: string[];
  rows?: unknown[][];
  pkColumns?: string[];
  columnTypes?: Record<string, string>;
  runSql?: ReturnType<typeof vi.fn>;
}

/** Build a panel with one done statement; runSql is controllable. */
function makePanel(opts: PanelOpts = {}) {
  const columns = opts.columns ?? ["id", "name"];
  const freshRows = opts.rows ?? [[10], [11]];
  const runSql =
    opts.runSql ??
    vi.fn(async (_sql: string): Promise<RunResult> => {
      return {
        results: [
          { columns, rows: freshRows, rowCount: freshRows.length, durationMs: 0 },
        ],
      };
    });
  const runner = {
    loadMore: vi.fn(async () => [] as Array<Record<string, unknown>>),
    cancel: vi.fn(async () => undefined),
    runSql,
    adopt: vi.fn(() => undefined),
    isCancelled: () => false,
  } as unknown as QueryRunner;
  const saveContext: SaveContext = {
    getDriver: () => (opts.driver === undefined ? "postgres" : opts.driver) as never,
    listPkColumns: async () => opts.pkColumns ?? [],
    ...(opts.columnTypes !== undefined
      ? { listColumnTypes: async () => opts.columnTypes }
      : {}),
  };
  const panel = new ResultsPanel({ runner, saveContext });
  vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
  panel.render(
    [
      {
        index: 0,
        sql: opts.sql ?? "SELECT id, name FROM t",
        status: "done",
        result: {
          columns,
          rows: [[1, "a"]],
          rowCount: 1,
          durationMs: 0,
        },
        durationMs: 0,
      },
    ],
    "hdr",
  );
  return { runSql, panel, fake: lastPanel.current! };
}

// =============================================================================
// Case 1 — happy: requestDistinctValues runs the DISTINCT SQL
// =============================================================================

describe("TASK-004 case 1 — requestDistinctValues runs the DISTINCT SQL", () => {
  it("runSql called once with SELECT DISTINCT \"name\" over UnicDB_distinct", async () => {
    const { runSql, fake } = makePanel();
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('SELECT DISTINCT "name"');
    expect(sql).toContain("UnicDB_distinct");
  });
});

// =============================================================================
// Case 2 — happy: reply reaches the webview
// =============================================================================

describe("TASK-004 case 2 — the reply reaches the webview", () => {
  it("posted message carries index/column/values/truncated", async () => {
    const { fake } = makePanel({ rows: [["a"], ["b"]] });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    expect(distinctMessages(fake)[0]).toEqual({
      type: "distinctValues",
      index: 0,
      column: "name",
      values: ["a", "b"],
      truncated: false,
    });
  });
});

// =============================================================================
// Case 3 — edge: per-(index, column) cache avoids a second run
// =============================================================================

describe("TASK-004 case 3 — a second request for the same column runs no SQL", () => {
  it("runSql count stays 1; a second distinctValues message is still posted", async () => {
    const { runSql, fake } = makePanel();
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 2);
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(distinctMessages(fake)).toHaveLength(2);
  });
});

// =============================================================================
// Case 4 — edge: render() clears the cache
// =============================================================================

describe("TASK-004 case 4 — a new render() for that index clears the cache", () => {
  it("after re-render, the same request runs runSql again", async () => {
    const { runSql, panel, fake } = makePanel();
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    expect(runSql).toHaveBeenCalledTimes(1);
    // Replace the statement via render().
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t2",
          status: "done",
          result: { columns: ["id", "name"], rows: [[2, "x"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr2",
    );
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 2);
    expect(runSql).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Case 5 — edge: driver error degrades, never throws
// =============================================================================

describe("TASK-004 case 5 — a failing DISTINCT query degrades, never throws", () => {
  it("error non-empty, values: [], no unhandled rejection", async () => {
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      throw new Error("permission denied");
    });
    const { fake } = makePanel({ runSql });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    const msg = distinctMessages(fake)[0]!;
    expect(String(msg.error ?? "")).toContain("permission denied");
    expect(msg.values).toEqual([]);
    expect(msg.truncated).toBe(false);
  });
});

// =============================================================================
// Case 6 — edge: no connection ⇒ explicit error reply, no SQL
// =============================================================================

describe("TASK-004 case 6 — no dialect means no SQL, explicit error reply", () => {
  it("runSql not called; reply carries index/column and an error", async () => {
    const { runSql, fake } = makePanel({ driver: null });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    expect(runSql).not.toHaveBeenCalled();
    const msg = distinctMessages(fake)[0]!;
    expect(msg.index).toBe(0);
    expect(msg.column).toBe("name");
    expect(String(msg.error ?? "").length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Case 6b — edge: late response for a replaced statement is dropped
// =============================================================================

describe("TASK-004 case 6b — late DISTINCT response for a replaced statement is dropped", () => {
  it("no distinctValues postMessage for the old response; cache stays empty", async () => {
    let resolveOld: (v: RunResult) => void = () => undefined;
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      return new Promise<RunResult>((res) => {
        resolveOld = res;
      });
    });
    const { panel, fake } = makePanel({ runSql });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await Promise.resolve(); // let the handler reach the pending runSql
    expect(runSql).toHaveBeenCalledTimes(1);

    // Replace the statement at the same index while the old DISTINCT is pending.
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM t_replaced",
          status: "done",
          result: { columns: ["id", "name"], rows: [[3, "z"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr2",
    );
    fake.webview.postMessage.mockClear();

    // Resolve the OLD deferred response (index 0, column name) — must be dropped.
    resolveOld({
      results: [
        { columns: ["name"], rows: [["stale"]], rowCount: 1, durationMs: 0 },
      ],
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(distinctMessages(fake)).toHaveLength(0);

    // The replacement cache is empty: the next request runs SQL again.
    const runSql2 = vi.fn(async (_sql: string): Promise<RunResult> => {
      return {
        results: [
          { columns: ["name"], rows: [["fresh"]], rowCount: 1, durationMs: 0 },
        ],
      };
    });
    (runSql as unknown as { mock: unknown }).mockImplementation(runSql2);
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    expect(runSql).toHaveBeenCalledTimes(2);
    expect(distinctMessages(fake)[0]!.values).toEqual(["fresh"]);
  });
});

// =============================================================================
// Case 14 — type-derived (Blanks) via declared column types
// =============================================================================

describe("TASK-004 case 14 — (Blanks) uses DECLARED column types, not row values", () => {
  it("varchar col with all-NULL rows composes IS NULL OR = ''", async () => {
    const { runSql, fake } = makePanel({
      columns: ["n", "num"],
      rows: [[null, 1]],
      columnTypes: { n: "varchar", num: "int4" },
      sql: "SELECT n, num FROM t",
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: { n: { values: ["(Blanks)"] } },
    });
    for (let i = 0; i < 500; i++) await Promise.resolve();
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('("n" IS NULL OR "n" ~ \'^[[:space:]]*$\')');
  });

  it("int4 col composes bare IS NULL even when every loaded row is null", async () => {
    const { runSql, fake } = makePanel({
      columns: ["n", "num"],
      rows: [[null, null]],
      columnTypes: { n: "varchar", num: "int4" },
      sql: "SELECT n, num FROM t",
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: { num: { values: ["(Blanks)"] } },
    });
    for (let i = 0; i < 500; i++) await Promise.resolve();
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('"num" IS NULL');
    expect(sql).not.toContain(`"num" = ''`);
  });
});

// =============================================================================
// Case 15 — edge: no type metadata ⇒ cycle-V behaviour
// =============================================================================

describe("TASK-004 case 15 — no type metadata means cycle-V bare IS NULL", () => {
  it("no listColumnTypes method: bare IS NULL, requery still runs", async () => {
    const { runSql, fake } = makePanel({
      columns: ["n"],
      rows: [["a"]],
      sql: "SELECT n FROM t",
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: { n: { values: ["(Blanks)"] } },
    });
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('"n" IS NULL');
    expect(sql).not.toContain(`"n" = ''`);
  });

  it("listColumnTypes rejecting: bare IS NULL, requery still runs", async () => {
    const { runSql } = makePanel({
      columns: ["n"],
      rows: [["a"]],
      columnTypes: undefined,
      sql: "SELECT n FROM t",
    });
    const saveContextOverride: SaveContext = {
      getDriver: () => "postgres" as never,
      listPkColumns: async () => [],
      listColumnTypes: async () => {
        throw new Error("metadata unavailable");
      },
    };
    const runner2 = {
      loadMore: vi.fn(async () => [] as Array<Record<string, unknown>>),
      cancel: vi.fn(async () => undefined),
      runSql,
      adopt: vi.fn(() => undefined),
      isCancelled: () => false,
    } as unknown as QueryRunner;
    const panel2 = new ResultsPanel({ runner: runner2, saveContext: saveContextOverride });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel2, { webviewOptions: { retainContextWhenHidden: true } });
    panel2.render(
      [
        {
          index: 0,
          sql: "SELECT n FROM t",
          status: "done",
          result: { columns: ["n"], rows: [["a"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake2 = lastPanel.current!;
    fake2.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: { n: { values: ["(Blanks)"] } },
    });
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('"n" IS NULL');
    expect(sql).not.toContain(`"n" = ''`);
  });

  it("tableByStatement miss (no-FROM sql): bare IS NULL, requery still runs, no throw", async () => {
    const { runSql, fake } = makePanel({
      columns: ["n"],
      rows: [["a"]],
      sql: "SELECT now()", // no FROM clause → tableByStatement miss
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: { n: { values: ["(Blanks)"] } },
    });
    for (let i = 0; i < 500; i++) await Promise.resolve();
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('"n" IS NULL');
    expect(sql).not.toContain(`"n" = ''`);
  });
});

// =============================================================================
// Fix round 1 — regression: cached truncated flag survives cache replay
// =============================================================================

describe("fix round 1 — a truncated:true first response replays truncated (not false)", () => {
  it("second (cached) request still reports truncated:true", async () => {
    // 1001 distinct rows: DISTINCT_VALUES_LIMIT probe is 1000+1 → truncated.
    const rows: unknown[][] = [];
    for (let i = 0; i < 1001; i++) rows.push([`v${i}`]);
    const { runSql, fake } = makePanel({ rows });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    expect(distinctMessages(fake)[0]!.truncated).toBe(true);
    expect(runSql).toHaveBeenCalledTimes(1);
    // Second request is served from cache — must replay truncated:true.
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 2);
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(distinctMessages(fake)[1]!.truncated).toBe(true);
    expect(distinctMessages(fake)[1]!.values).toHaveLength(1000);
  });
});

// =============================================================================
// Fix round 1 — regression: batched DISTINCT response is drained + closed
// =============================================================================

describe("fix round 1 — batched DISTINCT response drains all pages and closes the cursor", () => {
  it("two-page batched run is fully drained and batched.close() called", async () => {
    const fetchBatch = vi.fn(async () => null);
    const firstBatch: unknown[][] = [];
    for (let i = 0; i < 500; i++) firstBatch.push([`v${i}`]);
    const secondBatch: unknown[][] = [];
    for (let i = 500; i < 900; i++) secondBatch.push([`v${i}`]);
    let call = 0;
    fetchBatch.mockImplementation(async () => {
      call += 1;
      if (call === 1) return firstBatch;
      if (call === 2) return secondBatch;
      return null;
    });
    const close = vi.fn(async () => undefined);
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      return {
        results: [],
        batched: { columns: ["name"], fetchBatch, close },
      } as unknown as RunResult;
    });
    const { fake } = makePanel({ runSql });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    const msg = distinctMessages(fake)[0]!;
    // Both pages consumed: 500 + 400 = 900 values, complete (not truncated).
    expect(msg.values).toHaveLength(900);
    expect(msg.truncated).toBe(false);
    // Page 3 returns null (EOF) → cursor drained, then closed exactly once.
    expect(fetchBatch).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TASK-006 (cycle Y) — DISTINCT queries scoped to the active server-side view
// =============================================================================

/** Drain the requery round trip: host composes → runSql → state post. */
async function drainRequery(): Promise<void> {
  for (let i = 0; i < 500; i++) await Promise.resolve();
}

function distinctSqlCalls(runSql: ReturnType<typeof vi.fn>): string[] {
  return runSql.mock.calls
    .map((c) => c[0] as string)
    .filter((s) => s.includes("UnicDB_distinct"));
}

describe("TASK-006 case 1 — DISTINCT for one column retains bar WHERE plus other filters", () => {
  it("scoped SQL carries archived = false AND the b predicate", async () => {
    const { runSql, fake } = makePanel({
      columns: ["id", "archived", "a", "b"],
      sql: "SELECT id, archived, a, b FROM t",
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "archived = false",
      orderBy: "",
      filters: { b: { values: ["x"] } },
    });
    await drainRequery();
    runSql.mockClear();
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "a" });
    await waitForDistinct(fake, 1);
    const calls = distinctSqlCalls(runSql);
    expect(calls).toHaveLength(1);
    // Bar WHERE retained VERBATIM, other-column filter predicate AND-ed.
    expect(calls[0]).toContain(
      `UnicDB_distinct WHERE archived = false AND "b" IN ('x') ORDER BY 1`,
    );
  });
});

describe("TASK-006 case 2 — requested column's own filter never self-narrows", () => {
  it("predicates for the requested column are omitted, others kept", async () => {
    const { runSql, fake } = makePanel({
      columns: ["id", "a", "b"],
      sql: "SELECT id, a, b FROM t",
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: {
        a: { values: ["sel-a"] },
        b: { values: ["x"] },
      },
    });
    await drainRequery();
    runSql.mockClear();
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "a" });
    await waitForDistinct(fake, 1);
    const calls = distinctSqlCalls(runSql);
    expect(calls).toHaveLength(1);
    // Other column's predicate survives…
    expect(calls[0]).toContain(`"b" IN ('x')`);
    // …the requested column's own predicate NEVER appears.
    expect(calls[0]).not.toContain('"a" IN');
    expect(calls[0]).not.toContain("'sel-a'");
  });

  it("own-column-only filter scopes to nothing extra (no WHERE)", async () => {
    const { runSql, fake } = makePanel({
      columns: ["id", "a"],
      sql: "SELECT id, a FROM t",
    });
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      filters: { a: { values: ["sel-a"] } },
    });
    await drainRequery();
    runSql.mockClear();
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "a" });
    await waitForDistinct(fake, 1);
    const calls = distinctSqlCalls(runSql);
    expect(calls).toHaveLength(1);
    // Only own predicate existed → excluded list leaves bare base statement,
    // byte-identical to today's shape.
    expect(calls[0]).toContain("UnicDB_distinct ORDER BY 1 LIMIT 1001");
    expect(calls[0]).not.toContain("WHERE");
  });
});

describe("TASK-006 case 5 (regression) — no recorded source state keeps where=\"\"", () => {
  it("fresh render, no requery: DISTINCT stays base-statement scoped", async () => {
    const { runSql, fake } = makePanel({
      columns: ["id", "name"],
      sql: "SELECT id, name FROM t",
    });
    fake.webview.dispatch({ type: "requestDistinctValues", index: 0, column: "name" });
    await waitForDistinct(fake, 1);
    const calls = distinctSqlCalls(runSql);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      'SELECT DISTINCT "name" FROM (SELECT id, name FROM t) UnicDB_distinct ORDER BY 1 LIMIT 1001',
    );
  });
});
