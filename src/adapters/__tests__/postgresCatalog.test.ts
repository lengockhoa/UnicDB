// src/adapters/__tests__/postgresCatalog.test.ts
//
// TASK-AF-001 tests 10-12 — PostgresAdapter.catalog capability:
// - adapter exposes a `catalog` field that wires to pgCatalog SQL templates
//   via the existing pool.query path.
// - mysql / mssql adapters don't define `catalog` (degrade gracefully).
// - `catalog.objectDdl` rejects with a structured error when pg_get_*
//   returns 0 rows.
//
// Pattern: vi.mock("pg") at top-level — same as postgres.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Pool } from "pg";
import type { ConnectionConfig } from "../../config/types";
import { PostgresAdapter } from "../postgres";

interface FakePool {
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const queue: Array<{ rows: unknown[] }> = [];

function popNext(): Promise<{ rows: unknown[] }> {
  const next = queue.shift();
  if (!next) {
    return Promise.reject(new Error("pg mock: queue empty"));
  }
  return Promise.resolve(next);
}

vi.mock("pg", () => {
  const fakeClient = { query: vi.fn(() => popNext()), release: vi.fn() };
  const fakePool: FakePool = {
    query: vi.fn(() => popNext()),
    connect: vi.fn(() => Promise.resolve(fakeClient)),
    end: vi.fn(() => Promise.resolve()),
  };
  const PoolCtor = vi.fn(() => fakePool);
  return { Pool: PoolCtor };
});

function cfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "t",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    user: "u",
    database: "d",
  };
}

beforeEach(() => {
  queue.length = 0;
});

function lastPool(): FakePool {
  const ctor = Pool as unknown as {
    mock: { results: Array<{ value: unknown }> };
  };
  return ctor.mock.results[ctor.mock.results.length - 1]
    ?.value as FakePool;
}

describe("PostgresAdapter — catalog (TASK-AF-001 tests 10-12)", () => {
  it("exposes `catalog` with all 6 methods (test 10)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        {
          indexname: "idx_a",
          schemaname: "public",
          tablename: "t",
          indexdef:
            "CREATE UNIQUE INDEX idx_a ON public.t USING btree (a)",
        },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    expect(adapter.catalog).toBeDefined();
    expect(typeof adapter.catalog!.listIndexes).toBe("function");
    expect(typeof adapter.catalog!.listConstraints).toBe("function");
    expect(typeof adapter.catalog!.listTriggers).toBe("function");
    expect(typeof adapter.catalog!.listSequences).toBe("function");
    expect(typeof adapter.catalog!.rowCount).toBe("function");
    expect(typeof adapter.catalog!.objectDdl).toBe("function");

    const indexes = await adapter.catalog!.listIndexes("public", "t");
    expect(indexes).toEqual([
      {
        name: "idx_a",
        schema: "public",
        table: "t",
        isUnique: true,
        method: "btree",
        columns: ["a"],
      },
    ]);
    await adapter.close();
  });

  it("rowCount runs pool.query and returns the number (test 10 happy)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [{ n: "176" }] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const n = await adapter.catalog!.rowCount("public", "t");
    expect(n).toBe(176);
    await adapter.close();
  });

  it("objectDdl on nonexistent object → rejects with structured error (test 11)", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [] }); // pg_get_viewdef → 0 rows ⇒ object not found
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    await expect(
      adapter.catalog!.objectDdl("view", "ghost", "public"),
    ).rejects.toThrow(/pgCatalog\.|not found/i);
    await adapter.close();
  });

  it("objectDdl on existing object → returns the pg_get_* text", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [{ ddl: "CREATE VIEW public.v AS SELECT 1" }],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const text = await adapter.catalog!.objectDdl("view", "v", "public");
    expect(text).toBe("CREATE VIEW public.v AS SELECT 1");
    await adapter.close();
  });

  it("adapter.listColumns() (existing surface) still works after catalog wired in (regression)", async () => {
    // Sanity: catalog addition MUST NOT regress existing methods.
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        { column_name: "id", format_type: "bigint", is_nullable: "NO" },
      ],
    });
    queue.push({ rows: [] }); // no PK rows
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const cols = await adapter.listColumns("t", "public");
    expect(cols).toEqual([{ name: "id", dataType: "bigint", nullable: false }]);
    await adapter.close();
  });

  it("last pool.query is invoked with pgCatalog SQL template + array params", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({ rows: [] });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    await adapter.catalog!.listIndexes("public", "users");
    const lastCall = lastPool().query.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    expect(lastCall[1]).toEqual(["public", "users"]);
    expect(lastCall[0]).toContain("pg_indexes");
    await adapter.close();
  });

  // ---- DBX06-005 — renameUsage.triggers + renameUsage.indexes --------------

  it("renameUsage.triggers (table mode) binds [schema, table, ''] and maps rows", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        {
          tgname: "trg_audit",
          tgtype: 7, // ROW | BEFORE | INSERT
          tgrelid: "public.users",
        },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const out = await adapter.renameUsage!.triggers("public", "users", "");
    expect(out).toEqual([
      { name: "trg_audit", event: "INSERT", timing: "BEFORE" },
    ]);
    const lastCall = lastPool().query.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    expect(lastCall[1]).toEqual(["public", "users", ""]);
    expect(lastCall[0]).toMatch(/\$1/);
    expect(lastCall[0]).toMatch(/\$2/);
    expect(lastCall[0]).toMatch(/\$3/);
    expect(lastCall[0]).toContain("tgattr");
    await adapter.close();
  });

  it("renameUsage.triggers (column mode) binds [schema, table, column]", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        {
          tgname: "trg_full",
          tgtype: 19, // ROW | BEFORE | UPDATE
          tgrelid: "public.users",
        },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const out = await adapter.renameUsage!.triggers(
      "public",
      "users",
      "full_name",
    );
    expect(out[0]).toMatchObject({
      name: "trg_full",
      event: "UPDATE",
      timing: "BEFORE",
    });
    const lastCall = lastPool().query.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    expect(lastCall[1]).toEqual(["public", "users", "full_name"]);
    await adapter.close();
  });

  it("renameUsage.indexes (table mode) binds [schema, table, ''] and maps rows", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        {
          indexname: "idx_users_name",
          is_primary: false,
          is_unique: false,
          indexdef:
            "CREATE INDEX idx_users_name ON public.users USING btree (name)",
        },
        {
          indexname: "idx_users_pkey",
          is_primary: true,
          is_unique: true,
          indexdef:
            "CREATE UNIQUE INDEX idx_users_pkey ON public.users USING btree (id)",
        },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const out = await adapter.renameUsage!.indexes("public", "users", "");
    expect(out).toEqual([
      { name: "idx_users_name", isPrimary: false, isUnique: false, columns: ["name"] },
      { name: "idx_users_pkey", isPrimary: true, isUnique: true, columns: ["id"] },
    ]);
    const lastCall = lastPool().query.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    expect(lastCall[1]).toEqual(["public", "users", ""]);
    expect(lastCall[0]).toMatch(/\$1/);
    expect(lastCall[0]).toMatch(/\$2/);
    expect(lastCall[0]).toMatch(/\$3/);
    expect(lastCall[0]).toContain("indkey");
    await adapter.close();
  });

  it("renameUsage.indexes (column mode) binds [schema, table, column]", async () => {
    queue.push({ rows: [{ "?column?": 1 }] }); // probe
    queue.push({
      rows: [
        {
          indexname: "idx_email",
          is_primary: false,
          is_unique: true,
          indexdef:
            "CREATE UNIQUE INDEX idx_email ON public.users USING btree (email)",
        },
      ],
    });
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();
    const out = await adapter.renameUsage!.indexes(
      "public",
      "users",
      "email",
    );
    expect(out).toEqual([
      { name: "idx_email", isPrimary: false, isUnique: true, columns: ["email"] },
    ]);
    const lastCall = lastPool().query.mock.calls.at(-1) as unknown as [
      string,
      string[],
    ];
    expect(lastCall[1]).toEqual(["public", "users", "email"]);
    await adapter.close();
  });
});
