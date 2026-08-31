// src/adapters/__tests__/postgres.test.ts
//
// Unit tests cho PostgresAdapter.estimateTableRows (TASK-301).
//
// Pattern: vi.mock("pg") ở top-level (hoisted) — factory chỉ return mock object,
// real pg.Pool không được khởi tạo. Module-scoped mutable state shared với
// factory qua closure — same pattern as src/ui/__tests__/schemaTree.test.ts.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import { Client, Pool } from "pg";
import { PostgresAdapter } from "../postgres";

type QueryResult = { rows: Record<string, unknown>[]; fields?: unknown[] };
type QueueItem = QueryResult | Error;

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  end?: ReturnType<typeof vi.fn>;
  connect?: ReturnType<typeof vi.fn>;
  processID?: number;
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
  // runQuery() reads `result.fields` (pg Result shape); metadata paths only
  // read `rows`. Default an empty fields array when a test only seeded rows.
  return Promise.resolve({ fields: [], ...next });
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
  // ClientCtor is referenced via the `Client` import below; its return value
  // can be swapped per test by reassigning ClientCtor.mockImplementation.
  // The adapter's cancelActiveQuery() path uses `new Client(...)` to open
  // a dedicated one-off connection for pg_cancel_backend, so the constructor
  // must be a vi.fn we can inspect and override in tests.
  const ClientCtor = vi.fn();
  ClientCtor.mockImplementation(() => ({
    connect: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve({ rows: [] })),
    end: vi.fn(() => Promise.resolve()),
  }));
  return { Pool: PoolCtor, Client: ClientCtor };
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

// Helper: Client mock constructor — vi.fn we can inspect and override.
type ClientCtor = ReturnType<typeof vi.fn>;
function clientCtor(): ClientCtor {
  return Client as unknown as ClientCtor;
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
    // Regression assertion (CRITICAL): the SQL must fall back to
    // proargtypes when proallargtypes is NULL (ordinary all-IN-arg functions),
    // and must use 1-based ordinality (WITH ORDINALITY) — the previous
    // generate_series(0,…) + proallargtypes-only SQL degraded every routine
    // payload to { schema, table } in production. See Reviewer Verdict.
    expect(lastCall[0]).toMatch(
      /COALESCE\(p\.proallargtypes,\s*p\.proargtypes::oid\[\]\)/,
    );
    expect(lastCall[0]).toMatch(/WITH ORDINALITY/);
    expect(lastCall[0]).not.toMatch(/proallargtypes\[ord\]/);
    expect(lastCall[0]).not.toMatch(/generate_series/);
    await adapter.close();
  });

  it("edge: INOUT arg (proallargtypes populated, proargnames shorter) → correct ordering via WITH ORDINALITY", async () => {
    // Regression for the second defect flagged in Reviewer Verdict:
    // generate_series(0,…) was 0-based while proargnames[] is 1-based,
    // so even when proallargtypes WAS populated rows were misaligned.
    // The fixed SQL uses WITH ORDINALITY (1-based).
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        // Mixed IN + INOUT shapes; ordinality-driven subscripts yield the
        // first element from each unnested array in declaration order.
        { arg_name: "a", format_type: "integer" },
        { arg_name: "b", format_type: "text" },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.listRoutineParams("public", "mixed");
    expect(result).toEqual([
      { name: "a", dataType: "integer" },
      { name: "b", dataType: "text" },
    ]);
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

// =============================================================================
// TASK-005 D4 — listColumns pg_catalog rewrite shape parity. Full end-to-end
// (through the real pg mock, not a monkeypatched private query()) — proves
// the rewritten SQL still round-trips through pool.query(sql, params) and
// produces the identical ColumnInfo[] shape (names, types, nullability, PK
// flags) that the pre-rewrite information_schema-joined query produced.
// =============================================================================
describe("PostgresAdapter — listColumns shape parity (TASK-005 D4)", () => {
  it("happy: columns + PK flags → same ColumnInfo[] shape as before the rewrite", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({
      rows: [
        { column_name: "id", format_type: "bigint", is_nullable: "NO" },
        { column_name: "email", format_type: "text", is_nullable: "NO" },
        { column_name: "bio", format_type: "text", is_nullable: "YES" },
      ],
    });
    queue.push({ rows: [{ column_name: "id" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.listColumns("users", "public");
    expect(result).toEqual([
      { name: "id", dataType: "bigint", nullable: false, isPrimaryKey: true },
      { name: "email", dataType: "text", nullable: false },
      { name: "bio", dataType: "text", nullable: true },
    ]);
    await adapter.close();
  });

  it("edge: no primary key → no column carries isPrimaryKey", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [{ column_name: "note", format_type: "text", is_nullable: "YES" }],
    });
    queue.push({ rows: [] }); // no PK rows
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.listColumns("logs", "public");
    expect(result).toEqual([{ name: "note", dataType: "text", nullable: true }]);
    await adapter.close();
  });
});

// =============================================================================
// TASK-RLX-001 — cancel active non-cursor query.
//
// Contract:
//  - PostgresAdapter tracks the active non-cursor backend PID only while
//    runQuery()'s client is checked out.
//  - cancelActiveQuery() issues pg_cancel_backend through the existing
//    DEDICATED one-off Client and never closes the shared pool/adapter.
//  - Tracking is cleared on success / error / cancellation; the checked-out
//    client is released exactly once (release stays runQuery's job).
//  - Dedicated-client cancel failure is swallowed as best effort.
//  - A LATE cancelActiveQuery() (after the run settled) is a no-op: no
//    dedicated Client is constructed, no query is issued.
// =============================================================================
describe("PostgresAdapter — cancelActiveQuery (TASK-RLX-001)", () => {
  /**
   * The multi-statement (non-cursor) runQuery branch checks out ONE pool
   * client for the whole run. Give the fake pool a per-test client exposing
   * `processID` so the adapter can record the backend PID, and rewire the
   * pg.Client constructor so cancelActiveQuery() gets our inspectable
   * dedicated client.
   *
   * `hangFirst` makes the checked-out client's FIRST statement hang on a
   * deferred promise — that keeps the client checked out (PID window open)
   * while the test calls cancelActiveQuery() mid-flight.
   */
  function wirePoolClient(
    pid: number,
    dedicated: FakeClient,
    hangFirst = false,
  ) {
    const pool = lastPool();
    let releaseFirst!: (r?: unknown) => void;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let statements = 0;
    const checkedOut: FakeClient = {
      query: hangFirst
        ? vi.fn(() => {
            statements += 1;
            // First statement hangs on the gate, then consumes its queued
            // result (the gate itself resolves empty).
            if (statements === 1) return firstGate.then(() => popNext());
            return popNext();
          })
        : vi.fn(() => popNext()),
      release: vi.fn(),
      processID: pid,
    };
    pool.connect = vi.fn(() => Promise.resolve(checkedOut));
    clientCtor().mockImplementation(() => dedicated);
    return { pool, checkedOut, releaseFirst };
  }

  function dedicatedClientWith(
    impl: Partial<FakeClient>,
  ): FakeClient & {
    connect: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  } {
    return {
      connect: vi.fn(() => Promise.resolve()),
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      end: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
      ...impl,
    };
  }

  it("Test #4a — happy: cancelActiveQuery mid-flight targets the active PID via dedicated Client, releases once", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] }); // statement #1 result (released by the gate)
    queue.push({ rows: [] }); // statement #2 result
    const dedicated = dedicatedClientWith({});
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const { pool, checkedOut, releaseFirst } = wirePoolClient(42, dedicated, true);

    // Multi-statement script → non-cursor branch → client checked out and
    // first statement hanging → PID window OPEN.
    const runPromise = adapter.runQuery("SELECT 1; SELECT 2");
    await new Promise((r) => setTimeout(r, 5));
    expect(checkedOut.query).toHaveBeenCalledTimes(1);

    // Pool.end is a module-scoped shared mock (earlier tests' close() calls
    // it), so compare counts before/after instead of expecting zero.
    const poolEndCallsBefore = pool.end.mock.calls.length;

    // Cancel mid-flight — seam must use the DEDICATED client.
    await adapter.cancelActiveQuery!();
    expect(dedicated.connect).toHaveBeenCalledTimes(1);
    expect(dedicated.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dedicated.query.mock.calls[0] as [string, number[]];
    expect(sql).toMatch(/pg_cancel_backend/i);
    expect(params).toEqual([42]);
    // Dedicated client is a one-off: ended, never pool-released.
    expect(dedicated.end).toHaveBeenCalledTimes(1);
    expect(dedicated.release).not.toHaveBeenCalled();
    // The seam must NOT release the checked-out client (runQuery owns it)
    // and must NOT close the shared pool.
    expect(checkedOut.release).not.toHaveBeenCalled();
    expect(pool.end.mock.calls.length).toBe(poolEndCallsBefore);

    // Let the run settle; release stays exactly-once.
    releaseFirst();
    await runPromise;
    expect(checkedOut.release).toHaveBeenCalledTimes(1);
    expect(pool.end.mock.calls.length).toBe(poolEndCallsBefore);

    await adapter.close();
  });

  it("Test #4b — edge: dedicated cancel failure is swallowed; checked-out client still releases exactly once", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] });
    queue.push({ rows: [] });
    const dedicated = dedicatedClientWith({
      query: vi.fn(() => Promise.reject(new Error("dedicated cancel failed"))),
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const { pool, checkedOut, releaseFirst } = wirePoolClient(99, dedicated, true);

    const runPromise = adapter.runQuery("SELECT 1; SELECT 2");
    await new Promise((r) => setTimeout(r, 5));

    // Dedicated cancel throws — best effort, must not reject.
    await expect(adapter.cancelActiveQuery!()).resolves.toBeUndefined();
    expect(dedicated.query).toHaveBeenCalledTimes(1);
    expect(checkedOut.release).not.toHaveBeenCalled();

    // The query still terminates normally and releases exactly once; the
    // shared pool is untouched (pool.end count unchanged).
    const poolEndCallsBefore = pool.end.mock.calls.length;
    releaseFirst();
    await runPromise;
    expect(checkedOut.release).toHaveBeenCalledTimes(1);
    expect(pool.end.mock.calls.length).toBe(poolEndCallsBefore);

    await adapter.close();
  });

  it("Test #4c — edge: PID tracking cleared after run; late cancelActiveQuery is a no-op", async () => {
    // After runQuery() settles, the recorded PID window is closed: a later
    // cancelActiveQuery() must NOT construct a dedicated Client or issue
    // any query — it must never target a later query.
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] });
    queue.push({ rows: [] });
    const dedicated = dedicatedClientWith({});
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const { checkedOut } = wirePoolClient(1234, dedicated);

    await adapter.runQuery("SELECT 1; SELECT 2");
    expect(checkedOut.release).toHaveBeenCalledTimes(1);

    const ctorCallsBefore = clientCtor().mock.calls.length;
    await adapter.cancelActiveQuery!();
    const ctorCallsAfter = clientCtor().mock.calls.length;
    expect(ctorCallsAfter).toBe(ctorCallsBefore);
    expect(dedicated.query).not.toHaveBeenCalled();
    expect(dedicated.connect).not.toHaveBeenCalled();

    await adapter.close();
  });
});
});
