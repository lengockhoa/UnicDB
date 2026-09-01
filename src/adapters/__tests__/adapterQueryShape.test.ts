// src/adapters/__tests__/adapterQueryShape.test.ts
// TASK-005 — D5 cursor-routing predicate (Postgres), D6 MSSQL listColumns
// single-round-trip rewrite, and D2 estimateTableRowsBatch across all three
// drivers.
//
// Pattern: mock the pg Pool/Client (D5, same as postgres.test.ts) for the
// PostgresAdapter.runQuery routing tests; monkeypatch the adapter's private
// query()/execute() helper (same pattern as schemas.test.ts) everywhere else
// — no need to mock mysql2/tedious for pure SQL-shape + row-mapping tests.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import { Pool } from "pg";
import { PostgresAdapter, shouldUseCursor } from "../postgres";
import { MySqlAdapter } from "../mysql";
import { MsSqlAdapter } from "../mssql";

function cfg(driver: ConnectionConfig["driver"] = "postgres"): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver,
    host: "127.0.0.1",
    port: 5433,
    user: "vsdb",
    database: "vsdb",
  };
}

// ---- pg mock (Postgres routing tests) --------------------------------------
// Tracks calls separately on the cursor-capable client vs. the pool's direct
// (materializing) query() so tests can assert which path was taken.
let clientQueryCalls: unknown[] = [];
let poolQueryCalls: unknown[] = [];
let poolConnectCalls = 0;
let clientReleaseCalls = 0;

vi.mock("pg", () => {
  const fakeClient = {
    processID: 999,
    query: vi.fn((arg: unknown) => {
      clientQueryCalls.push(arg);
      const text = typeof arg === "string" ? arg : (arg as { text: string }).text;
      if (/^SELECT 1$/i.test(text)) {
        // Finding #6: this now also runs through the multi-statement
        // `client.query()` branch (not just the connect() probe / cursor
        // FETCH path), which reads `.fields` unconditionally — include it.
        return Promise.resolve({
          rows: [{ "?column?": 1 }],
          fields: [{ name: "?column?" }],
          rowCount: 1,
          command: "SELECT",
        });
      }
      if (/^BEGIN$/i.test(text)) {
        return Promise.resolve({ rows: [], fields: [], rowCount: null, command: "BEGIN" });
      }
      if (/^DECLARE/i.test(text)) return Promise.resolve({});
      if (/^FETCH 0/i.test(text)) return Promise.resolve({ fields: [], rows: [] });
      if (/^FETCH/i.test(text)) return Promise.resolve({ rows: [] });
      if (/^CLOSE/i.test(text)) return Promise.resolve({});
      if (/^COMMIT$/i.test(text)) {
        return Promise.resolve({ rows: [], fields: [], rowCount: null, command: "COMMIT" });
      }
      if (/^ROLLBACK$/i.test(text)) return Promise.resolve({});
      if (/^FORCE_ERROR$/i.test(text)) return Promise.reject(new Error("forced test error"));
      // Finding #6 fallback: generic statement shape (matches fakePool's
      // fallback below) so multi-statement runQuery — which now runs
      // through `client.query()` on a single checked-out client instead of
      // `pool.query()` per statement — can materialize columns/rowCount.
      return Promise.resolve({
        rows: [],
        fields: [],
        rowCount: 0,
        command: "SELECT",
      });
    }),
    release: vi.fn(() => {
      clientReleaseCalls += 1;
    }),
  };
  const fakePool = {
    query: vi.fn((sql: string) => {
      poolQueryCalls.push(sql);
      return Promise.resolve({
        rows: [],
        fields: [],
        rowCount: 0,
        command: "SELECT",
      });
    }),
    connect: vi.fn(() => {
      poolConnectCalls += 1;
      return Promise.resolve(fakeClient);
    }),
    end: vi.fn(() => Promise.resolve()),
  };
  const PoolCtor = vi.fn(() => fakePool);
  return { Pool: PoolCtor, Client: vi.fn(() => fakeClient) };
});

beforeEach(() => {
  clientQueryCalls = [];
  poolQueryCalls = [];
  poolConnectCalls = 0;
  clientReleaseCalls = 0;
});

// ---- D5: shouldUseCursor pure-function coverage ----------------------------

describe("shouldUseCursor — pure predicate (D5)", () => {
  it("plain SELECT → true", () => {
    expect(shouldUseCursor("SELECT * FROM t")).toBe(true);
  });

  it("leading line comment before SELECT → true", () => {
    expect(shouldUseCursor("-- note\nSELECT 1")).toBe(true);
  });

  it("leading block comment before SELECT → true", () => {
    expect(shouldUseCursor("/* note */ SELECT 1")).toBe(true);
  });

  it("WITH … CTE → true", () => {
    expect(shouldUseCursor("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  });

  it("semicolon inside a string literal does not affect the predicate → true", () => {
    expect(shouldUseCursor("SELECT ';' AS a")).toBe(true);
  });

  it("non-SELECT statement → false", () => {
    expect(shouldUseCursor("INSERT INTO t VALUES (1)")).toBe(false);
  });

  // Review fix round C, Finding #1 — BLOCKING REGRESSION: a data-modifying
  // CTE (`WITH x AS (UPDATE/INSERT/DELETE/MERGE ...) SELECT ...`) must NOT
  // route to DECLARE CURSOR — Postgres rejects "DECLARE CURSOR must not
  // contain data-modifying statements in WITH" and the adapter has no
  // fallback, so the UPDATE/INSERT/DELETE never runs.
  it("regression (finding 1): WITH ... UPDATE ... RETURNING CTE → false (must not use cursor)", () => {
    expect(
      shouldUseCursor(
        "WITH upd AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM upd",
      ),
    ).toBe(false);
  });

  it("regression (finding 1): WITH ... INSERT ... RETURNING CTE → false", () => {
    expect(
      shouldUseCursor(
        "WITH ins AS (INSERT INTO t(a) VALUES (1) RETURNING *) SELECT * FROM ins",
      ),
    ).toBe(false);
  });

  it("regression (finding 1): WITH ... DELETE ... RETURNING CTE → false", () => {
    expect(
      shouldUseCursor(
        "WITH del AS (DELETE FROM t WHERE id=1 RETURNING *) SELECT * FROM del",
      ),
    ).toBe(false);
  });

  it("regression (finding 1): WITH ... MERGE ... CTE → false", () => {
    expect(
      shouldUseCursor(
        "WITH m AS (MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET a=s.a) SELECT * FROM m",
      ),
    ).toBe(false);
  });

  it("finding 1 guard: a plain read-only CTE is still true (must not regress TASK-005)", () => {
    expect(shouldUseCursor("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(
      true,
    );
  });

  it("finding 1 guard: a CTE whose column is merely named 'update' is still true", () => {
    expect(
      shouldUseCursor(
        "WITH x AS (SELECT id, last_update FROM t) SELECT * FROM x",
      ),
    ).toBe(true);
  });

  it("finding 1 guard: a DML keyword inside a string literal inside the CTE does not false-positive", () => {
    expect(
      shouldUseCursor(
        "WITH x AS (SELECT 'DELETE this' AS note) SELECT * FROM x",
      ),
    ).toBe(true);
  });

  // Review fix round E, Finding #4 — MINOR (pre-existing, not from this
  // cycle). `SELECT ... INTO newtab FROM t` is a table-creating statement
  // (Postgres `SELECT INTO`), NOT a plain read-only SELECT. It still matched
  // `/^(SELECT|WITH)\b/` and routed to `openCursorForStatement`, which issues
  // `DECLARE "c" CURSOR FOR <sql>` — Postgres REJECTS `SELECT INTO` inside a
  // cursor declaration ("SELECT ... INTO is not allowed here") with no
  // fallback, so the statement just errors.
  it("regression (finding 4): SELECT ... INTO newtab FROM t → false (must not use cursor)", () => {
    expect(shouldUseCursor("SELECT * INTO newtab FROM t")).toBe(false);
  });

  it("regression (finding 4): SELECT col1, col2 INTO newtab FROM t WHERE x=1 → false", () => {
    expect(
      shouldUseCursor("SELECT col1, col2 INTO newtab FROM t WHERE x=1"),
    ).toBe(false);
  });

  it("finding 4 guard: a column merely named 'into_value' does not false-positive", () => {
    expect(shouldUseCursor("SELECT into_value FROM t")).toBe(true);
  });

  it("finding 4 guard: the literal word INTO inside a string literal does not false-positive", () => {
    expect(shouldUseCursor("SELECT 'INTO the woods' AS a FROM t")).toBe(
      true,
    );
  });

  it("finding 4 guard: plain SELECT without INTO is unaffected", () => {
    expect(shouldUseCursor("SELECT * FROM t")).toBe(true);
  });
});

// ---- D5: PostgresAdapter.runQuery routing ----------------------------------

describe("PostgresAdapter.runQuery — cursor routing (D5)", () => {
  it("Happy: plain SELECT → cursor path ({results: [], batched})", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.runQuery("SELECT * FROM t");
    expect(result.results).toEqual([]);
    expect(result.batched).toBeDefined();
    expect(poolQueryCalls.length).toBe(0);
    await adapter.close();
  });

  it("Edge (comment) / R (D5): leading comment SELECT → cursor path, not materialized via pool.query", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.runQuery("-- note\nSELECT 1");
    expect(result.batched).toBeDefined();
    expect(result.results).toEqual([]);
    // Regression proof: today's `/^\s*SELECT\b/i` predicate does NOT match
    // this text (it starts with `--`), so runQuery falls through to
    // pool.query() and materializes the whole result set.
    expect(poolQueryCalls.length).toBe(0);
    await adapter.close();
  });

  it("Edge (CTE): WITH … SELECT → cursor path", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.runQuery(
      "WITH x AS (SELECT 1) SELECT * FROM x",
    );
    expect(result.batched).toBeDefined();
    expect(poolQueryCalls.length).toBe(0);
    await adapter.close();
  });

  it("Edge (literal): `;` inside a string literal does not defeat the cursor path", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const result = await adapter.runQuery("SELECT ';' AS a");
    expect(result.batched).toBeDefined();
    expect(poolQueryCalls.length).toBe(0);
    await adapter.close();
  });

  it("Edge (must NOT batch): two statements → non-cursor path, 2 results", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    clientQueryCalls = []; // ignore the connect() probe's own SELECT 1
    const result = await adapter.runQuery("SELECT 1; SELECT 2;");
    expect(result.batched).toBeUndefined();
    expect(result.results.length).toBe(2);
    // Finding #6: multi-statement runs go through ONE checked-out client
    // (`client.query()`), never `pool.query()` per statement.
    expect(poolQueryCalls.length).toBe(0);
    expect(clientQueryCalls.length).toBe(2);
    await adapter.close();
  });

  // Review fix round C, Finding #6 — BLOCKING-adjacent race: `pool.query()`
  // checks out AND releases its client on EACH call, so with `max: 1` a
  // multi-statement run used to hand the single connection back to the pool
  // BETWEEN statements — letting any concurrent `pool.query()` caller
  // (schemaTree background refresh, keywordQualify, AI `run_sql`) land
  // inside a user's open `BEGIN ... COMMIT` and abort it. Verified via
  // `pool.connect()` call count: exactly 1 for the whole multi-statement
  // run (one client held for the duration), not re-acquired per statement.
  it("regression (finding 6): multi-statement run checks out exactly ONE client for the whole batch", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    poolConnectCalls = 0; // ignore the connect() probe from adapter.connect()
    clientQueryCalls = []; // ignore the connect() probe's own SELECT 1
    const result = await adapter.runQuery(
      "BEGIN;\nUPDATE t SET a=1;\nCOMMIT;",
    );
    expect(result.batched).toBeUndefined();
    expect(result.results.length).toBe(3);
    expect(poolConnectCalls).toBe(1);
    expect(poolQueryCalls.length).toBe(0);
    expect(clientQueryCalls.length).toBe(3);
    await adapter.close();
  });

  it("regression (finding 6): the single client is released even when a mid-batch statement throws", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    clientReleaseCalls = 0;
    let threw = false;
    try {
      await adapter.runQuery("BEGIN;\nFORCE_ERROR;\nCOMMIT;");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(clientReleaseCalls).toBeGreaterThanOrEqual(1);
    await adapter.close();
  });

  // Open risk `pg-metadata-vs-transaction-window` (cycle X audit) — a pinned
  // manual-commit client used to be the ONLY pool slot (`max: 1`), so every
  // background metadata call queued behind it and died after
  // connectionTimeoutMillis. Fix: pool opens up to PG_POOL_MAX slots, so while
  // beginTransaction() holds one client, an independent metadata query must be
  // served from another slot WITHOUT waiting for the transaction to finish.
  it("regression (metadata-vs-window): metadata runs on its own slot while a transaction pins another", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    // Hold one client open (as beginTransaction() would).
    const pinned = await adapter.beginTransaction();
    expect(pinned).toBeDefined();
    // Concurrent metadata traffic must NOT queue behind the pinned client —
    // with PG_POOL_MAX slots the second checkout resolves immediately and
    // `pool.query()`-backed this.query() serves listSchemas directly.
    queueMicrotask(() => void pinned.commit());
    await adapter.listSchemas(false);
    await adapter.close();
  });

  // Review fix round C, Finding #1 — end-to-end proof at the runQuery level
  // (not just the pure predicate): a data-modifying CTE must go through the
  // non-cursor (auto-commit, actually runs the UPDATE) path, never through
  // openCursorForStatement's `DECLARE CURSOR` (which Postgres would reject).
  // Finding #6 changed the non-cursor path from `pool.query()` per statement
  // to a single checked-out `client.query()` — assert on `clientQueryCalls`
  // (and that no `pool.query()` happened) accordingly.
  it("regression (finding 1): WITH ... UPDATE ... RETURNING → non-cursor path, never DECLARE CURSOR", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    clientQueryCalls = []; // ignore the connect() probe's own SELECT 1
    const result = await adapter.runQuery(
      "WITH upd AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM upd",
    );
    expect(result.batched).toBeUndefined();
    expect(poolQueryCalls.length).toBe(0);
    expect(clientQueryCalls.length).toBe(1);
    expect(
      clientQueryCalls.some((c) => /^DECLARE/i.test(String(c))),
    ).toBe(false);
    await adapter.close();
  });
});

// ---- D4: PostgresAdapter.listColumns — pg_catalog rewrite ------------------

describe("PostgresAdapter.listColumns — pg_catalog rewrite (D4)", () => {
  function makeAdapterWithQuery(
    responses: Array<{ rows: unknown[] }>,
  ): { adapter: PostgresAdapter; query: ReturnType<typeof vi.fn> } {
    const adapter = new PostgresAdapter(cfg(), "pw");
    let i = 0;
    const query = vi.fn(() => Promise.resolve(responses[i++]));
    (adapter as unknown as { query: unknown }).query = query;
    return { adapter, query };
  }

  it("R (D4): pg_catalog only (zero information_schema refs), ::regclass at most once, identical ColumnInfo[] shape", async () => {
    const { adapter, query } = makeAdapterWithQuery([
      {
        rows: [
          { column_name: "id", format_type: "integer", is_nullable: "NO" },
          { column_name: "name", format_type: "text", is_nullable: "YES" },
        ],
      },
      { rows: [{ column_name: "id" }] },
    ]);

    const cols = await adapter.listColumns("users", "public");

    expect(cols).toEqual([
      { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "text", nullable: true },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    const allSql = query.mock.calls
      .map((c) => c[0] as string)
      .join("\n");
    expect(allSql).not.toMatch(/information_schema/i);
    const regclassCount = (allSql.match(/::regclass/g) ?? []).length;
    expect(regclassCount).toBeLessThanOrEqual(1);
  });
});

// ---- D2: estimateTableRowsBatch — Postgres ---------------------------------

describe("PostgresAdapter.estimateTableRowsBatch (D2)", () => {
  it("Happy: 3 tables → 1 query, Map with 3 entries", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    const query = vi.fn().mockResolvedValue({
      rows: [
        { relname: "a", row_estimate: "10" },
        { relname: "b", row_estimate: "20" },
        { relname: "c", row_estimate: "30" },
      ],
    });
    (adapter as unknown as { query: unknown }).query = query;

    const result = await adapter.estimateTableRowsBatch("public", [
      "a",
      "b",
      "c",
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      new Map([
        ["a", 10],
        ["b", 20],
        ["c", 30],
      ]),
    );
  });

  it("Edge (empty): no tables → no query issued, empty Map", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    const query = vi.fn();
    (adapter as unknown as { query: unknown }).query = query;

    const result = await adapter.estimateTableRowsBatch("public", []);

    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual(new Map());
  });

  it("Edge (missing): table dropped between list and estimate → omitted from Map, no throw", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    const query = vi.fn().mockResolvedValue({
      rows: [{ relname: "a", row_estimate: "10" }],
    });
    (adapter as unknown as { query: unknown }).query = query;

    const result = await adapter.estimateTableRowsBatch("public", [
      "a",
      "ghost",
    ]);

    expect(result).toEqual(new Map([["a", 10]]));
    expect(result.has("ghost")).toBe(false);
  });
});

// ---- D2: estimateTableRowsBatch — MySQL ------------------------------------

describe("MySqlAdapter.estimateTableRowsBatch (D2)", () => {
  it("Happy: 3 tables → 1 query, Map with 3 entries", async () => {
    const adapter = new MySqlAdapter(cfg("mysql"), "pw");
    const query = vi.fn().mockResolvedValue({
      rows: [
        { name: "a", row_estimate: 10 },
        { name: "b", row_estimate: 20 },
        { name: "c", row_estimate: 30 },
      ],
      durationMs: 0,
    });
    (adapter as unknown as { query: unknown }).query = query;

    const result = await adapter.estimateTableRowsBatch("app", [
      "a",
      "b",
      "c",
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      new Map([
        ["a", 10],
        ["b", 20],
        ["c", 30],
      ]),
    );
  });

  it("Edge (empty): no tables → no query issued, empty Map", async () => {
    const adapter = new MySqlAdapter(cfg("mysql"), "pw");
    const query = vi.fn();
    (adapter as unknown as { query: unknown }).query = query;

    const result = await adapter.estimateTableRowsBatch("app", []);

    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual(new Map());
  });
});

// ---- D6 + D2: MsSqlAdapter — listColumns rewrite + estimateTableRowsBatch --

describe("MsSqlAdapter.listColumns — single round trip, no correlated EXISTS (D6)", () => {
  it("one query, zero EXISTS, one LEFT JOIN, identical ColumnInfo[] shape", async () => {
    const adapter = new MsSqlAdapter(cfg("mssql"), "pw");
    const execute = vi.fn().mockResolvedValue({
      columns: ["name", "dataType", "nullable", "isPrimaryKey"],
      rows: [
        ["id", "int", 0, 1],
        ["name", "nvarchar", 1, 0],
      ],
      rowCount: 2,
      durationMs: 0,
    });
    (adapter as unknown as { execute: unknown }).execute = execute;

    const cols = await adapter.listColumns("users", "dbo");

    expect(cols).toEqual([
      { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "nvarchar", nullable: true },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/EXISTS/i);
    expect(sql).toMatch(/LEFT JOIN/i);
  });

  it("Edge (quoting): listColumns(\"O'Brien\", \"dbo\") binds the name as a typed parameter, never into the SQL text (TASK-002)", async () => {
    const adapter = new MsSqlAdapter(cfg("mssql"), "pw");
    const execute = vi.fn().mockResolvedValue({
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
    });
    (adapter as unknown as { execute: unknown }).execute = execute;

    await adapter.listColumns("O'Brien", "dbo");

    const sql = execute.mock.calls[0][0] as string;
    // TASK-002 replaced `this.literal()` interpolation with typed
    // parameters — the quote-bearing value must never appear in the SQL
    // text (neither raw nor ''-escaped); it travels as @table.
    expect(sql).not.toContain("O'Brien");
    expect(sql).not.toContain("O''Brien");
    expect(sql).toContain("@table");
    const params = execute.mock.calls[0][1] as Array<{
      name: string;
      value: unknown;
    }>;
    expect(params).toContainEqual(
      expect.objectContaining({ name: "table", value: "O'Brien" }),
    );
  });
});

describe("MsSqlAdapter.estimateTableRowsBatch (D2)", () => {
  it("Happy: 3 tables → 1 query, Map with 3 entries", async () => {
    const adapter = new MsSqlAdapter(cfg("mssql"), "pw");
    const execute = vi.fn().mockResolvedValue({
      columns: ["name", "row_count"],
      rows: [
        ["a", 10],
        ["b", 20],
        ["c", 30],
      ],
      rowCount: 3,
      durationMs: 0,
    });
    (adapter as unknown as { execute: unknown }).execute = execute;

    const result = await adapter.estimateTableRowsBatch("dbo", [
      "a",
      "b",
      "c",
    ]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      new Map([
        ["a", 10],
        ["b", 20],
        ["c", 30],
      ]),
    );
  });

  it("Edge (empty): no tables → no query issued, empty Map", async () => {
    const adapter = new MsSqlAdapter(cfg("mssql"), "pw");
    const execute = vi.fn();
    (adapter as unknown as { execute: unknown }).execute = execute;

    const result = await adapter.estimateTableRowsBatch("dbo", []);

    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// TASK-005 M1/M3 — MySqlAdapter.query() checkout shape + streaming end-settle.
//
// These tests use a real MySqlAdapter instance with a mock promise pool
// injected over the private `pool` field (the same instance-level shadowing
// pattern used above). The mock records `pool.query` calls (which must NEVER
// happen post-M1) and per-connection `query`/`release` calls.
// ---------------------------------------------------------------------------

interface MockMysqlConnection {
  queries: Array<{ sql: string; values?: unknown[] }>;
  releases: number;
  query: (sql: unknown, values?: unknown) => Promise<[unknown[], unknown[]]>;
  release: () => void;
  destroy: () => void;
  ping: () => Promise<void>;
}

function mockMysqlConnection(
  queryImpl?: (sql: string) => Promise<[unknown[], unknown[]]>,
): MockMysqlConnection {
  const conn: MockMysqlConnection = {
    queries: [],
    releases: 0,
    destroy: () => undefined,
    query: (sql, values) => {
      const text = String(sql);
      conn.queries.push({
        sql: text,
        values: Array.isArray(values) ? values : undefined,
      });
      if (queryImpl) return queryImpl(text);
      return Promise.resolve([[{ name: "app" }], []]);
    },
    release: () => {
      conn.releases += 1;
    },
    ping: () => Promise.resolve(),
  };
  return conn;
}

interface MockMysqlPool {
  getConnection: () => Promise<{ connection: MockMysqlConnection } & MockMysqlConnection>;
  query: ReturnType<typeof vi.fn>;
  end: () => Promise<void>;
  swapConnection(conn: MockMysqlConnection): void;
}

function mockMysqlPool(connection: MockMysqlConnection): MockMysqlPool {
  let current = connection;
  const pool: MockMysqlPool = {
    getConnection: () => Promise.resolve(current),
    query: vi.fn(() => {
      throw new Error("pool.query must never be reached (TASK-005 M1)");
    }),
    end: () => Promise.resolve(),
    swapConnection: (conn) => {
      current = conn;
    },
  };
  return pool;
}

function mysqlAdapterWithPool(pool: MockMysqlPool): MySqlAdapter {
  const adapter = new MySqlAdapter(cfg("mysql"), "pw");
  (adapter as unknown as { pool: unknown }).pool = pool;
  return adapter;
}

describe("MySqlAdapter.query() — checkout/release shape (TASK-005 M1, cases 9-10)", () => {
  // Case 9 — regression (M1): query() checks out and always releases
  it("case 9: listSchemas() checks out once, runs SQL through connection.query, releases once; pool.query never called", async () => {
    const connection = mockMysqlConnection();
    let checkoutCount = 0;
    const pool = mockMysqlPool(connection);
    const typedPool = pool as unknown as {
      getConnection: () => Promise<unknown>;
    };
    const original = typedPool.getConnection.bind(typedPool);
    typedPool.getConnection = () => {
      checkoutCount += 1;
      return original();
    };
    const adapter = mysqlAdapterWithPool(pool);

    const schemas = await adapter.listSchemas(false);

    expect(checkoutCount).toBe(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(connection.queries.length).toBe(2);
    expect(connection.queries[0].sql).toBe("SET time_zone = '+00:00'");
    expect(connection.queries[1].sql).toMatch(/information_schema\.schemata/);
    expect(connection.releases).toBe(1);
    expect(schemas.map((s) => s.name)).toEqual(["app"]);
  });

  // Case 10 — edge (failure/cleanup, M1): rejecting query still releases
  it("case 10: a rejecting connection.query still releases the checkout exactly once", async () => {
    const failure = new Error("forced connection query failure");
    const connection = mockMysqlConnection(() =>
      Promise.reject(failure),
    );
    const pool = mockMysqlPool(connection);
    const adapter = mysqlAdapterWithPool(pool);

    let caught: unknown;
    try {
      await adapter.listSchemas(false);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(failure);
    expect(connection.releases).toBe(1);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("MySqlAdapter.openStreamingQuery — stream end handling (TASK-005 M3, cases 11-12)", () => {
  function fakeStream(
    script: Array<{ event: string; payload?: unknown }>,
  ): {
    stream: {
      once: (event: string, cb: (payload?: unknown) => void) => void;
      on: (event: string, cb: (payload?: unknown) => void) => void;
      destroy: () => void;
      pause: () => void;
      resume: () => void;
    };
    run: () => void;
    destroyed: () => number;
  } {
    const listeners = new Map<string, Array<(payload?: unknown) => void>>();
    let destroyedCount = 0;
    const stream = {
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
        destroyedCount += 1;
      },
      pause: () => undefined,
      resume: () => undefined,
    };
    const run = () => {
      for (const step of script) {
        for (const cb of [...(listeners.get(step.event) ?? [])]) {
          cb(step.payload);
        }
      }
    };
    return { stream, run, destroyed: () => destroyedCount };
  }

  function runQueryAdapter(
    connection: MockMysqlConnection,
    script: Array<{ event: string; payload?: unknown }>,
  ): { promise: Promise<unknown>; fake: ReturnType<typeof fakeStream> } {
    const fake = fakeStream(script);
    // The streaming path reaches the CORE connection (`wrapper.connection`)
    // and calls query({sql, rowsAsArray, timeout}) whose result .stream() is
    // the fake. Extend the mock wrapper with a core shape.
    const coreQueryResult = { stream: () => fake.stream };
    const core = {
      query: () => coreQueryResult,
    };
    const wrapper = Object.assign(Object.create(Object.getPrototypeOf(connection)), connection, {
      connection: core,
    });
    void wrapper;
    const pool = mockMysqlPool(connection as unknown as MockMysqlConnection);
    // Override getConnection to return the wrapper shape with a `.connection`
    // core whose query() yields the fake-streaming result.
    const typedPool = pool as unknown as {
      getConnection: () => Promise<unknown>;
    };
    typedPool.getConnection = () =>
      Promise.resolve(
        Object.assign({}, connection, {
          connection: core,
        }),
      );
    const adapter = mysqlAdapterWithPool(pool);
    const promise = adapter.runQuery("SELECT 1");
    // `getConnection()` and the stream setup both cross promise turns; run
    // the scripted events on the next macrotask, after all listeners exist.
    setTimeout(fake.run, 0);
    return { promise, fake };
  }

  // Case 11 — edge (pathological stream, M3): end without fields resolves empty
  it("case 11: a stream emitting only 'end' resolves with columns [] and a null first fetchBatch, without hanging", async () => {
    const connection = mockMysqlConnection();
    const { promise } = runQueryAdapter(connection, [{ event: "end" }]);

    // Must settle WITHOUT any test timeout — if firstFields never resolves,
    // this await itself would hang and vitest's default timeout would fail
    // the test (the RED state).
    const result = (await promise) as {
      batched: {
        columns: string[];
        fetchBatch: () => Promise<unknown[] | null>;
      };
    };
    expect(result.batched.columns).toEqual([]);
    expect(await result.batched.fetchBatch()).toBeNull();
    expect(connection.releases).toBe(1);
  });

  // Case 12 — edge (ordering, M3): fields still wins; error first still rejects
  it("case 12a: fields-then-rows-then-end yields the real column names, not []", async () => {
    const connection = mockMysqlConnection();
    const { promise } = runQueryAdapter(connection, [
      { event: "fields", payload: [{ name: "id" }, { name: "name" }] },
      { event: "data", payload: [1, "a"] },
      { event: "end" },
    ]);
    const result = (await promise) as {
      batched: { columns: string[]; fetchBatch: () => Promise<unknown[][] | null> };
    };
    expect(result.batched.columns).toEqual(["id", "name"]);
    const batch = await result.batched.fetchBatch();
    expect(batch).toEqual([[1, "a"]]);
    expect(await result.batched.fetchBatch()).toBeNull();
  });

  it("case 12b: an error-first stream still rejects and destroys the connection", async () => {
    const connection = mockMysqlConnection();
    const failure = new Error("stream failed before fields");
    const { promise } = runQueryAdapter(connection, [
      { event: "error", payload: failure },
    ]);
    await expect(promise).rejects.toThrow(/stream failed before fields/);
    expect(connection.releases).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TASK-002 M2 — MySqlAdapter.runQuery(): atomic multi-statement batches.
//
// A non-streaming multi-statement batch MUST run on ONE checked-out
// UTC-session PoolConnection wrapped in an explicit transaction: beginTransaction
// → every statement on that same connection → commit on success; rollback +
// rethrow on any failure; release exactly once in finally. The single-SELECT
// streaming arm must stay untouched (no beginTransaction/commit around a
// cursor — it would pin the connectionLimit:1 pool).
//
// Call order is asserted against one shared `log` fed by BOTH the pool
// (getConnection) and the connection (SET time_zone / query:* /
// beginTransaction / commit / rollback / release).
// ---------------------------------------------------------------------------

type TxConn = {
  queries: Array<{ sql: string; values?: unknown[] }>;
  releases: number;
  query: (sql: unknown, values?: unknown) => Promise<[unknown[], unknown[]]>;
  release: () => void;
  destroy: () => void;
  ping: () => Promise<void>;
  beginTransaction: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  connection?: unknown;
};

function mockMysqlTxConnection(
  log: string[],
  queryImpl?: (sql: string) => Promise<unknown>,
): TxConn {
  const conn: TxConn = {
    queries: [],
    releases: 0,
    query: (sql, values) => {
      const text = String(sql);
      conn.queries.push({
        sql: text,
        values: Array.isArray(values) ? values : undefined,
      });
      if (/^SET time_zone/i.test(text)) {
        log.push("SET time_zone");
        return Promise.resolve([[], []]);
      }
      log.push(`query:${text.replace(/\s+/g, " ").trim()}`);
      if (queryImpl) {
        return queryImpl(text) as Promise<[unknown[], unknown[]]>;
      }
      return Promise.resolve([[], []]);
    },
    release: () => {
      conn.releases += 1;
      log.push("release");
    },
    destroy: () => undefined,
    ping: () => Promise.resolve(),
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
  return conn;
}

function mockMysqlTxPool(log: string[], connection: TxConn) {
  return {
    getConnection: () => {
      log.push("getConnection");
      return Promise.resolve(connection);
    },
    query: vi.fn(() => {
      throw new Error("pool.query must never be reached (TASK-002 M2)");
    }),
    end: () => Promise.resolve(),
  };
}

function mysqlAdapterWithTxPool(pool: unknown): MySqlAdapter {
  const adapter = new MySqlAdapter(cfg("mysql"), "pw");
  (adapter as unknown as { pool: unknown }).pool = pool;
  return adapter;
}

describe("MySqlAdapter.runQuery — atomic multi-statement batches (TASK-002 M2)", () => {
  // Case 1 — happy: three-statement DML batch commits once, in order.
  it("happy: three-statement DML batch commits once on a single held connection, results in statement order", async () => {
    const log: string[] = [];
    const affected: Record<string, number> = { INSERT: 1, UPDATE: 2, DELETE: 3 };
    const conn = mockMysqlTxConnection(log, (text) => {
      // mysql2 DML resolves with the ResultSetHeader OK-packet directly,
      // not a row array — `resultRowCount` reads `affectedRows` off it.
      const okPacket = { affectedRows: affected[text.split(" ")[0]] };
      return Promise.resolve([okPacket, []]);
    });
    const pool = mockMysqlTxPool(log, conn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const result = await adapter.runQuery(
      "INSERT INTO t VALUES (1);\nUPDATE t SET a = 2;\nDELETE FROM t WHERE id = 3;",
    );

    expect(log).toEqual([
      "getConnection",
      "SET time_zone",
      "beginTransaction",
      "query:INSERT INTO t VALUES (1)",
      "query:UPDATE t SET a = 2",
      "query:DELETE FROM t WHERE id = 3",
      "commit",
      "release",
    ]);
    expect(result.batched).toBeUndefined();
    // Statement order preserved: 1 insert → 2 updates → 3 deletes.
    expect(result.results.map((r) => r.rowCount)).toEqual([1, 2, 3]);
    expect(conn.releases).toBe(1);
  });

  // Case 2 — edge (failure): statement two rejects → rollback + release, no commit, same error rethrown.
  it("edge: statement-two failure rolls back prior work, never commits, rethrows the original error", async () => {
    const log: string[] = [];
    const boom = new Error("boom");
    const conn = mockMysqlTxConnection(log, (text) =>
      text.startsWith("UPDATE")
        ? Promise.reject(boom)
        : Promise.resolve([[], []]),
    );
    const pool = mockMysqlTxPool(log, conn);
    const adapter = mysqlAdapterWithTxPool(pool);

    let caught: unknown;
    try {
      await adapter.runQuery(
        "INSERT INTO t VALUES (1);\nUPDATE t SET a=2;\nDELETE FROM t WHERE id=3;",
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect(log).toContain("query:INSERT INTO t VALUES (1)");
    expect(log.slice(-3)).toEqual([
      "query:UPDATE t SET a=2",
      "rollback",
      "release",
    ]);
    expect(log).not.toContain("commit");
    expect(conn.releases).toBe(1);
  });

  // Case 3 — regression: single SELECT stays on the streaming arm, byte-for-byte semantics.
  it("regression: single SELECT returns {results:[], batched} and never begins a transaction", async () => {
    const log: string[] = [];
    const conn = mockMysqlTxConnection(log);
    const listeners = new Map<string, Array<(payload?: unknown) => void>>();
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
      destroy: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
    };
    const wrapper = Object.assign(Object.create(Object.getPrototypeOf(conn)), conn, {
      connection: { query: () => ({ stream: () => fakeStream }) },
    });
    const pool = mockMysqlTxPool(log, wrapper as TxConn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const promise = adapter.runQuery("SELECT * FROM t");
    // Stream listeners attach after async checkout crosses a few turns; run
    // the scripted 'end' on the next macrotask (same pattern as case 11).
    setTimeout(() => {
      for (const cb of [...(listeners.get("end") ?? [])]) cb();
    }, 0);
    const result = await promise;

    expect(result.results).toEqual([]);
    expect(result.batched).toBeDefined();
    expect(log).toContain("getConnection");
    expect(log).toContain("SET time_zone");
    expect(log).not.toContain("beginTransaction");
    expect(log).not.toContain("commit");
    // No statement other than the UTC session preamble ever ran.
    expect(log.some((entry) => entry.startsWith("query:SELECT"))).toBe(false);
  });

  // Case 4 — boundary/pool ownership: the multi-statement arm never touches pool.query.
  it("edge: a two-statement batch resolves through ONLY the checked-out connection (pool.query unreachable)", async () => {
    const log: string[] = [];
    const conn = mockMysqlTxConnection(log);
    const pool = mockMysqlTxPool(log, conn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const result = await adapter.runQuery("UPDATE t SET a=1;\nDELETE FROM t;");

    expect(result.results.length).toBe(2);
    expect(pool.query).not.toHaveBeenCalled();
    // Exactly ONE checkout for the whole batch — not one per statement.
    expect(log.filter((entry) => entry === "getConnection")).toHaveLength(1);
    expect(conn.releases).toBe(1);
  });

  // Case 5 — boundary/empty: whitespace/semicolon-only input short-circuits.
  it("edge: whitespace/semicolon-only input returns {results:[]} without checking out a connection", async () => {
    const log: string[] = [];
    const conn = mockMysqlTxConnection(log);
    const pool = mockMysqlTxPool(log, conn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const result = await adapter.runQuery("   \n ;\n  ");

    expect(result).toEqual({ results: [] });
    expect(log).toEqual([]);
    expect(conn.releases).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TASK-RLX02-001 — MySqlAdapter.cancelActiveQuery(): live-ownership registry.
//
//   Goal: cancel live work through the EXISTING destruction primitive
//   (PoolConnection.destroy / stream.destroy) without closing the adapter
//   or pool. Two ownership windows exist in MySqlAdapter.runQuery:
//     1. Non-stream: one held connection (transaction-bound) between
//        getConnectionWithUtcSession() and the runQuery finally block.
//     2. Pre-handoff stream: between coreConnection.query({…}).stream()
//        and the `await firstFields` resolution that hands the
//        BatchedQuery to QueryRunner.
//
//   After each window closes (success, failure, or cancellation), the
//   record is removed so any later cancelActiveQuery() is a silent no-op.
//   BatchedQuery.cancel() remains the exclusive post-handoff cursor seam.
// ---------------------------------------------------------------------------

describe("MySqlAdapter.cancelActiveQuery — live non-cursor ownership (TASK-RLX02-001, case 1)", () => {
  it("case 1: cancelActiveQuery destroys one live non-streaming held connection exactly once", async () => {
    const log: string[] = [];
    // Defer the UPDATE so the test can observe the in-flight window.
    let resolveQuery: ((value: [unknown[], unknown[]]) => void) | undefined;
    let rejectQuery: ((error: Error) => void) | undefined;
    const deferred = new Promise<[unknown[], unknown[]]>((resolve, reject) => {
      resolveQuery = resolve;
      rejectQuery = reject;
    });
    const conn = mockMysqlTxConnection(log, (text) => {
      if (text.startsWith("UPDATE")) return deferred;
      return Promise.resolve([[], []]);
    });
    let destroyCount = 0;
    conn.destroy = () => {
      destroyCount += 1;
      // Simulate the real mysql2 behavior: destroy() rejects the in-flight
      // query promise so the awaited `connection.query()` unblocks and the
      // run can settle (catch → rollback → release path).
      rejectQuery?.(new Error("connection destroyed"));
    };
    let endCount = 0;
    const pool = mockMysqlTxPool(log, conn);
    const originalEnd = pool.end;
    pool.end = () => {
      endCount += 1;
      return originalEnd();
    };
    const adapter = mysqlAdapterWithTxPool(pool);

    const runPromise = adapter.runQuery("UPDATE t SET a = 1");
    // Let runQuery reach the deferred UPDATE.
    await new Promise((r) => setTimeout(r, 30));

    expect(destroyCount).toBe(0);
    expect(log).toContain("beginTransaction");
    expect(log).not.toContain("commit");
    expect(log).not.toContain("release");

    const connReleasesBefore = conn.releases;
    await adapter.cancelActiveQuery!();

    // Cancel must call connection.destroy() exactly once and must NOT
    // touch pool.end() or close(). release() is the success-path primitive
    // and must not be used as a cancellation fallback.
    expect(destroyCount).toBe(1);
    expect(endCount).toBe(0);
    expect(conn.releases).toBe(connReleasesBefore);

    // The run must subsequently settle (we don't care whether the runner
    // surfaces it as cancelled or error — the adapter just lets the
    // await throw). The key invariant is that the run does not hang and
    // does not double-release.
    await runPromise.catch(() => undefined);
    // Case 3 invariant: a late repeat cancel is a no-op.
    const before = destroyCount;
    await adapter.cancelActiveQuery!();
    await adapter.cancelActiveQuery!();
    expect(destroyCount).toBe(before);
  });
});

describe("MySqlAdapter.cancelActiveQuery — pre-handoff stream ownership (TASK-RLX02-001, case 2)", () => {
  it("case 2: cancel during pre-handoff stream setup destroys the exact stream and connection once", async () => {
    const log: string[] = [];
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
        // Simulate mysql2 stream destroy → emits 'error' so the
        // firstFields promise rejects (or 'close' for end-like semantics).
        // Either is enough; 'error' lets the await throw cleanly.
        for (const cb of [...(listeners.get("error") ?? [])]) {
          cb(new Error("stream destroyed"));
        }
      },
      pause: () => undefined,
      resume: () => undefined,
    };
    const conn = mockMysqlTxConnection(log);
    let connDestroyed = 0;
    conn.destroy = () => {
      connDestroyed += 1;
    };
    const wrapper = Object.assign(Object.create(Object.getPrototypeOf(conn)), conn, {
      connection: { query: () => ({ stream: () => fakeStream }) },
    });
    const pool = mockMysqlTxPool(log, wrapper as TxConn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const runPromise = adapter.runQuery("SELECT 1");
    // `fields` is intentionally NEVER emitted. The adapter is parked on
    // `await firstFields`, with currentBatched still null. cancel() at
    // this moment must reach the stream+connection via the seam.
    await new Promise((r) => setTimeout(r, 30));

    // The listener-attached 'destroy' function may already have fired
    // because the runQuery call attaches a 'destroy' handler via
    // stream.destroy? No — the stream only gets destroyed if the seam
    // fires. Listeners are attached but the stream is still live.
    expect(streamDestroyed).toBe(0);
    expect(connDestroyed).toBe(0);

    await adapter.cancelActiveQuery!();

    expect(streamDestroyed).toBe(1);
    expect(connDestroyed).toBe(1);

    // The run must subsequently settle (BatchedQuery may surface as
    // cancelled/error/empty — we only assert non-pending).
    await runPromise.catch(() => undefined);
    // No fetch waiter should remain unresolved: any openStreamingQuery
    // waiter would have been resolved (null) by closeStream's sweep.
    // We can assert: a second cancel is a no-op (case 3 invariant).
    const sBefore = streamDestroyed;
    const cBefore = connDestroyed;
    await adapter.cancelActiveQuery!();
    expect(streamDestroyed).toBe(sBefore);
    expect(connDestroyed).toBe(cBefore);
  });
});

describe("MySqlAdapter.cancelActiveQuery — late/repeated cancel no-op (TASK-RLX02-001, case 3)", () => {
  it("case 3a: cancel after a successful non-stream run is a no-op", async () => {
    const log: string[] = [];
    const conn = mockMysqlTxConnection(log);
    let destroyCount = 0;
    conn.destroy = () => {
      destroyCount += 1;
    };
    const pool = mockMysqlTxPool(log, conn);
    let endCount = 0;
    const originalEnd = pool.end;
    pool.end = () => {
      endCount += 1;
      return originalEnd();
    };
    const adapter = mysqlAdapterWithTxPool(pool);

    await adapter.runQuery("UPDATE t SET a = 1");
    expect(log).toContain("commit");
    expect(log).toContain("release");

    const releasesBefore = conn.releases;
    const endBefore = endCount;

    await adapter.cancelActiveQuery!();
    await adapter.cancelActiveQuery!();

    // Late cancel must not destroy, release again, or call pool.end.
    expect(destroyCount).toBe(0);
    expect(conn.releases).toBe(releasesBefore);
    expect(endCount).toBe(endBefore);
  });

  it("case 3b-pre: naturally-rejected non-stream run + double cancel: no extra destroy/release/pool-end", async () => {
    const log: string[] = [];
    const conn = mockMysqlTxConnection(log, () =>
      Promise.reject(new Error("simulated query failure")),
    );
    let destroyCount = 0;
    conn.destroy = () => {
      destroyCount += 1;
    };
    const pool = mockMysqlTxPool(log, conn);
    let endCount = 0;
    const originalEnd = pool.end;
    pool.end = () => {
      endCount += 1;
      return originalEnd();
    };
    const adapter = mysqlAdapterWithTxPool(pool);

    // The main query rejects naturally (SET time_zone still resolves first;
    // a DML statement keeps the run on the non-stream transaction path), so
    // the adapter's terminal failure cleanup runs before cancel is called.
    await expect(adapter.runQuery("UPDATE t SET a = 1")).rejects.toThrow(
      /simulated query failure/,
    );

    const destroyBefore = destroyCount;
    const releasesBefore = conn.releases;
    const endBefore = endCount;

    await adapter.cancelActiveQuery!();
    await adapter.cancelActiveQuery!();

    // Terminal query-failure cleanup must not be repeated by either cancel
    // call: no destroy, no extra release, no pool.end.
    expect(destroyCount).toBe(destroyBefore);
    expect(conn.releases).toBe(releasesBefore);
    expect(endCount).toBe(endBefore);
  });

  it("case 3b: cancel after a stream end is a no-op (BatchedQuery takes over)", async () => {
    const log: string[] = [];
    const listeners = new Map<string, Array<(payload?: unknown) => void>>();
    let fakeStreamDestroys = 0;
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
        fakeStreamDestroys += 1;
      },
      pause: () => undefined,
      resume: () => undefined,
    };
    const conn = mockMysqlTxConnection(log);
    const wrapper = Object.assign(Object.create(Object.getPrototypeOf(conn)), conn, {
      connection: { query: () => ({ stream: () => fakeStream }) },
    });
    const pool = mockMysqlTxPool(log, wrapper as TxConn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const promise = adapter.runQuery("SELECT 1");
    // Emit 'end' so firstFields resolves (empty-result success).
    setTimeout(() => {
      for (const cb of [...(listeners.get("end") ?? [])]) cb();
    }, 0);
    const result = (await promise) as { batched: { fetchBatch(): Promise<unknown> } };
    expect(result.batched).toBeDefined();
    // Drain to EOF.
    expect(await result.batched.fetchBatch()).toBeNull();

    // After the stream has reached EOF and been delivered to the runner,
    // any cancelActiveQuery() must be a no-op (record removed by the
    // stream end path). One or two calls must NOT call destroy/release.
    const beforeDestroys = fakeStreamDestroys;
    const beforeReleases = conn.releases;
    await adapter.cancelActiveQuery!();
    await adapter.cancelActiveQuery!();
    expect(conn.releases).toBe(beforeReleases);
    expect(fakeStreamDestroys).toBe(beforeDestroys);
  });
});

// ---------------------------------------------------------------------------
// TASK-ARP05-002 case 1 — runQuery routing/shape regression (DB-free, pure
// routing assertion via the monkeypatched private openStreamingQuery/query
// seam, same instance-level shadowing pattern as above; no mysql2 mock).
//   - a single SELECT routes to the streaming arm → { results: [], batched };
//   - a multi-statement batch holds ONE connection atomically (existing M2
//     pins above cover the call order; here we pin the ROUTING split).
// ---------------------------------------------------------------------------

describe("MySqlAdapter.runQuery — routing/shape (TASK-ARP05-002 case 1)", () => {
  it("case 1a: single-SELECT routes to streaming → {results: [], batched}, never materialized via query()", async () => {
    const adapter = new MySqlAdapter(cfg("mysql"), "pw");
    // runQuery guards on the pool field; inject a stand-in so the guard
    // passes (the routing seams below bypass it entirely).
    (adapter as unknown as { pool: unknown }).pool = {};
    // Monkeypatch BOTH private seams: `openStreamingQuery` (the streaming arm)
    // and `query` (the materializing arm) — the routing assertion is that a
    // bare single SELECT reaches ONLY the streaming arm.
    const openStreaming = vi.fn(() =>
      Promise.resolve({
        columns: ["id"],
        fetchBatch: () => Promise.resolve(null),
        cancel: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    );
    const materializingQuery = vi.fn(() => {
      throw new Error("routing bug: single SELECT must never materialize");
    });
    (adapter as unknown as { openStreamingQuery: unknown }).openStreamingQuery =
      openStreaming;
    (adapter as unknown as { query: unknown }).query = materializingQuery;

    const result = await adapter.runQuery("SELECT * FROM t");

    expect(result.results).toEqual([]);
    expect(result.batched).toBeDefined();
    expect(openStreaming).toHaveBeenCalledTimes(1);
    expect(materializingQuery).not.toHaveBeenCalled();
  });

  it("case 1b: a multi-statement batch routes to the atomic transaction arm (batched undefined)", async () => {
    const adapter = new MySqlAdapter(cfg("mysql"), "pw");
    // runQuery guards on the pool field; inject a stand-in so the guard
    // passes (the checked-out connection below is monkeypatched anyway).
    (adapter as unknown as { pool: unknown }).pool = {};
    // The atomic arm runs on a checked-out PoolConnection (not this.query).
    // Monkeypatch runQueryOnConnection to observe the statements on the one
    // held connection without needing mysql2.
    const runOnConn = vi.fn(() =>
      Promise.resolve({ results: [{ columns: [], rows: [], rowCount: 1, durationMs: 0 }] }),
    );
    (adapter as unknown as { runQueryOnConnection: unknown }).runQueryOnConnection =
      runOnConn;
    // getConnectionWithUtcSession must hand back a minimal transactional
    // connection: beginTransaction/commit/rollback/release once each.
    const txConn = {
      beginTransaction: vi.fn(() => Promise.resolve()),
      commit: vi.fn(() => Promise.resolve()),
      rollback: vi.fn(() => Promise.resolve()),
      release: vi.fn(),
    };
    (adapter as unknown as { getConnectionWithUtcSession: unknown }).getConnectionWithUtcSession =
      vi.fn(() => Promise.resolve(txConn));

    const result = await adapter.runQuery("UPDATE t SET a=1; DELETE FROM t;");

    expect(result.batched).toBeUndefined();
    expect(result.results.length).toBe(2);
    expect(txConn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(txConn.commit).toHaveBeenCalledTimes(1);
    expect(txConn.release).toHaveBeenCalledTimes(1);
    expect(runOnConn).toHaveBeenCalledTimes(2);
  });
});

// Helper used by case 3a to snapshot the baseline release count.
describe("MySqlAdapter.runQuery — single-SELECT BatchedQuery regression (TASK-RLX02-001, case 4)", () => {
  it("case 4: single SELECT returns {results:[], batched} and its BatchedQuery.cancel destroys the stream", async () => {
    const log: string[] = [];
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
    const conn = mockMysqlTxConnection(log);
    const wrapper = Object.assign(Object.create(Object.getPrototypeOf(conn)), conn, {
      connection: { query: () => ({ stream: () => fakeStream }) },
    });
    const pool = mockMysqlTxPool(log, wrapper as TxConn);
    const adapter = mysqlAdapterWithTxPool(pool);

    const promise = adapter.runQuery("SELECT * FROM t");
    // Emit fields → firstFields resolves → BatchedQuery returned.
    setTimeout(() => {
      for (const cb of [...(listeners.get("fields") ?? [])]) {
        cb([{ name: "id" }, { name: "name" }]);
      }
    }, 0);
    const result = await promise;
    expect(result.results).toEqual([]);
    expect(result.batched).toBeDefined();
    // No transaction was opened.
    expect(log).not.toContain("beginTransaction");
    // The BatchedQuery's own cancel must destroy the stream — the
    // established cursor-handle seam is preserved.
    await result.batched!.cancel();
    expect(streamDestroyed).toBe(1);
  });
});
