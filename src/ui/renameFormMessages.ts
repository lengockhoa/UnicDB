// src/ui/renameFormMessages.ts — TASK-DBX06-003 + DBX06-006
// Message protocol giữa RenameForm (host) và webview rename dialog.
// Mirror pattern newTableFormMessages.ts — type discriminator, unknown ignored.
// DBX06-006 — analysis carries typed RenamePlanStep[]; done carries
// named-step applied/failed outcomes.
import type { RenameReport } from "../core/ddl/renameAnalysis";
import type { RenamePlanStep } from "../core/ddl/renameCatalog";

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
  /** DBX06-006 — typed plan steps (executable rename + review rows). */
  steps: RenamePlanStep[];
  errors: string[];
}

/** Host → webview: tiến độ từng statement khi approve. */
export interface RenameFormProgress {
  type: "progress";
  index: number;
  total: number;
  statement: string;
}

/** DBX06-006 — named applied step entry, mirrors renameRunner.NamedStep. */
export interface NamedRenameStep {
  index: number;
  label: string;
  sql: string;
}

/** Host → webview: kết thúc chạy (hoàn tất / hủy giữa chừng / lỗi giữa chừng). */
export interface RenameFormDone {
  type: "done";
  /** DBX06-006 — every applied step (always present, possibly empty). */
  applied: NamedRenameStep[];
  /** DBX06-006 — total number of executable steps at run time. */
  total: number;
  /** DBX06-006 — set when an execute() rejected; names the failed step. */
  failed?: NamedRenameStep & { error: string };
  /** DBX06-006 — set on cancel; the cancel boundary index. */
  cancelledAfter?: number;
  /** DBX06-006 — set on cancel; remaining steps that never ran. */
  remaining?: number;
}

export type RenameFormHostMessage =
  | RenameFormInit
  | RenameFormAnalysis
  | RenameFormProgress
  | RenameFormDone;
