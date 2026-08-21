// src/adapters/__tests__/schemas.test.ts
// Unit tests cho listSchemas — TASK-101 §Test Files.
// Mock query layer của từng adapter (private query/execute), spy chuỗi SQL.
import { describe, expect, it, vi } from "vitest";
import { MsSqlAdapter } from "../mssql";
import { MySqlAdapter } from "../mysql";
import { PostgresAdapter } from "../postgres";
import type { ConnectionConfig } from "../../config/types";

function cfg(driver: ConnectionConfig["driver"]): ConnectionConfig {
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

type SqlSpy = ReturnType<typeof vi.fn>;

function makePostgres(rows: Array<{ nspname: string }>): {
  adapter: PostgresAdapter;
  query: SqlSpy;
} {
  const adapter = new PostgresAdapter(cfg("postgres"), "pw");
  const query = vi.fn().mockResolvedValue({ rows });
  (adapter as unknown as { query: unknown }).query = query;
  return { adapter, query };
}

function makeMysql(rows: Array<{ name: string }>): {
  adapter: MySqlAdapter;
  query: SqlSpy;
} {
  const adapter = new MySqlAdapter(cfg("mysql"), "pw");
  const query = vi.fn().mockResolvedValue({ rows });
  (adapter as unknown as { query: unknown }).query = query;
  return { adapter, query };
}

function makeMssql(names: string[]): {
  adapter: MsSqlAdapter;
  execute: SqlSpy;
} {
  const adapter = new MsSqlAdapter(cfg("mssql"), "pw");
  const execute = vi.fn().mockResolvedValue({
    columns: ["name"],
    rows: names.map((name) => [name]),
    rowCount: names.length,
    durationMs: 0,
  });
  (adapter as unknown as { execute: unknown }).execute = execute;
  return { adapter, execute };
}

describe("listSchemas — postgres", () => {
  it("includeSystem=false → SQL có NOT LIKE + <> 'information_schema', rows → SchemaInfo[]", async () => {
    const { adapter, query } = makePostgres([
      { nspname: "public" },
      { nspname: "app" },
    ]);

    const schemas = await adapter.listSchemas(false);

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("NOT LIKE");
    expect(sql).toContain("<> 'information_schema'");
    expect(schemas).toEqual([{ name: "public" }, { name: "app" }]);
  });

  it("includeSystem=true → SQL không chứa điều kiện lọc pg_", async () => {
    const { adapter, query } = makePostgres([
      { nspname: "pg_catalog" },
      { nspname: "public" },
    ]);

    const schemas = await adapter.listSchemas(true);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).not.toContain("NOT LIKE");
    expect(sql).not.toContain("information_schema");
    expect(schemas).toEqual([{ name: "pg_catalog" }, { name: "public" }]);
  });

  it("0 row → resolve []", async () => {
    const { adapter } = makePostgres([]);
    await expect(adapter.listSchemas(false)).resolves.toEqual([]);
  });
});

describe("listSchemas — mysql", () => {
  const systemSchemas = [
    "mysql",
    "information_schema",
    "performance_schema",
    "sys",
  ];

  it("includeSystem=false → loại 4 system schema", async () => {
    const { adapter } = makeMysql([
      { name: "app" },
      { name: "mysql" },
      { name: "information_schema" },
      { name: "performance_schema" },
      { name: "sys" },
      { name: "analytics" },
    ]);

    const schemas = await adapter.listSchemas(false);
    const names = schemas.map((s) => s.name);

    for (const sysName of systemSchemas) {
      expect(names).not.toContain(sysName);
    }
    expect([...names].sort()).toEqual(["analytics", "app"]);
  });

  it("includeSystem=true → giữ system schema", async () => {
    const { adapter } = makeMysql([{ name: "app" }, { name: "mysql" }]);

    const schemas = await adapter.listSchemas(true);

    expect(schemas.map((s) => s.name)).toEqual(["app", "mysql"]);
  });

  it("0 row → resolve []", async () => {
    const { adapter } = makeMysql([]);
    await expect(adapter.listSchemas(false)).resolves.toEqual([]);
  });
});

describe("listSchemas — mssql", () => {
  it("includeSystem=false → loại sys/INFORMATION_SCHEMA/guest/db_*", async () => {
    const { adapter } = makeMssql([
      "dbo",
      "sys",
      "INFORMATION_SCHEMA",
      "guest",
      "db_owner",
      "sales",
    ]);

    const schemas = await adapter.listSchemas(false);
    const names = schemas.map((s) => s.name);

    for (const hidden of ["sys", "INFORMATION_SCHEMA", "guest", "db_owner"]) {
      expect(names).not.toContain(hidden);
    }
    expect([...names].sort()).toEqual(["dbo", "sales"]);
  });

  it("includeSystem=true → giữ system schema", async () => {
    const { adapter } = makeMssql(["dbo", "sys"]);

    const schemas = await adapter.listSchemas(true);

    expect(schemas.map((s) => s.name)).toEqual(["dbo", "sys"]);
  });

  it("0 row → resolve []", async () => {
    const { adapter } = makeMssql([]);
    await expect(adapter.listSchemas(false)).resolves.toEqual([]);
  });
});
