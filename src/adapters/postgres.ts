// src/adapters/postgres.ts
// PostgresAdapter — pg.Pool (PG_POOL_MAX slot, mở lazy) + manual DECLARE CURSOR
// cho BatchedQuery.
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
//          one-off Client (không qua pool — tránh queue/wedge), rồi
//          CLOSE/ROLLBACK/release.
// close: adapter.close() cleanup mọi BatchedQuery còn open rồi pool.end().
//
// Metadata: information_schema + pg_proc.
import { Client, Pool, PoolClient } from "pg";
import type { ConnectionConfig } from "../config/types";
import { resolveSslOptions } from "../core/sslOptions";
import type {
  AdminApi,
  AdapterCapabilities,
  CatalogApi,
  BatchedQuery,
  DbTransaction,
  ColumnInfo,
  DbAdapter,
  IndexInfo,
  ListRolesOptions,
  ListSessionsOptions,
  QueryResult,
  RoutineInfo,
  SchemaInfo,
  SequenceInfo,
  TableConstraintInfo,
  TableDetail,
  TriggerInfo,
  TableInfo,
  RunResult,
  RenameUsageApi,
  ViewInfo,
} from "./types";
import {
  indexesSql,
  constraintsSql,
  triggersSql,
  sequencesSql,
  objectDdlSql,
  objectNotFoundError,
  rowsToIndexes,
  rowsToConstraints,
  rowsToTriggers,
  rowsToSequences,
  rowCountSql,
} from "../core/ddl/pgCatalog";
import {
  listRolesSql,
  listRoleGrantsSql,
  listSessionsSql,
  listLockWaitsSql,
  buildGrantSql,
  buildRevokeSql,
} from "../core/admin/pgAdmin";
import {
  INTROSPECT_COLUMNS_SQL,
  INTROSPECT_CONSTRAINTS_SQL,
} from "../core/ddl/pgIntrospect";
import {
  DEPENDENT_VIEWS_SQL,
  TABLE_FKS_SQL,
  ROUTINES_SQL,
  NAME_COLLISION_SQL,
  TRIGGERS_SQL,
  INDEXES_SQL,
  mapRenameTriggerRows,
  mapRenameIndexRows,
} from "../core/ddl/renameCatalog";
import type {
  RawRenameTriggerRow,
  RawRenameIndexRow,
} from "../core/ddl/renameCatalog";
import { splitStatements } from "../core/statementParser";
import { maskLiteralsAndComments } from "../core/dangerousStatement";

const DEFAULT_BATCH_SIZE = 500;

/**
 * Pool size for the shared Postgres connection. Metadata traffic (schema
 * tree, keyword completion, row-count estimates, AI run_sql) runs on its own
 * pool slot while a manual-commit transaction or a streaming cursor pins
 * another — see the comment in connect(). Slots open lazily on demand, so
 * idle VSDB connections cost nothing.
 */
const PG_POOL_MAX = 4;

/**
 * D5 fix — cursor-routing decision as a single, pure, exported-for-test
 * helper instead of the inline `/^\s*SELECT\b/i.test(text) &&
 * !text.includes(";")` regex that used to guard `runQuery`'s fast path.
 *
 * The old predicate had two independent defects:
 *  - A leading comment (which `splitStatements` always keeps as part of the
 *    statement text) defeats `/^\s*SELECT\b/` — the comment isn't whitespace.
 *  - `!text.includes(";")` rejects any statement containing a literal `;`
 *    even INSIDE a string ('...;...') — a false negative, since
 *    `splitStatements()` has already isolated real statement boundaries
 *    before `text` ever reaches this function.
 *
 * Fix: strip leading whitespace + `--`/`/* *\/` comments, then check the
 * leading keyword is `SELECT` or `WITH` (mirrors mssql.ts, which already
 * accepts `WITH`). No `;` check at all — `text` is always ONE statement by
 * the time it gets here, so any `;` remaining in it is by construction
 * inside a string/comment/dollar-quote, not a second statement boundary.
 *
 * Review fix round C, Finding #1 — BLOCKING REGRESSION: a `WITH ...` whose
 * CTE body is data-modifying (`WITH upd AS (UPDATE t SET a=1 RETURNING *)
 * SELECT * FROM upd`) was routed here too. `openCursorForStatement` issues
 * `DECLARE "c" CURSOR FOR <sql>`, which Postgres REJECTS for any WITH clause
 * containing INSERT/UPDATE/DELETE/MERGE ("DECLARE CURSOR must not contain
 * data-modifying statements in WITH") — and there is no fallback, so the
 * statement just errors and the user's UPDATE/INSERT/DELETE never runs. Fix:
 * when the leading keyword is `WITH`, additionally scan the (literal/
 * comment/dollar-quote-masked) text for a real INSERT/UPDATE/DELETE/MERGE
 * token and reject the cursor path if found. Read-only CTEs / comment-
 * prefixed SELECTs keep using the cursor path — that was the point of
 * TASK-005.
 *
 * Review fix round E, Finding #4 — MINOR (pre-existing, not from this
 * cycle): a bare `SELECT` CAN still be a table-creating statement via
 * Postgres `SELECT ... INTO newtab FROM t` — that is not a plain read-only
 * SELECT, and `DECLARE CURSOR FOR SELECT ... INTO ...` is rejected by
 * Postgres with no fallback. Guard: scan the masked text for a real `INTO`
 * token and reject the cursor path if found (mirrors the WITH/DML guard
 * above — masked so `INTO` inside a string/comment/identifier doesn't
 * false-positive).
 */
export function shouldUseCursor(text: string): boolean {
  const stripped = stripLeadingCommentsAndWhitespace(text);
  if (!/^(SELECT|WITH)\b/i.test(stripped)) return false;
  if (/^WITH\b/i.test(stripped) && containsDataModifyingCteBody(text)) {
    return false;
  }
  if (containsSelectInto(text)) {
    return false;
  }
  return true;
}

/**
 * True if `text` contains a real (not inside a string/identifier/comment/
 * dollar-quote) `INTO` token — i.e. a `SELECT ... INTO newtab FROM ...`
 * table-creating statement (Finding #4).
 */
function containsSelectInto(text: string): boolean {
  const masked = maskLiteralsAndComments(text);
  return /\bINTO\b/i.test(masked);
}

/**
 * True if `text` contains a real (not inside a string/identifier/comment/
 * dollar-quote) `INSERT` / `UPDATE` / `DELETE` / `MERGE` token — i.e. a
 * data-modifying CTE body. Reuses `dangerousStatement.ts`'s literal/comment
 * masking (same Postgres quoting rules) instead of duplicating it.
 */
function containsDataModifyingCteBody(text: string): boolean {
  const masked = maskLiteralsAndComments(text);
  return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(masked);
}

function stripLeadingCommentsAndWhitespace(text: string): string {
  let i = 0;
  const n = text.length;
  for (;;) {
    while (i < n && /\s/.test(text[i])) i += 1;
    if (text.startsWith("--", i)) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    break;
  }
  return text.slice(i);
}

/**
 * TASK-003 — server-side column sort as pure SQL composition.
 *
 * Wraps `originalSql` (the query whose result the webview table is showing)
 * in a subquery aliased `vsdb_sort` and appends an ORDER BY on the sorted
 * column. The webview composes the requery by putting column sort into the
 * `orderBy` field of the existing `requery` message; this helper is the
 * Postgres side of that composition — the mssql twin lives in
 * `src/adapters/mssql.ts`, and `composeSortQuery` (src/ui/queryComposer.ts)
 * is the dialect dispatch entry that selects between them.
 *
 *   getTableSortQuery("SELECT * FROM t WHERE id>5", "", "name", "ASC")
 *     → SELECT * FROM (SELECT * FROM t WHERE id>5) vsdb_sort ORDER BY "name" ASC
 *
 * Injection safety: `column` is emitted as a single double-quoted identifier
 * (embedded `"` doubled per Postgres rules), so a payload like
 * `name; DROP TABLE users--` stays one inert identifier token. `direction`
 * is whitelist-normalized to ASC/DESC. `whereFromBar` (requery-bar filter)
 * is appended as the OUTER query's WHERE clause when non-empty — the
 * original SQL stays verbatim inside the subquery.
 */
export function getTableSortQuery(
  originalSql: string,
  whereFromBar: string,
  column: string,
  direction: "ASC" | "DESC",
): string {
  const inner = originalSql.trim();
  const quotedColumn = `"${column.replace(/"/g, '""')}"`;
  const dir = direction === "DESC" ? "DESC" : "ASC";
  const whereClause = whereFromBar.trim().length
    ? ` WHERE ${whereFromBar.trim()}`
    : "";
  return `SELECT * FROM (${inner}) vsdb_sort${whereClause} ORDER BY ${quotedColumn} ${dir}`;
}

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
  /**
   * TASK-RLX-001 — backend PIDs của các operation non-cursor đang chạy qua
   * runQuery(). Mỗi lần runQuery check out client thì record `processID` của
   * client đó vào Set; `finally` của LẦN GỌI ĐÓ chỉ delete ĐÚNG PID nó đã
   * record (không bao giờ clear-all) — nên các runQuery chạy chồng nhau
   * không giết window của nhau (review fix round 1, Finding B: scalar
   * `activeNonCursorPid` cũ bị lần sau ghi đè và lần trước's finally xoá
   * window của lần sau còn đang bay). cancelActiveQuery() cancel TẤT CẢ
   * PID trong Set qua dedicated Client — KHÔNG bao giờ close pool/adapter.
   * Client không expose processID (typeof !== "number") → không track
   * (không có gì để cancel).
   */
  private readonly activeNonCursorPids = new Set<number>();

  constructor(
    private readonly cfg: ConnectionConfig,
    private readonly password: string,
  ) {}

  /**
   * DBX-08 — declared advanced-capability matrix. PostgresAdapter là adapter
   * duy nhất expose CatalogApi (`catalog`, gồm objectDdl) và AdminApi
   * (`admin`) thật, cùng table-DDL qua listTableDetail — nên cả 4 entry đều
   * true tường minh. Đây là nguồn truth cho admission (host/UI funnels đọc
   * qua hasAdapterCapability), KHÔNG phải `driver === "postgres"`.
   */
  readonly capabilities: AdapterCapabilities = Object.freeze({
    catalog: true,
    objectDdl: true,
    tableDdl: true,
    admin: true,
  });

  async connect(): Promise<void> {
    if (this.pool) return;
    // Open risk `pg-metadata-vs-transaction-window` (cycle X audit, fixed):
    // pool used to be `max: 1`. While a manual-commit transaction (or a
    // streaming cursor) pinned that single client, EVERY background metadata
    // call (schemaTree row counts, keywordQualify listTables, completion,
    // AI run_sql) queued behind it and failed after connectionTimeoutMillis
    // ("timeout exceeded when trying to connect", pg-pool/index.js:206-225).
    //
    // Safe to raise now because the cross-statement race that motivated
    // `max: 1` no longer exists: runQuery checks out ONE client for the WHOLE
    // multi-statement run (see its Finding #6 comment), and beginTransaction()
    // pins its own client — so concurrent metadata queries land on their OWN
    // session and can never interleave into a user's open transaction or
    // mid-script statement stream. Each extra pool slot is one additional
    // TCP + auth handshake (~ms); pg-pool only opens slots on demand.
    this.pool = new Pool({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.password,
      database: this.cfg.database,
      max: PG_POOL_MAX,
      ssl: pgSslOptions(this.cfg),
      connectionTimeoutMillis: 10_000,
    });
    const probe = await this.pool.connect();
    // ARP-05.1 (TASK-ARP05-001) — a failed connect probe must leave no
    // half-open pool behind (mirrors MySqlAdapter.connect, mysql.ts:184-196):
    // release the probe client, end the pool exactly once, drop the
    // reference, and rethrow the original error so a later connect() builds
    // a FRESH pool instead of silently reusing a dead one.
    let probeError: unknown = null;
    try {
      await probe.query("SELECT 1");
    } catch (error) {
      probeError = error;
    } finally {
      probe.release();
    }
    if (probeError !== null) {
      const deadPool = this.pool;
      this.pool = null;
      try {
        await deadPool.end();
      } catch {
        // ignore — pool.end failure must never mask the probe error.
      }
      throw probeError;
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

    // Finding #3 (review fix round C): postgres.ts is the "no dialect passed
    // ⇒ postgres-ish default" reference behavior (splitStatements' own
    // docstring), so `"postgres"` here is explicit rather than load-bearing
    // — kept for parity with the other two adapters and to make the dialect
    // threading auditable at every call site.
    const statements = splitStatements(sql, "postgres");

    const singleSelect =
      statements.length === 1 && shouldUseCursor(statements[0].text);

    if (singleSelect) {
      const batched = await this.openCursorForStatement(statements[0].text);
      return { results: [], batched };
    }

    // Review fix round C, Finding #6: check out ONE client for the WHOLE
    // multi-statement run instead of calling `this.pool.query()` per
    // statement. `pool.query()` checks out AND releases a client
    // internally on EACH call, so releasing it between statement N and
    // N+1 hands the connection to whatever OTHER pool caller is next in
    // pg's internal pending queue (schemaTree.fetchRowCountsBatch,
    // keywordQualify's listTables, the AI `run_sql` tool, ...). TASK-004's
    // `BEGIN;` de-blocking means `resultsPanel.ts`'s save flow now sends
    // `BEGIN; <stmts>; COMMIT;` through exactly THIS branch (it used to be
    // one opaque un-split statement) — without holding a single client, a
    // concurrent background query could land INSIDE the user's open
    // transaction and abort it. Held for the entire loop and released in
    // `finally` so no other caller can grab this client mid-script.
    // (This single-client discipline is also what makes PG_POOL_MAX > 1
    // safe: concurrent metadata queries get their OWN session.)
    const client = await this.pool.connect();
    // TASK-RLX-001 — record backend PID của client ĐANG ĐƯỢC CHECK OUT bởi
    // LẦN GỌI NÀY vào Set (Finding B fix round 1). `pid` là const của lần
    // gọi — finally dưới đây chỉ delete đúng PID này, không đụng PID của
    // lần runQuery khác đang chạy chồng. processID thiếu → không track.
    const pid = (client as unknown as { processID?: number }).processID;
    const trackedPid = typeof pid === "number" ? pid : null;
    if (trackedPid !== null) {
      this.activeNonCursorPids.add(trackedPid);
    }
    try {
      const results: QueryResult[] = [];
      for (const stmt of statements) {
        const text = stmt.text.trim();
        if (text.length === 0) continue;
        const t0 = Date.now();
        const r = await client.query(text);
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
    } finally {
      // TASK-RLX-001 — PID window của CHÍNH LẦN GỌI NÀY đóng: delete ĐÚNG
      // PID đã record (cả success lẫn error), KHÔNG clear-all — nếu một
      // runQuery khác vẫn đang bay với PID của nó, PID đó phải còn trong
      // Set để cancelActiveQuery() vẫn chạm tới được backend đó.
      if (trackedPid !== null) {
        this.activeNonCursorPids.delete(trackedPid);
      }
      client.release();
    }
  }

  async beginTransaction(): Promise<DbTransaction> {
    if (!this.pool) throw new Error("PostgresAdapter: connect() chưa được gọi");
    const client = await this.pool.connect();
    let finished = false;

    const release = (destroy = false): void => {
      try {
        client.release(destroy);
      } catch {
        // The client may already be released during adapter shutdown.
      }
    };
    const finish = async (sql: "COMMIT" | "ROLLBACK"): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        await client.query(sql);
      } finally {
        release(sql === "ROLLBACK");
      }
    };

    try {
      await client.query("BEGIN");
    } catch (error) {
      release(true);
      throw error;
    }

    return {
      runQuery: async (sql: string, values?: unknown[]): Promise<RunResult> => {
        if (finished) throw new Error("Postgres transaction is already closed");
        return this.runQueryOnClient(client, sql, values);
      },
      commit: () => finish("COMMIT"),
      rollback: () => finish("ROLLBACK"),
    };
  }

  /**
   * TASK-RLX-001 — DbAdapter.cancelActiveQuery seam (optional). Cancel
   * operation non-cursor đang chạy (statement mà QueryRunner đang chờ qua
   * runQuery) qua pg_cancel_backend trên backend PID đã record.
   *
   *  - Dùng cơ chế DEDICATED one-off Client có sẵn (CRITICAL #2 fix) —
   *    KHÔNG qua pool: các slot pool có thể đang bị giữ, pool.query sẽ xếp
   *    hàng 10s rồi timeout.
   *  - KHÔNG bao giờ close pool/adapter — chỉ cancel statement hiện tại.
   *  - KHÔNG đụng cursor: BatchedQuery có cancel path riêng
   *    (BatchedQuery.cancel), QueryRunner đảm bảo seam chỉ gọi khi không có
   *    cursor in-flight.
   *  - Không có PID active (window đóng / chưa từng run) → no-op.
   *  - Best-effort: dedicated client fail → swallow (giống cancel của
   *    BatchedQuery); việc release client vẫn là trách nhiệm của runQuery.
   */
  async cancelActiveQuery(): Promise<void> {
    // Finding B fix round 1 — Set có thể chứa NHIỀU PID (các runQuery chạy
    // chồng: runner run + background metadata / grant-wizard runQuery). Rỗng
    // → no-op (không mở dedicated client). Không rỗng → MỘT dedicated client,
    // pg_cancel_backend TỪNG PID. Vẫn best-effort: lỗi cancel từng PID bị
    // swallow (giống cancelBackendViaDedicatedClient); client `end()` trong
    // finally; KHÔNG bao giờ đụng pool/adapter.
    if (this.activeNonCursorPids.size === 0) return;
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
      for (const pid of this.activeNonCursorPids) {
        try {
          await dedicated.query("SELECT pg_cancel_backend($1)", [pid]);
        } catch {
          // ignore — best-effort cho từng PID.
        }
      }
    } catch {
      // ignore — dedicated client fail (server down, network) → best-effort.
    } finally {
      try {
        await dedicated.end();
      } catch {
        // ignore
      }
    }
  }

  private async runQueryOnClient(
    client: PoolClient,
    sql: string,
    values?: unknown[],
  ): Promise<RunResult> {
    const statements = splitStatements(sql, "postgres");
    const results: QueryResult[] = [];
    for (const stmt of statements) {
      const text = stmt.text.trim();
      if (!text) continue;
      const startedAt = Date.now();
      // Bind $N parameters when the caller supplied values and this
      // statement uses placeholders; otherwise execute literally.
      const result =
        values !== undefined && /\$\d+/.test(text)
          ? await client.query(text, values)
          : await client.query(text);
      const columns = result.fields.map((field) => field.name);
      results.push({
        columns,
        rows: rowsAsArrays(result.rows, columns),
        rowCount: result.rowCount ?? null,
        commandTag: result.command ?? undefined,
        durationMs: Date.now() - startedAt,
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

  async listRoutineParams(
    schema: string,
    routine: string,
  ): Promise<Array<{ name: string | null; dataType: string }>> {
    // Parameterized — $1/$2 bind via this.query → pool.query(sql, [..]).
    //
    // Two source columns for arg types in pg_proc:
    //   proallargtypes  — oid[]   of arg types including INOUT/OUT/VARIADIC;
    //                     NULL when the routine declares only IN args (the common
    //                     case for ordinary all-IN-arg functions/procs).
    //   proargtypes     — oidvector of arg types (only IN args).
    //
    // COALESCE(proallargtypes, proargtypes::oid[]) covers both shapes.
    // WITH ORDINALITY supplies a 1-based `ord` matching pg_proc's 1-based
    // array subscript convention (previous generate_series(0,…) implementation
    // was 0-based and misaligned even when proallargtypes WAS populated).
    //
    // proargnames[] is an array of the same length; subscript by ord → names
    // (NULL where the arg is unnamed positional).
    //
    // Validated against real PG 16.15 (vsdb-postgres, PREPARE/EXECUTE mirroring
    // $1/$2 binds) for: named all-IN args, unnamed positional args, no-arg,
    // and INOUT — see test cases.
    const res = await this.query<{
      arg_name: string | null;
      format_type: string;
    }>(
      `SELECT p.proargnames[t.ord] AS arg_name,
              pg_catalog.format_type(t.typ, NULL) AS format_type
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL unnest(
           COALESCE(p.proallargtypes, p.proargtypes::oid[])
         ) WITH ORDINALITY AS t(typ, ord)
        WHERE n.nspname = $1 AND p.proname = $2
        ORDER BY t.ord`,
      [schema, routine],
    );
    return res.rows.map((row) => ({
      name: row.arg_name,
      dataType: row.format_type,
    }));
  }

  /**
   * D4 fix — pg_catalog only, zero `information_schema` references, at most
   * ONE `::regclass` cast per call.
   *
   * Old query joined `information_schema.columns` (which evaluates
   * `has_column_privilege()` per column, DB-wide — slow) purely to get
   * column_name/data_type/is_nullable that `pg_attribute` already has, then
   * cast `::regclass` up to 3 times across 2 queries. `INTROSPECT_COLUMNS_SQL`
   * (pgIntrospect.ts, shared with listTableDetail) is a strictly faster
   * pure-pg_catalog equivalent for the columns half — zero regclass casts.
   * PK detection folds into a single `pg_index` lookup that casts once.
   */
  async listColumns(
    table: string,
    schema: string = "public",
  ): Promise<ColumnInfo[]> {
    const colsRes = await this.query<{
      column_name: string;
      format_type: string;
      is_nullable: "YES" | "NO";
    }>(INTROSPECT_COLUMNS_SQL(schema, table), [schema, table]);

    const pkRes = await this.query<{ column_name: string }>(
      `SELECT a.attname AS column_name
         FROM pg_index i
         JOIN pg_attribute a
           ON a.attrelid = i.indrelid
          AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid =
              (quote_ident($1) || '.' || quote_ident($2))::regclass
          AND i.indisprimary`,
      [schema, table],
    );
    const pkCols = new Set(pkRes.rows.map((row) => row.column_name));

    return colsRes.rows.map((row) => {
      const info: ColumnInfo = {
        name: row.column_name,
        dataType: row.format_type,
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

  /**
   * D2 API — one round trip cho nhiều table thay vì N lần estimateTableRows()
   * (trước đây rất tốn kém khi pool chỉ có 1 slot — mỗi lần gọi tuần tự xếp hàng).
   * `tables` rỗng → Map rỗng, KHÔNG issue query nào. Table không tồn tại /
   * bị drop giữa list và estimate → đơn giản không xuất hiện trong kết quả
   * `pg_class` → OMIT khỏi Map (không map null, không throw).
   */
  async estimateTableRowsBatch(
    schema: string,
    tables: readonly string[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (tables.length === 0) return result;
    try {
      const res = await this.query<{
        relname: string;
        row_estimate: string | number;
      }>(
        `SELECT c.relname, c.reltuples::bigint AS row_estimate
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY($2)
            AND c.relkind IN ('r','p')`,
        [schema, tables],
      );
      for (const row of res.rows) {
        const raw = row.row_estimate;
        const value = typeof raw === "string" ? Number(raw) : raw;
        result.set(
          row.relname,
          !Number.isFinite(value) || value < 0 ? null : value,
        );
      }
    } catch {
      // best-effort — mirrors estimateTableRows: lỗi metadata query không
      // được làm hỏng cả tree, trả về những gì đã có (có thể rỗng).
    }
    return result;
  }

  /**
   * listTableDetail — one-shot introspection cho (schema, table).
   *
   * Tách khỏi runQuery vì runQuery single-SELECT route qua cursor (trả empty
   * results). Ở đây dùng `this.query()` (pool.query với params) — server bind
   * $1/$2 an toàn (giống listColumns). MySQL/MSSQL adapter throw
   * NotImplementedError (DbAdapter contract).
   */
  async listTableDetail(schema: string, table: string): Promise<TableDetail> {
    const colsRes = await this.query<{
      column_name: string;
      format_type: string;
      is_nullable: "YES" | "NO";
      column_default: string | null;
    }>(INTROSPECT_COLUMNS_SQL(schema, table), [schema, table]);
    const consRes = await this.query<{
      conname: string;
      contype: string;
      conkey: number[];
      confrelidname: string | null;
      confkeycols: string[] | null;
      consrc: string;
    }>(INTROSPECT_CONSTRAINTS_SQL(schema, table), [schema, table]);
    return {
      columns: colsRes.rows,
      constraints: consRes.rows,
    };
  }

  // ---- DBX-06 Safe Rename usage analysis (parameterized pg_catalog) --------

  readonly renameUsage: RenameUsageApi = {
    dependentViews: (schema, table) =>
      this.query<{ name: string; kind: string }>(DEPENDENT_VIEWS_SQL(), [
        schema,
        table,
      ]).then((r) => r.rows),

    referencingFks: (schema, table) =>
      this.query<{
        constraint: string;
        from_table: string;
      }>(TABLE_FKS_SQL(), [schema, table]).then((r) =>
        r.rows.map((row) => ({
          constraint: row.constraint,
          fromTable: row.from_table,
        })),
      ),

    routines: (schema, table) =>
      this.query<{ name: string }>(ROUTINES_SQL(), [schema, table]).then(
        (r) => r.rows,
      ),

    nameCollision: (schema, candidate) =>
      this.query<{ name: string; kind: string }>(NAME_COLLISION_SQL(), [
        schema,
        candidate,
      ]).then((r) => r.rows),

    // DBX06-005 — typed trigger/index lookups. Both always bind exactly
    // [schema, table, column]; table mode passes column === "".
    triggers: (schema, table, column) =>
      this.query<RawRenameTriggerRow>(TRIGGERS_SQL(), [
        schema,
        table,
        column,
      ]).then((r) => mapRenameTriggerRows(r.rows)),

    indexes: (schema, table, column) =>
      this.query<RawRenameIndexRow>(INDEXES_SQL(), [
        schema,
        table,
        column,
      ]).then((r) => mapRenameIndexRows(r.rows)),
  };

  // ---- Helpers --------------------------------------------------------------

  // ---- Catalog (TASK-AF-001) -----------------------------------------------
  //
  // OPTIONAL DbAdapter.catalog capability. PostgreSQL-only — mysql/mssql
  // adapters leave `catalog` undefined. AF-002 (schema tree) and AF-004
  // (DDL viewer) consume this surface.

  readonly catalog: CatalogApi = {
    listIndexes: (schema: string, table: string) =>
      this.query<{
        indexname: string;
        schemaname: string;
        tablename: string;
        indexdef: string;
      }>(indexesSql(schema, table), [schema, table]).then((r) =>
        rowsToIndexes(r.rows),
      ),

    listConstraints: (schema: string, table: string) =>
      this.query<{
        conname: string;
        contype: string;
        conkeycols: string[];
        consrc: string | null;
        confrelidname: string | null;
        confkeycols: string[] | null;
      }>(constraintsSql(schema, table), [schema, table]).then((r) =>
        rowsToConstraints(r.rows),
      ),

    listTriggers: (schema: string, table: string) =>
      this.query<{
        tgname: string;
        tgtype: number;
        tgrelid: string | null;
        action_statement: string;
      }>(triggersSql(schema, table), [schema, table]).then((r) =>
        rowsToTriggers(r.rows),
      ),

    listSequences: (schema: string) =>
      this.query<{
        schemaname: string;
        sequencename: string;
        data_type: string;
        last_value: string | null;
      }>(sequencesSql(schema), [schema]).then((r) => rowsToSequences(r.rows)),

    rowCount: async (schema: string, table: string): Promise<number> => {
      const r = await this.query<{ n: string | number }>(
        rowCountSql(schema, table),
      );
      if (r.rows.length === 0) {
        throw new Error(
          "pgCatalog.rowCount: no rows for " + schema + "." + table,
        );
      }
      const raw = r.rows[0].n;
      const value = typeof raw === "string" ? Number(raw) : raw;
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          "pgCatalog.rowCount: invalid count for " + schema + "." + table,
        );
      }
      return value;
    },

    objectDdl: async (
      kind: "view" | "routine" | "trigger",
      name: string,
      schema?: string,
    ): Promise<string> => {
      if (kind === "trigger") {
        // The trigger SQL needs (schema, table) for the table the trigger
        // is attached to. The high-level call name is the trigger's
        // <table> (or qualified). For simplicity we ask callers to pass
        // a "schema.table.trigger" composite when they need disambig.
        const parts = name.split(".");
        let tableName: string;
        let triggerName: string;
        let trigSchema: string;
        if (parts.length === 3) {
          trigSchema = parts[0];
          tableName = parts[1];
          triggerName = parts[2];
        } else {
          trigSchema = schema ?? "public";
          tableName = parts[0];
          triggerName = parts[1] ?? name;
        }
        const r = await this.query<{ ddl: string }>(
          objectDdlSql(kind, triggerName, trigSchema),
          [trigSchema, tableName],
        );
        if (r.rows.length === 0) {
          throw objectNotFoundError(kind, triggerName, trigSchema);
        }
        return r.rows[0].ddl;
      }
      const r = await this.query<{ ddl: string }>(
        objectDdlSql(kind, name, schema),
        [],
      );
      if (r.rows.length === 0) {
        throw objectNotFoundError(kind, name, schema);
      }
      return r.rows[0].ddl;
    },
  };

  // Cycle AHL (TASK-AHL-001) — optional admin capability. Reuses pgAdmin SQL
  // templates + row mappers and this.query<T>() plumbing. mysql/mssql adapters
  // leave `admin` undefined; callers guard on `adapter.admin` first.
  readonly admin: AdminApi = {
    listRoles: (opts?: ListRolesOptions) => {
      const r = listRolesSql(opts);
      return this.query<{
        name: string;
        can_login: boolean;
        is_superuser: boolean;
        member_of: string[] | null;
      }>(r.sql, r.params).then((res) =>
        res.rows.map((row) => ({
          name: row.name,
          canLogin: row.can_login,
          isSuperuser: row.is_superuser,
          memberOf: row.member_of ?? [],
        })),
      );
    },
    listRoleGrants: (role: string) =>
      this.query<{
        grantee: string;
        schema: string;
        object: string;
        object_kind: "table" | "column";
        privileges: string[];
      }>(listRoleGrantsSql(role), [role]).then((res) =>
        res.rows
          .filter((r) => r.object_kind === "table")
          .map((r) => ({
            objectKind: "table" as const,
            schema: r.schema,
            object: r.object,
            privileges: r.privileges,
            grantee: r.grantee,
          })),
      ),
    listSessions: (opts?: ListSessionsOptions) =>
      this.query<{
        pid: number;
        usename: string;
        state: string;
        duration_ms: number;
        query: string;
        wait_event: string;
        application_name: string;
      }>(listSessionsSql(opts), []).then((res) =>
        res.rows.map((row) => ({
          pid: row.pid,
          usename: row.usename,
          state: row.state,
          durationMs: Number(row.duration_ms),
          query: row.query,
          waitEvent: row.wait_event || undefined,
          applicationName: row.application_name || undefined,
        })),
      ),
    listLockWaits: () =>
      this.query<{
        blocked_pid: number;
        blocked_query: string;
        blocking_pid: number;
        blocking_query: string;
        lock_type: string;
        mode: string;
        relation: string | null;
      }>(listLockWaitsSql(), []).then((res) =>
        res.rows.map((row) => ({
          blockedPid: row.blocked_pid,
          blockedQuery: row.blocked_query,
          blockingPid: row.blocking_pid,
          blockingQuery: row.blocking_query,
          lockType: row.lock_type,
          mode: row.mode,
          relation: row.relation ?? undefined,
        })),
      ),
    buildGrantSql: (req, opts) => buildGrantSql(req, opts),
    buildRevokeSql: (req, opts) => buildRevokeSql(req, opts),
  };

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
   * try/catch; bất kỳ lỗi nào → ROLLBACK + release(true) rồi rethrow. Mọi
   * pool slot phải luôn trở về trạng thái usable.
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
          // (không đợi lần fetch rỗng kế tiếp) — pool bị giới hạn slot,
          // cần client trả về sớm cho statement sau; nếu không các pool.query
          // kế tiếp xếp hàng connectionTimeoutMillis rồi fail "timeout exceeded
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
        // pg_cancel_backend — không qua pool (slot đang bị cursor giữ
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
      // rồi rethrow. Nếu không release ở đây, pool bị wedge vĩnh
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
   * dedicated connection) — KHÔNG qua pool. Lý do: các slot pool có thể đang
   * bị cursor/transaction giữ; gọi pool.query sẽ xếp hàng 10s rồi timeout
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
