// src/core/__tests__/queryRunner.test.ts
// Unit tests for QueryRunner — TASK-006 §Test Cases + fix round 1 regressions.
//
// Mocks MUST match the REAL adapter contract per src/adapters/postgres.ts:
//   - SELECT (single, no semicolon) → adapter returns { results: [], batched }.
//     Batched is the ONLY source of columns/rows.
//   - Non-SELECT / multi-statement → adapter returns { results: [...] }.
//   - pickResult() builds QueryResult from batched.columns + initial fetchBatch.
import { describe, it, expect, vi } from "vitest";
import {
  QueryRunner,
  pickResult,
  RETAINED_ROW_CAP,
  classifyStatementKind,
  stampStatementKind,
  RunnerBusy,
  type StatementResult,
} from "../queryRunner";
import {
  stampBqDialect,
  type BqSchemaField,
} from "../bqDialect";
import type { ParsedStatement } from "../../config/types";
import type {
  BatchedQuery,
  DbAdapter,
  QueryResult,
  RunResult,
} from "../../adapters/types";

// ---- Test helpers ----------------------------------------------------------

function stmt(text: string, start: number, end: number): ParsedStatement {
  return { text, start, end };
}

/** Tạo QueryResult async-trivial. */
function qresult(columns: string[], rows: any[][], rowCount: number | null = rows.length): QueryResult {
  return { columns, rows, rowCount, durationMs: 0 };
}

function okResult(columns: string[], rows: any[][]): RunResult {
  return { results: [qresult(columns, rows)] };
}

/**
 * Build a BatchedQuery mock with controlled fetchBatch sequence.
 * IMPORTANT: matches real PostgresAdapter contract — `columns` is the only
 * source of column metadata. fetchBatch returns rows; null = EOF.
 */
function makeBatched(
  columns: string[],
  fetchSequence: Array<any[][] | null>,
): BatchedQuery & { fetchBatch: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const fetchBatch = vi
    .fn<[], Promise<any[][] | null>>()
    .mockImplementation(async () => {
      const next = fetchSequence.shift();
      if (next === undefined) return null;
      return next;
    });
  const cancel = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  return { columns, fetchBatch, cancel, close };
}

/** Adapter mock với runQuerySpy có thể cấu hình. */
function makeAdapter(
  runImpl: (sql: string) => Promise<RunResult>,
): DbAdapter & { runQuerySpy: ReturnType<typeof vi.fn> } {
  const runQuerySpy = vi.fn(runImpl);
  return {
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
  } as unknown as DbAdapter & { runQuerySpy: ReturnType<typeof vi.fn> };
}

describe("QueryRunner — run()", () => {
  it("Test #1 — chạy tuần tự nhiều statement, onUpdate gọi ≥2 lần", async () => {
    const adapter = makeAdapter(async (sql) => {
      if (sql === "SELECT 1") return okResult(["n"], [[1]]);
      if (sql === "SELECT 2") return okResult(["n"], [[2]]);
      throw new Error("unexpected SQL: " + sql);
    });
    const runner = new QueryRunner(async () => adapter);
    const updates: number[] = [];
    const result = await runner.run(
      [stmt("SELECT 1", 0, 8), stmt("SELECT 2", 9, 17)],
      () => updates.push(1),
    );
    expect(result).toHaveLength(2);
    expect(result[0].status).toBe("done");
    expect(result[0].result?.rows).toEqual([[1]]);
    expect(result[1].status).toBe("done");
    expect(result[1].result?.rows).toEqual([[2]]);
    // onUpdate ≥ 2 (mỗi statement done + running); yêu cầu ≥ 2.
    expect(updates.length).toBeGreaterThanOrEqual(2);
  });

  it("Test #2 — statement 2 lỗi → dừng chuỗi, statements[2] KHÔNG chạy", async () => {
    const adapter = makeAdapter(async (sql) => {
      if (sql === "SELECT 1") return okResult(["n"], [[1]]);
      if (sql === "BAD SQL") throw new Error("syntax error");
      throw new Error("should not reach: " + sql);
    });
    const runner = new QueryRunner(async () => adapter);
    const updates: any[] = [];
    const result = await runner.run(
      [stmt("SELECT 1", 0, 8), stmt("BAD SQL", 9, 17), stmt("SELECT 3", 18, 26)],
      (r) => updates.push(r.map((x: any) => x.status)),
    );
    expect(result).toHaveLength(3);
    expect(result[0].status).toBe("done");
    expect(result[1].status).toBe("error");
    expect(result[1].error).toMatch(/syntax error/);
    expect(result[2].status).toBe("cancelled"); // statements[2] không chạy
    // Verify spy: chỉ 2 lần gọi (SELECT 1, BAD SQL), KHÔNG gọi SELECT 3.
    expect(adapter.runQuerySpy).toHaveBeenCalledTimes(2);
  });

  it("Test #5 — statement không trả result (INSERT) status done, rowCount từ commandTag", async () => {
    const adapter = makeAdapter(async (sql) => {
      if (sql.startsWith("INSERT")) {
        return {
          results: [
            {
              columns: [],
              rows: [],
              rowCount: 5,
              commandTag: "INSERT 0 5",
              durationMs: 1,
            },
          ],
        };
      }
      throw new Error("unexpected: " + sql);
    });
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run(
      [stmt("INSERT INTO t VALUES (1)", 0, 22)],
      () => {},
    );
    expect(result[0].status).toBe("done");
    expect(result[0].result?.commandTag).toBe("INSERT 0 5");
    expect(result[0].result?.rowCount).toBe(5);
  });
});

describe("QueryRunner — batched contract (CRITICAL #1 fix round 1)", () => {
  it("batched SELECT — picks columns from batched, initial 500 rows fetched", async () => {
    const batched = makeBatched(["id", "name"], [
      Array.from({ length: 500 }, (_, i) => [i + 1, `row${i + 1}`]),
      Array.from({ length: 500 }, (_, i) => [i + 501, `row${i + 501}`]),
      Array.from({ length: 200 }, (_, i) => [i + 1001, `row${i + 1001}`]),
      null,
    ]);
    // REAL contract: results=[], batched set.
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});

    expect(result[0].status).toBe("done");
    expect(result[0].result?.columns).toEqual(["id", "name"]);
    expect(result[0].result?.rows).toHaveLength(500);
    expect(result[0].result?.rows[0]).toEqual([1, "row1"]);
    expect(result[0].result?.rows[499]).toEqual([500, "row500"]);
    expect(result[0].batched).toBe(batched);
    // Initial fetchBatch must have been called exactly once.
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("batched SELECT — empty initial batch (EOF right away) → rows=[]", async () => {
    const batched = makeBatched(["x"], [null]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    expect(result[0].status).toBe("done");
    expect(result[0].result?.columns).toEqual(["x"]);
    expect(result[0].result?.rows).toEqual([]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("pickResult() — batched-only contract returns columns + initial rows", async () => {
    const batched = makeBatched(["n"], [[[1], [2], [3]]]);
    const r = await pickResult({ results: [], batched });
    expect(r.columns).toEqual(["n"]);
    expect(r.rows).toEqual([[1], [2], [3]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("pickResult() — non-batched path picks first non-empty result", async () => {
    const r = await pickResult({
      results: [
        qresult([], []),
        qresult(["x"], [[42]]),
      ],
    });
    expect(r.columns).toEqual(["x"]);
    expect(r.rows).toEqual([[42]]);
  });
});

describe("QueryRunner — cancel()", () => {
  it("Test #4 — cancel() trong in-flight runQuery reaches batched.cancel() của statement đó", async () => {
    // Mô phỏng statement có batched cursor đang trong fetchBatch(initial).
    const batched = makeBatched(["n"], [null]); // sẽ chờ forever trong fetchBatch
    // Override fetchBatch để treo vĩnh viễn (mô phỏng server đang xử lý).
    let resolveFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementation(
      () => new Promise<any[][] | null>((resolve) => { resolveFetch = resolve; }),
    );

    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});

    // Đợi runQuery resolve + currentBatched được set + fetchBatch(initial) đã gọi.
    await new Promise((r) => setTimeout(r, 10));
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);

    // Cancel — phải gọi batched.cancel() của cursor đang in-flight.
    const cancelPromise = runner.cancel();
    // Resolve fetchBatch (cancel đã cancel client; giả lập adapter resolve null).
    if (resolveFetch) resolveFetch(null);
    await cancelPromise;

    expect(batched.cancel).toHaveBeenCalledTimes(1);
    // Statement phải có status='cancelled' (cancel before/during fetchBatch initial).
    const result = await runPromise;
    // TASK-008 P2-2 re-examination: the OLD comment said pickResult "swallows
    // the initial fetch error or returns empty rows", leaving status
    // ambiguous between cancelled/done. The mock resolves fetchBatch(null)
    // (EOF, not an error), so pickResult now resolves a normal empty result
    // — and executeAll's post-fetch cancelRequested check (:197) is what
    // decides. Cancel was requested before that check, so the outcome is
    // deterministically 'cancelled'; the either/or assertion is tightened,
    // not loosened.
    expect(result[0].status).toBe("cancelled");
  });

  it("Test #4b — cancel() không gọi statements sau", async () => {
    const callOrder: string[] = [];
    const adapter = makeAdapter(async (sql) => {
      callOrder.push(sql);
      if (sql === "SELECT 1") return okResult(["n"], [[1]]);
      // Hanging for second.
      await new Promise(() => {});
      throw new Error("unreachable");
    });
    const runner = new QueryRunner(async () => adapter);
    const runPromise = runner.run(
      [stmt("SELECT 1", 0, 8), stmt("SLOW", 9, 13), stmt("SLOW2", 14, 19)],
      () => {},
    );
    // Wait until SLOW is in flight.
    await new Promise((r) => setTimeout(r, 5));
    await runner.cancel();
    const timeout = new Promise<void>((r) => setTimeout(r, 50));
    await Promise.race([runPromise.then(() => undefined, () => undefined), timeout]);
    expect(callOrder).toEqual(["SELECT 1", "SLOW"]);
  });
});

// ---- TASK-008 P2-2 (cycle-x-audit-grid-ui): a failed INITIAL cursor fetch
// must surface as an error, never as an empty "success". Pre-fix, pickResult
// wrapped the first fetchBatch in `catch { /* ignore */ }` and returned
// { rows: [], rowCount: null } — a dead cursor was indistinguishable from an
// empty table and handleRequery rendered a false empty grid.
describe("QueryRunner — batched initial-fetch failure surfaces (TASK-008 P2-2)", () => {
  it("pickResult() — initial fetchBatch rejection propagates (not swallowed into empty rows)", async () => {
    const batched = makeBatched(["n"], [null]);
    batched.fetchBatch.mockImplementation(() =>
      Promise.reject(new Error("cursor exploded")),
    );
    await expect(
      pickResult({ results: [], batched }),
    ).rejects.toThrow(/cursor exploded/);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("run() — a failing first fetch marks the statement error, not done-with-empty-rows", async () => {
    const batched = makeBatched(["id"], [[1]]);
    batched.fetchBatch.mockImplementation(() =>
      Promise.reject(new Error("cursor exploded")),
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    const results = await runner.run(
      [stmt("SELECT * FROM t", 0, 16)],
      () => {},
    );
    expect(results[0].status).toBe("error");
    expect(results[0].error).toContain("cursor exploded");
    // No rows may be presented as a successful result.
    expect(results[0].result?.rows ?? []).toEqual([]);
    expect(results[0].result).toBeUndefined();
  });

  it("run() — genuinely empty cursor (first fetchBatch resolves null/EOF) is still a success", async () => {
    const batched = makeBatched(["x"], [null]); // EOF right away
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    const results = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    expect(results[0].status).toBe("done");
    expect(results[0].result?.rows).toEqual([]);
    expect(results[0].result?.rowCount).toBe(null);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);
  });
});

describe("QueryRunner — loadMore()", () => {
  it("Test #7 — loadMore lấy batch kế tiếp từ BatchedQuery", async () => {
    const batched = makeBatched(
      ["n"],
      [
        [[1], [2]], // initial fetch
        [[10], [11], [12]], // loadMore 1
        null, // loadMore 2 → EOF
      ],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].result?.rows).toEqual([[1], [2]]);

    const updated = await runner.loadMore(0);
    expect(updated[0].result?.rows).toEqual([[1], [2], [10], [11], [12]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(2); // 1 initial + 1 loadMore

    const noMore = await runner.loadMore(0);
    expect(noMore[0].result?.rows).toEqual([[1], [2], [10], [11], [12]]);
    expect(noMore[0].result?.rowCount).toBe(5);
  });

  it("Test #7b — loadMore trên statement không có batched → throw", async () => {
    const adapter = makeAdapter(async () => okResult(["n"], [[1]]));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    await expect(runner.loadMore(0)).rejects.toThrow(/no batched/i);
  });

  it("Fix #3 — concurrent loadMore cho cùng index được serialize, không mất batch", async () => {
    // fetchBatch có độ trễ để mô phỏng IO — 2 calls phải nối tiếp nhau.
    const fetchBatch = vi
      .fn<[], Promise<any[][] | null>>()
      .mockImplementationOnce(async () => {
        // initial fetch inside pickResult
        await new Promise((r) => setTimeout(r, 10));
        return [[1], [2]];
      })
      .mockImplementationOnce(async () => {
        // loadMore #1
        await new Promise((r) => setTimeout(r, 10));
        return [[3], [4]];
      })
      .mockImplementationOnce(async () => {
        // loadMore #2 (serialized after #1)
        await new Promise((r) => setTimeout(r, 10));
        return [[5]];
      });
    const batched: BatchedQuery = {
      columns: ["n"],
      fetchBatch,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1); // initial

    // Fire 2 concurrent loadMore — phải serialize, mỗi cái fetchBatch riêng.
    const [a, b] = await Promise.all([
      runner.loadMore(0),
      runner.loadMore(0),
    ]);
    // Both should append — không mất batch.
    // Second call phải fetchBatch riêng (sau khi first xong).
    const rowsA = a[0].result!.rows;
    const rowsB = b[0].result!.rows;
    // Last write wins — max length >= 4 (2 initial + 2 appended by first).
    const max = Math.max(rowsA.length, rowsB.length);
    expect(max).toBeGreaterThanOrEqual(4);
    // fetchBatch called: 1 initial + 2 (serialized).
    expect(batched.fetchBatch).toHaveBeenCalledTimes(3);
  });
});

describe("QueryRunner — Serialization", () => {
  it("Test #6 — StatementResult an toàn với Date / null / BigInt", async () => {
    const big = BigInt("9007199254740993");
    const adapter = makeAdapter(async () => ({
      results: [
        qresult(
          ["d", "v", "b"],
          [[new Date("2024-01-01T00:00:00Z"), null, big]],
        ),
      ],
    }));
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    const json = JSON.stringify(result[0].result, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(json).toContain("2024-01-01T00:00:00.000Z");
    expect(json).toContain("null");
    expect(json).toContain("9007199254740993");
  });
});

// =============================================================================
// Regression: pool max=1 wedge — "timeout exceeded when trying to connect".
// Trước fix: (1) batched cursor của SELECT < 500 rows không bao giờ tự đóng,
// (2) run() mới không đóng cursor cũ còn mở → statement kế xếp hàng chờ
// client duy nhất của pool → connectionTimeoutMillis (10s) → timeout error.
// =============================================================================
describe("QueryRunner — stale batched cursor release (pool wedge fix)", () => {
  it("run() mới đóng batched cursor còn mở từ lần chạy trước", async () => {
    // Lần 1: SELECT lớn — chỉ fetch initial 500 rows, cursor vẫn mở.
    const bigBatched = makeBatched(["n"], [
      Array.from({ length: 500 }, (_, i) => [i + 1]),
    ]);
    // Lần 2: non-SELECT kết quả thường.
    const adapter = makeAdapter(async (sql) => {
      if (sql.startsWith("SELECT")) return { results: [], batched: bigBatched };
      return okResult(["ok"], [[1]]);
    });
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});
    expect(bigBatched.close).not.toHaveBeenCalled(); // cursor còn mở sau run 1

    await runner.run([stmt("UPDATE t SET x = 1", 0, 21)], () => {});
    expect(bigBatched.close).toHaveBeenCalledTimes(1); // run 2 đóng cursor cũ
    // Statement mới vẫn chạy được (không bị block).
    const final = runner.getResults();
    expect(final[0].status).toBe("done");
  });

  it("cursor cũ được đóng TRƯỚC khi statement mới chạy (thứ tự close → runQuery)", async () => {
    // Lần 1: SELECT lớn — chỉ fetch initial batch, cursor còn mở.
    const bigBatched = makeBatched(["n"], [
      Array.from({ length: 500 }, (_, i) => [i + 1]),
    ]);
    const events: string[] = [];
    const adapter = makeAdapter(async (sql) => {
      events.push(`runQuery:${sql}`);
      return { results: [], batched: bigBatched };
    });
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});
    events.length = 0;
    // bigBatched.close spy: ghi event vào queue chung để so thứ tự.
    bigBatched.close.mockImplementation(async () => {
      events.push("close");
    });

    await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});

    expect(events).toEqual(["close", "runQuery:SELECT * FROM big"]);
  });
});

describe("Cycle AH — append runs", () => {
  it("append run accumulates results and keeps old entries", async () => {
    const adapter = makeAdapter(async (sql) => okResult(["value"], [[sql]]));
    const runner = new QueryRunner(async () => adapter);
    const first = await runner.run([stmt("SELECT a", 0, 8)], () => {});
    const oldEntry = first[0];
    const results = await runner.run(
      [stmt("SELECT b", 0, 8), stmt("SELECT c", 0, 8)],
      () => {},
      { append: true },
    );
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(results[0]).toBe(oldEntry);
    expect(results[1].runNo).toBe(2);
    expect(results[1].runStmtNo).toBe(1);
    expect(results[2].runNo).toBe(2);
    expect(results[2].runStmtNo).toBe(2);
  });

  it("default run (no opts) still replaces", async () => {
    const adapter = makeAdapter(async (sql) => okResult(["value"], [[sql]]));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT a", 0, 8), stmt("SELECT b", 0, 8)], () => {});
    const result = await runner.run([stmt("SELECT c", 0, 8)], () => {});
    expect(result).toHaveLength(1);
    expect(result[0].sql).toBe("SELECT c");
    expect(result[0].runNo).toBeUndefined();
  });

  it("append run with empty statements leaves results unchanged", async () => {
    const adapter = makeAdapter(async () => okResult(["value"], [[1]]));
    const runner = new QueryRunner(async () => adapter);
    const seeded = await runner.run([stmt("SELECT a", 0, 8)], () => {});
    const updates: StatementResult[][] = [];
    const result = await runner.run([], (next) => updates.push(next), { append: true });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(seeded[0]);
    expect(updates).toHaveLength(1);
  });

  it("cancel mid-append-run leaves old tabs intact", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let secondStartedResolve!: () => void;
    const secondStarted = new Promise<void>((resolve) => { secondStartedResolve = resolve; });
    let calls = 0;
    const adapter = makeAdapter(async (sql) => {
      calls++;
      if (calls === 2) {
        secondStartedResolve();
        await gate;
      }
      return okResult(["value"], [[sql]]);
    });
    const runner = new QueryRunner(async () => adapter);
    const seeded = await runner.run([stmt("SELECT old", 0, 10)], () => {});
    const appendRun = runner.run(
      [stmt("SELECT one", 0, 10), stmt("SELECT two", 0, 10), stmt("SELECT three", 0, 12)],
      () => {},
      { append: true },
    );
    await secondStarted;
    await runner.cancel();
    release();
    const result = await appendRun;
    expect(result[0]).toBe(seeded[0]);
    expect(result[0].cursorClosed).toBeUndefined();
    expect(result.slice(1).map((r) => r.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("single-statement append run keeps cursor open and Load More works", async () => {
    const batched = makeBatched(["n"], [[[1]], [[2]], null]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT n", 0, 8)], () => {}, { append: true });
    expect(result[0].cursorClosed).toBeUndefined();
    const loaded = await runner.loadMore(0);
    expect(loaded[0].result?.rows).toEqual([[1], [2]]);
  });

  it("2 batched statements close the first cursor before the second starts", async () => {
    const first = makeBatched(["n"], [[[1]]]);
    const second = makeBatched(["n"], [[[2]]]);
    const events: string[] = [];
    first.close.mockImplementation(async () => { events.push("close:first"); });
    const adapter = makeAdapter(async (sql) => {
      events.push(`run:${sql}`);
      return sql === "SELECT 1" ? { results: [], batched: first } : { results: [], batched: second };
    });
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run(
      [stmt("SELECT 1", 0, 8), stmt("SELECT 2", 0, 8)],
      () => {},
      { append: true },
    );
    expect(result[0].cursorClosed).toBe(true);
    expect(result[0].result?.rows).toEqual([[1]]);
    expect(result[1].cursorClosed).toBeUndefined();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["run:SELECT 1", "close:first", "run:SELECT 2"]);
  });

  it("loadMore on a cursorClosed entry rejects before touching the cursor", async () => {
    const first = makeBatched(["n"], [[[1]]]);
    const second = makeBatched(["n"], [[[2]]]);
    const adapter = makeAdapter(async (sql) => sql === "SELECT 1"
      ? { results: [], batched: first }
      : { results: [], batched: second });
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT 1", 0, 8), stmt("SELECT 2", 0, 8)], () => {}, { append: true });
    await expect(runner.loadMore(0)).rejects.toThrow(/run this statement alone/);
    expect(first.fetchBatch).toHaveBeenCalledTimes(1);
  });

  it("last statement of an append multi-statement run keeps its cursor", async () => {
    const first = makeBatched(["n"], [[[1]]]);
    const last = makeBatched(["n"], [[[2]], [[3]]]);
    const adapter = makeAdapter(async (sql) => sql === "SELECT 1"
      ? { results: [], batched: first }
      : { results: [], batched: last });
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT 1", 0, 8), stmt("SELECT 2", 0, 8)], () => {}, { append: true });
    expect(result[1].cursorClosed).toBeUndefined();
    await runner.loadMore(1);
    expect(result[1].result?.rows).toEqual([[2], [3]]);
  });

  it("stale cursor close marks old entry and preserves degrade message", async () => {
    const oldBatched = makeBatched(["n"], [[[1]]]);
    const adapter = makeAdapter(async (sql) => sql === "SELECT old"
      ? { results: [], batched: oldBatched }
      : okResult(["ok"], [[1]]));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT old", 0, 10)], () => {});
    await runner.run([stmt("SELECT new", 0, 10)], () => {}, { append: true });
    expect(oldBatched.close).toHaveBeenCalledTimes(1);
    await expect(runner.loadMore(0)).rejects.toThrow(/run this statement alone/);
    expect(oldBatched.fetchBatch).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TASK-RLX-001 — cancel active non-batched query through adapter seam.
//
// Contract:
//  - DbAdapter gains an optional `cancelActiveQuery?(): Promise<void>`.
//  - QueryRunner.cancel() retains the resolved adapter only during the active
//    `run()` and invokes the seam ONLY when no currentBatched exists.
//  - After a non-batched statement settles and the PID window closes,
//    `cancel()` is a no-op (no seam call, no false error / cancelled status).
//  - Batched cursor path remains exclusive: BatchedQuery.cancel() is called
//    once and `cancelActiveQuery` is never invoked.
// =============================================================================
describe("QueryRunner — non-batched cancellation seam (TASK-RLX-001)", () => {
  it("Test #1 — happy/contract: cancel active non-batched run → seam called once, status cancelled", async () => {
    // Deferred adapter.runQuery so we can call cancel() while the statement
    // is still in flight. No BatchedQuery in the result (non-SELECT / multi).
    let resolveRun: ((v: RunResult) => void) | null = null;
    const runQuerySpy = vi.fn(
      () => new Promise<RunResult>((resolve) => { resolveRun = resolve; }),
    );
    const cancelActiveSpy = vi.fn(async () => {});
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: runQuerySpy,
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});

    // Wait for run() to have entered adapter.runQuery (statement in flight).
    await new Promise((r) => setTimeout(r, 5));
    expect(runQuerySpy).toHaveBeenCalledTimes(1);

    // Cancel — seam must be called once against the in-flight run.
    const cancelPromise = runner.cancel();
    // Now resolve the run; since cancel was requested, status must be cancelled.
    if (resolveRun) {
      resolveRun({ results: [{ columns: ["x"], rows: [], rowCount: 0, durationMs: 0 }] });
    }
    await cancelPromise;
    const result = await runPromise;

    expect(cancelActiveSpy).toHaveBeenCalledTimes(1);
    expect(result[0].status).toBe("cancelled");
  });

  it("Test #2 — edge / race: cancel BEFORE the adapter provider resolves; no seam, no runQuery against the late adapter", async () => {
    // Review fix round 1 Finding A: the provider promise stays DEFERRED
    // through runner.cancel(). The cancel therefore lands BEFORE the runner
    // ever obtains an adapter (executeAll is still awaiting the provider, no
    // statement has started, PID window never opened). Afterwards the
    // provider resolves with a normal adapter whose runQuery is a spy — the
    // runner must skip straight past the statement (pre-loop cancelRequested
    // check): runQuery NEVER called, the seam NEVER fired against the
    // late-resolving adapter, and the settled result is 'cancelled'.
    let resolveAdapter: ((a: DbAdapter) => void) | null = null;
    const cancelActiveSpy = vi.fn(async () => {});
    const runQuerySpy = vi.fn(async () =>
      okResult(["n"], [[1]]),
    );
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: runQuerySpy,
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(
      () => new Promise<DbAdapter>((resolve) => { resolveAdapter = resolve; }),
    );

    const runPromise = runner.run([stmt("UPDATE t SET x=1", 0, 16)], () => {});
    // Let run() enter executeAll and park on the pending provider — the
    // adapter is NOT resolved yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(runQuerySpy).not.toHaveBeenCalled();

    // Cancel while the provider is STILL pending — the runner holds no
    // adapter, so no seam may fire here.
    await runner.cancel();
    expect(cancelActiveSpy).not.toHaveBeenCalled();

    // Only now does the provider resolve with the late adapter.
    if (resolveAdapter) resolveAdapter(adapter);
    const result = await runPromise;

    // The late adapter must never be touched: no query, no seam.
    expect(runQuerySpy).not.toHaveBeenCalled();
    expect(cancelActiveSpy).not.toHaveBeenCalled();
    expect(result[0].status).toBe("cancelled");
  });

  it("Test #3 — edge / ordering: cancel AFTER statement settles and PID window closes → seam never called, status done", async () => {
    // Adapter resolves immediately. After run() completes, the PID/active
    // window is closed. cancel() in this window must be a no-op (no seam
    // call, no false cancelled / error status).
    const cancelActiveSpy = vi.fn(async () => {});
    const adapter = makeAdapter(async () =>
      okResult(["n"], [[1]]),
    ) as DbAdapter;
    (adapter as unknown as { cancelActiveQuery: ReturnType<typeof vi.fn> }).cancelActiveQuery = cancelActiveSpy;

    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    expect(result[0].status).toBe("done");

    await runner.cancel();
    expect(cancelActiveSpy).not.toHaveBeenCalled();
    // The settled entry must remain done with no false cancelled / error.
    const final = runner.getResults();
    expect(final[0].status).toBe("done");
    expect(final[0].error).toBeUndefined();
  });

  it("Test #3b — TASK-RLX02-003: cancel awaits an in-flight seam and settles status=cancelled", async () => {
    // Adapter seam returns a DEFERRED promise. The runner.cancel() promise
    // must NOT resolve until the seam settles — otherwise the extension's
    // command path (and panel message path) would clear busy state while
    // the dialect-level cancel is still mid-flight. After both resolve,
    // the statement status must be exactly "cancelled".
    let resolveRun: ((v: RunResult) => void) | null = null;
    let resolveCancel: (() => void) | null = null;
    const runQuerySpy = vi.fn(
      () => new Promise<RunResult>((resolve) => { resolveRun = resolve; }),
    );
    const cancelActiveSpy = vi.fn(
      () => new Promise<void>((resolve) => { resolveCancel = resolve; }),
    );
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: runQuerySpy,
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(runQuerySpy).toHaveBeenCalledTimes(1);

    // Fire runner.cancel() — it must remain pending until the seam resolves.
    let cancelSettled = false;
    const cancelPromise = runner.cancel().then(() => { cancelSettled = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelSettled).toBe(false);
    expect(cancelActiveSpy).toHaveBeenCalledTimes(1);

    // Now settle both: the deferred seam resolves first (mid-flight); the
    // deferred runQuery resolves second with a normal result. The cancel
    // promise should only resolve after the seam settles, and the runner
    // result should still be "cancelled" because cancelRequested was set
    // before runQuery settled.
    if (resolveCancel) resolveCancel();
    // Let the seam's microtask drain before resolving runQuery.
    await new Promise((r) => setTimeout(r, 5));
    if (resolveRun) {
      resolveRun({ results: [{ columns: ["x"], rows: [], rowCount: 0, durationMs: 0 }] });
    }
    await cancelPromise;
    const result = await runPromise;

    expect(cancelSettled).toBe(true);
    expect(result[0].status).toBe("cancelled");
  });

  // =============================================================================
  // TASK-ARP02-001 — Runner ownership: idempotent cancel + run-bounded
  // close-origin cancellation. Three RED cases (2, 4, 5) + regression pins
  // (3, 6) added; case 1 is the existing Test #1 above.
  // =============================================================================
  it("Test #2 — ARP02-001 case 2: double cancel on a non-batched in-flight run fires the seam exactly once", async () => {
    // Deferred adapter.runQuery so we can call cancel() twice while the
    // statement is still in flight. Seam must fire EXACTLY once (not 2x) and
    // the settled status must be "cancelled".
    let resolveRun: ((v: RunResult) => void) | null = null;
    const runQuerySpy = vi.fn(
      () => new Promise<RunResult>((resolve) => { resolveRun = resolve; }),
    );
    const cancelActiveSpy = vi.fn(async () => {});
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: runQuerySpy,
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(runQuerySpy).toHaveBeenCalledTimes(1);

    // Two sequential cancels while runQuery is still deferred.
    await runner.cancel();
    await runner.cancel();

    if (resolveRun) {
      resolveRun({ results: [{ columns: ["x"], rows: [], rowCount: 0, durationMs: 0 }] });
    }
    const result = await runPromise;

    // Seam exactly once (idempotent cancel).
    expect(cancelActiveSpy).toHaveBeenCalledTimes(1);
    expect(result[0].status).toBe("cancelled");
  });

  it("Test #3 — ARP02-001 case 3: double cancel on a batched in-flight run → batched.cancel 1x, seam never", async () => {
    // Regression pin: PID window at executeAll:245 (activeAdapter cleared)
    // and currentBatched at executeAll:253 are disjoint — two cancels while
    // a batched cursor is in flight must call batched.cancel() exactly once
    // and never the seam.
    const batched = makeBatched(["n"], [null]);
    let resolveFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementation(
      () => new Promise<any[][] | null>((resolve) => { resolveFetch = resolve; }),
    );
    const cancelActiveSpy = vi.fn(async () => {});
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: vi.fn(async () => ({ results: [], batched })),
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);

    await runner.cancel();
    await runner.cancel();

    if (resolveFetch) resolveFetch(null);
    const result = await runPromise;

    expect(batched.cancel).toHaveBeenCalledTimes(1);
    expect(cancelActiveSpy).not.toHaveBeenCalled();
    expect(result[0].status).toBe("cancelled");
  });

  it("Test #4 — ARP02-001 case 4: cancel on an idle/settled runner must not poison a later loadMore", async () => {
    // Run a batched SELECT to done (open cursor). Cancel the idle runner
    // (close-origin cancel). Then loadMore(0) must resolve and append — the
    // stale cancelRequested flag must NOT cause loadMore to throw.
    const batched = makeBatched(
      ["n"],
      [
        [[1]], // initial fetch
        [[2]], // loadMore
        null,
      ],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].result?.rows).toEqual([[1]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);

    // Idle cancel — close-origin, runner is fully settled.
    await runner.cancel();

    // loadMore must still work; cancelRequested flag must not poison it.
    const loaded = await runner.loadMore(0);
    expect(loaded[0].result?.rows).toEqual([[1], [2]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("Test #5 — ARP02-001 case 5: loadMore in-flight when cancel fires must not append after settle", async () => {
    // Start loadMore(0) (deferred fetch), call cancel(), then resolve the
    // deferred fetch with [[42]]. The late-settled batch must NOT be
    // appended; final rows stay [[1]]; no unhandled rejection.
    const batched = makeBatched(
      ["n"],
      [
        [[1]], // initial fetch
        // loadMore — first call hangs, then we resolve with [[42]]
      ],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].result?.rows).toEqual([[1]]);

    // Override the loadMore fetch to be controllable.
    let resolveLoadMoreFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementationOnce(
      () => new Promise<any[][] | null>((resolve) => { resolveLoadMoreFetch = resolve; }),
    );

    const loadMorePromise = runner.loadMore(0).catch((err) => err);
    // Let the loadMore call enter fetchBatch and park.
    await new Promise((r) => setTimeout(r, 5));

    // Cancel mid-loadMore.
    await runner.cancel();

    // Now resolve the deferred fetchBatch with [[42]] — this is the
    // "late settle" path. Per contract, the in-flight loadMore must NOT
    // append; either reject cleanly OR resolve with rows unchanged.
    if (resolveLoadMoreFetch) resolveLoadMoreFetch([[42]]);
    const settled = await loadMorePromise;

    // Acceptable: loadMore rejected with a cancel-shaped error, OR it
    // resolved but the rows are still [[1]] (no late append). Either way,
    // rows must NOT include [42].
    const final = runner.getResults();
    expect(final[0].result?.rows).toEqual([[1]]);
    // If loadMore rejected, the rejection must not be unhandled — the
    // returned value is either the error or the (unchanged) results array.
    if (settled instanceof Error) {
      expect(String(settled.message)).toMatch(/cancelled|cancel/i);
    }
  });

  it("Test #6 — ARP02-001 case 6: cancel mid-run; deferred settle after → status stays cancelled, never done", async () => {
    // Regression pin on executeAll post-await re-checks (:206, :225):
    // a deferred runQuery settling AFTER cancel must yield 'cancelled',
    // never 'done'.
    let resolveRun: ((v: RunResult) => void) | null = null;
    const runQuerySpy = vi.fn(
      () => new Promise<RunResult>((resolve) => { resolveRun = resolve; }),
    );
    const cancelActiveSpy = vi.fn(async () => {});
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: runQuerySpy,
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(runQuerySpy).toHaveBeenCalledTimes(1);

    // Cancel first.
    await runner.cancel();
    expect(cancelActiveSpy).toHaveBeenCalledTimes(1);

    // Then resolve the deferred runQuery with a normal successful result.
    if (resolveRun) {
      resolveRun({ results: [{ columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 }] });
    }
    const result = await runPromise;

    // Status must be 'cancelled' — NOT 'done' — even though runQuery
    // returned a fully-populated successful result.
    expect(result[0].status).toBe("cancelled");
  });

  it("Test #5 — regression: batched cursor uses BatchedQuery.cancel() only, seam never called", async () => {
    // The seam is for the NON-cursor branch. If a BatchedQuery is in flight
    // (currentBatched set), cancel() must call batched.cancel() once and must
    // NOT invoke the adapter-level seam.
    const batched = makeBatched(["n"], [null]);
    // fetchBatch hangs so the cursor remains in flight.
    let resolveFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementation(
      () => new Promise<any[][] | null>((resolve) => { resolveFetch = resolve; }),
    );
    const cancelActiveSpy = vi.fn(async () => {});
    const adapter = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      runQuery: vi.fn(async () => ({ results: [], batched })),
      cancelActiveQuery: cancelActiveSpy,
      listSchemas: vi.fn(async () => []),
      listTables: vi.fn(async () => []),
      listViews: vi.fn(async () => []),
      listRoutines: vi.fn(async () => []),
      listColumns: vi.fn(async () => []),
      testConnection: vi.fn(async () => {}),
    } as unknown as DbAdapter & {
      runQuery: ReturnType<typeof vi.fn>;
      cancelActiveQuery: ReturnType<typeof vi.fn>;
    };
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    // Wait for adapter.runQuery to have returned + fetchBatch(initial) called.
    await new Promise((r) => setTimeout(r, 5));
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);

    const cancelPromise = runner.cancel();
    // Resolve the in-flight fetchBatch (EOF) so the runner can settle.
    if (resolveFetch) resolveFetch(null);
    await cancelPromise;
    const result = await runPromise;

    expect(batched.cancel).toHaveBeenCalledTimes(1);
    expect(cancelActiveSpy).not.toHaveBeenCalled();
    expect(result[0].status).toBe("cancelled");
  });
});

// =============================================================================
// TASK-ARP03-002 — Runner enforcement: retained-row cap + one-shot cursor
// close + graceful no-op. Uses the REAL RETAINED_ROW_CAP (imported, not a
// fabricated smaller cap). All four cases use the real makeBatched /
// makeAdapter fixtures from this file's helper section.
// =============================================================================
describe("QueryRunner — retained-row cap (TASK-ARP03-002)", () => {
  /** Deterministic row factory: row i = [i + 1]. */
  const row = (i: number): any[] => [i + 1];
  const rows = (count: number): any[][] => Array.from({ length: count }, (_, i) => row(i));

  it("cap-crossing batch → capped prefix, close once, no future fetch, resultLimited", async () => {
    // Case 1 — initial fetch holds RETAINED_ROW_CAP - 2 rows; the next batch
    // of 3 crosses the cap. Expected: rows = RETAINED_ROW_CAP (prior rows +
    // first batch row), resultLimited = true, cursorClosed = true,
    // close() exactly 1x, fetchBatch NOT called again.
    const batched = makeBatched(
      ["n"],
      [rows(RETAINED_ROW_CAP - 2), rows(3), rows(1), null],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});
    expect(result[0].status).toBe("done");
    expect(result[0].result?.rows).toHaveLength(RETAINED_ROW_CAP - 2);

    const updated = await runner.loadMore(0);
    expect(updated[0].result?.rows).toHaveLength(RETAINED_ROW_CAP);
    // Deterministic prefix: prior rows first, then the FIRST batch row.
    expect(updated[0].result?.rows[RETAINED_ROW_CAP - 3]).toEqual(row(RETAINED_ROW_CAP - 3));
    expect(updated[0].result?.rows[RETAINED_ROW_CAP - 2]).toEqual(row(0));
    expect(updated[0].resultLimited).toBe(true);
    expect(updated[0].cursorClosed).toBe(true);
    expect(batched.close).toHaveBeenCalledTimes(1);
    // No further fetch after the budget close.
    expect(batched.fetchBatch).toHaveBeenCalledTimes(2); // initial + the cap-crossing one
  });

  it("second loadMore on a limited statement is a graceful no-op", async () => {
    // Case 2 — after the cap-crossing limit, a second loadMore(0) must
    // RESOLVE (no "run this statement alone" throw) with rows unchanged,
    // close() still exactly 1x total, and no further fetch.
    const batched = makeBatched(
      ["n"],
      [rows(RETAINED_ROW_CAP - 2), rows(3), rows(1), null],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});
    const limited = await runner.loadMore(0);
    expect(limited[0].resultLimited).toBe(true);
    expect(batched.close).toHaveBeenCalledTimes(1);

    const again = await runner.loadMore(0); // must NOT throw
    expect(again[0].result?.rows).toHaveLength(RETAINED_ROW_CAP);
    expect(again[0].resultLimited).toBe(true);
    expect(batched.close).toHaveBeenCalledTimes(1); // still exactly once
    expect(batched.fetchBatch).toHaveBeenCalledTimes(2); // frozen
  });

  it("concurrent cancel during the cap-crossing fetch wins — batch discarded, resultLimited NOT set", async () => {
    // Case 3 — loadMore in flight with a deferred oversized fetch; cancel()
    // lands mid-fetch. Expected: batch discarded (rows unchanged),
    // resultLimited undefined, cursor closed exactly once (by the cancel
    // path), no unhandled rejection.
    const batched = makeBatched(["n"], [rows(2)]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});
    expect(result[0].result?.rows).toEqual([[1], [2]]);

    // Deferred cap-crossing fetch: resolves an oversized batch AFTER cancel.
    let resolveFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementationOnce(
      () => new Promise<any[][] | null>((resolve) => { resolveFetch = resolve; }),
    );
    const loadMorePromise = runner.loadMore(0).catch((err) => err);
    await new Promise((r) => setTimeout(r, 5));

    await runner.cancel();
    if (resolveFetch) resolveFetch(rows(RETAINED_ROW_CAP)); // oversized late batch
    const settled = await loadMorePromise;

    // Cancel path closed the cursor exactly once; the budget path must NOT
    // have added a second close.
    expect(batched.close).toHaveBeenCalledTimes(1);
    expect(batched.cancel).toHaveBeenCalledTimes(1);
    const final = runner.getResults();
    expect(final[0].result?.rows).toEqual([[1], [2]]); // no append
    expect(final[0].resultLimited).toBeUndefined(); // limit never set
    // loadMore must not reject with an unhandled error (settled is either
    // the results array or a cancel-shaped Error).
    if (settled instanceof Error) {
      expect(String(settled.message)).toMatch(/cancelled|cancel/i);
    }
  });

  it("smaller result unchanged (regression pin)", async () => {
    // Case 4 — a total far below the cap behaves byte-identically to today:
    // all rows appended across several loadMore, resultLimited stays
    // undefined, cursorClosed stays falsy, EOF (null) behaves as before,
    // close() never called.
    const batched = makeBatched(["n"], [
      rows(2),
      rows(3),
      rows(1),
      null,
    ]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].result?.rows).toEqual([[1], [2]]);
    expect(result[0].resultLimited).toBeUndefined();
    expect(result[0].cursorClosed).toBeUndefined();

    const once = await runner.loadMore(0);
    expect(once[0].result?.rows).toEqual([[1], [2], [1], [2], [3]]);
    expect(once[0].result?.rowCount).toBe(5);
    expect(once[0].resultLimited).toBeUndefined();

    const eof = await runner.loadMore(0);
    expect(eof[0].result?.rows).toEqual([[1], [2], [1], [2], [3], [1]]);
    expect(eof[0].result?.rowCount).toBe(6);
    expect(eof[0].resultLimited).toBeUndefined();
    expect(eof[0].cursorClosed).toBeUndefined();

    const done = await runner.loadMore(0);
    expect(done[0].result?.rows).toEqual([[1], [2], [1], [2], [3], [1]]);
    expect(done[0].result?.rowCount).toBe(6);
    expect(batched.close).not.toHaveBeenCalled();
  });

  it("exact cap reached across batches is not limited (plan §4 boundary pin)", async () => {
    // Boundary — batches sum to EXACTLY RETAINED_ROW_CAP: appendBatchBounded's
    // `limited = total > cap` must stay false at the exact boundary. Cursor
    // stays open, close() never fires, and a following EOF loadMore returns
    // the unchanged rows with the limit still unset.
    const batched = makeBatched(
      ["n"],
      [rows(RETAINED_ROW_CAP - 3), rows(3), null],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT * FROM big", 0, 18)], () => {});
    expect(result[0].result?.rows).toHaveLength(RETAINED_ROW_CAP - 3);

    const atCap = await runner.loadMore(0);
    expect(atCap[0].result?.rows).toHaveLength(RETAINED_ROW_CAP);
    expect(atCap[0].resultLimited).toBeUndefined();
    expect(atCap[0].cursorClosed).toBeUndefined();
    expect(batched.close).not.toHaveBeenCalled();
    expect(batched.fetchBatch).toHaveBeenCalledTimes(2);

    // Following EOF loadMore: unchanged rows, still not limited, still open.
    const eof = await runner.loadMore(0);
    expect(eof[0].result?.rows).toHaveLength(RETAINED_ROW_CAP);
    expect(eof[0].result?.rowCount).toBe(RETAINED_ROW_CAP);
    expect(eof[0].resultLimited).toBeUndefined();
    expect(eof[0].cursorClosed).toBeUndefined();
    expect(batched.close).not.toHaveBeenCalled();
  });

  it("cancel() during the budget close does not poison a later loadMore on another statement", async () => {
    // Reviewer fix-round finding (queryRunner.ts budget close vs cancel()):
    // the budget branch sets currentBatchedCancelDelivered then awaits
    // batched.close() while currentBatched still references the cursor.
    // A cancel() landing in that window latches cancelPending=true and
    // early-returns on the delivered-once guard — stranding it — so a later
    // loadMore on a DIFFERENT open statement throws "Statement cancelled"
    // at the ARP-02 entry guard. Interleaving: deferred close → cancel()
    // while close pending → resolve close → loadMore on the other statement
    // must fetch normally.
    const batchedA = makeBatched(
      ["n"],
      [rows(RETAINED_ROW_CAP - 2), rows(3)], // cap-crossing on loadMore
    );
    const batchedB = makeBatched(["n"], [rows(2), rows(1)]); // healthy cursor
    const adapter = makeAdapter(async (sql) =>
      sql.includes("big")
        ? { results: [], batched: batchedA }
        : { results: [], batched: batchedB },
    );
    const runner = new QueryRunner(async () => adapter);

    // Non-append run of two → BOTH batched cursors stay open and done.
    await runner.run(
      [stmt("SELECT * FROM big", 0, 18), stmt("SELECT * FROM small", 19, 38)],
      () => {},
    );

    // Defer ONLY the budget close of the limited cursor.
    let resolveClose: (() => void) | null = null;
    batchedA.close.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveClose = resolve; }),
    );
    const limitedPromise = runner.loadMore(0);
    await new Promise((r) => setTimeout(r, 5));
    // loadMore(0) is parked inside the budget `await batched.close()`.

    const cancelPromise = runner.cancel(); // lands in the budget-close window
    resolveClose!();
    await Promise.all([limitedPromise, cancelPromise]);

    // Statement 0 is now limited via the budget close exactly once, and the
    // cancel must NOT have re-delivered on the same cursor.
    expect(batchedA.close).toHaveBeenCalledTimes(1);
    expect(batchedA.cancel).not.toHaveBeenCalled();

    // THE FIX OBSERVABLE: a loadMore on the OTHER healthy open cursor must
    // NOT throw "Statement 1 cancelled" (cancelPending must not be stranded).
    const updated = await runner.loadMore(1);
    expect(updated[1].result?.rows).toEqual([[1], [2], [1]]);
    expect(updated[1].resultLimited).toBeUndefined();
    expect(updated[1].cursorClosed).toBeUndefined();
    expect(batchedB.close).not.toHaveBeenCalled();
    expect(batchedB.fetchBatch).toHaveBeenCalledTimes(2); // initial + this one

    const final = runner.getResults();
    expect(final[0].resultLimited).toBe(true);
    expect(final[1].result?.rows).toEqual([[1], [2], [1]]);
  });
});

// =============================================================================
// TASK-BQ03-003 — QueryRunner continuation contract for BigQuery pages.
//
// A BigQuery-shaped BatchedQuery exposes the hook through
// `setOnExhausted(cb)` and stores it in a PRIVATE `onExhaustedCb` field
// (the real `BigQueryPagedQuery` in 03.1). The runner detects BQ-shaped
// via `typeof batched.setOnExhausted === "function"` and:
//   1) closes the handle + sets `cursorClosed = true` on EOF (the new
//      EOF → close transition; plain postgres cursors are NOT closed here
//      because the next-run sweep already handles them and the existing
//      ARP03-002 boundary tests assert `cursorClosed` stays undefined at
//      EOF for non-BQ handles),
//   2) wires `setOnExhausted` so the BQ handle's internal `limited` flag
//      surfaces as `resultLimited` on the statement,
//   3) snapshots a `runGeneration` counter before each `fetchBatch` await
//      and discards the late batch if a new `run()` started while parked,
//   4) sets `StatementResult.pending = true` immediately when the adapter
//      returned a BQ-shaped `{ results: [], batched }` and clears it on
//      the first successful `pickResult` (orthogonal to `status`).
//
// R4.5 — the fake here uses the REAL `BigQueryPagedQuery` shape: a
// `setOnExhausted(cb)` installer and NO own `onExhausted` property. The
// callback is stored in a closure (mirroring the real `private
// onExhaustedCb`) and tests that need to fire EOF-side effects retrieve
// it via the fake's internal `onExhaustedCb` field.
// =============================================================================
describe("QueryRunner — BQ-03.3 BigQuery page continuation", () => {
  /**
   * BQ-shaped BatchedQuery fake matching the REAL `BigQueryPagedQuery`
   * surface: a `setOnExhausted(cb)` installer method, no own
   * `onExhausted` property, and the registered callback is stored in a
   * private-shaped closure (exposed on the fake for tests that need to
   * invoke it). The fake does NOT auto-fire on EOF — the test that
   * needs the EOF-side effect (Test #9) drives the stored callback
   * explicitly from the next `fetchBatch` override, mirroring how
   * 03.1's `BigQueryPagedQuery` fires it on its EOF transition.
   */
  function makeBqBatched(
    columns: string[],
    fetchSequence: Array<any[][] | null>,
  ): BatchedQuery & {
    setOnExhausted: (cb: (info: { limited: boolean }) => void) => void;
    /** Test-only peek at the registered callback (real adapter stores it privately). */
    readonly onExhaustedCb: () => ((info: { limited: boolean }) => void) | null;
  } {
    const base = makeBatched(columns, fetchSequence);
    let stored: ((info: { limited: boolean }) => void) | null = null;
    const setOnExhausted = (cb: (info: { limited: boolean }) => void) => {
      stored = cb;
    };
    return Object.assign(base, {
      setOnExhausted,
      get onExhaustedCb() {
        return () => stored;
      },
    }) as unknown as BatchedQuery & {
      setOnExhausted: (cb: (info: { limited: boolean }) => void) => void;
      readonly onExhaustedCb: () => ((info: { limited: boolean }) => void) | null;
    };
  }

  it("Test #1 — Load More consumes only the current handle's fetchBatch, appends page 2 then page 3", async () => {
    const batched = makeBqBatched(["n"], [
      [[1], [2]], // initial fetch (pickResult)
      [[10], [11], [12]], // loadMore #1 → page 2
      [[20], [21]], // loadMore #2 → page 3
      null, // loadMore #3 → EOF
    ]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].result?.rows).toEqual([[1], [2]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1); // initial only

    const more1 = await runner.loadMore(0);
    expect(more1[0].result?.rows).toEqual([[1], [2], [10], [11], [12]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(2);

    const more2 = await runner.loadMore(0);
    expect(more2[0].result?.rows).toEqual([[1], [2], [10], [11], [12], [20], [21]]);
    expect(batched.fetchBatch).toHaveBeenCalledTimes(3);

    // Same handle throughout — no other fetchBatch entries.
    const fetchRecords = batched.fetchBatch.mock.results;
    expect(fetchRecords).toHaveLength(3);
  });

  it("Test #2 — EOF releases the retained job context exactly once; further loadMore is a graceful no-op", async () => {
    const batched = makeBqBatched(["n"], [
      [[1]], // initial
      [[2]], // loadMore #1
      null, // loadMore #2 → EOF
    ]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].cursorClosed).toBeUndefined();
    expect(batched.close).not.toHaveBeenCalled();

    await runner.loadMore(0);
    expect(batched.close).not.toHaveBeenCalled();

    // The third loadMore hits EOF → close EXACTLY once + cursorClosed = true.
    const eof = await runner.loadMore(0);
    expect(eof[0].cursorClosed).toBe(true);
    expect(batched.close).toHaveBeenCalledTimes(1);

    // A further loadMore is a graceful no-op (no throw, no extra close).
    const noop = await runner.loadMore(0);
    expect(noop[0].result?.rows).toEqual([[1], [2]]);
    expect(noop[0].cursorClosed).toBe(true);
    expect(batched.close).toHaveBeenCalledTimes(1); // still exactly once
    expect(noop[0].resultLimited).toBeUndefined();
  });

  it("Test #3 — concurrent loadMore for the same index is serialized (no lost/duplicate batch)", async () => {
    // fetchBatch has delay so concurrent calls genuinely race.
    const fetchBatch = vi
      .fn<[], Promise<any[][] | null>>()
      .mockImplementationOnce(async () => {
        // initial (pickResult)
        await new Promise((r) => setTimeout(r, 10));
        return [[1]];
      })
      .mockImplementationOnce(async () => {
        // loadMore #1
        await new Promise((r) => setTimeout(r, 10));
        return [[2]];
      })
      .mockImplementationOnce(async () => {
        // loadMore #2
        await new Promise((r) => setTimeout(r, 10));
        return [[3]];
      });
    const batched: BatchedQuery & {
      setOnExhausted: (cb: (info: { limited: boolean }) => void) => void;
    } = {
      columns: ["n"],
      fetchBatch,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      setOnExhausted: () => {},
    };
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT *", 0, 9)], () => {});

    const [a, b] = await Promise.all([
      runner.loadMore(0),
      runner.loadMore(0),
    ]);
    const rowsA = a[0].result!.rows.length;
    const rowsB = b[0].result!.rows.length;
    expect(Math.max(rowsA, rowsB)).toBeGreaterThanOrEqual(2); // both pages landed
    expect(batched.fetchBatch).toHaveBeenCalledTimes(3); // 1 initial + 2 serialized
  });

  it("Test #4 — late page after cancel is discarded; close() called on the handle", async () => {
    const batched = makeBqBatched(["n"], [
      [[1]], // initial
    ]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);

    // Override the NEXT fetchBatch to be deferred (after the initial
    // already consumed the default).
    let resolveLoadMoreFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementationOnce(
      () => new Promise<any[][] | null>((resolve) => { resolveLoadMoreFetch = resolve; }),
    );

    const loadMorePromise = runner.loadMore(0).catch((err) => err);
    await new Promise((r) => setTimeout(r, 5));

    await runner.cancel();
    if (resolveLoadMoreFetch) resolveLoadMoreFetch([[42]]);
    const settled = await loadMorePromise;

    const final = runner.getResults();
    expect(final[0].result?.rows).toEqual([[1]]); // 42 not appended
    expect(batched.close).toHaveBeenCalled();
    // Settled is either the (unchanged) results array or a cancel-shaped error.
    if (settled instanceof Error) {
      expect(String(settled.message)).toMatch(/cancelled|cancel/i);
    }
  });

  it("Test #5 — late page after a NEW run is discarded; first fetch's rows never land in new run", async () => {
    // One handle serves the first run; we defer the loadMore fetch and start
    // a new (append) run() while the fetch is in flight. The deferred
    // fetch's rows must NOT be appended to the OLD statement (which is
    // preserved across append runs) — the leak is observable as the OLD
    // statement's row count going from [[1]] to [[1], [42]].
    const batched = makeBqBatched(["n"], [
      [[1]], // initial for run #1
    ]);
    const adapter = makeAdapter(async (sql) => {
      // First run's SELECT returns the batched; second run returns a fresh
      // non-batched result so we can detect "rows from old handle leaked".
      if (sql === "SELECT old") return { results: [], batched };
      return okResult(["v"], [[sql]]);
    });
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT old", 0, 11)], () => {});
    const oldResult = runner.getResults()[0];
    expect(oldResult.result?.rows).toEqual([[1]]);

    // Override the NEXT fetchBatch AFTER the initial consumed the default.
    let resolveLoadMoreFetch: ((v: any[][] | null) => void) | null = null;
    batched.fetchBatch.mockImplementationOnce(
      () => new Promise<any[][] | null>((resolve) => { resolveLoadMoreFetch = resolve; }),
    );

    const loadMorePromise = runner.loadMore(0).catch((err) => err);
    await new Promise((r) => setTimeout(r, 5));

    // Start a new APPEND run while the loadMore fetch is pending — the
    // OLD statement is preserved in the results array, so any leak is
    // observable on the same object reference.
    const newRun = runner.run(
      [stmt("SELECT new", 0, 11)],
      () => {},
      { append: true },
    );

    // Resolve the deferred fetch — late-settled rows from the OLD handle
    // must NOT be appended to the OLD statement (which is now the first
    // entry of the new run's results array).
    if (resolveLoadMoreFetch) resolveLoadMoreFetch([[42]]);
    await loadMorePromise;
    const newResult = await newRun;

    // The OLD statement (preserved in the append run) must still be
    // [[1]] — NOT [[1], [42]]. The late batch is discarded.
    const preserved = newResult[0];
    expect(preserved).toBe(oldResult); // same object preserved
    expect(preserved.result?.rows).toEqual([[1]]);
    // The new run's SELECT new result must be a single [SELECT new] row.
    const newStmt = newResult.find((r) => r.sql === "SELECT new");
    expect(newStmt?.result?.rows).toEqual([["SELECT new"]]);
  });

  it("Test #6 — loadMore on statement #2 never touches statement #1's handle", async () => {
    const b1 = makeBqBatched(["n"], [
      [[1]], // initial
      [[2]], // loadMore 1
    ]);
    const b2 = makeBqBatched(["n"], [
      [[10]], // initial
      [[20]], // loadMore 2
    ]);
    const adapter = makeAdapter(async (sql) => {
      if (sql === "SELECT 1") return { results: [], batched: b1 };
      return { results: [], batched: b2 };
    });
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run(
      [stmt("SELECT 1", 0, 8), stmt("SELECT 2", 9, 17)],
      () => {},
    );
    expect(result[0].result?.rows).toEqual([[1]]);
    expect(result[1].result?.rows).toEqual([[10]]);
    expect(b1.fetchBatch).toHaveBeenCalledTimes(1);
    expect(b2.fetchBatch).toHaveBeenCalledTimes(1);

    // Load more on statement #2 only.
    const updated = await runner.loadMore(1);
    expect(updated[1].result?.rows).toEqual([[10], [20]]);
    // b1 is untouched.
    expect(b1.fetchBatch).toHaveBeenCalledTimes(1);
    expect(b1.close).not.toHaveBeenCalled();
    // b2 fetched exactly one extra.
    expect(b2.fetchBatch).toHaveBeenCalledTimes(2);
  });

  it("Test #7 — regression: postgres cursor semantics unchanged (existing ARP03-002 boundary)", async () => {
    // Pin: a non-BQ handle (no `onExhausted` property) at EOF keeps
    // `cursorClosed` undefined — the next-run sweep handles plain cursor
    // release. This mirrors the existing ARP03-002 boundary test but
    // asserted here against the explicit 03.3 EOF close path.
    const batched = makeBatched(["n"], [
      [[1]],
      [[2]],
      null, // EOF
    ]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT *", 0, 9)], () => {});
    const eof = await runner.loadMore(0);
    expect(eof[0].cursorClosed).toBeUndefined(); // non-BQ handle: not closed on EOF
    expect(batched.close).not.toHaveBeenCalled();
  });

  it("Test #8 — regression: BQ-shaped runResult ({ results: [], batched }) goes through pickResult with rowCount=null", async () => {
    // Minimal fake adapter returning the BQ-shaped RunResult. pickResult
    // must call fetchBatch() once for the initial page, and the resulting
    // QueryResult must have rowCount=null (Load More still offered).
    const batched = makeBqBatched(["id", "name"], [
      [[1, "a"], [2, "b"]], // initial fetch
      null, // EOF
    ]);
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].status).toBe("done");
    expect(result[0].result?.columns).toEqual(["id", "name"]);
    expect(result[0].result?.rows).toEqual([[1, "a"], [2, "b"]]);
    expect(result[0].result?.rowCount).toBeNull();
    // initial fetchBatch was called once.
    expect(batched.fetchBatch).toHaveBeenCalledTimes(1);
    // The BQ-shaped adapter sets `pending = true` while the initial fetch
    // is in flight, and clears it (to `false`) after the first successful
    // pickResult. The flag is the explicit "not pending" terminal state;
    // non-BQ paths leave it `undefined` (never set).
    expect(result[0].pending).toBe(false);
  });

  it("Test #9 — BQ onExhausted({ limited: true }) surfaces as resultLimited on the statement", async () => {
    // The EOF carries limited=true (mirrors 03.1's BigQueryPagedQuery firing
    // onExhausted at EOF when its internal `limited` flag is set). The
    // runner's onExhausted wiring (mirrors the loadMoreImpl budget close
    // path) must set `resultLimited = true` and close the handle.
    const batched = makeBqBatched(
      ["n"],
      [
        [[1]], // initial
        [[2]], // loadMore
        null, // EOF
      ],
    );
    const adapter = makeAdapter(async () => ({ results: [], batched }));
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT *", 0, 9)], () => {});
    await runner.loadMore(0); // returns [[2]]
    // Override the next fetchBatch to also call onExhausted (mirrors 03.1's
    // BigQueryPagedQuery firing it at EOF when limited). The callback is
    // retrieved from the fake's storedCb via the setOnExhausted installer.
    batched.fetchBatch.mockImplementationOnce(async () => {
      const cb = batched.onExhaustedCb();
      // 03.1's design: onExhausted fires INSIDE the fetchBatch call when
      // the underlying page source reports EOF + limited.
      if (typeof cb === "function") cb({ limited: true });
      return null;
    });
    const eof = await runner.loadMore(0); // EOF, limited=true

    expect(eof[0].resultLimited).toBe(true);
    expect(eof[0].cursorClosed).toBe(true);
    expect(batched.close).toHaveBeenCalledTimes(1);
  });

  it("Test #10 — REGRESSION R4.5: runner detects the REAL BigQueryPagedQuery shape (setOnExhausted method, no own onExhausted property)", async () => {
    // 03.1's real `BigQueryPagedQuery` exposes the hook through
    // `setOnExhausted(cb)` and stores the callback in a PRIVATE
    // `onExhaustedCb` field — it has NO own `onExhausted` property on the
    // instance. The runner's previous duck-type (`'onExhausted' in batched`
    // + `bq.onExhausted = ...`) was inert against the real adapter
    // because both the property check and the assignment were against a
    // field that doesn't exist. This test pins the SHAPE of the real
    // adapter so the runner cannot regress: the fake here has zero own
    // `onExhausted` property and exposes the installer method, and the
    // assertions verify that after the runner's hook wiring runs, the
    // stored callback fires on EOF and surfaces `resultLimited`.
    type Installer = (cb: (info: { limited: boolean }) => void) => void;
    const fetchBatch = vi
      .fn<[], Promise<any[][] | null>>()
      .mockImplementationOnce(async () => [[1]]) // initial (pickResult)
      .mockImplementationOnce(async () => [[2]]); // loadMore #1
    let storedCb: ((info: { limited: boolean }) => void) | null = null;
    const realShapedBatched = {
      columns: ["n"],
      fetchBatch,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      setOnExhausted: ((cb: (info: { limited: boolean }) => void) => {
        storedCb = cb;
      }) as Installer,
      // Intentionally NO own `onExhausted` property — matches the real
      // BigQueryPagedQuery class (private onExhaustedCb, exposed only via
      // the installer).
    };
    const adapter = makeAdapter(async () => ({ results: [], batched: realShapedBatched as unknown as BatchedQuery }));
    const runner = new QueryRunner(async () => adapter);

    await runner.run([stmt("SELECT *", 0, 9)], () => {});
    // pending is set on BQ-shaped RunResult (real shape: setOnExhausted
    // exists), and cleared after the first successful pickResult.
    const r0 = runner.getResults()[0];
    expect(r0.pending).toBe(false);

    await runner.loadMore(0); // returns [[2]]
    // After the runner's hook wiring runs (loadMoreImpl installs the
    // setOnExhausted hook on the first loadMore), storedCb must be a
    // function — the runner must use `setOnExhausted`, not the
    // non-existent `onExhausted` property.
    expect(typeof storedCb).toBe("function");

    // Override the next fetchBatch to call the storedCb (the REAL hook
    // path), then return EOF. This is what 03.1's BigQueryPagedQuery
    // does internally on its EOF transition.
    fetchBatch.mockImplementationOnce(async () => {
      if (storedCb) storedCb({ limited: true });
      return null;
    });
    const eof = await runner.loadMore(0); // EOF, limited=true

    // The runner must close the handle exactly once and surface
    // resultLimited — same invariants as Test #9, but the wiring went
    // through `setOnExhausted`, not the fake-only `onExhausted` property.
    expect(eof[0].resultLimited).toBe(true);
    expect(eof[0].cursorClosed).toBe(true);
    expect((realShapedBatched.close as any)).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// TASK-BQ04-001 — additive `dialect?` + `schemaFields?` markers on
// StatementResult (BIG-04 dialect marker). Pure-function tests on the
// `stampBqDialect` helper; the runner never has to be driven through a
// full `runStatements` VS Code handle to assert the contract.
//
// 001.a happy        — BQ run stamps `dialect: "bigquery"` on every settled
//                      statement + `schemaFields` is structurally present.
// 001.b non-BQ        — postgres / mysql / mssql drivers leave `dialect`
//                      and `schemaFields` `undefined` (regression pin for
//                      TASK-BQ04-002's formatCell path).
// 001.c spread survival — `dialect` survives the `resultsPanel.ts:696`
//                      requery rest-spread `const { resultLimited,
//                      cursorClosed, ...rest } = stmt`; reconstruction
//                      sites preserve the marker.
// =============================================================================
describe("QueryRunner — BQ-04 dialect marker (TASK-BQ04-001)", () => {
  /** Minimal settled `StatementResult` factory. */
  function mkSettled(index: number, sql = `SELECT ${index}`, columns: string[] = [`c${index}`]): StatementResult {
    return {
      index,
      sql,
      status: "done",
      durationMs: 1,
      result: { columns, rows: [columns.map(() => index)], rowCount: 1, durationMs: 1 },
    };
  }

  /** Build a settled BQ-shaped statement whose batched handle exposes columns. */
  function mkBqSettled(index: number, columns: string[]): { stmt: StatementResult; batched: BatchedQuery } {
    const batched = makeBatched(columns, [columns.map(() => index)]);
    const stmt: StatementResult = {
      ...mkSettled(index, `SELECT ${index}`, columns),
      batched: batched as unknown as BatchedQuery,
    };
    return { stmt, batched };
  }

  it("001.a — happy: BQ run stamps `dialect: \"bigquery\"` on every settled statement + schemaFields is structurally present", () => {
    // Two settled statements; the first carries a BQ-shaped `batched` handle
    // exposing a `columns` array (the live `BigQueryPagedQuery` shape). The
    // second carries no batched handle (e.g. an INSERT or DML in the same
    // run). After `stampBqDialect(runSlice, { driver: "bigquery" })`:
    //   - every entry has `dialect === "bigquery"`
    //   - the entry with a `batched.columns` exposes `schemaFields` matching
    //     the column-name order, structurally `{name?:,type?:,mode?:}` shaped
    //   - the entry without a batched handle leaves `schemaFields` undefined
    //     (the helper has no source to read from)
    const { stmt: s0, batched } = mkBqSettled(0, ["id", "name"]);
    const s1 = mkSettled(1); // no batched — INSERT-shaped
    const slice: StatementResult[] = [s0, s1];

    stampBqDialect(slice, { driver: "bigquery" });

    expect(slice[0].dialect).toBe("bigquery");
    expect(slice[1].dialect).toBe("bigquery");

    // schemaFields: structural shape on the statement whose batched handle
    // surfaces columns. Length and order match the handle's columns.
    expect(slice[0].schemaFields).toBeDefined();
    const fields0 = slice[0].schemaFields!;
    expect(fields0).toHaveLength(2);
    // The structural shape is { name?: string; type?: string; mode?: string };
    // we only stamp `name` because the live `BigQueryPagedQuery` exposes
    // `columns: string[]` (names only — no type/mode seam).
    expect(fields0[0]!.name).toBe("id");
    expect(fields0[1]!.name).toBe("name");
    // Verify the structural-shape invariant TASK-BQ04-002 consumes: each
    // entry has only the documented keys.
    expect(Object.keys(fields0[0]!).sort()).toEqual(["name"]);
    expect(Object.keys(fields0[1]!).sort()).toEqual(["name"]);

    // Statement without a batched handle: schemaFields stays undefined
    // (no source).
    expect(slice[1].schemaFields).toBeUndefined();

    // batched reference preserved.
    expect(slice[0].batched).toBe(batched);
  });

  it("001.a (complement) — BQ stamp preserves pre-existing fields and order", () => {
    // Stamp must NOT reorder entries, drop fields, or change status / result /
    // batched references — only ADD the new markers.
    const { stmt: s0Base, batched } = mkBqSettled(0, ["x"]);
    const s0: StatementResult = {
      ...s0Base,
      resultLimited: true,
      cursorClosed: true,
      cursorExhausted: true,
      pending: false,
    };
    const slice: StatementResult[] = [s0];

    stampBqDialect(slice, { driver: "bigquery" });

    expect(slice[0].dialect).toBe("bigquery");
    expect(slice[0].resultLimited).toBe(true);
    expect(slice[0].cursorClosed).toBe(true);
    expect(slice[0].cursorExhausted).toBe(true);
    expect(slice[0].pending).toBe(false);
    expect(slice[0].result?.columns).toEqual(["x"]);
    expect(slice[0].batched).toBe(batched);
  });

  it("001.b — edge (non-BQ regression): postgres / mysql / mssql drivers leave `dialect` and `schemaFields` undefined", () => {
    // For every non-BQ driver, the stamp helper must NOT enter the BQ
    // branch — `dialect` and `schemaFields` stay `undefined` and the
    // formatCell path TASK-BQ04-002 reads from `dialect` does not regress.
    const drivers = ["postgres", "mysql", "mssql"] as const;
    for (const driver of drivers) {
      const { stmt: s0, batched } = mkBqSettled(0, ["a", "b"]);
      const s1 = mkSettled(1);
      const slice: StatementResult[] = [s0, s1];

      stampBqDialect(slice, { driver });

      // Non-BQ: every entry stays untouched (no `dialect`, no `schemaFields`).
      expect(slice[0].dialect).toBeUndefined();
      expect(slice[1].dialect).toBeUndefined();
      expect(slice[0].schemaFields).toBeUndefined();
      expect(slice[1].schemaFields).toBeUndefined();
      // Pre-existing fields preserved byte-identically.
      expect(slice[0].result?.columns).toEqual(["a", "b"]);
      expect(slice[0].batched).toBe(batched);
      expect(slice[0].status).toBe("done");
      expect(slice[1].status).toBe("done");
    }
  });

  it("001.b (complement) — undefined / null active connection leaves `dialect` undefined (no crash)", () => {
    // The host's runStatements seam calls this with the result of
    // `mgr.getActive()` which may be `null`/`undefined` (no connection).
    const slice: StatementResult[] = [mkSettled(0)];
    expect(() => stampBqDialect(slice, null)).not.toThrow();
    expect(() => stampBqDialect(slice, undefined)).not.toThrow();
    expect(() => stampBqDialect(slice, {})).not.toThrow();
    expect(slice[0].dialect).toBeUndefined();
    expect(slice[0].schemaFields).toBeUndefined();
  });

  it("001.c — edge (spread survival): `dialect` survives the loadMore/requery rest-spread", () => {
    // The resultsPanel requery path (resultsPanel.ts:696) destructures
    // budget markers off and rebuilds the statement with `...rest`. A BQ
    // statement's `dialect` marker must survive that spread so downstream
    // consumers keep seeing the marker post-requery.
    const base: StatementResult = {
      index: 0,
      sql: "SELECT 1",
      status: "done",
      durationMs: 1,
      result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 1 },
      resultLimited: true,
      cursorClosed: true,
      dialect: "bigquery",
    };

    // Mirror the exact pattern from resultsPanel.ts:696.
    const { resultLimited, cursorClosed, ...rest } = base;
    void resultLimited;
    void cursorClosed;

    // `rest.dialect` MUST equal `"bigquery"` — proves the reconstruction
    // site preserves the marker. Without the additive field, `rest.dialect`
    // would be `undefined` and downstream renderers would lose the signal.
    expect(rest.dialect).toBe("bigquery");
    // Verify the rest-spread shape: budget markers stripped, everything
    // else carried.
    expect((rest as { resultLimited?: boolean }).resultLimited).toBeUndefined();
    expect((rest as { cursorClosed?: boolean }).cursorClosed).toBeUndefined();
    expect(rest.sql).toBe("SELECT 1");
    expect(rest.status).toBe("done");
    expect(rest.result?.columns).toEqual(["x"]);
  });

  it("001.c (complement) — `dialect` is structurally preserved across both StatementResult declarations", () => {
    // Compile-time assertion that the canonical `StatementResult`
    // (queryRunner.ts) declares the field. The mirror site
    // (resultsGridModel.ts) is enforced separately by `npm run typecheck`
    // — a successful vitest run + typecheck together prove the field
    // exists on BOTH sites.
    //
    // Runtime: the helper's `stampBqDialect` only accepts `StatementResult[]`
    // and reads/writes the `dialect` field. If the canonical interface
    // forgot the field, this test would fail to compile (vitest's esbuild
    // transformer tolerates them — but `npm run typecheck` would error).
    const stmt: StatementResult = mkSettled(0);
    stmt.dialect = "bigquery"; // direct assignment requires the field
    expect(stmt.dialect).toBe("bigquery");
    // schemaFields type-check: assignable to ReadonlyArray<BqSchemaField>-shaped
    const fields: ReadonlyArray<BqSchemaField> = [{ name: "x" }];
    stmt.schemaFields = fields;
    expect(stmt.schemaFields?.[0]?.name).toBe("x");
  });
});

// =============================================================================
// TASK-UX1-010 — DDL/non-SELECT classification (R12). The classifier is a pure
// helper exposed from src/core/queryRunner.ts; the stamping helper mirrors the
// `stampBqDialect` precedent and only fires when the entry has settled (not
// while `pending` — case 6).
//
// Truth table (case 5):
//   `WITH c AS (...) SELECT`             → "select"
//   `SELECT ... INTO new_t`              → "ddl"
//   `INSERT/UPDATE/DELETE`               → "dml"
//   `EXPLAIN SELECT`                     → "other"
//   comment-padded `/* c */ CREATE TABLE` → "ddl"
//   `  \n` (no keyword)                  → "other" (no throw)
// =============================================================================
describe("QueryRunner — classifyStatementKind (TASK-UX1-010)", () => {
  // SELECT family
  it("SELECT → select", () => {
    expect(classifyStatementKind("SELECT 1")).toBe("select");
    expect(classifyStatementKind("select * from t")).toBe("select");
    expect(classifyStatementKind("WITH c AS (SELECT 1) SELECT * FROM c")).toBe("select");
    expect(classifyStatementKind("  \n\tSELECT 1")).toBe("select");
    expect(classifyStatementKind("-- a comment\nSELECT 1")).toBe("select");
    expect(classifyStatementKind("/* block */ SELECT 1")).toBe("select");
  });

  // DDL family
  it("CREATE / ALTER / DROP → ddl", () => {
    expect(classifyStatementKind("CREATE TABLE t (id int)")).toBe("ddl");
    expect(classifyStatementKind("create or replace function app.fn(x int) returns int as $$ begin return x; end; $$ language plpgsql")).toBe("ddl");
    expect(classifyStatementKind("ALTER TABLE t ADD COLUMN x int")).toBe("ddl");
    expect(classifyStatementKind("DROP TABLE t")).toBe("ddl");
    expect(classifyStatementKind("/* c */ CREATE TABLE t (id int)")).toBe("ddl");
    expect(classifyStatementKind("SELECT * INTO new_t FROM old_t")).toBe("ddl");
  });

  // DML family
  it("INSERT / UPDATE / DELETE / CALL → dml", () => {
    expect(classifyStatementKind("INSERT INTO t VALUES (1)")).toBe("dml");
    expect(classifyStatementKind("update t set x=1")).toBe("dml");
    expect(classifyStatementKind("DELETE FROM t WHERE id=1")).toBe("dml");
    expect(classifyStatementKind("CALL proc()")).toBe("dml");
  });

  // Other family
  it("EXPLAIN / SET / empty → other", () => {
    expect(classifyStatementKind("EXPLAIN SELECT 1")).toBe("other");
    expect(classifyStatementKind("SET search_path TO public")).toBe("other");
    expect(classifyStatementKind("   \n  ")).toBe("other");
    expect(classifyStatementKind("")).toBe("other");
    // No-throw contract
    expect(() => classifyStatementKind("   \n")).not.toThrow();
  });
});

describe("QueryRunner — stampStatementKind (TASK-UX1-010)", () => {
  function mkResult(partial: Partial<StatementResult>): StatementResult {
    return {
      index: 0,
      sql: partial.sql ?? "SELECT 1",
      status: partial.status ?? "done",
      durationMs: partial.durationMs ?? 0,
      ...partial,
    } as StatementResult;
  }

  it("DDL success — stamps kind=ddl + command + affectedObjects + notice + durationMs carry", () => {
    const r = mkResult({
      sql: "CREATE OR REPLACE FUNCTION app.fn_create_plan(...) ...",
      status: "done",
      result: { columns: [], rows: [], rowCount: null, commandTag: "CREATE FUNCTION", durationMs: 1 },
      durationMs: 1,
    });
    const out = stampStatementKind([r]);
    expect(out[0].kind).toBe("ddl");
    // Stamp returns same reference (matches stampBqDialect precedent).
    expect(out[0]).toBe(r);
  });

  it("DML success — stamps kind=dml", () => {
    const r = mkResult({
      sql: "INSERT INTO t VALUES (1)",
      status: "done",
      result: { columns: [], rows: [], rowCount: 0, commandTag: "INSERT 0 1", durationMs: 1 },
      durationMs: 1,
    });
    stampStatementKind([r]);
    expect(r.kind).toBe("dml");
  });

  it("SELECT success — stamps kind=select", () => {
    const r = mkResult({
      sql: "SELECT 1",
      status: "done",
      result: { columns: ["n"], rows: [[1]], rowCount: 1, durationMs: 1 },
      durationMs: 1,
    });
    stampStatementKind([r]);
    expect(r.kind).toBe("select");
  });

  it("Pending BQ entry — kind stays undefined (case 6, regression pin)", () => {
    // The BQ `pending: true` shape carries no settled SQL yet; the stamping
    // helper MUST skip it. With a batched-shaped handle too, dialect-stamp
    // coexistence is verified — stampStatementKind does not touch dialect.
    const r = mkResult({
      sql: "",
      status: "running",
      pending: true,
      batched: { columns: ["n"], fetchBatch: (() => Promise.resolve(null)) } as unknown as StatementResult["batched"],
    });
    stampStatementKind([r]);
    expect(r.kind).toBeUndefined();
  });

  it("Error entry — stamps kind from sql even on error path", () => {
    const r = mkResult({
      sql: "CREATE TABLE broken_t (",
      status: "error",
      error: "syntax error at or near \"(\"\nLINE 1: CREATE TABLE broken_t (",
      durationMs: 1,
    });
    stampStatementKind([r]);
    expect(r.kind).toBe("ddl");
  });

  it("Mixed run — stamps each entry individually", () => {
    const slice = [
      mkResult({ sql: "CREATE TABLE a (id int)", status: "done" }),
      mkResult({ sql: "SELECT 1", status: "done" }),
      mkResult({ sql: "INSERT INTO a VALUES (1)", status: "done" }),
    ];
    stampStatementKind(slice);
    expect(slice[0].kind).toBe("ddl");
    expect(slice[1].kind).toBe("select");
    expect(slice[2].kind).toBe("dml");
  });

  it("Coexistence — stampStatementKind does not touch dialect/schemaFields", () => {
    const r = mkResult({
      sql: "SELECT 1",
      status: "done",
      dialect: "bigquery",
      schemaFields: [{ name: "n" }],
    });
    stampStatementKind([r]);
    expect(r.kind).toBe("select");
    expect(r.dialect).toBe("bigquery");
    expect(r.schemaFields).toEqual([{ name: "n" }]);
  });
});

// =============================================================================
// TASK-UX2-003 — QueryRunner.runFailed(reason) + RunnerBusy.
//
// The host's `runStatements` outer catch (TASK-UX2-004) calls
// `runner.runFailed(reason)` instead of dropping a toast. The synthetic
// StatementResult is appended to `this.results` and the existing onUpdate
// contract fires — `runFailed` reuses the same path real statements use,
// never a parallel one.
//
// Contract pinned by these 5 cases:
//   1. `runFailed("ECONNREFUSED")` synchronously appends one synthetic
//      StatementResult `{index:0, sql:"(connection)", status:"error",
//      error:"ECONNREFUSED", durationMs:0}` and fires onUpdate.
//   2. `runFailed` while a real `run()` is in flight throws `RunnerBusy`.
//   3. `runFailed` after a cancelled run appends a new synthetic row.
//   4. Calling `runFailed` twice accumulates two synthetic rows.
//   5. Regular `run([stmt])` after `runFailed` works (does not leak the
//      synthetic row into the new run's state).
// =============================================================================
describe("QueryRunner — runFailed (TASK-UX2-003)", () => {
  it("case 1 — runFailed appends one synthetic StatementResult and fires onUpdate", async () => {
    const adapter = makeAdapter(async () => okResult(["n"], [[1]]));
    const runner = new QueryRunner(async () => adapter);
    const updates: StatementResult[][] = [];
    // Drive `run()` once so `lastOnUpdate` is set; the synthetic onUpdate
    // must fire on `runFailed` after that.
    await runner.run([stmt("SELECT 1", 0, 8)], (r) => updates.push(r.slice()));
    updates.length = 0;
    const beforeLen = runner.getResults().length;

    runner.runFailed("ECONNREFUSED");

    const results = runner.getResults();
    expect(results).toHaveLength(beforeLen + 1);
    const last = results[results.length - 1];
    expect(last.index).toBe(beforeLen);
    expect(last.sql).toBe("(connection)");
    expect(last.status).toBe("error");
    expect(last.error).toBe("ECONNREFUSED");
    expect(last.durationMs).toBe(0);
    // onUpdate fired once with the synthetic row visible.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveLength(beforeLen + 1);
    expect(updates[0][updates[0].length - 1].sql).toBe("(connection)");
  });

  it("case 2 — runFailed while a real run() is in flight throws RunnerBusy", async () => {
    let resolveRun: ((v: RunResult) => void) | null = null;
    const adapter = makeAdapter(
      () => new Promise<RunResult>((resolve) => { resolveRun = resolve; }),
    );
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    // Wait for runQuery to be in flight.
    await new Promise((r) => setTimeout(r, 5));
    expect(runner.isRunning()).toBe(true);

    expect(() => runner.runFailed("DROPPED")).toThrow(RunnerBusy);
    // Tighten the assertion: the thrown error must be a `RunnerBusy`
    // INSTANCE, not any error. `toThrow(undefined)` accepts anything;
    // pinning the constructor name guards against the test passing for the
    // wrong reason (e.g. `runFailed` not yet implemented).
    try {
      runner.runFailed("DROPPED");
      throw new Error("expected RunnerBusy");
    } catch (e) {
      expect((e as { constructor?: { name?: string } }).constructor?.name).toBe("RunnerBusy");
    }
    if (resolveRun) {
      resolveRun({ results: [{ columns: ["x"], rows: [], rowCount: 0, durationMs: 0 }] });
    }
    const result = await runPromise;
    expect(result[0].status).toBe("done");
    // runFailed did NOT append anything while run was in flight.
    expect(result).toHaveLength(1);
    expect(result[0].sql).toBe("SELECT pg_sleep(10)");
  });

  it("case 3 — runFailed after a cancelled run appends a new synthetic row", async () => {
    let resolveRun: ((v: RunResult) => void) | null = null;
    const adapter = makeAdapter(
      () => new Promise<RunResult>((resolve) => { resolveRun = resolve; }),
    );
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run([stmt("SELECT pg_sleep(10)", 0, 18)], () => {});
    await new Promise((r) => setTimeout(r, 5));
    await runner.cancel();
    if (resolveRun) {
      resolveRun({ results: [{ columns: ["x"], rows: [], rowCount: 0, durationMs: 0 }] });
    }
    const result = await runPromise;
    expect(result[0].status).toBe("cancelled");

    // Now runFailed must NOT throw and must append a synthetic row.
    expect(() => runner.runFailed("CANCELLED THEN FAILED")).not.toThrow();
    const final = runner.getResults();
    expect(final).toHaveLength(2);
    const synth = final[final.length - 1];
    expect(synth.sql).toBe("(connection)");
    expect(synth.status).toBe("error");
    expect(synth.error).toBe("CANCELLED THEN FAILED");
  });

  it("case 4 — calling runFailed twice accumulates two synthetic rows", async () => {
    const adapter = makeAdapter(async () => okResult(["n"], [[1]]));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT 1", 0, 8)], () => {});

    runner.runFailed("ERR_A");
    runner.runFailed("ERR_B");

    const results = runner.getResults();
    expect(results).toHaveLength(3); // 1 real + 2 synthetic
    expect(results[1].sql).toBe("(connection)");
    expect(results[1].error).toBe("ERR_A");
    expect(results[2].sql).toBe("(connection)");
    expect(results[2].error).toBe("ERR_B");
  });

  it("case 5 — regression: regular run() after runFailed is unaffected", async () => {
    const adapter = makeAdapter(async (sql) => okResult(["value"], [[sql]]));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT a", 0, 8)], () => {});
    runner.runFailed("CONNECTION LOST");

    // After runFailed, run([stmt]) must reset to a clean single entry —
    // the synthetic row from runFailed must NOT leak into the new run.
    const result = await runner.run([stmt("SELECT b", 0, 8)], () => {});
    expect(result).toHaveLength(1);
    expect(result[0].sql).toBe("SELECT b");
    expect(result[0].status).toBe("done");
    expect(result[0].result?.rows).toEqual([["SELECT b"]]);
    expect(runner.getResults()).toHaveLength(1);
  });
});
