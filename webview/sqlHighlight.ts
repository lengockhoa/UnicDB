// webview/sqlHighlight.ts — TASK-003
// Dependency-free pure SQL tokenizer + highlighter for VSDB's own webviews
// (Results Messages tab, AI-chat ```sql blocks) — the one place no TextMate
// grammar or semantic-token provider can reach.
//
// Design:
//  - `tokenizeSql` is a pure character scanner. It is dialect-agnostic by
//    design: accepts `'...'`, `"..."`, `` `...` ``, and `[...]` quoting all
//    at once because the webview does not know which driver is active at
//    render time.
//  - `highlightSql` builds a DocumentFragment of <span>s via createElement +
//    textContent — NEVER an HTML string. No HTML-string assignment anywhere
//    in this file, so hostile SQL can never become live markup.
//  - No imports from `vscode`, `ag-grid-community`, or `src/` — this module
//    is bundled standalone by esbuild into webview/main.ts and
//    aiChatPanelMain.ts (keeping host code out keeps those bundles lean).

export type SqlTokenKind =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "ident"
  | "punct"
  | "ws";

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
  start: number;
  end: number;
}

/** CSS class emitted per token kind: `vsdb-sql-tok-<kind>`. */
export function tokenClass(kind: SqlTokenKind): string {
  return `vsdb-sql-tok-${kind}`;
}

/** Common SQL reserved words (case-insensitive). A word that is not in this
 *  set is treated as an identifier. */
const SQL_HIGHLIGHT_KEYWORDS = new Set<string>([
  "ALL", "AND", "ANY", "AS", "ASC", "BEGIN", "BETWEEN", "BIGINT", "BOOLEAN",
  "BY", "CASCADE", "CASE", "CHAR", "CHECK", "COLLATE", "COMMIT", "CONSTRAINT",
  "CREATE", "CROSS", "DATE", "DATABASE", "DECIMAL", "DEFAULT", "DELETE",
  "DESC", "DISTINCT", "DOUBLE", "DROP", "ELSE", "END", "EXCEPT", "EXISTS",
  "FLOAT", "FOREIGN", "FROM", "FULL", "GRANT", "GROUP", "HAVING", "IN",
  "INDEX", "INNER", "INSERT", "INT", "INTEGER", "INTERSECT", "INTO", "IS",
  "JOIN", "KEY", "LEFT", "LIKE", "LIMIT", "NOT", "NULL", "NUMERIC", "OFFSET",
  "ON", "OR", "ORDER", "OUTER", "PRIMARY", "REAL", "REFERENCES", "RESTRICT",
  "RETURNING", "REVOKE", "RIGHT", "ROLLBACK", "SCHEMA", "SELECT", "SET",
  "SMALLINT", "SOME", "TABLE", "TEXT", "THEN", "TIME", "TIMESTAMP", "TO",
  "TRUNCATE", "UNION", "UNIQUE", "UPDATE", "VALUES", "VARCHAR", "VIEW",
  "WHEN", "WHERE", "WITH",
]);

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

function isIdentStart(c: string | undefined): boolean {
  return (
    c !== undefined &&
    (c === "_" || /[A-Za-z]/.test(c) || c.charCodeAt(0) > 127)
  );
}

function isIdentPart(c: string | undefined): boolean {
  return (
    c !== undefined &&
    (c === "_" || c === "$" || /[A-Za-z0-9]/.test(c) || c.charCodeAt(0) > 127)
  );
}

/**
 * Tokenize SQL into a flat token list. Every character of the input is
 * consumed exactly once — tokens concatenated in order reproduce the input
 * verbatim (used by the round-trip tests). Unterminated strings/comments
 * terminate at end-of-input instead of hanging, which is the classic
 * hand-rolled-lexer failure (see TASK-003 case 5).
 */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = sql.length;
  let i = 0;

  const push = (kind: SqlTokenKind, start: number, end: number): void => {
    if (end > start) {
      tokens.push({ kind, text: sql.slice(start, end), start, end });
    }
  };

  while (i < n) {
    const ch = sql[i]!;

    // Whitespace.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      const start = i;
      while (i < n && (sql[i] === " " || sql[i] === "\t" || sql[i] === "\n" || sql[i] === "\r")) i++;
      push("ws", start, i);
      continue;
    }

    // `--` line comment — runs to (not including) the newline.
    if (ch === "-" && sql[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i++;
      push("comment", start, i);
      continue;
    }

    // `/* ... */` block comment (unterminated → consume to end-of-input).
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < n) i += 2; // consume closing `*/`
      push("comment", start, i);
      continue;
    }

    // `'...'` string literal (doubled `''` is an escaped quote).
    if (ch === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push("string", start, i);
      continue;
    }

    // `"..."` — treated as a string literal (dialect-agnostic; some drivers
    // read it as a delimited identifier, but string coloring is safe either
    // way and the webview cannot know the active driver).
    if (ch === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push("string", start, i);
      continue;
    }

    // `` `...` `` — quoted identifier (MySQL/Postgres), `` `` `` escape.
    if (ch === "`") {
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      push("ident", start, i);
      continue;
    }

    // `[...]` — quoted identifier (MSSQL).
    if (ch === "[") {
      const start = i;
      i++;
      while (i < n && sql[i] !== "]") i++;
      if (i < n) i++; // consume `]`
      push("ident", start, i);
      continue;
    }

    // Numbers: integer, decimal, exponent. A leading `.` only starts a number
    // if a digit follows (so `t.x` keeps `.` as punctuation).
    if (isDigit(ch) || (ch === "." && isDigit(sql[i + 1]))) {
      const start = i;
      while (i < n && isDigit(sql[i])) i++;
      if (sql[i] === "." && isDigit(sql[i + 1])) {
        i++;
        while (i < n && isDigit(sql[i])) i++;
      }
      if (
        (sql[i] === "e" || sql[i] === "E") &&
        (isDigit(sql[i + 1]) ||
          ((sql[i + 1] === "+" || sql[i + 1] === "-") && isDigit(sql[i + 2])))
      ) {
        i++;
        if (sql[i] === "+" || sql[i] === "-") i++;
        while (i < n && isDigit(sql[i])) i++;
      }
      push("number", start, i);
      continue;
    }

    // Identifier or keyword (maximal run of word chars; keyword match is
    // case-insensitive against the reserved-word set).
    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(sql[i])) i++;
      const word = sql.slice(start, i);
      push(
        SQL_HIGHLIGHT_KEYWORDS.has(word.toUpperCase()) ? "keyword" : "ident",
        start,
        i,
      );
      continue;
    }

    // Anything else is punctuation (a single character token).
    push("punct", i, i + 1);
    i++;
  }

  return tokens;
}

/**
 * Build a DocumentFragment of `<span class="vsdb-sql-tok-<kind>">` nodes for
 * the given SQL. Every character is written back through span.textContent —
 * never through an HTML string — so hostile SQL cannot execute or create
 * elements.
 */
export function highlightSql(sql: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const tok of tokenizeSql(sql)) {
    const span = document.createElement("span");
    span.className = tokenClass(tok.kind);
    span.textContent = tok.text;
    frag.appendChild(span);
  }
  return frag;
}
