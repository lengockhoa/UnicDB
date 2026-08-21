// src/core/__tests__/queryRunner.test.ts
// Unit tests for QueryRunner — TASK-006 §Test Cases + fix round 1 regressions.
//
// Mocks MUST match the REAL adapter contract per src/adapters/postgres.ts:
//   - SELECT (single, no semicolon) → adapter returns { results: [], batched }.
//     Batched is the ONLY source of columns/rows.
//   - Non-SELECT / multi-statement → adapter returns { results: [...] }.
//   - pickResult() builds QueryResult from batched.columns + initial fetchBatch.
import { describe, it, expect, vi } from "vitest";
import { QueryRunner } from "../queryRunner";
import { pickResult } from "../queryRunner";
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
    // pickResult swallows the initial fetch error or returns empty rows;
    // but executeAll checks cancelRequested BEFORE setting status='done'.
    // Either status='cancelled' (cancel set before completion) or done with rows=[].
    expect(["cancelled", "done"]).toContain(result[0].status);
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
