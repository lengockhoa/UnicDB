// src/ui/__tests__/resultsPanelRequery.test.ts
//
// TASK-504 — host-side requery handler tests across fix rounds.
//
// Fix Round 1:
//   - critical #2: handleRequery consumes the batched handle via
//     pickResult (adapters return {results:[], batched} for single SELECTs).
//   - critical #3: previous batched cursor is closed before the requery
//     runs (Postgres pool max=1 — leaked cursor wedges the next query).
//   - critical #1: webview banner persistence (covered by
//     webviewKeybinding + webviewSaveEdits regressions).
//
// Fix Round 2:
//   - critical #1: requery posts `status:"running"` for the statement
//     BEFORE runSql so the webview's statementReset branch fires —
//     otherwise equal-row-count requeries leave the grid stale.
//     Host-level behaviour verified by webviewRequery.test.ts; this file
//     covers host state-transition ordering.
//   - critical #2: loadMore after requery reads the NEW cursor. The panel
//     calls `runner.adopt(index, stmt)` to sync the runner's internal
//     entry to the new batched cursor so subsequent `runner.loadMore(i)`
//     reaches the new cursor, not the pre-requery one.
//   - important #1: composeRequery uses sql VERBATIM (no `;` split —
//     split is literal-unsafe). Covered by resultsGridModelRequery.test.ts.
//   - important #2: pickResult returns rowCount=null for batched cursors
//     so webview hasMore stays true while the cursor is open.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import {
  QueryRunner,
  pickResult,
  type RunResult,
  type BatchedQuery,
  type QueryResult,
  type StatementResult,
} from "../../core/queryRunner";
import type { ParsedStatement } from "../../config/types";
import type { DbAdapter } from "../../adapters/types";
type MessageHandler = (msg: unknown) => void;

// ---- FakeWebview + FakeWebviewPanel (mirrors sibling test files) ----------

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

import { ResultsPanel } from "../resultsPanel";
import { buildPagedQueryTerms } from "../queryComposer";

// ---- helpers --------------------------------------------------------------

interface BatchedOpts {
  columns: string[];
  initialRows: unknown[][];
  nextBatches?: unknown[][][];
  fetchError?: Error;
}

interface RecordingBatchedOpts extends BatchedOpts {
  closeCalls: number;
  cancelCalls: number;
}

function makeRecordingBatched(
  opts: RecordingBatchedOpts,
): BatchedQuery & { closeCalls: number; cancelCalls: number } {
  let fetched = 0;
  const cursor = {
    columns: opts.columns,
    async fetchBatch(): Promise<unknown[][] | null> {
      fetched += 1;
      if (opts.fetchError) throw opts.fetchError;
      if (fetched === 1) {
        return opts.initialRows;
      }
      const next = opts.nextBatches?.[fetched - 2];
      return next ?? null;
    },
    async cancel(): Promise<void> {
      opts.cancelCalls += 1;
    },
    async close(): Promise<void> {
      opts.closeCalls += 1;
    },
  };
  return cursor;
}

function makeBatchedRunResult(opts: BatchedOpts): RunResult {
  let fetched = 0;
  const batched: BatchedQuery = {
    columns: opts.columns,
    async fetchBatch(): Promise<unknown[][] | null> {
      fetched += 1;
      if (opts.fetchError) throw opts.fetchError;
      if (fetched === 1) return opts.initialRows;
      const next = opts.nextBatches?.[fetched - 2];
      return next ?? null;
    },
    async cancel(): Promise<void> {
      /* noop */
    },
    async close(): Promise<void> {
      /* noop */
    },
  };
  return { results: [], batched };
}

function makeBatchedCursor(
  fetchSequence: Array<unknown[][] | null>,
): BatchedQuery {
  const fetchBatch = vi
    .fn<[], Promise<unknown[][] | null>>()
    .mockImplementation(async () => {
      const next = fetchSequence.shift();
      if (next === undefined) return null;
      return next;
    });
  return {
    columns: ["id"],
    fetchBatch,
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

interface RealRunnerSetup {
  runner: QueryRunner;
  initialBatched: BatchedQuery;
  requeryBatched: BatchedQuery;
  firstSql: { sql: string };
  secondSql: { sql: string };
}

function makeRealRunner(): RealRunnerSetup {
  const initialBatched = makeBatchedCursor([[[1], [2], [3]]]);
  const requeryBatched = makeBatchedCursor([[[10], [11], [12]], [[100]]]);
  const firstSql = { sql: "" };
  const secondSql = { sql: "" };
  let callCount = 0;
  const adapter: DbAdapter = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    runQuery: vi.fn(async (sql: string): Promise<RunResult> => {
      callCount += 1;
      if (callCount === 1) {
        firstSql.sql = sql;
        return { results: [], batched: initialBatched };
      }
      if (callCount === 2) {
        secondSql.sql = sql;
        return { results: [], batched: requeryBatched };
      }
      throw new Error("unexpected runQuery call");
    }),
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    testConnection: vi.fn(async () => undefined),
  } as unknown as DbAdapter;
  const runner = new QueryRunner(async () => adapter);
  return { runner, initialBatched, requeryBatched, firstSql, secondSql };
}

function makeStmt(text: string): ParsedStatement {
  return { text, start: 0, end: text.length };
}

/** Wait until the last state message for statement 0 is in a terminal
 * status (done | error | no r.result at all). The running post is the
 * FIRST state sent; we want the second one (done | error) before
 * asserting on the requery outcome. */
async function waitForTerminal(fake: FakeWebviewPanel): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const states = stateMessages(fake);
    const last = states[states.length - 1];
    const r = (last?.results as Array<{ status?: string }> | undefined)?.[0];
    if (r && r.status !== "running") return;
    await Promise.resolve();
  }
}

function stateMessages(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map((c) => c[0] as { type?: string; results?: Array<Record<string, unknown>>; index?: number })
    .filter((m) => m.type === "state");
}

beforeEach(() => {
  lastView.current = null;
  providerStore.length = 0;
  lastPanel.current = null;
  vi.clearAllMocks();
});

// =============================================================================
// Fix R1 critical #2 — batched handle adopted on requery
// =============================================================================

describe("ResultsPanel — handleRequery adopts batched cursor (Fix R1 critical #2)", () => {
  it("Requery on a single SELECT → state.postMessage carries rows + columns from the initial fetchBatch", async () => {
    const requeryBatched = makeRecordingBatched({
      columns: ["id"],
      initialRows: [[10], [20]],
      closeCalls: 0,
      cancelCalls: 0,
    });
    const recorded: { sql: string }[] = [];
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return { results: [], batched: requeryBatched };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[1], [2], [3]], rowCount: 3, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "id > 5",
      orderBy: "id DESC",
    });
    await waitForTerminal(fake);

    // composeRequery wraps + adds WHERE + ORDER BY. With the R2 fix, the
    // inner statement is verbatim — no `;` split.
    expect(recorded[0]?.sql).toBe(
      "SELECT * FROM (SELECT id FROM t) UnicDB_sub WHERE id > 5 ORDER BY id DESC",
    );

    const states = stateMessages(fake);
    expect(states.length).toBeGreaterThanOrEqual(1);
    const lastState = states[states.length - 1]!;
    const results = lastState.results as Array<{
      index: number;
      status: string;
      result?: QueryResult;
      batched?: BatchedQuery;
    }>;
    const entry = results[0]!;
    expect(entry.status).toBe("done");
    expect(entry.result).toBeTruthy();
    expect(entry.result!.columns).toEqual(["id"]);
    expect(entry.result!.rows).toEqual([[10], [20]]);
    // TASK-006 P3-3 — host state payloads normalize the live cursor handle
    // to the webview wire type (`batched?: boolean`).
    expect(entry.batched).toBe(true);
    expect(typeof entry.batched).toBe("boolean");
  });

  it("Requery with empty WHERE/ORDER BY emits the literal statement (no `;` corruption)", async () => {
    const requeryBatched = makeRecordingBatched({
      columns: ["id"],
      initialRows: [[1]],
      closeCalls: 0,
      cancelCalls: 0,
    });
    const recorded: { sql: string }[] = [];
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return { results: [], batched: requeryBatched };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
    });
    await waitForTerminal(fake);

    expect(recorded[0]?.sql).toBe("SELECT id FROM t");
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      result?: QueryResult;
      batched?: BatchedQuery;
    }>;
    expect(results[0]!.result!.columns).toEqual(["id"]);
    expect(results[0]!.result!.rows).toEqual([[1]]);
    // TASK-006 P3-3 — live cursor handles never cross the host/webview wire.
    expect(results[0]!.batched).toBe(true);
    expect(typeof results[0]!.batched).toBe("boolean");
  });
});

// =============================================================================
// Fix R1 critical #3 — previous batched cursor closed on requery
// =============================================================================

describe("ResultsPanel — handleRequery closes previous batched cursor (Fix R1 critical #3)", () => {
  it("Previous statement's batched cursor is closed before the requery runs", async () => {
    const previousCloseable = {
      columns: ["id"],
      initialRows: [[1]],
      nextBatches: [] as unknown[][][],
      closeCalls: 0,
      cancelCalls: 0,
    };
    const previousBatched = makeRecordingBatched(previousCloseable);

    const requeryBatched = makeRecordingBatched({
      columns: ["id"],
      initialRows: [[10]],
      closeCalls: 0,
      cancelCalls: 0,
    });
    const recorded: { sql: string }[] = [];
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      return { results: [], batched: requeryBatched };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;

    const panel = new ResultsPanel({ runner });
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

    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "id > 5",
      orderBy: "",
    });
    await waitForTerminal(fake);

    expect(
      previousCloseable.closeCalls + previousCloseable.cancelCalls,
    ).toBeGreaterThanOrEqual(1);
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      batched?: BatchedQuery;
    }>;
    // TASK-006 P3-3 — live cursor handles never cross the host/webview wire.
    expect(results[0]!.batched).toBe(true);
    expect(typeof results[0]!.batched).toBe("boolean");
  });
});

// =============================================================================
// TASK-006 (cycle U) — post-commit requery with an OPEN batched cursor.
//
// The webview now posts the very same `requery` message automatically after
// saveResult.ok=true; this guards handleRequery's close-before-run ordering
// against regression on that path (Postgres pool max=1 — a leaked cursor
// wedges the requery behind a connect timeout).
// =============================================================================

describe("ResultsPanel — post-commit requery closes previous batched cursor first (TASK-006)", () => {
  it("Edge. batched cursor open + post-commit requery message ⇒ previous cursor closed BEFORE the requery SQL runs", async () => {
    // Global call-order log: close:previous vs runSql.
    const order: string[] = [];

    const previousBatched: BatchedQuery = {
      columns: ["id"],
      async fetchBatch() {
        return [[1], [2], [3]];
      },
      async cancel() {
        order.push("cancel:previous");
      },
      async close() {
        order.push("close:previous");
      },
    };
    const requeryBatched: BatchedQuery = {
      columns: ["id"],
      async fetchBatch() {
        return [[1], [2], [3]];
      },
      async cancel() {},
      async close() {},
    };

    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      order.push("runSql");
      return { results: [], batched: requeryBatched };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;

    // Statement 0 currently holds an OPEN batched cursor (Postgres
    // single-SELECT streaming shape).
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: {
            columns: ["id"],
            rows: [[1], [2], [3]],
            rowCount: 3,
            durationMs: 0,
          },
          batched: previousBatched,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    // Exactly the message the webview posts after saveResult.ok=true
    // (empty WHERE/ORDER BY — the bar defaults).
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
    });
    await waitForTerminal(fake);

    // The stale cursor was released (close alone suffices)…
    expect(order).toContain("close:previous");
    // …and it happened BEFORE the requery SQL ran.
    expect(order.indexOf("close:previous")).toBeLessThan(
      order.indexOf("runSql"),
    );
    expect(runSql).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Fix R1 — plain results path (non-batched adapters)
// =============================================================================

describe("ResultsPanel — handleRequery plain results path (Fix R1)", () => {
  it("Adapter returns `{ results: [...], batched: undefined }` → state carries rows", async () => {
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      return {
        results: [
          {
            columns: ["x"],
            rows: [["a"], ["b"]],
            rowCount: 2,
            durationMs: 0,
          },
        ],
      };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT x FROM t",
          status: "done",
          result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "x > 0",
      orderBy: "",
    });
    await waitForTerminal(fake);
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      result?: QueryResult;
      batched?: BatchedQuery;
    }>;
    expect(results[0]!.result!.rows).toEqual([["a"], ["b"]]);
    expect(results[0]!.result!.columns).toEqual(["x"]);
    // P3-3 normalizes absent internal handles to the explicit false wire value.
    expect(results[0]!.batched).toBe(false);
    expect(typeof results[0]!.batched).toBe("boolean");
  });
});

// =============================================================================
// Fix R2 critical #1 — requery posts running THEN done (state sequence)
// =============================================================================
//
// The webview's renderGrid detects a same-statement RESET via
// `lastResultStatus === "running" && r.status !== "running"`. The host
// must post a `running` state for the statement BEFORE runSql completes
// so the next `done` post triggers the reset branch (otherwise equal-row
// requeries take the append-delta / idempotent no-op branch and the grid
// stays stale).
describe("ResultsPanel — handleRequery state-transition order (Fix R2 critical #1)", () => {
  it("Requery posts running BEFORE done (statement sees the transition)", async () => {
    const requeryBatched = makeRecordingBatched({
      columns: ["id"],
      initialRows: [[10]],
      closeCalls: 0,
      cancelCalls: 0,
    });
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      return { results: [], batched: requeryBatched };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "id",
    });
    // Fix R2 critical #1: handleRequery now posts running BEFORE done.
    // Wait for the terminal state (status done | error), not just any
    // state — the running post is the FIRST state sent.
    await waitForTerminal(fake);

    const states = stateMessages(fake);
    // The last state should be done; there should be at least one state
    // with status running posted BEFORE the final done.
    const lastState = states[states.length - 1]!;
    const lastResults = lastState.results as Array<{
      index: number;
      status: string;
    }>;
    expect(lastResults[0]!.status).toBe("done");

    // Find a running state for statement 0 posted BEFORE the last one.
    const runningBefore = states.slice(0, -1).some((s) => {
      const rs = s.results as Array<{ index: number; status: string }>;
      return rs.some((r) => r.index === 0 && r.status === "running");
    });
    expect(runningBefore).toBe(true);
  });
});

// =============================================================================
// Fix R2 critical #2 — loadMore after requery uses the NEW cursor
// =============================================================================
//
// Before the fix, requery swapped `panel.lastResults[index].batched` but
// `runner.loadMore(index)` reads runner-internal `results[index].batched`
// (queryRunner.ts:261) — still the PRE-requery cursor. After this fix the
// panel calls `runner.adopt(index, stmt)` to sync the new cursor.
describe("ResultsPanel — handleRequery syncs runner cursor (Fix R2 critical #2)", () => {
  it("loadMore after requery reads the NEW cursor (returns new rows, not pre-requery ones)", async () => {
    const { runner, requeryBatched } = makeRealRunner();
    await runner.run([makeStmt("SELECT id FROM t")], () => undefined);

    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: {
            columns: ["id"],
            rows: [[1], [2], [3]],
            rowCount: 3,
            durationMs: 0,
          },
          batched: runner.getResults()[0]!.batched,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "id > 5",
      orderBy: "id DESC",
    });
    // Fix R2 critical #1: handleRequery now posts running BEFORE done.
    // Wait for the terminal state (status done | error).
    await waitForTerminal(fake);
    const requeryState = stateMessages(fake).slice(-1)[0]!;
    const requeryResults = requeryState.results as Array<{
      result?: QueryResult;
      batched?: BatchedQuery;
    }>;
    expect(requeryResults[0]!.result!.rows).toEqual([[10], [11], [12]]);

    // Load more through the runner. Must read requeryBatched (not the
    // initial cursor) so we get the new next batch ([[100]]).
    const updated = await runner.loadMore(0);
    expect(updated[0]!.result!.rows).toEqual([[10], [11], [12], [100]]);
  });

  it("QueryRunner.adopt(index, stmt) replaces the entry's batched cursor in place", async () => {
    const { runner, initialBatched, requeryBatched } = makeRealRunner();
    await runner.run([makeStmt("SELECT id FROM t")], () => undefined);
    // After runner.run(): initialBatched.fetchBatch was called once
    // (pickResult initial fetch inside executeAll) and runner's entry
    // holds rows [[1],[2],[3]].

    // adopt: replace runner's internal entry[0] entirely. We do NOT
    // pre-fetch requeryBatched — loadMore will fetch its first batch
    // here (which is what the test asserts).
    runner.adopt(0, {
      index: 0,
      sql: "SELECT id FROM t",
      status: "done",
      result: { columns: ["id"], rows: [], rowCount: null, durationMs: 0 },
      batched: requeryBatched,
      durationMs: 0,
    });

    const updated = await runner.loadMore(0);
    expect(updated[0]!.result!.rows).toEqual([[10], [11], [12]]);
    expect(initialBatched.fetchBatch).toHaveBeenCalledTimes(1);
    expect(requeryBatched.fetchBatch).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Fix R2 important #2 — pickResult rowCount=null for batched
// =============================================================================
//
// pickResult's doc comment says "rowCount = null cho batched (chưa biết
// tổng)" but the implementation set `rowCount = initialRows.length` when
// the initial batch returned any rows. That made the grid model's
// hasMore=false while the cursor was still open — Load More vanished on
// the very first batch. Fix: always null for batched so hasMore stays
// true while the cursor is open.
describe("pickResult — rowCount=null for batched (Fix R2 important #2)", () => {
  it("batched with initial rows: rowCount=null (not initialRows.length)", async () => {
    const batched = makeBatchedCursor([[[1], [2], [3]]]);
    const r = await pickResult({ results: [], batched });
    expect(r.rowCount).toBeNull();
  });

  it("batched with empty initial batch: rowCount=null", async () => {
    const batched = makeBatchedCursor([null]);
    const r = await pickResult({ results: [], batched });
    expect(r.rowCount).toBeNull();
  });

  it("non-batched: rowCount preserved from results[0]", async () => {
    const r = await pickResult({
      results: [
        { columns: ["x"], rows: [["a"], ["b"]], rowCount: 7, durationMs: 0 },
      ],
    });
    expect(r.rowCount).toBe(7);
  });
});

// =============================================================================
// TASK-004 (cycle Y) — keyset paging + missing-PK projection wiring.
//
// The host consumes composeKeysetQuery through composeRequerySql ONLY in the
// paging lane (filters/offset present). A webview-supplied `lastKey` swaps
// deep OFFSET for the cursor predicate; a gated explicit projection missing
// PK columns is widened and the appended columns are stripped from the
// DISPLAYED result while their values stay positionally available for the
// next page's key. DISTINCT/aggregates (gate-refused SQL) never widen.
// =============================================================================

import type { SaveContext } from "../resultsPanel";

describe("ResultsPanel — keyset paging (TASK-004 cycle Y)", () => {
  interface PanelOpts {
    driver?: string;
    sql?: string;
    columns?: string[];
    pkColumns?: string[];
    /** Row served by every requery runSql call. */
    requeryRows?: unknown[][];
    requeryColumns?: string[];
  }

  function makeKeysetPanel(opts: PanelOpts) {
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => ({
      results: [
        {
          columns: opts.requeryColumns ?? opts.columns ?? ["id"],
          rows: opts.requeryRows ?? [[1]],
          rowCount: (opts.requeryRows ?? [[1]]).length,
          durationMs: 0,
        },
      ],
    }));
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql,
      adopt: vi.fn(),
      isCancelled: () => false,
    } as unknown as QueryRunner;
    const saveContext: SaveContext = {
      getDriver: () => (opts.driver ?? "postgres") as never,
      listPkColumns: async () => opts.pkColumns ?? [],
    };
    const panel = new ResultsPanel({ runner, saveContext });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: opts.sql ?? "SELECT * FROM events",
          status: "done",
          result: {
            columns: opts.columns ?? ["id"],
            rows: [[1]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    return { runSql, fake: lastPanel.current! };
  }

  it("lastRow key present → composed SQL carries the keyset predicate with LIMIT, no OFFSET", async () => {
    // Full PK visible ("id" projected on SELECT *) ⇒ tiebreakers armed.
    const { runSql, fake } = makeKeysetPanel({
      sql: "SELECT * FROM events",
      columns: ["created_at", "id"],
      pkColumns: ["id"],
    });
    lastPanel.current!.webview.postMessage.mockClear();
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "id DESC",
      offset: 100000,
      limit: 500,
      append: true,
      lastKey: [{ column: "id", value: 42 }],
    });
    await waitForTerminal(fake);
    const sql = runSql.mock.calls[0]![0] as string;
    expect(sql).toContain('("id" < 42)');
    expect(sql).toContain("LIMIT 500");
    expect(sql).not.toContain("OFFSET");
  });

  it("no lastKey supplied (current webview) → byte-identical legacy OFFSET composition", async () => {
    const sql = "SELECT * FROM events";
    const { runSql, fake } = makeKeysetPanel({
      sql,
      columns: ["id"],
      pkColumns: ["id"],
    });
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "id DESC",
      offset: 100000,
      limit: 500,
      append: true,
    });
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    expect(composed).toBe(
      buildPagedQueryTerms(
        sql,
        "",
        [{ column: "id", direction: "DESC" }],
        100000,
        500,
        "postgres",
        ["id"],
      ),
    );
  });

  it("missing-PK projection on a gated browse widens the SQL and strips hidden columns from the displayed result", async () => {
    const { runSql, fake } = makeKeysetPanel({
      sql: "SELECT name FROM users",
      columns: ["name"],
      pkColumns: ["id"],
      requeryColumns: ["name", "id"],
      requeryRows: [["alice", 7], ["bob", 8]],
    });
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "",
      offset: 0,
      limit: 500,
    });
    await waitForTerminal(fake);
    // Projection was widened server-side… page 0 stays byte-identical to the
    // cycle-W composition applied to the WIDENED projection (empty user ORDER
    // BY + PK tiebreaker appended).
    expect(runSql.mock.calls[0]![0]).toBe(
      buildPagedQueryTerms(
        'SELECT name, "id" FROM users',
        "",
        [],
        0,
        500,
        "postgres",
        ["id"],
      ),
    );
    // …but the DISPLAYED result hides the injected column while its value
    // stays positionally available for the paging key.
    const state = stateMessages(fake).slice(-1)[0]!;
    const entry = (state.results as Array<{ result?: QueryResult; status?: string }>)[0]!;
    expect(entry.status).toBe("done");
    expect(entry.result!.columns).toEqual(["name"]);
    expect(entry.result!.rows).toEqual([["alice"], ["bob"]]);
  });

  it("DISTINCT base SQL keeps safe OFFSET paging and injects no hidden PK columns", async () => {
    const { runSql, fake } = makeKeysetPanel({
      sql: "SELECT DISTINCT region FROM sales",
      columns: ["region"],
      pkColumns: ["id"],
      requeryColumns: ["region"],
      requeryRows: [["EMEA"]],
    });
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "",
      orderBy: "region ASC",
      offset: 500,
      limit: 500,
      append: true,
      lastKey: [{ column: "region", value: "EMEA" }],
    });
    await waitForTerminal(fake);
    const composed = runSql.mock.calls[0]![0] as string;
    // OFFSET fallback preserved verbatim (byte-identical to legacy), no
    // widening, no keyset predicate even though a lastKey was sent.
    expect(composed).toBe(
      buildPagedQueryTerms(
        "SELECT DISTINCT region FROM sales",
        "",
        [{ column: "region", direction: "ASC" }],
        500,
        500,
        "postgres",
        [],
      ),
    );
    expect(composed).not.toContain("> 'EMEA'");
  });
});


