// src/ai/tools/__tests__/sqlTool.test.ts — TASK-002 TDD
import { describe, it, expect, vi, type Mock } from "vitest";
import type { DbAdapter, BatchedQuery, RunResult, QueryResult } from "../../../adapters/types";
import type { AdapterFactory } from "../types";
import { createSqlTool, isReadOnlySql } from "../sqlTool";

// ---- fake adapters ---------------------------------------------------------

interface CursorOpts {
  columns?: string[];
  rows?: unknown[][];
  throwOn?: "fetchBatch";
  batchSize?: number;
  emptyResults?: boolean;
}

interface CursorFakes {
  adapter: DbAdapter;
  fetchBatch: Mock<[], Promise<unknown[][] | null>>;
  close: Mock<[], Promise<void>>;
  runQuery: Mock<[string], Promise<RunResult>>;
}

function makeCursorAdapter(opts: CursorOpts = {}): CursorFakes {
  const cols = opts.columns ?? ["id", "name"];
  const allRows = opts.rows ?? [
    [1, "a"],
    [2, "b"],
  ];
  const throwOn = opts.throwOn;
  const emptyResults = opts.emptyResults ?? true;

  const fetchBatch = vi.fn(async (): Promise<unknown[][] | null> => {
    if (throwOn === "fetchBatch") throw new Error("boom-fetch");
    return allRows;
  });
  const close = vi.fn(async () => undefined);
  const cursor: BatchedQuery = {
    columns: cols,
    fetchBatch: fetchBatch as BatchedQuery["fetchBatch"],
    cancel: vi.fn(async () => undefined),
    close: close as BatchedQuery["close"],
  };
  const runQuery = vi.fn(async (_sql: string): Promise<RunResult> => {
    if (emptyResults) {
      return { results: [], batched: cursor };
    }
    const fallback: QueryResult = {
      columns: cols,
      rows: allRows,
      rowCount: allRows.length,
      durationMs: 1,
    };
    return { results: [fallback] };
  });

  const adapter: DbAdapter = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    runQuery: runQuery as DbAdapter["runQuery"],
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    estimateTableRows: vi.fn(async () => null),
    listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
    testConnection: vi.fn(async () => undefined),
  };
  return { adapter, fetchBatch, close, runQuery };
}

function makeFactory(adapter: DbAdapter | null): AdapterFactory {
  return vi.fn(async () => adapter);
}

// ---- isReadOnlySql ---------------------------------------------------------

describe("isReadOnlySql", () => {
  it("accepts plain SELECT", () => {
    expect(isReadOnlySql("SELECT * FROM users")).toEqual({ ok: true });
  });

  it("rejects DML: INSERT/UPDATE/DELETE/DROP/TRUNCATE", () => {
    expect(isReadOnlySql("INSERT INTO t VALUES (1)")).toEqual({
      ok: false,
      reason: "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    });
    expect(isReadOnlySql("UPDATE t SET a=1")).toEqual({
      ok: false,
      reason: "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    });
    expect(isReadOnlySql("DELETE FROM t")).toEqual({
      ok: false,
      reason: "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    });
    expect(isReadOnlySql("DROP TABLE t")).toEqual({
      ok: false,
      reason: "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    });
    expect(isReadOnlySql("TRUNCATE t")).toEqual({
      ok: false,
      reason: "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)",
    });
  });

  it("rejects multi-statement", () => {
    const r = isReadOnlySql("SELECT 1; DROP TABLE x");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Multiple statements are not allowed");
  });

  it("rejects SELECT INTO unconditionally", () => {
    const r = isReadOnlySql("SELECT * INTO t2 FROM t");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Read-only violation: INTO");
  });

  it("rejects writable CTE (WITH … INSERT …)", () => {
    const sql = "WITH x AS (INSERT INTO a VALUES(1) RETURNING *) SELECT * FROM x";
    const r = isReadOnlySql(sql);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Read-only violation: writable CTE (INSERT/UPDATE/DELETE/MERGE)");
  });

  it("strips leading -- line comment before checking", () => {
    const sql = "-- comment\nSELECT * FROM t";
    expect(isReadOnlySql(sql)).toEqual({ ok: true });
  });
});

// ---- createSqlTool --------------------------------------------------------

describe("createSqlTool — run_sql", () => {
  it("uses cursor flow: fetchBatch(50) + close() and JSON-shapes result", async () => {
    const { adapter, fetchBatch, close, runQuery } = makeCursorAdapter({
      columns: ["id", "name"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      emptyResults: true,
    });
    const tool = createSqlTool(makeFactory(adapter));
    expect(tool.name).toBe("run_sql");
    const out = await tool.execute({ sql: "SELECT * FROM users" });
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(fetchBatch).toHaveBeenCalledWith();
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out)).toEqual({
      columns: ["id", "name"],
      rows: [
        [1, "a"],
        [2, "b"],
      ],
      rowCount: 2,
      truncated: false,
    });
  });

  it("falls back to run.results when cursor is absent", async () => {
    const cols = ["x"];
    const rows: unknown[][] = [[42]];
    const adapter: DbAdapter = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      runQuery: vi.fn(async () => ({
        results: [{ columns: cols, rows, rowCount: 1, durationMs: 1 }],
      })),
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      estimateTableRows: vi.fn(async () => null),
      listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
      testConnection: vi.fn(async () => undefined),
    };
    const tool = createSqlTool(makeFactory(adapter));
    const out = await tool.execute({ sql: "SELECT x FROM t" });
    expect(JSON.parse(out)).toEqual({
      columns: ["x"],
      rows: [[42]],
      rowCount: 1,
      truncated: false,
    });
  });

  it("truncates results to 50 rows with truncated:true", async () => {
    const big: unknown[][] = [];
    for (let i = 0; i < 120; i++) big.push([i]);
    const { adapter } = makeCursorAdapter({
      columns: ["n"],
      rows: big,
      emptyResults: true,
    });
    const tool = createSqlTool(makeFactory(adapter));
    const out = await tool.execute({ sql: "SELECT n FROM t" });
    const parsed = JSON.parse(out);
    expect(parsed.rows).toHaveLength(50);
    expect(parsed.truncated).toBe(true);
    expect(parsed.rowCount).toBe(120);
  });

  it("rejects DML with the read-only reason", async () => {
    const { adapter } = makeCursorAdapter();
    const tool = createSqlTool(makeFactory(adapter));
    const out = await tool.execute({ sql: "DROP TABLE users" });
    expect(out).toBe("Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)");
  });

  it("returns no-connection message when factory resolves null", async () => {
    const tool = createSqlTool(makeFactory(null));
    const out = await tool.execute({ sql: "SELECT 1" });
    expect(out).toBe("No active database connection.");
  });

  it("wraps adapter.runQuery throw as 'Tool failed: <msg>'", async () => {
    const adapter: DbAdapter = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      runQuery: vi.fn(async () => {
        throw new Error("syntax error at end");
      }),
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      estimateTableRows: vi.fn(async () => null),
      listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
      testConnection: vi.fn(async () => undefined),
    };
    const tool = createSqlTool(makeFactory(adapter));
    const out = await tool.execute({ sql: "SELECT 1" });
    expect(out).toBe("Tool failed: syntax error at end");
  });

  it("still calls cursor.close() when fetchBatch throws", async () => {
    const { adapter, close } = makeCursorAdapter({
      throwOn: "fetchBatch",
      columns: ["id"],
      rows: [],
      emptyResults: true,
    });
    const tool = createSqlTool(makeFactory(adapter));
    const out = await tool.execute({ sql: "SELECT id FROM t" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(out).toBe("Tool failed: boom-fetch");
  });
});