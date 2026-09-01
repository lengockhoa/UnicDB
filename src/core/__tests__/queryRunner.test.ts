// src/core/__tests__/queryRunner.test.ts
// Unit tests for QueryRunner — TASK-006 §Test Cases + fix round 1 regressions.
//
// Mocks MUST match the REAL adapter contract per src/adapters/postgres.ts:
//   - SELECT (single, no semicolon) → adapter returns { results: [], batched }.
//     Batched is the ONLY source of columns/rows.
//   - Non-SELECT / multi-statement → adapter returns { results: [...] }.
//   - pickResult() builds QueryResult from batched.columns + initial fetchBatch.
import { describe, it, expect, vi } from "vitest";
import { QueryRunner, pickResult, type StatementResult } from "../queryRunner";
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
    // Regression pin: PID window at executeAll:191 and currentBatched at
    // executeAll:203 are disjoint — two cancels while a batched cursor is
    // in flight must call batched.cancel() exactly once and never the seam.
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
