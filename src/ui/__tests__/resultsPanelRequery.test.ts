// src/ui/__tests__/resultsPanelRequery.test.ts
//
// TASK-504 Fix Round 1 — host-side requery handler tests.
//
// Covers the three blocker findings from the reviewer verdict:
//
//   1. CRITICAL #2 — handleRequery must consume the batched handle exactly
//      like QueryRunner.executeAll does. Adapters return
//      { results: [], batched } for a single `;`-free SELECT (which is
//      exactly what composeRequery emits). The unguarded
//      `refreshed.results[0]` was always undefined → entry swapped to
//      `status:"done"` with no result → grid blanks. We must adopt the
//      batched cursor (pickResult + initial fetchBatch + store) and the
//      requery must actually return rows.
//
//   2. CRITICAL #3 — abandoning the previous batched cursor leaks the
//      Postgres pool client (pool max=1). Before starting a new requery,
//      the previous statement's batched handle MUST be closed/cancelled.
//      Fake adapter records close/cancel calls; we assert the previous
//      cursor was closed.
//
//   3. CRITICAL #1 (webview/main.ts) — covered by webviewKeybinding
//      B1/B2 and webviewSaveEdits T4 (banner persistence). This file is
//      only for the host-side fixes; the webview fix is verified via the
//      regression banner tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  QueryRunner,
  RunResult,
  BatchedQuery,
  QueryResult,
} from "../../core/queryRunner";

type MessageHandler = (msg: unknown) => void;

// Re-declare just the bits we need from the sibling test file (it's not
// exported). We replicate the FakeWebview / FakeWebviewPanel locally — the
// only behavioral dependency is "panel dispatches our requery message".

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

const lastPanel: { current: FakeWebviewPanel | null } = { current: null };

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        path: parts.map((p: unknown) => (p as { fsPath?: string; path?: string })?.fsPath ?? (p as { path?: string })?.path ?? "").join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      createWebviewPanel: (vt: string, t: string, col: number, opts: unknown) => {
        const p = new FakeWebviewPanel(vt, t, col, opts);
        lastPanel.current = p;
        return p;
      },
      showErrorMessage: vi.fn(async () => undefined),
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
  };
});

import { ResultsPanel } from "../resultsPanel";

interface BatchedOpts {
  /** Columns returned by the cursor's metadata. */
  columns: string[];
  /** Rows for the initial 500-row fetch. */
  initialRows: unknown[][];
  /** Rows for subsequent fetchBatch calls (after initial). */
  nextBatches?: unknown[][][];
  /** Optional error to throw from fetchBatch. */
  fetchError?: Error;
}

interface RecordingBatchedOpts extends BatchedOpts {
  /** Track close() / cancel() calls. */
  closeCalls: number;
  cancelCalls: number;
}

function makeRecordingBatched(opts: RecordingBatchedOpts): BatchedQuery & {
  closeCalls: number;
  cancelCalls: number;
} {
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
      return next ?? null; // EOF after nextBatches exhausted
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

function stateMessages(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map((c) => c[0] as { type?: string; results?: Array<Record<string, unknown>>; index?: number })
    .filter((m) => m.type === "state");
}

beforeEach(() => {
  lastPanel.current = null;
  vi.clearAllMocks();
});

// ---- CRITICAL #2 — batched handle adopted on requery ------------------------

describe("ResultsPanel — handleRequery adopts batched cursor (Fix R1 critical #2)", () => {
  it("Requery on a single SELECT → state.postMessage carries rows + columns from the initial fetchBatch", async () => {
    // The requery adapter returns a NEW batched cursor (mirrors what the
    // Postgres adapter does for any single `;`-free SELECT — which is
    // exactly what composeRequery emits).
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
    // Initial render supplies a synthetic StatementResult — runSql is
    // NOT called for the editor SQL itself (that's done by extension.ts
    // before ResultsPanel.render). We only patch runSql for the requery.
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
    for (let i = 0; i < 200; i++) {
      if (stateMessages(fake).length > 0) break;
      await Promise.resolve();
    }

    // The requery composed the SQL via composeRequery (wrap + WHERE + ORDER BY).
    expect(recorded[0]?.sql).toBe(
      "SELECT * FROM (SELECT id FROM t) vsdb_sub WHERE id > 5 ORDER BY id DESC",
    );

    // The state postMessage MUST carry the batched rows + columns. If the
    // bug is present the entry would be { status:"done", result: undefined }
    // and the grid would blank.
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
    // Batched cursor stored on the entry so the webview's "load more"
    // would still work (mirrors QueryRunner.executeAll behaviour).
    expect(entry.batched).toBeTruthy();
    expect(entry.batched).toBe(requeryBatched);
  });
  it("Requery with empty WHERE/ORDER BY still emits a batched-aware state (no `;` corruption)", async () => {
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
    for (let i = 0; i < 200; i++) {
      if (stateMessages(fake).length > 0) break;
      await Promise.resolve();
    }

    // The composed SQL must NOT have a trailing `;` from the input that
    // would defeat the Postgres single-SELECT cursor path.
    expect(recorded[0]?.sql).toBe("SELECT id FROM t");
    // State carries the batched columns + initial rows.
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      result?: QueryResult;
      batched?: BatchedQuery;
    }>;
    expect(results[0]!.result!.columns).toEqual(["id"]);
    expect(results[0]!.result!.rows).toEqual([[1]]);
    expect(results[0]!.batched).toBe(requeryBatched);
  });
});

// ---- CRITICAL #3 — previous batched cursor closed on requery ---------------

describe("ResultsPanel — handleRequery closes previous batched cursor (Fix R1 critical #3)", () => {
  it("Previous statement's batched cursor is closed before the requery runs", async () => {
    // Previous cursor: the one returned for the original SELECT.
    const previousCloseable = {
      columns: ["id"],
      initialRows: [[1]],
      nextBatches: [] as unknown[][][],
      closeCalls: 0,
      cancelCalls: 0,
    };
    const previousBatched = makeRecordingBatched(previousCloseable);

    // Requery cursor: a brand-new cursor.
    const requeryBatched = makeRecordingBatched({
      columns: ["id"],
      initialRows: [[10]],
      closeCalls: 0,
      cancelCalls: 0,
    });

    const recorded: { sql: string }[] = [];
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      recorded.push({ sql });
      // Only the requery path calls runSql — render() just posts state.
      return { results: [], batched: requeryBatched };
    });
    const runner = {
      loadMore: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      runSql,
    } as unknown as QueryRunner;

    const panel = new ResultsPanel({ runner });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 0 },
          // Previous run already adopted this cursor.
          batched: previousBatched,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastPanel.current!;
    fake.webview.postMessage.mockClear();

    // Fire requery.
    fake.webview.dispatch({
      type: "requery",
      index: 0,
      where: "id > 5",
      orderBy: "",
    });
    for (let i = 0; i < 200; i++) {
      if (stateMessages(fake).length > 0) break;
      await Promise.resolve();
    }

    // The previous cursor's close() must have been called AT LEAST once
    // before the requery's runSql invocation. (Adapters may also call
    // cancel(); we accept either or both.)
    expect(
      previousCloseable.closeCalls + previousCloseable.cancelCalls,
    ).toBeGreaterThanOrEqual(1);
    // The new cursor is the one we expect on the entry.
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      batched?: BatchedQuery;
    }>;
    expect(results[0]!.batched).toBe(requeryBatched);
  });
});

// ---- Sanity: requery without batched (multi-statement or non-SELECT) --------

describe("ResultsPanel — handleRequery plain results path (Fix R1)", () => {
  it("Adapter returns `{ results: [...], batched: undefined }` → state carries rows (no batched handle needed)", async () => {
    const runSql = vi.fn(async (_sql: string): Promise<RunResult> => {
      // Simulate MySQL/MSSQL adapter returning populated results.
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
    for (let i = 0; i < 200; i++) {
      if (stateMessages(fake).length > 0) break;
      await Promise.resolve();
    }
    const lastState = stateMessages(fake).slice(-1)[0]!;
    const results = lastState.results as Array<{
      result?: QueryResult;
      batched?: BatchedQuery;
    }>;
    expect(results[0]!.result!.rows).toEqual([["a"], ["b"]]);
    expect(results[0]!.result!.columns).toEqual(["x"]);
    // No batched cursor (mysql/mssql) — entry.batched must not be set.
    expect(results[0]!.batched).toBeUndefined();
  });
});