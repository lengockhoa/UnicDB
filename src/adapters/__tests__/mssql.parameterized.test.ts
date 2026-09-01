// src/adapters/__tests__/mssql.parameterized.test.ts
// TASK-002 — MSSQL parameter binding: `execute(sql, params?)` sends typed
// tedious parameters via Request.addParameter, and the metadata queries
// (listTables / listViews / listRoutines / listColumns / estimateTableRows /
// estimateTableRowsBatch) stop interpolating `${this.literal()}` into SQL.
//
// Two lanes, following the existing patterns in schemas.test.ts and
// adapterQueryShape.test.ts:
//  - execute()-level tests wire a fake tedious Connection + mock Request by
//    overriding the adapter's private newRequest() (instance-level shadow —
//    no tedious module mock needed) to assert exactly what is bound via
//    addParameter and sent through execSql.
//  - metadata-query tests mock the adapter's private execute() and assert the
//    SQL shape (@schema/@table placeholders, no quoted literal values) plus
//    the params array passed alongside.
import { describe, expect, it, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { TYPES, Request as TediousRequestCtor } from "tedious";
import type { Request as TediousRequest } from "tedious";
import { MsSqlAdapter } from "../mssql";
import type { ConnectionConfig } from "../../config/types";

function cfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver: "mssql",
    host: "127.0.0.1",
    port: 1433,
    user: "vsdb",
    database: "vsdb",
  };
}

/**
 * Adapter wired with a fake tedious Connection so tests can observe the
 * parameter binding without a real SQL Server. The real `newRequest()`
 * implementation runs (a real tedious Request is created, and the prototype
 * spy on `addParameter` still delegates to tedious's real validation against
 * real TYPES); an instance-level wrapper records each created request. The
 * fake connection settles each request through `request.callback` on a
 * microtask, mirroring how tedious signals request completion.
 */
let addParameterSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  addParameterSpy?.mockRestore();
  addParameterSpy = null;
});

function makeWiredAdapter(): {
  adapter: MsSqlAdapter;
  execSql: ReturnType<typeof vi.fn>;
  requests: TediousRequest[];
} {
  const adapter = new MsSqlAdapter(cfg(), "pw");
  const requests: TediousRequest[] = [];
  addParameterSpy = vi.spyOn(TediousRequestCtor.prototype, "addParameter");
  const originalNewRequest = (
    MsSqlAdapter.prototype as unknown as {
      newRequest: (
        this: MsSqlAdapter,
        sql: string,
        params?: unknown,
      ) => TediousRequest;
    }
  ).newRequest;
  (adapter as unknown as { newRequest: unknown }).newRequest = (
    sql: string,
    params?: unknown,
  ) => {
    const request = originalNewRequest.call(adapter, sql, params);
    requests.push(request);
    return request;
  };
  const execSql = vi.fn((request: TediousRequest) => {
    queueMicrotask(() => {
      (
        request as unknown as {
          callback:
            | ((error: Error | null | undefined, rowCount?: number) => void)
            | null;
        }
      ).callback?.(null, 0);
    });
  });
  (adapter as unknown as { connection: unknown }).connection = { execSql };
  (adapter as unknown as { connected: boolean }).connected = true;
  return { adapter, execSql, requests };
}

/** Call the private execute(sql, params?) with type-safe casting. */
function callExecute(
  adapter: MsSqlAdapter,
  sql: string,
  params?: Array<{ name: string; type: unknown; value: string | null }>,
): Promise<unknown> {
  return (
    adapter as unknown as {
      execute: (
        sql: string,
        params?: Array<{ name: string; type: unknown; value: string | null }>,
      ) => Promise<unknown>;
    }
  ).execute(sql, params);
}

type QueryResultLike = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
};

/** Adapter whose private execute() is a spy returning a canned result. */
function makeAdapterWithExecuteSpy(
  rows: unknown[][] = [],
): { adapter: MsSqlAdapter; execute: ReturnType<typeof vi.fn> } {
  const adapter = new MsSqlAdapter(cfg(), "pw");
  const execute = vi.fn().mockResolvedValue({
    columns: [],
    rows,
    rowCount: rows.length,
    durationMs: 0,
  } satisfies QueryResultLike);
  (adapter as unknown as { execute: unknown }).execute = execute;
  return { adapter, execute };
}

// ---- Test #1: execute() binds typed NVarChar parameters --------------------

describe("MsSqlAdapter.execute(sql, params) — parameter binding (TASK-002)", () => {
  it("#1 execute with params sends NVarChar parameters", async () => {
    const { adapter, execSql, requests } = makeWiredAdapter();

    await callExecute(adapter, "SELECT name FROM t WHERE s = @schema AND n = @name", [
      { name: "schema", type: TYPES.NVarChar, value: "dbo" },
      { name: "name", type: TYPES.NVarChar, value: "users" },
    ]);

    expect(execSql).toHaveBeenCalledTimes(1);
    const addParameter = requests[0].addParameter;
    // One addParameter call per param, each with the tedious NVarChar type.
    expect(addParameter).toHaveBeenCalledTimes(2);
    expect(addParameter).toHaveBeenNthCalledWith(
      1,
      "schema",
      TYPES.NVarChar,
      "dbo",
    );
    expect(addParameter).toHaveBeenNthCalledWith(
      2,
      "name",
      TYPES.NVarChar,
      "users",
    );
  });

  it("#5 edge: execute with empty params array runs SQL without parameters", async () => {
    const { adapter, execSql, requests } = makeWiredAdapter();

    const result = await callExecute(adapter, "SELECT 1 AS one", []);

    expect(execSql).toHaveBeenCalledTimes(1);
    expect(requests[0].addParameter).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rows: [] });
  });

  it("#6 edge: execute with null param value sends the parameter as a typed NULL", async () => {
    const { adapter, requests } = makeWiredAdapter();

    // tedious 18.x has no `TYPES.Null` export — the canonical NULL wire form
    // is the declared type with value null (tedious emits the TDS NULL
    // marker). Assert the null round-trips instead of being stringified into
    // the SQL text.
    await callExecute(adapter, "SELECT 1 WHERE n = @maybe", [
      { name: "maybe", type: TYPES.NVarChar, value: null },
    ]);

    expect(requests[0].addParameter).toHaveBeenCalledTimes(1);
    expect(requests[0].addParameter).toHaveBeenCalledWith(
      "maybe",
      TYPES.NVarChar,
      null,
    );
  });
});

// ---- Test #2/#3: metadata queries are parameterized -------------------------

describe("MsSqlAdapter metadata queries — parameterized SQL (TASK-002)", () => {
  it("#2 listTables uses parameterized query", async () => {
    const { adapter, execute } = makeAdapterWithExecuteSpy([
      ["users", "dbo"],
    ]);

    await adapter.listTables("dbo");

    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain("@schema");
    // No `${this.literal()}` residue: the schema value must NOT be quoted
    // into the SQL text.
    expect(sql).not.toContain("'dbo'");
    expect(sql).not.toMatch(/WHERE s\.name = '/);
    const params = execute.mock.calls[0][1] as Array<{
      name: string;
      type: unknown;
      value: unknown;
    }>;
    expect(params).toEqual([
      { name: "schema", type: TYPES.NVarChar, value: "dbo" },
    ]);
  });

  it("#3 listColumns uses parameterized query", async () => {
    const { adapter, execute } = makeAdapterWithExecuteSpy();

    await adapter.listColumns("users", "dbo");

    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain("@schema");
    expect(sql).toContain("@table");
    expect(sql).not.toContain("'dbo'");
    expect(sql).not.toContain("'users'");
    expect(sql).not.toMatch(/WHERE s\.name = '/);
    expect(sql).not.toMatch(/AND t\.name = '/);
    const params = execute.mock.calls[0][1] as Array<{
      name: string;
      type: unknown;
      value: unknown;
    }>;
    expect(params).toEqual([
      { name: "schema", type: TYPES.NVarChar, value: "dbo" },
      { name: "table", type: TYPES.NVarChar, value: "users" },
    ]);
  });

  it("#2b regression: listTables with a quote in the schema name never reaches the SQL text", async () => {
    const { adapter, execute } = makeAdapterWithExecuteSpy();

    await adapter.listTables("O'Brien");

    const sql = execute.mock.calls[0][0] as string;
    expect(sql).not.toContain("O'Brien");
    expect(sql).not.toContain("O''Brien");
    const params = execute.mock.calls[0][1] as Array<{
      name: string;
      value: unknown;
    }>;
    expect(params).toEqual([
      { name: "schema", type: TYPES.NVarChar, value: "O'Brien" },
    ]);
  });

  it("#3b regression: estimateTableRowsBatch builds an IN list from @tableN parameters", async () => {
    const { adapter, execute } = makeAdapterWithExecuteSpy([
      ["a", 10],
      ["b", 20],
    ]);

    await adapter.estimateTableRowsBatch("dbo", ["a", "b"]);

    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain("IN (@table0, @table1)");
    expect(sql).not.toContain("'a'");
    expect(sql).not.toContain("'b'");
    expect(sql).not.toContain("'dbo'");
    const params = execute.mock.calls[0][1] as Array<{
      name: string;
      value: unknown;
    }>;
    expect(params).toEqual([
      { name: "schema", type: TYPES.NVarChar, value: "dbo" },
      { name: "table0", type: TYPES.NVarChar, value: "a" },
      { name: "table1", type: TYPES.NVarChar, value: "b" },
    ]);
  });
});

// ---- Test #4: literal() retained for backward compatibility ----------------

describe("MsSqlAdapter.literal — backward compat (TASK-002)", () => {
  it("#4 literal() method still exists for backward compat", () => {
    const adapter = new MsSqlAdapter(cfg(), "pw");
    expect(
      (adapter as unknown as { literal: (value: string) => string }).literal(
        "test",
      ),
    ).toBe("'test'");
  });
});

// ---- TASK-RLX02-002: cancelActiveQuery — non-cursor cancellation seam -------
//
// Same wiring pattern as makeWiredAdapter(), but the fake connection's
// execSql deliberately does NOT settle the request: the test holds the
// request callback and decides when (and with what error) the request
// completes. That exposes the exact window cancelActiveQuery() operates in —
// a request that is live in `activeRequests` while its caller is still
// awaiting the result.

function makeDeferredAdapter(): {
  adapter: MsSqlAdapter;
  execSql: ReturnType<typeof vi.fn>;
  closeConnection: ReturnType<typeof vi.fn>;
  requests: TediousRequest[];
  settle: (
    request: TediousRequest,
    error?: Error | null,
    rowCount?: number,
  ) => void;
  emitMetadata: (request: TediousRequest) => void;
} {
  const adapter = new MsSqlAdapter(cfg(), "pw");
  const requests: TediousRequest[] = [];
  addParameterSpy = vi.spyOn(TediousRequestCtor.prototype, "addParameter");
  const originalNewRequest = (
    MsSqlAdapter.prototype as unknown as {
      newRequest: (
        this: MsSqlAdapter,
        sql: string,
        params?: unknown,
      ) => TediousRequest;
    }
  ).newRequest;
  (adapter as unknown as { newRequest: unknown }).newRequest = (
    sql: string,
    params?: unknown,
  ) => {
    const request = originalNewRequest.call(adapter, sql, params);
    requests.push(request);
    return request;
  };
  const execSql = vi.fn((_request: TediousRequest) => {
    // Deferred on purpose — completion is driven by settle() below.
  });
  const closeConnection = vi.fn();
  (adapter as unknown as { connection: unknown }).connection = {
    execSql,
    close: closeConnection,
  };
  (adapter as unknown as { connected: boolean }).connected = true;
  const settle = (
    request: TediousRequest,
    error: Error | null = null,
    rowCount = 0,
  ): void => {
    (
      request as unknown as {
        callback:
          | ((error: Error | null | undefined, rowCount?: number) => void)
          | null;
      }
    ).callback?.(error, rowCount);
  };
  const emitMetadata = (request: TediousRequest): void => {
    request.emit("columnMetadata", []);
  };
  return { adapter, execSql, closeConnection, requests, settle, emitMetadata };
}

function activeRequestsOf(adapter: MsSqlAdapter): Set<TediousRequest> {
  return (
    adapter as unknown as { activeRequests: Set<TediousRequest> }
  ).activeRequests;
}

function operationQueueOf(adapter: MsSqlAdapter): Promise<unknown> {
  return (adapter as unknown as { operationQueue: Promise<unknown> })
    .operationQueue;
}

describe("MsSqlAdapter.cancelActiveQuery (TASK-RLX02-002)", () => {
  it("cancelActiveQuery cancels exactly one deferred non-streaming Request", async () => {
    const { adapter, requests, settle, closeConnection } =
      makeDeferredAdapter();
    const closeAdapterSpy = vi.spyOn(adapter, "close");

    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];
    // Pre-state: the deferred request is the one live non-cursor request.
    expect(activeRequestsOf(adapter).has(request)).toBe(true);

    const cancelSpy = vi.spyOn(request, "cancel");
    await adapter.cancelActiveQuery();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(closeAdapterSpy).not.toHaveBeenCalled();

    // Completion still settles the caller and removes the exact request.
    settle(request, null, 0);
    expect(await runPromise).toMatchObject({ rows: [] });
    expect(activeRequestsOf(adapter).has(request)).toBe(false);
  });

  it("request.cancel throw is swallowed and completion still cleans up", async () => {
    const { adapter, requests, settle } = makeDeferredAdapter();

    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];
    const cancelSpy = vi
      .spyOn(request, "cancel")
      .mockImplementation(() => {
        throw new Error("cancel raced with completion");
      });

    // The seam resolves even though cancel() threw.
    await expect(adapter.cancelActiveQuery()).resolves.toBeUndefined();

    // Later callback completion removes the exact request.
    settle(request, null, 0);
    await runPromise;
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(activeRequestsOf(adapter).size).toBe(0);

    // Repeated cancellation after settlement resolves silently.
    await expect(adapter.cancelActiveQuery()).resolves.toBeUndefined();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it("empty or already-completed activeRequests is a no-op", async () => {
    const { adapter, execSql, requests, settle, closeConnection } =
      makeDeferredAdapter();

    // Empty set: no execSql, no close, operationQueue untouched.
    const queueBefore = operationQueueOf(adapter);
    await adapter.cancelActiveQuery();
    expect(execSql).not.toHaveBeenCalled();
    expect(closeConnection).not.toHaveBeenCalled();
    expect(operationQueueOf(adapter)).toBe(queueBefore);

    // Already-completed request: it is not re-cancelled.
    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    settle(requests[0], null, 0);
    await runPromise;
    expect(execSql).toHaveBeenCalledTimes(1);
    expect(activeRequestsOf(adapter).size).toBe(0);

    const queueAfterRun = operationQueueOf(adapter);
    await adapter.cancelActiveQuery();
    expect(execSql).toHaveBeenCalledTimes(1);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(operationQueueOf(adapter)).toBe(queueAfterRun);
  });

  it("streaming BatchedQuery cancellation remains request-local", async () => {
    const { adapter, execSql, requests, emitMetadata, closeConnection } =
      makeDeferredAdapter();

    const runPromise = adapter.runQuery("SELECT * FROM dbo.vsdb_big");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];
    emitMetadata(request); // tedious emits columnMetadata before rows flow
    const run = await runPromise;
    const batched = run.batched;
    expect(batched).toBeDefined();
    expect(activeRequestsOf(adapter).has(request)).toBe(true);

    const cancelSpy = vi.spyOn(request, "cancel");
    await batched!.cancel();

    // Cursor cancel is request-local: cancels its own request once and
    // deletes it from activeRequests.
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(activeRequestsOf(adapter).has(request)).toBe(false);

    // The adapter-level seam neither re-cancels the cursor request, closes
    // the connection, nor manufactures new SQL.
    await adapter.cancelActiveQuery();
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(execSql).toHaveBeenCalledTimes(1);

    // The cancelled stream drains to EOF without pending work.
    await expect(batched!.fetchBatch()).resolves.toBeNull();
  });
});

// ---- TASK-ARP05-003 — MSSQL finite-failure contract pins --------------------
//
// Wave-1 measurement probes for the cross-driver resilience contract
// (docs/decisions/0002-cross-driver-resilience-contract.md §2.3/§2.4/§2.5,
// SLO-1/SLO-2). Expected posture on today's code is GREEN (pin-only): these
// tests ship as pins unless a probe proves a gap in mssql.ts.
//
// Fixtures reuse the instance-level newRequest shadow + fake deferred
// connection patterns above. Test #1 additionally calls the adapter's private
// createConnection() directly so the REAL tedious Connection constructor runs
// and the adapter's exact options are read at the driver boundary — the
// tedious 18.x constructor is pure (it copies config; no socket or timer is
// armed until connect() is called), so this is DB-free and side-effect free.

function createConnectionOptionsOf(
  adapter: MsSqlAdapter,
): Record<string, unknown> {
  const connection = (
    adapter as unknown as {
      createConnection: () => {
        config: { options: Record<string, unknown> };
      };
    }
  ).createConnection();
  return connection.config.options;
}

describe("MsSqlAdapter ARP-05.3 — paused-stream survival (requestTimeout: 0)", () => {
  it("#1 pin: streaming SELECT is not timed out — requestTimeout 0, no request timer armed, long paused load-more survives", async () => {
    // (a) Driver-boundary pin: the real tedious Connection is constructed
    // with requestTimeout: 0 (mssql.ts:554), so execSql can arm NO wall-clock
    // request timer — a paused load-more stream cannot be killed by a
    // timeout. cancelTimeout: 5_000 and connectTimeout: 10_000 stay pinned
    // alongside (mssql.ts:555, :547).
    const options = createConnectionOptionsOf(new MsSqlAdapter(cfg(), "pw"));
    expect(options["requestTimeout"]).toBe(0);
    expect(options["cancelTimeout"]).toBe(5_000);
    expect(options["connectTimeout"]).toBe(10_000);

    // (b) Behavioral pin: a streaming request that pauses mid-flow (rows
    // buffered, no fetcher) stays alive across a load-more stall far longer
    // than any finite query timeout and still drains afterwards. The adapter
    // never arms a per-request timer (never calls Request.setTimeout).
    const { adapter, requests, settle, emitMetadata } = makeDeferredAdapter();
    const setTimeoutSpy = vi
      .spyOn(TediousRequestCtor.prototype, "setTimeout")
      .mockClear();

    const runPromise = adapter.runQuery("SELECT * FROM dbo.vsdb_big");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];
    const pauseSpy = vi.spyOn(request, "pause");

    emitMetadata(request); // tedious emits columnMetadata before rows flow
    const run = await runPromise;
    const batched = run.batched!;
    expect(batched).toBeDefined();

    // 600 rows: BATCH_SIZE=500 → first batch parked in readyBatch, request
    // paused; remaining 100 stay buffered mid-flow.
    for (let i = 0; i < 600; i++) {
      request.emit("row", { c0: { value: i } });
    }
    expect(pauseSpy).toHaveBeenCalled();

    const firstBatch = await batched.fetchBatch();
    expect(firstBatch).toHaveLength(500);

    // Paused mid-flow "load-more" stall: with any finite requestTimeout this
    // window is where tedious would kill the request. Under requestTimeout: 0
    // the paused stream just waits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setTimeoutSpy).not.toHaveBeenCalled(); // no per-request timer armed

    // The stream survived the stall and completes normally end-to-end.
    settle(request, null, 600);
    const lastBatch = await batched.fetchBatch();
    expect(lastBatch).toHaveLength(100);
    await expect(batched.fetchBatch()).resolves.toBeNull(); // EOF
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });
});

describe("MsSqlAdapter ARP-05.3 — cancel within cancelTimeout", () => {
  it("#2 edge: live request cancels within cancelTimeout — runRequest settles and activeRequests drains", async () => {
    const { adapter, requests, settle } = makeDeferredAdapter();

    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];
    expect(activeRequestsOf(adapter).has(request)).toBe(true);

    // Fake the tedious cancel round-trip: request.cancel() drives the
    // driver's error/completion path well inside cancelTimeout: 5_000
    // (mssql.ts:555).
    const cancelSpy = vi.spyOn(request, "cancel").mockImplementation(() => {
      request.emit("error", new Error("Canceled."));
      settle(request, new Error("Canceled."));
    });

    const startedAt = Date.now();
    await adapter.cancelActiveQuery();
    await expect(runPromise).rejects.toThrow("Canceled.");
    const elapsedMs = Date.now() - startedAt;

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // Bounded by the 5s cancel SLO (ADR §5 SLO-1, cancel row).
    expect(elapsedMs).toBeLessThan(5_000);
    expect(activeRequestsOf(adapter).has(request)).toBe(false);
    expect(activeRequestsOf(adapter).size).toBe(0);
  });
});

describe("MsSqlAdapter ARP-05.3 — late failure cannot wedge the enqueue chain", () => {
  it("#3 edge: first queued operation rejects; the second queued operation still runs — no deadlock, no unhandled rejection", async () => {
    const { adapter, requests, settle } = makeDeferredAdapter();

    // Queue two operations through execute() → enqueue(); both deferred.
    const first = callExecute(adapter, "SELECT 1 AS one");
    const second = callExecute(adapter, "SELECT 2 AS two");
    await vi.waitFor(() => expect(requests.length).toBe(1));

    // The first operation's request fails terminally.
    settle(requests[0], new Error("first failed"));
    await expect(first).rejects.toThrow("first failed");

    // The chain advanced: enqueue released the second operation even though
    // the first rejected (the chain link resolves in `finally`).
    await vi.waitFor(() => expect(requests.length).toBe(2));
    settle(requests[1], null, 0);
    await expect(second).resolves.toMatchObject({ rows: [] });

    // The queue returned to its idle resolved state — nothing wedged.
    await expect(operationQueueOf(adapter)).resolves.toBeUndefined();
  });
});

describe("MsSqlAdapter ARP-05.3 — connect() failure cleanup", () => {
  it("#4 edge: connect failure clears the connection, closes it best-effort, and resets connecting", async () => {
    const adapter = new MsSqlAdapter(cfg(), "pw");
    const connection = new EventEmitter() as unknown as {
      state: { name: string };
      connect: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      emit: EventEmitter["emit"];
    };
    connection.state = { name: "Initialized" };
    connection.connect = vi.fn();
    connection.close = vi.fn();
    (adapter as unknown as { createConnection: () => unknown })
      .createConnection = () => connection;

    const connectPromise = adapter.connect();
    // The fake connection signals the failure through the `error` event —
    // how tedious surfaces handshake/login failures.
    await Promise.resolve();
    connection.emit("error", new Error("login failed"));

    await expect(connectPromise).rejects.toThrow("login failed");

    // fail() path: clearConnection dropped the reference, close() ran
    // best-effort, `connecting` was reset in `.finally`, `connected` false.
    expect(
      (adapter as unknown as { connection: unknown }).connection,
    ).toBeNull();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(
      (adapter as unknown as { connecting: Promise<void> | null }).connecting,
    ).toBeNull();
    expect((adapter as unknown as { connected: boolean }).connected).toBe(
      false,
    );
  });
});

describe("MsSqlAdapter ARP-05.3 — cancel after settle is a no-op", () => {
  it("#5 edge: late error/cancel on an already-settled request is swallowed — settled guard keeps state final", async () => {
    const { adapter, requests, settle } = makeDeferredAdapter();

    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];

    // Settle via the request callback (the final completion signal).
    settle(request, null, 7);
    const result = (await runPromise) as QueryResultLike;
    expect(result.rowCount).toBe(7);
    expect(activeRequestsOf(adapter).size).toBe(0);

    // Late error event + cancel after settle: the settled guard inside
    // runRequest's finish() ignores both — the promise stays resolved with
    // rowCount 7, finish is never re-invoked, and no unhandled rejection
    // surfaces (vitest fails the suite on any).
    request.emit("error", new Error("late error after settle"));
    expect(() => request.cancel()).not.toThrow();
    request.cancel(); // tedious re-cancel guard: no-op second time

    await expect(runPromise).resolves.toMatchObject({ rowCount: 7 });
    // Adapter seam on an already-drained set: silent no-op.
    await expect(adapter.cancelActiveQuery()).resolves.toBeUndefined();
    expect(activeRequestsOf(adapter).size).toBe(0);
  });
});
