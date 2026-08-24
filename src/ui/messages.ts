// src/ui/messages.ts
// Shared message protocol between extension host and ResultsPanel webview.
// Defined in a shared file so both sides can import the same TypeScript types.
//
// All messages use a `type` discriminator. Unknown messages are ignored.
import type { StatementResult } from "../core/queryRunner";
import type { ExportFormat } from "./resultsGridModel";

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

export type HostMessage = InitMessage | StateMessage | BusyMessage | SaveResultMessage;

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
  | RequeryMessage
  | ReadyMessage;

export interface RequeryMessage {
  /** TASK-504 — user clicked "Re-Run" with a WHERE/ORDER BY filter. Host
   *  composes the SQL via `composeRequery(r.sql, where, orderBy)` and runs
   *  it through the QueryRunner; the resulting StatementResult replaces
   *  the entry at `index` in the panel. */
  type: "requery";
  index: number;
  where: string;
  orderBy: string;
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
}

export interface SaveResultMessage {
  type: "saveResult";
  /** Statement index echoed back to the webview so it can find its panel. */
  index: number;
  /** True on full success; false when ANY statement failed. */
  ok: boolean;
  /** Per-statement error messages (parallel to host execution order). */
  errors?: string[];
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

