// src/core/queryRunner.ts
// QueryRunner — chạy danh sách statements tuần tự qua DbAdapter, gom kết quả.
//
// Contract (TASK-006):
// - `run(statements, onUpdate)`:
//   - Chạy từng statement qua `adapter.runQuery(sql)`.
//   - Với mỗi statement, push running → onUpdate callback.
//   - Khi xong: status = 'done' | 'error' | 'cancelled'.
//   - Statement N lỗi → KHÔNG chạy N+1; statements sau status = 'cancelled'.
//   - Nếu adapter runQuery trả `batched` (Postgres cursor), build result từ
//     batched.columns + initial 500-row fetch rồi lưu BatchedQuery để loadMore().
//   - onUpdate được gọi SAU mỗi state change (running, done, error, cancelled).
// - `loadMore(index)`:
//   - Lấy batch kế tiếp từ BatchedQuery; append vào result.rows.
//   - Trả về mảng results mới (cùng reference tới internal state).
//   - Có in-flight guard — concurrent loadMore cho cùng index được serialize.
// - `cancel()`:
//   - Gọi batched.cancel() trên cursor đang mở (CURRENT statement, not previous).
//   - Statement đang chạy sẽ bị cancel khi promise adapter.runQuery resolve/reject.
//
// IMPORTANT (fix round 1):
// - `currentBatched` được assign NGAY KHI batched handle xuất hiện (trước khi
//   fetchBatch initial) — để cancel mid-`fetchBatch(initial)` reaches đúng cursor.
// - Batched cursor được close sau khi run() xong (success/error/cancel) nếu còn open.
// - `pickResult()` xử lý contract batched: results=[] thì result = batched columns
//   + rows initial từ fetchBatch().
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
  /** Batched handle của statement đang in-flight (cancel target). */
  private currentBatched: BatchedQuery | null = null;
  private currentIndex = -1;
  private running: Promise<void> | null = null;
  /** Per-index in-flight promise — serializes concurrent loadMore cho cùng index. */
  private loadMoreInFlight: Map<number, Promise<StatementResult[]>> = new Map();

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
    this.currentBatched = null;
    this.loadMoreInFlight.clear();
    // Đóng các batched cursor còn mở từ lần chạy trước (user chạy câu mới
    // mà chưa fetch hết rows cũ). Pool Postgres max=1 — nếu không đóng,
    // statement đầu của lần chạy này xếp hàng chờ client và fail sau
    // connectionTimeoutMillis ("timeout exceeded when trying to connect").
    const stale = this.results
      .filter((r) => r.status === "done" && r.batched)
      .map((r) => r.batched!);
    for (const b of stale) {
      try {
        await b.close();
      } catch {
        // best-effort — cursor có thể đã đóng.
      }
    }
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
      this.currentBatched = null;
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
        // Clear currentBatched assignment từ lần trước trước khi re-assign.
        // (nếu statement trước cancel xong, currentBatched có thể stale.)
        this.currentBatched = null;

        if (runResult.batched) {
          // CRITICAL #1 contract: batched cursor — assign currentBatched NGAY
          // để cancel trong fetchBatch(initial) reaches đúng cursor.
          this.currentBatched = runResult.batched;
        }

        if (this.cancelRequested) {
          this.results[i].status = "cancelled";
          if (runResult.batched) {
            try {
              await runResult.batched.close();
            } catch {
              // ignore
            }
            this.currentBatched = null;
          }
          onUpdate(this.results.slice());
          continue;
        }

        // Pick result với batched-aware contract.
        const result = await pickResult(runResult);

        // Re-check cancel: cancel có thể đã được gọi trong lúc fetchBatch(initial)
        // đang chờ. Status cuối cùng là 'cancelled', KHÔNG done.
        if (this.cancelRequested) {
          this.results[i].status = "cancelled";
          if (runResult.batched) {
            try {
              await runResult.batched.close();
            } catch {
              // ignore
            }
            this.currentBatched = null;
          }
          onUpdate(this.results.slice());
          continue;
        }

        this.results[i].status = "done";
        this.results[i].result = result;
        this.results[i].durationMs = Date.now() - start;
        if (runResult.batched) {
          this.results[i].batched = runResult.batched;
          // currentBatched đã set ở trên — giữ để loadMore dùng.
        }
        onUpdate(this.results.slice());
      } catch (err) {
        if (this.cancelRequested) {
          this.results[i].status = "cancelled";
        } else {
          this.results[i].status = "error";
          this.results[i].error = err instanceof Error ? err.message : String(err);
          this.results[i].durationMs = Date.now() - start;
        }
        this.currentBatched = null;
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
    }
  }

  /**
   * Lấy batch kế tiếp từ BatchedQuery (nếu có) cho statement `index`.
   * Append vào result.rows; trả về mảng results mới.
   *
   * IMPORTANT #3 (fix round 1): serialize concurrent calls cho cùng index bằng
   * một in-flight promise chain. Hai loadMore đồng thời → batch thứ hai phải
   * đợi batch thứ nhất hoàn thành rồi mới fetchBatch tiếp (không mất batch).
   */
  async loadMore(index: number): Promise<StatementResult[]> {
    // Per-index guard — chain cùng key. Concurrent loadMore cho cùng index
    // được serialize: call thứ hai phải đợi call thứ nhất xong rồi MỚI fetch
    // batch kế tiếp (không mất batch).
    const existing = this.loadMoreInFlight.get(index);
    let promise: Promise<StatementResult[]>;
    if (existing) {
      promise = existing.then(() => this.loadMoreImpl(index));
    } else {
      promise = this.loadMoreImpl(index);
    }
    const tracked = promise.finally(() => {
      // Chỉ clear nếu key vẫn còn trỏ tới promise này (tránh race với chain
      // tiếp theo set key mới).
      if (this.loadMoreInFlight.get(index) === tracked) {
        this.loadMoreInFlight.delete(index);
      }
    });
    this.loadMoreInFlight.set(index, tracked);
    return tracked;
  }

  private async loadMoreImpl(index: number): Promise<StatementResult[]> {
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
    if (this.cancelRequested) {
      throw new Error(`Statement ${index} cancelled`);
    }
    const batched = r.batched;
    // Track currentBatched để cancel mid-fetchBatch reaches đúng cursor.
    this.currentBatched = batched;
    try {
      const batch = await batched.fetchBatch();
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
    } finally {
      // currentBatched sẽ được reset bởi run() hoặc cancel().
      if (this.currentBatched === batched) {
        this.currentBatched = null;
      }
    }
  }

  /**
   * Yêu cầu cancel. Nếu đang trong batched query (in-flight), gọi batched.cancel().
   *
   * IMPORTANT #4 (fix round 1): cancel reaches `currentBatched` (in-flight
   * cursor), KHÔNG phải previous statement's cursor. Nếu run() chưa gán
   * currentBatched (vd đang chờ statement đầu), cancel sẽ no-op cho phần đó
   * nhưng flag vẫn được set — statement sẽ thành 'cancelled' khi runQuery
   * resolve.
   *
   * Sau khi cancel xong, attempt close batched cursor (idempotent).
   */
  async cancel(): Promise<void> {
    this.cancelRequested = true;
    if (this.currentBatched) {
      try {
        await this.currentBatched.cancel();
      } catch {
        // ignore
      }
      try {
        await this.currentBatched.close();
      } catch {
        // ignore
      }
      this.currentBatched = null;
    }
  }
}

/**
 * Build QueryResult từ RunResult theo contract batched-aware.
 *
 * CRITICAL #1 contract (fix round 1):
 * - Nếu `runResult.batched` tồn tại: Postgres adapter trả `results: []` cùng
 *   batched handle (single SELECT). Caller PHẢI build result từ batched.columns
 *   + initial 500-row fetch (load first batch ngay để grid render footer "500 rows").
 * - Nếu `runResult.results` có data (multi-statement, INSERT, non-SELECT):
 *   trả về QueryResult cuối cùng (hoặc cái đầu tiên có rows).
 *
 * Trả về QueryResult với rowCount = null cho batched (chưa biết tổng).
 * Nếu fetch initial thất bại → result.rows = [] + error được set bởi caller (try/catch).
 */
export async function pickResult(runResult: RunResult): Promise<QueryResult> {
  // Batched case (Postgres cursor): adapter returns { results: [], batched }.
  // Caller (QueryRunner.executeAll) catches errors; here we always assume batched is valid.
  if (runResult.batched) {
    const cols = runResult.batched.columns;
    let initialRows: any[][] = [];
    try {
      const first = await runResult.batched.fetchBatch();
      if (first) initialRows = first;
    } catch {
      // ignore — caller will set error status if it bubbles up.
    }
    return {
      columns: cols,
      rows: initialRows,
      rowCount: initialRows.length > 0 ? initialRows.length : null,
      durationMs: 0,
    };
  }
  if (runResult.results.length === 0) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 0,
    };
  }
  // Multi-statement path: chọn result có rows > 0 ưu tiên.
  for (const r of runResult.results) {
    if (r.rows.length > 0) return r;
  }
  return runResult.results[0];
}
