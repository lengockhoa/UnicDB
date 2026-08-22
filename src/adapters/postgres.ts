// src/adapters/postgres.ts
// PostgresAdapter — pg.Pool (max=1) + manual DECLARE CURSOR cho BatchedQuery.
//
// Lý do không dùng pg-cursor: package đó yêu cầu native binding (pg-native),
// trong khi ta dùng JS pure pg (node_modules/pg/lib/*.js). pg-cursor gọi
// `con.parse(...)` không tồn tại ở JS pg.
//
// Cách hiện thực cursor chuẩn Postgres:
//   BEGIN;
//   DECLARE <name> CURSOR FOR <sql>;
//   -- lặp nhiều lần --
//   FETCH 500 FROM <name>;
//   -- khi hết --
//   CLOSE c;
//   COMMIT;
//
// runQuery:
//   - Tách statement bằng splitStatements (TASK-002).
//   - Statement đơn, bắt đầu bằng SELECT, không có `;` → DECLARE CURSOR,
//     trả về QueryResult rỗng + BatchedQuery.
//   - Ngược lại (multi, non-SELECT, hoặc SELECT có `;`) → pool.query tuần tự.
//
// cancel: BatchedQuery.cancel → SELECT pg_cancel_backend(pid) qua DEDICATED
//          one-off Client (không qua pool max=1 — tránh queue/wedge), rồi
//          CLOSE/ROLLBACK/release.
// close: adapter.close() cleanup mọi BatchedQuery còn open rồi pool.end().
//
// Metadata: information_schema + pg_proc.
import { Client, Pool, PoolClient } from "pg";
import type { ConnectionConfig } from "../config/types";
import { resolveSslOptions } from "../core/sslOptions";
import type {
  BatchedQuery,
  ColumnInfo,
  DbAdapter,
  QueryResult,
  RoutineInfo,
  RunResult,
  SchemaInfo,
  TableInfo,
  ViewInfo,
} from "./types";
import { splitStatements } from "../core/statementParser";

const DEFAULT_BATCH_SIZE = 500;

type CursorState = "open" | "eof" | "closed" | "error";

interface OpenCursorRecord {
  client: PoolClient;
  cursorName: string;
  closed: Promise<void>;
}

export class PostgresAdapter implements DbAdapter {
  private pool: Pool | null = null;
  private closed = false;
  /**
   * Track every open BatchedQuery client so adapter.close() can release
   * them before pool.end() — otherwise pool.end() waits for checked-out
   * clients forever (CRITICAL #3).
   */
  private openCursors: Set<OpenCursorRecord> = new Set();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly password: string,
  ) {}

  async connect(): Promise<void> {
    if (this.pool) return;
    this.pool = new Pool({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.password,
      database: this.cfg.database,
      max: 1,
      ssl: pgSslOptions(this.cfg),
      connectionTimeoutMillis: 10_000,
    });
    const probe = await this.pool.connect();
    try {
      await probe.query("SELECT 1");
    } finally {
      probe.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Cleanup mọi cursor còn open (CRITICAL #3 — close() với cursor open
    // phải resolve < 5s, không treo ở pool.end).
    if (this.openCursors.size > 0) {
      const records = Array.from(this.openCursors);
      this.openCursors.clear();
      // Race: mỗi cursor ta ROLLBACK + release(true) để giải phóng client
      // về pool ngay, song song.
      await Promise.race([
        Promise.all(
          records.map(async (rec) => {
            try {
              await rec.client.query("ROLLBACK").catch(() => undefined);
            } finally {
              try {
                rec.client.release(true);
              } catch {
                // ignore
              }
            }
          }),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (this.pool) {
      try {
        // Timeout guard: pg.Pool.end không nhận timeout option cho mọi phiên
        // bản, nên ta race với setTimeout. Sau khi đã cleanup cursor ở trên,
        // pool.end() sẽ resolve nhanh.
        await Promise.race([
          this.pool.end(),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("PostgresAdapter.close: pool.end timeout")),
              3_000,
            ),
          ),
        ]);
      } catch {
        // ignore — adapter đã đóng về mặt logic.
      }
      this.pool = null;
    }
  }

  async testConnection(): Promise<void> {
    if (!this.pool) {
      await this.connect();
      return;
    }
    const c = await this.pool.connect();
    try {
      await c.query("SELECT 1");
    } finally {
      c.release();
    }
  }

  async runQuery(sql: string): Promise<RunResult> {
    if (!this.pool) throw new Error("PostgresAdapter: connect() chưa được gọi");

    const statements = splitStatements(sql);

    const singleSelect =
      statements.length === 1 &&
      /^\s*SELECT\b/i.test(statements[0].text) &&
      !statements[0].text.includes(";");

    if (singleSelect) {
      const batched = await this.openCursorForStatement(statements[0].text);
      return { results: [], batched };
    }

    const results: QueryResult[] = [];
    for (const stmt of statements) {
      const text = stmt.text.trim();
      if (text.length === 0) continue;
      const t0 = Date.now();
      const r = await this.pool.query(text);
      const durationMs = Date.now() - t0;
      const columns = r.fields.map((f) => f.name);
      results.push({
        columns,
        rows: rowsAsArrays(r.rows, columns),
        rowCount: r.rowCount ?? null,
        // Populate commandTag từ pg result (IMPORTANT #5).
        commandTag: r.command ?? undefined,
        durationMs,
      });
    }
    return { results };
  }

  // ---- Metadata -------------------------------------------------------------

  async listSchemas(includeSystem: boolean): Promise<SchemaInfo[]> {
    const filter = includeSystem
      ? ""
      : `WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`;
    const r = await this.query<{ nspname: string }>(
      `SELECT nspname
         FROM pg_namespace
        ${filter}
        ORDER BY nspname`,
    );
    return r.rows.map((row) => ({ name: row.nspname }));
  }

  async listTables(schema: string = "public"): Promise<TableInfo[]> {
    const r = await this.query<{ table_name: string; table_schema: string }>(
      `SELECT table_name, table_schema
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      [schema],
    );
    return r.rows.map((row) => ({
      name: row.table_name,
      schema: row.table_schema,
    }));
  }

  async listViews(schema: string = "public"): Promise<ViewInfo[]> {
    const r = await this.query<{ table_name: string; table_schema: string }>(
      `SELECT table_name, table_schema
         FROM information_schema.views
         WHERE table_schema = $1
         ORDER BY table_name`,
      [schema],
    );
    return r.rows.map((row) => ({
      name: row.table_name,
      schema: row.table_schema,
    }));
  }

  async listRoutines(schema: string = "public"): Promise<RoutineInfo[]> {
    const r = await this.query<{
      proname: string;
      prokind: string;
      nspname: string;
    }>(
      `SELECT p.proname, p.prokind, n.nspname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1
           AND p.prokind IN ('f', 'p')
           AND n.oid <> 11
         ORDER BY p.proname`,
      [schema],
    );
    return r.rows.map((row) => ({
      name: row.proname,
      kind: row.prokind === "f" ? "function" : "procedure",
      schema: row.nspname,
    }));
  }

  async listColumns(
    table: string,
    schema: string = "public",
  ): Promise<ColumnInfo[]> {
    const colsRes = await this.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      format_type: string;
    }>(
      `SELECT c.column_name,
              c.data_type,
              c.udt_name,
              c.is_nullable,
              pg_catalog.format_type(a.atttypid, a.atttypmod) AS format_type
         FROM information_schema.columns c
         JOIN pg_attribute a
           ON a.attrelid =
              (quote_ident($1) || '.' || quote_ident($2))::regclass
          AND a.attname = c.column_name
          AND a.attnum > 0
          AND NOT a.attisdropped
         WHERE c.table_schema = $1 AND c.table_name = $2
         ORDER BY c.ordinal_position`,
      [schema, table],
    );

    const pkRes = await this.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a
           ON a.attrelid =
              (quote_ident($1) || '.' || quote_ident($2))::regclass
          AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid =
              (quote_ident($1) || '.' || quote_ident($2))::regclass
           AND i.indisprimary`,
      [schema, table],
    );
    const pkCols = new Set(pkRes.rows.map((row) => row.column_name));

    return colsRes.rows.map((row) => {
      const dataType =
        row.format_type && row.format_type.length > 0
          ? row.format_type
          : row.udt_name || row.data_type;
      const info: ColumnInfo = {
        name: row.column_name,
        dataType,
        nullable: row.is_nullable === "YES",
      };
      if (pkCols.has(row.column_name)) info.isPrimaryKey = true;
      return info;
    });
  }

  async estimateTableRows(
    schema: string,
    table: string,
  ): Promise<number | null> {
    try {
      const res = await this.query<{ row_estimate: string | number }>(
        `SELECT c.reltuples::bigint AS row_estimate
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2
            AND c.relkind IN ('r','p')`,
        [schema, table],
      );
      if (res.rows.length === 0) return null;
      const raw = res.rows[0].row_estimate;
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (!Number.isFinite(value) || value < 0) return null;
      return value;
    } catch {
      return null;
    }
  }

  // ---- Helpers --------------------------------------------------------------

  private async query<T = any>(
    sql: string,
    params: any[] = [],
  ): Promise<{ rows: T[] }> {
    if (!this.pool) throw new Error("PostgresAdapter: connect() chưa được gọi");
    const r = await this.pool.query(sql, params);
    return { rows: r.rows as T[] };
  }

  /**
   * Mở client, BEGIN, DECLARE cursor với unique name, lấy columns (từ FETCH 0)
   * rồi trả BatchedQuery. Cursor KHÔNG bị re-execute — server chỉ stream rows
   * qua FETCH FORWARD n lần.
   *
   * CRITICAL #1 fix: toàn bộ lifecycle BEGIN → DECLARE → FETCH 0 wrap trong
   * try/catch; bất kỳ lỗi nào → ROLLBACK + release(true) rồi rethrow. Pool
   * max=1 phải luôn trở về trạng thái usable.
   */
  private async openCursorForStatement(sql: string): Promise<BatchedQuery> {
    if (!this.pool) throw new Error("PostgresAdapter: connect() chưa được gọi");
    const pool = this.pool;
    const client: PoolClient = await pool.connect();
    const cursorName = `vsdb_c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    // Track this cursor so adapter.close() can release it (CRITICAL #3).
    const record: OpenCursorRecord = {
      client,
      cursorName,
      closed: Promise.resolve(),
    };
    this.openCursors.add(record);

    let state: CursorState = "open";
    let backendPid: number | null = null;

    const releaseClient = (destroy: boolean): void => {
      try {
        client.release(destroy);
      } catch {
        // ignore
      }
      this.openCursors.delete(record);
    };

    const finalize = async (destroy: boolean): Promise<void> => {
      if (state === "closed" || state === "eof") {
        releaseClient(destroy);
        return;
      }
      state = "closed";
      try {
        await client.query(`CLOSE "${cursorName}"`).catch(() => undefined);
      } catch {
        // ignore
      }
      try {
        await client.query("COMMIT").catch(async () => {
          await client.query("ROLLBACK").catch(() => undefined);
        });
      } catch {
        // ignore
      }
      releaseClient(destroy);
    };

    try {
      await client.query("BEGIN");
      await client.query(`DECLARE "${cursorName}" CURSOR FOR ${sql}`);
      const pid = (client as unknown as { processID?: number }).processID;
      backendPid = typeof pid === "number" ? pid : null;

      const colRes = await client.query({
        text: `FETCH 0 FROM "${cursorName}"`,
      });
      const columns = colRes.fields.map((f) => f.name);

      const fetchBatch = async (): Promise<any[][] | null> => {
        if (state === "eof") return null;
        // CRITICAL #4: fetchBatch after cancel/close returns null (not throw).
        if (state === "closed" || state === "error") return null;
        try {
          const r = await client.query({
            text: `FETCH ${DEFAULT_BATCH_SIZE} FROM "${cursorName}"`,
            rowMode: "array",
          });
          const rows = r.rows as any[][];
          if (rows.length === 0) {
            state = "eof";
            await finalize(false);
            return null;
          }
          // FETCH trả ít hơn số row yêu cầu → cursor đã cạn. Đóng NGAY
          // (không đợi lần fetch rỗng kế tiếp) — pool max=1 cần client
          // trả về cho statement sau, nếu không mọi pool.query kế tiếp
          // xếp hàng connectionTimeoutMillis rồi fail "timeout exceeded
          // when trying to connect" (SELECT < 500 rows là case phổ biến).
          if (rows.length < DEFAULT_BATCH_SIZE) {
            state = "eof";
            await finalize(false);
          }
          return rows;
        } catch (err) {
          state = "error";
          try {
            await client.query("ROLLBACK").catch(() => undefined);
          } catch {
            // ignore
          }
          releaseClient(true);
          throw err;
        }
      };

      const cancel = async (): Promise<void> => {
        if (state === "closed" || state === "eof") return;
        state = "closed";

        // CRITICAL #2 fix: dùng DEDICATED one-off Client để gọi
        // pg_cancel_backend — KHÔNG dùng pool max=1 (đang bị cursor giữ
        // → request xếp hàng 10s rồi nuốt exception).
        if (backendPid !== null) {
          await this.cancelBackendViaDedicatedClient(backendPid);
        }
        try {
          await client.query("ROLLBACK").catch(() => undefined);
        } catch {
          // ignore
        }
        releaseClient(true);
      };

      const close = async (): Promise<void> => {
        if (state === "closed" || state === "eof") return;
        await finalize(false);
      };

      return {
        columns,
        fetchBatch,
        cancel,
        close,
      };
    } catch (err) {
      // CRITICAL #1: bất kỳ lỗi nào trong BEGIN/DECLARE/FETCH 0 → cleanup
      // rồi rethrow. Nếu không release ở đây, pool max=1 bị wedge vĩnh
      // viễn và mọi runQuery sau timeout.
      state = "error";
      try {
        await client.query("ROLLBACK").catch(() => undefined);
      } catch {
        // ignore
      }
      releaseClient(true);
      throw err;
    }
  }

  /**
   * CRITICAL #2 fix: gọi pg_cancel_backend(pid) qua một Client riêng (one-off,
   * dedicated connection) — KHÔNG qua pool.max=1. Lý do: pool đang có client
   * duy nhất bị cursor giữ; gọi pool.query sẽ xếp hàng 10s rồi timeout
   * (bị nuốt bởi catch { ignore }). Dedicated Client mở connection mới,
   * gửi cancel, đóng → server pg_cancel_backend chạy được ngay.
   *
   * Nếu dedicated connection cũng fail (server down, network), ignore —
   * việc release(true) ở caller vẫn giải phóng client về pool.
   */
  private async cancelBackendViaDedicatedClient(pid: number): Promise<void> {
    const dedicated = new Client({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.password,
      database: this.cfg.database,
      ssl: pgSslOptions(this.cfg),
      connectionTimeoutMillis: 5_000,
    });
    try {
      await dedicated.connect();
      await dedicated.query("SELECT pg_cancel_backend($1)", [pid]);
    } catch {
      // ignore — best-effort.
    } finally {
      try {
        await dedicated.end();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Map ResolvedSsl → pg ssl option. `ssl: false` = không TLS. verify-ca cần
 * checkServerIdentity noop vì pg (node tls) kiểm hostname SAN mặc định khi
 * rejectUnauthorized — cert Cloud SQL/RDS proxy mang DNS instance, host local.
 */
function pgSslOptions(cfg: ConnectionConfig): false | { [k: string]: unknown } {
  const ssl = resolveSslOptions(cfg);
  if (!ssl) return false;
  return {
    ...(ssl.ca !== undefined ? { ca: ssl.ca } : {}),
    ...(ssl.cert !== undefined ? { cert: ssl.cert } : {}),
    ...(ssl.key !== undefined ? { key: ssl.key } : {}),
    rejectUnauthorized: ssl.rejectUnauthorized,
    ...(ssl.checkHostname
      ? {}
      : { checkServerIdentity: () => undefined }),
  };
}

function rowsAsArrays(rows: any[], columns: string[]): any[][] {
  return rows.map((row) => {
    if (Array.isArray(row)) return row;
    const out: any[] = new Array(columns.length);
    for (let i = 0; i < columns.length; i++) {
      out[i] = row[columns[i]];
    }
    return out;
  });
}