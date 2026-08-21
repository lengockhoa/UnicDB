// src/adapters/__tests__/mssql.integration.test.ts
// Integration tests for MsSqlAdapter. Run only when VSDB_IT=1.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MsSqlAdapter } from "../mssql";

const IT = process.env.VSDB_IT === "1";
const HOST = process.env.VSDB_MSSQL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.VSDB_MSSQL_PORT ?? 1434);
const USER = process.env.VSDB_MSSQL_USER ?? "sa";
const PASS = process.env.VSDB_MSSQL_PASS ?? "VsdbPass123!";
// The compose service does not create a separate database; sa connects to master.
// The compose service is provisioned by its test setup with this database.
const DB = process.env.VSDB_MSSQL_DB ?? "vsdb";

function makeAdapter(password = PASS): MsSqlAdapter {
  return new MsSqlAdapter(
    {
      id: "mssql-it",
      name: "mssql-it",
      driver: "mssql",
      host: HOST,
      port: PORT,
      user: USER,
      database: DB,
    },
    password,
  );
}

describe.skipIf(!IT)("MsSqlAdapter — integration", () => {
  let adapter: MsSqlAdapter;

  beforeAll(async () => {
    adapter = makeAdapter();
    await adapter.connect();
    await adapter.runQuery("IF OBJECT_ID('dbo.vsdb_it_rows', 'U') IS NOT NULL DROP TABLE dbo.vsdb_it_rows");
    await adapter.runQuery(
      "CREATE TABLE dbo.vsdb_it_rows (id INT NOT NULL PRIMARY KEY, value NVARCHAR(64) NOT NULL)",
    );
    const values = Array.from(
      { length: 1200 },
      (_, i) => `(${i + 1}, N'row-${i + 1}')`,
    );
    for (let start = 0; start < values.length; start += 500) {
      await adapter.runQuery(
        `INSERT dbo.vsdb_it_rows (id, value) VALUES ${values
          .slice(start, start + 500)
          .join(",")}`,
      );
    }
  });

  afterAll(async () => {
    if (adapter) {
      await adapter
        .runQuery("IF OBJECT_ID('dbo.vsdb_it_rows', 'U') IS NOT NULL DROP TABLE dbo.vsdb_it_rows")
        .catch(() => undefined);
      await adapter.close();
    }
  });

  it("Test #4 — connect + SELECT 1 trả one column/row", async () => {
    const { results, batched } = await adapter.runQuery("SELECT 1 AS one");
    expect(results).toEqual([]);
    expect(batched).toBeDefined();
    expect(batched!.columns).toEqual(["one"]);
    await expect(batched!.fetchBatch()).resolves.toEqual([[1]]);
    await expect(batched!.fetchBatch()).resolves.toBeNull();
    await batched!.close();
  });

  it("Test #5 — batch 500/500/200/null, tables và columns", async () => {
    const { batched } = await adapter.runQuery(
      "SELECT id FROM dbo.vsdb_it_rows ORDER BY id",
    );
    expect(batched).toBeDefined();
    const b1 = await batched!.fetchBatch();
    const b2 = await batched!.fetchBatch();
    const b3 = await batched!.fetchBatch();
    const b4 = await batched!.fetchBatch();
    expect(b1).toHaveLength(500);
    expect(b2).toHaveLength(500);
    expect(b3).toHaveLength(200);
    expect(b4).toBeNull();
    expect(b1![0][0]).toBe(1);
    expect(b2![0][0]).toBe(501);
    expect(b3![0][0]).toBe(1001);
    await batched!.close();

    const tables = await adapter.listTables("dbo");
    expect(tables.some((t) => t.name === "vsdb_it_rows" && t.schema === "dbo")).toBe(
      true,
    );
    const columns = await adapter.listColumns("vsdb_it_rows", "dbo");
    const id = columns.find((column) => column.name === "id");
    expect(id).toBeDefined();
    expect(id!.isPrimaryKey).toBe(true);
    expect(id!.nullable).toBe(false);
  });

  it("Test #6 — sai password trả Login failed", async () => {
    const bad = makeAdapter("definitely-wrong-password");
    await expect(bad.connect()).rejects.toThrow(/Login failed/i);
  });

  it("Test #6b — cancel dừng batch và lần fetch sau trả null", async () => {
    const { batched } = await adapter.runQuery(
      "SELECT TOP 5000000 value FROM dbo.vsdb_it_rows CROSS JOIN (VALUES (1),(2),(3),(4),(5)) AS x(n)",
    );
    expect(batched).toBeDefined();
    await expect(batched!.fetchBatch()).resolves.toHaveLength(500);
    await batched!.cancel();
    // Tedious may complete the attention round-trip asynchronously; the
    // interface guarantees cancellation is idempotent, so poll the batch state
    // rather than blocking the test on the network round-trip.
    let next = await batched!.fetchBatch();
    const deadline = Date.now() + 5_000;
    while (next === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      next = await batched!.fetchBatch();
    }
    expect(next).toBeNull();
    await batched!.close();
  });
});
