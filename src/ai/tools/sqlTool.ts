// src/ai/tools/sqlTool.ts — TASK-002
// Read-only SQL executor tool + isReadOnlySql guard. Cursor flow per F1:
// when adapter.runQuery returns a BatchedQuery, fetchBatch(50) + close() in
// finally; otherwise fall back to run.results. NO vscode import.

import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import type { DbAdapter } from "../../adapters/types";

const NO_CONNECTION_MSG = "No active database connection.";
const ROW_LIMIT = 50;


const READ_ONLY_REASON = "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)";
const MULTI_STMT_REASON = "Multiple statements are not allowed";
const INTO_REASON = "Read-only violation: INTO";
const WCTE_REASON = "Read-only violation: writable CTE (INSERT/UPDATE/DELETE/MERGE)";

export interface ReadOnlyCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Strip leading `-- line` and `/* block * /` comments from the start of SQL
 * so guards operate on the first non-comment token. Whitespace between
 * comments and the next comment/statement is consumed.
 */
function stripLeadingComments(sql: string): string {
  let i = 0;
  const len = sql.length;
  while (i < len && /\s/.test(sql[i] ?? "")) i++;
  while (i < len) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
      while (i < len && /\s/.test(sql[i] ?? "")) i++;
    } else if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < len - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, len);
      while (i < len && /\s/.test(sql[i] ?? "")) i++;
    } else {
      break;
    }
  }
  return sql.slice(i);
}

/** Count statements excluding a single optional trailing semicolon. */
function countStatements(body: string): number {
  const trimmed = body.replace(/;\s*$/, "");
  if (trimmed.length === 0) return 1;
  let count = 1;
  let inSingle = false;
  let inDouble = false;
  let inDollar = false;
  let i = 0;
  const n = trimmed.length;
  while (i < n) {
    const c = trimmed[i] ?? "";
    const nx = trimmed[i + 1] ?? "";
    if (inSingle) {
      if (c === "'" && nx !== "'") inSingle = false;
      else if (c === "'" && nx === "'") i++;
    } else if (inDouble) {
      if (c === '"' && nx !== '"') inDouble = false;
      else if (c === '"' && nx === '"') i++;
    } else if (inDollar) {
      if (c === "$") inDollar = false;
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === "$") {
      inDollar = true;
    } else if (c === ";") {
      let j = i + 1;
      while (j < n && /\s/.test(trimmed[j] ?? "")) j++;
      if (j < n) count++;
    }
    i++;
  }
  return count;
}

function firstKeyword(body: string): string | null {
  const m = body.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
  return m && m[1] ? m[1].toLowerCase() : null;
}

const ALLOWED_FIRST: Record<string, true> = {
  select: true,
  show: true,
  explain: true,
  with: true,
};

export function isReadOnlySql(sql: string): ReadOnlyCheck {
  const stripped = stripLeadingComments(sql).trim();
  if (stripped.length === 0) return { ok: false, reason: READ_ONLY_REASON };
  const lower = stripped.toLowerCase();
  if (countStatements(lower) > 1) return { ok: false, reason: MULTI_STMT_REASON };

  const kw = firstKeyword(lower);
  if (!kw || !ALLOWED_FIRST[kw]) return { ok: false, reason: READ_ONLY_REASON };

  // Writable CTE check (when first keyword is WITH) precedes the INTO scan:
  // `WITH x AS (INSERT INTO a …) SELECT …` contains INTO as part of INSERT,
  // not as a standalone INTO clause; the more specific reason wins.
  if (kw === "with" && /\b(insert|update|delete|merge)\b/.test(lower)) {
    return { ok: false, reason: WCTE_REASON };
  }

  // INTO scan is unconditional (word-boundary).
  if (/\binto\b/.test(lower)) return { ok: false, reason: INTO_REASON };

  return { ok: true };
}

export interface SqlResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

async function executeReadOnly(adapter: DbAdapter, sql: string): Promise<SqlResult> {
  const run = await adapter.runQuery(sql);
  if (run.batched) {
    const cursor = run.batched;
    try {
      const batch = await cursor.fetchBatch();
      if (!batch) {
        return { columns: cursor.columns, rows: [], rowCount: 0, truncated: false };
      }
      const truncated = batch.length > ROW_LIMIT;
      const sliced = truncated ? batch.slice(0, ROW_LIMIT) : batch;
      return {
        columns: cursor.columns,
        rows: sliced,
        rowCount: batch.length,
        truncated,
      };
    } finally {
      await cursor.close();
    }
  }
  const last = run.results[run.results.length - 1];
  if (!last) return { columns: [], rows: [], rowCount: 0, truncated: false };
  const allRows = last.rows ?? [];
  const truncated = allRows.length > ROW_LIMIT;
  const sliced = truncated ? allRows.slice(0, ROW_LIMIT) : allRows;
  return {
    columns: last.columns,
    rows: sliced,
    rowCount: allRows.length,
    truncated,
  };
}

export function createSqlTool(factory: AdapterFactory): AgentTool {
  return {
    name: "run_sql",
    description:
      "Execute a read-only SQL statement (SELECT/SHOW/EXPLAIN/WITH…SELECT) against the active database. Returns up to 50 rows as JSON.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>): Promise<string> {
      const sql = typeof args.sql === "string" ? args.sql : "";
      const guard = isReadOnlySql(sql);
      if (!guard.ok) return guard.reason ?? READ_ONLY_REASON;

      const adapter = await factory();
      if (!adapter) return NO_CONNECTION_MSG;

      try {
        const result = await executeReadOnly(adapter, sql);
        return JSON.stringify(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Tool failed: ${msg}`;
      }
    },
  };
}