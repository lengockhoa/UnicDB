// src/ui/messages.ts
// Shared message protocol between extension host and ResultsPanel webview.
// Defined in a shared file so both sides can import the same TypeScript types.
//
// All messages use a `type` discriminator. Unknown messages are ignored.
import type { StatementResult } from "../core/queryRunner";
import type { ExportFormat } from "./resultsGridModel";
import type { ColumnFilterModel } from "./queryComposer";

export interface InitMessage {
  type: "init";
  /** URI của webview.bundle.js (resolved bằng asWebviewUri). */
  scriptUri: string;
  /** URI của webview/styles.css (resolved bằng asWebviewUri). */
  styleUri: string;
  /** CSP nonce/header cho webview. */
  cspSource: string;
}

export interface StateMessage {
  type: "state";
  /** Header tổng (vd "Run at 2024-01-01 10:00 — postgres@localhost/db"). */
  header: string;
  /** Kết quả từng statement. */
  results: StatementResult[];
  /** Đang busy / running → disable buttons. */
  busy: boolean;
}

export interface BusyMessage {
  type: "busy";
  busy: boolean;
}

export interface TransactionStatusMessage {
  type: "transactionStatus";
  /** Whether the active connection currently has a manual transaction open. */
  open: boolean;
}

export type HostMessage =
  | InitMessage
  | StateMessage
  | BusyMessage
  | SaveResultMessage
  | TransactionStatusMessage
  | DistinctValuesMessage;

// ---- Webview → Host --------------------------------------------------------

export interface LoadMoreMessage {
  type: "loadMore";
  index: number;
}

export interface CancelMessage {
  type: "cancel";
}

export interface CopyMessage {
  type: "copy";
  text: string;
}

export interface ExportFileMessage {
  type: "exportFile";
  format: ExportFormat;
  text: string;
}

export interface ReadyMessage {
  type: "ready";
}
export type WebviewMessage =
  | LoadMoreMessage
  | CancelMessage
  | CopyMessage
  | ExportFileMessage
  | SaveEditsMessage
  | RetryFailedRowsMessage
  | RequeryMessage
  | ReadyMessage
  | CommitTransactionMessage
  | RollbackTransactionMessage
  | RequestDistinctValuesMessage;

/** TASK-004 / TASK-003 — webview asks the host for a column's distinct values
 *  (set-filter dropdown). The reply echoes `index` + `column` and is cached
 *  per `(index, column)` host-side until the next render for that index. */
export interface RequestDistinctValuesMessage {
  type: "requestDistinctValues";
  /** Statement index the dropdown belongs to. */
  index: number;
  /** Column (field) name. */
  column: string;
}

/** Host reply carrying the column's DISTINCT values. Additive: an older
 *  webview bundle ignores the unknown `type`. */
export interface DistinctValuesMessage {
  type: "distinctValues";
  /** Echoed from the request. */
  index: number;
  /** Echoed from the request. */
  column: string;
  /** Raw DB values, may contain null. */
  values: unknown[];
  /** true when more distinct values exist than were returned. */
  truncated: boolean;
  /** present when the query failed — values is empty and the webview keeps
   *  its loaded-row fallback. */
  error?: string;
}

export interface CommitTransactionMessage {
  type: "commitTransaction";
}

export interface RollbackTransactionMessage {
  type: "rollbackTransaction";
}

export interface RequeryMessage {
  /** TASK-504 — user clicked "Re-Run" with a WHERE/ORDER BY filter. Host
   *  composes the SQL via `composeRequery(r.sql, where, orderBy)` and runs
   *  it through the QueryRunner; the resulting StatementResult replaces
   *  the entry at `index` in the panel. */
  type: "requery";
  index: number;
  where: string;
  orderBy: string;
  /** TASK-005 — AG Grid set-filter model (display values + optional typed
   *  raw values) pushed down as a server-side WHERE. Optional is
   *  load-bearing: the three pre-TASK-005 senders (Re-Run, Refresh,
   *  post-save auto-requery) omit it and must behave byte-identically. */
  filters?: ColumnFilterModel;
  /** 0-based row offset; present ⇒ host pages via buildPagedQuery.
   *  Omitted ⇒ no paging (unless filters force a server-side wrap). */
  offset?: number;
  /** Page size; omitted ⇒ adapter default batch (500). */
  limit?: number;
  /** true ⇒ concatenate the fresh page onto the existing result.rows
   *  instead of replacing (server-side "Load More"). */
  append?: boolean;
}

export interface SaveEditsMessage {
  type: "saveEdits";
  /** Statement index whose snapshot owns the edits. */
  index: number;
  /** One entry per dirty cell. Mirrors EditState.snapshot() shape. */
  edits: Array<{
    rowId: number;
    colIndex: number;
    value: unknown;
  }>;
  /** Host-derived FROM-clause table name (or null when statement has none). */
  tableName: string | null;
  /** PK columns derived via DbAdapter.listColumns (empty = caller must fall back). */
  pkColumns: string[];
  /** cycle T / TASK-002 (A12): __rowId → index into the host's
   *  result.rows. Keys are stringified numbers (JSON). Absent ⇒ host
   *  falls back to rowId. */
  serverIndexByRowId?: Record<string, number>;
}

export interface RetryFailedRowsMessage {
  /** TASK-005 / A19 — webview "Retry failed rows" click after a partial
   *  save failure (saveResult carried rowErrors). Carries ONLY the failed
   *  rows: successful rows' edits were already cleared from the webview's
   *  EditState by `clearExceptRowIds`, and the snapshot here is filtered
   *  again to `rowIds`. The host defensively re-filters against `rowIds`
   *  and runs the subset through the same save pipeline as saveEdits. */
  type: "retryFailedRows";
  /** Statement index whose snapshot owns the edits. */
  index: number;
  /** Stable rowIds of the rows that failed in the previous save ack. */
  rowIds: number[];
  /** Only the failed rows' dirty edits — same entry shape as
   *  SaveEditsMessage.edits (mirrors EditState.snapshot() filtered to
   *  rowIds). */
  edits: Array<{
    rowId: number;
    colIndex: number;
    value: unknown;
  }>;
  /** Same __rowId → result.rows index map as SaveEditsMessage (A12). */
  serverIndexByRowId?: Record<string, number>;
}

export interface SaveResultMessage {
  type: "saveResult";
  /** Statement index echoed back to the webview so it can find its panel. */
  index: number;
  /** True on full success; false when ANY statement failed. */
  ok: boolean;
  /** Per-statement error messages (parallel to host execution order). */
  errors?: string[];
  /** Non-fatal per-row warnings from the save operation. */
  warnings?: string[];
  /**
   * Soft refusal (e.g. mysql/mssql without a PK). When `refused` is true the
   * webview MUST clear its dirty state too — there is nothing to retry, and
   * the `reason` is the single-line banner copy.
   */
  refused?: boolean;
  reason?: string;
  /**
   * TASK-007 — per-row error report. When the host runs each generated
   * UPDATE/INSERT/DELETE statement against the DB and at least one fails,
   * it pairs the failing row's stable id with the driver error string so
   * the webview can KEEP that row's edits dirty (for retry) while clearing
   * successful rows. Older hosts (pre-T7) do not send this field; the
   * webview treats absence as "no per-row info, banner shows joined
   * `errors[]` and the user fixes manually".
   */
  rowErrors?: Array<{ rowId: number; error: string }>;
}

