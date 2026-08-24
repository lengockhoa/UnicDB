// src/adapters/__tests__/postgres.test.ts
//
// Unit tests cho PostgresAdapter.estimateTableRows (TASK-301).
//
// Pattern: vi.mock("pg") ở top-level (hoisted) — factory chỉ return mock object,
// real pg.Pool không được khởi tạo. Module-scoped mutable state shared với
// factory qua closure — same pattern as src/ui/__tests__/schemaTree.test.ts.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import { Pool } from "pg";
import { PostgresAdapter } from "../postgres";

type QueryResult = { rows: Record<string, unknown>[] };
type QueueItem = QueryResult | Error;

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}
interface FakePool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

// Module-scoped state — referenced by vi.mock factory below (after this file
// is fully evaluated at import time, factory reads these via closure).
const queue: QueueItem[] = [];

function cfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5433,
    user: "vsdb",
    database: "vsdb",
  };
}

function popNext(): Promise<QueryResult> {
  const next = queue.shift();
  if (next === undefined) {
    return Promise.reject(
      new Error("pg mock: queue empty (test misconfigured)"),
    );
  }
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next);
}

vi.mock("pg", () => {
  // One shared client whose .query() pulls next result from `queue`. Each test
  // pushes exactly the responses it expects and clears between cases.
  const fakeClient: FakeClient = {
    query: vi.fn(() => popNext()),
    release: vi.fn(),
  };
  const fakePool: FakePool = {
    query: vi.fn(() => popNext()),
    connect: vi.fn(() => Promise.resolve(fakeClient)),
    end: vi.fn(() => Promise.resolve()),
  };
  const PoolCtor = vi.fn(() => fakePool);
  return { Pool: PoolCtor };
});

beforeEach(() => {
  queue.length = 0;
});

// Helper: peek into the most recently constructed FakePool from the mocked Pool.
function lastPool(): FakePool {
  const ctor = Pool as unknown as { mock: { results: Array<{ value: unknown }> } };
  const value = ctor.mock.results[ctor.mock.results.length - 1]?.value;
  if (!value) throw new Error("Pool mock: no instance recorded");
  return value as FakePool;
}

describe("PostgresAdapter — estimateTableRows (TASK-301)", () => {
  it("happy: reltuples=176 → resolves 176", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe SELECT 1
    queue.push({ rows: [{ row_estimate: "176" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.estimateTableRows("qas", "api_po_log");
    expect(result).toBe(176);
    await adapter.close();
  });

  it("happy: reltuples=1234567 → resolves 1234567", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [{ row_estimate: "1234567" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.estimateTableRows("public", "big_table");
    expect(result).toBe(1234567);
    await adapter.close();
  });

  it("edge: reltuples=-1 (chưa ANALYZE) → resolves null", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [{ row_estimate: "-1" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.estimateTableRows("public", "no_stats");
    expect(result).toBeNull();
    await adapter.close();
  });

  it("edge: 0 row (table không tồn tại / không phải table) → resolves null, không throw", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [] }); // estimateTableRows → 0 rows
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.estimateTableRows("public", "ghost");
    expect(result).toBeNull();
    await adapter.close();
  });

  it("edge: client query reject (connection chết) → resolves null, không throw", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    // Override pool.query to reject on the next call (estimateTableRows uses
    // pool.query through the private this.query helper).
    const pool = lastPool();
    const origQuery = pool.query;
    pool.query = vi.fn(() =>
      Promise.reject(new Error("connection terminated")),
    );
    try {
      const result = await adapter.estimateTableRows("public", "whatever");
      expect(result).toBeNull();
    } finally {
      pool.query = origQuery;
      await adapter.close();
    }
  });

  it("edge: reltuples=0 (table rỗng đã analyze) → resolves 0", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [{ row_estimate: "0" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.estimateTableRows("public", "empty_table");
    expect(result).toBe(0);
    await adapter.close();
  });

// =============================================================================
// TASK-008 — listRoutineParams: parameterized pg_proc introspection via
// $1/$2 bind. Returns { name, dataType } per routine argument; `name` is null
// for unnamed positional args. Empty arrays for no-arg routines.
// =============================================================================
describe("PostgresAdapter — listRoutineParams (TASK-008)", () => {
  it("happy: routine with named params → mapped rows + parameterized bind", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({
      rows: [
        { arg_name: "user_id", format_type: "integer" },
        { arg_name: "amount", format_type: "numeric" },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.listRoutineParams("public", "add_credit");
    expect(result).toEqual([
      { name: "user_id", dataType: "integer" },
      { name: "amount", dataType: "numeric" },
    ]);
    const lastCall = lastPool().query.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    expect(lastCall[0]).toMatch(/proallargtypes\[ord\]/);
    expect(lastCall[1]).toEqual(["public", "add_credit"]);
    await adapter.close();
  });

  it("edge: unnamed positional arg → name: null in mapped row", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [{ arg_name: null, format_type: "integer" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.listRoutineParams("public", "inc");
    expect(result).toEqual([{ name: null, dataType: "integer" }]);
    await adapter.close();
  });

  it("edge: no-arg routine → empty array, no throw", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.listRoutineParams("public", "no_args");
    expect(result).toEqual([]);
    await adapter.close();
  });
});
});
