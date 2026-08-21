// src/adapters/__tests__/mysql.integration.test.ts
// Integration tests for MySqlAdapter. Run only when VSDB_IT=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MySqlAdapter } from "../mysql";

const IT = process.env.VSDB_IT === "1";
const HOST = process.env.VSDB_MYSQL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.VSDB_MYSQL_PORT ?? 3307);
const USER = process.env.VSDB_MYSQL_USER ?? "root";
const PASS = process.env.VSDB_MYSQL_PASS ?? "vsdb";
const DB = process.env.VSDB_MYSQL_DB ?? "vsdb";

function makeAdapter(password = PASS): MySqlAdapter {
  return new MySqlAdapter(
    {
      id: "mysql-it",
      name: "mysql-it",
      driver: "mysql",
      host: HOST,
      port: PORT,
      user: USER,
      database: DB,
    },
    password,
  );
}

describe.skipIf(!IT)("MySqlAdapter — integration", () => {
  let adapter: MySqlAdapter;

  beforeAll(async () => {
    adapter = makeAdapter();
    await adapter.connect();
    await adapter.runQuery("DROP TABLE IF EXISTS vsdb_it_rows");
    await adapter.runQuery(
      "CREATE TABLE vsdb_it_rows (id INT NOT NULL PRIMARY KEY, value VARCHAR(64) NOT NULL)",
    );
    const values = Array.from(
      { length: 1200 },
      (_, i) => `(${i + 1}, 'row-${i + 1}')`,
    ).join(",");
    await adapter.runQuery(
      `INSERT INTO vsdb_it_rows (id, value) VALUES ${values}`,
    );
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.runQuery("DROP TABLE IF EXISTS vsdb_it_rows").catch(() => undefined);
      await adapter.close();
    }
  });

  it("Test #1 — connect + SELECT 1 trả one column/row", async () => {
    const { results, batched } = await adapter.runQuery("SELECT 1 AS one");
    expect(results).toEqual([]);
    expect(batched).toBeDefined();
    expect(batched!.columns).toEqual(["one"]);
    await expect(batched!.fetchBatch()).resolves.toEqual([[1]]);
    await expect(batched!.fetchBatch()).resolves.toBeNull();
    await batched!.close();
  });

  it("Test #2 — batch 500/500/200/null và giữ thứ tự", async () => {
    const { batched } = await adapter.runQuery(
      "SELECT id FROM vsdb_it_rows ORDER BY id",
    );
    expect(batched).toBeDefined();
    const b1 = await batched!.fetchBatch();
    expect(b1).toHaveLength(500);
    expect(b1![0][0]).toBe(1);
    const b2 = await batched!.fetchBatch();
    expect(b2).toHaveLength(500);
    expect(b2![0][0]).toBe(501);
    const b3 = await batched!.fetchBatch();
    expect(b3).toHaveLength(200);
    expect(b3![0][0]).toBe(1001);
    const b4 = await batched!.fetchBatch();
    expect(b1).toHaveLength(500);
    expect(b2).toHaveLength(500);
    expect(b3).toHaveLength(200);
    expect(b4).toBeNull();
    expect(b1![0][0]).toBe(1);
    expect(b2![0][0]).toBe(501);
    expect(b3![0][0]).toBe(1001);
    await batched!.close();
  });

  it("Test #3 — sai password trả Access denied", async () => {
    const bad = makeAdapter("definitely-wrong-password");
    await expect(bad.connect()).rejects.toThrow(/Access denied/i);
  });

  it("metadata — tables và columns", async () => {
    const tables = await adapter.listTables(DB);
    expect(tables.some((t) => t.name === "vsdb_it_rows" && t.schema === DB)).toBe(
      true,
    );
    const columns = await adapter.listColumns("vsdb_it_rows", DB);
    const id = columns.find((column) => column.name === "id");
    expect(id).toBeDefined();
    expect(id!.isPrimaryKey).toBe(true);
    expect(id!.nullable).toBe(false);
  });
});
