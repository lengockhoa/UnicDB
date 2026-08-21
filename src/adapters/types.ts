// src/adapters/types.ts
// Interface dùng chung cho 3 DB adapter (postgres/mysql/mssql).
// TASK-003 §Interfaces — TASK-004/005/006/007 consume NGUYÊN VĂN.

/**
 * Kết quả trả về cho một statement đã chạy xong.
 * `rows` là mảng các mảng giá trị theo đúng thứ tự `columns`.
 * `commandTag` cho biết loại statement (vd "SELECT 5", "INSERT 0 3" của Postgres).
 * `durationMs` do adapter tự đo.
 */
export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number | null;
  commandTag?: string;
  durationMs: number;
}

/** Thông tin một table. */
export interface TableInfo {
  name: string;
  schema: string;
}

/** Thông tin một view. */
export interface ViewInfo {
  name: string;
  schema: string;
}

/**
 * Thông tin một routine (function hoặc procedure).
 * `kind` phân biệt function/procedure vì Postgres trả về cả 2 từ pg_proc.
 */
export interface RoutineInfo {
  name: string;
  kind: "function" | "procedure";
  schema: string;
}

/** Thông tin một column. */
export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
}

/**
 * Server-side cursor: adapter execute query 1 lần, rồi `fetchBatch()` lần lượt
 * trả về từng batch rows cho đến khi hết → trả `null`.
 *
 * - `fetchBatch()`: lấy batch kế tiếp (mặc định 500 rows ở Postgres). `null` = EOF.
 * - `cancel()`: dừng query phía server (Pg: cursor.close + pg_cancel_backend).
 * - `close()`: giải phóng tài nguyên (Pg: cursor.close). Idempotent.
 */
export interface BatchedQuery {
  columns: string[];
  fetchBatch(): Promise<any[][] | null>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Run-result: một adapter runQuery trả về:
 *  - `results`: QueryResult[] cho MỌI statement trong script.
 *  - `batched`: nếu statement cuối là SELECT lớn và adapter hỗ trợ cursor
 *    (chỉ Postgres ở TASK-003), adapter trả kèm BatchedQuery. Caller lúc đó
 *    KHÔNG nên đọc rows từ `results` cuối — rows nằm trong batched.
 */
export interface RunResult {
  results: QueryResult[];
  batched?: BatchedQuery;
}

/**
 * Adapter interface dùng chung cho 3 driver.
 *
 * `runQuery` nhận một SQL string (có thể nhiều statements phân tách bằng `;`,
 * tuỳ adapter — Postgres thực thi từng statement riêng qua cursor).
 *
 * `cancel()` không có trên interface vì cancel gắn với từng BatchedQuery.
 */
export interface DbAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  runQuery(sql: string): Promise<RunResult>;
  listTables(schema?: string): Promise<TableInfo[]>;
  listViews(schema?: string): Promise<ViewInfo[]>;
  listRoutines(schema?: string): Promise<RoutineInfo[]>;
  listColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
  testConnection(): Promise<void>;
}

/**
 * Error báo hiệu driver chưa được implement trong task này.
 * Factory ném lỗi này khi user chọn driver chưa được TASK-003 hỗ trợ.
 */
export class NotImplementedError extends Error {
  constructor(driver: string) {
    super(`Driver "${driver}" is not implemented yet (TASK-004 will add it).`);
    this.name = "NotImplementedError";
  }
}