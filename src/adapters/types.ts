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

/** Thông tin một schema. */
export interface SchemaInfo {
  name: string;
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
 * A database session pinned to one physical connection until it is committed or
 * rolled back. This prevents a manual transaction from leaking across pooled
 * adapter calls.
 */
export interface DbTransaction {
  runQuery(sql: string): Promise<RunResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
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
  beginTransaction?(): Promise<DbTransaction>;
  listSchemas(includeSystem: boolean): Promise<SchemaInfo[]>;
  listTables(schema?: string): Promise<TableInfo[]>;
  listViews(schema?: string): Promise<ViewInfo[]>;
  listRoutines(schema?: string): Promise<RoutineInfo[]>;
  listColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
  /**
   * Routine argument introspection — one entry per routine parameter.
   * `name` is null for unnamed positional args (Postgres `proargnames`
   * can be NULL). Empty array for no-arg routines. MySQL/MSSQL throw
   * NotImplementedError (caller guards driver === "postgres" first).
   */
  listRoutineParams(
    schema: string,
    routine: string,
  ): Promise<Array<{ name: string | null; dataType: string }>>;
  /**
   * Row estimate cho table từ planner/catalog metadata (không scan).
   * Null = unknown (chưa analyze / lỗi / không tồn tại).
   */
  estimateTableRows(schema: string, table: string): Promise<number | null>;
  /**
   * D2 (TASK-005): batch row estimate — one round trip cho nhiều table thay
   * vì gọi estimateTableRows() N lần (đặc biệt tốn kém trên pool `max: 1`).
   * Table không tồn tại / bị drop giữa list và estimate → OMIT khỏi Map
   * (không map sang null, không throw). `tables` rỗng → Map rỗng, KHÔNG
   * issue query nào.
   */
  estimateTableRowsBatch(
    schema: string,
    tables: readonly string[],
  ): Promise<Map<string, number | null>>;
  /**
   * One-shot introspection: trả columns + constraints cho (schema, table) qua
   * parameterized SQL. PostgresAdapter.pool.query(sql, [schema, table]) bind
   * $1/$2 an toàn — không phải regex SQL. Tách khỏi runQuery vì runQuery
   * single-SELECT route qua cursor (trả empty results).
   *
   * MySQL/MSSQL chưa implement → throw NotImplementedError. Caller guard
   * driver === "postgres" trước khi gọi.
   */
  listTableDetail(schema: string, table: string): Promise<TableDetail>;
  testConnection(): Promise<void>;
}

/**
 * Result shape cho adapter.listTableDetail. Row format giữ stringly-typed cho
 * pg_catalog (pgIntrospect map sang TableSpec sau).
 */
export interface TableDetail {
  columns: Array<{
    column_name: string;
    format_type: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
  }>;
  constraints: Array<{
    conname: string;
    contype: string;
    conkey: number[];
    confrelidname: string | null;
    confkeycols: string[] | null;
    consrc: string;
  }>;
}

/**
 * Error báo hiệu driver chưa được implement trong task này.
 * Factory ném lỗi này khi user chọn driver chưa TASK-003 hỗ trợ.
 */
export class NotImplementedError extends Error {
  constructor(driver: string) {
    super(`Driver "${driver}" is not implemented yet (TASK-004 will add it).`);
    this.name = "NotImplementedError";
  }
}
