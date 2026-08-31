// src/ai/tools/analysisTools.ts — TASK-AIX03-002
// Composite analysis agent tools for the AIX-03 Database Analysis Copilot.
// Same contracts as dbAwareTools: NO vscode import, adapter injected via
// AdapterFactory, permission-gated upstream by DbToolPermissionGate, never
// throws (every failure is a message/envelope), row bytes only in the
// explicitly-labeled sample surface.
import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import { parseReadonly, containsForbidden } from "./readonlySqlParser";

const NO_CONNECTION_MSG =
  "No active database connection. Connect to a database first, then retry.";
const SAMPLE_DEFAULT_LIMIT = 20;
const SAMPLE_MAX_LIMIT = 100;
const DIAGNOSE_DETAIL_CAP = 200;

/**
 * Identifier guard for interpolated SQL (same contract as dbAwareTools):
 * identifiers are interpolated into runQuery strings, so anything but a
 * plain identifier is refused outright — no quotes, no dots, no whitespace,
 * no semicolons, no forbidden keyword substring. Blocks
 * `public"; DELETE FROM users; --` style injection.
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

function toolFailed(err: unknown): string {
  return `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** Render a result set as a pipe-separated text table (same shape as
 * dbAwareTools.renderTable — kept local to keep these tools standalone). */
function renderTable(
  columns: readonly string[],
  rows: readonly unknown[][],
  total: number,
): string {
  const header = columns.join(" | ");
  const lines = rows.map((r) => r.map((c) => String(c ?? "")).join(" | "));
  return `${header}\n${"---".repeat(Math.max(1, columns.length))}\n${lines.join("\n")}\n(${lines.length} of ${total} rows)`;
}

export function createAnalyzeTableTool(f: AdapterFactory): AgentTool {
  return {
    name: "analyze_table",
    description:
      "One-call table analysis: column shape, exact row count, a capped data " +
      "sample (rows included — the only data surface), and foreign keys. " +
      "Parts degrade independently. Requires user permission.",
    parameters: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name." },
        table: { type: "string", description: "Table name." },
        limit: {
          type: "number",
          description: "Sample row count, 1..100. Defaults to 20.",
        },
      },
      required: ["schema", "table"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const schema = args["schema"];
      const table = args["table"];
      const bad = badIdentifier(schema) ?? badIdentifier(table);
      if (bad !== null) {
        return JSON.stringify({ error: "bad_identifier", detail: bad });
      }
      const raw = args["limit"];
      const requested =
        typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : SAMPLE_DEFAULT_LIMIT;
      const limit = Math.min(SAMPLE_MAX_LIMIT, Math.max(1, requested));

      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;

      const report: Record<string, unknown> = {};
      // Part 1: schema shape (NO row bytes).
      try {
        const detail = await adapter.listTableDetail(schema as string, table as string);
        report["schema"] = {
          columns: detail.columns.map((c) => ({
            name: c.column_name,
            type: c.format_type,
          })),
        };
        // Part 4 (same introspection): FK relationships.
        report["relationships"] = detail.constraints
          .filter((c) => c.contype === "f" && c.confrelidname !== null)
          .map((c) => ({
            constraint: c.conname,
            references: c.confrelidname as string,
            columns: c.confkeycols ?? [],
          }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report["schema"] = { error: msg };
        report["relationships"] = { error: msg };
      }
      // Part 2: exact count.
      try {
        const run = await adapter.runQuery(
          `SELECT COUNT(*) FROM "${schema as string}"."${table as string}"`,
        );
        const last = run.results[run.results.length - 1];
        const cell = last?.rows?.[0]?.[0];
        report["count"] = typeof cell === "bigint" ? Number(cell) : Number(cell ?? 0);
      } catch (err) {
        report["count"] = { error: err instanceof Error ? err.message : String(err) };
      }
      // Part 3: capped sample (the ONLY row-byte surface).
      try {
        const sql = `SELECT * FROM "${schema as string}"."${table as string}" LIMIT ${limit}`;
        const run = await adapter.runQuery(sql);
        const last = run.results[run.results.length - 1];
        const columns = last?.columns ?? [];
        const allRows = last?.rows ?? [];
        const shown = allRows.slice(0, limit);
        report["sample"] = renderTable(columns, shown, allRows.length);
      } catch (err) {
        report["sample"] = { error: err instanceof Error ? err.message : String(err) };
      }
      return JSON.stringify(report);
    },
  };
}

export type DiagnosisClass = "syntax" | "permission" | "connection" | "unknown";

/** Classify an adapter error message for diagnose_query. Pure. */
export function classifyDbError(message: string): DiagnosisClass {
  // Connection first: "connection terminated unexpectedly" also contains
  // "unexpected", but the connection meaning is the specific one.
  if (/connection|ECONNREFUSED|terminat|closed/i.test(message)) return "connection";
  if (/syntax error|parse|unexpected/i.test(message)) return "syntax";
  if (/permission denied|access denied|privilege/i.test(message)) return "permission";
  return "unknown";
}

/** Same guard surface as dbAwareTools.guardSql (EXPLAIN ANALYZE + parse). */
function guardSql(sql: unknown): { sql: string } | { error: string } {
  const text = typeof sql === "string" ? sql : "";
  if (/\bexplain\b[\s(]*\banaly[sz]e\b/i.test(text)) {
    return {
      error: `Tool rejected the request (reason=explain_analyze): EXPLAIN ANALYZE executes the wrapped statement and is not allowed`,
    };
  }
  const parsed = parseReadonly(text);
  if (!parsed.ok) {
    return {
      error: `Tool rejected the request (reason=${parsed.reason}): only a single read-only SELECT/WITH statement is allowed`,
    };
  }
  return { sql: text.trim().replace(/;\s*$/, "") };
}

/** Both AIX-03 analysis tools, in canonical order. */
export function createAnalysisTools(f: AdapterFactory): AgentTool[] {
  return [createAnalyzeTableTool(f), createDiagnoseQueryTool(f)];
}

export function createDiagnoseQueryTool(f: AdapterFactory): AgentTool {
  return {
    name: "diagnose_query",
    description:
      "Run a read-only SELECT/WITH and, when it fails, classify the database " +
      "error (syntax / permission / connection / unknown) to explain WHY a " +
      "query fails. Read-only guard applies. Requires user permission.",
    parameters: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT or WITH…SELECT." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const guard = guardSql(args["sql"]);
      if ("error" in guard) return guard.error;
      const adapter = await f();
      if (!adapter) return NO_CONNECTION_MSG;
      try {
        const run = await adapter.runQuery(guard.sql);
        const last = run.results[run.results.length - 1];
        const rows = last?.rows ?? [];
        // Postgres routes big SELECTs through a cursor; results may be
        // empty while batched is present — still a success.
        const rowCount = run.batched ? -1 : rows.length;
        return JSON.stringify({ ok: true, rows: rowCount });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          ok: false,
          class: classifyDbError(message),
          detail: message.slice(0, DIAGNOSE_DETAIL_CAP),
        });
      }
    },
  };
}
