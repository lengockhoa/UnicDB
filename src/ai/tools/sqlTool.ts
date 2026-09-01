// src/ai/tools/sqlTool.ts — TASK-002
// Read-only SQL executor tool + isReadOnlySql guard. Cursor flow per F1:
// when adapter.runQuery returns a BatchedQuery, fetchBatch(50) + close() in
// finally; otherwise fall back to run.results. NO vscode import.

import type { AgentTool } from "../agent";
import type { AdapterFactory } from "./types";
import type { DbAdapter } from "../../adapters/types";
// TASK-AIX03-101: shared row-lock regex. Imported so both guards (this
// file's `isReadOnlySql` and `parseReadonly` in readonlySqlParser.ts) use
// the same pinned pattern.
import { ROW_LOCK_RE } from "./readonlySqlParser";

const NO_CONNECTION_MSG = "No active database connection.";
const ROW_LIMIT = 50;


const READ_ONLY_REASON = "Only SELECT/SHOW/EXPLAIN/WITH…SELECT are allowed (read-only)";
const MULTI_STMT_REASON = "Multiple statements are not allowed";
const INTO_REASON = "Read-only violation: INTO";
const WCTE_REASON = "Read-only violation: writable CTE (INSERT/UPDATE/DELETE/MERGE)";
/**
 * TASK-AIX03-101 — pinned row-lock rejection literal. Both `parseReadonly`
 * and `isReadOnlySql` must surface the same machine-readable reason so the
 * agent can self-correct. Kept identical to the acceptance-criterion literal.
 */
const ROW_LOCK_REASON = "Read-only violation: FOR UPDATE/SHARE";

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

  // EXPLAIN may wrap a writable statement — in PostgreSQL, EXPLAIN ANALYZE
  // actually executes the wrapped statement (DELETE/UPDATE/INSERT/DROP/CREATE/
  // REFRESH/MERGE/TRUNCATE all mutate state). Reduce EXPLAIN to the inner
  // statement by stripping the leading EXPLAIN plus optional ANALYZE|ANALYSE
  // |VERBOSE and an optional parenthesized options list, then re-check that
  // inner statement against the same guards. EXPLAIN SELECT/WITH…SELECT/SHOW
  // remain allowed; anything else behind EXPLAIN is rejected.
  if (kw === "explain") {
    const inner = stripExplainPrefix(lower);
    const innerKw = firstKeyword(inner);
    if (!innerKw || !ALLOWED_FIRST[innerKw]) return { ok: false, reason: READ_ONLY_REASON };
    if (innerKw === "with" && /\b(insert|update|delete|merge)\b/.test(inner)) {
      return { ok: false, reason: WCTE_REASON };
    }
    // Row-locking clause (TASK-AIX03-101 fix round 1): EXPLAIN ANALYZE of a
    // SELECT … FOR SHARE / FOR KEY SHARE actually executes and takes share
    // row locks. Run the row-lock guard against the EXPLAIN inner statement
    // before accepting — the top-level ROW_LOCK_RE guard below only sees
    // `explain …` and would miss it.
    if (ROW_LOCK_RE.test(inner)) {
      return { ok: false, reason: ROW_LOCK_REASON };
    }
    if (/\binto\b/.test(inner)) return { ok: false, reason: INTO_REASON };
    return { ok: true };
  }

  // Writable CTE check (when first keyword is WITH) precedes the INTO scan:
  // `WITH x AS (INSERT INTO a …) SELECT …` contains INTO as part of INSERT,
  // not as a standalone INTO clause; the more specific reason wins.
  if (kw === "with" && /\b(insert|update|delete|merge)\b/.test(lower)) {
    return { ok: false, reason: WCTE_REASON };
  }

  // Row-locking clause (TASK-AIX03-101): a SELECT may take a share row
  // lock with `FOR SHARE` / `FOR KEY SHARE` / `FOR NO KEY SHARE`. Neither
  // the first-keyword check nor `INTO` nor the writable-CTE scan catch
  // these — they look like a plain read but they block writers.
  if (ROW_LOCK_RE.test(lower)) {
    return { ok: false, reason: ROW_LOCK_REASON };
  }

  // INTO scan is unconditional (word-boundary).
  if (/\binto\b/.test(lower)) return { ok: false, reason: INTO_REASON };

  return { ok: true };
}

/**
 * Strip a leading `EXPLAIN` plus optional modifier keywords
 * (`ANALYZE` | `ANALYSE` | `VERBOSE`, repeatable in any order) and an
 * optional parenthesized options list, returning the inner statement
 * the EXPLAIN actually wraps. Whitespace between tokens is consumed.
 * Does not validate token shape; callers re-check the inner result.
 */
function stripExplainPrefix(lower: string): string {
  let i = 0;
  const n = lower.length;
  const isWordChar = (c: string) => /[a-zA-Z0-9_]/.test(c);
  // Consume leading whitespace before EXPLAIN itself.
  while (i < n && /\s/.test(lower[i] ?? "")) i++;
  // Consume "explain".
  if (lower.startsWith("explain", i) && !isWordChar(lower[i + 7] ?? "")) i += 7;
  // Consume any number of ANALYZE|ANALYSE|VERBOSE tokens and an optional
  // parenthesized options list, in any order.
  while (i < n) {
    while (i < n && /\s/.test(lower[i] ?? "")) i++;
    if (lower.startsWith("analyze", i) && !isWordChar(lower[i + 7] ?? "")) {
      i += 7;
      continue;
    }
    if (lower.startsWith("analyse", i) && !isWordChar(lower[i + 7] ?? "")) {
      i += 7;
      continue;
    }
    if (lower.startsWith("verbose", i) && !isWordChar(lower[i + 7] ?? "")) {
      i += 7;
      continue;
    }
    if (lower[i] === "(") {
      let depth = 0;
      const start = i;
      while (i < n) {
        const c = lower[i] ?? "";
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      if (depth !== 0) i = start + 1; // unbalanced — bail, leave as-is
      continue;
    }
    break;
  }
  return lower.slice(i);
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