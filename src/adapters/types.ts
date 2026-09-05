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
  /**
   * Run one SQL statement inside the pinned transaction. `values` are
   * bound as $N parameters when the adapter supports it (Postgres does
   * via `client.query(text, values)`); omitted for literal SQL.
   */
  runQuery(sql: string, values?: unknown[]): Promise<RunResult>;
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
  /**
   * TASK-BQF-001 / TASK-BQF-002 — optional second arg carries per-statement
   * options:
   *   - `pageSize?: number` — BQ `getQueryResults.maxResults` clamp [1,10000].
   *   - `useLegacySql?: boolean` — BQ GoogleSQL (default false) vs legacy SQL.
   * Adapters that don't recognize these opts ignore them (Postgres / Mssql /
   * MySql paths are byte-identical for the absent case). The BQ adapter
   * (src/adapters/bigquery.ts) is the only consumer that threads them through.
   */
  runQuery(
    sql: string,
    opts?: { pageSize?: number; useLegacySql?: boolean },
  ): Promise<RunResult>;
  /**
   * TASK-RLX-001 — best-effort cancel của operation non-cursor đang chạy
   * (statement mà QueryRunner.run() đang chờ qua runQuery). Optional:
   * adapter không có cancel server-side cứ bỏ qua — QueryRunner.cancel()
   * khi đó giữ hành vi cũ (chỉ set flag).
   *
   * Contract:
   *  - KHÔNG được close adapter/pool (chỉ cancel statement hiện tại).
   *  - KHÔNG đụng vào BatchedQuery cursor — cursor cancel qua
   *    BatchedQuery.cancel() (QueryRunner đảm bảo seam chỉ gọi khi KHÔNG có
   *    currentBatched).
   *  - Idempotent: không có operation active → resolve không làm gì.
   */
  cancelActiveQuery?(): Promise<void>;
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
  /**
   * DBX-06 Safe Rename usage analysis — parameterized pg_catalog queries
   * (views/matviews depending on the table, FKs referencing it, routines
   * mentioning it, target-name collisions). Undefined on mysql/mssql —
   * callers guard driver === "postgres" first (same as catalog/admin).
   */
  renameUsage?: RenameUsageApi;
  catalog?: CatalogApi;
  admin?: AdminApi;
  /**
   * DBX-08 — declarative advanced-capability matrix (PostgreSQL-first).
   * Optional for fixture/mock compatibility, nhưng matrix NÀY là nguồn
   * truth duy nhất cho admission ở host/UI funnels: absent, false, hay
   * partial entry đều được coi là KHÔNG hỗ trợ (fail-closed). Không suy
   * diễn support từ `driver` hay từ sự hiện diện cấu trúc của
   * `catalog`/`admin` — dùng hasAdapterCapability().
   */
  capabilities?: AdapterCapabilities;
}

/**
 * DBX-08 — các advanced surface của adapter. Mỗi key chỉ true khi adapter
 * CÓ implementation thật đã được chứng minh (capability true phải tương ứng
 * với API thật — CatalogApi.objectDdl cho `objectDdl`, v.v.).
 */
export type AdapterCapability = "catalog" | "objectDdl" | "tableDdl" | "admin";

/** Khai báo đầy đủ cả 4 capability — production adapters expose literal. */
export interface AdapterCapabilities {
  catalog: boolean;
  objectDdl: boolean;
  tableDdl: boolean;
  admin: boolean;
}

/**
 * DBX-08 — pure predicate: trả true CHỈ khi declaration là `true` tường
 * minh (=== true). Fail-closed cho mọi trường hợp còn lại: adapter
 * null/undefined, thiếu `capabilities`, thiếu key, false, hay truthy
 * non-boolean. KHÔNG bao giờ đọc `driver`, `catalog`, hay `admin` —
 * structural presence không tự động thành support.
 */
export function hasAdapterCapability(
  adapter: Pick<DbAdapter, "capabilities"> | null | undefined,
  capability: AdapterCapability,
): boolean {
  return adapter?.capabilities?.[capability] === true;
}

/**
 * DBX-06 — all lookups MUST be $n-parameterized (never interpolate
 * user identifiers into SQL text).
 */
export interface RenameUsageApi {
  dependentViews(schema: string, table: string): Promise<Array<{ name: string; kind: string }>>;
  referencingFks(schema: string, table: string): Promise<Array<{ constraint: string; fromTable: string }>>;
  routines(schema: string, table: string): Promise<Array<{ name: string }>>;
  nameCollision(schema: string, candidate: string): Promise<Array<{ name: string; kind: string }>>;
  /**
   * DBX06-005 — triggers on (schema, table) referencing `column` (pass
   * `""` in table mode). Returns `{ name, event, timing }` records
   * derived from `pg_trigger.tgtype`.
   */
  triggers(
    schema: string,
    table: string,
    column: string,
  ): Promise<Array<{ name: string; event: string; timing: string }>>;
  /**
   * DBX06-005 — indexes on (schema, table) referencing `column` (pass
   * `""` in table mode). Returns `{ name, isPrimary, isUnique, columns }`
   * records derived from `pg_index` and `pg_get_indexdef`.
   */
  indexes(
    schema: string,
    table: string,
    column: string,
  ): Promise<Array<{ name: string; isPrimary: boolean; isUnique: boolean; columns: string[] }>>;
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

// =============================================================================
// TASK-AF-001 — OPTIONAL catalog capability for adapters (PostgreSQL-first).
// Definitions live here so the DbAdapter interface stays self-contained.
// pgCatalog.ts owns the SQL template + mapper implementations and re-exports
// the info types so the schema tree (AF-002) can import from either side
// without circular imports.
// =============================================================================

export interface IndexInfo {
  name: string;
  schema: string;
  table: string;
  isUnique: boolean;
  method: string;
  columns: string[];
}

export type ConstraintType = "pk" | "fk" | "unique" | "check";

export interface TableConstraintInfo {
  name: string;
  type: ConstraintType;
  columns: string[];
  fkTarget?: { table: string; schema?: string; columns: string[] };
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
  statement: string;
}

export interface SequenceInfo {
  name: string;
  schema: string;
  dataType: string;
  lastValue?: string;
}

export interface CatalogApi {
  listIndexes(schema: string, table: string): Promise<IndexInfo[]>;
  listConstraints(schema: string, table: string): Promise<TableConstraintInfo[]>;
  listTriggers(schema: string, table: string): Promise<TriggerInfo[]>;
  listSequences(schema: string): Promise<SequenceInfo[]>;
  rowCount(schema: string, table: string): Promise<number>;
  objectDdl(
    kind: "view" | "routine" | "trigger",
    name: string,
    schema?: string,
  ): Promise<string>;
}


// =============================================================================
// Cycle AHL (TASK-AHL-001) — OPTIONAL admin capability for adapters (Postgres-first).
// pgAdmin.ts owns the SQL templates + row mappers + safe GRANT/REVOKE builders;
// this file only re-declares the public interface contract that callers use.
// mysql/mssql leave adapter.admin undefined.
// =============================================================================

import type {
  RoleInfo,
  RoleGrantInfo,
  SessionInfo,
  LockWaitInfo,
  GrantRequest,
  RevokeRequest,
  GrantOptions,
  RevokeOptions,
  AdminErrorCode,
} from "../core/admin/pgAdmin";

export type {
  RoleInfo,
  RoleGrantInfo,
  SessionInfo,
  LockWaitInfo,
  GrantRequest,
  RevokeRequest,
  GrantOptions,
  RevokeOptions,
  AdminErrorCode,
} from "../core/admin/pgAdmin";

export interface ListRolesOptions {
  includeSystemRoles?: boolean;
}

export interface ListSessionsOptions {
  limit?: number;
}

export interface AdminApi {
  listRoles(opts?: ListRolesOptions): Promise<RoleInfo[]>;
  listRoleGrants(role: string): Promise<RoleGrantInfo[]>;
  listSessions(opts?: ListSessionsOptions): Promise<SessionInfo[]>;
  listLockWaits(): Promise<LockWaitInfo[]>;
  buildGrantSql(req: GrantRequest, opts?: GrantOptions): string;
  buildRevokeSql(req: RevokeRequest, opts?: RevokeOptions): string;
}
