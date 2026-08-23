// src/ui/tableCommands.ts
// TASK-005 — Wires 6 schema-tree commands:
//   vsdb.newTable          — open NewTableForm (create mode) on schema/category/table node
//   vsdb.modifyTable       — open NewTableForm (modify mode) on table node
//   vsdb.copyCreateDdl     — introspect table → generateCreateTable → clipboard
//   vsdb.generateSampleData — input N → introspect → generateSampleInserts → untitled SQL doc
//   vsdb.analyzeTable      — ANALYZE <schema>.<table>
//   vsdb.vacuumTable       — VACUUM ANALYZE <schema>.<table>
//
// All commands share the same guards:
//   1. node.meta hợp lệ → resolve {conn, schema, table?}
//   2. driver === "postgres" → else showInformationMessage "<Title>: PostgreSQL connections only"
//   3. category hợp lệ (newTable requires "tables") → else showInformationMessage mentioning "Tables"
//   4. Run DDL qua mgr.getAdapterFor(conn).runQuery, never QueryRunner
//   5. After OK: tree.refresh() + revealTableNode(treeView, conn, schema, table) + notification
//   6. On error: showErrorMessage "<Title> failed: <msg>" (no refresh, no reveal)
//
// `registerTableCommands(deps)` exported — extension.ts calls it at activate.
// This shape keeps the commands testable in isolation (tableCommands.test.ts).

import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import {
  generateCreateTable,
  defaultColumnSpecs,
} from "../core/ddl/createTable";
import { alwaysQuote } from "../core/ddl/alterTable";
import {
  INTROSPECT_COLUMNS_SQL,
  INTROSPECT_CONSTRAINTS_SQL,
  rowsToSpec,
} from "../core/ddl/pgIntrospect";
import { generateSampleInserts } from "../core/ddl/sampleData";
import { NewTableForm } from "./newTableForm";
import {
  SchemaTreeProvider,
  revealTableNode,
  registerSchemaTreeProvider,
  type VsdbNode,
} from "./schemaTree";

interface ResolvedTableNode {
  conn: ConnectionConfig;
  schema: string;
  table: string;
  category?: string;
}

function resolveTableNode(arg: unknown): ResolvedTableNode | null {
  if (!arg || typeof arg !== "object") return null;
  const meta = (arg as {
    meta?: {
      connection?: ConnectionConfig;
      schema?: string;
      objectName?: string;
      category?: string;
    };
  }).meta;
  if (!meta || !meta.connection || !meta.schema) return null;
  return {
    conn: meta.connection,
    schema: meta.schema,
    table: meta.objectName ?? "",
    category: meta.category,
  };
}

const COMMAND_TITLE: Record<string, string> = {
  newTable: "New Table",
  modifyTable: "Modify Table",
  copyCreateDdl: "Copy CREATE DDL",
  generateSampleData: "Generate Sample Data",
  analyzeTable: "Analyze Table",
  vacuumTable: "Vacuum Table",
};

interface GuardedTarget {
  conn: ConnectionConfig;
  schema: string;
  table: string;
}

interface RegisterDeps {
  mgr: ConnectionManager;
  tree: SchemaTreeProvider;
  treeView: vscode.TreeView<unknown>;
  context: vscode.ExtensionContext;
}

async function runDdl(
  mgr: ConnectionManager,
  conn: ConnectionConfig,
  sql: string,
): Promise<void> {
  const adapter = await mgr.getAdapterFor(conn);
  await adapter.runQuery(sql);
}

/** Guard: meta + driver. Trả null nếu pass hoặc đã hiển thị message. */
function guardPostgres(
  resolved: ResolvedTableNode | null,
  command: keyof typeof COMMAND_TITLE,
): GuardedTarget | null {
  if (!resolved) return null;
  const title = COMMAND_TITLE[command];
  if (resolved.conn.driver !== "postgres") {
    void vscode.window.showInformationMessage(
      `${title}: PostgreSQL connections only`,
    );
    return null;
  }
  return {
    conn: resolved.conn,
    schema: resolved.schema,
    table: resolved.table,
  };
}

interface PgColumnRowInput {
  column_name: string;
  format_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}
interface PgConstraintRowInput {
  conname: string;
  contype: "p" | "u" | "f" | "c";
  conkey: number[];
  confrelidname: string | null;
  confkeycols: string[] | null;
  consrc: string;
}

async function introspectTable(
  mgr: ConnectionManager,
  conn: ConnectionConfig,
  schema: string,
  table: string,
): Promise<{
  columns: PgColumnRowInput[];
  constraints: PgConstraintRowInput[];
}> {
  const adapter = await mgr.getAdapterFor(conn);
  const colsRes = await adapter.runQuery(INTROSPECT_COLUMNS_SQL(schema, table));
  const consRes = await adapter.runQuery(
    INTROSPECT_CONSTRAINTS_SQL(schema, table),
  );
  const columns: PgColumnRowInput[] = (colsRes.results[0]?.rows ?? []).map(
    (r) => ({
      column_name: r[0] as string,
      format_type: r[1] as string,
      is_nullable: r[2] as "YES" | "NO",
      column_default: r[3] as string | null,
    }),
  );
  const constraints: PgConstraintRowInput[] = (
    consRes.results[0]?.rows ?? []
  ).map((r) => ({
    conname: r[0] as string,
    contype: r[1] as "p" | "u" | "f" | "c",
    conkey: r[2] as number[],
    confrelidname: r[3] as string | null,
    confkeycols: r[4] as string[] | null,
    consrc: r[5] as string,
  }));
  return { columns, constraints };
}

export function registerTableCommands(deps: RegisterDeps): void {
  const { mgr, tree, treeView, context } = deps;
  registerSchemaTreeProvider(tree);

  // vsdb.newTable — schema/category (tables only)/table node.
  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.newTable", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      // Category check: chỉ accept "tables" (Views/Routines → Information).
      if (resolved.category && resolved.category !== "tables") {
        void vscode.window.showInformationMessage(
          "New Table: open the Tables category to create a table.",
        );
        return;
      }
      const guarded = guardPostgres(resolved, "newTable");
      if (!guarded) return;

      const { conn, schema } = guarded;
      const initialName = "table_name";

      const form = new NewTableForm({
        extensionUri: context.extensionUri,
        mode: "create",
        schema,
        loadSpec: async () => ({
          name: initialName,
          schema,
          columns: defaultColumnSpecs(initialName),
          keys: [],
        }),
        runDdl: async (sql: string) => {
          try {
            console.log('DEBUG runDdl: start', sql.slice(0, 30));
            await runDdl(mgr, conn, sql);
            console.log('DEBUG runDdl: after runQuery');
            tree.refresh();
            console.log('DEBUG runDdl: after refresh');
            const m = sql.match(/CREATE TABLE\s+(?:"[^"]+"\.)?"([^"]+)"/i);
            const createdName = m ? m[1] : initialName;
            await revealTableNode(treeView, conn, schema, createdName);
            console.log('DEBUG runDdl: after reveal');
            void vscode.window.showInformationMessage(
              `Created ${schema}.${createdName}`,
            );
          } catch (err) {
            console.log('DEBUG runDdl: caught error', err);
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`New Table failed: ${msg}`);
          }
        },
      });
      form.show();
    }),
  );

  // vsdb.modifyTable — table nodes only.
  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.modifyTable", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      const guarded = guardPostgres(resolved, "modifyTable");
      if (!guarded) return;
      const { conn, schema, table } = guarded;
      if (table === "") return;

      const form = new NewTableForm({
        extensionUri: context.extensionUri,
        mode: "modify",
        schema,
        originalTableName: table,
        loadSpec: async () => {
          const { columns, constraints } = await introspectTable(
            mgr,
            conn,
            schema,
            table,
          );
          return rowsToSpec(schema, table, columns, constraints);
        },
        runDdl: async (sql: string) => {
          try {
            console.log('DEBUG runDdl: start', sql.slice(0, 30));
            await runDdl(mgr, conn, sql);
            console.log('DEBUG runDdl: after runQuery');
            tree.refresh();
            console.log('DEBUG runDdl: after refresh');
            await revealTableNode(treeView, conn, schema, table);
            void vscode.window.showInformationMessage(
              `Modified ${schema}.${table}`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`Modify Table failed: ${msg}`);
          }
        },
      });
      form.show();
    }),
  );

  // vsdb.copyCreateDdl — table nodes only.
  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.copyCreateDdl", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      const guarded = guardPostgres(resolved, "copyCreateDdl");
      if (!guarded) return;
      const { conn, schema, table } = guarded;
      if (table === "") return;

      try {
        const { columns, constraints } = await introspectTable(
          mgr,
          conn,
          schema,
          table,
        );
        const spec = rowsToSpec(schema, table, columns, constraints);
        const ddl = generateCreateTable(spec);
        await vscode.env.clipboard.writeText(ddl);
        void vscode.window.setStatusBarMessage("VSDB: DDL copied", 2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Copy CREATE DDL failed: ${msg}`);
      }
    }),
  );

  // vsdb.generateSampleData — table nodes only.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vsdb.generateSampleData",
      async (arg?: unknown) => {
        const resolved = resolveTableNode(arg);
        if (!resolved) return;
        const guarded = guardPostgres(resolved, "generateSampleData");
        if (!guarded) return;
        const { conn, schema, table } = guarded;
        if (table === "") return;

        const input = await vscode.window.showInputBox({
          prompt: "Number of rows",
          value: "10",
        });
        if (input === undefined) return;
        const n = Number.parseInt(input, 10);
        if (Number.isNaN(n) || n < 0) {
          void vscode.window.showInformationMessage(
            "Enter a positive number",
          );
          return;
        }
        const clamped = Math.max(0, Math.min(1000, n));

        try {
          const { columns, constraints } = await introspectTable(
            mgr,
            conn,
            schema,
            table,
          );
          const spec = rowsToSpec(schema, table, columns, constraints);
          const content = generateSampleInserts(spec, clamped);
          if (content === "") return;
          const doc = await vscode.workspace.openTextDocument({
            language: "sql",
            content,
          });
          await vscode.window.showTextDocument(doc);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Generate Sample Data failed: ${msg}`,
          );
        }
      },
    ),
  );

  // ANALYZE / VACUUM cần always-quote (giống ALTER TABLE style).
  const qualified = (schema: string, table: string): string =>
    `${alwaysQuote(schema)}.${alwaysQuote(table)}`;

  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.analyzeTable", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      const guarded = guardPostgres(resolved, "analyzeTable");
      if (!guarded) return;
      const { conn, schema, table } = guarded;
      if (table === "") return;

      try {
        await runDdl(mgr, conn, `ANALYZE ${qualified(schema, table)}`);
        void vscode.window.showInformationMessage(
          `${schema}.${table} analyzed`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Analyze Table failed: ${msg}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.vacuumTable", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      const guarded = guardPostgres(resolved, "vacuumTable");
      if (!guarded) return;
      const { conn, schema, table } = guarded;
      if (table === "") return;

      try {
        await runDdl(mgr, conn, `VACUUM ANALYZE ${qualified(schema, table)}`);
        void vscode.window.showInformationMessage(
          `${schema}.${table} vacuumed`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Vacuum Table failed: ${msg}`);
      }
    }),
  );
}

export type { VsdbNode };
