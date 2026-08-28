// src/ai/tools/dbAwareTools.ts — cycle AD TASK-001
// Five read-only DB-aware agent tools. Every one of them is gated by the
// host permission card (see `DbToolPermissionGate` in src/ui/aiChatPanel.ts)
// before it ever reaches this module. NO vscode import.
//
// Privacy contract (cycle AA/AB): row bytes are returned to the caller as a
// tool result ONLY. Nothing here logs, throws, or embeds row content —
// error paths return a fixed message and `summarizeForLog` emits shape,
// never values.

import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import type { DbAdapter, QueryResult } from "../../adapters/types";
import { parseReadonly, containsForbidden } from "./readonlySqlParser";

const NO_CONNECTION_MSG =
  "No active database connection. Connect to a database first, then retry.";
const SAMPLE_DEFAULT_LIMIT = 20;
const SAMPLE_MAX_LIMIT = 100;
const QUERY_DEFAULT_MAX_ROWS = 100;
const QUERY_MAX_ROWS = 1000;

/** Uniform refusal text. Contains both the word `rejected` and the machine
 * reason so the model can self-correct and the user sees why in the bubble. */
function rejected(reason: string, detail: string): string {
  return `Tool rejected the request (reason=${reason}): ${detail}`;
}

/** Shape-only log line — NEVER row values. Mirrors the cycle-AB
 * `summarizeAttachmentsForLog` pattern. */
export function summarizeForLog(
  columns: readonly string[],
  rows: readonly unknown[][],
): string {
  return `${columns.length} cols x ${rows.length} rows`;
}

/**
 * Identifier guard for the schema/table args of the introspection-shaped
 * tools. Identifiers are interpolated into SQL (adapters expose no bound
 * parameter path on `runQuery`), so anything but a plain identifier is
 * refused outright — no quotes, no dots, no whitespace, no forbidden
 * keyword substring.
 */
function badIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return "schema and table must be non-empty strings";
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    return `"${value}" is not a plain identifier`;
  }
  if (containsForbidden(value)) {
    return `"${value}" contains a forbidden SQL keyword`;
  }
  return null;
}

/** Last non-empty result set of a run, cursor-aware (Postgres routes large
 * SELECTs through a server-side cursor and leaves `results` empty). */
async function firstResult(
  adapter: DbAdapter,
  sql: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const run = await adapter.runQuery(sql);
  if (run.batched) {
    const cursor = run.batched;
    try {
      const rows: unknown[][] = [];
      for (;;) {
        const batch = await cursor.fetchBatch();
        if (!batch || batch.length === 0) break;
        rows.push(...batch);
        if (rows.length >= QUERY_MAX_ROWS) break;
      }
      return { columns: cursor.columns, rows };
    } finally {
      await cursor.close();
    }
  }
  const last: QueryResult | undefined = run.results[run.results.length - 1];
  if (!last) return { columns: [], rows: [] };
  return { columns: last.columns, rows: last.rows ?? [] };
}

/** Render a result set as a pipe-separated text table with a header row. */
function renderTable(
  columns: readonly string[],
  rows: readonly unknown[][],
  cap: number,
  total: number,
): string {
  const lines: string[] = [columns.join(" | ")];
  lines.push(columns.map((c) => "-".repeat(Math.max(3, c.length))).join(" | "));
  for (const row of rows) {
    lines.push(row.map((v) => (v === null || v === undefined ? "NULL" : String(v))).join(" | "));
  }
  if (total > cap) {
    lines.push(`-- truncated: showing ${cap} of ${total} rows`);
  }
  return lines.join("\n");
}

function toolFailed(err: unknown): string {
  // The message comes from the driver, never from row content.
  return `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
}

export function createListTableDataSampleTool(f: AdapterFactory): AgentTool {
  return {
    name: "list_table_data_sample",
    description:
      "Read the first N rows of a table (default 20, hard cap 100). Requires user permission.",
    parameters: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name." },
        table: { type: "string", description: "Table name." },
        limit: {
          type: "number",
          description: "Row count, 1..100. Defaults to 20.",
        },
      },
      required: ["schema", "table"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const schema = args["schema"];
      const table = args["table"];
      const bad = badIdentifier(schema) ?? badIdentifier(table);
      if (bad !== null) return rejected("bad_identifier", bad);

      const raw = args["limit"];
      const requested =
        typeof raw === "number" && Number.isFinite(raw)
          ? Math.floor(raw)
          : SAMPLE_DEFAULT_LIMIT;
      const limit = Math.min(SAMPLE_MAX_LIMIT, Math.max(1, requested));

      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;
      try {
        const sql = `SELECT * FROM "${schema as string}"."${table as string}" LIMIT ${limit}`;
        const { columns, rows } = await firstResult(adapter, sql);
        const shown = rows.slice(0, limit);
        return renderTable(columns, shown, limit, rows.length);
      } catch (err) {
        return toolFailed(err);
      }
    },
  };
}

export function createCountRowsTool(f: AdapterFactory): AgentTool {
  return {
    name: "count_rows",
    description:
      "Count rows in a table, with an optional read-only WHERE clause. Requires user permission.",
    parameters: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name." },
        table: { type: "string", description: "Table name." },
        where: {
          type: "string",
          description: "Optional WHERE clause body (no semicolons, no DML).",
        },
      },
      required: ["schema", "table"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const schema = args["schema"];
      const table = args["table"];
      const bad = badIdentifier(schema) ?? badIdentifier(table);
      if (bad !== null) return rejected("bad_identifier", bad);

      const whereRaw = args["where"];
      let where = "";
      if (typeof whereRaw === "string" && whereRaw.trim().length > 0) {
        where = whereRaw.trim();
        if (where.includes(";")) {
          return rejected("multi_statement", "WHERE clause may not contain ';'");
        }
        if (containsForbidden(where)) {
          return rejected(
            "non_select",
            "WHERE clause contains a forbidden SQL keyword",
          );
        }
      }

      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;
      try {
        const base = `SELECT COUNT(*) FROM "${schema as string}"."${table as string}"`;
        const sql = where.length === 0 ? base : `${base} WHERE ${where}`;
        const { rows } = await firstResult(adapter, sql);
        const cell = rows[0]?.[0];
        const count = typeof cell === "bigint" ? Number(cell) : Number(cell ?? 0);
        return JSON.stringify({ count });
      } catch (err) {
        return toolFailed(err);
      }
    },
  };
}

/** Shared parser + EXPLAIN-ANALYZE gate for the two raw-SQL tools. */
function guardSql(sql: unknown): { sql: string } | { error: string } {
  const text = typeof sql === "string" ? sql : "";
  if (/\bexplain\b[\s(]*\banaly[sz]e\b/i.test(text)) {
    return {
      error: rejected(
        "explain_analyze",
        "EXPLAIN ANALYZE executes the wrapped statement and is not allowed",
      ),
    };
  }
  const parsed = parseReadonly(text);
  if (!parsed.ok) {
    return {
      error: rejected(
        parsed.reason,
        "only a single read-only SELECT/WITH statement is allowed",
      ),
    };
  }
  return { sql: text.trim().replace(/;\s*$/, "") };
}

export function createRunReadonlyQueryTool(f: AdapterFactory): AgentTool {
  return {
    name: "run_readonly_query",
    description:
      "Run a single read-only SELECT/WITH query and return up to maxRows rows (default 100, hard cap 1000). Requires user permission.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT or WITH…SELECT." },
        maxRows: {
          type: "number",
          description: "Row cap, 1..1000. Defaults to 100.",
        },
      },
      required: ["sql"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const guard = guardSql(args["sql"]);
      if ("error" in guard) return guard.error;

      const raw = args["maxRows"];
      const requested =
        typeof raw === "number" && Number.isFinite(raw)
          ? Math.floor(raw)
          : QUERY_DEFAULT_MAX_ROWS;
      const cap = Math.min(QUERY_MAX_ROWS, Math.max(1, requested));

      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;
      try {
        const { columns, rows } = await firstResult(adapter, guard.sql);
        return renderTable(columns, rows.slice(0, cap), cap, rows.length);
      } catch (err) {
        return toolFailed(err);
      }
    },
  };
}

export function createExplainQueryTool(f: AdapterFactory): AgentTool {
  return {
    name: "explain_query",
    description:
      "Show the query plan (EXPLAIN, never ANALYZE) for a read-only SELECT/WITH query. Requires user permission.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT or WITH…SELECT." },
      },
      required: ["sql"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const guard = guardSql(args["sql"]);
      if ("error" in guard) return guard.error;

      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;
      try {
        const { rows } = await firstResult(adapter, `EXPLAIN ${guard.sql}`);
        return rows.map((r) => String(r[0] ?? "")).join("\n");
      } catch (err) {
        return toolFailed(err);
      }
    },
  };
}

/**
 * FK introspection via `listTableDetail` constraints (`contype === "f"`).
 * Reverse FKs are computed by scanning every table in the SAME schema and
 * keeping those whose FK targets this table — the adapter interface exposes
 * no reverse-FK query, and cross-schema reverse FKs are therefore out of
 * reach in this cycle (documented fallback, no row data either way).
 */
export function createTableRelationshipsTool(f: AdapterFactory): AgentTool {
  return {
    name: "get_table_relationships",
    description:
      "List the foreign keys of a table plus the tables in the same schema that reference it. Schema metadata only, no row data.",
    parameters: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name." },
        table: { type: "string", description: "Table name." },
      },
      required: ["schema", "table"],
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const schema = args["schema"];
      const table = args["table"];
      const bad = badIdentifier(schema) ?? badIdentifier(table);
      if (bad !== null) return rejected("bad_identifier", bad);

      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;
      try {
        const self = await adapter.listTableDetail(
          schema as string,
          table as string,
        );
        const foreignKeys = self.constraints
          .filter((c) => c.contype === "f" && c.confrelidname !== null)
          .map((c) => ({
            constraint: c.conname,
            references: c.confrelidname as string,
            columns: c.confkeycols ?? [],
          }));

        const referencedBy: Array<{ table: string; constraint: string }> = [];
        const siblings = await adapter.listTables(schema as string);
        for (const t of siblings) {
          if (t.name === table) continue;
          let detail;
          try {
            detail = await adapter.listTableDetail(t.schema, t.name);
          } catch {
            // Per-table introspection failure: skip it, keep the rest.
            continue;
          }
          for (const c of detail.constraints) {
            if (c.contype === "f" && c.confrelidname === table) {
              referencedBy.push({
                table: `${t.schema}.${t.name}`,
                constraint: c.conname,
              });
            }
          }
        }
        return JSON.stringify({ foreignKeys, referencedBy });
      } catch (err) {
        return toolFailed(err);
      }
    },
  };
}

/** All five DB-aware tools, in the canonical order. */
export function createDbAwareTools(f: AdapterFactory): AgentTool[] {
  return [
    createListTableDataSampleTool(f),
    createCountRowsTool(f),
    createRunReadonlyQueryTool(f),
    createExplainQueryTool(f),
    createTableRelationshipsTool(f),
  ];
}
