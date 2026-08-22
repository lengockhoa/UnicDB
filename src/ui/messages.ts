// src/ui/messages.ts
// Shared message protocol between extension host and ResultsPanel webview.
// Defined in a shared file so both sides can import the same TypeScript types.
//
// All messages use a `type` discriminator. Unknown messages are ignored.
import type { StatementResult } from "../core/queryRunner";

// ---- Host → Webview --------------------------------------------------------

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

export type HostMessage = InitMessage | StateMessage | BusyMessage;

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
  format: "tsv" | "csv" | "xml" | "json" | "sql-inserts" | "sql-inserts-multirow" | "sql-updates" | "sql-where";
  text: string;
}

export interface ReadyMessage {
  type: "ready";
}
export type WebviewMessage = LoadMoreMessage | CancelMessage | CopyMessage | ExportFileMessage | ReadyMessage;
