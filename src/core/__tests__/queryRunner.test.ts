// src/core/__tests__/queryRunner.test.ts
// Unit tests for QueryRunner — TASK-006 §Test Cases.
import { describe, it, expect, vi } from "vitest";
import { QueryRunner } from "../queryRunner";
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

  it("inserts batched result — QueryResult chứa rows initial từ batched", async () => {
    const batched: BatchedQuery = {
      columns: ["n"],
      fetchBatch: vi.fn(async () => null),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const adapter = makeAdapter(async (sql) => {
      if (sql.startsWith("SELECT")) {
        return {
          results: [qresult(["n"], [], 0)],
          batched,
        };
      }
      throw new Error("unexpected: " + sql);
    });
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run(
      [stmt("SELECT * FROM big", 0, 16)],
      () => {},
    );
    expect(result[0].status).toBe("done");
    expect(result[0].batched).toBe(batched);
    expect(result[0].result?.columns).toEqual(["n"]);
  });
});

describe("QueryRunner — cancel()", () => {
  it("Test #4 — cancel() gọi adapter.cancel, statement đang chạy → 'cancelled'", async () => {
    let resolveRun!: (r: RunResult) => void;
    const slowPromise = new Promise<RunResult>((resolve) => {
      resolveRun = resolve;
    });
    const adapter = makeAdapter(() => slowPromise);
    const runner = new QueryRunner(async () => adapter);

    const runPromise = runner.run(
      [stmt("SELECT pg_sleep(10)", 0, 18)],
      () => {},
    );

    // Đợi adapter.runQuery đã được gọi.
    await new Promise((r) => setTimeout(r, 5));
    expect(adapter.runQuerySpy).toHaveBeenCalledTimes(1);

    // Cancel.
    await runner.cancel();

    // Resolve câu query giả lập (cancel không reject, chỉ flag).
    resolveRun(okResult(["n"], []));
    const result = await runPromise;
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
    // resolve Run rồi abort bằng cách close runner (chờ đủ lâu).
    // Thực tế: SLOW never resolves; ta chỉ assert no further calls.
    // Cleanup: race với timeout.
    const timeout = new Promise<void>((r) => setTimeout(r, 50));
    await Promise.race([runPromise.then(() => undefined, () => undefined), timeout]);
    expect(callOrder).toEqual(["SELECT 1", "SLOW"]);
  });
});

describe("QueryRunner — loadMore()", () => {
  it("Test #7 — loadMore lấy batch kế tiếp từ BatchedQuery", async () => {
    const fetchBatch = vi
      .fn<[], Promise<any[][] | null>>()
      .mockResolvedValueOnce([[10], [11], [12]])
      .mockResolvedValueOnce(null);
    const batched: BatchedQuery = {
      columns: ["n"],
      fetchBatch,
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const adapter = makeAdapter(async (sql) => {
      return {
        results: [qresult(["n"], [[1], [2]], 2)],
        batched,
      };
    });
    const runner = new QueryRunner(async () => adapter);
    const result = await runner.run([stmt("SELECT *", 0, 9)], () => {});
    expect(result[0].result?.rows).toEqual([[1], [2]]);
    // Load more.
    const updated = await runner.loadMore(0);
    expect(updated[0].result?.rows).toEqual([[1], [2], [10], [11], [12]]);
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    // Load more → EOF.
    const noMore = await runner.loadMore(0);
    expect(noMore[0].result?.rows).toEqual([[1], [2], [10], [11], [12]]);
    // total rows = 5 → rowCount updated.
    expect(noMore[0].result?.rowCount).toBe(5);
  });

  it("Test #7b — loadMore trên statement không có batched → throw", async () => {
    const adapter = makeAdapter(async () => okResult(["n"], [[1]]));
    const runner = new QueryRunner(async () => adapter);
    await runner.run([stmt("SELECT 1", 0, 8)], () => {});
    await expect(runner.loadMore(0)).rejects.toThrow(/no batched/i);
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
