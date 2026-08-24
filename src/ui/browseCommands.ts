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

/** Adapter surface needed by qualifyKeywordTables (only listTables). */
type AdapterWithTables = Pick<DbAdapter, "listTables">;

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
 * Register the `vsdb.browseTableData` command.
 *
 * Steps:
 *  1. Resolve the VsdbNode arg (palette fallback → showInformationMessage).
 *  2. Align the active connection if the node's conn differs.
 *  3. Build the per-dialect SELECT.
 *  4. TASK-007: apply qualifyKeywordTables via the active adapter
 *     (best-effort — falls back to raw SQL on adapter failure).
 *  5. Run via the standard `runner.run → panel.render` pipeline. No destructive
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
        // TASK-007 — Apply qualifyKeywordTables so generated browse SQL keeps
        // the same defensive rewrite path as the editor submit path.
        const adapter = await maybeGetAdapter(mgr);
        const sql = adapter
          ? (
              await qualifyKeywordTables(rawSql, (s) =>
                adapter.listTables(s).then((rows) => rows.map((r) => r.name)),
              )
            ).sql
          : rawSql;
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