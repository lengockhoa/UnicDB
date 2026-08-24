// src/ai/tools/schemaTools.ts — TASK-001
// Two introspection tools for the agent:
//   - list_tables        → listTables()        (all 3 drivers)
//   - describe_table     → listTableDetail()   (Postgres only; mysql/mssql throw)
//   - export_structure   → buildDatabaseStructure (Postgres only; full DB)
//
// Both tools swallow exceptions per the agent error policy:
//   - factory resolves null → "No active connection"
//   - NotImplementedError   → "<tool> is only supported for PostgreSQL connections"
//   - any other throw      → "Tool failed: <message>"
// Return shape is a JSON string (agent loop pushes it into a tool-result message).
// NO vscode import.

import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import { NotImplementedError } from "../../adapters/types";
import {
  buildDatabaseStructure,
  type ExportColumn,
} from "../../ui/exportStructure";

const NO_CONNECTION_MSG =
  "No active connection. Connect to a database first, then retry.";
const PG_ONLY_MSG =
  "describe_table is only supported for PostgreSQL connections.";
const PG_ONLY_EXPORT_MSG =
  "export_structure is only supported for PostgreSQL connections.";

function jsonCompact(value: unknown): string {
  return JSON.stringify(value);
}

export function createListTablesTool(f: AdapterFactory): AgentTool {
  return {
    name: "list_tables",
    description:
      "List tables in an optional schema. Returns a compact JSON array of {schema, name}.",
    parameters: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description:
            "Optional schema name. Omit to list across the active schemas.",
        },
      },
    },
    execute: async (args) => {
      try {
        const adapter = await f();
        if (!adapter) return NO_CONNECTION_MSG;
        const tables = await adapter.listTables(args["schema"] as string | undefined);
        return jsonCompact(
          tables.map((t) => ({ schema: t.schema, name: t.name })),
        );
      } catch (err) {
        return `Tool failed: ${(err as Error).message}`;
      }
    },
  };
}

export function createDescribeTableTool(f: AdapterFactory): AgentTool {
  return {
    name: "describe_table",
    description:
      "Describe a single (schema, table) — columns + constraints. PostgreSQL only.",
    parameters: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name." },
        table: { type: "string", description: "Table name." },
      },
      required: ["schema", "table"],
    },
    execute: async (args) => {
      try {
        const adapter = await f();
        if (!adapter) return NO_CONNECTION_MSG;
        const schema = args["schema"] as string;
        const table = args["table"] as string;
        const detail = await adapter.listTableDetail(schema, table);
        return jsonCompact({
          columns: detail.columns,
          constraints: detail.constraints,
        });
      } catch (err) {
        if (err instanceof NotImplementedError) return PG_ONLY_MSG;
        return `Tool failed: ${(err as Error).message}`;
      }
    },
  };
}

/**
 * export_structure — render full-DB DDL text (all schemas + tables + views).
 * Per-object introspection errors (listColumns throw) are swallowed: object
 * is skipped and counted in `skipped` so a single broken object doesn't
 * blank the entire export. `tables`/`views` counts reflect total discovered
 * by listTables/listViews, not just objects whose columns were fetched.
 */
export function createExportStructureTool(f: AdapterFactory): AgentTool {
  return {
    name: "export_structure",
    description:
      "Export the FULL database structure (all schemas, tables, views) as CREATE TABLE DDL text. Use when the schema summary above is truncated or when you need complete context to advise the user.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      try {
        const adapter = await f();
        if (!adapter) return NO_CONNECTION_MSG;

        const schemas = await adapter.listSchemas(false);
        const tables: Array<{ schema: string; name: string }> = [];
        const views: Array<{ schema: string; name: string }> = [];
        const columns: Record<string, ExportColumn[]> = {};
        let skipped = 0;
        let tableCount = 0;
        let viewCount = 0;

        // Returns null when introspection throws — caller skips that object.
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
            skipped += 1;
            return null;
          }
        };

        for (const s of schemas) {
          const schemaTables = await adapter.listTables(s.name);
          for (const t of schemaTables) {
            tableCount += 1;
            const cols = await collectColumns(t.schema, t.name);
            if (!cols) continue;
            tables.push({ schema: t.schema, name: t.name });
            columns[`${t.schema}.${t.name}`] = cols;
          }

          const schemaViews = await adapter.listViews(s.name);
          for (const v of schemaViews) {
            viewCount += 1;
            const cols = await collectColumns(v.schema, v.name);
            if (!cols) continue;
            views.push({ schema: v.schema, name: v.name });
            columns[`${v.schema}.${v.name}`] = cols;
          }
        }

        const ddl = buildDatabaseStructure({ schemas, tables, views, columns });
        return jsonCompact({
          ddl,
          schemas: schemas.length,
          tables: tableCount,
          views: viewCount,
          skipped,
        });
      } catch (err) {
        if (err instanceof NotImplementedError) return PG_ONLY_EXPORT_MSG;
        return `Tool failed: ${(err as Error).message}`;
      }
    },
  };
}
