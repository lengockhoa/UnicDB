// src/ui/__tests__/resultsPanelServerFilter.test.ts
//
// TASK-005 — host-side server-filter + paging requery composition.
//
// Cases 1-8, 13, 15-17 of the TASK-005 test matrix. Reuses the
// FakeWebview / FakeWebviewPanel + vi.mock("vscode") harness written in
// resultsPanelRequery.test.ts.
//
// The host composes the SQL with TASK-004 builders when `filters`/`offset`/
// `limit` are present on the requery message, and keeps the no-filter path
// byte-identical to `composeRequery` (back-compat, cases 4/16/17).
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  QueryRunner,
  type RunResult,
  type BatchedQuery,
} from "../../core/queryRunner";
import type { DbTransaction } from "../../adapters/types";
import { composeRequery } from "../resultsGridModel";

type MessageHandler = (msg: unknown) => void;

// ---- FakeWebview + FakeWebviewPanel (mirrors resultsPanelRequery.test.ts) ---

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
        if (cmd === "UnicDB-results.focus" && providerStore.length > 0) {
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

function stateMessages(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map((c) => c[0] as { type?: string; results?: Array<Record<string, unknown>> })
    .filter((m) => m.type === "state");
}

/** Wait until statement 0's last state is terminal (done | error) AND at
 *  least `minStates` state messages were posted. TASK-004 made the requery
 *  handler await PK/column-type metadata before composing, adding microtasks
 *  before the first runSql — without the floor the helper returned on the
 *  initial render state before the requery even started. */
async function waitForTerminal(fake: FakeWebviewPanel, minStates = 2): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const states = stateMessages(fake);
    const last = states[states.length - 1];
    const r = (last?.results as Array<{ status?: string }> | undefined)?.[0];
    if (states.length >= minStates && r && r.status !== "running") return;
    await Promise.resolve();
  }
}

beforeEach(() => {
  lastView.current = null;
  providerStore.length = 0;
  lastPanel.current = null;
  lastView.current = null;
  providerStore.length = 0;
  vi.clearAllMocks();
});

/** Build a plain-result runner recording every SQL passed to runSql.
 *  `rows` is what runSql returns as the fresh requery page. */
function makePanel(opts: {
  driver?: string;
  rows?: unknown[][];
  columns?: string[];
  sql?: string;
  initialRows?: unknown[][];
}) {
  const columns = opts.columns ?? ["id"];
  const freshRows = opts.rows ?? [[10]];
  const recorded: string[] = [];
  const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
    recorded.push(sql);
    return {
      results: [
        {
          columns,
          rows: freshRows,
          rowCount: freshRows.length,
          durationMs: 0,
        },
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
    getDriver: () => (opts.driver ?? "postgres") as never,
    listPkColumns: async () => [],
  };
  const panel = new ResultsPanel({ runner, saveContext });
  vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
  const initialRows = opts.initialRows ?? [[1]];
  panel.render(
    [
      {
        index: 0,
        sql: opts.sql ?? "SELECT id FROM t",
        status: "done",
        result: {
          columns,
          rows: initialRows,
          rowCount: initialRows.length,
          durationMs: 0,
        },
        durationMs: 0,
      },
    ],
    "hdr",
  );
  return { runner, runSql, recorded, panel, fake: lastPanel.current! };
}

function requeryMsg(overrides: Record<string, unknown> = {}) {
  return { type: "requery", index: 0, where: "", orderBy: "", ...overrides };
}

// =============================================================================
// Case 1-3 — happy path: filter WHERE, paging, append
// =============================================================================

describe("TASK-005 case 1 — requery with filters composes a server-side WHERE", () => {
  it("buildFilterWhere pushes an IN list onto the composed SQL", async () => {
    const { runSql, fake } = makePanel({ columns: ["id", "name"] });
    fake.webview.dispatch(
      requeryMsg({ filters: { name: { values: ["a"] } } }),
    );
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain("IN (");
    expect(sql).toContain('"name"');
  });
});

describe("TASK-005 case 2 — requery with offset+limit pages", () => {
  it("composes LIMIT/OFFSET for a postgres driver", async () => {
    const { runSql, fake } = makePanel({ driver: "postgres" });
    fake.webview.dispatch(requeryMsg({ offset: 500, limit: 500 }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain("LIMIT 500 OFFSET 500");
  });
});

describe("TASK-005 case 3 — append:true concatenates rows onto the existing result", () => {
  it("posted state results[0].result.rows.length === 1000 (500 old + 500 new)", async () => {
    const initialRows = Array.from({ length: 500 }, (_, i) => [i]);
    const freshRows = Array.from({ length: 500 }, (_, i) => [i + 1000]);
    const { fake } = makePanel({ rows: freshRows, initialRows });
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch(
      requeryMsg({ filters: { id: { values: ["a"] } }, offset: 500, limit: 500, append: true }),
    );
    await waitForTerminal(fake);
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      status: string;
      result?: { rows: unknown[][] };
    }>;
    expect(results[0]!.status).toBe("done");
    expect(results[0]!.result!.rows).toHaveLength(1000);
    // First 500 keep the original rows; last 500 are the fresh page.
    expect(results[0]!.result!.rows[0]).toEqual([0]);
    expect(results[0]!.result!.rows[999]).toEqual([999 + 1000 - 500]);
  });
});

// =============================================================================
// Case 4 — back-compat: no new fields ⇒ byte-identical to today
// =============================================================================

describe("TASK-005 case 4 — requery without the new fields is byte-identical", () => {
  it("{where:'',orderBy:''} composes exactly composeRequery(sql, '', '')", async () => {
    const sql = "SELECT id FROM t";
    const { runSql, fake } = makePanel({ sql, driver: "postgres" });
    fake.webview.dispatch(requeryMsg());
    await waitForTerminal(fake);
    expect(runSql.mock.calls[0]![0]).toBe(composeRequery(sql, "", ""));
  });
});

// =============================================================================
// Case 5 — cursor lifecycle: previous batched cursor closed before the
// filtered requery runs
// =============================================================================

describe("TASK-005 case 5 — previous batched cursor is closed before a filtered requery", () => {
  it("close() called exactly once, before runSql", async () => {
    const order: string[] = [];
    const previousBatched: BatchedQuery = {
      columns: ["id"],
      async fetchBatch() {
        return [[1], [2]];
      },
      async cancel() {
        order.push("cancel:previous");
      },
      async close() {
        order.push("close:previous");
      },
    };
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      order.push("runSql");
      return {
        results: [
          { columns: ["id"], rows: [[10]], rowCount: 1, durationMs: 0 },
        ],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
      adopt: vi.fn(() => undefined),
      isCancelled: () => false,
    } as unknown as QueryRunner;
    const saveContext: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const panel = new ResultsPanel({ runner, saveContext });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 0 },
          batched: previousBatched,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch(
      requeryMsg({ filters: { id: { values: ["a"] } } }),
    );
    await waitForTerminal(fake);

    expect(order.filter((o) => o === "close:previous")).toHaveLength(1);
    expect(order.indexOf("close:previous")).toBeLessThan(order.indexOf("runSql"));
  });
});

// =============================================================================
// Case 6 — concurrency: a stale in-flight requery never overwrites a newer one
// =============================================================================

describe("TASK-005 case 6 — stale in-flight requery never overwrites a newer one", () => {
  it("out-of-order resolution leaves lastResults[0] holding the NEWER requery's rows", async () => {
    const pending: Array<(r: RunResult) => void> = [];
    const runSql = vi.fn(
      (_sql: string): Promise<RunResult> =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
      adopt: vi.fn(() => undefined),
      isCancelled: () => false,
    } as unknown as QueryRunner;
    const saveContext: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const panel = new ResultsPanel({ runner, saveContext });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[0]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    // Requery A (slow) then requery B (fast). B resolves FIRST.
    fake.webview.dispatch(requeryMsg({ where: "A" }));
    fake.webview.dispatch(requeryMsg({ where: "B" }));

    // Both runSql calls must be pending before we resolve anything.
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(2);

    const result = (rows: unknown[][]): RunResult => ({
      results: [
        { columns: ["id"], rows, rowCount: rows.length, durationMs: 0 },
      ],
    });
    pending[1]!(result([[2]])); // B resolves first (sequence 2)
    await new Promise((r) => setTimeout(r, 0));
    pending[0]!(result([[1]])); // A resolves later (sequence 1)
    await waitForTerminal(fake);

    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      result?: { rows: unknown[][] };
    }>;
    // The surviving entry carries B's (newer) rows — not A's stale rows.
    expect(results[0]!.result!.rows).toEqual([[2]]);
  });
});

// =============================================================================
// Case 7 — alternate execution path: filtered requery routes through the
// open manual transaction, never through runner.runSql
// =============================================================================

describe("TASK-005 case 7 — filtered requery routes through the open transaction", () => {
  it("transaction.runQuery called; runner.runSql NOT called", async () => {
    const txStatements: string[] = [];
    const transaction: DbTransaction & {
      commit: ReturnType<typeof vi.fn>;
      rollback: ReturnType<typeof vi.fn>;
    } = {
      runQuery: async (sql: string): Promise<RunResult> => {
        txStatements.push(sql);
        return {
          results: [
            { columns: ["id"], rows: [[5]], rowCount: 1, durationMs: 0 },
          ],
        };
      },
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    };
    const beginTransaction = vi.fn(async (): Promise<DbTransaction> => transaction);
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      return {
        results: [
          { columns: ["id"], rows: [[9]], rowCount: 1, durationMs: 0 },
        ],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
      beginTransaction,
      adopt: vi.fn(() => undefined),
      isCancelled: () => false,
    } as unknown as QueryRunner;
    const saveContext: SaveContext = {
      getDriver: () => "mssql",
      getManualCommit: () => true,
      listPkColumns: async () => ["id"],
    };
    const panel = new ResultsPanel({ runner, saveContext });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM people",
          status: "done",
          result: {
            columns: ["id", "name"],
            rows: [[1, "original"]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;

    // Open a manual transaction via a saveEdits (session-pinned). Edit a
    // NON-PK column so the save is not refused as "only PK columns edited".
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: "people",
      pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    // Wait until the save's UPDATE actually travelled through the
    // transaction handle — only then is `this.transaction` assigned.
    for (let i = 0; i < 500; i++) {
      if (txStatements.length > 0) break;
      await Promise.resolve();
    }
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch(
      requeryMsg({ filters: { id: { values: ["1"] } } }),
    );
    await waitForTerminal(fake);

    expect(txStatements.length).toBeGreaterThan(0);
    const composed = txStatements[txStatements.length - 1]!;
    expect(composed).toContain("[id] IN ('1')");
    expect(runSql).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Case 8 — failure atomicity: a failed append leaves existing rows intact
// =============================================================================

describe("TASK-005 case 8 — a failed append leaves the existing rows intact", () => {
  it("runSql rejects → posted state keeps original 500 rows with a status:error entry", async () => {
    const initialRows = Array.from({ length: 500 }, (_, i) => [i]);
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      throw new Error("boom");
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
      adopt: vi.fn(() => undefined),
      isCancelled: () => false,
    } as unknown as QueryRunner;
    const saveContext: SaveContext = {
      getDriver: () => "postgres",
      listPkColumns: async () => [],
    };
    const panel = new ResultsPanel({ runner, saveContext });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: {
            columns: ["id"],
            rows: initialRows,
            rowCount: initialRows.length,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch(
      requeryMsg({ filters: { id: { values: ["a"] } }, offset: 500, limit: 500, append: true }),
    );
    await waitForTerminal(fake);

    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      status: string;
      result?: { rows: unknown[][] };
      error?: string;
    }>;
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.error).toBe("boom");
    // No row loss: the error entry preserves the original 500 rows.
    expect(results[0]!.result!.rows).toHaveLength(500);
  });
});

// =============================================================================
// Case 13 — typed passthrough: host forwards typed[] to buildFilterWhere
// unmodified (numbers stay unquoted)
// =============================================================================

describe("TASK-005 case 13 — host emits unquoted numerics end-to-end", () => {
  it("filters:{id:{values:['42'],typed:[42]}} → IN (42), never IN ('42')", async () => {
    const { runSql, fake } = makePanel({ driver: "postgres" });
    fake.webview.dispatch(
      requeryMsg({ filters: { id: { values: ["42"], typed: [42] } } }),
    );
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain("IN (42)");
    expect(sql).not.toContain("IN ('42')");
  });
});

// =============================================================================
// Case 15 — live call path: simple ORDER BY is dialect-quoted via
// composeSortQuery
// =============================================================================

describe("TASK-005 case 15 — simple ORDER BY from the requery bar is dialect-quoted", () => {
  it("mssql: 'name DESC' → ORDER BY [name] DESC", async () => {
    const { runSql, fake } = makePanel({ driver: "mssql", columns: ["id", "name"] });
    fake.webview.dispatch(requeryMsg({ orderBy: "name DESC" }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain("ORDER BY [name] DESC");
  });

  it("postgres: 'name DESC' → ORDER BY \"name\" DESC", async () => {
    const { runSql, fake } = makePanel({ driver: "postgres", columns: ["id", "name"] });
    fake.webview.dispatch(requeryMsg({ orderBy: "name DESC" }));
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('ORDER BY "name" DESC');
  });
});

// =============================================================================
// Case 16 — TASK-004 behaviour change: non-simple ORDER BY is now either
// parsed+quoted (multi-term) or explicitly rejected (expressions/ordinals).
// Cycle V passed these through verbatim; PLAN.md §3.1 replaced the pass-through
// with parseOrderBy. Case 15 above (single bare term) is unchanged.
// =============================================================================

describe("TASK-004 case 16 — non-simple ORDER BY is parsed or rejected, never passed through", () => {
  it("'a, b DESC' with where 'id > 0' is parsed, quoted and wrapped (not composeRequery)", async () => {
    const sql = "SELECT id FROM t";
    const { runSql, fake } = makePanel({ sql, driver: "postgres" });
    fake.webview.dispatch(requeryMsg({ where: "id > 0", orderBy: "a, b DESC" }));
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    expect(composed).not.toBe(composeRequery(sql, "id > 0", "a, b DESC"));
    expect(composed).toBe(
      'SELECT * FROM (SELECT id FROM t) AS UnicDB_sub WHERE id > 0 ORDER BY "a" ASC, "b" DESC',
    );
  });

  it("'lower(name)' is rejected: no runSql, error surfaced", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t", driver: "postgres" });
    fake.webview.dispatch(requeryMsg({ orderBy: "lower(name)" }));
    await waitForTerminal(fake);
    expect(runSql).not.toHaveBeenCalled();
    const showErrorMessage = (await import("vscode")).window
      .showErrorMessage as ReturnType<typeof vi.fn>;
    expect(showErrorMessage).toHaveBeenCalled();
  });

  // TASK-007 (cycle Y): bare ordinals are NO LONGER rejected. The webview
  // sends POSITIONAL ORDER BY terms (`2 ASC`) whenever the user sorts a
  // column whose projection name appears more than once (`SELECT id, id`),
  // so the host grammar accepts an unsigned integer token and composes it
  // BARE (never quote-wrapped into the inert identifier `"1"`). This is the
  // same intentional expectation change as queryComposer.test.ts case 5.
  it("'1' parses as a positional ordinal and composes BARE (never quoted)", async () => {
    const { runSql, fake } = makePanel({ sql: "SELECT id FROM t", driver: "postgres" });
    fake.webview.dispatch(requeryMsg({ orderBy: "1" }));
    await waitForTerminal(fake);
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain("ORDER BY 1 ASC");
    expect(sql).not.toContain('"1"');
  });
});

// =============================================================================
// Case 17 — empty boundary: empty/whitespace ORDER BY adds no ORDER BY clause
// =============================================================================

describe("TASK-005 case 17 — empty or whitespace-only ORDER BY adds no ORDER BY", () => {
  it.each([[""], ["   "]])("orderBy %j composes byte-identically with no ORDER BY clause", async (orderBy) => {
    const sql = "SELECT id FROM t";
    const { runSql, fake } = makePanel({ sql, driver: "postgres" });
    fake.webview.dispatch(requeryMsg({ orderBy } as Record<string, unknown>));
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    expect(composed).not.toContain("ORDER BY");
    expect(composed).toBe(composeRequery(sql, "", orderBy));
  });
});
