// src/core/dangerousStatement.ts
// TASK-606 — Detector thuần (KHÔNG import vscode) phân loại mức nguy hiểm của
// một statement SQL để extension quyết định modal confirm.
//
// Thuật toán:
//   1. Mask string `'...'`, identifier `"..."`, dollar-quote `$tag$...$tag$`,
//      comment `--` và `/* */` thành space (giữ nguyên độ dài) → keyword nằm
//      trong literal/comment không bị tính.
//   2. Scan word ở paren-depth 0: bỏ qua `with` (phần CTE nằm trong parens nên
//      tự động bị bỏ qua); keyword ĐẦU TIÊN quyết định `kind`.
//   3. `hasWhere` = có `\bwhere\b` trong text đã mask.

export type DangerousKind = "delete" | "truncate" | "drop" | "update" | "other";

export interface StatementAnalysis {
  kind: DangerousKind;
  hasWhere: boolean;
}

export type GuardTier = "red" | "amber" | "none";

const DML_KINDS: Record<string, DangerousKind> = {
  delete: "delete",
  truncate: "truncate",
  drop: "drop",
  update: "update",
};

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
 */
function maskLiteralsAndComments(sql: string): string {
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

    // String literal `'...'` với escape `''`.
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
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

/** Phân loại statement: kind theo keyword DML depth-0 đầu tiên + có WHERE hay không. */
export function analyzeStatement(sql: string): StatementAnalysis {
  const masked = maskLiteralsAndComments(sql);
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

  return { kind, hasWhere };
}

/**
 * Tier confirm: red = mất dữ liệu diện rộng (DELETE/UPDATE không WHERE, mọi
 * TRUNCATE/DROP); amber = DELETE có điều kiện; none = không hỏi.
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
    default:
      return "none";
  }
}
