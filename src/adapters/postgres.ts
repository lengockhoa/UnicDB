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
// cancel: BatchedQuery.cancel → SELECT pg_cancel_backend(pid) + CLOSE.
// Metadata: information_schema + pg_proc.
import { Pool, PoolClient } from "pg";
import type { ConnectionConfig } from "../config/types";
import type {
  BatchedQuery,
  ColumnInfo,
  DbAdapter,
  QueryResult,
  RoutineInfo,
  RunResult,
  TableInfo,
  ViewInfo,
} from "./types";
import { splitStatements } from "../core/statementParser";

const DEFAULT_BATCH_SIZE = 500;

export class PostgresAdapter implements DbAdapter {
  private pool: Pool | null = null;
  private closed = false;

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
      ssl: this.cfg.ssl ? { rejectUnauthorized: false } : false,
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
    if (this.pool) {
      await this.pool.end();
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
        commandTag: undefined,
        durationMs,
      });
    }
    return { results };
  }

  // ---- Metadata -------------------------------------------------------------

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
   */
  private async openCursorForStatement(sql: string): Promise<BatchedQuery> {
    if (!this.pool) throw new Error("PostgresAdapter: connect() chưa được gọi");
    const client: PoolClient = await this.pool.connect();
    // Pool max=1 → lấy client duy nhất. Nếu muốn hỗ trợ nhiều cursor song song,
    // pool max cần > 1.

    // Tên cursor unique để tránh đụng độ nếu có > 1 statement trong session.
    const cursorName = `vsdb_c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    // Bắt đầu transaction. Cursor chỉ tồn tại trong transaction.
    await client.query("BEGIN");

    // Lấy columns bằng cách wrap SQL với count(*) giả: ta tách SQL để inject
    // wrapper trả về cùng shape columns. Đơn giản nhất: dùng FETCH 0 với SQL
    // gốc được bọc trong subquery → server trả về metadata đầy đủ.
    // Tuy nhiên cursor API yêu cầu câu lệnh DUY NHẤT — không được có `;`.
    // Vì vậy ta không dùng DECLARE + EXPLAIN; ta parse SQL đơn giản.
    //
    // Cách an toàn: ta DECLARE trực tiếp SQL, sau đó FETCH 0 để lấy column
    // metadata (Postgres trả fields[] rỗng nếu 0 rows, NHƯNG fields luôn
    // populated bởi ParseComplete trước khi DataRow). Thực nghiệm: pg JS
    // trả fields[] kể cả khi 0 rows. Ta dùng FETCH 0 để xác nhận columns.
    await client.query(`DECLARE "${cursorName}" CURSOR FOR ${sql}`);

    const backendPid = (client as unknown as { processID?: number })
      .processID;

    const colRes = await client.query({
      text: `FETCH 0 FROM "${cursorName}"`,
    });
    const columns = colRes.fields.map((f) => f.name);

    let state: "open" | "eof" | "closed" = "open";

    const cleanup = async (destroyClient: boolean): Promise<void> => {
      if (state === "closed") return;
      state = "closed";
      // Bỏ qua lỗi — transaction có thể đã được commit/rollback.
      try {
        await client.query(`CLOSE "${cursorName}"`);
      } catch {
        // ignore
      }
      try {
        await client.query("COMMIT");
      } catch {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
      }
      try {
        client.release(destroyClient);
      } catch {
        // ignore
      }
    };

    const adapter: BatchedQuery = {
      columns,
      fetchBatch: async (): Promise<any[][] | null> => {
        if (state === "eof") return null;
        if (state === "closed") {
          throw new Error("PostgresAdapter: cursor đã đóng");
        }
        try {
          const r = await client.query({
            text: `FETCH ${DEFAULT_BATCH_SIZE} FROM "${cursorName}"`,
            rowMode: "array",
          });
          const rows = r.rows as any[][];
          if (rows.length === 0) {
            state = "eof";
            await cleanup(false);
            return null;
          }
          return rows;
        } catch (err) {
          state = "closed";
          try {
            await client.query("ROLLBACK");
          } catch {
            // ignore
          }
          try {
            client.release(true);
          } catch {
            // ignore
          }
          throw err;
        }
      },
      cancel: async (): Promise<void> => {
        if (state === "closed") return;
        state = "closed";
        if (backendPid && this.pool) {
          try {
            await this.pool.query("SELECT pg_cancel_backend($1)", [backendPid]);
          } catch {
            // ignore — connection có thể đã đóng.
          }
        }
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
        try {
          client.release(true);
        } catch {
          // ignore
        }
      },
      close: async (): Promise<void> => {
        if (state === "closed") return;
        await cleanup(false);
      },
    };

    return adapter;
  }
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