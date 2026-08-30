// src/ui/connectionFormMessages.ts
// Message protocol giữa ConnectionForm (host) và webview form.
// Mirror pattern src/ui/messages.ts — type discriminator, unknown ignored.
import type { ConnectionConfig, DriverType, SslMode } from "../config/types";

/** Form data gửi sang webview (edit mode: prefilled; add mode: null). */
export interface ConnectionFormInit {
  type: "init";
  /** null = add mode, object = edit mode. */
  existing: ConnectionConfig | null;
}

/** Kết quả submit từ webview (cũng dùng cho test). */
export interface ConnectionFormSubmit {
  type: "submit";
  name: string;
  driver: DriverType;
  host: string;
  port: number;
  user: string;
  database: string;
  /** Chuỗi rỗng = không đổi password (edit mode). */
  password: string;
  sslMode: SslMode;
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  /** TASK-001 — luôn boolean cụ thể (false = automatic), không bao giờ omitted. */
  manualCommit: boolean;
  /** DBX-05 — connection workspace fields (all optional, round-tripped). */
  folder: string;
  color: string;
  readOnly: boolean;
  tunnelHost: string;
  tunnelPort: number | null;
  tunnelUser: string;
  tunnelIdentityFile: string;
}

export interface ConnectionFormCancel {
  type: "cancel";
}

/** Webview xin host mở file picker cho một SSL path field. */
export interface ConnectionFormPickFile {
  type: "pickFile";
  field: "sslCaPath" | "sslCertPath" | "sslKeyPath";
}
export interface ConnectionFormReady {
  type: "ready";
}

export type FormWebviewMessage =
  | ConnectionFormSubmit
  | ConnectionFormCancel
  | ConnectionFormPickFile
  | ConnectionFormTest
  | ConnectionFormReady;

export interface ConnectionFormTest {
  type: "test";
  name: string;
  driver: DriverType;
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
  sslMode: SslMode;
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  /** TASK-001 — giữ trường qua protocol cho symmetric với submit. */
  manualCommit: boolean;
}

// ---- Host → Webview --------------------------------------------------------

/** Host → webview: kết quả test connection. */
export interface ConnectionFormTestResult {
  type: "testResult";
  ok: boolean;
  message: string;
}

/** Host → webview: path user vừa chọn qua file picker. */
export interface ConnectionFormPickFileResult {
  type: "pickFileResult";
  field: "sslCaPath" | "sslCertPath" | "sslKeyPath";
  path: string;
}

export type FormHostMessage =
  | ConnectionFormInit
  | ConnectionFormTestResult
  | ConnectionFormPickFileResult;

