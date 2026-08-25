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
  TableDetail,
  TableInfo,
  ViewInfo,
} from "./types";
import {
  INTROSPECT_COLUMNS_SQL,
  INTROSPECT_CONSTRAINTS_SQL,
} from "../core/ddl/pgIntrospect";
import { splitStatements } from "../core/statementParser";
import { maskLiteralsAndComments } from "../core/dangerousStatement";

const DEFAULT_BATCH_SIZE = 500;

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
    // internally on EACH call — with `Pool({ max: 1 })` there is exactly
    // one physical connection, so releasing it between statement N and
    // N+1 hands the connection to whatever OTHER `pool.query()` call is
    // next in pg's internal pending queue (schemaTree.fetchRowCountsBatch,
    // keywordQualify's listTables, the AI `run_sql` tool, ...). TASK-004's
    // `BEGIN;` de-blocking means `resultsPanel.ts`'s save flow now sends
    // `BEGIN; <stmts>; COMMIT;` through exactly THIS branch (it used to be
    // one opaque un-split statement) — without holding a single client, a
    // concurrent background query could land INSIDE the user's open
    // transaction and abort it. Held for the entire loop and released in
    // `finally` so no other caller can grab the connection mid-script.
    const client = await this.pool.connect();
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
      client.release();
    }
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
   * (đặc biệt tốn kém trên pool `max: 1` — mỗi lần gọi tuần tự xếp hàng).
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
