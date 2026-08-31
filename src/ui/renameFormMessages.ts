// src/ui/renameFormMessages.ts — TASK-DBX06-003
// Message protocol giữa RenameForm (host) và webview rename dialog.
// Mirror pattern newTableFormMessages.ts — type discriminator, unknown ignored.
import type { RenameReport } from "../core/ddl/renameAnalysis";

export interface RenameFormInit {
  type: "init";
  mode: "table" | "column";
  schema: string;
  table: string;
  oldName: string;
}

export interface RenameFormReady {
  type: "ready";
}

/** Webview → host: user đã nhập tên mới, yêu cầu analyze. */
export interface RenameFormAnalyze {
  type: "analyze";
  newName: string;
}

/** Webview → host: user duyệt plan — host chạy statements. */
export interface RenameFormApprove {
  type: "approve";
}

export interface RenameFormCancel {
  type: "cancel";
}

export type RenameFormWebviewMessage =
  | RenameFormReady
  | RenameFormAnalyze
  | RenameFormApprove
  | RenameFormCancel;

// ---- Host → Webview ---------------------------------------------------------

/** Host → webview: kết quả analyze — report + plan (hoặc errors). */
export interface RenameFormAnalysis {
  type: "analysis";
  report: RenameReport;
  statements: string[];
  errors: string[];
}

/** Host → webview: tiến độ từng statement khi approve. */
export interface RenameFormProgress {
  type: "progress";
  index: number;
  total: number;
  statement: string;
}

/** Host → webview: kết thúc chạy (hoàn tất / hủy giữa chừng / lỗi giữa chừng). */
export interface RenameFormDone {
  type: "done";
  applied: number;
  total: number;
  failedAt?: number;
  failedStatement?: string;
  error?: string;
  cancelled?: boolean;
  remaining?: number;
}

export type RenameFormHostMessage =
  | RenameFormInit
  | RenameFormAnalysis
  | RenameFormProgress
  | RenameFormDone;
