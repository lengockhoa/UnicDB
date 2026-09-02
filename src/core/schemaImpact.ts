// src/core/schemaImpact.ts
// TASK-ARP07-001 — pure schema-impact classifier (KHÔNG import vscode).
// Quyết định: nếu statement này ĐÃ chạy thành công thì nó có làm thay đổi
// "schema surface" (danh sách table/column/index... mà schema cache/context
// cache đang giữ) hay không — dùng để invalidate cache/context sau batch.
//
// Reconciliation với họ classifier hiện có:
//   - Reuse `maskLiteralsAndComments` từ ./dangerousStatement (KHÔNG viết
//     parser mới) → keyword nằm trong string literal / comment / dollar-quote
//     / backtick identifier không bao giờ trigger (B6 safety, cùng contract).
//   - Keyword set là TẬP CON NGHIÊM của `readOnlyIntent`'s MUTATION_KEYWORDS
//     trên các DDL keyword (`create`, `alter`, `drop`), CỘNG `rename`
//     (MySQL `RENAME TABLE a TO b` / Postgres `ALTER ... RENAME` variant đã
//     bắt bởi `alter`) — `rename` KHÔNG có trong readOnlyIntent's table.
//   - DML / data-only / maintenance (insert, update, delete, merge, truncate,
//     vacuum, analyze...) → false: chúng đổi DATA, không đổi schema surface.
//   - `drop` trùng với tier "red" confirm của dangerousStatement (mọi DROP
//     đều red) — classifier này KHÔNG thay thế guard confirm, nó chỉ báo
//     cache invalidation.
//
// Depth-0 contract (giống analyzeStatement): scan word ở paren-depth 0;
// prelude `WITH` bị bỏ qua (body CTE nằm trong parens nên tự nhiên bị skip)
// và keyword statement ĐẦU TIÊN ở depth 0 quyết định. Thuật toán KHÔNG phân
// biệt dialect — chỉ masking là dialect-driven (MySQL backslash escape,
// backtick identifier), y như readOnlyIntent.
//
// Deliberate non-goal: EXPLAIN prelude không được skip (khác analyzeStatement)
// vì corpus của task không pin hành vi đó và việc gọi `EXPLAIN ANALYZE DDL`
// qua lane này là outside contract — feeder (TASK-ARP07-004) chịu trách nhiệm
// statement list nó đưa vào.

import type { SqlDialect } from "./statementParser";
import { maskLiteralsAndComments } from "./dangerousStatement";

/**
 * Depth-0 keyword mở đầu statement làm thay đổi schema surface nếu chạy
 * thành công. Case-insensitive (lowercased trước lookup). Mọi DML / DCL /
 * data-only / maintenance keyword cố ý KHÔNG có trong bảng này.
 */
const SCHEMA_IMPACT_KEYWORDS: Record<string, true> = {
  create: true,
  alter: true,
  drop: true,
  rename: true,
};

/**
 * Sau prelude `WITH`, chỉ keyword mở đầu statement chính mới được quyết định
 * (mirror STATEMENT_STARTERS của dangerousStatement, cộng `rename` cho đủ).
 * Với SQL hợp lệ, statement chính sau WITH luôn là SELECT/INSERT/UPDATE/
 * DELETE/MERGE — không bao giờ có schema impact; bảng này chỉ để hành vi
 * giữ nguyên hình dạng contract của analyzeStatement (conservative-true với
 * SQL bất hợp lệ type DDL sau WITH, vô hại với cache invalidation).
 */
const POST_WITH_STARTERS: Record<string, true> = {
  delete: true,
  truncate: true,
  drop: true,
  update: true,
  insert: true,
  select: true,
  merge: true,
  create: true,
  alter: true,
  rename: true,
};

/**
 * Depth-0 first-keyword scan trên text ĐÃ mask literal/comment.
 * `WITH x AS (SELECT 1) SELECT * FROM x` → SELECT sau CTE ở depth 0 nhưng
 * không nằm trong SCHEMA_IMPACT_KEYWORDS → false; mọi word trong parens
 * (CTE body, `count(*)`, column list) bị skip theo depth.
 */
function statementHasSchemaImpact(masked: string): boolean {
  const wordRe = /[A-Za-z_][A-Za-z0-9_]*|\(|\)/g;
  wordRe.lastIndex = 0;
  let depth = 0;
  let sawWith = false;
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
    if (!sawWith) {
      if (lower === "with") {
        sawWith = true;
        continue;
      }
      // Keyword depth-0 ĐẦU TIÊN quyết định (cùng contract analyzeStatement).
      return SCHEMA_IMPACT_KEYWORDS[lower] === true;
    }
    // withMode: chỉ statement starter mới quyết định.
    if (POST_WITH_STARTERS[lower]) {
      return SCHEMA_IMPACT_KEYWORDS[lower] === true;
    }
  }
  return false;
}

/**
 * True nếu `sql` (một statement, đã mask literal/comment theo `dialect`)
 * mở đầu bằng DDL keyword depth-0 — tức là nếu nó hoàn thành thành công,
 * schema surface sẽ đổi.
 *
 * Dialect contract (giống readOnlyIntent): candidates là `postgres` |
* `mysql` | `mssql` (optional; bỏ qua ~= postgres-ish). Phân loại keyword
 * dialect-AGNOSTIC; chỉ literal/identifier masking là dialect-DRIVEN
 * (MySQL `'...\'...'` escape, backtick identifier) qua
 * `maskLiteralsAndComments`.
 */
export function hasSchemaImpact(sql: string, dialect?: SqlDialect): boolean {
  return statementHasSchemaImpact(maskLiteralsAndComments(sql, dialect));
}

/**
 * Batch helper cho executor (TASK-ARP07-004): true iff ANY completed
 * statement trong batch có schema impact → invalidate schema/context cache.
 * Empty batch / tất cả SELECT-DML-maintenance → false (no-op).
 */
export function completedSchemaImpact(
  completed: readonly string[],
  dialect?: SqlDialect,
): boolean {
  for (const stmt of completed) {
    if (hasSchemaImpact(stmt, dialect)) return true;
  }
  return false;
}
