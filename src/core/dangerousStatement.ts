// src/core/dangerousStatement.ts
// TASK-606 — Detector thuần (KHÔNG import vscode) phân loại mức nguy hiểm của
// một statement SQL để extension quyết định modal confirm.
//
// Thuật toán:
//   1. Mask string `'...'`, identifier `"..."`, MySQL backtick identifier
//      `` `...` `` (dialect mysql only), dollar-quote `$tag$...$tag$`,
//      comment `--` và `/* */` thành space (giữ nguyên độ dài) → keyword nằm
//      trong literal/comment không bị tính.
//   2. Scan word ở paren-depth 0: bỏ qua `with` (phần CTE nằm trong parens nên
//      tự động bị bị qua); keyword ĐẦU TIÊN quyết định `kind`.
//   3. `hasWhere` = có `\bwhere\b` trong text đã mask.
// TASK-AHL-004 — bổ sung DCL admin (GRANT/REVOKE/KILL/TERMINATE) + tier admin-red.

import type { SqlDialect } from "./statementParser";

export type DangerousKind =
  | "delete"
  | "truncate"
  | "drop"
  | "update"
  | "grant"
  | "revoke"
  | "kill"
  | "terminate"
  | "other";

export interface StatementAnalysis {
  kind: DangerousKind;
  hasWhere: boolean;
}

export type GuardTier = "red" | "amber" | "none" | "admin-red";

const DML_KINDS: Record<string, DangerousKind> = {
  delete: "delete",
  truncate: "truncate",
  drop: "drop",
  update: "update",
  grant: "grant",
  revoke: "revoke",
};

/**
 * TASK-AHL-004 — admin DCL session-control helpers. We don't use DML_KINDS
 * for these because the depth-0 first-word kind rule already classifies
 * `SELECT pg_cancel_backend(...)` as "other" (kind comes from the leading
 * SELECT). Detect the wrapped function instead, case-insensitive, after
 * masking literals/comments (B6 safety).
 */
export function isPgBackendAdminCall(masked: string): DangerousKind | null {
  const fn = /\bpg_(cancel|terminate)_backend\s*\(/i.exec(masked);
  if (!fn) return null;
  return fn[1].toLowerCase() === "terminate" ? "terminate" : "kill";
}

/** Keyword có thể mở đầu statement chính sau prelude `WITH ... AS (...)`. */
const STATEMENT_STARTERS: Record<string, true> = {
  delete: true,
  truncate: true,
  drop: true,
  update: true,
  insert: true,
  select: true,
  merge: true,
  create: true,
  alter: true,
};

/**
 * Thay nội dung literal/comment bằng space, giữ nguyên độ dài chuỗi để offset
 * và ranh giới word không đổi.
 *
 * Exported (review fix round C, Finding #1) so `postgres.ts:shouldUseCursor`
 * can reuse the SAME literal/comment/dollar-quote masking to scan for a
 * top-level `INSERT|UPDATE|DELETE|MERGE` token when deciding whether a
 * `WITH ...` statement is a data-modifying CTE (must NOT go to `DECLARE
 * CURSOR` — Postgres rejects that) — instead of duplicating this logic.
 *
 * `dialect` (review fix round C, Finding #5) — optional & additive, mirrors
 * `statementParser.ts`'s `readString`: when `dialect === "mysql"`, `\x`
 * inside a `'...'` string escapes the next char (including `\'`), matching
 * `splitStatements(sql, "mysql")`'s tokenizing EXACTLY. Without this, once
 * callers start passing a real dialect through `splitStatements` (Finding
 * #3), this masker could disagree with the parser on where a MySQL string
 * literal ends — a `\'`-containing DELETE/UPDATE string could leak fake
 * `WHERE` text (or swallow a real one), silently flipping the guard tier.
 * Omitting `dialect` stays byte-identical to before (`''`-escape only).
 */
export function maskLiteralsAndComments(
  sql: string,
  dialect?: SqlDialect,
): string {
  const useBackslashEscape = dialect === "mysql";
  const out = sql.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    // Line comment `-- ... \n`
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      blank(i, end);
      i = end;
      continue;
    }

    // Block comment `/* ... */` (Postgres cho nested, xử lý theo depth).
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    // String literal `'...'` với escape `''` (mọi dialect) hoặc `\x`
    // (MySQL, khi `useBackslashEscape` — Finding #5, khớp readString()).
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (useBackslashEscape && sql[j] === "\\" && j + 1 < sql.length) {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Quoted identifier `"..."` với escape `""`.
    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // TASK-ARP01-001 — MySQL backtick-quoted identifier `` `...` `` with the
    // standard doubling escape (``` `` ```). Gated on `dialect === "mysql"`
    // because a bare backtick is not SQL syntax in postgres/mssql, and
    // masking it there would desync this masker from `splitStatements`'
    // tokenizer, which also only understands backticks under mysql. Without
    // this branch, `` SELECT `insert` FROM t `` leaks the identifier body as
    // a fake statement keyword into the depth-scan (read-only guard false
    // positive). Mirrors the `"`-identifier branch above (doubling escape
    // only; MySQL's backslash escape inside identifiers is intentionally not
    // handled — same limitation the `"` branch documents).
    if (ch === "`" && useBackslashEscape) {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "`") {
          if (sql[j + 1] === "`") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }

    // Dollar-quote `$$...$$` hoặc `$tag$...$tag$`.
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? sql.length : close + tag.length;
        blank(i, end);
        i = end;
        continue;
      }
    }

    i += 1;
  }

  return out.join("");
}

/**
 * Phân loại statement: kind theo keyword DML depth-0 đầu tiên + có WHERE hay
 * không. `dialect` (Finding #5) — optional & additive, threaded straight
 * into `maskLiteralsAndComments` so this stays in sync with whatever
 * dialect `splitStatements` used to produce `sql` in the first place.
 * TASK-AHL-004: sau khi keyword scan xong, nếu kind còn là "other" thì
 * dò thêm `pg_cancel_backend(...)` / `pg_terminate_backend(...)` ở depth 0.
 */
export function analyzeStatement(
  sql: string,
  dialect?: SqlDialect,
): StatementAnalysis {
  const masked = maskLiteralsAndComments(sql, dialect);
  const hasWhere = /\bwhere\b/i.test(masked);

  let kind: DangerousKind = "other";
  let depth = 0;
  let sawWith = false;
  let sawExplain = false;
  const wordRe = /[A-Za-z_][A-Za-z0-9_]*|\(|\)/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(masked)) !== null) {
    const tok = m[0];
    if (tok === "(") {
      depth += 1;
      continue;
    }
    if (tok === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    const lower = tok.toLowerCase();

    // Prelude `EXPLAIN [ANALYZE|ANALYSE|VERBOSE] [(options...)]` ở depth 0:
    // bỏ qua mọi modifier/option cho tới khi gặp statement thật.
    // `analyzeStatement` (Postgres) hay `analyse`/`verbose` chỉ là phụ
    // của EXPLAIN; cũng chấp nhận từ trong parens-options qua depth>0 ở trên.
    if (!sawWith && !sawExplain) {
      if (lower === "explain") {
        sawExplain = true;
        continue;
      }
    } else if (sawExplain) {
      // Modifier EXPLAIN ở depth 0: analyze / analyse / verbose — bỏ qua.
      if (lower === "analyze" || lower === "analyse" || lower === "verbose") {
        continue;
      }
      // Hết modifier — chuyển sang xử lý bình thường.
      sawExplain = false;
    }

    if (!sawWith) {
      if (lower === "with") {
        // Sau `WITH`, phần CTE (tên + `AS (...)`) ở depth 0 xen kẽ parens —
        // phải bỏ qua tới keyword statement thật.
        sawWith = true;
        continue;
      }
      kind = DML_KINDS[lower] ?? "other";
      break;
    }
    // withMode: chỉ keyword mở đầu statement mới quyết định kind.
    if (STATEMENT_STARTERS[lower]) {
      kind = DML_KINDS[lower] ?? "other";
      break;
    }
  }

  // TASK-AHL-004 — admin session-control detection. Sau khi keyword scan đã
  // settle kind (thường là "other" cho `SELECT pg_cancel_backend(...)`), dò
  // trong WHOLE masked body xem có wrapped pg_*_backend call không. Vì đã
  // mask literals/comments nên fake `pg_cancel_backend` trong string/comment
  // không lọt được.
  if (kind === "other") {
    const admin = isPgBackendAdminCall(masked);
    if (admin !== null) kind = admin;
  }

  return { kind, hasWhere };
}

/**
 * Tier confirm: red = mất dữ liệu diện rộng (DELETE/UPDATE không WHERE, mọi
 * TRUNCATE/DROP); amber = DELETE có điều kiện; admin-red = GRANT/REVOKE/KILL/
 * TERMINATE (luôn confirm — TASK-AHL-004); none = không hỏi.
 */
export function guardTier(a: StatementAnalysis): GuardTier {
  switch (a.kind) {
    case "truncate":
    case "drop":
      return "red";
    case "delete":
      return a.hasWhere ? "amber" : "red";
    case "update":
      return a.hasWhere ? "none" : "red";
    case "grant":
    case "revoke":
    case "kill":
    case "terminate":
      return "admin-red";
    default:
      return "none";
  }
}
