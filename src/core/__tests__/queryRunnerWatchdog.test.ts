// src/core/__tests__/queryRunnerWatchdog.test.ts
// SQLHANG (TASK-SQLHANG-001) — QueryRunner statement watchdog tests.
//
// Contract under test (SPEC §5 FR-002..005, §8.2):
//   - Every statement-execution await is bounded by `statementTimeoutMs`.
//   - On expiry: adapter.abortActiveQuery?.() ?? adapter.cancelActiveQuery?.()
//     (bounded by ABORT_GRACE_MS, errors swallowed) → QueryTimeoutError →
//     existing error path (statement `error`, rest `cancelled`).
//   - `statementTimeoutMs <= 0` disables the watchdog (pass-through).
//   - cancel() internal awaits bounded by CANCEL_GRACE_MS; escalation to
//     abortActiveQuery when work is still held past the grace.
//   - runLocked stale-cursor sweep bounded by CLEANUP_GRACE_MS.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  QueryRunner,
  QueryTimeoutError,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  ABORT_GRACE_MS,
  CANCEL_GRACE_MS,
  CLEANUP_GRACE_MS,
  type StatementResult,
} from "../queryRunner";
import type { ParsedStatement } from "../../config/types";
import type {
  BatchedQuery,
  DbAdapter,
  QueryResult,
  RunResult,
} from "../../adapters/types";

// ---- Test helpers (mirror queryRunner.test.ts conventions) -----------------

function stmt(text: string, start: number, end: number): ParsedStatement {
  return { text, start, end };
}

function qresult(
  columns: string[],
  rows: any[][],
  rowCount: number | null = rows.length,
): QueryResult {
  return { columns, rows, rowCount, durationMs: 0 };
}

function okResult(columns: string[], rows: any[][]): RunResult {
  return { results: [qresult(columns, rows)] };
}

type AdapterExtras = {
  runQuerySpy: ReturnType<typeof vi.fn>;
  abortActiveQuery?: ReturnType<typeof vi.fn>;
  cancelActiveQuery?: ReturnType<typeof vi.fn>;
};

function makeAdapter(
  runImpl: (sql: string) => Promise<RunResult>,
  extras: {
    abortActiveQuery?: () => Promise<void>;
    cancelActiveQuery?: () => Promise<void>;
  } = {},
): DbAdapter & AdapterExtras {
  const runQuerySpy = vi.fn(runImpl);
  const adapter: Record<string, unknown> = {
    runQuerySpy,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runQuery: runQuerySpy,
    listSchemas: vi.fn(async () => []),
    listTables: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    listRoutines: vi.fn(async () => []),
    listColumns: vi.fn(async () => []),
    testConnection: vi.fn(async () => {}),
  };
  if (extras.abortActiveQuery) {
    adapter.abortActiveQuery = vi.fn(extras.abortActiveQuery);
  }
  if (extras.cancelActiveQuery) {
    adapter.cancelActiveQuery = vi.fn(extras.cancelActiveQuery);
  }
  return adapter as unknown as DbAdapter & AdapterExtras;
}

function makeBatched(overrides: {
  columns?: string[];
  fetchBatch?: () => Promise<any[][] | null>;
  cancel?: () => Promise<void>;
  close?: () => Promise<void>;
}): BatchedQuery & {
  fetchBatch: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    columns: overrides.columns ?? ["n"],
    fetchBatch: vi.fn(overrides.fetchBatch ?? (async () => null)),
    cancel: vi.fn(overrides.cancel ?? (async () => {})),
    close: vi.fn(overrides.close ?? (async () => {})),
  };
}

const NEVER = () => new Promise<never>(() => {});

describe("QueryRunner watchdog (SQLHANG)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the frozen constants and QueryTimeoutError", () => {
    expect(DEFAULT_STATEMENT_TIMEOUT_MS).toBe(300_000);
    expect(ABORT_GRACE_MS).toBe(5_000);
    expect(CANCEL_GRACE_MS).toBe(5_000);
    expect(CLEANUP_GRACE_MS).toBe(3_000);
    const err = new QueryTimeoutError(50);
    expect(err.name).toBe("QueryTimeoutError");
    expect(err.message).toBe("Statement timed out after 50ms — aborted");
  });

  it("#1 — runQuery settles before timeout: results returned, abort never called", async () => {
    const adapter = makeAdapter(async () => okResult(["n"], [[1]]), {
      abortActiveQuery: async () => {},
      cancelActiveQuery: async () => {},
    });
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 1000,
    });
    const p = runner.run([stmt("SELECT 1", 0, 8)], () => {});
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;
    expect(result[0].status).toBe("done");
    expect(result[0].result?.rows).toEqual([[1]]);
    expect(adapter.abortActiveQuery).not.toHaveBeenCalled();
    expect(adapter.cancelActiveQuery).not.toHaveBeenCalled();
    // Watchdog timer cleared on settle — nothing left armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("#2 — stmt 2 of 3 never settles: timeout → error + rest cancelled + abort once", async () => {
    const adapter = makeAdapter(
      async (sql) => {
        if (sql === "SELECT 1") return okResult(["n"], [[1]]);
        if (sql === "SELECT 2") return NEVER();
        throw new Error("should not reach: " + sql);
      },
      { abortActiveQuery: async () => {} },
    );
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 50,
    });
    const p = runner.run(
      [
        stmt("SELECT 1", 0, 8),
        stmt("SELECT 2", 9, 17),
        stmt("SELECT 3", 18, 26),
      ],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(60);
    const result = await p;
    expect(result).toHaveLength(3);
    expect(result[0].status).toBe("done");
    expect(result[1].status).toBe("error");
    expect(result[1].error).toBe(
      "Statement timed out after 50ms — aborted",
    );
    expect(result[2].status).toBe("cancelled");
    expect(adapter.abortActiveQuery).toHaveBeenCalledTimes(1);
  });

  it("#3 — statementTimeoutMs: 0 disables the watchdog (pass-through)", async () => {
    const adapter = makeAdapter(async () => NEVER(), {
      abortActiveQuery: async () => {},
      cancelActiveQuery: async () => {},
    });
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 0,
    });
    let settled = false;
    const p = runner
      .run([stmt("SELECT 1", 0, 8)], () => {})
      .then((r) => {
        settled = true;
        return r;
      });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
    expect(adapter.abortActiveQuery).not.toHaveBeenCalled();
    expect(adapter.cancelActiveQuery).not.toHaveBeenCalled();
    // No watchdog timer armed.
    expect(vi.getTimerCount()).toBe(0);
    void p;
  });

  it("#4 — adapter without abortActiveQuery falls back to cancelActiveQuery", async () => {
    const adapter = makeAdapter(async () => NEVER(), {
      cancelActiveQuery: async () => {},
    });
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 50,
    });
    const p = runner.run([stmt("SELECT 1", 0, 8)], () => {});
    await vi.advanceTimersByTimeAsync(60);
    const result = await p;
    expect(result[0].status).toBe("error");
    expect(result[0].error).toBe(
      "Statement timed out after 50ms — aborted",
    );
    expect(adapter.cancelActiveQuery).toHaveBeenCalledTimes(1);
  });

  it("#5 — cancel() resolves within grace when batched.cancel() hangs; abort fires", async () => {
    const batched = makeBatched({
      fetchBatch: vi
        .fn<[], Promise<any[][] | null>>()
        .mockImplementationOnce(async () => [[1]])
        .mockImplementation(() => NEVER()),
      cancel: () => NEVER(),
    });
    const adapter = makeAdapter(
      async () => ({ results: [], batched }),
      { abortActiveQuery: async () => {} },
    );
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 60_000,
    });
    const run = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    expect(run[0].status).toBe("done");
    // Park a loadMore so currentBatched is held, then cancel.
    const lm = runner.loadMore(0);
    void lm.catch(() => {});
    const cancelP = runner.cancel();
    await vi.advanceTimersByTimeAsync(CANCEL_GRACE_MS + ABORT_GRACE_MS + 100);
    await cancelP; // MUST resolve — never hang.
    expect(adapter.abortActiveQuery).toHaveBeenCalledTimes(1);
  });

  it("#6 — loadMore fetchBatch never settles: rejects with QueryTimeoutError, status stays done", async () => {
    const batched = makeBatched({
      fetchBatch: vi
        .fn<[], Promise<any[][] | null>>()
        .mockImplementationOnce(async () => [[1]])
        .mockImplementation(() => NEVER()),
    });
    const adapter = makeAdapter(
      async () => ({ results: [], batched }),
      { abortActiveQuery: async () => {} },
    );
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 50,
    });
    const run = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    expect(run[0].status).toBe("done");
    const lm = runner.loadMore(0);
    const assertion = expect(lm).rejects.toThrow(QueryTimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(adapter.abortActiveQuery).toHaveBeenCalledTimes(1);
    // Statement keeps `done` — a timed-out page fetch does not flip it.
    expect(runner.getResults()[0].status).toBe("done");
  });

  it("#7 — regression: 3-stmt run with never-settling stmt 2 resolves (was: hang)", async () => {
    const adapter = makeAdapter(
      async (sql) => {
        if (sql === "SELECT 1") return okResult(["n"], [[1]]);
        if (sql === "SELECT 2") return NEVER();
        return okResult(["n"], [[3]]);
      },
      { abortActiveQuery: async () => {} },
    );
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 50,
    });
    const p = runner.run(
      [
        stmt("SELECT 1", 0, 8),
        stmt("SELECT 2", 9, 17),
        stmt("SELECT 3", 18, 26),
      ],
      () => {},
    );
    await vi.advanceTimersByTimeAsync(60);
    const result: StatementResult[] = await p;
    expect(result[1].status).toBe("error");
    expect(result[2].status).toBe("cancelled");
  });

  it("#8 — stale cursor close() hangs at next run start: sweep bounded, run proceeds", async () => {
    const hangingClose = makeBatched({
      fetchBatch: vi
        .fn<[], Promise<any[][] | null>>()
        .mockImplementationOnce(async () => [[1]])
        .mockImplementation(() => NEVER()),
      close: () => NEVER(),
    });
    let call = 0;
    const adapter = makeAdapter(
      async () => {
        call++;
        if (call === 1) return { results: [], batched: hangingClose };
        return okResult(["n"], [[2]]);
      },
      { abortActiveQuery: async () => {} },
    );
    const runner = new QueryRunner(async () => adapter, {
      statementTimeoutMs: 60_000,
    });
    const first = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    expect(first[0].status).toBe("done");
    expect(first[0].batched).toBe(hangingClose);
    // Second run: sweep must bound the hanging close() and proceed.
    const p = runner.run([stmt("SELECT 2", 0, 8)], () => {});
    await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS + ABORT_GRACE_MS + 100);
    const second = await p;
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe("done");
    expect(second[0].result?.rows).toEqual([[2]]);
    // The stale entry was marked closed despite the hung close().
    expect(first[0].cursorClosed).toBe(true);
    expect(adapter.abortActiveQuery).toHaveBeenCalled();
  });
});
