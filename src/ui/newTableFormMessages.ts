// src/ui/newTableFormMessages.ts
// Message protocol giữa NewTableForm (host) và webview designer dialog
// (DataGrip-style: left COLUMNS/KEYS list + right edit form + bottom SQL
// preview). Mirror pattern src/ui/connectionFormMessages.ts — type
// discriminator, unknown ignored.
import type { TableSpec } from "../core/ddl/createTable";

/** Host → webview: cấu hình ban đầu khi webview ready. */
export interface NewTableFormInit {
  type: "init";
  mode: "create" | "modify";
  schema: string;
  /** Modify mode: table hiện tại (giữ để webview biết khi render). */
  originalTableName?: string;
  /** Modify mode: spec đã introspect. Create mode: defaultColumnSpecs(name). */
  spec: TableSpec;
  /** Modify mode: loadSpec() reject — webview vẫn render empty spec. */
  loadError?: string;
}

/** Webview → host: ready để nhận init. */
export interface NewTableFormReady {
  type: "ready";
}

/** Webview → host: spec thay đổi (rename/add/remove/edit column/key). */
export interface NewTableFormSpecChanged {
  type: "specChanged";
  spec: TableSpec;
  /** Bật khi table name đổi (modify mode cần để host re-diff đúng). */
  tableChanged?: boolean;
}

/** Webview → host: user nhấn Cancel hoặc Escape. */
export interface NewTableFormCancel {
  type: "cancel";
}

/** Webview → host: user nhấn OK — Execute. */
export interface NewTableFormSubmit {
  type: "submit";
  spec: TableSpec;
}

export type NewTableFormWebviewMessage =
  | NewTableFormReady
  | NewTableFormSpecChanged
  | NewTableFormCancel
  | NewTableFormSubmit;

// ---- Host → Webview --------------------------------------------------------

/** Host → webview: preview SQL + errors (refresh sau mỗi specChanged). */
export interface NewTableFormPreview {
  type: "preview";
  /** Empty khi errors>0 hoặc modify mode không có diff. */
  sql: string;
  errors: string[];
}

export type NewTableFormHostMessage = NewTableFormInit | NewTableFormPreview;
