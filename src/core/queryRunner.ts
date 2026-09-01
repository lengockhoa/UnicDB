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
import type {
  BatchedQuery,
  DbAdapter,
  DbTransaction,
  QueryResult,
  RunResult,
} from "../adapters/types";
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
  /** True when a batched cursor was released before this run completed. */
  cursorClosed?: boolean;
  /** 1-based run ordinal, present only for append-mode entries. */
  runNo?: number;
  /** 1-based statement ordinal within an append-mode run. */
  runStmtNo?: number;
  /** Optional per-statement tab label used by browse flows. */
  label?: string;
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
  /**
   * TASK-ARP02-001 — in-flight-scoped cancel ownership. `cancelPending` is
   * true ONLY while a cancel was issued against LIVE work (a run or an
   * in-flight loadMore) and that work has not settled yet. A close-origin
   * cancel (runner idle/settled) leaves `cancelPending` false, so it cannot
   * poison a later healthy `loadMore` — while legacy `cancelRequested`
   * keeps its sticky semantics for the run path (`executeAll` re-checks)
   * and `isCancelled()`.
   *
   * `cancelSeq` increments on every `cancel()`; `loadMoreImpl` snapshots it
   * before its `fetchBatch` await and re-checks after — a cancel landing
   * DURING the fetch discards the late-settled batch (the load-bearing
   * post-await re-check; the `run()` finally reset alone cannot cover it
   * because the cancel arrives after the finally).
   */
  private cancelPending = false;
  private cancelSeq = 0;
  /** Batched handle của statement đang in-flight (cancel target). */
  private currentBatched: BatchedQuery | null = null;
  /**
   * TASK-ARP02-001 — delivered-once guard for `BatchedQuery.cancel()` on the
   * cursor currently referenced by `currentBatched`. A second `cancel()`
   * while the first is still awaiting the cursor must not re-fire
   * `batched.cancel()/close()`.
   */
  private currentBatchedCancelDelivered = false;
  /**
   * TASK-RLX-001 — adapter đã resolve, giữ CHỈ trong lúc một statement
   * non-batched đang in-flight qua runQuery (PID window). Cancel() khi đó
   * gọi seam `cancelActiveQuery()` (nếu adapter hỗ trợ). Sau khi statement
   * settle, window đóng → cancel() là no-op (không seam, không false
   * cancelled). Batched cursor vẫn đi qua BatchedQuery.cancel() độc quyền.
   */
  private activeAdapter: DbAdapter | null = null;
  /**
   * TASK-ARP02-001 — once-only guard for the non-batched seam. A second
   * `cancel()` while the PID window is still open must NOT re-fire
   * `adapter.cancelActiveQuery()`. Reset at run() entry (per run) so a
   * new in-flight run can fire its own seam once.
   */
  private seamDelivered = false;
  private currentIndex = -1;
  private running: Promise<void> | null = null;
  /** Per-index in-flight promise — serializes concurrent loadMore cho cùng index. */
  private loadMoreInFlight: Map<number, Promise<StatementResult[]>> = new Map();
  private runCount = 0;

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
   *
   * TASK-ARP02-001 — semantics UNCHANGED (sticky until the next `run()`):
   * consumers (resultsPanel error-toast suppression) rely on the legacy
   * value. The new run-bounded ownership lives in `cancelPending` /
   * `cancelSeq`, consulted by `loadMoreImpl`.
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
    opts: { append?: boolean } = {},
  ): Promise<StatementResult[]> {
    if (this.running) {
      throw new Error("QueryRunner is already running");
    }
    const append = opts.append === true;
    const base = append ? this.results.length : 0;
    const runNo = ++this.runCount;
    // TASK-ARP02-001 — a new run owns its cancel state: clear the sticky
    // flag (legacy semantics) and open the in-flight cancel window. Any
    // close-origin cancel from before this run is bounded away.
    this.cancelRequested = false;
    this.cancelPending = false;
    this.cancelSeq = 0;
    this.currentBatched = null;
    this.currentBatchedCancelDelivered = false;
    this.seamDelivered = false;
    this.loadMoreInFlight.clear();
    // Đóng các batched cursor còn mở từ lần chạy trước (user chạy câu mới
    // mà chưa fetch hết rows cũ). Pool Postgres max=1 — nếu không đóng,
    // statement đầu của lần chạy này xếp hàng chờ client và fail sau
    // connectionTimeoutMillis ("timeout exceeded when trying to connect").
    const stale = this.results.filter(
      (r) => r.status === "done" && r.batched && !r.cursorClosed,
    );
    for (const entry of stale) {
      try {
        await entry.batched!.close();
      } catch {
        // best-effort — cursor có thể đã đóng.
      }
      entry.cursorClosed = true;
    }
    const nextResults = statements.map((s, i) => ({
      index: base + i,
      sql: s.text,
      status: "running" as StatementStatus,
      durationMs: 0,
      ...(append ? { runNo, runStmtNo: i + 1 } : {}),
    }));
    this.results = append ? [...this.results, ...nextResults] : nextResults;
    onUpdate(this.results.slice());

    const runPromise = this.executeAll(statements, onUpdate, base, append);
    this.running = runPromise;
    try {
      await runPromise;
    } finally {
      this.running = null;
      this.currentBatched = null;
      this.currentBatchedCancelDelivered = false;
      this.seamDelivered = false;
      // TASK-ARP02-001 — the run settled: close the in-flight cancel window.
      // (cancelRequested stays sticky for isCancelled(); a cancel arriving
      // AFTER this finally is close-origin and sets only the sticky flag,
      // leaving cancelPending=false so a later healthy loadMore still works.)
      this.cancelPending = false;
      // TASK-RLX-001 — đóng PID window khi run kết thúc (dù success/error).
      this.activeAdapter = null;
    }
    return this.results.slice();
  }

  private async executeAll(
    statements: ParsedStatement[],
    onUpdate: (results: StatementResult[]) => void,
    base: number,
    append: boolean,
  ): Promise<void> {
    const adapter = await this.adapterProvider();

    for (let i = 0; i < statements.length; i++) {
      const index = base + i;
      if (this.cancelRequested) {
        // statements còn lại → cancelled.
        this.results[index].status = "cancelled";
        continue;
      }
      this.currentIndex = index;
      this.results[index].status = "running";
      onUpdate(this.results.slice());

      const start = Date.now();
      try {
        // TASK-RLX-001 — PID window MỞ: giữ adapter reference chỉ trong lúc
        // runQuery in-flight để cancel() có thể gọi cancelActiveQuery().
        this.activeAdapter = adapter;
        const runResult: RunResult = await adapter.runQuery(statements[i].text);
        // PID window ĐÓNG: statement đã settle (kể cả khi cancel đã được
        // yêu cầu trong lúc chờ) — cancel() sau điểm này là no-op.
        this.activeAdapter = null;
        // Clear currentBatched assignment từ lần trước trước khi re-assign.
        // (nếu statement trước cancel xong, currentBatched có thể stale.)
        this.currentBatched = null;

        if (runResult.batched) {
          // CRITICAL #1 contract: batched cursor — assign currentBatched NGAY
          // để cancel trong fetchBatch(initial) reaches đúng cursor.
          this.currentBatched = runResult.batched;
        }

        if (this.cancelRequested) {
          this.results[index].status = "cancelled";
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
          this.results[index].status = "cancelled";
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

        this.results[index].status = "done";
        this.results[index].result = result;
        this.results[index].durationMs = Date.now() - start;
        if (runResult.batched) {
          this.results[index].batched = runResult.batched;
          // In append multi-statement runs, release non-final cursors before
          // starting the next statement (the pool may have max=1 client).
          if (append && statements.length > 1 && i < statements.length - 1) {
            try {
              await runResult.batched.close();
            } catch {
              // best-effort — cursor may already be closed.
            }
            this.results[index].cursorClosed = true;
            this.currentBatched = null;
          }
        }
        onUpdate(this.results.slice());
      } catch (err) {
        // PID window đóng cả ở error path — không cho late cancel bắn seam.
        this.activeAdapter = null;
        if (this.cancelRequested) {
          this.results[index].status = "cancelled";
        } else {
          this.results[index].status = "error";
          this.results[index].error = err instanceof Error ? err.message : String(err);
          this.results[index].durationMs = Date.now() - start;
        }
        this.currentBatched = null;
        // Emit state change (error dừng chuỗi).
        onUpdate(this.results.slice());
        // Nếu lỗi logic (không phải cancel) → KHÔNG chạy statements sau.
        if (!this.cancelRequested) {
          // Đánh dấu các statements còn lại là cancelled.
          for (let j = i + 1; j < statements.length; j++) {
            this.results[base + j].status = "cancelled";
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
    if (r.cursorClosed) {
      throw new Error(`Statement ${index} cursor closed after its run finished — run this statement alone to page more rows`);
    }
    if (!r.batched) {
      throw new Error(`Statement ${index} has no batched cursor`);
    }
    if (r.status !== "done") {
      throw new Error(`Statement ${index} is not done (status=${r.status})`);
    }
    // TASK-ARP02-001 — entry guard, in-flight-scoped (load-bearing per the
    // plan-review note): a close-origin cancel left `cancelPending=false`
    // (only the sticky `cancelRequested` is set), so it must NOT poison
    // this healthy loadMore. Only a cancel issued against LIVE work — i.e.
    // `cancelRequested && cancelPending` — rejects here. (A cancel landing
    // mid-loadMore sets currentBatched to THIS cursor and closes it; the
    // sticky flag then stays true for isCancelled(), matching the run-path
    // contract.)
    if (this.cancelRequested && this.cancelPending) {
      throw new Error(`Statement ${index} cancelled`);
    }
    const batched = r.batched;
    // Track currentBatched để cancel mid-fetchBatch reaches đúng cursor.
    this.currentBatched = batched;
    this.currentBatchedCancelDelivered = false;
    // Snapshot the cancel sequence before the await; a cancel landing during
    // the fetch bumps it (see cancel()).
    const cancelSeqBefore = this.cancelSeq;
    try {
      const batch = await batched.fetchBatch();
      // TASK-ARP02-001 — post-await re-check (load-bearing): the run()'s
      // finally reset alone cannot catch a cancel that arrives AFTER the run
      // settled but DURING this fetch. If the cancel sequence advanced while
      // we were parked in fetchBatch, cancel() has already cancelled and
      // closed THIS cursor — the late batch is DISCARDED, never appended
      // onto a cancelled state.
      if (this.cancelSeq !== cancelSeqBefore) {
        return this.results.slice();
      }
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
   *
   * TASK-RLX-001 — non-batched branch: nếu KHÔNG có currentBatched mà runner
   * đang giữ một adapter cho statement in-flight (PID window mở), gọi seam
   * `adapter.cancelActiveQuery()` (best-effort). Window đóng (statement đã
   * settle) → cancel là no-op: không seam, không false cancelled.
   *
   * TASK-ARP02-001 — exactly-once ownership:
   * - `cancelRequested` (sticky, legacy) + `cancelPending` (in-flight-scoped)
   *   are both latched here; the sticky flag alone is what made close-origin
   *   cancels poison later `loadMore` calls — `cancelPending` is the
   *   load-bearing predicate for those.
   * - Batched branch: delivered-once guard — a second cancel while the same
   *   in-flight cursor is being cancelled is a no-op (no double
   *   `batched.cancel()/close()`).
   * - Non-batched branch: delivered-once guard on the seam — a second cancel
   *   while the PID window is still open must not re-fire
   *   `cancelActiveQuery()`.
   * - A cancel landing while a loadMore is in flight bumps `cancelSeq` so
   *   the post-await re-check in `loadMoreImpl` discards the late batch.
   * - Close-origin cancel (no currentBatched, PID window closed): sets the
   *   sticky flag only — the seam / cursor channels correctly do nothing.
   */
  async cancel(): Promise<void> {
    this.cancelRequested = true;
    this.cancelSeq++;
    const liveCancel = this.currentBatched !== null || this.activeAdapter !== null;
    if (liveCancel) {
      this.cancelPending = true;
    }
    if (this.currentBatched) {
      if (this.currentBatchedCancelDelivered) {
        // Idempotent: cancel already delivered for this in-flight cursor.
        return;
      }
      this.currentBatchedCancelDelivered = true;
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
      this.cancelPending = false;
      return;
    }
    // TASK-RLX-001 — non-batched in-flight cancellation. Chỉ bắn seam khi
    // runner đang thực sự giữ adapter cho một runQuery đang chờ.
    const adapter = this.activeAdapter;
    if (this.seamDelivered) {
      // Idempotent: seam already fired for this run's in-flight statement.
      return;
    }
    if (adapter?.cancelActiveQuery) {
      this.seamDelivered = true;
      try {
        await adapter.cancelActiveQuery();
      } catch {
        // best-effort — seam failure không được làm hỏng cancel flow.
      }
      this.cancelPending = false;
    }
  }

  /**
   * TASK-503 — run a single SQL string through the adapter (no statement
   * parsing, no cursor lifecycle, no `results` bookkeeping). Used by the
   * host Save flow which builds its own list of UPDATE/INSERT/DELETE
   * statements and re-runs the original query afterwards.
   *
   * The adapter is fetched fresh (matches the existing `executeAll` pattern)
   * so the active connection or a brand-new connection each route through
   * the same plumbing as `run()`.
   */
  async runSql(sql: string): Promise<RunResult> {
    const adapter = await this.adapterProvider();
    return adapter.runQuery(sql);
  }

  async beginTransaction(): Promise<DbTransaction> {
    const adapter = await this.adapterProvider();
    if (!adapter.beginTransaction) {
      throw new Error("The active database adapter does not support manual transactions");
    }
    return adapter.beginTransaction();
  }

  /**
   * TASK-504 Fix R2 critical #2 — adopt a StatementResult from an external
   * source (typically the ResultsPanel after a requery). Replaces the
   * runner-internal entry at `index` with the supplied StatementResult so
   * subsequent `loadMore(index)` reads the NEW batched cursor / rows
   * instead of the runner's stale, pre-requery state.
   *
   * Why this exists: `runSql()` does NOT route through `this.executeAll()`
   * and therefore does not mutate `this.results` — the runner's internal
   * `results[index].batched` is still the cursor from the original `run()`.
   * The panel swaps its own `lastResults[index]` but `runner.loadMore(i)`
   * reads the runner's entry, leaving the cursor unreachable. `adopt()`
   * closes that gap without forcing requery through the full `run()`
   * lifecycle (no `running` / `done` transition, no `onUpdate` callbacks).
   *
   * Adopted entries keep the original `index` and `sql` (the wrapped SQL
   * returned by `runSql`); the new `result` and `batched` come from the
   * panel's requery result.
   */
  adopt(index: number, stmt: StatementResult): void {
    if (index < 0 || index >= this.results.length) {
      throw new Error(
        `QueryRunner.adopt: index ${index} out of range (have ${this.results.length} entries)`,
      );
    }
    const prev = this.results[index];
    if (prev && prev.batched && prev.batched !== stmt.batched) {
      // Best-effort close of the displaced cursor to release the
      // Postgres pool client (Fix R1 critical #3 mirror). The panel also
      // closes this cursor on its side, but doing it here too keeps the
      // invariant "only the runner-adopted cursor is open" simple.
      try {
        // do not await — adopt must remain sync for hot-path use
        void prev.batched.close().catch(() => undefined);
      } catch {
        // ignore
      }
    }
    this.results[index] = stmt;
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
 * Nếu fetch initial thất bại → REJECT (TASK-008 P2-2): lỗi cursor phải đến
 * được error handling của caller (`executeAll` catch → status:"error",
 * `handleRequery` error branch), KHÔNG phải thành một grid rỗng giả.
 */
export async function pickResult(runResult: RunResult): Promise<QueryResult> {
  // Batched case (Postgres cursor): adapter returns { results: [], batched }.
  // TASK-008 P2-2 (cycle-x-audit-grid-ui): the initial fetchBatch is no longer
  // swallowed. A `catch { /* ignore */ }` here returned `rows: []` — a dead
  // cursor was indistinguishable from an empty table and the requery rendered
  // a false empty grid. An EOF (`null`) first batch is NOT an error: it still
  // resolves to the empty successful result below with rowCount=null.
  if (runResult.batched) {
    const cols = runResult.batched.columns;
    const first = await runResult.batched.fetchBatch();
    const initialRows: any[][] = first ?? [];
    return {
      columns: cols,
      rows: initialRows,
      // rowCount=null for batched: we don't know the total until EOF.
      // Returning `initialRows.length` here flipped the grid model's
      // hasMore=false while the cursor was still open, hiding Load More
      // on the very first batch (Fix R2 important #2). Doc-comment
      // contract matches: "rowCount = null cho batched (chưa biết tổng)".
      rowCount: null,
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
