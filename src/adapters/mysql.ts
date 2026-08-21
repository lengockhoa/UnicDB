import mysql, {
  type FieldPacket,
  type Pool as PromisePool,
} from "mysql2/promise";
import type { Connection as CoreConnection, Query } from "mysql2";
import type { ConnectionConfig } from "../config/types";
import { splitStatements } from "../core/statementParser";
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

const BATCH_SIZE = 500;

type MySqlRow = any[];

type MySqlQueryResult = {
  rows: any;
  fields: FieldPacket[] | undefined;
};

type StreamState = "open" | "eof" | "closed" | "error";

/**
 * MySQL/MariaDB adapter.
 *
 * mysql2's promise wrapper does not expose Query.stream(), so the promise pool
 * is used for its public API and its underlying core pool is used for the one
 * SELECT stream. A single connection is deliberately held by a stream so a
 * cancelled query can be stopped by destroying that connection.
 */
export class MySqlAdapter implements DbAdapter {
  private pool: PromisePool | null = null;
  private closed = false;

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly password: string,
  ) {}

  async connect(): Promise<void> {
    if (this.pool) return;
    this.closed = false;

    const pool = mysql.createPool({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.password,
      database: this.cfg.database,
      connectionLimit: 1,
      waitForConnections: true,
      queueLimit: 0,
      connectTimeout: 10_000,
      // The adapter splits scripts itself, so server-side multi-statements are
      // intentionally not enabled.
      multipleStatements: false,
      ...(this.cfg.ssl ? { ssl: {} } : {}),
    });
    this.pool = pool;

    try {
      const connection = await pool.getConnection();
      try {
        await connection.ping();
      } finally {
        connection.release();
      }
    } catch (error) {
      await pool.end().catch(() => undefined);
      this.pool = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.end();
  }

  async testConnection(): Promise<void> {
    if (!this.pool) {
      await this.connect();
      return;
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.ping();
    } finally {
      connection.release();
    }
  }

  async runQuery(sql: string): Promise<RunResult> {
    if (!this.pool) {
      throw new Error("MySqlAdapter: connect() chưa được gọi");
    }

    const statements = splitStatements(sql);
    if (statements.length === 0) return { results: [] };

    const singleSelect =
      statements.length === 1 &&
      /^\s*SELECT\b/i.test(statements[0].text) &&
      !statements[0].text.includes(";");

    if (singleSelect) {
      const batched = await this.openStreamingQuery(statements[0].text);
      return { results: [], batched };
    }

    const results: QueryResult[] = [];
    for (const statement of statements) {
      const text = statement.text.trim();
      if (!text) continue;
      results.push(await this.executeText(text));
    }
    return { results };
  }

  async listTables(schema = this.cfg.database): Promise<TableInfo[]> {
    const result = await this.query(
      `SELECT table_name AS name, table_schema AS \`schema\`
         FROM information_schema.tables
         WHERE table_schema = ? AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      [schema],
    );
    return this.mapRows(result, (row) => ({
      name: String(row.name),
      schema: String(row.schema),
    }));
  }

  async listViews(schema = this.cfg.database): Promise<ViewInfo[]> {
    const result = await this.query(
      `SELECT table_name AS name, table_schema AS \`schema\`
         FROM information_schema.views
         WHERE table_schema = ?
         ORDER BY table_name`,
      [schema],
    );
    return this.mapRows(result, (row) => ({
      name: String(row.name),
      schema: String(row.schema),
    }));
  }

  async listRoutines(schema = this.cfg.database): Promise<RoutineInfo[]> {
    const result = await this.query(
      `SELECT routine_name AS name,
              routine_type AS type,
              routine_schema AS \`schema\`
         FROM information_schema.routines
         WHERE routine_schema = ?
           AND routine_type IN ('FUNCTION', 'PROCEDURE')
         ORDER BY routine_name`,
      [schema],
    );
    return this.mapRows(result, (row) => ({
      name: String(row.name),
      kind: String(row.type).toUpperCase() === "PROCEDURE"
        ? "procedure"
        : "function",
      schema: String(row.schema),
    }));
  }

  async listColumns(
    table: string,
    schema = this.cfg.database,
  ): Promise<ColumnInfo[]> {
    const columns = await this.query(
      `SELECT column_name AS name,
              data_type AS dataType,
              is_nullable AS isNullable
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
      [schema, table],
    );
    const primaryKeys = await this.query(
      `SELECT column_name AS name
         FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ?
           AND index_name = 'PRIMARY'
         ORDER BY seq_in_index`,
      [schema, table],
    );
    const primaryKeyNames = new Set(
      this.mapRows(primaryKeys, (row) => String(row.name)),
    );

    return this.mapRows(columns, (row) => {
      const info: ColumnInfo = {
        name: String(row.name),
        dataType: String(row.dataType),
        nullable: String(row.isNullable).toUpperCase() === "YES",
      };
      if (primaryKeyNames.has(info.name)) info.isPrimaryKey = true;
      return info;
    });
  }

  private async executeText(sql: string): Promise<QueryResult> {
    const result = await this.query(sql);
    const columns = result.fields?.map((field) => field.name) ?? [];
    return {
      columns,
      rows: this.rowsAsArrays(result.rows, result.fields, columns),
      rowCount: this.resultRowCount(result.rows),
      durationMs: result.durationMs,
    };
  }

  private async query(
    sql: string,
    values: any[] = [],
  ): Promise<MySqlQueryResult & { durationMs: number }> {
    if (!this.pool) {
      throw new Error("MySqlAdapter: connect() chưa được gọi");
    }
    const startedAt = Date.now();
    const [rows, fields] = await this.pool.query(sql, values);
    return { rows, fields, durationMs: Date.now() - startedAt };
  }

  private async openStreamingQuery(sql: string): Promise<BatchedQuery> {
    if (!this.pool) {
      throw new Error("MySqlAdapter: connect() chưa được gọi");
    }

    const promiseConnection = await this.pool.getConnection();
    let coreQuery: Query;
    try {
      // Query.stream() is part of mysql2's callback/core API, not its promise
      // wrapper. rowsAsArray gives the grid the same array contract as pg.
      const coreConnection = promiseConnection.connection as unknown as CoreConnection;
      // mysql2's `timeout` arms a query-level timer that aborts the request.
      // For long-running streaming SELECTs (load-more across 100k+ rows) this
      // would kill the stream even while data is flowing. Disable the timer;
      // cancellation goes through stream.destroy() / connection.destroy().
      coreQuery = coreConnection.query({
        sql,
        rowsAsArray: true,
        timeout: 0,
      });
    } catch (error) {
      promiseConnection.release();
      throw error;
    }

    // Use the default stream backpressure; rowsAsArray gives the grid the same
    // array contract as pg.
    const stream = coreQuery.stream();
    const buffer: MySqlRow[] = [];
    const firstFields = new Promise<void>((resolve, reject) => {
      stream.once("fields", (fields: FieldPacket[]) => {
        columns = fields.map((field) => field.name);
        resolve();
      });
      stream.once("error", reject);
    });
    const waiters: Array<{
      resolve: (rows: MySqlRow[] | null) => void;
      reject: (error: Error) => void;
    }> = [];
    let columns: string[] = [];
    let state: StreamState = "open";
    let paused = false;
    let streamDone = false;
    let released = false;
    let lastError: Error | undefined;

    const releaseConnection = (): void => {
      if (released) return;
      released = true;
      promiseConnection.release();
    };

    const destroyConnection = (): void => {
      if (released) return;
      released = true;
      promiseConnection.destroy();
    };

    const closeStream = (): void => {
      if (state === "closed" || state === "eof") return;
      state = "closed";
      try {
        stream.destroy();
      } catch {
        // The underlying query is destroyed below when cancellation is used.
      }
      destroyConnection();
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.resolve(null);
      }
    };

    const deliver = (): void => {
      if (state === "error" || state === "closed") return;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        if (buffer.length >= BATCH_SIZE) {
          const batch = buffer.splice(0, BATCH_SIZE);
          if (paused) {
            paused = false;
            stream.resume();
          }
          waiter.resolve(batch);
          continue;
        }
        if (buffer.length > 0 && streamDone) {
          // Final partial batch — deliver the buffered rows BEFORE the eof
          // signal so callers never lose them. EOF will be handed to the next
          // fetchBatch() call when buffer is empty and streamDone is true.
          const batch = buffer.splice(0, buffer.length);
          waiter.resolve(batch);
          continue;
        }
        if (!streamDone) {
          // No data and no EOF yet; put this waiter back and stop.
          waiters.unshift(waiter);
          break;
        }
        state = "eof";
        releaseConnection();
        waiter.resolve(null);
        closeStream();
      }
    };

    const fail = (error: Error): void => {
      if (state === "closed" || state === "eof") return;
      state = "error";
      lastError = error;
      buffer.length = 0;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.reject(error);
      }
      destroyConnection();
    };

    stream.on("fields", (fields: FieldPacket[]) => {
      columns = fields.map((field) => field.name);
    });
    stream.on("data", (row: MySqlRow) => {
      if (state === "closed" || state === "eof" || state === "error") return;
      buffer.push(Array.isArray(row) ? row : [row]);
      if (buffer.length >= BATCH_SIZE) {
        paused = true;
        stream.pause();
      }
      deliver();
    });
    stream.on("end", () => {
      streamDone = true;
      deliver();
    });
    stream.on("error", (error: Error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });

    const fetchBatch = (): Promise<MySqlRow[] | null> => {
      if (state === "eof" || state === "closed") return Promise.resolve(null);
      if (state === "error") {
        return Promise.reject(
          lastError ?? new Error("MySQL query stream failed"),
        );
      }
      if (buffer.length > 0) {
        const batch = buffer.splice(0, Math.min(BATCH_SIZE, buffer.length));
        if (paused) {
          paused = false;
          stream.resume();
        }
        return Promise.resolve(batch);
      }
      if (streamDone) {
        state = "eof";
        releaseConnection();
        return Promise.resolve(null);
      }
      return new Promise<MySqlRow[] | null>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    };

    const adapter: BatchedQuery = {
      get columns() {
        return columns;
      },
      fetchBatch: () => fetchBatch(),
      cancel: async () => {
        if (state === "closed" || state === "eof") return;
        closeStream();
      },
      close: async () => {
        closeStream();
      },
    };

    // Column metadata can arrive asynchronously after openStreamingQuery() is
    // called. Wait for the actual `fields` event before exposing the contract
    // to the caller; otherwise a tiny SELECT could briefly advertise [].
    try {
      await firstFields;
    } catch (error) {
      state = "error";
      stream.destroy();
      destroyConnection();
      throw error instanceof Error ? error : new Error(String(error));
    }
    return adapter;
  }

  private mapRows<T>(
    result: { rows: any },
    mapper: (row: any) => T,
  ): T[] {
    if (!Array.isArray(result.rows)) return [];
    return result.rows.map((row) => mapper(this.rowAsObject(row)));
  }

  private rowAsObject(row: any): any {
    if (row && !Array.isArray(row) && typeof row === "object") return row;
    return row;
  }

  private rowsAsArrays(rows: any, fields?: FieldPacket[], columns?: string[]): any[][] {
    if (!Array.isArray(rows)) return [];
    if (rows.length === 0) return [];
    if (Array.isArray(rows[0])) return rows as any[][];
    const names = fields?.map((field) => field.name) ?? columns ?? [];
    if (names.length === 0) return rows.map((row) => [row]);
    return rows.map((row) => names.map((name) => row?.[name]));
  }

  private resultRowCount(rows: any): number | null {
    if (!Array.isArray(rows)) {
      if (rows && typeof rows === "object" && "affectedRows" in rows) {
        return Number(rows.affectedRows) || 0;
      }
      return null;
    }
    return rows.length;
  }
}
