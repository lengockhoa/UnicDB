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
import { appendBatchBounded } from "./resultBatcher";
import type { SqlDialect } from "./statementParser";

export type StatementStatus = "running" | "done" | "error" | "cancelled";

/**
 * TASK-UX2-003 — thrown by `runFailed` when a real `run()` is still in flight.
 * The synthetic error row that `runFailed` produces would otherwise race the
 * live run's `onUpdate` emit and corrupt the panel render — so it is rejected
 * synchronously with a clear error type instead.
 */
export class RunnerBusy extends Error {
  constructor(message = "QueryRunner.runFailed: a real run() is in flight") {
    super(message);
    this.name = "RunnerBusy";
  }
}

/**
 * TASK-ARP03-002 — conservative, driver-independent primary gate for rows
 * retained in a StatementResult. When a loadMore batch pushes the retained
 * rows past this cap, the prefix is kept, the cursor is closed exactly once
 * and the statement is marked `resultLimited` — the limit is neither an
 * error nor a false EOF. Tests/consumers can lower it via
 * `QueryRunnerOptions.maxRetainedRows` without editing the constant.
 */
export const RETAINED_ROW_CAP = 10_000;

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
  /**
   * TASK-BQ03-003 — true iff the cursor was released because the
   * BigQuery-shaped page source reported EOF (a fresh handle's natural
   * exhaustion), NOT because a new run swept it for the pool. This
   * distinguishes a BQ-EOF close from a sweep close so `loadMore` can
   * be a graceful no-op for the former and keep the existing
   * "run this statement alone" throw for the latter. For postgres
   * cursors, this stays undefined (their EOF still uses the next-run
   * sweep, and the ARP03-002 boundary tests pin `cursorClosed`
   * undefined at EOF for non-BQ handles).
   */
  cursorExhausted?: boolean;
  /**
   * TASK-ARP03-002 — true iff the retained-row cap was hit and the cursor
   * was closed for the budget (NOT by a cancel). A later loadMore is a
   * graceful no-op: unchanged rows, no throw, no false EOF.
   */
  resultLimited?: boolean;
  /**
   * TASK-BQ03-003 — true iff the adapter returned a BigQuery-shaped
   * `{ results: [], batched }` (job submitted, first page not yet fetched).
   * Cleared on the first successful `pickResult`. Orthogonal to `status`:
   * a pending BigQuery statement is still `status = "running"`, while a
   * postgres-cursor statement keeps `pending` undefined. TASK-BQ03-004
   * reads this directly to render the pending state without re-deriving
   * from a `batched` boolean the panel discards.
   */
  pending?: boolean;
  /** 1-based run ordinal, present only for append-mode entries. */
  runNo?: number;
  /** 1-based statement ordinal within an append-mode run. */
  runStmtNo?: number;
  /** Optional per-statement tab label used by browse flows. */
  label?: string;
  /**
   * TASK-BQ04-001 — additive dialect marker. `"bigquery"` iff this
   * statement ran on a BigQuery connection (stamped by the host's
   * `runStatements` after `runner.run()` settles). `undefined` on every
   * non-BQ path so existing postgres/mysql/mssql behavior stays
   * byte-identical. The marker is the canonical signal TASK-BQ04-002's
   * `formatCell` switch reads to decide between the dialect-aware and the
   * legacy rendering. Survives the requery rest-spread (see
   * `resultsPanel.ts:696`) because the field is added to the interface
   * AND mirrored in `src/ui/resultsGridModel.ts` — reconstruction sites
   * carry it through verbatim.
   */
  dialect?: "bigquery" | SqlDialect;
  /**
   * TASK-UX1-010 — additive statement-kind marker. Stamped by the host's
   * `runStatements` via `stampStatementKind` after `runner.run()`
   * settles, classification-only (no parser, no grammar). `undefined`
   * when no stamping helper fired (BQ-pending shapes, never-stamped
   * legacy paths). UX1-011 consumes `kind === "ddl" | "dml"` to drive
   * refresh classification; the webview uses `kind === "select"` to
   * decide between grid (legacy) and status card (new). Additive —
   * BQ-04 dialect marker and all existing fields stay untouched.
   */
  kind?: "select" | "ddl" | "dml" | "other";
  /**
   * TASK-BQ04-001 — per-column BQ schema field, ordered to match
   * `result.columns`. Set ONLY when the live page source exposes a
   * typed `BigQuerySchemaField[]` (or a structural equivalent); the
   * `BigQueryPagedQuery` surface currently exposes `columns: string[]`
   * only, so the helper falls back to a name-only projection (type/mode
   * `undefined`) — TASK-BQ04-002 consumers must treat absent type/mode
   * as "no declared metadata". `undefined` on every non-BQ path.
   */
  schemaFields?: ReadonlyArray<{ name?: string; type?: string; mode?: string }>;
}

export interface QueryRunnerOptions {
  /** Batch size cho loadMore (mặc định 500). */
  batchSize?: number;
  /**
   * TASK-ARP03-002 — retained-row cap (mặc định RETAINED_ROW_CAP). Không
   * được thread vào StatementResult: marker observable là `resultLimited`.
   */
  maxRetainedRows?: number;
}

export class QueryRunner {
  private readonly adapterProvider: () => Promise<DbAdapter>;
  private readonly batchSize: number;
  /** TASK-ARP03-002 — retained-row budget (default RETAINED_ROW_CAP). */
  private readonly maxRetainedRows: number;
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
  /**
   * TASK-UX2-003 — last onUpdate callback passed to `run()`. Cached so
   * `runFailed(reason)` can fire the same emit path the panel already
   * listens to, without growing a parallel contract. Overwritten on each
   * `run()` entry; intentionally NOT cleared in `run()` finally so the
   * host's outer catch can still emit a synthetic error row after the
   * run settled with a connection failure.
   */
  private lastOnUpdate: ((results: StatementResult[]) => void) | null = null;
  /** Per-index in-flight promise — serializes concurrent loadMore cho cùng index. */
  private loadMoreInFlight: Map<number, Promise<StatementResult[]>> = new Map();
  private runCount = 0;
  /**
   * TASK-BQ03-003 — monotonically increasing run ordinal. `loadMoreImpl`
   * snapshots this BEFORE its `fetchBatch` await and re-checks AFTER; a
   * new `run()` having started while the fetch was parked bumps the
   * counter and discards the late-settled batch. Closes the "late page
   * after a NEW run" leak that the existing `cancelSeq` re-check (reset
   * to 0 on each run) cannot catch — the new run starts with
   * `cancelSeq = 0` again, so a loadMore's snapshot of 0 matches the
   * post-await value of 0 and the late batch would otherwise land on the
   * preserved statement. The counter is the minimal additive guard; the
   * cancel machinery itself is untouched.
   */
  private runGeneration = 0;

  constructor(
    adapterProvider: () => Promise<DbAdapter>,
    options: QueryRunnerOptions = {},
  ) {
    this.adapterProvider = adapterProvider;
    this.batchSize = options.batchSize ?? 500;
    this.maxRetainedRows = options.maxRetainedRows ?? RETAINED_ROW_CAP;
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
    // TASK-UX2-003 — cache the onUpdate callback so `runFailed(reason)`
    // can fire the same emit path the panel listens to.
    this.lastOnUpdate = onUpdate;
    // TASK-BQ03-003 — bump the run generation so any in-flight loadMore
    // (whose pre-await snapshot still references the previous generation)
    // is forced to discard its late-settled batch on the post-await
    // re-check. The previous run's preserved statement is the only place
    // the late batch could otherwise leak into; this counter is the
    // minimal additive guard that closes the leak.
    this.runGeneration++;
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
          // TASK-BQ03-003 R4.5 — detect BigQuery-shaped handles via the
          // real `BigQueryPagedQuery.setOnExhausted(cb)` installer method.
          // 03.1's adapter stores the hook in a PRIVATE `onExhaustedCb`
          // field — there is NO own `onExhausted` property on the
          // instance. The previous duck-type (`'onExhausted' in batched`)
          // was inert against the real adapter, so `pending`, EOF-close,
          // and `resultLimited` surfacing were all dead. Mark the
          // statement `pending = true` for a BQ-shaped `{ results: [],
          // batched }` (job submitted, first page not yet fetched).
          // Postgres cursors (no `setOnExhausted` method) leave `pending`
          // undefined so the existing tests stay byte-identical. Cleared
          // after the first successful `pickResult` below.
          const bqLike = runResult.batched as BatchedQuery & {
            setOnExhausted?: (cb: (info: { limited: boolean }) => void) => void;
          };
          if (typeof bqLike.setOnExhausted === "function") {
            this.results[index].pending = true;
          }
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
        // TASK-BQ03-003 — first successful pickResult clears `pending`.
        // (A failing pickResult — e.g. a rejected initial fetchBatch —
        // leaves `pending` set so the error path doesn't accidentally
        // mark a never-fetched statement as not-pending; the catch block
        // below resets it explicitly.)
        if (this.results[index].pending) {
          this.results[index].pending = false;
        }

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
        // TASK-BQ03-003 — `pending` is the pre-running marker. A statement
        // that errored or was cancelled before its first page resolved
        // never had its initial fetch completed; clear the flag so
        // consumers don't see a "pending" entry that's already terminal.
        if (this.results[index].pending) {
          this.results[index].pending = false;
        }
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
    // TASK-ARP03-002 — graceful no-op for a limited statement (load-bearing
    // order): this guard MUST precede the `cursorClosed` throw because a
    // budget-limited statement has `cursorClosed = true`. Returning the
    // unchanged rows keeps the limit from surfacing as either an error or a
    // false EOF.
    if (r.resultLimited) {
      return this.results.slice();
    }
    if (r.cursorClosed && !r.cursorExhausted) {
      throw new Error(`Statement ${index} cursor closed after its run finished — run this statement alone to page more rows`);
    }
    // TASK-BQ03-003 — BQ-shaped cursor that hit its natural EOF: a later
    // loadMore is a graceful no-op (no throw, no extra fetch, unchanged
    // rows). Mirrors the `resultLimited` no-op above; ordering matches
    // the existing `cursorClosed` throw because a budget-limited
    // statement also has `cursorExhausted` unset (budget close ≠ EOF
    // close on a BQ handle in this design — onExhausted is the limited
    // signal and the EOF branch is the close path).
    if (r.cursorExhausted) {
      return this.results.slice();
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
    // TASK-BQ03-003 R4.5 — detect BigQuery-shaped handles via the real
    // `BigQueryPagedQuery.setOnExhausted(cb)` installer method. 03.1's
    // adapter stores the hook in a PRIVATE `onExhaustedCb` field — there
    // is NO own `onExhausted` property on the instance. The previous
    // duck-type (`'onExhausted' in batched`) was inert against the real
    // adapter. Postgres cursors do NOT have `setOnExhausted`; their EOF
    // behavior is unchanged (the next-run sweep still releases them and
    // the ARP03-002 boundary tests pin `cursorClosed` undefined at EOF).
    const bqLike = batched as BatchedQuery & {
      setOnExhausted?: (cb: (info: { limited: boolean }) => void) => void;
    };
    const isBqShaped = typeof bqLike.setOnExhausted === "function";
    if (isBqShaped && bqLike.setOnExhausted) {
      // Wire the onExhausted callback so 03.1's BigQueryPagedQuery can
      // surface its internal `limited` flag as `resultLimited` on the
      // statement (mirrors the budget close path below). The callback
      // must NOT close the handle — that's loadMoreImpl's job at the
      // EOF transition — so the onExhausted fires BEFORE the EOF check
      // sees the null and closes; if it already ran, we no-op.
      bqLike.setOnExhausted((info: { limited: boolean }) => {
        if (!info.limited) return;
        if (r.resultLimited || r.cursorClosed) return;
        // The BQ handle hit its byte budget at EOF. We only mark the
        // flag here; the actual close is performed by the EOF branch
        // below (unified path) for both limited and non-limited BQ
        // handles. This keeps "EOF releases the job context exactly
        // once" as a single transition.
        r.resultLimited = true;
      });
    }
    // Track currentBatched để cancel mid-fetchBatch reaches đúng cursor.
    this.currentBatched = batched;
    this.currentBatchedCancelDelivered = false;
    // Snapshot the cancel sequence before the await; a cancel landing during
    // the fetch bumps it (see cancel()).
    const cancelSeqBefore = this.cancelSeq;
    // TASK-BQ03-003 — snapshot the run generation too. A new `run()`
    // having started while the fetch was parked bumps the counter (and
    // resets cancelSeq to 0); the cancelSeq re-check alone cannot catch
    // this because both the snapshot and the post-await value are 0.
    const runGenBefore = this.runGeneration;
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
      // TASK-BQ03-003 — late page after a NEW run: a run() that started
      // while we were parked bumps `runGeneration`; the late batch is
      // discarded so it never lands on the previous run's preserved
      // statement (append-mode) or a leaked object reference.
      if (this.runGeneration !== runGenBefore) {
        return this.results.slice();
      }
      if (batch === null || batch.length === 0) {
        // EOF — không append gì; rowCount = current rows length.
        if (r.result) {
          r.result = { ...r.result, rowCount: r.result.rows.length };
        }
        // TASK-BQ03-003 — BQ-shaped handle on EOF: close the retained
        // job context exactly once and mark the statement `cursorClosed`.
        // Plain postgres cursors are NOT closed here (the next-run
        // sweep releases them and the ARP03-002 boundary tests pin
        // `cursorClosed` undefined at EOF for non-BQ handles). When
        // onExhausted already marked `resultLimited`, this same call
        // closes the handle for the budget — unified EOF transition.
        if (isBqShaped && !r.cursorClosed) {
          this.currentBatchedCancelDelivered = true;
          this.currentBatched = null;
          try {
            await batched.close();
          } catch {
            // best-effort — handle may already be closed.
          }
          r.cursorClosed = true;
          r.cursorExhausted = true;
        }
        return this.results.slice();
      }
      const currentRows = r.result?.rows ?? [];
      // TASK-ARP03-002 — retained-row budget. This runs AFTER the `cancelSeq`
      // re-check above, so a cancel landing mid-fetch already returned (batch
      // discarded) and the budget close can never race the cancel close on
      // the same cursor — mutually exclusive by ordering.
      const { rows: merged, limited } = appendBatchBounded(
        currentRows,
        batch,
        this.maxRetainedRows,
      );
      if (r.result) {
        r.result = {
          ...r.result,
          rows: merged,
          rowCount: merged.length,
        };
      }
      if (limited) {
        // Budget close — exactly once, same delivered-once shape as the
        // ARP-02 cancel path. Best-effort: a cursor that is already closed
        // (or a close() rejection) must not turn the limit into an error.
        this.currentBatchedCancelDelivered = true;
        // Null currentBatched BEFORE the await: while `batched.close()` is
        // pending, a concurrent cancel() must see close-origin state (no
        // live cursor) so `cancelPending` stays false. If currentBatched
        // still referenced the cursor here, cancel() would latch
        // cancelPending=true, early-return on the delivered-once guard, and
        // strand it — poisoning a later healthy loadMore on a DIFFERENT
        // open statement with "Statement N cancelled" (ARP-02 isolation).
        // The finally below only resets when the reference still matches,
        // so this early null is safe (idempotent with it).
        this.currentBatched = null;
        try {
          await batched.close();
        } catch {
          // best-effort — cursor may already be closed.
        }
        r.cursorClosed = true;
        r.resultLimited = true;
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
   * TASK-UX2-003 — append ONE synthetic `StatementResult` to `this.results`
   * so the Results panel renders the same shape for a connection-failure
   * as for a failed statement. Fires the cached `onUpdate` callback (set
   * by the most recent `run()`) so the panel goes through its single,
   * existing render path — no parallel "error tab" producer.
   *
   * Contract:
   *   - Synchronous append: `{index: results.length, sql: "(connection)",
   *     status: "error", error: reason, durationMs: 0}`.
   *   - Throws `RunnerBusy` if a real `run()` is currently in flight —
   *     the synthetic row would race the live run's onUpdate emit.
   *   - Defensive: if no `run()` has been called yet (or the most recent
   *     run already settled), the row is still appended but no onUpdate
   *     fires (the panel just won't see it — caller's job to wire a
   *     subscriber if they want it before the first run).
   *   - Idempotent at the row level: calling twice accumulates two rows.
   *     A second call before the panel has rendered the first does NOT
   *     crash — each call appends independently.
   *
   * Why a separate path from `run()`: first-connect failures throw out of
   * `adapterProvider()` before any statement runs, so there is no
   * StatementResult to surface. The host's `runStatements` outer catch
   * (TASK-UX2-004) calls this instead of dropping a toast.
   */
  runFailed(reason: string): void {
    // Synchronous guard — `this.running` is set before the first await
    // inside `run()`, so by the time a real run is in flight, this is
    // non-null. Throwing synchronously keeps the contract tight: the
    // caller can `try/catch` around the host catch path.
    if (this.running !== null) {
      throw new RunnerBusy();
    }
    const row: StatementResult = {
      index: this.results.length,
      sql: "(connection)",
      status: "error",
      error: reason,
      durationMs: 0,
    };
    this.results.push(row);
    // Reuse the existing onUpdate contract (TASK-UX2-003 acceptance —
    // no separate emit). If no run() has registered a callback yet,
    // skip silently; the row is still in `this.results` for later
    // observers (e.g. a panel that subscribes post-mount).
    if (this.lastOnUpdate) {
      this.lastOnUpdate(this.results.slice());
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

// ---- TASK-UX1-010: classify + stamp helpers --------------------------------
//
// R12 — DDL/DML statements render a status card, not an empty grid.
//
// The classification is deliberately text-first: the first significant
// keyword after comment/whitespace stripping drives the kind. `WITH ...
// SELECT` counts as select; `SELECT ... INTO` as a count (destructive
// form, host classifies as ddl). Adapter-level grammars are rejected as
// fragile cross-driver.
//
// `stampStatementKind` is the host-side pure helper that mirrors the
// `stampBqDialect` precedent: it stamps the additive `kind` field on
// every entry of a settled run slice. Pending entries (BQ-pending shapes)
// are SKIPPED — their `kind` stays `undefined` so the existing pending
// renderer keeps working unchanged. The dialect marker is orthogonal —
// the helper does not read or write `dialect` / `schemaFields`.

/** Coarse statement-kind taxonomy. Stable string union — the panel
 *  consumer keys the visual branch on this value. */
export type StatementKind = "select" | "ddl" | "dml" | "other";

/**
 * Classify a SQL string into a coarse kind bucket.
 *
 * Algorithm: scan past leading whitespace, single-line (`-- …`) and
 * block (`/* … *\/`) comments, return the first non-comment, non-
 * whitespace, non-string-literal, non-dollar-quote keyword token
 * (case-insensitive) and look it up against the bucket table.
 *
 * Truth table (per TASK-UX1-010 §Test Cases case 5):
 *   - SELECT / WITH         → "select"
 *   - CREATE / ALTER / DROP → "ddl" (also `SELECT … INTO`)
 *   - INSERT / UPDATE / DELETE / CALL / MERGE → "dml"
 *   - everything else       → "other" (EXPLAIN / SET / SHOW / etc.)
 *
 * Never throws — empty / whitespace-only / comment-only SQL returns
 * `"other"` so a stale call doesn't break a panel render.
 */
export function classifyStatementKind(
  sql: string,
  _dialect?: SqlDialect,
): StatementKind {
  if (!sql) return "other";
  const s = sql;
  let i = 0;
  const n = s.length;
  // Walk past leading whitespace + comments + string-literal + dollar-quote
  // tokens to find the first significant SQL keyword.
  while (i < n) {
    const c = s[i];
    // whitespace
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // line comment
    if (c === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    // block comment
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    // string literal — skip
    if (c === "'") {
      i++;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // dollar-quoted body — skip
    if (c === "$") {
      // $tag$ … $tag$ (postgres)
      const tagEnd = s.indexOf("$", i + 1);
      if (tagEnd > i + 1) {
        const tag = s.substring(i, tagEnd + 1);
        const closer = s.indexOf(tag, tagEnd + 1);
        i = closer < 0 ? n : closer + tag.length;
        continue;
      }
      // $$ … $$ fallback
      if (s[i + 1] === "$") {
        const closer = s.indexOf("$$", i + 2);
        i = closer < 0 ? n : closer + 2;
        continue;
      }
    }
    // first identifier-character — read keyword
    if (
      (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_"
    ) {
      let j = i;
      while (
        j < n &&
        ((s[j] >= "a" && s[j] <= "z") ||
          (s[j] >= "A" && s[j] <= "Z") ||
          (s[j] >= "0" && s[j] <= "9") ||
          s[j] === "_" ||
          s[j] === "$")
      ) {
        j++;
      }
      const keyword = s.substring(i, j).toUpperCase();
      // Peek for `SELECT ... INTO` — destructive form, classified as DDL.
      if (keyword === "SELECT") {
        // scan ahead for INTO/INTO TEMP (skipping over strings + comments).
        const after = scanForInto(s, j);
        if (after.found) return "ddl";
        return "select";
      }
      // WITH … SELECT counts as select.
      if (keyword === "WITH") return "select";
      switch (keyword) {
        case "CREATE":
        case "ALTER":
        case "DROP":
          return "ddl";
        case "INSERT":
        case "UPDATE":
        case "DELETE":
        case "CALL":
        case "MERGE":
          return "dml";
        default:
          return "other";
      }
    }
    // anything else (digit, etc.) — stop; we already have the keyword.
    break;
  }
  return "other";
}

/** Scan forward from `start` for the keyword `INTO` (with optional TEMP
 *  variant) past comments / strings / wildcards (`*`). Used by
 *  `classifyStatementKind` to classify `SELECT ... INTO new_t` as DDL.
 *  Stops at any non-INTO identifier (FROM / WHERE / LIMIT / …) since
 *  INTO cannot follow those tokens in valid SQL. */
function scanForInto(s: string, start: number): { found: boolean } {
  let i = start;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (s[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // `*` (column wildcard) — keep walking, INTO may follow.
    if (c === "*") {
      i++;
      continue;
    }
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_") {
      let j = i;
      while (
        j < n &&
        ((s[j] >= "a" && s[j] <= "z") ||
          (s[j] >= "A" && s[j] <= "Z") ||
          (s[j] >= "0" && s[j] <= "9") ||
          s[j] === "_")
      ) {
        j++;
      }
      const word = s.substring(i, j).toUpperCase();
      if (word === "INTO") return { found: true };
      // any other token (FROM, WHERE, LIMIT, …) — INTO is not present.
      return { found: false };
    }
    // digit / punctuation — keep walking (e.g. `1` after `SELECT 1`).
    if (c >= "0" && c <= "9") {
      i++;
      while (i < n && s[i] >= "0" && s[i] <= "9") i++;
      continue;
    }
    // `.` (table.column reference) — keep walking.
    if (c === ".") {
      i++;
      continue;
    }
    // any other character — stop, INTO is not present.
    return { found: false };
  }
  return { found: false };
}

/**
 * Pure stamping helper — mirror of `stampBqDialect` for the additive
 * `kind` marker on `StatementResult`. Sets `kind` on every settled
 * entry of `runSlice` (skips pending entries — BQ-pending shape stays
 * `kind === undefined` per case 6). The helper never touches
 * `dialect` / `schemaFields` / any other field; the dialect stamp
 * (TASK-BQ04-001) is orthogonal and fires on a separate call site.
 *
 * Returns the same reference as `runSlice` for caller chaining.
 * Entries are mutated in place (matching `stampBqDialect` and the
 * runner's own in-place mutation pattern).
 */
export function stampStatementKind(runSlice: StatementResult[]): StatementResult[] {
  for (const stmt of runSlice) {
    // Pending entries (BQ-pending shape) carry no settled SQL — skip.
    // The `kind` field stays `undefined` so the BQ-pending renderer
    // keeps its legacy grid/pending contract byte-identical.
    if (stmt.pending) continue;
    // Already-stamped (idempotent re-run) — skip the re-classification
    // so a second stamp call from a panel rerender doesn't churn the
    // marker. The classifier is deterministic so this only saves work.
    if (stmt.kind) continue;
    stmt.kind = classifyStatementKind(stmt.sql ?? "");
  }
  return runSlice;
}
