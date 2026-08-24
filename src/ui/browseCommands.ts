// src/ui/browseCommands.ts
// TASK-001 — browseCommands module.
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
import type { QueryRunner, StatementResult } from "../core/queryRunner";
import type { ResultsPanel } from "./resultsPanel";
import type { ConnectionManager } from "../core/connectionManager";

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
  const qualifiedSchema = schema ? quoteForDriver(driver, schema) : "";
  const qualifiedTable = quoteForDriver(driver, table);
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
      return `\`${id.replace(/`/g, "``")}\``;
    case "mssql":
      return `[${id.replace(/]/g, "]]")}]`;
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
 * Register the `vsdb.browseTableData` command.
 *
 * Pipeline:
 *   1. resolve node arg → showInformationMessage + return if missing/invalid.
 *   2. If `meta.connection.id !== mgr.getActive()?.id` → await `mgr.setActive(id)`
 *      (ordering: setActive MUST complete BEFORE first `runner.run`).
 *   3. Build SELECT via `buildBrowseSelect(driver, schema, table)`.
 *   4. `panel.setBusy(true)` → `runner.run([stmt], onUpdate)` (where onUpdate
 *      re-renders the panel via `runner.getResults()`) → final `panel.render`
 *      with the resolved results.
 *   5. On any error: `showErrorMessage(<message>)`. `panel.setBusy(false)` in
 *      `finally` to release the busy state on both success and failure paths.
 *
 * Note: `confirmDangerousStatements` is intentionally SKIPPED — the generated
 * statement is a `SELECT *`, `guardTier` can never fire.
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
        const sql = buildBrowseSelect(conn.driver, schema, table);
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