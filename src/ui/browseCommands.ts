// src/ui/browseCommands.ts
// TASK-001 — browseCommands module.
// TASK-007 — applies qualifyKeywordTables to generated browse SQL so it
// shares the same defensive reserved-keyword rewrite path as the editor
// submit path.
//
// Exports:
//   - `buildBrowseSelect(driver, schema, table)` — pure per-dialect SELECT builder
//     using identifier-appropriate quoting + doubling (pg: ", mysql: `, mssql: []).
//     Empty schema → unqualified form (`"t"`, `` `t` ``, `[t]`).
//   - `registerBrowseCommands(deps)` — registers `vsdb.browseTableData` command
//     against the schema-tree node argument contract: receives the whole VsdbNode
//     (with `.meta`) as `arguments[0]`, aligns the active connection if needed,
//     drives `runner.run → panel.render` with the standard busy/run/render
//     pipeline (no `confirmDangerousStatements` — generated SELECT, never
//     dangerous).
//
// The header copy mirrors `runStatements` style: `Browse <qualified> at <ISO>`.
import * as vscode from "vscode";
import type { ConnectionConfig, ParsedStatement } from "../config/types";
import { qualifyKeywordTables } from "../core/keywordQualify";
import type { QueryRunner, StatementResult } from "../core/queryRunner";
import type { ResultsPanel } from "./resultsPanel";
import type { ConnectionManager } from "../core/connectionManager";
import type { DbAdapter } from "../adapters/types";

/** Adapter surface used by qualifyKeywordTables + PG no-PK ctid detection. */
type AdapterWithTables = Pick<DbAdapter, "listTables" | "listColumns">;

/**
 * Pure per-dialect SELECT * FROM <schema>.<table> builder.
 *
 * Identifier quoting rules (doubling to escape delimiter char inside identifier):
 *   - postgres: `"` delimiter, escape by doubling `"` → `""`
 *   - mysql:     `` ` `` delimiter, escape by doubling `` ` `` → `` `` ``
 *   - mssql:     `[` / `]` delimiter, escape by doubling `]` → `]]`
 *
 * Empty schema → unqualified form (no prefix, just the quoted table identifier).
 * Never appends `;`.
 */
export function buildBrowseSelect(
  driver: ConnectionConfig["driver"],
  schema: string,
  table: string,
): string {
  const qualifiedTable = quoteForDriver(driver, table);
  const qualifiedSchema = schema ? quoteForDriver(driver, schema) : "";
  const tableRef = schema ? `${qualifiedSchema}.${qualifiedTable}` : qualifiedTable;
  return `SELECT * FROM ${tableRef}`;
}

function quoteForDriver(
  driver: ConnectionConfig["driver"],
  id: string,
): string {
  switch (driver) {
    case "postgres":
      return `"${id.replace(/"/g, '""')}"`;
    case "mysql":
      return '`' + id.replace(/`/g, "``") + '`';
    case "mssql":
      return '[' + id.replace(/]/g, "]]") + ']';
    default: {
      const _exhaustive: never = driver;
      void _exhaustive;
      throw new Error(`Unsupported driver: ${String(driver)}`);
    }
  }
}

interface BrowseNodeArg {
  meta?: {
    connection?: ConnectionConfig;
    schema?: string;
    objectName?: string;
  };
}

interface ResolvedBrowseNode {
  conn: ConnectionConfig;
  schema: string;
  table: string;
}

function resolveBrowseNode(arg: unknown): ResolvedBrowseNode | null {
  if (!arg || typeof arg !== "object") return null;
  const meta = (arg as BrowseNodeArg).meta;
  if (!meta || !meta.connection || !meta.schema || !meta.objectName) return null;
  return {
    conn: meta.connection,
    schema: meta.schema,
    table: meta.objectName,
  };
}

export interface RegisterBrowseDeps {
  mgr: ConnectionManager;
  runner: QueryRunner;
  panel: ResultsPanel;
}

/**
 * Safely fetch the active adapter. Returns null when no adapter is reachable
 * (no active connection, missing password, testConnect failure). Callers use
 * null to bypass adapter-dependent operations (like qualifyKeywordTables).
 */
async function maybeGetAdapter(
  mgr: ConnectionManager,
): Promise<AdapterWithTables | null> {
  try {
    const a = await mgr.getAdapter();
    return a ?? null;
  } catch {
    return null;
  }
}


/**
 * TASK-006 fix-round-1 — PG no-PK ctid augmentation.
 *
 * When the active driver is `postgres` AND the target table has no PRIMARY
 * KEY column (verified via `adapter.listColumns`), the result set of the
 * browse SELECT MUST carry a `ctid` column at a known index so the save
 * flow can address rows by exact ctid (no fragile value-match round-trip
 * for Date/numeric/boolean literals — the user-blocking bug).
 *
 * The cleanest, least-invasive shape is to wrap the original SELECT with a
 * subquery alias: `SELECT __v.*, ctid FROM (<originalSql>) __v`. The
 * Postgres alias `__v` is unique to this code path and the `ctid` is a
 * system column on every table — no ambiguity with user columns.
 *
 * Hand-written (non-browse) queries are NOT touched here — the save flow's
 * `fetchPostgresCtids` fallback remains the safety net.
 *
 * Best-effort: any failure (adapter unreachable, listColumns throws) returns
 * the original SQL unchanged so the user still sees the table; the save
 * flow's fallback handles the resulting ctid-less result set.
 */
async function maybeAppendCtidForNoPk(
  conn: ConnectionConfig,
  schema: string,
  table: string,
  rawSql: string,
  adapter: AdapterWithTables | null,
): Promise<string> {
  if (conn.driver !== "postgres" || adapter === null) return rawSql;
  try {
    const cols = await adapter.listColumns(table, schema || undefined);
    const hasPk = cols.some((c) => c.isPrimaryKey === true);
    if (hasPk) return rawSql;
  } catch {
    return rawSql;
  }
  // Wrap original SELECT so the alias only sees user columns and `ctid` is
  // a distinct system column. qualifyKeywordTables will run AFTER this
  // wrapper and still recognize the inner `"schema"."table"` as already
  // qualified (no rewrite happens for the wrapped shape).
  return `SELECT __vsdb_browse__.*, ctid FROM (${rawSql}) __vsdb_browse__`;
}

/**
 * Register the `vsdb.browseTableData` command.
 *
 * Steps:
 *  1. Resolve the VsdbNode arg (palette fallback → showInformationMessage).
 *  2. Align the active connection if the node's conn differs.
 *  3. Build the per-dialect SELECT.
 *  4. TASK-006 fix-round-1: when the driver is `postgres` AND the table
 *     has no PK column, wrap the SELECT with a subquery alias that adds
 *     the `ctid` system column. Save flow reads it directly to address
 *     rows — no value-match round-trip (was fragile on Date/numeric/boolean
 *     literal round-trip and produced the user-blocking
 *     "ctid lookup failed for every dirty row" banner on newly-created
 *     no-PK tables). Best-effort — adapter failure leaves SQL unchanged.
 *  5. TASK-007: apply qualifyKeywordTables via the active adapter
 *     (best-effort — falls back to raw SQL on adapter failure).
 *  6. Run via the standard `runner.run → panel.render` pipeline. No destructive
 *     confirm — generated SELECT is never dangerous.
 */
export function registerBrowseCommands(deps: RegisterBrowseDeps): void {
  const { mgr, runner, panel } = deps;
  vscode.commands.registerCommand(
    "vsdb.browseTableData",
    async (arg?: unknown) => {
      const resolved = resolveBrowseNode(arg);
      if (!resolved) {
        void vscode.window.showInformationMessage(
          "VSDB: Browse Table Data — open a table node from the schema tree.",
        );
        return;
      }
      const { conn, schema, table } = resolved;
      try {
        const active = mgr.getActive();
        if (!active || active.id !== conn.id) {
          await mgr.setActive(conn.id);
        }
        const rawSql = buildBrowseSelect(conn.driver, schema, table);
        // Fetch the adapter once — used by both qualifyKeywordTables (TASK-007)
        // and the PG no-PK ctid augmentation (TASK-006 fix-round-1). The
        // helper is best-effort: on adapter failure the original rawSql
        // passes through and the save flow's value-match fallback handles
        // the resulting ctid-less result set.
        const adapter = await maybeGetAdapter(mgr);
        const noPkSql = await maybeAppendCtidForNoPk(
          conn,
          schema,
          table,
          rawSql,
          adapter,
        );
        // TASK-007 — Apply qualifyKeywordTables so generated browse SQL keeps
        // the same defensive rewrite path as the editor submit path. The
        // qualifier works on the wrapped (no-PK) or raw SQL alike — the inner
        // SELECT * FROM "<schema>"."<table>" is already qualified, so no
        // rewrite happens for either shape.
        const sql = adapter
          ? (
              await qualifyKeywordTables(noPkSql, (s) =>
                adapter.listTables(s).then((rows) => rows.map((r) => r.name)),
              )
            ).sql
          : noPkSql;
        const stmt: ParsedStatement = { text: sql, start: 0, end: sql.length };
        const qualified = schema ? `${schema}.${table}` : table;
        const header = `Browse ${qualified} at ${new Date().toISOString()}`;
        panel.setBusy(true);
        const results: StatementResult[] = await runner.run([stmt], (current) => {
          panel.render(current, header);
        });
        panel.render(results, header);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`VSDB browseTableData failed: ${msg}`);
      } finally {
        panel.setBusy(false);
      }
    },
  );
}