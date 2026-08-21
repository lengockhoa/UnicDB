import { Connection, Request } from "tedious";
import type { ConnectionConfig } from "../config/types";
import { resolveSslOptions } from "../core/sslOptions";
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

type MssqlColumn = {
  colName?: string;
  name?: string;
  [key: string]: any;
};

type RequestState = "open" | "eof" | "cancelled" | "closed" | "error";
type BatchWaiter = {
  resolve: (rows: any[][] | null) => void;
  reject: (error: Error) => void;
};

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

    const statements = splitStatements(sql);
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

  async listTables(schema = "dbo"): Promise<TableInfo[]> {
    const result = await this.execute(
      `SELECT t.name AS name, s.name AS [schema]
         FROM sys.tables t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE s.name = ${this.literal(schema)}
        ORDER BY t.name`,
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
        WHERE s.name = ${this.literal(schema)}
        ORDER BY v.name`,
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
        WHERE s.name = ${this.literal(schema)}
          AND o.type IN ('P', 'IF', 'TF', 'FN')
        ORDER BY o.name`,
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      kind: String(row[1]).toLowerCase() === "procedure"
        ? "procedure"
        : "function",
      schema: String(row[2]),
    }));
  }

  async listColumns(
    table: string,
    schema = "dbo",
  ): Promise<ColumnInfo[]> {
    const result = await this.execute(
      `SELECT c.name AS name,
              ty.name AS dataType,
              c.is_nullable AS nullable,
              CASE WHEN EXISTS (
                SELECT 1
                  FROM sys.indexes i
                  JOIN sys.index_columns ic
                    ON ic.object_id = i.object_id
                   AND ic.index_id = i.index_id
                 WHERE i.object_id = t.object_id
                   AND i.is_primary_key = 1
                   AND ic.column_id = c.column_id
              ) THEN 1 ELSE 0 END AS isPrimaryKey
         FROM sys.tables t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         JOIN sys.columns c ON c.object_id = t.object_id
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        WHERE s.name = ${this.literal(schema)}
          AND t.name = ${this.literal(table)}
        ORDER BY c.column_id`,
    );
    return result.rows.map((row) => ({
      name: String(row[0]),
      dataType: String(row[1]),
      nullable: Boolean(Number(row[2])),
      ...(Number(row[3]) === 1 ? { isPrimaryKey: true } : {}),
    }));
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

  /** Execute one statement and return the normalized query result. */
  private async execute(sql: string): Promise<QueryResult> {
    return this.enqueue(() => this.runRequest(sql));
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

  private async runRequest(sql: string): Promise<QueryResult> {
    if (!this.connection) {
      throw new Error("MsSqlAdapter: connect() chưa được gọi");
    }

    const startedAt = Date.now();
    const request = this.newRequest(sql);
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

  private newRequest(sql: string): Request {
    return new Request(sql, () => undefined);
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
