// src/adapters/__tests__/mysqlQueueBound.test.ts
//
// TASK-ARP05-002 — focused DB-free unit suite for the MySQL queue bound + the
// streaming/cancel/terminal pins (Test Cases 2-5 of the task file).
//
// The acquire bound is a module-scoped constant `POOL_ACQUIRE_TIMEOUT_MS`
// (default 10_000, aligned with `connectTimeout`) in src/adapters/mysql.ts,
// overridable via `setPoolAcquireTimeoutMsForTests` so this suite stubs it to
// 50ms — the queue-bound test never waits a real 10s. The constant is also
// passed to `mysql.createPool` as `acquireTimeout`; note that mysql2 3.23.4
// does NOT honour that option (measured — see the ADR `## Probe: MySQL`
// section), so the adapter additionally enforces the bound itself with a
// `Promise.race` around `pool.getConnection()`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import * as mysqlAdapterModule from "../mysql";

const { MySqlAdapter } = mysqlAdapterModule;
// Defensive access: before the fix lands, the constant + setter do not exist
// and the stub is a no-op — case 2 must then fail for the RIGHT reason
// (unbounded wait), not with an import error.
const mod = mysqlAdapterModule as unknown as {
  POOL_ACQUIRE_TIMEOUT_MS?: number;
  setPoolAcquireTimeoutMsForTests?: (ms: number) => void;
};

function cfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "UnicDB",
    database: "UnicDB",
  };
}

// ---- mysql2/promise mock ----------------------------------------------------
//
// Mirrors the timezone.test.ts pattern: the factory keeps module-level state
// (`__state.createdPools`) reachable from the tests. Each created pool models
// the connectionLimit:1 slot: the first getConnection() hands out the single
// `held` connection and marks the slot busy; further calls park in a queue
// (queueLimit:0 = unlimited) that only `pool.ctl.free()` can drain — the mock
// never frees the slot on release(), so a test that wants the slot free calls
// ctl.free() explicitly.

vi.mock("mysql2/promise", () => {
  const state = {
    createdPools: [] as Array<Record<string, unknown>>,
    failNextPing: false,
  };

  const makeConn = () => {
    const conn: Record<string, unknown> = {
      queries: [] as Array<{ sql: string }>,
      released: 0,
      destroyed: 0,
    };
    conn.query = (sql: unknown) => {
      (conn.queries as Array<{ sql: string }>).push({ sql: String(sql) });
      return Promise.resolve([[], []]);
    };
    conn.ping = () => {
      if (state.failNextPing) {
        state.failNextPing = false;
        return Promise.reject(new Error("simulated ping failure"));
      }
      return Promise.resolve();
    };
    conn.release = () => {
      conn.released = (conn.released as number) + 1;
    };
    conn.destroy = () => {
      conn.destroyed = (conn.destroyed as number) + 1;
    };
    conn.beginTransaction = () => Promise.resolve();
    conn.commit = () => Promise.resolve();
    conn.rollback = () => Promise.resolve();
    return conn;
  };

  const createPool = (options: Record<string, unknown>) => {
    const held = makeConn();
    const queue: Array<{
      resolve: (c: unknown) => void;
      reject: (e: Error) => void;
    }> = [];
    const pool: Record<string, unknown> = {
      options,
      endCalls: 0,
      holdSlot: false,
      getConnection: () => {
        if (pool.holdSlot) {
          return new Promise((resolve, reject) => {
            queue.push({ resolve, reject });
          });
        }
        pool.holdSlot = true;
        return Promise.resolve(held);
      },
      ctl: {
        held,
        queue,
        free: () => {
          pool.holdSlot = false;
          const waiter = queue.shift();
          if (waiter) {
            pool.holdSlot = true;
            waiter.resolve(held);
          }
        },
      },
      query: () => {
        throw new Error("pool.query must never be reached (TASK-005 M1)");
      },
      end: () => {
        pool.endCalls = (pool.endCalls as number) + 1;
        return Promise.resolve();
      },
    };
    state.createdPools.push(pool);
    return pool;
  };

  return {
    default: { createPool, __state: state },
    createPool,
    __state: state,
  };
});

import mysql from "mysql2/promise";

interface MockState {
  createdPools: Array<{
    options: Record<string, unknown>;
    endCalls: number;
    holdSlot: boolean;
    ctl: {
      held: Record<string, unknown>;
      queue: Array<{
        resolve: (c: unknown) => void;
        reject: (e: Error) => void;
      }>;
      free: () => void;
    };
  }>;
  failNextPing: boolean;
}

function mockState(): MockState {
  return (mysql as unknown as { __state: MockState }).__state;
}

function lastPool(): MockState["createdPools"][number] {
  const pool = mockState().createdPools.at(-1);
  if (!pool) throw new Error("no pool created");
  return pool;
}

let savedBound: number | undefined;

beforeEach(() => {
  mockState().createdPools.length = 0;
  mockState().failNextPing = false;
  savedBound = mod.POOL_ACQUIRE_TIMEOUT_MS;
  // Inject a short bound so the queue-bound case is fast and deterministic
  // (never a real 10s wait). Production default is restored in afterEach.
  mod.setPoolAcquireTimeoutMsForTests?.(50);
});

afterEach(() => {
  mod.setPoolAcquireTimeoutMsForTests?.(savedBound ?? 10_000);
});

// ----------------------------------------------------------------------------
// Case 2 (RED→GREEN) — held single connection + late request terminates within
// a bounded, injectable acquire wait.
// ----------------------------------------------------------------------------

describe("MySqlAdapter — bounded acquire wait (TASK-ARP05-002 case 2)", () => {
  // (a) config pin — the pool factory options carry the injected bound.
  it("case 2a: pool factory options include acquireTimeout = the injected POOL_ACQUIRE_TIMEOUT_MS", async () => {
    const adapter = new MySqlAdapter(cfg(), "pw");
    await adapter.connect();

    const pool = lastPool();
    expect(pool.options.acquireTimeout).toBe(50);
    // Untouched intent from §3.2 of the ADR: single slot + queued waits.
    expect(pool.options.connectionLimit).toBe(1);
    expect(pool.options.waitForConnections).toBe(true);
    expect(pool.options.queueLimit).toBe(0);
    await adapter.close().catch(() => undefined);
  });

  // (b) behavior — with the single slot held, a late checkout must REJECT
  // within the injected bound. RED on today's code: queueLimit: 0 + no
  // acquireTimeout = the late request waits forever (test timeout).
  it("case 2b: a late request against a held single slot rejects within the injected bound", async () => {
    const adapter = new MySqlAdapter(cfg(), "pw");
    await adapter.connect();

    const pool = lastPool();
    // The mock's slot is now busy (the probe checked out the only connection
    // and the mock never auto-frees): any further checkout is the LATE
    // request enqueuing behind a held stream/transaction.
    expect(pool.holdSlot).toBe(true);

    const start = Date.now();
    let caught: Error | undefined;
    try {
      await adapter.listSchemas(false);
    } catch (e) {
      caught = e as Error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/acquire/i);
    // Bounded: well under the 2s test timeout (the injected bound is 50ms).
    // An unbounded wait would blow the test timeout instead of settling.
    expect(elapsed).toBeLessThan(1_500);
    // The waiter is still parked in the pool queue — the bound rejects the
    // request without disturbing the pool's own queue bookkeeping.
    expect(pool.ctl.queue.length).toBe(1);

    // Cleanup: free the slot; the abandoned waiter resolves and the adapter's
    // late-acquire guard hands the connection straight back (no zombie slot).
    pool.ctl.free();
    await adapter.close().catch(() => undefined);
  }, 2_000);
});

// ----------------------------------------------------------------------------
// Case 3 (pin) — cancel is terminal: destroy, never replay; a late repeat
// cancelActiveQuery is a silent no-op.
// ----------------------------------------------------------------------------

describe("MySqlAdapter — cancel is terminal, no replay (TASK-ARP05-002 case 3)", () => {
  it("case 3: cancel destroys the held non-streaming connection exactly once; repeat cancels are no-ops and the statement is never re-issued", async () => {
    const log: string[] = [];
    let rejectInFlight: ((e: Error) => void) | undefined;
    const held = {
      queries: [] as Array<{ sql: string }>,
      released: 0,
      destroyed: 0,
      query: (sql: unknown) => {
        const text = String(sql);
        held.queries.push({ sql: text });
        if (/^SET time_zone/i.test(text)) {
          log.push("SET time_zone");
          return Promise.resolve([[], []]);
        }
        log.push(`query:${text.replace(/\s+/g, " ").trim()}`);
        // Park the in-flight mutation so the ownership window stays open.
        return new Promise<[unknown[], unknown[]]>((_, reject) => {
          rejectInFlight = reject;
        });
      },
      release: () => {
        held.released += 1;
        log.push("release");
      },
      destroy: () => {
        held.destroyed += 1;
        log.push("destroy");
        // Real mysql2 destroy() rejects the in-flight query promise.
        rejectInFlight?.(new Error("connection destroyed"));
      },
      beginTransaction: () => {
        log.push("beginTransaction");
        return Promise.resolve();
      },
      commit: () => {
        log.push("commit");
        return Promise.resolve();
      },
      rollback: () => {
        log.push("rollback");
        return Promise.resolve();
      },
    };
    const pool = {
      getConnection: () => Promise.resolve(held),
      query: vi.fn(() => {
        throw new Error("pool.query must never be reached");
      }),
      end: () => Promise.resolve(),
    };
    const adapter = new MySqlAdapter(cfg(), "pw");
    (adapter as unknown as { pool: unknown }).pool = pool;

    const runPromise = adapter.runQuery("UPDATE t SET a = 1");
    await new Promise((r) => setTimeout(r, 30));
    expect(log).toContain("beginTransaction");
    expect(log).not.toContain("destroy");
    expect(held.queries.filter((q) => q.sql.startsWith("UPDATE")).length).toBe(1);

    await adapter.cancelActiveQuery!();
    expect(held.destroyed).toBe(1);

    // Late repeat cancels are silent no-ops.
    await adapter.cancelActiveQuery!();
    await adapter.cancelActiveQuery!();
    expect(held.destroyed).toBe(1);

    // The run settles; the mutation was issued exactly once and never
    // replayed (no second UPDATE on the wire).
    await runPromise.catch(() => undefined);
    expect(held.queries.filter((q) => q.sql.startsWith("UPDATE")).length).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Case 4 (pin) — a stream that ends without `fields`/`error` settles
// openStreamingQuery (empty-result success) and releases the connection.
// ----------------------------------------------------------------------------

describe("MySqlAdapter — stream ends without fields does not hang (TASK-ARP05-002 case 4)", () => {
  it("case 4: a stream emitting only 'end' resolves with columns [] and releases the pool connection", async () => {
    const listeners = new Map<string, Array<(payload?: unknown) => void>>();
    let streamDestroyed = 0;
    const fakeStream = {
      once: (event: string, cb: (payload?: unknown) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      },
      on: (event: string, cb: (payload?: unknown) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
      },
      destroy: () => {
        streamDestroyed += 1;
      },
      pause: () => undefined,
      resume: () => undefined,
    };
    let releases = 0;
    const held = {
      queries: [] as Array<{ sql: string }>,
      query: (sql: unknown) => {
        held.queries.push({ sql: String(sql) });
        return Promise.resolve([[], []]);
      },
      release: () => {
        releases += 1;
      },
      destroy: () => undefined,
      ping: () => Promise.resolve(),
    };
    const wrapper = Object.assign(
      Object.create(Object.getPrototypeOf(held)),
      held,
      { connection: { query: () => ({ stream: () => fakeStream }) } },
    );
    const pool = {
      getConnection: () => Promise.resolve(wrapper),
      query: vi.fn(() => {
        throw new Error("pool.query must never be reached");
      }),
      end: () => Promise.resolve(),
    };
    const adapter = new MySqlAdapter(cfg(), "pw");
    (adapter as unknown as { pool: unknown }).pool = pool;

    const promise = adapter.runQuery("SELECT 1");
    // Listeners attach after the async checkout crosses a few turns.
    setTimeout(() => {
      for (const cb of [...(listeners.get("end") ?? [])]) cb();
    }, 0);

    const result = (await promise) as {
      results: unknown[];
      batched: { columns: string[]; fetchBatch: () => Promise<unknown[] | null> };
    };
    expect(result.results).toEqual([]);
    expect(result.batched.columns).toEqual([]);
    expect(await result.batched.fetchBatch()).toBeNull();
    expect(releases).toBe(1);
    expect(streamDestroyed).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Case 5 (pin) — connect() failure closes the pool and nulls it; a later
// connect() rebuilds a fresh pool.
// ----------------------------------------------------------------------------

describe("MySqlAdapter — connect failure cleanup (TASK-ARP05-002 case 5)", () => {
  it("case 5: a failed connect probe ends the pool, nulls it, and a later connect() rebuilds a fresh pool", async () => {
    mockState().failNextPing = true;
    const adapter = new MySqlAdapter(cfg(), "pw");

    let caught: Error | undefined;
    try {
      await adapter.connect();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toMatch(/ping failure/);
    // The half-open pool was ended exactly once and the reference nulled.
    expect(mockState().createdPools.length).toBe(1);
    expect(mockState().createdPools[0].endCalls).toBe(1);
    expect((adapter as unknown as { pool: unknown }).pool).toBeNull();

    // A later connect() rebuilds a FRESH pool (second createPool call) and
    // succeeds — the failed pool is not reused.
    await expect(adapter.connect()).resolves.toBeUndefined();
    expect(mockState().createdPools.length).toBe(2);
    expect(mockState().createdPools[1].endCalls).toBe(0);
    expect((adapter as unknown as { pool: unknown }).pool).toBe(
      mockState().createdPools[1],
    );
    await adapter.close().catch(() => undefined);
  });
});
