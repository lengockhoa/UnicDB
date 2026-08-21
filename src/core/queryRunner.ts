// src/core/queryRunner.ts
// QueryRunner — chạy danh sách statements tuần tự qua DbAdapter, gom kết quả.
//
// Contract (TASK-006):
// - `run(statements, onUpdate)`:
//   - Chạy từng statement qua `adapter.runQuery(sql)`.
//   - Với mỗi statement, push running → onUpdate callback.
//   - Khi xong: status = 'done' | 'error' | 'cancelled'.
//   - Statement N lỗi → KHÔNG chạy N+1; statements sau status = 'cancelled'.
//   - Nếu adapter runQuery trả `batched` (Postgres cursor), lưu BatchedQuery vào
//     StatementResult để loadMore() có thể dùng.
//   - onUpdate được gọi SAU mỗi state change (running, done, error, cancelled).
// - `loadMore(index)`:
//   - Lấy batch kế tiếp từ BatchedQuery; append vào result.rows.
//   - Trả về mảng results mới (cùng reference tới internal state).
// - `cancel()`:
//   - Đánh dấu cancel = true. Hành vi:
//     - Nếu đang chờ batched.fetchBatch() → gọi batched.cancel().
//     - Statement đang chạy sẽ bị cancel khi promise adapter.runQuery resolve/reject.
//
// Không phụ thuộc vscode; có thể test với mock adapter.
import type { ParsedStatement } from "../config/types";
import type { BatchedQuery, DbAdapter, QueryResult, RunResult } from "../adapters/types";
import { appendBatch } from "./resultBatcher";

export type StatementStatus = "running" | "done" | "error" | "cancelled";

export interface StatementResult {
  index: number;
  sql: string;
  status: StatementStatus;
  result?: QueryResult;
  batched?: BatchedQuery;
  error?: string;
  durationMs: number;
}

export interface QueryRunnerOptions {
  /** Batch size cho loadMore (mặc định 500). */
  batchSize?: number;
}

export class QueryRunner {
  private readonly adapterProvider: () => Promise<DbAdapter>;
  private readonly batchSize: number;
  private results: StatementResult[] = [];
  private cancelRequested = false;
  private currentBatched: BatchedQuery | null = null;
  private currentIndex = -1;
  private running: Promise<void> | null = null;

  constructor(
    adapterProvider: () => Promise<DbAdapter>,
    options: QueryRunnerOptions = {},
  ) {
    this.adapterProvider = adapterProvider;
    this.batchSize = options.batchSize ?? 500;
  }

  /**
   * Đang chạy hay không (dùng cho UI disable buttons).
   */
  isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Đã cancel hay chưa.
   */
  isCancelled(): boolean {
    return this.cancelRequested;
  }

  /**
   * Lấy kết quả hiện tại (copy).
   */
  getResults(): StatementResult[] {
    return this.results.slice();
  }

  /**
   * Chạy tuần tự statements. onUpdate được gọi SAU mỗi state change.
   * Trả về mảng StatementResult cuối cùng (cùng reference với getResults()).
   */
  async run(
    statements: ParsedStatement[],
    onUpdate: (results: StatementResult[]) => void,
  ): Promise<StatementResult[]> {
    if (this.running) {
      throw new Error("QueryRunner is already running");
    }
    this.cancelRequested = false;
    this.results = statements.map((s, i) => ({
      index: i,
      sql: s.text,
      status: "running" as StatementStatus,
      durationMs: 0,
    }));
    onUpdate(this.results.slice());

    const runPromise = this.executeAll(statements, onUpdate);
    this.running = runPromise;
    try {
      await runPromise;
    } finally {
      this.running = null;
    }
    return this.results.slice();
  }

  private async executeAll(
    statements: ParsedStatement[],
    onUpdate: (results: StatementResult[]) => void,
  ): Promise<void> {
    const adapter = await this.adapterProvider();

    for (let i = 0; i < statements.length; i++) {
      if (this.cancelRequested) {
        // statements còn lại → cancelled.
        this.results[i].status = "cancelled";
        continue;
      }
      this.currentIndex = i;
      this.results[i].status = "running";
      onUpdate(this.results.slice());

      const start = Date.now();
      try {
        const runResult: RunResult = await adapter.runQuery(statements[i].text);
        if (this.cancelRequested) {
          this.results[i].status = "cancelled";
          if (runResult.batched) {
            try {
              await runResult.batched.close();
            } catch {
              // ignore
            }
          }
        } else {
          // Lấy result cuối (adapter có thể trả nhiều statement trong 1 call).
          const result = pickResult(runResult);
          this.results[i].status = "done";
          this.results[i].result = result;
          this.results[i].durationMs = Date.now() - start;
          if (runResult.batched) {
            this.results[i].batched = runResult.batched;
            this.currentBatched = runResult.batched;
          }
        }
      } catch (err) {
        if (this.cancelRequested) {
          this.results[i].status = "cancelled";
        } else {
          this.results[i].status = "error";
          this.results[i].error = err instanceof Error ? err.message : String(err);
          this.results[i].durationMs = Date.now() - start;
        }
        // Emit state change (error dừng chuỗi).
        onUpdate(this.results.slice());
        // Nếu lỗi logic (không phải cancel) → KHÔNG chạy statements sau.
        if (!this.cancelRequested) {
          // Đánh dấu các statements còn lại là cancelled.
          for (let j = i + 1; j < statements.length; j++) {
            this.results[j].status = "cancelled";
          }
          onUpdate(this.results.slice());
          return;
        }
      }
      onUpdate(this.results.slice());
    }
  }

  /**
   * Lấy batch kế tiếp từ BatchedQuery (nếu có) cho statement `index`.
   * Append vào result.rows; trả về mảng results mới.
   */
  async loadMore(index: number): Promise<StatementResult[]> {
    const r = this.results[index];
    if (!r) {
      throw new Error(`Statement ${index} not found`);
    }
    if (!r.batched) {
      throw new Error(`Statement ${index} has no batched cursor`);
    }
    if (r.status !== "done") {
      throw new Error(`Statement ${index} is not done (status=${r.status})`);
    }
    const batch = await r.batched.fetchBatch();
    if (batch === null || batch.length === 0) {
      // EOF — không append gì; rowCount = current rows length.
      if (r.result) {
        r.result = { ...r.result, rowCount: r.result.rows.length };
      }
      return this.results.slice();
    }
    const currentRows = r.result?.rows ?? [];
    const merged = appendBatch(currentRows, batch);
    if (r.result) {
      r.result = {
        ...r.result,
        rows: merged,
        rowCount: merged.length,
      };
    }
    return this.results.slice();
  }

  /**
   * Yêu cầu cancel. Nếu đang trong batched query, gọi batched.cancel().
   */
  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.currentBatched) {
      try {
        await this.currentBatched.cancel();
      } catch {
        // ignore
      }
    }
    // Đánh dấu statement hiện tại running → cancelled nếu đang chờ.
    if (this.currentIndex >= 0 && this.results[this.currentIndex]?.status === "running") {
      // Sẽ được set sang 'cancelled' khi promise runQuery của nó resolve.
    }
  }
}

/**
 * Chọn QueryResult từ RunResult. Hầu hết adapter trả 1 result; một số (postgres)
 * có thể trả nhiều (nếu SQL có nhiều statement). Lấy result thứ `index` an toàn.
 */
function pickResult(runResult: RunResult): QueryResult {
  if (runResult.results.length === 0) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
    };
  }
  // Chọn result có rows > 0 ưu tiên (tránh bị trả result rỗng khi batched).
  for (const r of runResult.results) {
    if (r.rows.length > 0) return r;
  }
  return runResult.results[0];
}
