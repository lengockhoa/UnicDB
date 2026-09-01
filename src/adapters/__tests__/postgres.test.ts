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

// =============================================================================
// TASK-RLX-001 fix round 1 — Finding B (review, blocking): the adapter-wide
// scalar `activeNonCursorPid` is overwritten by concurrent runQuery() calls
// and unconditionally cleared by each call's finally, so (1) a concurrent
// direct run (e.g. the grant wizard at src/extension.ts:770, or background
// metadata traffic) makes the runner's query un-cancellable, and (2) the
// earlier call's finally closes the PID window while the later call is still
// in flight (cancel becomes a no-op against a live backend).
//
// These overlap tests use TWO mock pool clients with distinct processIDs
// (11 and 22) checked out concurrently through the non-cursor branch
// (multi-statement scripts), with per-client deferred gates so each run can
// settle independently while the other is still in flight.
// =============================================================================
describe("PostgresAdapter — cancelActiveQuery overlap race (TASK-RLX-001 fix round 1)", () => {
  /**
   * A checked-out pool client whose FIRST statement hangs on a deferred gate
   * — the run stays in flight (client checked out, PID window open) until
   * the test releases the gate. Same trick as wirePoolClient above, but one
   * independent client per call so two runs can overlap.
   */
  function hangableClient(pid: number) {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let statements = 0;
    const client: FakeClient = {
      query: vi.fn(() => {
        statements += 1;
        if (statements === 1) return firstGate.then(() => popNext());
        return popNext();
      }),
      release: vi.fn(),
      processID: pid,
    };
    return { client, releaseFirst };
  }

  function dedicatedClientForOverlap() {
    return {
      connect: vi.fn(() => Promise.resolve()),
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      end: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    };
  }

  /**
   * Rewire the (module-scoped singleton) fake pool so run-time connect()
   * hands out client A first, then client B, and a fresh fallback client
   * after that. Must be called AFTER `adapter.connect()` — connect()'s probe
   * runs on the original pool.connect mock, so the handout queue is never
   * consumed by the probe and each test is self-sufficient (works under
   * `vitest -t` filtering too).
   */
  function wireTwoClients(a: FakeClient, b: FakeClient): FakePool {
    const pool = lastPool();
    const handouts: FakeClient[] = [a, b];
    pool.connect = vi.fn((): Promise<FakeClient> => {
      const next = handouts.shift();
      if (next) return Promise.resolve(next);
      return Promise.resolve({
        query: vi.fn(() => popNext()),
        release: vi.fn(),
      });
    });
    return pool;
  }

  it("Test O1 — earlier run settling must NOT clear the later run's PID window; cancel targets the survivor", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] }); // A statement #1 (released by gate)
    queue.push({ rows: [] }); // A statement #2
    queue.push({ rows: [] }); // B statement #1
    queue.push({ rows: [] }); // B statement #2
    const dedicated = dedicatedClientForOverlap();
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const a = hangableClient(11);
    const b = hangableClient(22);
    const pool = wireTwoClients(a.client, b.client);
    clientCtor().mockImplementation(() => dedicated);

    // A (pid 11) checks out first, then B (pid 22) — both in flight.
    const runA = adapter.runQuery("SELECT 1; SELECT 2");
    const runB = adapter.runQuery("SELECT 3; SELECT 4");
    await new Promise((r) => setTimeout(r, 5));
    expect(a.client.query).toHaveBeenCalledTimes(1);
    expect(b.client.query).toHaveBeenCalledTimes(1);

    // A settles FIRST while B is still in flight. A's cleanup must not close
    // B's PID window.
    a.releaseFirst();
    await runA;
    expect(a.client.release).toHaveBeenCalledTimes(1);
    expect(b.client.release).not.toHaveBeenCalled(); // B still checked out

    // Cancel must reach the SURVIVOR (pid 22) via the DEDICATED client.
    const poolEndCallsBefore = pool.end.mock.calls.length;
    await adapter.cancelActiveQuery!();
    expect(dedicated.connect).toHaveBeenCalledTimes(1);
    expect(dedicated.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dedicated.query.mock.calls[0] as [string, number[]];
    expect(sql).toMatch(/pg_cancel_backend/i);
    expect(params).toEqual([22]);
    expect(dedicated.end).toHaveBeenCalledTimes(1);
    expect(pool.end.mock.calls.length).toBe(poolEndCallsBefore);
    expect(b.client.release).not.toHaveBeenCalled();

    // Drain B — release stays exactly-once per client.
    b.releaseFirst();
    await runB;
    expect(b.client.release).toHaveBeenCalledTimes(1);

    await adapter.close();
  });

  it("Test O2 — drain: once every overlapping run has settled, cancelActiveQuery is a no-op (no dedicated client)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] }); // A statement #1
    queue.push({ rows: [] }); // A statement #2
    queue.push({ rows: [] }); // B statement #1
    queue.push({ rows: [] }); // B statement #2
    const dedicated = dedicatedClientForOverlap();
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const a = hangableClient(11);
    const b = hangableClient(22);
    wireTwoClients(a.client, b.client);
    clientCtor().mockImplementation(() => dedicated);

    const runA = adapter.runQuery("SELECT 1; SELECT 2");
    const runB = adapter.runQuery("SELECT 3; SELECT 4");
    await new Promise((r) => setTimeout(r, 5));

    // Both runs settle → the tracked-PID state must be fully empty.
    a.releaseFirst();
    await runA;
    b.releaseFirst();
    await runB;
    expect(a.client.release).toHaveBeenCalledTimes(1);
    expect(b.client.release).toHaveBeenCalledTimes(1);

    const ctorCallsBefore = clientCtor().mock.calls.length;
    await adapter.cancelActiveQuery!();
    expect(clientCtor().mock.calls.length).toBe(ctorCallsBefore);
    expect(dedicated.connect).not.toHaveBeenCalled();
    expect(dedicated.query).not.toHaveBeenCalled();

    await adapter.close();
  });

  it("Test O3 — window correctness: cancel while BOTH runs are in flight targets BOTH pids via ONE dedicated client, never the pool", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] }); // A statement #1
    queue.push({ rows: [] }); // A statement #2
    queue.push({ rows: [] }); // B statement #1
    queue.push({ rows: [] }); // B statement #2
    const dedicated = dedicatedClientForOverlap();
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const a = hangableClient(11);
    const b = hangableClient(22);
    const pool = wireTwoClients(a.client, b.client);
    clientCtor().mockImplementation(() => dedicated);

    const runA = adapter.runQuery("SELECT 1; SELECT 2");
    const runB = adapter.runQuery("SELECT 3; SELECT 4");
    await new Promise((r) => setTimeout(r, 5));
    expect(a.client.query).toHaveBeenCalledTimes(1);
    expect(b.client.query).toHaveBeenCalledTimes(1);

    const poolEndCallsBefore = pool.end.mock.calls.length;
    await adapter.cancelActiveQuery!();
    // ONE dedicated client; a pg_cancel_backend for EACH tracked backend.
    expect(dedicated.connect).toHaveBeenCalledTimes(1);
    expect(dedicated.query).toHaveBeenCalledTimes(2);
    const pids = dedicated.query.mock.calls
      .map((c) => (c as unknown as [string, number[]])[1][0])
      .sort((x, y) => x - y);
    expect(pids).toEqual([11, 22]);
    expect(dedicated.end).toHaveBeenCalledTimes(1);
    expect(pool.end.mock.calls.length).toBe(poolEndCallsBefore);
    // Cancelling must not release either checked-out client.
    expect(a.client.release).not.toHaveBeenCalled();
    expect(b.client.release).not.toHaveBeenCalled();

    // Drain both — release exactly once each.
    a.releaseFirst();
    b.releaseFirst();
    await Promise.all([runA, runB]);
    expect(a.client.release).toHaveBeenCalledTimes(1);
    expect(b.client.release).toHaveBeenCalledTimes(1);

    await adapter.close();
  });
});

// =============================================================================
// TASK-ARP05-001 — ARP-05.1 pool isolation, failed-connect release, close
// recovery, dedicated-client cancel.
//
// Contract under test (ADR 0002 §2 PG column, §5 SLO):
//  - PIN: PG_POOL_MAX = 4 — metadata traffic never queues behind a pinned
//    cursor/transaction client (postgres.ts:291-314); the Pool must be built
//    with max: 4 and the metadata path rides pool.query, not a held client.
//  - GAP (fixed in this task): a failed connect() probe must release cleanly
//    — pool.end() once, this.pool nulled, next connect() builds a fresh pool
//    (mirrors mysql.ts:184-196). Today's connect() leaves the half-open pool.
//  - PIN: close() with an open cursor resolves < 5s — cursor ROLLBACK +
//    release(true) fired, pool.end() raced vs the 3s guard
//    (postgres.ts:323-369).
//  - PIN: cancelActiveQuery() with every pool slot held opens ONE one-off
//    Client (connectionTimeoutMillis: 5_000), issues pg_cancel_backend($1)
//    per tracked PID, end()s it, and never touches the pool
//    (postgres.ts:513-548, ARP-02 semantics).
//  - PIN: idle/no-PID cancel is a silent no-op — no dedicated Client.
// =============================================================================
describe("PostgresAdapter — ARP-05.1 resilience pins (TASK-ARP05-001)", () => {
  it("metadata does not queue behind a pinned cursor/transaction client (PG_POOL_MAX=4, pin)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    // The pool must be built with the documented slot budget (max: 4) —
    // this is the value that guarantees metadata gets its own session.
    const poolCtor = Pool as unknown as { mock: { calls: unknown[][] } };
    const lastCtorCall = poolCtor.mock.calls[poolCtor.mock.calls.length - 1];
    const poolConfig = lastCtorCall[0] as { max?: number };
    expect(poolConfig.max).toBe(4);

    const pool = lastPool();
    // Pin every pool slot the way a held cursor/transaction client would:
    // checked out and never released. The fake connect() keeps succeeding on
    // demand, mirroring pg-pool's on-demand slot opening.
    const held: FakeClient[] = [];
    pool.connect = vi.fn(() =>
      Promise.resolve({
        query: vi.fn(() => popNext()),
        release: vi.fn(),
        processID: 1000 + held.length,
      } as FakeClient),
    );
    for (let i = 0; i < 4; i += 1) {
      held.push(await pool.connect());
    }
    expect(held.length).toBe(4);

    // Metadata rides pool.query on its own slot — it must resolve (never
    // queue into a connectionTimeoutMillis fail) while ALL slots are pinned.
    queue.push({ rows: [{ nspname: "public" }, { nspname: "qas" }] });
    const schemas = await adapter.listSchemas(false);
    expect(schemas.map((s) => s.name)).toEqual(["public", "qas"]);

    await adapter.close();
  });

  it("connect() probe fails → no pool leak: end() once, pool nulled, next connect() builds a fresh pool", async () => {
    const poolCtor = Pool as unknown as { mock: { calls: unknown[][] } };
    // Register the shared mock pool instance up front so lastPool() works
    // even under `vitest -t` filtering of just this case.
    new Pool();
    const sharedPool = lastPool();
    const endCallsBefore = sharedPool.end.mock.calls.length;
    const ctorCallsBefore = poolCtor.mock.calls.length;

    queue.push(new Error("probe: connection refused")); // SELECT 1 probe rejects
    const adapter = new PostgresAdapter(cfg(), "pw");
    await expect(adapter.connect()).rejects.toThrow(
      "probe: connection refused",
    );

    // The half-open pool must have been ended exactly once — no leak.
    expect(sharedPool.end.mock.calls.length).toBe(endCallsBefore + 1);

    // this.pool must be nulled: the next connect() builds a FRESH pool
    // (a second Pool construction), it must not silently reuse the dead one.
    queue.push({ rows: [{ "?column?": 1 }] }); // fresh pool's probe
    await expect(adapter.connect()).resolves.toBeUndefined();
    expect(poolCtor.mock.calls.length).toBe(ctorCallsBefore + 2);

    await adapter.close();
  });

  it("close() with an open cursor resolves < 5s: ROLLBACK + release(true), pool.end() raced vs the 3s guard (pin)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] }); // BEGIN
    queue.push({ rows: [] }); // DECLARE CURSOR
    queue.push({ rows: [] }); // FETCH 0 (column discovery)
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const pool = lastPool();
    // The cursor client stays checked out after runQuery returns (held until
    // close/fetch-eof), so its record is open when close() runs.
    const cursorClient: FakeClient = {
      query: vi.fn(() => popNext()),
      release: vi.fn(),
      processID: 777,
    };
    pool.connect = vi.fn(() => Promise.resolve(cursorClient));

    const batched = await adapter.runQuery("SELECT * FROM big_table");
    expect(batched.batched).toBeDefined();

    // pool.end() hangs forever — only the 3s guard can get close() out.
    const originalEnd = pool.end;
    pool.end = vi.fn(() => new Promise<void>(() => {}));
    try {
      const startedAt = Date.now();
      await expect(adapter.close()).resolves.toBeUndefined();
      const elapsed = Date.now() - startedAt;
      // Every open cursor was ROLLBACKed and force-released…
      expect(cursorClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(cursorClient.release).toHaveBeenCalledWith(true);
      // …and close() beat the hang via the guard: ≥ 3s (the guard fired, not
      // an instant resolve) but < 5s (SLO — close must never hang past 5s).
      expect(elapsed).toBeGreaterThanOrEqual(2_900);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      // Don't leak the hanging end() into later tests sharing this mock.
      pool.end = originalEnd;
    }
  }, 15_000);

  it("cancelActiveQuery uses a dedicated client, never the pool (all slots held) (pin)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    queue.push({ rows: [] }); // pid client statement #1 (released by gate)
    queue.push({ rows: [] }); // pid client statement #2
    const dedicated = {
      connect: vi.fn(() => Promise.resolve()),
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      end: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    };
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    // Route every later `new Client(...)` to the inspectable dedicated client.
    clientCtor().mockImplementation(() => dedicated);

    const pool = lastPool();
    // First rewired connect() hands the run's PID client (first statement
    // hangs → PID window open); every later connect() is a held slot.
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let statements = 0;
    const pidClient: FakeClient = {
      query: vi.fn(() => {
        statements += 1;
        if (statements === 1) return firstGate.then(() => popNext());
        return popNext();
      }),
      release: vi.fn(),
      processID: 4242,
    };
    const heldClients: FakeClient[] = [];
    let pidHandedOut = false;
    pool.connect = vi.fn(() => {
      if (!pidHandedOut) {
        pidHandedOut = true;
        heldClients.push(pidClient);
        return Promise.resolve(pidClient);
      }
      const held: FakeClient = {
        query: vi.fn(() => popNext()),
        release: vi.fn(),
      };
      heldClients.push(held);
      return Promise.resolve(held);
    });

    const runPromise = adapter.runQuery("SELECT 1; SELECT 2");
    await new Promise((r) => setTimeout(r, 5));
    expect(pidClient.query).toHaveBeenCalledTimes(1);
    // Hold every remaining pool slot on top of the pinned run — a cancel that
    // tried to go through the pool would queue behind these.
    for (let i = 0; i < 4; i += 1) await pool.connect();
    expect(heldClients.length).toBe(5); // pid client + 4 held slots

    const poolConnectCalls = pool.connect.mock.calls.length;
    const poolQueryCalls = pool.query.mock.calls.length;
    const poolEndCalls = pool.end.mock.calls.length;
    const clientCtorMock = clientCtor();
    const ctorCallsBefore = clientCtorMock.mock.calls.length;

    await adapter.cancelActiveQuery!();

    // Exactly ONE dedicated one-off Client, with the 5s cancel budget.
    expect(clientCtorMock.mock.calls.length).toBe(ctorCallsBefore + 1);
    const clientConfig = clientCtorMock.mock.calls[ctorCallsBefore][0] as {
      connectionTimeoutMillis?: number;
    };
    expect(clientConfig.connectionTimeoutMillis).toBe(5_000);
    expect(dedicated.connect).toHaveBeenCalledTimes(1);
    expect(dedicated.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dedicated.query.mock.calls[0] as [string, number[]];
    expect(sql).toMatch(/pg_cancel_backend/i);
    expect(params).toEqual([4242]);
    expect(dedicated.end).toHaveBeenCalledTimes(1);
    expect(dedicated.release).not.toHaveBeenCalled();
    // The pool was untouched: no slot request, no pooled query, no end.
    expect(pool.connect.mock.calls.length).toBe(poolConnectCalls);
    expect(pool.query.mock.calls.length).toBe(poolQueryCalls);
    expect(pool.end.mock.calls.length).toBe(poolEndCalls);

    // Drain the run — release stays exactly-once (cancel owns nothing).
    releaseFirst();
    await runPromise;
    expect(pidClient.release).toHaveBeenCalledTimes(1);

    await adapter.close();
  });

  it("idle/no-PID cancel is a no-op: no dedicated client opened, resolves silently (pin)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // connect probe
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const clientCtorMock = clientCtor();
    const ctorCallsBefore = clientCtorMock.mock.calls.length;
    await expect(adapter.cancelActiveQuery!()).resolves.toBeUndefined();
    expect(clientCtorMock.mock.calls.length).toBe(ctorCallsBefore);

    await adapter.close();
  });
});
