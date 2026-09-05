import mysql, {
  type FieldPacket,
  type Pool as PromisePool,
  type PoolConnection,
  type PoolOptions,
} from "mysql2/promise";
import type { Connection as CoreConnection, Query } from "mysql2";
import type { ConnectionConfig } from "../config/types";
import { resolveSslOptions } from "../core/sslOptions";
import { splitStatements } from "../core/statementParser";
import { quoteIdent } from "../core/saveStatements";
import {
  NotImplementedError,
  type AdapterCapabilities,
  type BatchedQuery,
  type DbTransaction,
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
const SYSTEM_SCHEMAS: Record<string, true> = {
  mysql: true,
  information_schema: true,
  performance_schema: true,
  sys: true,
};

const BATCH_SIZE = 500;

/** TASK-005 — one UTC session statement per fresh physical connection. */
const UTC_SESSION_SQL = "SET time_zone = '+00:00'";

/**
 * TASK-ARP05-002 — bounded acquire wait for the single-slot pool, in ms.
 *
 * The ADR's known gap (§4): `connectionLimit: 1` + `waitForConnections: true`
 * + `queueLimit: 0` means a held stream/transaction pins the only connection
 * and every later checkout enqueues FOREVER — nothing bounded the wait. The
 * chosen bound aligns with the driver's `connectTimeout: 10_000` so both
 * failure surfaces agree on one 10-second budget (ADR §5 SLO-1).
 *
 * Why a `Promise.race` at the checkout choke point instead of an
 * `acquireTimeout` pool option: mysql2 3.23.4 (the pinned driver) does NOT
 * support that option — it logs "Ignoring invalid configuration option
 * passed to Connection: acquireTimeout" and queues forever anyway (measured;
 * recorded in ADR §7 `## Probe: MySQL`). The wrapper is the real,
 * driver-agnostic bound; it is injected short by the DB-free suite via
 * `setPoolAcquireTimeoutMsForTests` so the queue-bound test never waits a
 * real 10s.
 */
export let POOL_ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * TASK-ARP05-002 — test-only injection seam for `POOL_ACQUIRE_TIMEOUT_MS`.
 * Never called by production code; the DB-free suite stubs a short bound
 * (e.g. 50ms) and restores the default afterwards.
 */
export function setPoolAcquireTimeoutMsForTests(ms: number): void {
  POOL_ACQUIRE_TIMEOUT_MS = ms;
}

type MySqlRow = any[];

type MySqlQueryResult = {
  rows: any;
  fields: FieldPacket[] | undefined;
};

type StreamState = "open" | "eof" | "closed" | "error";

/**
 * TASK-005 — server-side column sort as pure SQL composition (MySQL dialect).
 *
 * Mirrors `getTableSortQuery` (src/adapters/postgres.ts, src/adapters/mssql.ts)
 * exactly: same 4-arg signature, same `UnicDB_sort` subquery wrap, same
 * ASC/DESC whitelist — but identifiers are quoted with MySQL backticks
 * (embedded `` ` `` doubled) via the shared `quoteIdent`. The emitted
 * `ORDER BY` is exactly what MySQL `LIMIT/OFFSET` paging can attach to
 * (see `buildPagedQuery`, src/ui/queryComposer.ts).
 *
 *   getTableSortQuery("SELECT * FROM t WHERE id>5", "", "name", "ASC")
 *     → SELECT * FROM (SELECT * FROM t WHERE id>5) UnicDB_sort ORDER BY `name` ASC
 *
 * Injection safety: `column` is emitted as a single backtick-quoted
 * identifier, so a payload like ``n`; DROP TABLE x--`` stays one inert
 * identifier token. `direction` is whitelist-normalized to ASC/DESC.
 * `whereFromBar` (requery-bar filter) is appended as the OUTER query's WHERE
 * clause when non-empty — the original SQL stays verbatim inside the
 * subquery.
 *
 * Dispatch: `composeSortQuery("mysql", …)` in src/ui/queryComposer.ts
 * delegates here (host-side only — the webview never imports mysql2).
 */
export function getTableSortQuery(
  originalSql: string,
  whereFromBar: string,
  column: string,
  direction: "ASC" | "DESC",
): string {
  const inner = originalSql.trim();
  const quotedColumn = quoteIdent(column, "mysql");
  const dir = direction === "DESC" ? "DESC" : "ASC";
  const whereClause = whereFromBar.trim().length
    ? ` WHERE ${whereFromBar.trim()}`
    : "";
  return `SELECT * FROM (${inner}) UnicDB_sort${whereClause} ORDER BY ${quotedColumn} ${dir}`;
}

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
  /**
   * TASK-005 — physical core connections whose UTC session (`SET time_zone =
   * '+00:00'`) has been awaited successfully. Keyed by the CORE connection
   * (the promise wrapper's `.connection` field — a fresh wrapper object per
   * checkout), so a pool-created replacement physical connection is never
   * falsely marked initialized.
   */
  private readonly utcReadyConnections = new WeakSet<object>();
  /**
   * TASK-005 — in-flight UTC initializations per core connection. Concurrent
   * checkouts of the same physical identity share one initialization promise
   * instead of racing a second `SET time_zone` onto the wire.
   */
  private readonly utcInitializing = new WeakMap<object, Promise<void>>();
  /**
   * TASK-RLX02-001 — live non-cursor cancellation records. Each record is a
   * cancel closure for one ownership window that is open RIGHT NOW:
   *   - the held non-streaming transaction connection between
   *     getConnectionWithUtcSession() and runQuery's `finally` release, and
   *   - the pre-handoff stream between coreConnection.query({…}).stream()
   *     and the `await firstFields` resolution inside openStreamingQuery.
   * Each record removes ITSELF in its own terminal path (success, failure,
   * close, cancellation) so a late or repeated cancelActiveQuery() is a
   * silent no-op and never touches work that has already settled. The
   * post-handoff BatchedQuery seam (BatchedQuery.cancel) is exclusive and
   * never registered here.
   */
  private readonly activeCancelClosures = new Set<() => void>();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly password: string,
  ) {}

  /**
   * DBX-08 — declared advanced-capability matrix. Checked-in MySqlAdapter
   * KHÔNG có backend thật cho catalog/object-DDL/table-DDL detail/admin
   * (catalog lẫn admin đều undefined) — nên cả 4 entry đều false tường
   * minh. Baseline navigation (schemas/tables/views/routines/columns +
   * row estimates) KHÔNG nằm trong matrix này và vẫn hoạt động như cũ.
   */
  readonly capabilities: AdapterCapabilities = Object.freeze({
    catalog: false,
    objectDdl: false,
    tableDdl: false,
    admin: false,
  });

  async connect(): Promise<void> {
    if (this.pool) return;
    this.closed = false;

    const ssl = resolveSslOptions(this.cfg);
    // TASK-ARP05-002 — the declared pool acquire bound. mysql2 3.23.4 does
    // not implement the option (one console warning at createPool, measured;
    // see ADR §7 `## Probe: MySQL`); the ENFORCED bound is the
    // Promise.race at getConnectionWithUtcSession() below. The option stays
    // on the factory so the declared contract is greppable and future
    // mysql2 versions that honour it converge with the wrapper.
    const poolOptions = {
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.password,
      database: this.cfg.database,
      connectionLimit: 1,
      waitForConnections: true,
      queueLimit: 0,
      connectTimeout: 10_000,
      // TASK-005 — driver-side parsing of DATETIME/TIMESTAMP strings must be
      // UTC, not the extension host's local timezone (mysql2 defaults to
      // `local`). Together with the per-session `SET time_zone = '+00:00'`
      // (see withUtcSession), display, DISTINCT typed values and requery
      // filters all agree on one UTC contract.
      timezone: "Z",
      // The adapter splits scripts itself, so server-side multi-statements are
      // intentionally not enabled.
      multipleStatements: false,
      // TASK-ARP05-002 — declared acquire bound (see
      // POOL_ACQUIRE_TIMEOUT_MS). The enforced bound is the Promise.race
      // inside getConnectionWithUtcSession(); mysql2 3.23.4 ignores this
      // option (one console warning at createPool) and future drivers that
      // honour it will converge with the wrapper.
      acquireTimeout: POOL_ACQUIRE_TIMEOUT_MS,
      // ssl shape mysql2 SSLOptions: { ca, cert, key, rejectUnauthorized,
      // checkServerIdentity }. checkHostname là field nội bộ — strip.
      ...(ssl
        ? {
            ssl: {
              ca: ssl.ca,
              cert: ssl.cert,
              key: ssl.key,
              rejectUnauthorized: ssl.rejectUnauthorized,
              ...(ssl.checkHostname ? {} : { checkServerIdentity: () => undefined }),
            },
          }
        : {}),
    } satisfies PoolOptions & Record<string, unknown>;
    const pool = mysql.createPool(
      poolOptions as Parameters<typeof mysql.createPool>[0],
    );
    this.pool = pool;

    try {
      const connection = await this.getConnectionWithUtcSession();
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
    const connection = await this.getConnectionWithUtcSession();
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

    // Finding #3 (review fix round C): must pass the real dialect — without
    // it, MySQL string literals with `\'` backslash-escape are mis-split
    // mid-string (`splitStatements` defaults to postgres-ish `''`-only
    // escaping when `dialect` is omitted).
    const statements = splitStatements(sql, "mysql");
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
    // TASK-002 (M2) — atomic multi-statement batches. One checked-out
    // UTC-session PoolConnection is held for the WHOLE batch, wrapped in an
    // explicit transaction: `beginTransaction` → every statement on that same
    // connection → `commit()` on success; any failure runs `rollback()` and
    // rethrows the original error; `release()` happens exactly once in
    // `finally`. Without the transaction each statement autocommitted on its
    // own checkout, so a batch failing at statement N left 1..N-1 committed.
    // (`multipleStatements: false` rules out joining BEGIN…COMMIT into one
    // text; see Discussion #1 of TASK-002.) The single-SELECT streaming arm
    // above returns BEFORE this loop and must never be wrapped in a
    // transaction — a held cursor would pin the connectionLimit:1 pool.
    const connection = await this.getConnectionWithUtcSession();
    // TASK-RLX02-001 — live non-cursor ownership window. The held
    // transaction connection is cancellable via PoolConnection.destroy()
    // from the moment it is checked out until the `finally` below closes
    // the window. destroy-or-release is exclusive (mirrors
    // openStreamingQuery's `released` flag) so a cancelled connection is
    // never released a second time after destruction.
    let connectionDestroyed = false;
    const cancelHeldConnection = (): void => {
      // Self-remove first: this closure fires at most once, and removing it
      // here keeps a late repeat cancel a silent no-op.
      this.activeCancelClosures.delete(cancelHeldConnection);
      if (connectionDestroyed) return;
      connectionDestroyed = true;
      try {
        connection.destroy();
      } catch {
        // Best-effort — cancellation never masks the awaiting run.
      }
    };
    this.activeCancelClosures.add(cancelHeldConnection);
    try {
      await connection.beginTransaction();
      for (const statement of statements) {
        const text = statement.text.trim();
        if (!text) continue;
        // `runQueryOnConnection` wraps each statement back up in its own
        // RunResult (it re-splits); unwrap so the public `results` array keeps
        // the flat QueryResult-per-statement order executeText used to give.
        const statementResult = await this.runQueryOnConnection(connection, text);
        for (const queryResult of statementResult.results) {
          results.push(queryResult);
        }
      }
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Rollback failure must not mask the original statement error below.
      }
      throw error;
    } finally {
      // TASK-RLX02-001 — exact terminal path: the window closes on BOTH
      // success and failure, so a later cancelActiveQuery() is a no-op.
      this.activeCancelClosures.delete(cancelHeldConnection);
      if (!connectionDestroyed) {
        connection.release();
      }
    }
    return { results };
  }

  async beginTransaction(): Promise<DbTransaction> {
    if (!this.pool) throw new Error("MySqlAdapter: connect() chưa được gọi");
    const connection = await this.getConnectionWithUtcSession();
    let finished = false;

    const finish = async (action: "commit" | "rollback"): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        await connection[action]();
      } finally {
        connection.release();
      }
    };

    try {
      await connection.beginTransaction();
    } catch (error) {
      connection.release();
      throw error;
    }

    return {
      runQuery: async (sql: string): Promise<RunResult> => {
        if (finished) throw new Error("MySQL transaction is already closed");
        return this.runQueryOnConnection(connection, sql);
      },
      commit: () => finish("commit"),
      rollback: () => finish("rollback"),
    };
  }

  /**
   * TASK-RLX02-001 — DbAdapter.cancelActiveQuery seam (optional). Best-effort
   * cancel of the LIVE non-cursor ownership windows this adapter currently
   * holds:
   *   - the held non-streaming transaction connection (PoolConnection.destroy),
   *   - the pre-handoff stream inside openStreamingQuery
   *     (stream.destroy() + promiseConnection.destroy()).
   *
   * Contract (mirrors PostgresAdapter.cancelActiveQuery):
   *  - NEVER closes the adapter or pool — only the current statement's
   *    connection/stream is destroyed.
   *  - NEVER touches the BatchedQuery cursor — post-handoff cancellation goes
   *    exclusively through BatchedQuery.cancel(); the runner only calls this
   *    seam when no currentBatched exists.
   *  - Idempotent: an empty live set (window closed / nothing running)
   *    resolves without doing anything.
   *  - Best-effort: an individual closure failure is swallowed; cancellation
   *    must never surface as a new error on top of the in-flight statement.
   */
  async cancelActiveQuery(): Promise<void> {
    // Snapshot first: a closure self-removes when it fires, so iterating a
    // copy avoids mutating the Set while looping.
    const closures = [...this.activeCancelClosures];
    for (const cancel of closures) {
      try {
        cancel();
      } catch {
        // ignore — best-effort for each record.
      }
    }
  }

  async listSchemas(includeSystem: boolean): Promise<SchemaInfo[]> {
    const result = await this.query(
      `SELECT schema_name AS name
         FROM information_schema.schemata
        ORDER BY schema_name`,
    );
    const schemas = this.mapRows(result, (row) => ({ name: String(row.name) }));
    if (includeSystem) return schemas;
    return schemas.filter((s) => !SYSTEM_SCHEMAS[s.name]);
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

  async estimateTableRows(
    schema: string,
    table: string,
  ): Promise<number | null> {
    try {
      const result = await this.query(
        `SELECT TABLE_ROWS AS row_estimate
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            AND TABLE_TYPE = 'BASE TABLE'`,
        [schema, table],
      );
      const rows = result.rows;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const raw = (rows[0] as Record<string, unknown>).row_estimate;
      if (raw === null || raw === undefined) return null;
      const value = typeof raw === "string" ? Number(raw) : Number(raw);
      if (!Number.isFinite(value) || value < 0) return null;
      return value;
    } catch {
      return null;
    }
  }

  /**
   * D2 API — one round trip cho nhiều table qua `information_schema.TABLES
   * ... WHERE TABLE_NAME IN (...)`. KHÔNG lặp `SHOW TABLE STATUS` per-table —
   * form đó buộc MySQL collect statistics riêng cho từng table (chậm).
   * `tables` rỗng → Map rỗng, KHÔNG issue query. Table drop giữa list và
   * estimate → không có trong kết quả → OMIT khỏi Map, không throw.
   */
  async estimateTableRowsBatch(
    schema: string,
    tables: readonly string[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (tables.length === 0) return result;
    try {
      const placeholders = tables.map(() => "?").join(", ");
      const res = await this.query(
        `SELECT TABLE_NAME AS name, TABLE_ROWS AS row_estimate
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})
            AND TABLE_TYPE = 'BASE TABLE'`,
        [schema, ...tables],
      );
      const rows = res.rows;
      if (Array.isArray(rows)) {
        for (const row of rows as Record<string, unknown>[]) {
          const name = String(row.name);
          const raw = row.row_estimate;
          if (raw === null || raw === undefined) {
            result.set(name, null);
            continue;
          }
          const value = typeof raw === "string" ? Number(raw) : Number(raw);
          result.set(name, !Number.isFinite(value) || value < 0 ? null : value);
        }
      }
    } catch {
      // best-effort — mirrors estimateTableRows.
    }
    return result;
  }

  async listTableDetail(_schema: string, _table: string): Promise<TableDetail> {
    // MySQL adapter does not implement table-detail introspection (TASK-005
    // wires only Postgres; the editor guards driver === "postgres" before
    // calling). Throw so the contract is satisfied and the regression test
    // verifies caller-side guard.
    throw new NotImplementedError("mysql");
  }
  async listRoutineParams(
    _schema: string,
    _routine: string,
  ): Promise<Array<{ name: string | null; dataType: string }>> {
    throw new NotImplementedError("mysql");
 }

  private async runQueryOnConnection(
    connection: PoolConnection,
    sql: string,
  ): Promise<RunResult> {
    const statements = splitStatements(sql, "mysql");
    const results: QueryResult[] = [];
    for (const statement of statements) {
      const text = statement.text.trim();
      if (!text) continue;
      const startedAt = Date.now();
      const [rows, fields] = await connection.query(text);
      const columns = Array.isArray(fields) ? fields.map((field) => field.name) : [];
      results.push({
        columns,
        rows: this.rowsAsArrays(rows, Array.isArray(fields) ? fields : undefined, columns),
        rowCount: this.resultRowCount(rows),
        durationMs: Date.now() - startedAt,
      });
    }
    return { results };
  }

  /**
   * TASK-005 (M1) — single choke point for metadata (`information_schema`)
   * queries. TASK-002 removed `executeText`'s last caller: non-streaming
   * batches now run on one transaction-bound connection via
   * `runQueryOnConnection`, so `executeText` was deleted with it. Checks a
   * connection out through the UTC-initialized helper (never `pool.query()`,
   * which checks out implicitly and would let a replacement physical
   * connection bypass the awaited session initialization), runs
   * `connection.query(sql, values)`, and releases in `finally` on both the
   * success and rejection paths.
   */
  private async query(
    sql: string,
    values: any[] = [],
  ): Promise<MySqlQueryResult & { durationMs: number }> {
    if (!this.pool) {
      throw new Error("MySqlAdapter: connect() chưa được gọi");
    }
    const startedAt = Date.now();
    const connection = await this.getConnectionWithUtcSession();
    let rows: any;
    let fields: FieldPacket[] | undefined;
    try {
      [rows, fields] = await connection.query(sql, values);
    } finally {
      connection.release();
    }
    return { rows, fields, durationMs: Date.now() - startedAt };
  }

  /**
   * TASK-005 — checkout helper establishing the UTC adapter-session invariant.
   *
   * Every explicit `pool.getConnection()` site (connect()'s probe,
   * testConnection, beginTransaction, openStreamingQuery) and — via M1 —
   * `query(sql, values)` goes through here. On the FIRST checkout of each
   * PHYSICAL connection (the promise wrapper's `.connection` core object) it
   * awaits `SET time_zone = '+00:00'` before the connection is handed to any
   * user work; success is cached in a WeakSet keyed by that core identity, and
   * concurrent checkouts share one in-flight initialization promise so the
   * session statement is never duplicated or raced. On failure the checkout is
   * released and the error propagated — the connection is NOT marked
   * initialized, so nothing ever runs on it with an unknown timezone.
   *
   * A pool-created replacement physical connection has a fresh core identity,
   * so it re-initializes before its first user query.
   */
  private async getConnectionWithUtcSession(): Promise<PoolConnection> {
    if (!this.pool) {
      throw new Error("MySqlAdapter: connect() chưa được gọi");
    }
    // TASK-ARP05-002 — bounded acquire wait (ADR §4 known gap). mysql2 3.23.4
    // has no working acquire-timeout knob, so the wait is bounded HERE, at
    // the single checkout choke point, by racing the raw checkout against a
    // timer of POOL_ACQUIRE_TIMEOUT_MS ms. A late request against the held
    // `connectionLimit: 1` slot now surfaces an error within the bound
    // instead of queueing forever. The losing checkout (if the pool hands
    // one out after the timeout won the race) is released back immediately
    // so the slot is not leaked by an abandoned waiter.
    let timedOut = false;
    let clearAcquireTimer: (() => void) | undefined;
    const connection = await Promise.race([
      this.pool.getConnection().then((conn) => {
        if (timedOut) {
          // The timer already rejected this acquire; hand the slot straight
          // back so the pool's queue bookkeeping stays consistent.
          conn.release();
          throw new Error("MySqlAdapter: acquire already timed out");
        }
        clearAcquireTimer?.();
        return conn;
      }),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          reject(
            new Error(
              `MySqlAdapter: acquire timed out after ${POOL_ACQUIRE_TIMEOUT_MS}ms (pool slot held by another query/stream/transaction)`,
            ),
          );
        }, POOL_ACQUIRE_TIMEOUT_MS);
        // Never keep the process alive for a bookkeeping timer.
        (timer as unknown as { unref?: () => void }).unref?.();
        clearAcquireTimer = () => clearTimeout(timer);
      }),
    ]);
    try {
      await this.ensureUtcSession(connection);
      return connection;
    } catch (error) {
      connection.release();
      throw error;
    }
  }

  private async ensureUtcSession(connection: PoolConnection): Promise<void> {
    // Physical identity is the CORE connection the promise wrapper exposes as
    // `.connection` — the wrapper object itself is new on every checkout.
    const physical = (connection as unknown as { connection?: object })
      .connection ?? (connection as unknown as object);
    if (this.utcReadyConnections.has(physical)) return;
    const inFlight = this.utcInitializing.get(physical);
    if (inFlight) {
      await inFlight;
      return;
    }
    const init = (async () => {
      await connection.query(UTC_SESSION_SQL);
      this.utcReadyConnections.add(physical);
    })().finally(() => {
      this.utcInitializing.delete(physical);
    });
    this.utcInitializing.set(physical, init);
    await init;
  }

  private async openStreamingQuery(sql: string): Promise<BatchedQuery> {
    if (!this.pool) {
      throw new Error("MySqlAdapter: connect() chưa được gọi");
    }

    const promiseConnection = await this.getConnectionWithUtcSession();
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
    // TASK-RLX02-001 — assigned inside the firstFields executor below so the
    // pre-handoff cancellation record can settle the awaiting setup path
    // deterministically after destroying the stream (a Promise's second
    // settle call is a no-op, so late 'fields'/'end' cannot double-settle).
    let rejectFirstFields: ((error: Error) => void) | undefined;
    // TASK-005 (M3) — the promise MUST settle on every terminal stream path.
    // Before this, only `fields` (resolve) and `error` (reject) settled it, so
    // a stream that ended without ever emitting either hung openStreamingQuery
    // forever while holding the pooled connection (the caller never got the
    // handle, so fetchBatch/close were unreachable and the pool was
    // exhausted). `end` without `fields` is an empty-result success:
    // columns stay [] and the resolve lets the normal streamDone/deliver
    // machinery finish and release the connection.
    const firstFields = new Promise<void>((resolve, reject) => {
      // TASK-RLX02-001 — hoisted so the pre-handoff cancellation record can
      // settle the awaiting setup path deterministically after destroying
      // the stream (a Promise's second settle call is a no-op).
      rejectFirstFields = reject;
      stream.once("fields", (fields: FieldPacket[]) => {
        columns = fields.map((field) => field.name);
        resolve();
      });
      stream.once("error", reject);
      stream.once("end", () => {
        // Case 12: a `fields` event that already arrived wins — the promise
        // is settled and this resolve is a no-op.
        resolve();
      });
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
    // TASK-RLX02-001 — set by cancelPreHandoffStream so the terminal catch
    // path after `await firstFields` never destroys the already-cancelled
    // stream/connection a second time (destroy is counted exactly once).
    let preHandoffCancelled = false;

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

    // TASK-RLX02-001 — pre-handoff cancellation record (TASK-RLX02 §3.1).
    // openStreamingQuery has one short ownership window between
    // coreConnection.query({…}).stream() and the `await firstFields`
    // resolution that hands the BatchedQuery to QueryRunner. The record is
    // registered the moment the stream exists and is removed by its EXACT
    // terminal path:
    //   - cancel fires (below) → self-remove;
    //   - firstFields settles (fields/end = BatchedQuery handoff, error =
    //     terminal failure) → the .then() cleanup removes it, so the window
    //     is CLOSED the instant the handle reaches the runner and a late
    //     cancelActiveQuery() can never reach a runner-owned cursor (the
    //     post-handoff seam stays BatchedQuery.cancel()).
    const cancelPreHandoffStream = (): void => {
      this.activeCancelClosures.delete(cancelPreHandoffStream);
      preHandoffCancelled = true;
      try {
        stream.destroy();
      } catch {
        // ignore — best-effort.
      }
      destroyConnection();
      // Guarantee the awaiting setup path settles even if the destroyed
      // stream never emits 'error' (a Promise's second settle is a no-op,
      // so a real driver error still wins) and no fetch waiter is left
      // hanging — the sweep mirrors closeStream().
      rejectFirstFields?.(new Error("MySQL query was cancelled"));
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter.resolve(null);
      }
    };
    this.activeCancelClosures.add(cancelPreHandoffStream);
    firstFields.then(
      () => this.activeCancelClosures.delete(cancelPreHandoffStream),
      () => this.activeCancelClosures.delete(cancelPreHandoffStream),
    );

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
      // TASK-RLX02-001 — if the rejection came from the pre-handoff
      // cancellation record, the stream/connection were ALREADY destroyed
      // exactly once; skip the redundant teardown (destroy is counted, and
      // `released` already guards the double destroy in destroyConnection).
      if (!preHandoffCancelled) {
        stream.destroy();
        destroyConnection();
      }
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
