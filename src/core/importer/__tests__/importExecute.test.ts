// src/core/importer/__tests__/importExecute.test.ts
// DBX-01-003 — execute layer: the only module that touches a DbAdapter.
// RED first.

import { describe, it, expect, vi } from "vitest";
import { executeImport } from "../importExecute";
import type { DryRunPlan } from "../importDryRun";
import type { DbAdapter, DbTransaction, RunResult } from "../../../adapters/types";

function plan(batches: number, rowsPerBatch: number): DryRunPlan {
  const sqlStatements: string[] = [];
  const parameterSets: unknown[][] = [];
  for (let b = 0; b < batches; b++) {
    sqlStatements.push(`INSERT INTO "public"."t" VALUES ($1)`);
    for (let r = 0; r < rowsPerBatch; r++) parameterSets.push([b * rowsPerBatch + r]);
  }
  return {
    sqlStatements,
    parameterSets,
    batches,
    rowCount: batches * rowsPerBatch,
    totalBytes: batches * rowsPerBatch * 8,
  };
}

interface TxSpy {
  tx: DbTransaction;
  runQueryCalls: string[];
  commitCalls: number;
  rollbackCalls: number;
}

function makeTx(opts?: { failOnBatch?: number; commitFails?: boolean }): TxSpy {
  const spy: TxSpy = { tx: {} as DbTransaction, runQueryCalls: [], commitCalls: 0, rollbackCalls: 0 };
  spy.tx.runQuery = vi.fn(async (sql: string): Promise<RunResult> => {
    spy.runQueryCalls.push(sql);
    if (opts?.failOnBatch !== undefined && spy.runQueryCalls.length === opts.failOnBatch) {
      throw new Error(`batch ${opts.failOnBatch} failed`);
    }
    return { results: [] };
  });
  spy.tx.commit = vi.fn(async () => {
    spy.commitCalls++;
    if (opts?.commitFails) throw new Error("commit failed");
  });
  spy.tx.rollback = vi.fn(async () => {
    spy.rollbackCalls++;
  });
  return spy;
}

function makeAdapter(spy: TxSpy, driver: string = "postgres"): { adapter: DbAdapter; beginCalls: number } {
  let beginCalls = 0;
  const adapter = {
    driver,
    connect: vi.fn(),
    close: vi.fn(),
    runQuery: vi.fn(),
    beginTransaction: vi.fn(async () => {
      beginCalls++;
      return spy.tx;
    }),
  } as unknown as DbAdapter & { driver: string };
  (adapter as { driver: string }).driver = driver;
  return { adapter, beginCalls };
}

describe("executeImport — happy path", () => {
  it("BEGIN + N batched INSERTs via transaction.runQuery + COMMIT; rollback never called", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    const result = await executeImport(plan(3, 2), adapter);
    expect(result.errors).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(spy.runQueryCalls.length).toBe(3);
    expect(spy.commitCalls).toBe(1);
    expect(spy.rollbackCalls).toBe(0);
  });

  it("forwards plan parameterSets in order (batch i ↔ statement i)", async () => {
    const spy = makeTx();
    const seen: unknown[][] = [];
    spy.tx.runQuery = vi.fn(async (_sql: string, values?: unknown[]) => {
      if (values) seen.push(values);
      return { results: [] };
    }) as DbTransaction["runQuery"];
    const { adapter } = makeAdapter(spy);
    const p = plan(2, 3);
    await executeImport(p, adapter);
    // runQuery receives one statement per batch; we flatten the plan's
    // parameterSets by batch position (3 rows per batch → 3 values).
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual([0, 1, 2]);
    expect(seen[1]).toEqual([3, 4, 5]);
  });

  it("returns rowCount matching the plan on success", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    const result = await executeImport(plan(2, 5), adapter);
    expect(result.rowCount).toBe(10);
  });

  it("uses default batch size 1000 when no opts provided", async () => {
    // 2500 rows / 1000 per batch = 3 statements.
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    const result = await executeImport(plan(1, 2500), adapter);
    expect(result.rowCount).toBe(2500);
  });
});

describe("executeImport — failure paths", () => {
  it("mid-batch failure → ROLLBACK, no further runQuery", async () => {
    const spy = makeTx({ failOnBatch: 2 });
    const { adapter } = makeAdapter(spy);
    const result = await executeImport(plan(3, 2), adapter);
    expect(result.error?.phase).toBe("runQuery");
    expect(spy.rollbackCalls).toBe(1);
    expect(spy.commitCalls).toBe(0);
    // Statements 3 never issued.
    expect(spy.runQueryCalls.length).toBe(2);
  });

  it("BEGIN failure → result.error.phase = 'begin', no INSERT issued", async () => {
    const spy = makeTx();
    const adapter = {
      driver: "postgres",
      connect: vi.fn(),
      close: vi.fn(),
      runQuery: vi.fn(),
      beginTransaction: vi.fn(async () => {
        throw new Error("cannot begin");
      }),
    } as unknown as DbAdapter & { driver: string };
    (adapter as { driver: string }).driver = "postgres";
    const result = await executeImport(plan(2, 2), adapter);
    expect(result.error?.phase).toBe("begin");
    expect(spy.runQueryCalls.length).toBe(0);
  });

  it("COMMIT failure → result.error.phase = 'commit'", async () => {
    const spy = makeTx({ commitFails: true });
    const { adapter } = makeAdapter(spy);
    const result = await executeImport(plan(1, 2), adapter);
    expect(result.error?.phase).toBe("commit");
    expect(spy.rollbackCalls).toBe(1);
  });

  it("empty plan (zero rows) → no transaction, rowCount 0", async () => {
    const spy = makeTx();
    let beginCalls = 0;
    const adapter = {
      driver: "postgres",
      connect: vi.fn(),
      close: vi.fn(),
      runQuery: vi.fn(),
      beginTransaction: vi.fn(async () => {
        beginCalls++;
        return spy.tx;
      }),
    } as unknown as DbAdapter & { driver: string };
    (adapter as { driver: string }).driver = "postgres";
    const result = await executeImport(
      { sqlStatements: [], parameterSets: [], batches: 0, rowCount: 0, totalBytes: 0 },
      adapter,
    );
    expect(beginCalls).toBe(0);
    expect(result.rowCount).toBe(0);
  });
});

describe("executeImport — guards", () => {
  it("non-PostgreSQL adapter → driver-gate error, no transaction started", async () => {
    const spy = makeTx();
    const { adapter, beginCalls } = makeAdapter(spy, "mysql");
    const result = await executeImport(plan(1, 1), adapter);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message.toLowerCase()).toMatch(/postgres|driver/);
    expect(beginCalls).toBe(0);
  });

  it("refuses a plan whose statement is not an INSERT (dangerous-statement gate)", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    const malicious = plan(1, 1);
    malicious.sqlStatements[0] = 'DROP TABLE "public"."users"';
    const result = await executeImport(malicious, adapter);
    expect(result.error).toBeDefined();
    expect(spy.runQueryCalls.length).toBe(0);
  });

  it("never calls adapter.runQuery directly (only via DbTransaction)", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    await executeImport(plan(2, 2), adapter);
    expect(vi.mocked(adapter.runQuery)).not.toHaveBeenCalled();
  });

  it("oversized row (byte budget) is reported and skipped, not thrown", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    // 3 rows, maxBatchBytes tiny → row 3 exceeds budget.
    const p: DryRunPlan = {
      sqlStatements: ['INSERT INTO "public"."t" VALUES ($1)'],
      parameterSets: [["a"], ["b"], ["x".repeat(1000)]],
      batches: 1,
      rowCount: 3,
      totalBytes: 1008,
    };
    const result = await executeImport(p, adapter, { maxBatchBytes: 100 });
    expect(result.rowCount).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.message).toMatch(/byte|size/i);
  });
});

describe("executeImport — structural plan gate", () => {
  it("valid aligned plan (2 statements / 2 batches) commits once with ordered values", async () => {
    const spy = makeTx();
    const seen: unknown[][] = [];
    spy.tx.runQuery = vi.fn(async (_sql: string, values?: unknown[]) => {
      if (values) seen.push(values);
      return { results: [] };
    }) as DbTransaction["runQuery"];
    const { adapter } = makeAdapter(spy);
    const result = await executeImport(plan(2, 2), adapter);
    // BEGIN exactly once, one tx.runQuery per batch, values in order.
    expect(vi.mocked(adapter.beginTransaction).mock.calls.length).toBe(1);
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual([0, 1]);
    expect(seen[1]).toEqual([2, 3]);
    expect(result.rowCount).toBe(4);
    expect(result.errors).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(spy.commitCalls).toBe(1);
    expect(spy.rollbackCalls).toBe(0);
  });

  it("declared batch lacks SQL statement → gate error, no transaction", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    const malformed: DryRunPlan = {
      sqlStatements: ['INSERT INTO "public"."t" VALUES ($1)'], // 1 statement…
      parameterSets: [[1], [2]], // …but values for 2 declared batches
      batches: 2,
      rowCount: 2,
      totalBytes: 16,
    };
    const result = await executeImport(malformed, adapter);
    expect(result.rowCount).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.error?.phase).toBe("gate");
    // Fail-closed diagnostics: the message must name WHICH plan entry is
    // affected (0-based index into plan.sqlStatements, i.e. the second
    // declared batch = index 1) and the concrete reason ("missing").
    expect(result.error?.message).toContain("statement 1 is missing");
    expect(result.error?.message).toContain("batches=2");
    expect(result.error?.message).toContain("statements=1");
    expect(vi.mocked(adapter.beginTransaction).mock.calls.length).toBe(0);
    expect(vi.mocked(adapter.runQuery)).not.toHaveBeenCalled();
    expect(spy.runQueryCalls.length).toBe(0);
  });

  it("executable plan with no parameter sets → gate error, no transaction", async () => {
    const spy = makeTx();
    const { adapter } = makeAdapter(spy);
    const malformed: DryRunPlan = {
      sqlStatements: ['INSERT INTO "public"."t" VALUES ($1)'],
      parameterSets: [],
      batches: 1,
      rowCount: 0,
      totalBytes: 0,
    };
    const result = await executeImport(malformed, adapter);
    expect(result.rowCount).toBe(0);
    expect(result.error?.phase).toBe("gate");
    // Fail-closed diagnostics: the parameterSets reason must be pinned to
    // the first affected statement index (0-based: statement 0).
    expect(result.error?.message).toContain("statement 0 has empty parameterSets");
    expect(result.error?.message).toContain("parameterSets=0");
    expect(vi.mocked(adapter.beginTransaction).mock.calls.length).toBe(0);
  });
});
