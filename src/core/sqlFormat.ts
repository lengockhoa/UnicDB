// src/core/sqlFormat.ts
// TASK-AF-003 — pure SQL formatter (zero non-stdlib imports).
// Tokenize → classify clauses → render with line breaks at clause
// boundaries, indent at clause opens + subquery depth. Strings,
// comments, and identifiers are preserved verbatim; only the casing
// of known keywords is changed.

export type FormatOptions = {
  keywordCase?: "upper" | "lower";
  indent?: string;
};

// Clauses that begin a new line at the same indent as the leading SELECT.
const CLAUSE_TOP: Record<string, true> = {
  SELECT: true,
  FROM: true,
  WHERE: true,
  GROUP: true,
  ORDER: true,
  HAVING: true,
  LIMIT: true,
  OFFSET: true,
  UNION: true,
  INTERSECT: true,
  EXCEPT: true,
  VALUES: true,
  RETURNING: true,
  INSERT: true,
  UPDATE: true,
  DELETE: true,
  SET: true,
  INTO: true,
  CREATE: true,
  ALTER: true,
  DROP: true,
  TRUNCATE: true,
  EXPLAIN: true,
};

// Clauses that nest one level deeper (under FROM).
const CLAUSE_JOIN: Record<string, true> = {
  JOIN: true,
  INNER: true,
  LEFT: true,
  RIGHT: true,
  FULL: true,
  CROSS: true,
  OUTER: true,
  ON: true,
  USING: true,
};

// Recognized keyword upper-case forms for casing normalization.
const KNOWN_KEYWORDS: Record<string, true> = {
  ...CLAUSE_TOP,
  ...CLAUSE_JOIN,
  BY: true,
  AND: true,
  OR: true,
  NOT: true,
  AS: true,
  ALL: true,
  DISTINCT: true,
  NULL: true,
  IS: true,
  IN: true,
  BETWEEN: true,
  LIKE: true,
  CASE: true,
  WHEN: true,
  THEN: true,
  ELSE: true,
  END: true,
  ASC: true,
  DESC: true,
  NULLS: true,
  FIRST: true,
  LAST: true,
  TABLE: true,
  VIEW: true,
  INDEX: true,
  IF: true,
  EXISTS: true,
  WITH: true,
  RECURSIVE: true,
  OVER: true,
  PARTITION: true,
  TRUE: true,
  FALSE: true,
  DEFAULT: true,
  PRIMARY: true,
  KEY: true,
  FOREIGN: true,
  REFERENCES: true,
  UNIQUE: true,
  CHECK: true,
  CONSTRAINT: true,
  CASCADE: true,
  RESTRICT: true,
};

// Multi-word clause heads whose second word stays on the same line.
const CLAUSE_TAIL: Record<string, true> = {
  BY: true,
  INTO: true,
  TABLE: true,
};

type TokKind =
  | "ws"
  | "ident"
  | "number"
  | "string"
  | "comment"
  | "punct";

interface Tok {
  kind: TokKind;
  text: string;
  upper: string;
  isKeyword: boolean;
}

function isAsciiLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      let j = i + 1;
      while (j < n) {
        const c = input[j]!;
        if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
        j++;
      }
      toks.push({
        kind: "ws",
        text: input.slice(i, j),
        upper: "",
        isKeyword: false,
      });
      i = j;
      continue;
    }
    if (ch === "-" && input[i + 1] === "-") {
      let j = i + 2;
      while (j < n && input[j] !== "\n") j++;
      toks.push({
        kind: "comment",
        text: input.slice(i, j),
        upper: "",
        isKeyword: false,
      });
      i = j;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      let j = i + 2;
      while (j < n - 1 && !(input[j] === "*" && input[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      toks.push({
        kind: "comment",
        text: input.slice(i, j),
        upper: "",
        isKeyword: false,
      });
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (input[j] === quote) {
          if (input[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      toks.push({
        kind: "string",
        text: input.slice(i, j),
        upper: "",
        isKeyword: false,
      });
      i = j;
      continue;
    }
    if (isDigit(ch) || (ch === "." && isDigit(input[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n) {
        const c = input[j]!;
        if (isDigit(c) || c === "." || c === "e" || c === "E") {
          j++;
        } else break;
      }
      toks.push({
        kind: "number",
        text: input.slice(i, j),
        upper: "",
        isKeyword: false,
      });
      i = j;
      continue;
    }
    if (
      isAsciiLetter(ch) ||
      ch === "_" ||
      ch === "$" ||
      ch === "@"
    ) {
      let j = i + 1;
      while (j < n) {
        const c = input[j]!;
        if (
          isAsciiLetter(c) ||
          isDigit(c) ||
          c === "_" ||
          c === "$" ||
          c === "@" ||
          c === "."
        ) {
          j++;
        } else break;
      }
      const text = input.slice(i, j);
      const upper = text.toUpperCase();
      toks.push({
        kind: "ident",
        text,
        upper,
        isKeyword: KNOWN_KEYWORDS[upper] === true,
      });
      i = j;
      continue;
    }
    toks.push({
      kind: "punct",
      text: ch,
      upper: "",
      isKeyword: false,
    });
    i++;
  }
  return toks;
}

interface FormatState {
  indentUnit: string;
  keywordCase: "upper" | "lower";
  out: string[];
  baseIndent: number;
  needNewline: boolean;
  prevChar: string;
  lastEmittedIdentUpper: string;
  lastEmittedIdentIsKeyword: boolean;
  lastWasIdent: boolean;
  lastWasOpenParen: boolean;
  followClauseSameLine: boolean;
}

function emitNewline(s: FormatState, indentLevel: number): void {
  s.out.push("\n");
  for (let i = 0; i < indentLevel; i++) s.out.push(s.indentUnit);
  s.prevChar = s.indentUnit.length > 0 ? s.indentUnit[s.indentUnit.length - 1]! : "";
}

function ensureSpace(s: FormatState): void {
  if (s.prevChar === "" || /\s/.test(s.prevChar)) return;
  s.out.push(" ");
  s.prevChar = " ";
}

function noteIdent(s: FormatState, upper: string, isKw: boolean): void {
  s.lastEmittedIdentUpper = upper;
  s.lastEmittedIdentIsKeyword = isKw;
  s.lastWasIdent = true;
  s.lastWasOpenParen = false;
}

function needsSpaceBefore(prevChar: string): boolean {
  return prevChar !== "" && !/\s/.test(prevChar);
}

function isDigitChar(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function formatStatement(
  tokens: Tok[],
  opts: { indentUnit: string; keywordCase: "upper" | "lower" },
): string {
  const s: FormatState = {
    indentUnit: opts.indentUnit,
    keywordCase: opts.keywordCase,
    out: [],
    baseIndent: 0,
    needNewline: false,
    prevChar: "",
    lastEmittedIdentUpper: "",
    lastEmittedIdentIsKeyword: false,
    lastWasIdent: false,
    lastWasOpenParen: false,
    followClauseSameLine: false,
  };

  let i = 0;

  while (i < tokens.length) {
    const t = tokens[i]!;

    if (t.kind === "ws") {
      i++;
      continue;
    }

    if (t.kind === "comment") {
      if (t.text.startsWith("--")) {
        if (s.out.length > 0) {
          const last = s.out[s.out.length - 1]!;
          const lc = last[last.length - 1] ?? "";
          if (lc !== "" && lc !== "\n" && lc !== " ") s.out.push(" ");
        }
        s.out.push(t.text);
        s.prevChar = "\n";
        s.needNewline = true;
        s.lastWasIdent = false;
        s.lastWasOpenParen = false;
        s.followClauseSameLine = false;
        i++;
        continue;
      }
      // Block comment: inline.
      if (s.needNewline) {
        emitNewline(s, s.baseIndent);
        s.needNewline = false;
      }
      if (needsSpaceBefore(s.prevChar)) s.out.push(" ");
      s.out.push(t.text);
      s.prevChar = " ";
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.kind === "ws") j++;
      const next = j < tokens.length ? tokens[j]! : null;
      if (next && next.kind !== "punct" && next.kind !== "comment") {
        s.out.push(" ");
        s.prevChar = " ";
      }
      s.lastWasIdent = false;
      s.lastWasOpenParen = false;
      s.followClauseSameLine = false;
      i++;
      continue;
    }

    if (t.kind === "string" || t.kind === "number") {
      if (s.needNewline) {
        emitNewline(s, s.baseIndent);
        s.needNewline = false;
      }
      if (
        needsSpaceBefore(s.prevChar) &&
        s.prevChar !== "(" &&
        s.prevChar !== "."
      ) {
        s.out.push(" ");
      }
      s.out.push(t.text);
      s.prevChar = t.text[t.text.length - 1]!;
      s.lastWasIdent = false;
      s.lastWasOpenParen = false;
      s.followClauseSameLine = false;
      i++;
      continue;
    }

    if (t.kind === "punct") {
      const ch = t.text;
      if (ch === "(") {
        if (s.needNewline) {
          emitNewline(s, s.baseIndent);
          s.needNewline = false;
        }
        if (
          needsSpaceBefore(s.prevChar) &&
          s.prevChar !== "(" &&
          s.prevChar !== "."
        ) {
          s.out.push(" ");
        }
        s.out.push("(");
        s.prevChar = "(";
        s.lastWasIdent = false;
        s.lastWasOpenParen = true;
        s.followClauseSameLine = false;
        if (
          s.lastEmittedIdentIsKeyword &&
          (s.lastEmittedIdentUpper === "FROM" || s.lastEmittedIdentUpper === "TABLE")
        ) {
          s.baseIndent += 1;
          s.needNewline = true;
        }
        i++;
        continue;
      }
      if (ch === ")") {
        let j = i + 1;
        while (j < tokens.length && tokens[j]!.kind === "ws") j++;
        const next = j < tokens.length ? tokens[j]! : null;
        const closeOfSubquery =
          next === null ||
          (next &&
            next.kind === "ident" &&
            (next.isKeyword
              ? CLAUSE_TOP[next.upper] === true
              : true)) ||
          (next && next.kind === "punct" && (next.text === ";" || next.text === ")"));
        if (closeOfSubquery && s.baseIndent > 0) {
          s.needNewline = true;
          s.baseIndent -= 1;
          emitNewline(s, s.baseIndent);
          s.needNewline = false;
        }
        if (
          needsSpaceBefore(s.prevChar) &&
          s.prevChar !== "(" &&
          !s.lastWasIdent &&
          !isDigitChar(s.prevChar)
        ) {
          s.out.push(" ");
        }
        s.out.push(")");
        s.prevChar = ")";
        s.lastWasIdent = false;
        s.lastWasOpenParen = false;
        s.followClauseSameLine = false;
        i++;
        continue;
      }
      if (ch === ",") {
        if (s.needNewline) {
          emitNewline(s, s.baseIndent);
          s.needNewline = false;
        }
        s.out.push(",");
        s.prevChar = ",";
        let j = i + 1;
        while (j < tokens.length && tokens[j]!.kind === "ws") j++;
        const next = j < tokens.length ? tokens[j]! : null;
        if (
          next &&
          !(next.kind === "punct" && (next.text === ")" || next.text === "," || next.text === ";"))
        ) {
          s.out.push(" ");
          s.prevChar = " ";
        }
        s.lastWasIdent = false;
        s.lastWasOpenParen = false;
        s.followClauseSameLine = false;
        i++;
        continue;
      }
      if (ch === ";") {
        s.out.push(";");
        s.prevChar = ";";
        s.needNewline = true;
        s.lastWasIdent = false;
        s.lastWasOpenParen = false;
        s.lastEmittedIdentUpper = "";
        s.lastEmittedIdentIsKeyword = false;
        s.followClauseSameLine = false;
        i++;
        continue;
      }
      // Operator.
      if (s.needNewline) {
        emitNewline(s, s.baseIndent);
        s.needNewline = false;
      }
      if (
        needsSpaceBefore(s.prevChar) &&
        s.prevChar !== "(" &&
        s.prevChar !== "," &&
        s.prevChar !== "."
      ) {
        s.out.push(" ");
      }
      s.out.push(ch);
      let j = i + 1;
      while (j < tokens.length && tokens[j]!.kind === "ws") j++;
      const next = j < tokens.length ? tokens[j]! : null;
      const isClosing =
        next &&
        next.kind === "punct" &&
        (next.text === ")" || next.text === "," || next.text === ";");
      if (!isClosing) {
        s.out.push(" ");
        s.prevChar = " ";
      } else {
        s.prevChar = ch;
      }
      s.lastWasIdent = false;
      s.lastWasOpenParen = false;
      s.followClauseSameLine = false;
      i++;
      continue;
    }

    if (t.kind === "ident") {
      const text =
        t.isKeyword
          ? s.keywordCase === "lower"
            ? t.text.toLowerCase()
            : t.text.toUpperCase()
          : t.text;
      const upper = t.upper;

      // Multi-word tail (BY, INTO, TABLE) — same line as previous clause head.
      if (t.isKeyword && CLAUSE_TAIL[upper] === true && s.prevChar !== "") {
        if (!/\s/.test(s.prevChar)) s.out.push(" ");
        s.out.push(text);
        s.prevChar = text[text.length - 1]!;
        noteIdent(s, upper, true);
        s.followClauseSameLine = false;
        i++;
        continue;
      }

      // INSERT/UPDATE/DELETE: keep on same line; flag the next top-clause
      // to also stay on same line (DELETE FROM, UPDATE SET, INSERT INTO,
      // INSERT VALUES).
      if (
        t.isKeyword &&
        (upper === "INSERT" || upper === "UPDATE" || upper === "DELETE")
      ) {
        if (s.needNewline) {
          emitNewline(s, s.baseIndent);
          s.needNewline = false;
        } else if (s.prevChar !== "") {
          ensureSpace(s);
        }
        s.out.push(text);
        s.prevChar = text[text.length - 1]!;
        noteIdent(s, upper, true);
        s.followClauseSameLine = true;
        i++;
        continue;
      }

      // Top-level clauses.
      if (t.isKeyword && CLAUSE_TOP[upper] === true) {
        if (s.followClauseSameLine) {
          if (needsSpaceBefore(s.prevChar)) s.out.push(" ");
          s.followClauseSameLine = false;
        } else if (s.prevChar !== "") {
          // Inside a subquery, SELECT sits at baseIndent and other clauses
          // are indented one level deeper.
          const inSubquery = s.baseIndent > 0;
          const clauseIndent =
            inSubquery && upper !== "SELECT" ? s.baseIndent + 1 : s.baseIndent;
          emitNewline(s, clauseIndent);
        }
        s.needNewline = false;
        s.out.push(text);
        s.prevChar = text[text.length - 1]!;
        noteIdent(s, upper, true);
        i++;
        continue;
      }

      if (t.isKeyword && CLAUSE_JOIN[upper] === true) {
        if (upper === "ON" || upper === "USING") {
          emitNewline(s, s.baseIndent + 1);
          s.needNewline = false;
          s.out.push(text);
          s.prevChar = text[text.length - 1]!;
          noteIdent(s, upper, true);
          s.followClauseSameLine = false;
          i++;
          continue;
        }
        const prevIsJoinFam =
          s.lastEmittedIdentIsKeyword &&
          (CLAUSE_JOIN[s.lastEmittedIdentUpper] === true ||
            s.lastEmittedIdentUpper === "FROM" ||
            s.lastEmittedIdentUpper === "TABLE");
        if (prevIsJoinFam) {
          if (needsSpaceBefore(s.prevChar)) s.out.push(" ");
          s.out.push(text);
          s.prevChar = text[text.length - 1]!;
        } else {
          emitNewline(s, s.baseIndent + 1);
          s.needNewline = false;
          s.out.push(text);
          s.prevChar = text[text.length - 1]!;
        }
        noteIdent(s, upper, true);
        s.followClauseSameLine = false;
        i++;
        continue;
      }

      // Generic keyword or identifier.
      if (s.needNewline) {
        emitNewline(s, s.baseIndent);
        s.needNewline = false;
      } else if (
        needsSpaceBefore(s.prevChar) &&
        s.prevChar !== "(" &&
        s.prevChar !== "."
      ) {
        s.out.push(" ");
      }
      s.out.push(text);
      s.prevChar = text[text.length - 1]!;
      noteIdent(s, upper, t.isKeyword);
      s.followClauseSameLine = false;
      i++;
      continue;
    }

    i++;
  }

  let result = s.out.join("");
  result = result.replace(/[ \t]+$/gm, "");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.trim();
  return result;
}

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const n = sql.length;
  let parens = 0;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      buf += ch;
      i++;
      while (i < n) {
        const c = sql[i]!;
        buf += c;
        if (c === quote) {
          if (sql[i + 1] === quote) {
            buf += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        buf += sql[i]!;
        i++;
      }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      buf += "/*";
      i += 2;
      while (i < n - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) {
        buf += sql[i]!;
        i++;
      }
      if (i < n) {
        buf += "*/";
        i += 2;
      }
      continue;
    }
    if (ch === "(") parens++;
    if (ch === ")") parens = Math.max(0, parens - 1);
    if (ch === ";" && parens === 0) {
      buf += ";";
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

export function formatSql(sql: string, opts: FormatOptions = {}): string {
  const keywordCase = opts.keywordCase ?? "upper";
  const indentUnit = opts.indent ?? "  ";

  if (!sql || /^\s*$/.test(sql)) return "";

  const stmts = splitStatements(sql);
  const formatted: string[] = [];
  for (const raw of stmts) {
    if (/^\s*$/.test(raw)) continue;
    const toks = tokenize(raw);
    formatted.push(formatStatement(toks, { indentUnit, keywordCase }));
  }
  return formatted.join("\n\n");
}
