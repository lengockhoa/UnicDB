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
import { rowsToSpec } from "../core/ddl/pgIntrospect";
import { AiConfigStore } from "../ai/config";
import { createProviderClient } from "../ai/provider";
import {
  aiGenerateSampleData,
  pickInsertableColumns,
  type SampleColumn,
} from "./sampleDataAi";
import { NewTableForm } from "./newTableForm";
import { SchemaForm } from "./schemaForm";
import { buildPostmanPayload } from "./postmanPayload";
import {
  SchemaTreeProvider,
  revealTableNode,
  revealSchemaNode,
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
  createSchema: "Create Schema",
  postmanPayload: "Postman Payload",
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
  // Path: adapter.listTableDetail(schema, table) — PostgresAdapter bind $1/$2
  // qua pool.query. runQuery single-SELECT sẽ route qua cursor (trả empty)
  // và không bind params → production fail (fix round 1 CRITICAL #1).
  const adapter = await mgr.getAdapterFor(conn);
  const detail = await adapter.listTableDetail(schema, table);
  const columns: PgColumnRowInput[] = detail.columns.map((r) => ({
    column_name: r.column_name,
    format_type: r.format_type,
    is_nullable: r.is_nullable,
    column_default: r.column_default,
  }));
  const constraints: PgConstraintRowInput[] = detail.constraints.map((r) => ({
    conname: r.conname,
    contype: r.contype as "p" | "u" | "f" | "c",
    conkey: r.conkey,
    confrelidname: r.confrelidname,
    confkeycols: r.confkeycols,
    consrc: r.consrc,
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
      // Category check: accept "tables" (Tables category node) HOẶC "columns"
      // (table node đã mở rộng → category children). Views/Routines → Information.
      if (
        resolved.category &&
        resolved.category !== "tables" &&
        resolved.category !== "columns"
      ) {
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
        runDdl: async (sql: string, spec) => {
          try {
            await runDdl(mgr, conn, sql);
            tree.refresh();
            // spec.name từ form (KHÔNG regex SQL string — fix round 1 minor).
            const createdName = spec.name;
            await revealTableNode(treeView, conn, schema, createdName);
            void vscode.window.showInformationMessage(
              `Created ${schema}.${createdName}`,
            );
          } catch (err) {
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
        runDdl: async (sql: string, _spec) => {
          try {
            await runDdl(mgr, conn, sql);
            tree.refresh();
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

  // vsdb.generateSampleData — TASK-006 AI-driven flow (work model).
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
        const parsed = Number.parseInt(input, 10);
        if (Number.isNaN(parsed) || parsed <= 0) {
          void vscode.window.showInformationMessage(
            "Enter a positive number",
          );
          return;
        }
        const n = Math.min(100, parsed);

        const cfg = await new AiConfigStore(context).loadConfig();
        if (!cfg) {
          void vscode.window.showInformationMessage(
            "VSDB: AI not configured. Open settings.",
          );
          await vscode.commands.executeCommand("vsdb.openAiSettings");
          return;
        }

        let columns: SampleColumn[];
        try {
          const detail = await introspectTable(mgr, conn, schema, table);
          columns = detail.columns.map((r) => ({
            name: r.column_name,
            type: r.format_type,
            nullable: r.is_nullable === "YES",
            default: r.column_default,
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Generate Sample Data failed: ${msg}`,
          );
          return;
        }

        const insertable = pickInsertableColumns(table, columns);
        if (insertable.length === 0) {
          void vscode.window.showInformationMessage(
            `VSDB: nothing to insert into ${schema}.${table}`,
          );
          return;
        }

        const provider = createProviderClient({
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          method: cfg.method,
          timeoutMs: cfg.timeoutMs,
        });

        try {
          await aiGenerateSampleData({
            cfg,
            conn,
            schema,
            table,
            n,
            columns: insertable,
            complete: (req) => provider.complete(req),
            getAdapterFor: () => mgr.getAdapterFor(conn),
            showInfo: (m) => {
              void vscode.window.showInformationMessage(m);
            },
            showError: (m) => {
              void vscode.window.showErrorMessage(m);
            },
          });
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
  // TASK-003 — vsdb.createSchema: open SchemaForm on connection/schema node.
  // node arg meta.connection (connection node) → that conn; schema node passes
  // meta.connection too (schema meta = {connection, schema}). palette (no arg)
  // → fall back to mgr.getActive(); null → info message.
  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.createSchema", async (arg?: unknown) => {
      // Resolve target conn.
      let conn: ConnectionConfig | null = null;
      if (arg && typeof arg === "object") {
        const meta = (arg as {
          meta?: { connection?: ConnectionConfig };
        }).meta;
        if (meta?.connection) conn = meta.connection;
      }
      if (!conn) conn = mgr.getActive();
      if (!conn) {
        void vscode.window.showInformationMessage(
          "Create Schema: no active connection. Select one first.",
        );
        return;
      }
      if (conn.driver !== "postgres") {
        void vscode.window.showInformationMessage(
          `${COMMAND_TITLE.createSchema}: PostgreSQL connections only`,
        );
        return;
      }

      const form = new SchemaForm({
        extensionUri: context.extensionUri,
        listSchemaNames: async () => {
          const adapter = await mgr.getAdapterFor(conn);
          const schemas = await adapter.listSchemas(true);
          return schemas.map((s) => s.name);
        },
        runDdl: async (sql, _name) => {
          const adapter = await mgr.getAdapterFor(conn);
          await adapter.runQuery(sql);
        },
        onOk: async (sql, name) => {
          tree.refresh();
          await revealSchemaNode(treeView, conn, name);
          void vscode.window.showInformationMessage(
            `VSDB: schema "${name}" created`,
          );
        },
        onError: (msg) => {
          void vscode.window.showErrorMessage(msg);
        },
      });
      form.show();
    }),
  );
  // TASK-008 — vsdb.postmanPayload: copy JS object literal for table/view/
  // routine node. Schema + table/view/routine name are JSON-quoted strings;
  // columns are emitted as `jsKey: this.workingObj.<col>` (bracket-access for
  // non-identifier keys). MySQL/MSSQL → info message, no clipboard write.
  // Routine nodes resolve columns via adapter.listRoutineParams (pg
  // proallargtypes / proargnames); table + view both use listColumns
  // (information_schema covers view output columns).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vsdb.postmanPayload",
      async (arg?: unknown) => {
        if (!arg || typeof arg !== "object") return;
        const node = arg as { contextValue?: string; meta?: { connection?: ConnectionConfig; schema?: string; objectName?: string } };
        if (!node.meta?.connection || !node.meta.schema) return;
        const guarded = guardPostgres(
          resolveTableNode(arg),
          "postmanPayload",
        );
        if (!guarded) return;
        const { conn, schema, table: name } = guarded;
        if (name === "") return;

        try {
          const adapter = await mgr.getAdapterFor(conn);
          const isRoutine = node.contextValue === "routine";
          const columnNames: string[] = isRoutine
            ? (await adapter.listRoutineParams(schema, name)).map(
                (p) => p.name ?? "",
              )
            : (await adapter.listColumns(name, schema)).map((c) => c.name);
          const payload = buildPostmanPayload(schema, name, columnNames);
          await vscode.env.clipboard.writeText(payload);
          void vscode.window.setStatusBarMessage(
            "VSDB: Postman payload copied",
            2000,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Postman Payload failed: ${msg}`,
          );
        }
      },
    ),
  );
}

export type { VsdbNode };
