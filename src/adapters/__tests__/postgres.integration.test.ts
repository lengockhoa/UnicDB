// src/adapters/__tests__/postgres.integration.test.ts
// Integration tests cho PostgresAdapter — chỉ chạy khi VSDB_IT=1.
// TASK-003 §Test Cases #1..#5.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgresAdapter } from "../postgres";

const IT = process.env.VSDB_IT === "1";
const HOST = process.env.VSDB_PG_HOST ?? "127.0.0.1";
const PORT = Number(process.env.VSDB_PG_PORT ?? 5433);
const USER = process.env.VSDB_PG_USER ?? "vsdb";
const PASS = process.env.VSDB_PG_PASS ?? "vsdb";
const DB = process.env.VSDB_PG_DB ?? "vsdb";

function makeAdapter(pw: string = PASS): PostgresAdapter {
  // PostgresAdapter constructor sẽ nhận (config, password)
  return new PostgresAdapter(
    {
      id: "it",
      name: "pg-it",
      driver: "postgres",
      host: HOST,
      port: PORT,
      user: USER,
      database: DB,
    },
    pw,
  );
}

describe.skipIf(!IT)("PostgresAdapter — integration", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = makeAdapter();
    await adapter.connect();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it("Test #1 — Connect + query đơn giản (SELECT 1 qua cursor)", async () => {
    const { results, batched } = await adapter.runQuery("SELECT 1 AS one");
    // SELECT luôn đi qua pg-cursor → batched defined, results rỗng.
    expect(results).toHaveLength(0);
    expect(batched).toBeDefined();
    expect(batched!.columns).toEqual(["one"]);
    const rows = await batched!.fetchBatch();
    expect(rows).not.toBeNull();
    expect(rows!).toEqual([[1]]);
    // EOF
    const eof = await batched!.fetchBatch();
    expect(eof).toBeNull();
    await batched!.close();
  });

  it("Test #2 — Batch 500 + Load more (generate_series 1..1200)", async () => {
    const { results, batched } = await adapter.runQuery(
      "SELECT generate_series(1, 1200) AS n",
    );
    expect(results.length).toBeGreaterThanOrEqual(0);
    expect(batched).toBeDefined();
    const bq = batched!;
    expect(bq.columns).toEqual(["n"]);

    const b1 = await bq.fetchBatch();
    expect(b1).not.toBeNull();
    expect(b1!.length).toBe(500);
    expect(b1![0][0]).toBe(1);

    const b2 = await bq.fetchBatch();
    expect(b2).not.toBeNull();
    expect(b2!.length).toBe(500);

    const b3 = await bq.fetchBatch();
    expect(b3).not.toBeNull();
    expect(b3!.length).toBe(200);

    const b4 = await bq.fetchBatch();
    expect(b4).toBeNull();

    await bq.close();
  });

  it("Test #3 — Sai password → lỗi chứa 28P01 / password authentication failed", async () => {
    const bad = makeAdapter("definitely-wrong-pw");
    let err: unknown = null;
    try {
      await bad.connect();
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    const msg = String((err as Error).message ?? err);
    expect(msg).toMatch(/28P01|password authentication failed/i);
  });

  it("Test #4 — Cancel giữa query lớn", async () => {
    const { batched } = await adapter.runQuery(
      "SELECT generate_series(1, 5000000) AS n",
    );
    expect(batched).toBeDefined();
    const bq = batched!;
    const first = await bq.fetchBatch();
    expect(first).not.toBeNull();
    await bq.cancel();
    await bq.close();
  });

  it("Test #5 — Metadata: tables, columns, routines", async () => {
    await adapter.runQuery("DROP TABLE IF EXISTS vsdb_it_orders");
    await adapter.runQuery("DROP FUNCTION IF EXISTS vsdb_it_double(integer)");
    await adapter.runQuery(`
      CREATE TABLE vsdb_it_orders (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        qty INTEGER
      )
    `);
    await adapter.runQuery(`
      CREATE OR REPLACE FUNCTION vsdb_it_double(i integer) RETURNS integer
      LANGUAGE sql AS $$ SELECT i * 2 $$;
    `);

    const tables = await adapter.listTables("public");
    const found = tables.find((t) => t.name === "vsdb_it_orders");
    expect(found).toBeTruthy();
    expect(found!.schema).toBe("public");

    const cols = await adapter.listColumns("vsdb_it_orders", "public");
    const id = cols.find((c) => c.name === "id");
    expect(id).toBeTruthy();
    expect(id!.isPrimaryKey).toBe(true);
    expect(id!.nullable).toBe(false);

    const name = cols.find((c) => c.name === "name");
    expect(name).toBeTruthy();
    expect(name!.nullable).toBe(false);

    const qty = cols.find((c) => c.name === "qty");
    expect(qty).toBeTruthy();
    expect(qty!.nullable).toBe(true);

    const routines = await adapter.listRoutines("public");
    const fn = routines.find(
      (r) => r.name === "vsdb_it_double" && r.kind === "function",
    );
    expect(fn).toBeTruthy();
    expect(fn!.schema).toBe("public");

    await adapter.runQuery("DROP TABLE IF EXISTS vsdb_it_orders");
    await adapter.runQuery("DROP FUNCTION IF EXISTS vsdb_it_double(integer)");
  });

  // ---- Regression tests (fix round 1) --------------------------------------

  it("Regression #1 — bad SELECT inside cursor: pool stays usable (subsequent query succeeds)", async () => {
    // Bad SELECT triggers an error inside openCursorForStatement (DECLARE fails).
    // The adapter must release the client back to the pool so subsequent
    // runQuery calls still work (no permanent wedge of max=1 pool).
    let firstErr: unknown = null;
    try {
      const { batched } = await adapter.runQuery(
        "SELECT * FROM no_such_table_for_vsdb_regression",
      );
      if (batched) {
        await batched.fetchBatch().catch((e) => {
          firstErr = e;
        });
      }
    } catch (e) {
      firstErr = e;
    }
    expect(firstErr).toBeTruthy();

    // Subsequent query must succeed (no wedge).
    const { results, batched } = await adapter.runQuery("SELECT 7 AS seven");
    expect(results).toHaveLength(0);
    expect(batched).toBeDefined();
    const rows = await batched!.fetchBatch();
    expect(rows).not.toBeNull();
    expect(rows!).toEqual([[7]]);
    await batched!.close();
  });

  it("Regression #2 — cancel mid-FETCH: pool recovers and subsequent query succeeds", async () => {
    const { batched } = await adapter.runQuery(
      "SELECT generate_series(1, 5000000) AS n",
    );
    expect(batched).toBeDefined();
    const bq = batched!;
    const first = await bq.fetchBatch();
    expect(first).not.toBeNull();
    await bq.cancel();
    await bq.close();

    // Pool must still work after cancel.
    const after = await adapter.runQuery("SELECT 42 AS forty_two");
    expect(after.batched).toBeDefined();
    const r = await after.batched!.fetchBatch();
    expect(r).toEqual([[42]]);
    await after.batched!.close();
  });

  it("Regression #3 — fetchBatch after cancel returns null (not throw)", async () => {
    const { batched } = await adapter.runQuery(
      "SELECT generate_series(1, 5000000) AS n",
    );
    expect(batched).toBeDefined();
    const bq = batched!;
    await bq.fetchBatch();
    await bq.cancel();
    // After cancel, fetchBatch must return null (per spec Test #4 contract).
    const after = await bq.fetchBatch();
    expect(after).toBeNull();
  });

  it("Regression #4 — adapter.close() with open cursor resolves within 5s", async () => {
    // Use a fresh adapter (own pool) so we don't disturb the shared one.
    const a = makeAdapter();
    await a.connect();
    const { batched } = await a.runQuery(
      "SELECT generate_series(1, 5000000) AS n",
    );
    expect(batched).toBeDefined();
    await batched!.fetchBatch();
    // Intentionally NOT calling cancel/close on the batched query — simulating
    // user disconnecting while a cursor is still open.
    const t0 = Date.now();
    await a.close();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
  });

  it("Regression #5 — commandTag populated for non-cursor path", async () => {
    // INSERT is not a SELECT so it goes through the non-cursor path.
    await adapter.runQuery("DROP TABLE IF EXISTS vsdb_it_tags");
    await adapter.runQuery("CREATE TABLE vsdb_it_tags (id SERIAL PRIMARY KEY, v INT)");
    const r = await adapter.runQuery(
      "INSERT INTO vsdb_it_tags (v) VALUES (1), (2), (3)",
    );
    expect(r.batched).toBeUndefined();
    expect(r.results).toHaveLength(1);
    expect(r.results[0].commandTag).toBeTruthy();
    expect(String(r.results[0].commandTag)).toMatch(/INSERT/i);
    expect(r.results[0].rowCount).toBe(3);
    await adapter.runQuery("DROP TABLE IF EXISTS vsdb_it_tags");
  });
});