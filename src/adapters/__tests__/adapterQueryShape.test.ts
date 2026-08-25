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

  it("Edge (quoting): listColumns(\"dbo\", \"O'Brien\") emits 'O''Brien' exactly once", async () => {
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
    const matches = sql.match(/'O''Brien'/g) ?? [];
    expect(matches.length).toBe(1);
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
