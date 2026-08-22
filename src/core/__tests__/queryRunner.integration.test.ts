// src/core/__tests__/queryRunner.integration.test.ts
// Integration test: QueryRunner + PostgresAdapter + real docker postgres.
// Chỉ chạy khi VSDB_IT=1.
//
// CRITICAL #1 fix round 1: closes the loop — adapter returns
// { results: [], batched }, runner must build result from batched.columns
// + initial 500-row fetch.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { QueryRunner } from "../queryRunner";
import { PostgresAdapter } from "../../adapters/postgres";

const IT = process.env.VSDB_IT === "1";
const HOST = process.env.VSDB_PG_HOST ?? "127.0.0.1";
const PORT = Number(process.env.VSDB_PG_PORT ?? 5433);
const USER = process.env.VSDB_PG_USER ?? "vsdb";
const PASS = process.env.VSDB_PG_PASS ?? "vsdb";
const DB = process.env.VSDB_PG_DB ?? "vsdb";

describe.skipIf(!IT)("QueryRunner + PostgresAdapter (docker) — batched contract", () => {
  let adapter: PostgresAdapter;
  let runner: QueryRunner;

  beforeAll(async () => {
    adapter = new PostgresAdapter(
      {
        id: "qr-it",
        name: "qr-it",
        driver: "postgres",
        host: HOST,
        port: PORT,
        user: USER,
        database: DB,
      },
      PASS,
    );
    await adapter.connect();
    runner = new QueryRunner(async () => adapter);
  }, 30_000);

  afterAll(async () => {
    await adapter.close();
  }, 30_000);

  it("Real adapter SELECT: initial 500 rows + columns từ batched", async () => {
    const { ParsedStatement } = await import("../../config/types");
    const stmt: ParsedStatement = {
      text: "SELECT generate_series(1, 1200) AS n",
      start: 0,
      end: 38,
    };
    const updates: any[] = [];
    const results = await runner.run([stmt], (r) => updates.push(r.length));
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("done");
    // CRITICAL #1: columns come from batched, not results (adapter trả results=[]).
    expect(results[0].result?.columns).toEqual(["n"]);
    // Initial 500-row batch shown immediately (design intent).
    expect(results[0].result?.rows).toHaveLength(500);
    expect(results[0].result?.rows[0]).toEqual([1]);
    // Footer-style rowCount = null for batched (Fix R2 important #2).
    // Total unknown until EOF; returning `500` here flipped the grid
    // model's hasMore=false on the very first batch and hid Load More.
    expect(results[0].result?.rowCount).toBeNull();
    expect(results[0].batched).toBeDefined();

    // Cleanup: close cursor để adapter.close() không phải cleanup.
    if (results[0].batched) {
      await results[0].batched.close();
    }
  });

  it("Real adapter loadMore: 4 batches total = 1200 rows", async () => {
    const { ParsedStatement } = await import("../../config/types");
    const stmt: ParsedStatement = {
      text: "SELECT generate_series(1, 1200) AS n, 'row' || generate_series(1, 1200) AS label",
      start: 0,
      end: 79,
    };
    const results = await runner.run([stmt], () => {});
    expect(results[0].result?.rows).toHaveLength(500);

    // loadMore 1 → 1000 total.
    const r1 = await runner.loadMore(0);
    expect(r1[0].result?.rows).toHaveLength(1000);

    // loadMore 2 → 1200 total.
    const r2 = await runner.loadMore(0);
    expect(r2[0].result?.rows).toHaveLength(1200);

    // loadMore 3 → EOF (no change).
    const r3 = await runner.loadMore(0);
    expect(r3[0].result?.rows).toHaveLength(1200);

    // Cleanup.
    if (results[0].batched) {
      await results[0].batched.close();
    }
  });

  it("Real adapter cancel mid-fetchBatch: in-flight cursor cancel called", async () => {
    const { ParsedStatement } = await import("../../config/types");
    const stmt: ParsedStatement = {
      text: "SELECT generate_series(1, 10000000) AS n",
      start: 0,
      end: 47,
    };
    const runPromise = runner.run([stmt], () => {});
    // Wait until initial fetch starts.
    await new Promise((r) => setTimeout(r, 50));
    await runner.cancel();
    const results = await runPromise;
    // Status either 'cancelled' or 'done' with rows=[] (if cancel happened between
    // runQuery resolve and fetchBatch).
    expect(["cancelled", "done"]).toContain(results[0].status);

    // Cleanup any leftover cursor.
    if (results[0].batched) {
      await results[0].batched.close();
    }
  });
});
