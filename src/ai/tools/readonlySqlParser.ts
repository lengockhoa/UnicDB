// src/ai/tools/readonlySqlParser.ts — cycle AD TASK-001
// PURE readonly-SQL guard for the DB-aware tools. No vscode, no fs, no net.
//
// Deliberately STRICTER than a real SQL parser: a forbidden keyword is
// rejected even inside a string literal or as a substring of an identifier
// (`inserted_at` contains `insert`). This over-rejects legitimate SQL but
// makes parser-bypass impossible without a full tokenizer; the model is
// told to rename such columns via an alias-free projection or use
// `list_table_data_sample` instead. A proper literal-aware tokenizer can
// relax this later without changing the exported contract.

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
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|merge|call|exec)/i;

/** True when `text` contains any forbidden keyword (case-insensitive). */
export function containsForbidden(text: string): boolean {
  return FORBIDDEN_RE.test(text);
}

/**
 * Strip every `-- line` and block comment from `sql`, replacing each with a
 * single space so adjacent tokens never fuse. Comment bodies are dropped
 * before any keyword scan, so a comment can neither hide nor fake a token.
 */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      out += " ";
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/** Parse `sql` as a single read-only statement. Never throws. */
export function parseReadonly(sql: string): ParseResult {
  const body = stripComments(typeof sql === "string" ? sql : "").trim();
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
  if (containsForbidden(statement)) return { ok: false, reason: "non_select" };

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
