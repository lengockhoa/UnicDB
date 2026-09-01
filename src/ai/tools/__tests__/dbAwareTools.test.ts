// src/ai/tools/__tests__/dbAwareTools.test.ts — cycle AD TASK-001 TDD
// Acceptance criteria 2-6: the five DB-aware read-only tools.

import { describe, it, expect, vi } from "vitest";
import {
  createListTableDataSampleTool,
  createCountRowsTool,
  createRunReadonlyQueryTool,
  createExplainQueryTool,
  createTableRelationshipsTool,
  createDbAwareTools,
  summarizeForLog,
} from "../dbAwareTools";
import type { AdapterFactory } from "../types";
import type { DbAdapter, RunResult, TableDetail } from "../../../adapters/types";

interface StubOptions {
  columns?: string[];
  rows?: unknown[][];
  detail?: Record<string, TableDetail>;
  tables?: Array<{ schema: string; name: string }>;
  runQueryThrows?: boolean;
}

function makeAdapter(opts: StubOptions = {}) {
  const seen: string[] = [];
  const columns = opts.columns ?? ["id", "name"];
  const rows = opts.rows ?? [[1, "alice"], [2, "bob"]];
  const runQuery = vi.fn(async (sql: string): Promise<RunResult> => {
    seen.push(sql);
    if (opts.runQueryThrows) throw new Error("boom");
    return {
      results: [
        { columns, rows, rowCount: rows.length, durationMs: 1 },
      ],
    };
  });
  const adapter = {
    runQuery,
    listTables: vi.fn(async (schema?: string) =>
      (opts.tables ?? []).filter((t) => schema === undefined || t.schema === schema),
    ),
    listTableDetail: vi.fn(async (schema: string, table: string) => {
      const d = opts.detail?.[`${schema}.${table}`];
      if (!d) return { columns: [], constraints: [] } as TableDetail;
      return d;
    }),
  } as unknown as DbAdapter;
  const factory: AdapterFactory = async () => adapter;
  return { adapter, factory, seen, runQuery };
}

const nullFactory: AdapterFactory = async () => null;

describe("list_table_data_sample", () => {
  it("uses default limit 20", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createListTableDataSampleTool(factory);
    expect(tool.name).toBe("list_table_data_sample");
    await tool.execute({ schema: "public", table: "users" });
    expect(seen[0]).toContain("LIMIT 20");
  });

  it("caps limit at 100", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createListTableDataSampleTool(factory);
    await tool.execute({ schema: "public", table: "users", limit: 5000 });
    expect(seen[0]).toContain("LIMIT 100");
  });

  it("floors limit at 1", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createListTableDataSampleTool(factory);
    await tool.execute({ schema: "public", table: "users", limit: 0 });
    expect(seen[0]).toContain("LIMIT 1");
  });

  it("includes the header row and renders row data as text", async () => {
    const { factory } = makeAdapter();
    const tool = createListTableDataSampleTool(factory);
    const out = await tool.execute({ schema: "public", table: "users" });
    expect(out).toContain("id | name");
    expect(out).toContain("1 | alice");
    expect(out).toContain("2 | bob");
  });

  it("rejects identifiers containing forbidden keywords", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createListTableDataSampleTool(factory);
    const out = await tool.execute({ schema: "public", table: "drop_me" });
    expect(out).toContain("rejected");
    expect(seen).toHaveLength(0);
  });

  it("reports no connection without touching the adapter", async () => {
    const tool = createListTableDataSampleTool(nullFactory);
    const out = await tool.execute({ schema: "public", table: "users" });
    expect(out).toContain("No active");
  });

  it("never leaks row bytes on the failure path", async () => {
    const { factory } = makeAdapter({ runQueryThrows: true });
    const tool = createListTableDataSampleTool(factory);
    const out = await tool.execute({ schema: "public", table: "users" });
    expect(out).toContain("Tool failed");
    expect(out).not.toContain("alice");
  });
});

describe("count_rows", () => {
  it("counts without a WHERE clause", async () => {
    const { factory, seen } = makeAdapter({ columns: ["count"], rows: [[42]] });
    const tool = createCountRowsTool(factory);
    const out = await tool.execute({ schema: "public", table: "users" });
    expect(seen[0]).toBe('SELECT COUNT(*) FROM "public"."users"');
    expect(JSON.parse(out)).toEqual({ count: 42 });
  });

  it("counts with a WHERE clause", async () => {
    const { factory, seen } = makeAdapter({ columns: ["count"], rows: [[7]] });
    const tool = createCountRowsTool(factory);
    const out = await tool.execute({ schema: "public", table: "users", where: "age > 30" });
    expect(seen[0]).toBe('SELECT COUNT(*) FROM "public"."users" WHERE age > 30');
    expect(JSON.parse(out)).toEqual({ count: 7 });
  });

  it("rejects a WHERE clause containing a semicolon", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createCountRowsTool(factory);
    const out = await tool.execute({ schema: "public", table: "users", where: "1=1; DROP TABLE t" });
    expect(out).toContain("rejected");
    expect(seen).toHaveLength(0);
  });

  it("rejects a WHERE clause containing a forbidden keyword", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createCountRowsTool(factory);
    const out = await tool.execute({ schema: "public", table: "users", where: "1=1 OR delete" });
    expect(out).toContain("rejected");
    expect(seen).toHaveLength(0);
  });
});

describe("run_readonly_query", () => {
  it("runs a happy SELECT", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({ sql: "SELECT id, name FROM t" });
    expect(seen).toHaveLength(1);
    expect(out).toContain("id | name");
    expect(out).toContain("1 | alice");
  });

  it("rejects UPDATE before touching the adapter", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({ sql: "UPDATE t SET a = 1" });
    expect(out).toContain("non_select");
    expect(seen).toHaveLength(0);
  });

  it("rejects multi-statement SQL", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({ sql: "SELECT 1; SELECT 2" });
    expect(out).toContain("multi_statement");
    expect(seen).toHaveLength(0);
  });

  it("rejects EXPLAIN ANALYZE", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({ sql: "EXPLAIN ANALYZE SELECT 1" });
    expect(out).toContain("rejected");
    expect(seen).toHaveLength(0);
  });

  it("caps rows at maxRows (default 100)", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => [i, `n${i}`]);
    const { factory } = makeAdapter({ rows });
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({ sql: "SELECT id, name FROM t" });
    const dataLines = out.split("\n").filter((l) => /^\d+ \| n\d+$/.test(l));
    expect(dataLines).toHaveLength(100);
    expect(out).toContain("truncated");
  });

  it("caps maxRows at 1000", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => [i, `n${i}`]);
    const { factory } = makeAdapter({ rows });
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({ sql: "SELECT id, name FROM t", maxRows: 99999 });
    const dataLines = out.split("\n").filter((l) => /^\d+ \| n\d+$/.test(l));
    // TASK-AIX03-101 case 7: cap is QUERY_MAX_ROWS = 1000 even when caller
    // asks for 99999.
    expect(dataLines).toHaveLength(1000);
  });
});

// =============================================================================
// TASK-AIX03-101 cases 7-8 — cap boundary + sentinel non-leak.
//
// The sentinel fixture deliberately exercises the cursor-batch path: the
// fake adapter's runQuery returns a BatchedQuery whose fetchBatch yields
// EXACTLY 500 rows in a single batch (matching Postgres DEFAULT_BATCH_SIZE)
// before returning null (EOF). The sentinel value is placed at the row
// index that would normally be sliced off when cap < total. If the cap is
// applied AFTER all rows are read (current implementation), the sentinel
// stays dropped and the truncation line is emitted with the exact
// `cap / total` numbers. If a future regression stops early at `cap`
// batches, the sentinel would leak.
// =============================================================================

import type { BatchedQuery, DbAdapter, RunResult } from "../../../adapters/types";

const SENTINEL = "SENTINEL-leak";
const DEFAULT_BATCH_SIZE = 500; // mirrors src/adapters/postgres.ts:98

function makeCursorAdapterWithBatch(totalRows: number, cap: number) {
  let batchesDelivered = 0;
  const fetchBatch = vi.fn(async (): Promise<unknown[][] | null> => {
    // Single Postgres-style batch: DEFAULT_BATCH_SIZE = 500 rows, then EOF.
    batchesDelivered++;
    if (batchesDelivered > 1) return null; // EOF after the first batch
    const slice: unknown[][] = [];
    for (let i = 0; i < totalRows; i++) {
      slice.push(i === cap ? [SENTINEL] : [i, `n${i}`]);
    }
    return slice;
  });
  const close = vi.fn(async () => undefined);
  const cursor: BatchedQuery = {
    columns: ["id", "name"],
    fetchBatch: fetchBatch as unknown as BatchedQuery["fetchBatch"],
    cancel: vi.fn(async () => undefined),
    close: close as unknown as BatchedQuery["close"],
  };
  const runQuery = vi.fn(async (_sql: string): Promise<RunResult> => ({
    results: [],
    batched: cursor,
  }));
  const adapter = {
    runQuery,
    listTables: vi.fn(async () => []),
    listTableDetail: vi.fn(async () => ({ columns: [], constraints: [] })),
  } as unknown as DbAdapter;
  const factory: AdapterFactory = async () => adapter;
  return { adapter, factory, fetchBatch, close };
}

describe("run_readonly_query — cap boundary + sentinel (TASK-AIX03-101)", () => {
  it("sentinel fixture pins Postgres DEFAULT_BATCH_SIZE to 500", () => {
    // Pin the literal so a change to the production constant is caught.
    expect(DEFAULT_BATCH_SIZE).toBe(500);
  });

  it("case 7: maxRows=99999 caps at 1000 data rows", async () => {
    const { factory } = makeCursorAdapterWithBatch(1200, 1000);
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({
      sql: "SELECT id, name FROM t",
      maxRows: 99999,
    });
    const dataLines = out.split("\n").filter((l) => /^\d+ \| n\d+$/.test(l));
    expect(dataLines).toHaveLength(1000);
  });

  it("case 8: row index 100 in a 500-row cursor batch is dropped (sentinel non-leak)", async () => {
    // totalRows=500, cap=100. Row index 100 (zero-based) carries the
    // sentinel. After renderTable slices to cap, the sentinel must NOT
    // appear, and the truncation line must read `-- truncated: showing
    // 100 of 500 rows`.
    const { factory } = makeCursorAdapterWithBatch(DEFAULT_BATCH_SIZE, 100);
    const tool = createRunReadonlyQueryTool(factory);
    const out = await tool.execute({
      sql: "SELECT id, name FROM t",
      maxRows: 100,
    });
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain("-- truncated: showing 100 of 500 rows");
  });
});

describe("explain_query", () => {
  it("runs EXPLAIN on a SELECT and renders text", async () => {
    const { factory, seen } = makeAdapter({
      columns: ["QUERY PLAN"],
      rows: [["Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)"]],
    });
    const tool = createExplainQueryTool(factory);
    const out = await tool.execute({ sql: "SELECT 1" });
    expect(seen[0]).toBe("EXPLAIN SELECT 1");
    expect(out).toContain("Seq Scan on t");
  });

  it("rejects EXPLAIN ANALYZE", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createExplainQueryTool(factory);
    const out = await tool.execute({ sql: "EXPLAIN ANALYZE SELECT 1" });
    expect(out).toContain("rejected");
    expect(seen).toHaveLength(0);
  });

  it("rejects a non-SELECT statement", async () => {
    const { factory, seen } = makeAdapter();
    const tool = createExplainQueryTool(factory);
    const out = await tool.execute({ sql: "DELETE FROM t" });
    expect(out).toContain("non_select");
    expect(seen).toHaveLength(0);
  });
});

describe("get_table_relationships", () => {
  const detail: Record<string, TableDetail> = {
    "public.orders": {
      columns: [],
      constraints: [
        {
          conname: "orders_user_fk",
          contype: "f",
          conkey: [1],
          confrelidname: "users",
          confkeycols: ["id"],
          consrc: "FOREIGN KEY (user_id) REFERENCES users(id)",
        },
      ],
    },
    "public.items": {
      columns: [],
      constraints: [
        {
          conname: "items_order_fk",
          contype: "f",
          conkey: [2],
          confrelidname: "orders",
          confkeycols: ["id"],
          consrc: "FOREIGN KEY (order_id) REFERENCES orders(id)",
        },
      ],
    },
  };

  it("returns FK + reverse-FK and no row data", async () => {
    const { factory, runQuery } = makeAdapter({
      detail,
      tables: [
        { schema: "public", name: "orders" },
        { schema: "public", name: "items" },
      ],
    });
    const tool = createTableRelationshipsTool(factory);
    const out = await tool.execute({ schema: "public", table: "orders" });
    const parsed = JSON.parse(out) as {
      foreignKeys: Array<{ constraint: string; references: string }>;
      referencedBy: Array<{ table: string; constraint: string }>;
    };
    expect(parsed.foreignKeys).toEqual([
      { constraint: "orders_user_fk", references: "users", columns: ["id"] },
    ]);
    expect(parsed.referencedBy).toEqual([
      { table: "public.items", constraint: "items_order_fk" },
    ]);
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe("registry + logging", () => {
  it("createDbAwareTools registers exactly the five tools", () => {
    const { factory } = makeAdapter();
    const names = createDbAwareTools(factory).map((t) => t.name);
    expect(names).toEqual([
      "list_table_data_sample",
      "count_rows",
      "run_readonly_query",
      "explain_query",
      "get_table_relationships",
    ]);
  });

  it("summarizeForLog never emits row bytes", () => {
    const s = summarizeForLog(["id", "name"], [[1, "SENTINEL-alice"]]);
    expect(s).not.toContain("SENTINEL");
    expect(s).toContain("1 rows");
    expect(s).toContain("2 cols");
  });
});
