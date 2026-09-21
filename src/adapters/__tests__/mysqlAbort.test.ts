// src/adapters/__tests__/mysqlAbort.test.ts
//
// TASK-SQLHANG-002 — MySqlAdapter.abortActiveQuery + bounded rollback.
// Cases 5-7 of the task file's §Test Cases.
//
// Pattern: vi.mock("mysql2/promise") hoisted factory (per
// mysqlQueueBound.test.ts convention). Tests inject a fake pool directly
// (`adapter.pool = pool`) — the same seam case 3 of mysqlQueueBound uses —
// so each case controls the held connection's query/rollback/destroy.
import { describe, it, expect, afterEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import { MySqlAdapter } from "../mysql";

vi.mock("mysql2/promise", () => ({
  default: { createPool: vi.fn() },
  createPool: vi.fn(),
}));

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

function fakePool(connection: unknown): unknown {
  return {
    getConnection: () => Promise.resolve(connection),
    query: vi.fn(() => {
      throw new Error("pool.query must never be reached");
    }),
    end: () => Promise.resolve(),
  };
}

function adapterWithPool(connection: unknown): MySqlAdapter {
  const adapter = new MySqlAdapter(cfg(), "pw");
  // Private seam: tests reach the internal pool slot directly (same as
  // mysqlQueueBound.test.ts case 3) to control the held connection.
  const internals = adapter as unknown as { pool: unknown };
  internals.pool = fakePool(connection);
  return adapter;
}

// abortActiveQuery is the SQLHANG seam under test; it stays optional on
// DbAdapter until TASK-001 lands, so tests call it through a named type.
type Abortable = { abortActiveQuery?: () => Promise<void> };
function abort(adapter: MySqlAdapter): Promise<void> {
  const seam = adapter as Abortable;
  return seam.abortActiveQuery!();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MySqlAdapter — abortActiveQuery (TASK-SQLHANG-002)", () => {
  it("case 5: abort while a batch holds the connection destroys it via the registered closure and the pending query rejects", async () => {
    const inFlight = Promise.withResolvers<never>();
    const held = {
      destroyed: 0,
      released: 0,
      statementIssued: false,
      query: (sql: unknown) => {
        const text = String(sql);
        if (/^SET time_zone/i.test(text)) return Promise.resolve([[], []]);
        // The in-flight statement parks until the connection is destroyed.
        held.statementIssued = true;
        return inFlight.promise;
      },
      release: () => {
        held.released += 1;
      },
      destroy: () => {
        held.destroyed += 1;
        // Real mysql2: destroy() rejects the in-flight query promise.
        inFlight.reject(new Error("connection destroyed"));
      },
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => Promise.resolve(),
    };
    const adapter = adapterWithPool(held);

    const run = adapter.runQuery("UPDATE t SET a = 1; UPDATE t SET b = 2");
    run.catch(() => undefined);
    // Wait until the batch actually holds the connection: beginTransaction
    // ran and the first statement is parked in-flight.
    await vi.waitFor(() => expect(held.statementIssued).toBe(true));

    await abort(adapter);
    expect(held.destroyed).toBe(1);

    await expect(run).rejects.toThrow("connection destroyed");
    // Destroyed connection is never released back to the pool.
    expect(held.released).toBe(0);
  });

  it("case 6: statement error + hanging rollback() → destroy, connectionDestroyed set, ORIGINAL error propagates, no release after destroy", async () => {
    const hanging = Promise.withResolvers<never>();
    const held = {
      destroyed: 0,
      released: 0,
      query: (sql: unknown) => {
        const text = String(sql);
        if (/^SET time_zone/i.test(text)) return Promise.resolve([[], []]);
        return Promise.reject(new Error("stmt boom"));
      },
      release: () => {
        held.released += 1;
      },
      destroy: () => {
        held.destroyed += 1;
      },
      beginTransaction: () => Promise.resolve(),
      commit: () => Promise.resolve(),
      rollback: () => hanging.promise, // dead connection — never settles
    };
    const adapter = adapterWithPool(held);

    vi.useFakeTimers();
    const run = adapter.runQuery("UPDATE t SET a = 1; UPDATE t SET b = 2");
    const assertion = expect(run).rejects.toThrow("stmt boom");
    // CLEANUP_GRACE_MS (3s) expires → destroy path, original error wins.
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    expect(held.destroyed).toBe(1);
    expect(held.released).toBe(0);
  });

  it("case 7: abort with nothing in flight resolves and destroys nothing", async () => {
    const held = {
      destroyed: 0,
      query: () => Promise.resolve([[], []]),
      release: () => undefined,
      destroy: () => {
        held.destroyed += 1;
      },
    };
    const adapter = adapterWithPool(held);

    await expect(abort(adapter)).resolves.toBeUndefined();
    expect(held.destroyed).toBe(0);
  });
});
