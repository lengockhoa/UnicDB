// src/ai/tools/schemaTools.ts — TASK-001
// Two introspection tools for the agent:
//   - list_tables        → listTables()        (all 3 drivers)
//   - describe_table     → listTableDetail()   (Postgres only; mysql/mssql throw)
//
// Both tools swallow exceptions per the agent error policy:
//   - factory resolves null → "No active connection"
//   - NotImplementedError   → "describe_table is only supported for PostgreSQL connections"
//   - any other throw      → "Tool failed: <message>"
// Return shape is a JSON string (agent loop pushes it into a tool-result message).
// NO vscode import.

import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import { NotImplementedError } from "../../adapters/types";

const NO_CONNECTION_MSG =
  "No active connection. Connect to a database first, then retry.";
const PG_ONLY_MSG =
  "describe_table is only supported for PostgreSQL connections.";

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
