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
  serializeTsv,
  serializeCsv,
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

  // TASK-001 — inferColumns NO LONGER auto-tags any column as hidden. The
  // previous TASK-006 behavior hardcoded `ctid` so the host could ship the
  // system column through the result set; under TASK-001 the browse path
  // never adds host metadata columns, so the inference layer has nothing
  // to hide. `spec.hidden` remains available for callers that explicitly
  // mark a column (none do today); this test locks the no-auto-hide
  // contract.
  it("inferColumns does NOT auto-tag any column as hidden (TASK-001)", () => {
    const rows: unknown[][] = [
      ["alice", "(0,1)"],
      ["bob", "(0,2)"],
    ];
    const cols = inferColumns(["name", "ctid"], rows);
    expect(cols).toEqual([
      { field: "name", headerName: "name", kind: "string" },
      { field: "ctid", headerName: "ctid", kind: "string" },
    ]);
    // No column carries a `hidden` key — host-metadata columns are
    // indistinguishable from user columns at the inference layer.
    expect(cols[0]?.hidden).toBeUndefined();
    expect(cols[1]?.hidden).toBeUndefined();
  });

  it("inferColumns leaves `hidden` undefined for ordinary columns (TASK-001)", () => {
    const rows: unknown[][] = [[1, "x"]];
    const cols = inferColumns(["id", "name"], rows);
    expect(cols[0]?.hidden).toBeUndefined();
    expect(cols[1]?.hidden).toBeUndefined();
  });
});

// =============================================================================
// 1b. inferColumns — unique `field` per spec (TASK-003 / A17)
// =============================================================================
// `field` must be unique across the returned specs so AG Grid does not key
// two distinct columns on the same field (which collapses both onto data
// index 0 via `columns.indexOf(name)`'s first-match behavior). `headerName`
// always stays the raw column name (may repeat).
describe("inferColumns — unique field (TASK-003 / A17)", () => {
  it("Happy: distinct names -> fields identical to headerName", () => {
    const rows: unknown[][] = [["a1", "b1"]];
    const cols = inferColumns(["a", "b"], rows);
    expect(cols.map((c) => c.field)).toEqual(["a", "b"]);
    expect(cols.map((c) => c.headerName)).toEqual(["a", "b"]);
  });

  it("Happy: kind inference intact for second (numeric) column", () => {
    const rows: unknown[][] = [
      ["x", 1],
      ["y", 2],
    ];
    const cols = inferColumns(["s", "n"], rows);
    expect(cols[1]).toEqual({ field: "n", headerName: "n", kind: "number", alignRight: true });
  });

  it('Edge (duplicate): ["id","id"] -> fields ["id","id__2"], both headerName "id"', () => {
    const rows: unknown[][] = [[1, 2]];
    const cols = inferColumns(["id", "id"], rows);
    expect(cols.map((c) => c.field)).toEqual(["id", "id__2"]);
    expect(cols.every((c) => c.headerName === "id")).toBe(true);
  });

  it('Edge (triple + collision bait): ["id","id","id__2"] -> all fields unique', () => {
    const rows: unknown[][] = [[1, 2, 3]];
    const cols = inferColumns(["id", "id", "id__2"], rows);
    const fields = cols.map((c) => c.field);
    expect(new Set(fields).size).toBe(3);
    expect(fields[0]).not.toBe(fields[1]);
    expect(fields[0]).not.toBe(fields[2]);
    expect(fields[1]).not.toBe(fields[2]);
    // headerName stays the raw (possibly-repeated) original name.
    expect(cols.map((c) => c.headerName)).toEqual(["id", "id", "id__2"]);
  });

  it("Edge (empty): inferColumns([], []) -> [], no throw", () => {
    expect(() => inferColumns([], [])).not.toThrow();
    expect(inferColumns([], [])).toEqual([]);
  });

  it('Regression (A17): ["id","id"] with rows [[1,2]] -- second spec resolves data index 1, not 0', () => {
    // Today `colIdx = columns.indexOf(name)` returns 0 for BOTH specs (first
    // match), so kind inference for the second "id" reads rows[i][0] instead
    // of rows[i][1]. Prove per-spec resolution by giving each index an
    // incompatible type: index 0 numeric, index 1 non-numeric string. If the
    // second spec were still reading index 0, it would also infer "number".
    const rows: unknown[][] = [[1, "not-a-number"]];
    const cols = inferColumns(["id", "id"], rows);
    expect(cols[0].kind).toBe("number");
    expect(cols[1].kind).toBe("string");
  });
});

// =============================================================================
// 1c. inferColumns — declared server types override sampled inference (TASK-003)
// =============================================================================
// P2-4 fix at the pure grid-model boundary: when the host supplies a declared
// DB type for a column NAME, that type decides `kind` and row sampling is
// skipped entirely. Rationale (PLAN §3.3): row-sniffing is page-dependent —
// a varchar holding digit strings misclassifies as "number" today, and an
// all-NULL numeric window collapses to "string". Webview wiring is owned by
// TASK-007; these tests exercise the pure model directly.
describe("inferColumns — declared columnTypes override (TASK-003)", () => {
  it("Happy: declared varchar defeats numeric-looking sample", () => {
    // Every sampled value here is NUMERIC_STRING — sampling alone would say
    // number/alignRight. The declared varchar must win.
    const cols = inferColumns(["code"], [["123"], ["456"]], { code: "varchar" });
    expect(cols).toEqual([{ field: "code", headerName: "code", kind: "string" }]);
    expect(cols[0]?.alignRight).toBeUndefined();
  });

  it("Edge (empty): declared integer classifies all-NULL data", () => {
    // No non-null sample values — sampling falls back to "string"; the
    // declared integer must yield number + right alignment.
    const cols = inferColumns(["count"], [[null], [undefined]], { count: "integer" });
    expect(cols).toEqual([
      { field: "count", headerName: "count", kind: "number", alignRight: true },
    ]);
  });

  it("Edge (boundary): declared boolean wins conflicting string samples", () => {
    // Sampling cannot prove boolean from the strings "true"/"false" — today
    // they classify as string. Declared boolean overrides.
    const cols = inferColumns(["enabled"], [["true"], ["false"]], { enabled: "boolean" });
    expect(cols).toEqual([{ field: "enabled", headerName: "enabled", kind: "boolean" }]);
  });

  it("Regression: omitted third argument is byte-identical to pre-TASK-003 output (incl. id→id__2 suffixing)", () => {
    // Numeric kind, string kind AND duplicate-field de-duplication in one
    // call — with NO third argument the output must match today exactly.
    const rows: unknown[][] = [
      [1, "a"],
      [2, "b"],
    ];
    const expected = [
      { field: "id", headerName: "id", kind: "number", alignRight: true },
      { field: "id__2", headerName: "id", kind: "string" },
    ];
    expect(inferColumns(["id", "id"], rows)).toEqual(expected);
    // Explicit `undefined` must behave identically to omission.
    expect(inferColumns(["id", "id"], rows, undefined)).toEqual(expected);
  });

  it("Edge (unknown declaration): geometry falls back to sampling", () => {
    // An unrecognized declared type must NOT force string — nonempty numeric
    // samples still classify as number/alignRight via sampling.
    const cols = inferColumns(["geo"], [[1.5], [2.5]], { geo: "geometry" });
    expect(cols).toEqual([
      { field: "geo", headerName: "geo", kind: "number", alignRight: true },
    ]);
  });
});

// =============================================================================
// 1d. inferColumns — typmod'd declared types + extended vocabulary (R4.5)
// =============================================================================
// Reviewer finding (TASK-003 Fix Round 4.5): PostgreSQL introspection ships
// typmod'd type names (src/core/ddl/pgIntrospect.ts uses
// format_type(atttypid, atttypmod) → "numeric(10,2)", "bit(1)"), but only the
// STRING family accepted a "(...)" modifier — a declared numeric(10,2) fell
// through to sampling and landed as left-aligned string. Also adds the dialect
// tokens the producers emit: MySQL tinyint/mediumint/double, MSSQL
// smallmoney, and boolean bit for MSSQL/MySQL. Tests pin: modifier tolerance
// on the numeric/boolean families, the new tokens, and lookalike guards
// (family-bounded matching must never leak into unknown/partial types).
describe("inferColumns — declared types with typmod / extended vocabulary (R4.5)", () => {
  it("Happy: declared numeric(10,2) classifies all-NULL data as number + alignRight", () => {
    // The most common PG decimal/money declaration from format_type(); no
    // non-null sample values, so only the declared type can decide kind.
    const cols = inferColumns(["price"], [[null], [null]], { price: "numeric(10,2)" });
    expect(cols).toEqual([
      { field: "price", headerName: "price", kind: "number", alignRight: true },
    ]);
  });

  it("Extended numeric tokens: tinyint/mediumint/double/smallmoney -> number + alignRight", () => {
    const cols = inferColumns(
      ["a", "b", "c", "d"],
      [[null, null, null, null]],
      { a: "tinyint", b: "mediumint", c: "double", d: "smallmoney" },
    );
    expect(cols).toEqual([
      { field: "a", headerName: "a", kind: "number", alignRight: true },
      { field: "b", headerName: "b", kind: "number", alignRight: true },
      { field: "c", headerName: "c", kind: "number", alignRight: true },
      { field: "d", headerName: "d", kind: "number", alignRight: true },
    ]);
  });

  it("Extended boolean token: bit and bit(1) -> boolean", () => {
    const cols = inferColumns(["f1", "f2"], [[null, null]], { f1: "bit", f2: "bit(1)" });
    expect(cols).toEqual([
      { field: "f1", headerName: "f1", kind: "boolean" },
      { field: "f2", headerName: "f2", kind: "boolean" },
    ]);
  });

  it("Regression: varchar(50) still string; bare int4 still number; geometry still sampling", () => {
    const cols = inferColumns(
      ["name", "n", "geo"],
      [["123", null, "polygon"]],
      { name: "varchar(50)", n: "int4", geo: "geometry" },
    );
    expect(cols[0]).toEqual({ field: "name", headerName: "name", kind: "string" });
    expect(cols[1]).toEqual({
      field: "n",
      headerName: "n",
      kind: "number",
      alignRight: true,
    });
    // geometry is unknown metadata → sampling over the single string sample
    // decides, exactly as before the fix.
    expect(cols[2]).toEqual({ field: "geo", headerName: "geo", kind: "string" });
  });

  it("Guard: lookalikes and embedded junk do NOT match a family token (sampling decides)", () => {
    // All-NULL + non-numeric probes: sampling yields plain string. A botched
    // prefix match would force number(+alignRight)/string-families instead.
    const cols = inferColumns(["x", "y", "z"], [[null, "abc", "abc"]], {
      x: "numericonly",
      y: "varcharx",
      z: "junk numeric",
    });
    expect(cols[0]).toEqual({ field: "x", headerName: "x", kind: "string" });
    expect(cols[0]?.alignRight).toBeUndefined();
    expect(cols[1]).toEqual({ field: "y", headerName: "y", kind: "string" });
    expect(cols[1]?.alignRight).toBeUndefined();
    expect(cols[2]).toEqual({ field: "z", headerName: "z", kind: "string" });
    expect(cols[2]?.alignRight).toBeUndefined();
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

// =============================================================================
// 11. hidden columns excluded from export TSV/CSV
// =============================================================================
// The host may mark columns as hidden (spec.hidden → hiddenColumns) — e.g. a
// user or host explicitly suppressing an internal column from exports. Hidden
// columns MUST NOT leak into user-facing exports (TSV, CSV); the grid also
// hides them visually (webview concern).

describe("hidden columns excluded from export (TASK-006 #5)", () => {
  it("serializeTsv with hiddenColumns: ['ctid'] → header + rows omit ctid", () => {
    const columns = ["name", "created_at", "ctid"];
    const rows: unknown[][] = [
      ["alice", "2024-01-01T00:00:00.000Z", "(0,1)"],
      ["bob", "2024-02-02T00:00:00.000Z", "(0,2)"],
    ];
    const out = serializeTsv(columns, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
      hiddenColumns: ["ctid"],
    });
    const lines = out.split("\n");
    // Header has only name + created_at — no ctid column.
    expect(lines[0]).toBe("name\tcreated_at");
    // Data rows have 2 cells (no trailing tab with "(0,1)").
    expect(lines[1]).toBe("alice\t2024-01-01T00:00:00.000Z");
    expect(lines[2]).toBe("bob\t2024-02-02T00:00:00.000Z");
    // The ctid value never appears anywhere in the output.
    expect(out).not.toContain("(0,1)");
    expect(out).not.toContain("(0,2)");
    expect(out).not.toMatch(/\bctid\b/);
  });

  it("serializeCsv with hiddenColumns: ['ctid'] → header + rows omit ctid (RFC4180)", () => {
    const columns = ["name", "ctid"];
    const rows: unknown[][] = [
      ["alice", "(0,1)"],
      ["bob, with comma", "(0,2)"],
    ];
    const out = serializeCsv(columns, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
      hiddenColumns: ["ctid"],
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("name");
    expect(lines[1]).toBe("alice");
    // RFC4180 still applies for the visible columns.
    expect(lines[2]).toBe('"bob, with comma"');
    // ctid value never appears.
    expect(out).not.toContain("(0,1)");
    expect(out).not.toContain("(0,2)");
    expect(out).not.toMatch(/\bctid\b/);
  });

  it("hiddenColumns: undefined → behaves as before (no columns hidden)", () => {
    const columns = ["name", "ctid"];
    const rows: unknown[][] = [["alice", "(0,1)"]];
    const out = serializeTsv(columns, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    expect(out).toBe("name\tctid\nalice\t(0,1)");
  });

  it("hiddenColumns: [] → behaves as before (no columns hidden)", () => {
    const columns = ["name", "ctid"];
    const rows: unknown[][] = [["alice", "(0,1)"]];
    const out = serializeTsv(columns, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
      hiddenColumns: [],
    });
    expect(out).toBe("name\tctid\nalice\t(0,1)");
  });
});
