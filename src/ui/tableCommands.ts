// src/ui/tableCommands.ts
// TASK-005 — Wires 6 schema-tree commands:
//   vsdb.newTable          — open NewTableForm (create mode) on schema/category/table node
//   vsdb.modifyTable       — open NewTableForm (modify mode) on table node
//   vsdb.copyCreateDdl     — introspect table → generateCreateTable → clipboard
//   vsdb.generateSampleData — TASK-UX1-003: open the VSDB Console with typed
//                             INSERT templates (manual execution). The
//                             AI-driven flow is preserved as a module
//                             export (`aiGenerateSampleData` in
//                             src/ui/sampleDataAi.ts) for power users;
//                             only the menu default changed.
//   vsdb.analyzeTable      — ANALYZE <schema>.<table>
//   vsdb.vacuumTable       — VACUUM ANALYZE <schema>.<table>
//
// All commands share the same guards:
//   1. node.meta hợp lệ → resolve {conn, schema, table?}
//   2. DBX-08 — resolved adapter declares tableDdl (hasAdapterCapability,
//      fail-closed) → else concise `VSDB: <Title> is not supported…` message
//      BEFORE any form/SQL/AI/clipboard side effect
//   3. category hợp lệ (newTable requires "tables") → else showInformationMessage mentioning "Tables"
//   4. Run DDL qua mgr.getAdapterFor(conn).runQuery, never QueryRunner
//   5. After OK: tree.refresh() + revealTableNode(treeView, conn, schema, table) + notification
//   6. On error: showErrorMessage "<Title> failed: <msg>" (no refresh, no reveal)
//
// `registerTableCommands(deps)` exported — extension.ts calls it at activate.
// This shape keeps the commands testable in isolation (tableCommands.test.ts).
// `buildInsertTemplate(columns, opts)` is a pure export for tests + future
// callers (UX1-004 guide will reference it).

import * as vscode from "vscode";
import type { ConnectionConfig } from "../config/types";
import type { ConnectionManager } from "../core/connectionManager";
import { hasAdapterCapability, type DbAdapter } from "../adapters/types";
import {
  generateCreateTable,
  defaultColumnSpecs,
} from "../core/ddl/createTable";
import { alwaysQuote } from "../core/ddl/alterTable";
import { rowsToSpec } from "../core/ddl/pgIntrospect";
import type { SqlDialect } from "../core/statementParser";
// TASK-UX1-003 — the menu default for vsdb.generateSampleData no longer
// routes through the AI config / provider / orchestrator. The AI module
// (sampleDataAi.ts) stays importable + unit-tested; we still use
// `pickInsertableColumns` for the upstream identity/sequence filter so
// generated INSERT templates skip columns the DB will fill in itself.
import {
  pickInsertableColumns,
  type SampleColumn,
} from "./sampleDataAi";
import { NewTableForm } from "./newTableForm";
import { RenameForm } from "./renameForm";
import { SchemaForm } from "./schemaForm";
import { buildPostmanPayload } from "./postmanPayload";
import { buildTableStructure, buildViewStructure, buildDatabaseStructure, type ExportColumn } from "./exportStructure";
import {
  SchemaTreeProvider,
  revealTableNode,
  revealSchemaNode,
  registerSchemaTreeProvider,
  type VsdbNode,
} from "./schemaTree";
// TASK-UX1-003 — the console-seeding seam is an optional `openConsoleWithTemplate`
// field on RegisterDeps (injected by extension.ts at activate time). This
// avoids a circular import (extension.ts depends on tableCommands via
// `registerTableCommands`; the reverse direction would create a load-time
// cycle that resolves to `undefined`). The seam calls the same singleton +
// onRun + draft/autocomplete path that `vsdb.openConsole` /
// `vsdb.openConsoleForObject` already use.
interface ResolvedTableNode {
  conn: ConnectionConfig;
  schema: string;
  table: string;
  category?: string;
  /** Column node arg: the column name (else ""). */
  column?: string;
}

export function resolveTableNode(arg: unknown): ResolvedTableNode | null {
  if (!arg || typeof arg !== "object") return null;
  const meta = (arg as {
    meta?: {
      connection?: ConnectionConfig;
      schema?: string;
      objectName?: string;
      objectKey?: string;
      category?: string;
      column?: { name?: string };
    };
  }).meta;
  if (!meta || !meta.connection || !meta.schema) return null;
  // Table nodes carry objectName; column nodes carry objectKey
  // ("connId.schema.table") instead. Fall back so renameColumn works from
  // a column context-menu item.
  // Column nodes carry the parent table name in meta.objectName (set by
  // schemaTree.getColumnChildren) — never parse objectKey, which is lossy
  // for quoted table identifiers containing dots.
  return {
    conn: meta.connection,
    schema: meta.schema,
    table: meta.objectName ?? "",
    category: meta.category,
    column: meta.column?.name ?? "",
  };
}

const COMMAND_TITLE: Record<string, string> = {
  newTable: "New Table",
  modifyTable: "Modify Table",
  renameTable: "Rename Table",
  renameColumn: "Rename Column",
  copyCreateDdl: "Copy Create Query",
  generateSampleData: "Generate Sample Data",
  analyzeTable: "Analyze Table",
  vacuumTable: "Vacuum Table",
  createSchema: "Create Schema",
  postmanPayload: "Postman Payload",
  exportStructure: "Export Structure",
  exportAllStructures: "Export All Structures",
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
  /**
   * TASK-CL-002 — ARP-07 invalidation wiring. Optional injected seam fired
   * PER successful form-view DDL statement (after `await adapter.runQuery`
   * resolves). NEVER fires on the error path. The dialect is derived locally
   * from `conn.driver` exactly the same way extension.ts:131-135 narrows
   * `DriverType → SqlDialect` (bigquery → `undefined`). Optional: callers
   * that omit it keep the pre-CL-002 behavior byte-identical.
   */
  onSchemaDdl?: (statements: readonly string[], dialect?: SqlDialect) => void;
  /**
   * TASK-UX1-003 — console-seeding seam. Optional injected helper that opens
   * the VSDB Console singleton (or its seeded tab in an existing instance)
   * pre-filled with `buffer`. Wired by extension.ts to call the same
   * `commandOpenConsole` + `consolePanel.seedTab(name, buffer)` + `show()`
   * pattern already used by `vsdb.openConsole` / `vsdb.openConsoleForObject`.
   * Optional: callers (tests) that omit it keep the console template path
   * silent — the menu default still produces the SQL buffer (assertable via
   * the `buildInsertTemplate` pure export) but does not open the Console.
   */
  openConsoleWithTemplate?: (name: string, buffer: string) => void;
}

// TASK-CL-002 — local `DriverType → SqlDialect` narrowing mirroring
// extension.ts:131-135. BigQuery has no SqlDialect and the BQ runQuery path
// owns its own SQL handling; locally `undefined` here matches the host's
// `toSqlDialect` so the closure stays the single source of truth at the
// module seam, but we mirror the narrowing here to avoid crossing the
// tableCommands boundary to call into the host on every form DDL.
function toLocalSqlDialect(
  driver: ConnectionConfig["driver"] | undefined,
): SqlDialect | undefined {
  return driver === "bigquery" ? undefined : driver;
}

async function runDdl(
  mgr: ConnectionManager,
  conn: ConnectionConfig,
  sql: string,
  onSchemaDdl?: (statements: readonly string[], dialect?: SqlDialect) => void,
): Promise<void> {
  const adapter = await mgr.getAdapterFor(conn);
  await adapter.runQuery(sql);
  // TASK-CL-002 — fire the seam PER successful statement, NEVER on the
  // error path (the await above would have thrown and skipped this line).
  onSchemaDdl?.([sql], toLocalSqlDialect(conn.driver));
}

/** Guard: meta + driver. Trả null nếu pass hoặc đã hiển thị message. */
async function guardPostgres(
  mgr: ConnectionManager,
  resolved: ResolvedTableNode | null,
  command: keyof typeof COMMAND_TITLE,
): Promise<GuardedTarget | null> {
  if (!resolved) return null;
  const title = COMMAND_TITLE[command];
  // DBX-08 — admission is the DECLARED tableDdl capability of the exact
  // target adapter, never `driver === "postgres"`. Resolve the adapter first;
  // false/missing declaration → concise VSDB message, zero side effects.
  let adapter: DbAdapter | null = null;
  try {
    adapter = await mgr.getAdapterFor(resolved.conn);
  } catch {
    adapter = null;
  }
  if (!hasAdapterCapability(adapter, "tableDdl")) {
    void vscode.window.showInformationMessage(
      `VSDB: ${title} is not supported by this connection's database.`,
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

// TASK-UX1-003 — buildInsertTemplate: pure helper exported for tests +
// UX1-004 guide. Renders a SQL string of `rows` INSERT statements against
// `schema.table` using type-specific placeholder values. The user is
// expected to edit values before running. Default 5 rows; rows > 20 are
// capped at 20; rows <= 0 → header comment only (zero INSERT statements).
export interface BuildInsertTemplateOpts {
  schema: string;
  table: string;
  rows?: number;
}

/** Quote an identifier for safe injection into a generated SQL template. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Render one placeholder value for a column. NOT NULL text columns get a
 * `'Sample <col>'` literal (never NULL — would violate the constraint).
 * Nullable text → NULL (the user can replace with a literal). Unknown /
 * exotic types render a commented-out NULL so the statement still parses
 * (e.g. `/* bytea *\/ NULL`). The user must hand-edit before running.
 */
function placeholderFor(c: SampleColumn): string {
  const t = c.type.trim().toLowerCase();
  // Arrays — leading underscore in pg (e.g. `_int4`). Always commented
  // placeholder; user supplies an array literal.
  if (t.startsWith("_")) return `/* array */ NULL`;
  // JSON family.
  if (t === "jsonb" || t === "json") return `'{}'::${c.type}`;
  // Bytea — binary, leave commented placeholder.
  if (t === "bytea") return `/* bytea */ NULL`;
  // USER-DEFINED (enum / domain) — user must supply a valid literal.
  if (t === "user-defined") return `/* ${c.type} */ NULL`;
  // Numeric family (incl. precision/scale). Bare 0 keeps any numeric valid.
  if (
    t === "integer" ||
    t === "bigint" ||
    t === "smallint" ||
    t === "numeric" ||
    t === "real" ||
    t === "double precision" ||
    /^numeric\s*\(/.test(t) ||
    /^decimal\s*\(/.test(t)
  ) {
    return "0";
  }
  // Boolean.
  if (t === "boolean" || t === "bool") return "true";
  // Date / time family.
  if (
    t === "timestamp" ||
    t === "timestamp without time zone" ||
    t === "timestamptz" ||
    t === "timestamp with time zone" ||
    t === "date" ||
    t === "time" ||
    t === "time without time zone" ||
    t === "timetz" ||
    t === "time with time zone" ||
    t === "interval"
  ) {
    return "NOW()";
  }
  // Text / character family. NOT NULL → literal placeholder; nullable →
  // NULL (user can replace).
  if (
    t === "text" ||
    t === "varchar" ||
    t === "character varying" ||
    t === "char" ||
    t === "character" ||
    /^varchar\s*\(/.test(t) ||
    /^character varying\s*\(/.test(t) ||
    /^char\s*\(/.test(t) ||
    /^character\s*\(/.test(t)
  ) {
    if (!c.nullable) return `'Sample ${c.name}'`;
    return "NULL";
  }
  // UUID.
  if (t === "uuid") {
    return c.nullable
      ? "NULL"
      : "'00000000-0000-0000-0000-000000000000'";
  }
  // Fallback: commented NULL so the statement still parses; user edits.
  return `/* ${c.type || "unknown"} */ NULL`;
}

/** Render a single `INSERT INTO ... VALUES (...);` statement. */
function renderInsert(
  schema: string,
  table: string,
  insertable: SampleColumn[],
): string {
  const qSchema = quoteIdent(schema);
  const qTable = quoteIdent(table);
  const colList = insertable.map((c) => quoteIdent(c.name)).join(",");
  const valList = insertable.map((c) => placeholderFor(c)).join(", ");
  return `INSERT INTO ${qSchema}.${qTable} (${colList}) VALUES (${valList});`;
}

/**
 * Build a SQL string of `rows` INSERT templates for `schema.table`. Pure
 * (no vscode imports) — unit-tested in tableCommands.test.ts.
 *
 * Behaviour:
 *   - `rows` defaults to 5; values > 20 cap at 20; values <= 0 yield a
 *     header comment only (zero INSERT statements).
 *   - Empty `columns` → header comment only.
 *   - The header explains how to use the template (manual execution).
 *   - Output always ends with a single trailing newline.
 */
export function buildInsertTemplate(
  columns: SampleColumn[],
  opts: BuildInsertTemplateOpts,
): string {
  const rawRows = opts.rows ?? 5;
  const rows = Math.max(0, Math.min(20, Math.floor(rawRows)));
  const qSchema = quoteIdent(opts.schema);
  const qTable = quoteIdent(opts.table);
  // Header is a no-op comment block; the bare `;` on its own line terminates
  // the comment block as its own statement so the SQL splitter doesn't
  // merge the comment with the first INSERT below. PG ignores the empty
  // statement when the user runs the buffer (the Console parses + skips
  // empty statements before execution).
  const header = [
    `-- VSDB: Insert Sample Data template for ${qSchema}.${qTable}`,
    `-- Edit values, then run. ${rows === 0 ? "No insertable columns detected." : `${rows} placeholder INSERT statement(s); the user edits + runs manually.`}`,
    `;`,
    ``,
  ].join("\n");
  if (rows === 0 || columns.length === 0) {
    if (columns.length === 0) {
      return (
        header +
        `-- (no insertable columns after filtering identity / created_at / nextval-default)\n`
      );
    }
    return header;
  }
  const statements: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    statements.push(renderInsert(opts.schema, opts.table, columns));
  }
  return header + statements.join("\n") + "\n";
}

export function registerTableCommands(deps: RegisterDeps): void {
  const { mgr, tree, treeView, context, onSchemaDdl, openConsoleWithTemplate } = deps;
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
      const guarded = await guardPostgres(mgr, resolved, "newTable");
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
            await runDdl(mgr, conn, sql, onSchemaDdl);
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
      const guarded = await guardPostgres(mgr, resolved, "modifyTable");
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
            await runDdl(mgr, conn, sql, onSchemaDdl);
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
      const guarded = await guardPostgres(mgr, resolved, "copyCreateDdl");
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
        void vscode.window.showErrorMessage(`Copy Create Query failed: ${msg}`);
      }
    }),
  );

  // vsdb.generateSampleData — TASK-UX1-003: open the VSDB Console with a
  // pre-filled buffer of typed INSERT templates (default 5 rows). The user
  // reviews + edits + runs manually — no AI config / provider / row-count
  // prompt on the default path. The AI-driven module (sampleDataAi.ts)
  // remains importable for power users; only the menu default changed.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vsdb.generateSampleData",
      async (arg?: unknown) => {
        const resolved = resolveTableNode(arg);
        if (!resolved) return;
        const guarded = await guardPostgres(mgr, resolved, "generateSampleData");
        if (!guarded) return;
        const { conn, schema, table } = guarded;
        if (table === "") return;

        let detail: Awaited<ReturnType<typeof introspectTable>>;
        try {
          detail = await introspectTable(mgr, conn, schema, table);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Insert Sample Data failed: ${msg}`,
          );
          return;
        }
        const columns: SampleColumn[] = detail.columns.map((r) => ({
          name: r.column_name,
          type: r.format_type,
          nullable: r.is_nullable === "YES",
          default: r.column_default,
        }));
        const insertable = pickInsertableColumns(table, columns);
        const buffer = buildInsertTemplate(insertable, {
          schema,
          table,
        });
        if (typeof openConsoleWithTemplate === "function") {
          openConsoleWithTemplate(`Sample ${schema}.${table}`, buffer);
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
      const guarded = await guardPostgres(mgr, resolved, "analyzeTable");
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
      const guarded = await guardPostgres(mgr, resolved, "vacuumTable");
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

  // DBX-06 — vsdb.renameTable: safe rename dialog (table nodes, PG only).
  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.renameTable", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      const guarded = await guardPostgres(mgr, resolved, "renameTable");
      if (!guarded) return;
      const { conn, schema, table } = guarded;
      if (table === "") return;
      const form = new RenameForm({
        extensionUri: context.extensionUri,
        mode: "table",
        schema,
        table,
        oldName: table,
        mgr,
        conn,
        onRenamed: async (newName) => {
          tree.refresh();
          await revealTableNode(treeView, conn, schema, newName);
        },
      });
      form.show();
    }),
  );

  // DBX-06 — vsdb.renameColumn:
  //   - column-tree node: resolved.column → use directly (no QuickPick).
  //   - table-tree node / palette: introspectTable + QuickPick (fallback).
  context.subscriptions.push(
    vscode.commands.registerCommand("vsdb.renameColumn", async (arg?: unknown) => {
      const resolved = resolveTableNode(arg);
      if (!resolved) return;
      const guarded = await guardPostgres(mgr, resolved, "renameColumn");
      if (!guarded) return;
      const { conn, schema, table } = guarded;
      if (table === "") return;
      let picked = resolved.column ?? "";
      try {
        if (picked === "") {
          const { columns } = await introspectTable(mgr, conn, schema, table);
          const names = columns.map((c) => c.column_name);
          picked =
            (await vscode.window.showQuickPick(names, {
              placeHolder: `Select column to rename on ${schema}.${table}`,
            })) ?? "";
        }
        if (picked === "") return;
        const form = new RenameForm({
          extensionUri: context.extensionUri,
          mode: "column",
          schema,
          table,
          oldName: picked,
          mgr,
          conn,
          onRenamed: async () => {
            tree.refresh();
          },
        });
        form.show();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Rename Column failed: ${msg}`);
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
      // DBX-08 — declared tableDdl capability gates schema DDL (never driver).
      let createSchemaAdapter: DbAdapter | null = null;
      try {
        createSchemaAdapter = await mgr.getAdapterFor(conn);
      } catch {
        createSchemaAdapter = null;
      }
      if (!hasAdapterCapability(createSchemaAdapter, "tableDdl")) {
        void vscode.window.showInformationMessage(
          `VSDB: ${COMMAND_TITLE.createSchema} is not supported by this connection's database.`,
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
          // TASK-CL-002 — fire the seam PER successful CREATE SCHEMA, NEVER
          // on the error path. Mirrors the local narrowing above.
          onSchemaDdl?.([sql], toLocalSqlDialect(conn.driver));
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
        const guarded = await guardPostgres(
          mgr,
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
  // Export Structure — copy CREATE TABLE DDL (table) / column list (view)
  // cho node table/view. Postgres-only, giống postmanPayload guard.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vsdb.exportStructure",
      async (arg?: unknown) => {
        if (!arg || typeof arg !== "object") return;
        const node = arg as { contextValue?: string };
        const guarded = await guardPostgres(
          mgr,
          resolveTableNode(arg),
          "exportStructure",
        );
        if (!guarded) return;
        const { conn, schema, table: name } = guarded;
        if (name === "") return;

        try {
          const adapter = await mgr.getAdapterFor(conn);
          const columns = (await adapter.listColumns(name, schema)).map(
            (c) => ({
              name: c.name,
              dataType: c.dataType,
              nullable: c.nullable,
              isPrimaryKey: c.isPrimaryKey,
            }),
          );
          const text =
            node.contextValue === "view"
              ? buildViewStructure(schema, name, columns)
              : buildTableStructure(schema, name, columns);
          await vscode.env.clipboard.writeText(text);
          void vscode.window.setStatusBarMessage(
            "VSDB: structure copied",
            2000,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Export Structure failed: ${msg}`,
          );
        }
      },
    ),
  );
  // TASK-004 — vsdb.exportAllStructures: copy whole-DB DDL (all schemas →
  // CREATE TABLE / CREATE VIEW) to clipboard. Connection/schema node arg or
  // palette (no arg → mgr.getActive()). Postgres-only; non-PG → info guard.
  // Per-object listColumns throw → skip that object (không blank whole export).
  // Status bar reports total objects successfully copied.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vsdb.exportAllStructures",
      async (arg?: unknown) => {
        // Resolve target conn: connection node (meta.connection) | schema node
        // (meta.connection) | palette → mgr.getActive().
        let conn: ConnectionConfig | null = null;
        let targetSchema: string | null = null;
        if (arg && typeof arg === "object") {
          const meta = (arg as {
            meta?: { connection?: ConnectionConfig; schema?: string };
          }).meta;
          if (meta?.connection) conn = meta.connection;
          if (meta?.schema) targetSchema = meta.schema;
        }
        if (!conn) conn = mgr.getActive();
        if (!conn) {
          void vscode.window.showErrorMessage(
            "Export All Structures failed: no active connection. Select one first.",
          );
          return;
        }
        // DBX-08 — declared tableDdl capability gates whole-DB structure
        // export (never driver identity).
        let exportAdapter: DbAdapter | null = null;
        try {
          exportAdapter = await mgr.getAdapterFor(conn);
        } catch {
          exportAdapter = null;
        }
        if (!hasAdapterCapability(exportAdapter, "tableDdl")) {
          void vscode.window.showInformationMessage(
            `VSDB: Export All Structures is not supported by this connection's database.`,
          );
          return;
        }

        try {
          const adapter = await mgr.getAdapterFor(conn);
          const allSchemas = await adapter.listSchemas(false);
          const schemas = targetSchema
            ? allSchemas.filter((s) => s.name === targetSchema)
            : allSchemas;
          const tables: Array<{ schema: string; name: string }> = [];
          const views: Array<{ schema: string; name: string }> = [];
          const columns: Record<string, ExportColumn[]> = {};

          const collectColumns = async (
            schema: string,
            name: string,
          ): Promise<ExportColumn[] | null> => {
            try {
              const cols = await adapter.listColumns(name, schema);
              return cols.map((c) => ({
                name: c.name,
                dataType: c.dataType,
                nullable: c.nullable,
                isPrimaryKey: c.isPrimaryKey,
              }));
            } catch {
              return null;
            }
          };

          let renderedObjects = 0;
          for (const s of schemas) {
            const schemaTables = await adapter.listTables(s.name);
            for (const t of schemaTables) {
              const cols = await collectColumns(t.schema, t.name);
              if (!cols) continue;
              tables.push({ schema: t.schema, name: t.name });
              columns[`${t.schema}.${t.name}`] = cols;
              renderedObjects += 1;
            }
            const schemaViews = await adapter.listViews(s.name);
            for (const v of schemaViews) {
              const cols = await collectColumns(v.schema, v.name);
              if (!cols) continue;
              views.push({ schema: v.schema, name: v.name });
              columns[`${v.schema}.${v.name}`] = cols;
              renderedObjects += 1;
            }
          }

          const text = buildDatabaseStructure({
            schemas: schemas.map((s) => ({ name: s.name })),
            tables,
            views,
            columns,
          });
          await vscode.env.clipboard.writeText(text);
          void vscode.window.setStatusBarMessage(
            `VSDB: database structure copied (${renderedObjects} objects)`,
            2000,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(
            `Export All Structures failed: ${msg}`,
          );
        }
      },
    ),
  );
}

export type { VsdbNode };
