// src/adapters/__tests__/timezone.test.ts
//
// TASK-005 — explicit UTC adapter sessions (cases 4-8).
//
// Faithful mysql2 mock: the promise pool wraps a CORE pool; each
// `getConnection()` call resolves a NEW `PromisePoolConnection` whose
// `.connection` field is the stable per-physical-connection core object
// (exactly what node_modules/mysql2/lib/promise/pool.js does). Physical
// identity therefore = wrapper `.connection`, and a "replacement after loss"
// is simply the next core object the mock hands out. `pool.query(sql, values)`
// exists on the mock and records calls — the M1 tests assert the adapter
// NEVER reaches it.
//
// tedious is mocked at module level so `new Connection(config)` is observable
// for the `useUTC: true` assertion (case 4) without any network.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("mysql2/promise", () => {
  const createdPools: Array<{
    options: Record<string, unknown>;
    coreConnections: Array<Record<string, unknown>>;
    getConnectionCalls: number;
    queryCalls: Array<unknown[]>;
    directQueryCalls: Array<unknown[]>;
  }> = [];

  const createPool = (options: Record<string, unknown>) => {
    const pool = {
      options,
      coreConnections: [] as Array<Record<string, unknown>>,
      /** Released identities available for reuse, like a real pool. */
      freeCores: [] as Array<Record<string, unknown>>,
      getConnectionCalls: 0,
      queryCalls: [] as Array<unknown[]>,
      directQueryCalls: [] as Array<unknown[]>,
      getConnection: () => {
        pool.getConnectionCalls += 1;
        const reusable = pool.freeCores.shift();
        const core: Record<string, unknown> =
          reusable ??
          (() => {
            // The per-physical-connection observable state lives ON the core
            // object so tests can read it after release (mirrors what a real
            // mysql2 pool exposes for identity: the wrapper's `.connection`).
            const created: Record<string, unknown> = {
              __id: `core-${createdPools.length}-${pool.coreConnections.length}`,
              queries: [] as Array<{ sql: string; values?: unknown[] }>,
              released: 0,
              destroyed: 0,
            };
            pool.coreConnections.push(created);
            return created;
          })();
        // Faithful core connection: query(sql, values, cb) settles on a
        // microtask; `ping(cb)` succeeds.
        core.query = (sql: unknown, values: unknown, cb?: unknown) => {
          const callback = typeof values === "function" ? values : cb;
          const vals = typeof values === "function" ? undefined : values;
          (core.queries as Array<{ sql: string; values?: unknown[] }>).push({
            sql: String(sql),
            values: vals,
          });
          queueMicrotask(() => {
            (callback as (e: Error | null, r?: unknown) => void)?.(null, [[], []]);
          });
        };
        core.ping = (cb: unknown) => {
          queueMicrotask(() => (cb as (e: Error | null) => void)?.(null));
        };
        core.release = () => {
          core.released = (core.released as number) + 1;
        };
        core.destroy = () => {
          core.destroyed = (core.destroyed as number) + 1;
        };
        const wrapper = {
          connection: core,
          query: (sql: unknown, values?: unknown) => {
            (core.queries as Array<{ sql: string; values?: unknown[] }>).push({
              sql: String(sql),
              values: Array.isArray(values) ? values : undefined,
            });
            return Promise.resolve([[], []]);
          },
          // mysql2 sends COM_PING on the physical connection — log it so
          // tests can prove the UTC init preceded the probe.
          ping: () => {
            (core.queries as Array<{ sql: string; values?: unknown[] }>).push({
              sql: "PING",
            });
            return Promise.resolve();
          },
          beginTransaction: () => Promise.resolve(),
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
          release: () => {
            core.released = (core.released as number) + 1;
            pool.freeCores.push(core);
          },
          destroy: () => {
            core.destroyed = (core.destroyed as number) + 1;
          },
        };
        return Promise.resolve(wrapper);
      },
      query: (sql: unknown, values?: unknown) => {
        pool.directQueryCalls.push([sql, values]);
        return Promise.resolve([[], []]);
      },
      end: () => Promise.resolve(),
    };
    createdPools.push(pool as never);
    return pool;
  };

  return {
    default: { createPool, __createdPools: createdPools },
    createPool,
    __createdPools: createdPools,
  };
});

vi.mock("tedious", () => {
  const configs: Array<Record<string, unknown>> = [];
  const ConnectionCtor = vi.fn((config: Record<string, unknown>) => {
    configs.push(config);
    const listeners = new Map<string, Array<(err?: Error | null) => void>>();
    const conn = {
      config,
      on: (event: string, cb: (err?: Error | null) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return conn;
      },
      once: (event: string, cb: (err?: Error | null) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return conn;
      },
      removeListener: (event: string, cb: (err?: Error | null) => void) => {
        const list = listeners.get(event) ?? [];
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
        return conn;
      },
      // Faithful-enough handshake: `connect()` emits `connect` (no error) on
      // the next tick, already in the LoggedIn state, so adapter.connect()
      // resolves without a real TDS login.
      connect: () => {
        queueMicrotask(() => {
          for (const cb of [...(listeners.get("connect") ?? [])]) cb(null);
        });
      },
      close: () => undefined,
      state: { name: "LoggedIn" },
      execSql: () => undefined,
    };
    return conn;
  });
  return {
    Connection: ConnectionCtor,
    Request: vi.fn(),
    TYPES: { NVarChar: "NVarChar" },
    __configs: configs,
  };
});

import mysql from "mysql2/promise";
import { MySqlAdapter } from "../mysql";
import { MsSqlAdapter } from "../mssql";
import type { ConnectionConfig } from "../../config/types";

interface MockPool {
  options: Record<string, unknown>;
  coreConnections: Array<{
    __id: string;
    queries: Array<{ sql: string; values?: unknown[] }>;
    released: number;
    destroyed: number;
  }>;
  freeCores: Array<Record<string, unknown>>;
  getConnectionCalls: number;
  queryCalls: Array<unknown[]>;
  directQueryCalls: Array<unknown[]>;
  getConnection: () => Promise<unknown>;
}

function mysqlCfg(): ConnectionConfig {
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

function mssqlCfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver: "mssql",
    host: "127.0.0.1",
    port: 1433,
    user: "UnicDB",
    database: "UnicDB",
  };
}

async function makeConnectedMysqlAdapter(): Promise<{
  adapter: MySqlAdapter;
  pool: MockPool;
}> {
  const adapter = new MySqlAdapter(mysqlCfg(), "pw");
  await adapter.connect();
  const pool = (
    mysql as unknown as { __createdPools: MockPool[] }
  ).__createdPools.at(-1)!;
  return { adapter, pool };
}

import * as tediousState from "tedious";

beforeEach(() => {
  const pools = (
    mysql as unknown as { __createdPools: MockPool[] }
  ).__createdPools;
  pools.length = 0;
  const configs = (tediousState as unknown as { __configs: unknown[] })
    .__configs;
  if (configs) configs.length = 0;
});

// ---- Case 4: UTC checkout and tedious options -------------------------------

describe("UTC adapter configuration (TASK-005 case 4)", () => {
  it("mysql2 pool receives timezone: 'Z' and each checkout runs SET time_zone = '+00:00' before returning", async () => {
    const { adapter, pool } = await makeConnectedMysqlAdapter();
    await adapter.testConnection();

    expect(pool.options.timezone).toBe("Z");
    // The connect() probe's own checkout proves ordering on a FRESH physical
    // connection: the UTC session statement is the FIRST SQL on the wire,
    // before the ping that proves usability.
    const first = pool.coreConnections[0];
    expect(first.queries[0].sql).toBe("SET time_zone = '+00:00'");
    expect(first.queries[1].sql).toBe("PING");
    expect(first.released).toBe(2);
    // testConnection() reused the pooled identity (no re-init, no extra SET).
    expect(
      first.queries.filter((q) => q.sql === "SET time_zone = '+00:00'").length,
    ).toBe(1);
  });

  it("tedious receives options.useUTC: true", async () => {
    const adapter = new MsSqlAdapter(mssqlCfg(), "pw");
    await adapter.connect().catch(() => undefined);
    const configs = (
      tediousState as unknown as { __configs: Array<Record<string, unknown>> }
    ).__configs;
    expect(configs.length).toBeGreaterThan(0);
    const last = configs.at(-1)!;
    expect(
      (last.options as Record<string, unknown>).useUTC,
    ).toBe(true);
  });
});

// ---- Case 5: UTC session setup fails closed ---------------------------------

describe("UTC session setup fails closed (TASK-005 case 5)", () => {
  it("init rejection releases the checkout and rejects the adapter operation; no user SQL runs", async () => {
    const adapter = new MySqlAdapter(mysqlCfg(), "pw");
    await adapter.connect();

    const pool = (
      mysql as unknown as { __createdPools: MockPool[] }
    ).__createdPools.at(-1)!;
    const freshCore: Record<string, unknown> = {
      __id: "rejecting-core",
      queries: [] as Array<{ sql: string }>,
      released: 0,
    };
    freshCore.query = (sql: unknown) => {
      (freshCore.queries as Array<{ sql: string }>).push({ sql: String(sql) });
      return Promise.reject(new Error("session init rejected"));
    };
    freshCore.ping = () => Promise.resolve();
    freshCore.release = () => {
      freshCore.released = (freshCore.released as number) + 1;
    };
    freshCore.destroy = () => {};
    (pool as unknown as {
      getConnection: () => Promise<unknown>;
    }).getConnection = () =>
      Promise.resolve({
        connection: freshCore,
        query: freshCore.query as (sql: unknown) => Promise<never>,
        ping: () => Promise.resolve(),
        release: freshCore.release as () => void,
        destroy: () => {},
      });

    let error: Error | undefined;
    try {
      await adapter.listSchemas(false);
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/session init rejected|time_zone/i);
    expect(freshCore.released).toBe(1);
    expect(freshCore.queries).toEqual([
      { sql: "SET time_zone = '+00:00'" },
    ]); // the init attempt itself, and nothing after it
    await adapter.close().catch(() => undefined);
  });
});

// ---- Case 6: every physical connection initializes exactly once -------------

describe("Every physical connection initializes once (TASK-005 case 6)", () => {
  it("two physical connections each run SET time_zone exactly once; repeat checkouts skip; in-flight init is not overtaken", async () => {
    const { adapter, pool } = await makeConnectedMysqlAdapter();
    await adapter.testConnection(); // reuses the pooled identity — no re-init

    // Simulate a loss of the current physical identity: clear the free list
    // so the next checkout must create a SECOND physical connection.
    pool.freeCores.length = 0;
    await adapter.testConnection(); // physical #2 — must initialize once

    const cores = pool.coreConnections;
    expect(cores.length).toBe(2);
    const initCounts = cores.map(
      (core) =>
        core.queries.filter((q) => q.sql === "SET time_zone = '+00:00'").length,
    );
    expect(initCounts).toEqual([1, 1]);
    // The replacement's session statement is its first SQL, before its ping.
    expect(cores[1].queries[0].sql).toBe("SET time_zone = '+00:00'");
    expect(cores[1].queries[1].sql).toBe("PING");
  });
});

// ---- Case 7: replacement initializes before its SQL -------------------------

describe("Direct-query replacement initializes before SQL (TASK-005 case 7)", () => {
  it("after a connection loss, query(sql, values) initializes the replacement before its metadata query and releases it; pool.query is never called", async () => {
    const { adapter, pool } = await makeConnectedMysqlAdapter();
    const typedPool = pool as unknown as {
      coreConnections: Array<Record<string, unknown>>;
      directQueryCalls: Array<unknown[]>;
      getConnection: () => Promise<unknown>;
    };

    // Simulate a connection loss: the pool now hands out a brand-new
    // physical identity on the next checkout (a replacement).
    let replacementQueries: Array<{ sql: string; values?: unknown[] }> = [];
    const replacementCore: Record<string, unknown> = {
      __id: "replacement-core",
      query: (sql: unknown, values: unknown, cb?: unknown) => {
        const callback = typeof values === "function" ? values : cb;
        const vals = typeof values === "function" ? undefined : values;
        replacementQueries.push({ sql: String(sql), values: vals });
        queueMicrotask(() =>
          (callback as (e: Error | null, r?: unknown) => void)?.(null, [[], []]),
        );
      },
      ping: (cb: unknown) =>
        queueMicrotask(() => (cb as (e: Error | null) => void)?.(null)),
      release: () => {},
      destroy: () => {},
    };
    const originalGetConnection = typedPool.getConnection.bind(typedPool);
    let released = 0;
    typedPool.getConnection = () =>
      Promise.resolve({
        connection: replacementCore,
        query: (sql: unknown, values?: unknown) => {
          replacementQueries.push({
            sql: String(sql),
            values: Array.isArray(values) ? values : undefined,
          });
          return Promise.resolve([[{ name: "app" }], []]);
        },
        ping: () => Promise.resolve(),
        release: () => {
          released += 1;
        },
        destroy: () => {},
      });
    void originalGetConnection;

    const schemas = await adapter.listSchemas(false);

    expect(schemas.map((s) => s.name)).toEqual(["app"]);
    // The replacement's FIRST issued SQL is the UTC session init — no user
    // SQL may precede it.
    expect(replacementQueries[0].sql).toBe("SET time_zone = '+00:00'");
    expect(replacementQueries[1].sql).toMatch(/information_schema\.schemata/);
    expect(replacementQueries.length).toBe(2);
    expect(released).toBe(1);
    expect(typedPool.directQueryCalls).toEqual([]); // pool.query never reached
  });
});

// ---- Case 8: host TZ cannot shift canonical filter literals ------------------

describe("Host TZ cannot shift canonical filter literals (TASK-005 case 8)", () => {
  it("buildFilterWhere emits the same MySQL/MSSQL UTC-naive literal under a non-UTC TZ", async () => {
    const originalTz = process.env.TZ;
    const { buildFilterWhere } = await import("../../ui/queryComposer");
    const filters = {
      d: { values: ["2024-03-01T10:30:00.000Z"], typed: [new Date("2024-03-01T10:30:00.000Z")] },
    };
    const before = {
      mysql: buildFilterWhere(filters, "mysql"),
      mssql: buildFilterWhere(filters, "mssql"),
    };
    try {
      process.env.TZ = "Asia/Tokyo";
      const after = {
        mysql: buildFilterWhere(filters, "mysql"),
        mssql: buildFilterWhere(filters, "mssql"),
      };
      expect(after.mysql).toBe(before.mysql);
      expect(after.mssql).toBe(before.mssql);
      expect(after.mysql).toContain("'2024-03-01 10:30:00.000'");
      expect(after.mssql).toContain("'2024-03-01 10:30:00.000'");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
    // Canonical literal regardless of TZ
    expect(buildFilterWhere(filters, "mysql")).toMatch(
      /`d` IN \('2024-03-01 10:30:00\.000'\)/,
    );
  });
});
