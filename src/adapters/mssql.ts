import { Connection, Request, TYPES } from "tedious";
import type { ConnectionConfig } from "../config/types";
import { resolveSslOptions } from "../core/sslOptions";
import { splitStatements } from "../core/statementParser";
import { quoteIdent } from "../core/saveStatements";
import {
  NotImplementedError,
  type BatchedQuery,
  type ColumnInfo,
  type DbAdapter,
  type QueryResult,
  type RoutineInfo,
  type SchemaInfo,
  type RunResult,
  type TableInfo,
  type ViewInfo,
  type TableDetail,
} from "./types";

const BATCH_SIZE = 500;

type MssqlColumn = {
  colName?: string;
  name?: string;
  [key: string]: any;
};

/**
 * TASK-002 — typed parameter bound into a tedious Request via
 * `addParameter`, so values never get interpolated into the SQL text.
 * `null` values keep their declared type; tedious serializes them as the
 * TDS NULL marker (tedious 18.x has no `TYPES.Null` export — declared type +
 * null value is the canonical way to send NULL).
 */
export type MssqlQueryParam = {
  name: string;
  type: (typeof TYPES)[keyof typeof TYPES];
  value: string | null;
};

type RequestState = "open" | "eof" | "cancelled" | "closed" | "error";
type BatchWaiter = {
  resolve: (rows: any[][] | null) => void;
  reject: (error: Error) => void;
};

/**
 * TASK-006 — server-side column sort as pure SQL composition (T-SQL dialect).
 *
 * Mirrors `getTableSortQuery` (src/adapters/postgres.ts) exactly: same 4-arg
 * signature, same `vsdb_sort` subquery wrap, same ASC/DESC whitelist — but
 * identifiers are quoted with T-SQL `[…]` brackets (embedded `]` doubled)
 * instead of Postgres double quotes, and the emitted `ORDER BY` is exactly
 * what T-SQL `OFFSET/FETCH` paging can attach to (see `buildPagedQuery`).
 *
 *   getTableSortQuery("SELECT * FROM t WHERE id>5", "", "name", "ASC")
 *     → SELECT * FROM (SELECT * FROM t WHERE id>5) vsdb_sort ORDER BY [name] ASC
 *
 * Injection safety: `column` is emitted as a single bracket-quoted identifier
 * (`]` doubled per T-SQL rules via `quoteIdent`), so a payload like
 * `name]; DROP TABLE users--` stays one inert identifier token. `direction`
 * is whitelist-normalized to ASC/DESC. `whereFromBar` (requery-bar filter)
 * is appended as the OUTER query's WHERE clause when non-empty — the
 * original SQL stays verbatim inside the subquery.
 *
 * Dispatch: `composeSortQuery("mssql", …)` in src/ui/queryComposer.ts
 * delegates here, and TASK-005's requery path is the live call site.
 */
export function getTableSortQuery(
  originalSql: string,
  whereFromBar: string,
  column: string,
  direction: "ASC" | "DESC",
): string {
  const inner = originalSql.trim();
  const quotedColumn = quoteIdent(column, "mssql");
  const dir = direction === "DESC" ? "DESC" : "ASC";
  const whereClause = whereFromBar.trim().length
    ? ` WHERE ${whereFromBar.trim()}`
    : "";
  return `SELECT * FROM (${inner}) vsdb_sort${whereClause} ORDER BY ${quotedColumn} ${dir}`;
}

/** SQL Server adapter. SELECTs are collected from tedious request row events. */
export class MsSqlAdapter implements DbAdapter {
  private connection: Connection | null = null;
  private connected = false;
  private closed = false;
  private connecting: Promise<void> | null = null;
  private readonly activeRequests = new Set<Request>();
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly password: string,
  ) {}

  async connect(): Promise<void> {
    if (this.connected && this.connection) return;
    if (this.connecting) return this.connecting;

    this.closed = false;
    const connection = this.createConnection();
    this.connection = connection;

    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        connection.removeListener("connect", onConnect);
        connection.removeListener("error", onError);
        this.clearConnection(connection);
        try {
          connection.close();
        } catch {
          // The failed connection may already be closed.
        }
        reject(error);
      };

      const onError = (error: Error): void => fail(error);

      const onConnect = (error?: Error): void => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }

        // Tedious emits `connect` after login, before the initial SQL phase has
        // completed. Only the `LoggedIn` state accepts requests, so wait for
        // that state rather than issuing a request immediately. The poll is
        // bounded by `connectTimeout` so a stalled handshake cannot hang the
        // caller forever.
        const deadline = Date.now() + 10_000;
        const waitForLoggedIn = (): void => {
          if (settled) return;
          const stateName = connection.state.name;
          if (stateName === "LoggedIn") {
            settled = true;
            connection.removeListener("connect", onConnect);
            connection.removeListener("error", onError);
            // Keep a no-op listener for network errors after login. Node's
            // EventEmitter otherwise throws those errors as uncaught.
            connection.on("error", () => undefined);
            this.connected = true;
            resolve();
            return;
          }
          if (stateName === "Final") {
            fail(new Error("Tedious connection closed before login completed"));
            return;
          }
          if (Date.now() >= deadline) {
            fail(
              new Error(
                "Tedious connection did not reach LoggedIn state within 10s",
              ),
            );
            return;
          }
          setTimeout(waitForLoggedIn, 5);
        };
        waitForLoggedIn();
      };

      connection.once("connect", onConnect);
      connection.once("error", onError);
      try {
        connection.connect();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }).finally(() => {
      this.connecting = null;
    });

    await this.connecting;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;

    // Tedious permits one request at a time. Cancel active requests before
    // closing so a later adapter can reuse this connection without a stale one.
    for (const request of this.activeRequests) {
      try {
        request.cancel();
      } catch {
        // Best-effort cancellation during shutdown.
      }
    }
    this.activeRequests.clear();

    const connection = this.connection;
    this.connection = null;
    if (connection) {
      try {
        connection.close();
      } catch {
        // close is best effort; Tedious closes asynchronously.
      }
    }
  }

  async testConnection(): Promise<void> {
    if (!this.connected || !this.connection) {
      await this.connect();
    }
    await this.execute("SELECT 1 AS one");
  }

  async runQuery(sql: string): Promise<RunResult> {
    if (!this.connected || !this.connection) {
      throw new Error("MsSqlAdapter: connect() chưa được gọi");
    }

    // Finding #3 (review fix round C): must pass the real dialect — without
    // it, MSSQL's `GO` batch separator is never recognized and gets sent to
    // the server as SQL text ("Could not find stored procedure 'GO'").
    const statements = splitStatements(sql, "mssql");
    if (statements.length === 0) return { results: [] };

    const results: QueryResult[] = [];
    for (let index = 0; index < statements.length; index++) {
      const text = statements[index].text.trim();
      if (!text) continue;

      const isLast = index === statements.length - 1;
      const isSingleSelect =
        statements.length === 1 &&
        /^\s*(SELECT|WITH)\b/i.test(text) &&
        !text.includes(";");

      // A final SELECT in a script is streamed; earlier DDL/DML statements
      // are returned in order. Each statement has its own request.
      if (isLast && isSingleSelect) {
        return {
          results,
          batched: await this.openStreamingQuery(text),
        };
      }

      results.push(await this.execute(text));
    }
    return { results };
  }

  async listSchemas(includeSystem: boolean): Promise<SchemaInfo[]> {
    const result = await this.execute(
      `SELECT s.name AS name
         FROM sys.schemas s
        ORDER BY s.name`,
    );
    const schemas = result.rows.map((row) => ({ name: String(row[0]) }));
    if (includeSystem) return schemas;
    return schemas.filter(
      (s) =>
        s.name !== "sys" &&
        s.name !== "INFORMATION_SCHEMA" &&
        s.name !== "guest" &&
        !s.name.startsWith("db_"),
    );
  }

  async listTables(schema = "dbo"): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT t.name AS name, s.name AS [schema]
         FROM sys.tables t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = @schema
        ORDER BY t.name`,
      [{ name: "schema", type: TYPES.NVarChar, value: schema }],
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      schema: String(row[1]),
    }));
  }

  async listViews(schema = "dbo"): Promise<ViewInfo[]> {
    const result = await this.execute(
      `SELECT v.name AS name, s.name AS [schema]
         FROM sys.views v
         JOIN sys.schemas s ON s.schema_id = v.schema_id
        WHERE s.name = @schema
        ORDER BY v.name`,
      [{ name: "schema", type: TYPES.NVarChar, value: schema }],
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      schema: String(row[1]),
    }));
  }

  async listRoutines(schema = "dbo"): Promise<RoutineInfo[]> {
    const result = await this.execute(
      `SELECT o.name AS name,
              CASE
                WHEN o.type = 'P' THEN 'procedure'
                WHEN o.type IN ('IF', 'TF', 'FN') THEN 'function'
                ELSE 'function'
              END AS kind,
              s.name AS [schema]
         FROM sys.objects o
         JOIN sys.schemas s ON s.schema_id = o.schema_id
         JOIN sys.sql_modules m ON m.object_id = o.object_id
        WHERE s.name = @schema
          AND o.type IN ('P', 'IF', 'TF', 'FN')
        ORDER BY o.name`,
      [{ name: "schema", type: TYPES.NVarChar, value: schema }],
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      kind: String(row[1]).toLowerCase() === "procedure"
        ? "procedure"
        : "function",
      schema: String(row[2]),
    }));
  }

  /**
   * D6 fix (cost only — see PLAN §3.9 scope note) — one round trip, zero
   * correlated `EXISTS` subqueries. The old query ran `EXISTS (SELECT 1
   * FROM sys.indexes ⋈ sys.index_columns WHERE ...)` PER COLUMN ROW; this
   * replaces it with a single `LEFT JOIN` against the PK's index_columns so
   * every column's PK flag comes back from the same query. TASK-002 binds
   * schema/table as typed NVarChar parameters instead of `this.literal()`
   * interpolation.
   */
  async listColumns(
    table: string,
    schema = "dbo",
  ): Promise<ColumnInfo[]> {
    const result = await this.execute(
      `SELECT c.name AS name,
              ty.name AS dataType,
              c.is_nullable AS nullable,
              CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey
         FROM sys.tables t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.columns c ON c.object_id = t.object_id
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
         LEFT JOIN (
           SELECT ic.object_id, ic.column_id
             FROM sys.indexes i
             JOIN sys.index_columns ic
               ON ic.object_id = i.object_id
              AND ic.index_id = i.index_id
            WHERE i.is_primary_key = 1
         ) pk ON pk.object_id = t.object_id AND pk.column_id = c.column_id
        WHERE s.name = @schema
          AND t.name = @table
        ORDER BY c.column_id`,
      [
        { name: "schema", type: TYPES.NVarChar, value: schema },
        { name: "table", type: TYPES.NVarChar, value: table },
      ],
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      dataType: String(row[1]),
      nullable: Boolean(Number(row[2])),
      ...(Number(row[3]) === 1 ? { isPrimaryKey: true } : {}),
    }));
  }

  async listTableDetail(
    _schema: string,
    _table: string,
  ): Promise<TableDetail> {
    // SQL Server adapter does not implement table-detail introspection
    // (TASK-005 wires only Postgres; the editor guards driver === "postgres"
    // before calling). Throw to satisfy the DbAdapter contract.
    throw new NotImplementedError("mssql");
  }
  async listRoutineParams(
    _schema: string,
    _routine: string,
  ): Promise<Array<{ name: string | null; dataType: string }>> {
    throw new NotImplementedError("mssql");
  }

  async estimateTableRows(
    schema: string,
    table: string,
  ): Promise<number | null> {
    try {
      const result = await this.execute(
        `SELECT SUM(p.rows) AS row_count
           FROM sys.partitions p
           JOIN sys.tables t ON t.object_id = p.object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id
          WHERE s.name = @schema
            AND t.name = @table
            AND p.index_id IN (0, 1)`,
        [
          { name: "schema", type: TYPES.NVarChar, value: schema },
          { name: "table", type: TYPES.NVarChar, value: table },
        ],
      );
      if (result.rows.length === 0) return null;
      const raw = result.rows[0][0];
      if (raw === null || raw === undefined) return null;
      const value = typeof raw === "string" ? Number(raw) : Number(raw);
      if (!Number.isFinite(value) || value < 0) return null;
      return value;
    } catch {
      return null;
    }
  }

  /**
   * D2 API — one round trip cho nhiều table (thay vì N lần
   * estimateTableRows()). TASK-002: mỗi table name là một parameter
   * `@tableN` (NVarChar) — không còn `this.literal()` interpolation. `tables`
   * rỗng → Map rỗng, KHÔNG issue query. Table drop giữa list và estimate →
   * không có trong `GROUP BY` result → OMIT khỏi Map, không throw.
   */
  async estimateTableRowsBatch(
    schema: string,
    tables: readonly string[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (tables.length === 0) return result;
    try {
      const tableParams: MssqlQueryParam[] = tables.map((table, index) => ({
        name: `table${index}`,
        type: TYPES.NVarChar,
        value: table,
      }));
      const inList = tableParams.map((p) => `@${p.name}`).join(", ");
      const res = await this.execute(
        `SELECT t.name AS name, SUM(p.rows) AS row_count
           FROM sys.partitions p
           JOIN sys.tables t ON t.object_id = p.object_id
           JOIN sys.schemas s ON s.schema_id = t.schema_id
          WHERE s.name = @schema
            AND t.name IN (${inList})
            AND p.index_id IN (0, 1)
          GROUP BY t.name`,
        [
          { name: "schema", type: TYPES.NVarChar, value: schema },
          ...tableParams,
        ],
      );
      for (const row of res.rows) {
        const name = String(row[0]);
        const raw = row[1];
        if (raw === null || raw === undefined) {
          result.set(name, null);
          continue;
        }
        const value = Number(raw);
        result.set(name, !Number.isFinite(value) || value < 0 ? null : value);
      }
    } catch {
      // best-effort — mirrors estimateTableRows.
    }
    return result;
  }

  private createConnection(): Connection {
    const ssl = resolveSslOptions(this.cfg);
    return new Connection({
      server: this.cfg.host,
      authentication: {
        type: "default",
        options: {
          userName: this.cfg.user,
          password: this.password,
        },
      },
      options: {
        port: this.cfg.port,
        database: this.cfg.database,
        // tedious không expose checkServerIdentity — verify-ca trên SQL Server
        // hành xử như verify-full (chain + hostname). require → trustServer.
        encrypt: ssl !== undefined,
        trustServerCertificate: ssl?.rejectUnauthorized === false,
        ...(ssl
          ? {
              cryptoCredentialsDetails: {
                ...(ssl.ca !== undefined ? { ca: [ssl.ca] } : {}),
                ...(ssl.cert !== undefined ? { cert: ssl.cert } : {}),
                ...(ssl.key !== undefined ? { key: ssl.key } : {}),
              },
            }
          : {}),
        useColumnNames: true,
        connectTimeout: 10_000,
        // Disable requestTimeout for streaming SELECTs — tedious arms the timer
        // at execSql and does not pause/resume it with request.pause(). For
        // load-more across very large result sets this would otherwise kill the
        // stream while rows are still flowing. Cancellation goes through
        // request.cancel(). For metadata/short queries callers can still bound
        // via the surrounding code path.
        requestTimeout: 0,
        cancelTimeout: 5_000,
        rowCollectionOnRequestCompletion: false,
        rowCollectionOnDone: false,
      },
    });
  }

  /**
   * Execute one statement and return the normalized query result.
   * TASK-002 — `params` are bound into the tedious Request via
   * `addParameter` (typed, never interpolated into the SQL text).
   */
  private async execute(
    sql: string,
    params?: MssqlQueryParam[],
  ): Promise<QueryResult> {
    return this.enqueue(() => this.runRequest(sql, params));
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let resolveNext!: () => void;
    const next = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    this.operationQueue = next;
    try {
      await previous;
      return await operation();
    } finally {
      resolveNext();
    }
  }

  private async runRequest(
    sql: string,
    params?: MssqlQueryParam[],
  ): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error("MsSqlAdapter: connect() chưa được gọi");
    }

    const startedAt = Date.now();
    const request = this.newRequest(sql, params);
    this.activeRequests.add(request);
    try {
      return await new Promise<QueryResult>((resolve, reject) => {
        let columns: MssqlColumn[] = [];
        const rows: any[][] = [];
        let rowCount: number | null = null;
        let settled = false;
        let requestError: Error | undefined;

        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          this.activeRequests.delete(request);
          if (error) {
            reject(error);
            return;
          }
          resolve({
            columns: columns.map((column, index) =>
              this.columnName(column, index),
            ),
            rows,
            rowCount,
            durationMs: Date.now() - startedAt,
          });
        };

        request.on("columnMetadata", (metadata) => {
          columns = this.columnsFromMetadata(metadata);
        });
        request.on("row", (row) => {
          rows.push(this.rowValues(row, columns));
        });
        const recordDone = (count?: number): void => {
          if (typeof count === "number") rowCount = count;
        };
        request.on("done", recordDone);
        request.on("doneInProc", recordDone);
        request.on("doneProc", recordDone);
        request.on("error", (error) => {
          requestError = error;
          finish(error);
        });
        request.on("requestCompleted", () => {
          if (requestError) finish(requestError);
        });

        // Request's callback is the final completion signal and receives the
        // row count even when no row events were emitted.
        request.callback = (error, count) => {
          if (typeof count === "number") rowCount = count;
          finish(error ?? undefined);
        };
        this.connection!.execSql(request);
      });
    } finally {
      this.activeRequests.delete(request);
    }
  }

  private newRequest(sql: string, params?: MssqlQueryParam[]): Request {
    const request = new Request(sql, () => undefined);
    // TASK-002 — typed parameter binding. `null` values keep their declared
    // type; tedious serializes them as the TDS NULL marker (tedious 18.x has
    // no `TYPES.Null` export — declared type + null value is the canonical
    // way to send NULL).
    for (const param of params ?? []) {
      request.addParameter(param.name, param.type, param.value);
    }
    return request;
  }

  private async openStreamingQuery(sql: string): Promise<BatchedQuery> {
    await this.enqueue(() => Promise.resolve());
    return this.runStreamingQuery(sql);
  }

  private async runStreamingQuery(sql: string): Promise<BatchedQuery> {
    if (!this.connection) {
      throw new Error("MsSqlAdapter: connect() chưa được gọi");
    }

    const request = this.newRequest(sql);
    this.activeRequests.add(request);
    const buffer: any[][] = [];
    const waiters: BatchWaiter[] = [];
    let readyBatch: any[][] | null = null;
    let columns: MssqlColumn[] = [];
    let state: RequestState = "open";
    let terminalError: Error | undefined;
    let settled = false;
    let paused = false;
    let queue: Promise<any[][] | null> = Promise.resolve(null);
    let resolveMetadataReady!: () => void;
    let rejectMetadataReady!: (error: Error) => void;
    const metadataReady = new Promise<void>((resolve, reject) => {
      resolveMetadataReady = resolve;
      rejectMetadataReady = reject;
    });

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) {
        state = "error";
        terminalError = error;
        buffer.length = 0;
        readyBatch = null;
        while (waiters.length > 0) {
          waiters.shift()!.reject(error);
        }
        if (paused) {
          paused = false;
          try {
            request.resume();
          } catch {
            // The request may already be in a terminal state.
          }
        }
        try {
          request.cancel();
        } catch {
          // Best effort.
        }
        return;
      }

      state = "eof";
      if (buffer.length > 0) {
        readyBatch = buffer.splice(0, Math.min(BATCH_SIZE, buffer.length));
      }
      if (paused) {
        paused = false;
        try {
          request.resume();
        } catch {
          // The request has already finished.
        }
      }
      if (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.resolve(readyBatch);
        readyBatch = null;
        while (waiters.length > 0) {
          waiters.shift()!.resolve(null);
        }
      }
    };

    request.on("columnMetadata", (metadata) => {
      columns = this.columnsFromMetadata(metadata);
      resolveMetadataReady();
    });
    request.on("row", (row) => {
      if (state !== "open" || settled) return;
      buffer.push(this.rowValues(row, columns));
      if (buffer.length < BATCH_SIZE) return;

      const batch = buffer.splice(0, BATCH_SIZE);
      if (waiters.length > 0) {
        waiters.shift()!.resolve(batch);
        if (paused) {
          paused = false;
          request.resume();
        }
      } else {
        readyBatch = batch;
        paused = true;
        request.pause();
      }
    });
    request.on("error", (error) => {
      rejectMetadataReady(error);
      finish(error);
    });
    request.on("requestCompleted", () => {
      if (!settled) finish(terminalError);
    });

    const takeBatch = (): Promise<any[][] | null> => {
      if (state === "cancelled" || state === "closed") {
        return Promise.resolve(null);
      }
      if (terminalError) return Promise.reject(terminalError);
      if (readyBatch !== null) {
        const batch = readyBatch;
        readyBatch = null;
        if (paused) {
          paused = false;
          try {
            request.resume();
          } catch {
            // Request is already finished.
          }
        }
        return Promise.resolve(batch);
      }
      if (state === "eof") return Promise.resolve(null);
      if (state === "error") {
        return Promise.reject(terminalError ?? new Error("MSSQL query failed"));
      }
      if (buffer.length >= BATCH_SIZE) {
        const batch = buffer.splice(0, Math.min(BATCH_SIZE, buffer.length));
        if (paused) {
          paused = false;
          request.resume();
        }
        return Promise.resolve(batch);
      }
      return new Promise<any[][] | null>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    };

    const columnName = (column: MssqlColumn, index: number): string =>
      this.columnName(column, index);
    const adapter: BatchedQuery = {
      get columns() {
        return columns.map((column, index) => columnName(column, index));
      },
      fetchBatch: () => {
        queue = queue.then(takeBatch, takeBatch);
        return queue;
      },
      cancel: async () => {
        if (state === "eof" || state === "closed" || state === "cancelled") {
          return;
        }
        state = "cancelled";
        settled = true;
        readyBatch = null;
        buffer.length = 0;
        while (waiters.length > 0) {
          waiters.shift()!.resolve(null);
        }
        if (paused) {
          paused = false;
          try {
            request.resume();
          } catch {
            // Request already completed.
          }
        }
        try {
          request.cancel();
        } catch {
          // The request may have completed between the state check and cancel.
        }
        this.activeRequests.delete(request);
      },
      close: async () => {
        if (state === "closed" || state === "eof") return;
        if (state === "open") {
          if (paused) {
            paused = false;
            try {
              request.resume();
            } catch {
              // Request already completed.
            }
          }
          try {
            request.cancel();
          } catch {
            // Best effort; see above.
          }
        }
        state = "closed";
        settled = true;
        readyBatch = null;
        buffer.length = 0;
        while (waiters.length > 0) {
          waiters.shift()!.resolve(null);
        }
        this.activeRequests.delete(request);
      },
    };

    request.callback = (error) => {
      if (error) finish(error);
      else finish();
    };
    this.connection.execSql(request);
    await metadataReady;
    return adapter;
  }

  private columnsFromMetadata(
    metadata: MssqlColumn[] | { [key: string]: MssqlColumn },
  ): MssqlColumn[] {
    return Array.isArray(metadata) ? metadata : Object.values(metadata);
  }

  private columnName(column: MssqlColumn, index: number): string {
    return String(column.colName ?? column.name ?? index);
  }

  private rowValues(row: any, columns: MssqlColumn[]): any[] {
    if (Array.isArray(row)) {
      return row.map((entry, index) => this.unwrapValue(entry, columns[index]));
    }
    if (!row || typeof row !== "object") return [row];

    return columns.map((column, index) => {
      const key = this.columnName(column, index);
      const entry = row[key] ?? row[String(index)];
      return this.unwrapValue(entry, column);
    });
  }

  private unwrapValue(entry: any, column?: MssqlColumn): any {
    if (entry && typeof entry === "object" && "value" in entry) {
      return entry.value;
    }
    if (column && column.colName && Array.isArray(entry)) {
      return entry.map((item) =>
        item && typeof item === "object" && "value" in item ? item.value : item,
      );
    }
    return entry;
  }

  private literal(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
  }

  private clearConnection(connection: Connection): void {
    if (this.connection === connection) this.connection = null;
    this.connected = false;
  }
}
