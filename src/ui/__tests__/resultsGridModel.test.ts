// src/ui/__tests__/resultsGridModel.test.ts
// Pure-logic tests for the results-grid adapter model.
// No AG Grid, no vscode — must run in plain vitest node environment.
import { describe, it, expect, vi } from "vitest";
import {
  inferColumns,
  createResultsGridModel,
  selectionToText,
  shouldResetGrid,
  footerText,
  formatCell,
  type StatementResult,
} from "../resultsGridModel";

// ---- helpers ---------------------------------------------------------------

function makeResults(
  partials: Partial<StatementResult>[],
  overrides: Partial<StatementResult> = {},
): StatementResult[] {
  return partials.map((p, i) => ({
    index: p.index ?? i,
    sql: p.sql ?? `select ${i}`,
    status: p.status ?? "done",
    result: p.result,
    error: p.error,
    durationMs: p.durationMs ?? 0,
    ...overrides,
    ...p,
  }));
}

// =============================================================================
// 1. inferColumns
// =============================================================================
describe("inferColumns", () => {
  it("infers number kind from number + bigint-sanitized string", () => {
    const rows: unknown[][] = [
      [123, "9007199254740993"],
      [456, "9007199254740994"],
    ];
    const cols = inferColumns(["n", "big"], rows);
    expect(cols).toEqual([
      { field: "n", headerName: "n", kind: "number", alignRight: true },
      { field: "big", headerName: "big", kind: "number", alignRight: true },
    ]);
  });

  it("infers string kind for string/iso-date sample", () => {
    const rows: unknown[][] = [
      ["abc", "2026-01-01T00:00:00.000Z"],
      ["def", "2026-01-02T00:00:00.000Z"],
    ];
    const cols = inferColumns(["s", "d"], rows);
    expect(cols).toEqual([
      { field: "s", headerName: "s", kind: "string" },
      { field: "d", headerName: "d", kind: "string" },
    ]);
  });

  it("infers boolean kind from boolean sample", () => {
    const cols = inferColumns(["flag"], [[true], [false], [true]]);
    expect(cols).toEqual([{ field: "flag", headerName: "flag", kind: "boolean" }]);
  });

  it("falls back to string when all values are null", () => {
    const cols = inferColumns(["x"], [[null], [null]]);
    expect(cols).toEqual([{ field: "x", headerName: "x", kind: "string" }]);
  });

  it("returns empty array when no columns", () => {
    expect(inferColumns([], [])).toEqual([]);
  });
});

// =============================================================================
// 2. loadMore gate fires exactly once per request→sync cycle (dedup)
// =============================================================================
describe("createResultsGridModel — loadMore gate", () => {
  it("fires onNeedMore once for first scroll near bottom; second requestWindow before sync is deduped", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const stmt: StatementResult = makeResults(
      [
        {
          index: 0,
          sql: "select 1",
          status: "running",
          result: { columns: ["n"], rows: [], rowCount: 500, commandTag: "SELECT", durationMs: 0 },
        },
      ],
    )[0];
    // mark as batched with hasMore via sync first (loaded=0)
    model.sync(stmt.result!.rows, 0, true, { total: 500, loadedBefore: 0 });

    // displayedRow=495 means user is near bottom (500 - 5); viewport=30.
    model.requestWindow(495, 30);
    model.requestWindow(495, 30); // dedup before sync
    model.requestWindow(498, 30); // still dedup

    expect(onNeedMore).toHaveBeenCalledTimes(1);
  });

  it("clears gate after sync, fires again on next requestWindow", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const r: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows: [], rowCount: 500, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];
    model.sync(r.result!.rows, 0, true, { total: 500, loadedBefore: 0 });
    model.requestWindow(495, 30);
    expect(onNeedMore).toHaveBeenCalledTimes(1);

    // sync brings 500 more rows in (loadMore returned them)
    model.sync(r.result!.rows, 0, true, { total: 1000, loadedBefore: 500 });
    model.requestWindow(995, 30);
    expect(onNeedMore).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// 3. sync — append delta + idempotent on same data
// =============================================================================
describe("createResultsGridModel — sync append delta", () => {
  it("returns deep-equal appendDelta for new tail of rows", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const firstBatch: unknown[][] = Array.from({ length: 500 }, (_, i) => [i]);
    const r1: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows: firstBatch, rowCount: 1000, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];

    const s1 = model.sync(r1.result!.rows, 0, true, { total: 1000, loadedBefore: 0 });
    expect(s1.appendDelta).toEqual(firstBatch);
    expect(s1.isReset).toBe(false);

    const secondBatch: unknown[][] = [
      ...firstBatch,
      ...Array.from({ length: 500 }, (_, i) => [500 + i]),
    ];
    const r2: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows: secondBatch, rowCount: 1000, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];

    const s2 = model.sync(r2.result!.rows, 0, true, { total: 1000, loadedBefore: 500 });
    const newTail = secondBatch.slice(500);
    expect(s2.appendDelta).toEqual(newTail);
    expect(s2.appendDelta.length).toBe(500);
    expect(s2.isReset).toBe(false);
  });

  it("sync with same row count is idempotent (no delta, no reset)", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const rows: unknown[][] = Array.from({ length: 1000 }, (_, i) => [i]);
    const r: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows, rowCount: 1000, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];

    const s1 = model.sync(r.result!.rows, 0, true, { total: 1000, loadedBefore: 0 });
    expect(s1.appendDelta.length).toBe(1000);

    const s2 = model.sync(r.result!.rows, 0, true, { total: 1000, loadedBefore: 1000 });
    expect(s2.appendDelta).toEqual([]);
    expect(s2.isReset).toBe(false);
  });
});

// =============================================================================
// 4. EOF — when rowCount === rows.length, hasMore flips false and total pinned
// =============================================================================
describe("createResultsGridModel — EOF handling", () => {
  it("pierces hasMore=false when rowCount === rows.length and pins total", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const rows: unknown[][] = Array.from({ length: 1000 }, (_, i) => [i]);
    const r: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows, rowCount: 1000, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];

    // caller signals hasMore=true, but rowCount === rows.length → EOF
    const s = model.sync(r.result!.rows, 0, true, {
      total: null,
      loadedBefore: 500,
      rowCount: 1000,
    });

    const st = model.getState();
    expect(st.hasMore()).toBe(false);
    expect(st.getLoaded()).toBe(1000);
    expect(s.isReset).toBe(false);
  });
});

// =============================================================================
// 5. cancelMore permanently locks the gate
// =============================================================================
describe("createResultsGridModel — cancelMore", () => {
  it("silences all subsequent requestWindow calls after cancelMore()", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const r: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows: [], rowCount: 1000, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];
    model.sync(r.result!.rows, 0, true, { total: 1000, loadedBefore: 0 });

    model.cancelMore();
    model.requestWindow(999, 30);
    model.requestWindow(2000, 30);
    expect(onNeedMore).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 6. reset
// =============================================================================
describe("createResultsGridModel — reset", () => {
  it("clears state, opens gate, treats next sync as fresh (no delta)", () => {
    const onNeedMore = vi.fn();
    const model = createResultsGridModel({ onNeedMore });

    const rows: unknown[][] = Array.from({ length: 1000 }, (_, i) => [i]);
    const r: StatementResult = makeResults([
      {
        index: 0,
        sql: "select 1",
        status: "done",
        result: { columns: ["n"], rows, rowCount: 1000, commandTag: "SELECT", durationMs: 0 },
      },
    ])[0];
    model.sync(r.result!.rows, 0, true, { total: 1000, loadedBefore: 0 });

    model.reset();

    expect(model.getState().getLoaded()).toBe(0);
    expect(model.getState().hasMore()).toBe(false);

    // gate re-opens after reset
    model.requestWindow(495, 30);
    expect(onNeedMore).toHaveBeenCalledTimes(1);

    // sync after reset treats as fresh
    const s = model.sync(r.result!.rows, 0, true, { total: 1000, loadedBefore: 0 });
    expect(s.isReset).toBe(true);
    expect(s.appendDelta).toEqual(rows);
  });
});

// =============================================================================
// 7. selectionToText — tab separated
// =============================================================================
describe("selectionToText", () => {
  it("joins cells with tab, rows with newline; null → empty string", () => {
    const rows: unknown[][] = [
      [1, "a"],
      [2, null],
    ];
    expect(selectionToText(rows)).toBe("1\ta\n2\t");
  });
});

// =============================================================================
// 8. shouldResetGrid
// =============================================================================
describe("shouldResetGrid", () => {
  it("returns true if any result is running", () => {
    const rs: StatementResult[] = makeResults([
      { status: "done" },
      { status: "running" },
      { status: "error" },
    ]);
    expect(shouldResetGrid(rs)).toBe(true);
  });

  it("returns false when all results are terminal", () => {
    const rs: StatementResult[] = makeResults([
      { status: "done" },
      { status: "error" },
      { status: "cancelled" },
    ]);
    expect(shouldResetGrid(rs)).toBe(false);
  });
});

// =============================================================================
// 9. footerText
// =============================================================================
describe("footerText", () => {
  it("batched stats: contains loaded count and 'load more' affordance", () => {
    const text = footerText(500, null, true, 500, false);
    expect(text).toContain("500");
    expect(text.toLowerCase()).toContain("load more");
  });

  it("filtered stats: 'X of Y' format", () => {
    const text = footerText(200, 200, false, 176, true);
    expect(text).toContain("176 of 200");
  });
});

// =============================================================================
// 10. formatCell — verbatim from webview/grid.ts
// =============================================================================
describe("formatCell", () => {
  it("bigint → string", () => {
    expect(formatCell(BigInt("9007199254740993"))).toBe("9007199254740993");
  });

  it("Date → ISO string", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(formatCell(d)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("object → JSON string", () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });

  it("null → empty string", () => {
    expect(formatCell(null)).toBe("");
  });

  it("undefined → empty string", () => {
    expect(formatCell(undefined)).toBe("");
  });

  it("primitive passthrough", () => {
    expect(formatCell(42)).toBe("42");
    expect(formatCell("hello")).toBe("hello");
    expect(formatCell(true)).toBe("true");
  });
});
