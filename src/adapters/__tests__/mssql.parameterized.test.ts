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
