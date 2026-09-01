// src/ai/tools/readonlySqlParser.ts — cycle AD TASK-001
// CORE PROFILE of the ARP-06 AI-SQL policy decision (ADR 0003,
// docs/decisions/0003-ai-sql-policy.md): parser uncertainty never admits
// mutation-capable SQL. The run_sql profile (isReadOnlySql in sqlTool.ts)
// additionally admits SHOW/EXPLAIN by reducing EXPLAIN to its inner
// statement and re-checking. PURE guard — no vscode, no fs, no net.
//
// Deliberately STRICTER than a real SQL parser: a forbidden keyword is
// rejected even inside a string literal, inside a comment body, or as a
// substring of an identifier (`inserted_at` contains `insert`). This
// over-rejects legitimate SQL but makes parser-bypass impossible without a
// full tokenizer; the model is told to rename such columns via an
// alias-free projection or use `list_table_data_sample` instead. A proper
// literal-aware tokenizer can relax this later without changing the
// exported contract.

export type ParseFailReason =
  | "non_select"
  | "multi_statement"
  | "empty"
  | "unbalanced_parens";

export type ParseResult =
  | { ok: true; kind: "select" | "with" }
  | { ok: false; reason: ParseFailReason };

/**
 * Whole-word-boundary forbidden tokens. `\b` around each alternative means
 * `insert` matches inside `inserted_at` only because `_` is a word char and
 * `inserted` starts at a boundary — which is exactly the defense-in-depth
 * behaviour we want (`inserted_at` IS rejected). See the module header.
 */
const FORBIDDEN_RE =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|exec|into)/i;

/**
 * PostgreSQL row-locking clause: `FOR <lockmode>`. The lockmodes a read-only
 * copilot must NEVER accept because they take row-level locks. Used by both
 * `parseReadonly` (dbAwareTools) and `isReadOnlySql` (sqlTool) — same regex,
 * same purpose. `\b` ensures `FORECAST` is not matched.
 *
 * TASK-AIX03-101 — pin both forms. `FOR UPDATE` / `FOR NO KEY UPDATE` are
 * already caught by `FORBIDDEN_RE` via the `update` keyword; the remaining
 * bypass is `FOR SHARE` / `FOR KEY SHARE` / `FOR NO KEY SHARE` which carry
 * no DML keyword.
 */
export const ROW_LOCK_RE =
  /\bfor\s+(no\s+key\s+update|no\s+key\s+share|key\s+share|update|share)\b/i;

/** True when `text` contains any forbidden keyword (case-insensitive). */
export function containsForbidden(text: string): boolean {
  return FORBIDDEN_RE.test(text);
}

/** True when `text` contains a PostgreSQL row-locking clause. */
export function containsRowLock(text: string): boolean {
  return ROW_LOCK_RE.test(text);
}

/**
 * Strip every `-- line` and block comment from `sql`, replacing each with a
 * single space so adjacent tokens never fuse. Comment bodies are dropped for
 * STRUCTURAL parsing only (first keyword, statement counting, paren
 * balance); the forbidden/row-lock token scans in `parseReadonly` run against
 * the raw text, so a comment can neither hide nor fake a token there.
 *
 * Lexical context rules (conservative — errs on the safe side):
 *   - Inside a single-quoted string: NO comment stripping. A single quote
 *     that isn't doubled (`''`) closes the string.
 *   - Inside a PostgreSQL double-quoted identifier: NO comment stripping.
 *     Doubled double-quote is an escaped quote.
 *   - Inside a PostgreSQL dollar-quoted string `$tag$…$tag$`: NO comment
 *     stripping. The tag body is `[A-Za-z_][A-Za-z0-9_]*` (or empty for
 *     `$$`). The matching closing tag must be present.
 *   - Otherwise: `--` until newline and block comments are stripped.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'") {
      // Single-quoted string literal. Copy verbatim (allow '' as escape).
      out += ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === "'") {
          out += c;
          i++;
          // Doubled '' → escaped quote, keep going.
          if (i < n && sql[i] === "'") {
            out += sql[i];
            i++;
            continue;
          }
          break;
        }
        out += c;
        i++;
      }
    } else if (ch === '"') {
      // Double-quoted identifier. Copy verbatim ("" is an escaped quote).
      out += ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === '"') {
          out += c;
          i++;
          if (i < n && sql[i] === '"') {
            out += sql[i];
            i++;
            continue;
          }
          break;
        }
        out += c;
        i++;
      }
    } else if (ch === "$") {
      // Dollar-quoted string: $tag$…$tag$ or $$…$$.
      const tag = readDollarTag(sql, i);
      if (tag !== null) {
        const start = i;
        const endIdx = sql.indexOf(tag, start + tag.length);
        if (endIdx !== -1) {
          // Copy the entire dollar-quoted region verbatim.
          out += sql.slice(start, endIdx + tag.length);
          i = endIdx + tag.length;
        } else {
          // Unterminated dollar-quote — copy remainder, no comment strip.
          out += sql.slice(start);
          i = n;
        }
        continue;
      }
      // Not a dollar tag — fall through and treat `$` as ordinary char.
      out += ch;
      i++;
    } else if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/**
 * If `sql` starting at `i` begins with a valid dollar-quote delimiter
 * (`$tag$` or `$$`), return the full delimiter including the leading `$`.
 * Otherwise return null. The tag body, if any, is `[A-Za-z_][A-Za-z0-9_]*`.
 */
function readDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  const n = sql.length;
  let j = i + 1;
  if (j < n && sql[j] === "$") return "$$";
  // Tag must start with letter or underscore.
  const c = sql[j];
  if (j >= n || !((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_")) {
    return null;
  }
  j++;
  while (j < n) {
    const cc = sql[j];
    if (
      (cc >= "A" && cc <= "Z") ||
      (cc >= "a" && cc <= "z") ||
      (cc >= "0" && cc <= "9") ||
      cc === "_"
    ) {
      j++;
    } else {
      break;
    }
  }
  if (sql[j] !== "$") return null;
  return sql.slice(i, j + 1);
}

/**
 * Exported helper — strip every `-- line` and block comment, preserving
 * string literals (single-quoted), PostgreSQL double-quoted identifiers,
 * and PostgreSQL dollar-quoted strings. Used by callers that need the
 * lexically-safe stripped form for downstream scanning.
 */
export function stripTrailingSqlComments(sql: string): string {
  return stripComments(typeof sql === "string" ? sql : "");
}

/** Parse `sql` as a single read-only statement. Never throws. */
export function parseReadonly(sql: string): ParseResult {
  const raw = typeof sql === "string" ? sql : "";
  const body = stripComments(raw).trim();
  if (body.length === 0) return { ok: false, reason: "empty" };

  // Multi-statement: a `;` with any non-whitespace content after it. A single
  // trailing `;` (optionally followed by whitespace) is fine.
  const semi = body.indexOf(";");
  if (semi !== -1 && body.slice(semi + 1).trim().length > 0) {
    return { ok: false, reason: "multi_statement" };
  }

  const statement = semi === -1 ? body : body.slice(0, semi);

  const first = /^([a-zA-Z_][a-zA-Z0-9_]*)/.exec(statement);
  const keyword = first?.[1]?.toLowerCase() ?? "";
  if (keyword !== "select" && keyword !== "with") {
    return { ok: false, reason: "non_select" };
  }

  // Defense in depth: no forbidden keyword anywhere in the statement.
  // ARP-06.1: the token scans run against the RAW text (comments included),
  // so a forbidden keyword hidden in a comment body is rejected —
  // `SELECT 1 -- drop table t` never parses. Fail-closed over-rejection.
  if (containsForbidden(raw)) return { ok: false, reason: "non_select" };

  // Defense in depth: no PostgreSQL row-locking clause. Catches the
  // bypass where neither `FOR UPDATE` / `FOR NO KEY UPDATE` is present
  // but a share lock is taken (FOR SHARE / FOR KEY SHARE / FOR NO KEY
  // SHARE). TASK-AIX03-101. Also scanned on the raw text (see above).
  if (containsRowLock(raw)) return { ok: false, reason: "non_select" };

  let depth = 0;
  for (const ch of statement) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return { ok: false, reason: "unbalanced_parens" };
    }
  }
  if (depth !== 0) return { ok: false, reason: "unbalanced_parens" };

  return { ok: true, kind: keyword === "with" ? "with" : "select" };
}
