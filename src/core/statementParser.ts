// src/core/statementParser.ts
// Parser SQL thuần (không phụ thuộc vscode) — tách SQL thành statements.
// Nhận biết:
//   - String literal `'...'` (escape `''`)
//   - Identifier double-quote `"..."` (escape `""`)
//   - Dollar-quote `$$...$$` và `$tag$...$tag$` (Postgres)
//   - Comment `-- ... \n` và `/* ... */`
//   - Khối BEGIN...END = 1 statement
//
// Hàm export theo spec TASK-002 §Interfaces:
//   splitStatements(sql): ParsedStatement[]
//   statementAtCursor(sql, offset): ParsedStatement | null
//   sqlToRun(sql, selection?, cursorOffset): { statements; mode }
import type { ParsedStatement } from "../config/types";

/**
 * Dialect SQL — TASK-004: điều khiển các quy tắc tokenizing/split đặc thù
 * theo dialect (backslash escape của MySQL, batch separator `GO` của MSSQL).
 * Optional & additive: bỏ qua ⇒ hành vi postgres-ish như trước TASK-004.
 */
export type SqlDialect = "postgres" | "mysql" | "mssql";

// ---- Trạng thái tokenizing -------------------------------------------------

enum TokenKind {
  Code = 0,
  String = 1, // '...'
  Identifier = 2, // "..."
  DollarQuote = 3, // $$...$$ hoặc $tag$...$tag$
  LineComment = 4, // -- ...
  BlockComment = 5, // /* ... */
}

interface TokenState {
  kind: TokenKind;
  /** tag của dollar-quote (vd `$$` hoặc `$fn$`); undefined với token khác */
  tag: string;
}

/**
 * Đọc 1 token từ `sql` tại `i`, trả về state mới + index ngay SAU token.
 * Nếu state vào là Code và gặp ký tự mở → trả về token tương ứng.
 * Nếu state đã vào 1 token → chỉ tìm ký tự đóng, trả về Code + index mới.
 */
function readToken(
  sql: string,
  i: number,
  state: TokenState,
  useBackslashEscape: boolean,
): { nextState: TokenState; nextIndex: number } {
  // Đang trong token → tìm đóng.
  if (state.kind === TokenKind.String) {
    return readString(sql, i, useBackslashEscape);
  }
  if (state.kind === TokenKind.Identifier) {
    return readIdentifier(sql, i);
  }
  if (state.kind === TokenKind.DollarQuote) {
    return readDollarQuote(sql, i, state.tag);
  }
  if (state.kind === TokenKind.LineComment) {
    return readLineComment(sql, i);
  }
  if (state.kind === TokenKind.BlockComment) {
    return readBlockComment(sql, i);
  }
  // Code → tìm ký tự mở token tiếp theo.
  return startNextToken(sql, i);
}

function readString(
  sql: string,
  i: number,
  useBackslashEscape: boolean,
): { nextState: TokenState; nextIndex: number } {
  // Vào đây khi đã thấy `'` mở; i trỏ tới ký tự SAU dấu `'` mở.
  while (i < sql.length) {
    const ch = sql[i];
    // MySQL (dialect-conditional, TASK-004 C3): `\x` escape bất kỳ ký tự
    // theo sau, kể cả `\'` — postgres/mssql giữ nguyên hành vi cũ (backslash
    // là ký tự thường, KHÔNG escape).
    if (useBackslashEscape && ch === "\\" && i + 1 < sql.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      // Có thể là escape `''` hoặc đóng string.
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        i += 2; // skip escape
        continue;
      }
      // Đóng string.
      return {
        nextState: { kind: TokenKind.Code, tag: "" },
        nextIndex: i + 1,
      };
    }
    i += 1;
  }
  // Không đóng → coi như chạy cuối file, trả về Code.
  return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i };
}

function readIdentifier(
  sql: string,
  i: number,
): { nextState: TokenState; nextIndex: number } {
  // Vào đây khi đã thấy `"` mở; i trỏ tới ký tự SAU `"` mở.
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '"') {
      // Escape `""` (theo chuẩn SQL identifier quoting).
      if (i + 1 < sql.length && sql[i + 1] === '"') {
        i += 2;
        continue;
      }
      return {
        nextState: { kind: TokenKind.Code, tag: "" },
        nextIndex: i + 1,
      };
    }
    i += 1;
  }
  return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i };
}

function readDollarQuote(
  sql: string,
  i: number,
  tag: string,
): { nextState: TokenState; nextIndex: number } {
  // Tìm đúng tag đóng (vd `$$` hoặc `$fn$`).
  while (i < sql.length) {
    if (sql.startsWith(tag, i)) {
      return {
        nextState: { kind: TokenKind.Code, tag: "" },
        nextIndex: i + tag.length,
      };
    }
    i += 1;
  }
  return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i };
}

function readLineComment(
  sql: string,
  i: number,
): { nextState: TokenState; nextIndex: number } {
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "\n") {
      // Kết thúc comment tại newline (giữ newline cho parser Code).
      return {
        nextState: { kind: TokenKind.Code, tag: "" },
        nextIndex: i,
      };
    }
    i += 1;
  }
  return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i };
}

function readBlockComment(
  sql: string,
  i: number,
): { nextState: TokenState; nextIndex: number } {
  while (i < sql.length) {
    if (sql[i] === "*" && i + 1 < sql.length && sql[i + 1] === "/") {
      return {
        nextState: { kind: TokenKind.Code, tag: "" },
        nextIndex: i + 2,
      };
    }
    i += 1;
  }
  return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i };
}

/**
 * Tại code position, kiểm tra xem ký tự tại `i` có mở token không.
 * Trả về state mới + index tiếp theo nếu có; ngược lại nextIndex = i+1 (giữ Code).
 */
function startNextToken(
  sql: string,
  i: number,
): { nextState: TokenState; nextIndex: number } {
  if (i >= sql.length) {
    return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i };
  }
  const ch = sql[i];
  if (ch === "'") {
    return {
      nextState: { kind: TokenKind.String, tag: "" },
      nextIndex: i + 1,
    };
  }
  if (ch === '"') {
    return {
      nextState: { kind: TokenKind.Identifier, tag: "" },
      nextIndex: i + 1,
    };
  }
  if (ch === "-" && i + 1 < sql.length && sql[i + 1] === "-") {
    return {
      nextState: { kind: TokenKind.LineComment, tag: "" },
      nextIndex: i + 2,
    };
  }
  if (ch === "/" && i + 1 < sql.length && sql[i + 1] === "*") {
    return {
      nextState: { kind: TokenKind.BlockComment, tag: "" },
      nextIndex: i + 2,
    };
  }
  if (ch === "$") {
    // Dollar-quote: hoặc `$$` hoặc `$tag$` với tag = [A-Za-z_][A-Za-z0-9_]*.
    const tag = matchDollarTag(sql, i);
    if (tag !== null) {
      return {
        nextState: { kind: TokenKind.DollarQuote, tag },
        nextIndex: i + tag.length,
      };
    }
  }
  // Ký tự thường — giữ Code.
  return { nextState: { kind: TokenKind.Code, tag: "" }, nextIndex: i + 1 };
}

/**
 * Nếu tại `i` bắt đầu 1 dollar-quote tag hợp lệ (`$$` hoặc `$identifier$`),
 * trả về chuỗi tag (bao gồm cả 2 dấu `$`). Ngược lại null.
 */
function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  if (i + 1 >= sql.length) return null;
  // `$$` — tag rỗng, kết thúc ngay.
  if (sql[i + 1] === "$") return "$$";
  // `$tag$` — tag là identifier.
  let j = i + 1;
  const first = sql[j];
  if (!isIdStart(first)) return null;
  j += 1;
  while (j < sql.length && isIdContinue(sql[j])) {
    j += 1;
  }
  if (j >= sql.length || sql[j] !== "$") return null;
  return sql.substring(i, j + 1);
}

function isIdStart(ch: string): boolean {
  return (
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    ch === "_"
  );
}

function isIdContinue(ch: string): boolean {
  return (
    isIdStart(ch) || (ch >= "0" && ch <= "9")
  );
}

// ---- splitStatements --------------------------------------------------------

/**
 * Construct mở bởi từ khoá (case-insensitive) — chỉ `BEGIN` tăng block depth;
 * `IF`/`CASE`/`LOOP`/`WHILE`/`FOR` mở construct riêng và CHỈ `END` của chúng đóng,
 * KHÔNG chạm vào block depth của `BEGIN...END`.
 */
type ConstructKind = "BLOCK" | "IF" | "CASE" | "LOOP";

/**
 * TASK-004 C1: phân biệt `BEGIN` transaction-control (`BEGIN;`, `BEGIN
 * TRANSACTION`, `BEGIN WORK`, `BEGIN ISOLATION LEVEL ...`) với `BEGIN ... END`
 * block plpgsql/T-SQL. Nhìn (peek) từ `afterIndex` (ngay SAU từ `BEGIN`,
 * CHƯA include ký tự tại vị trí này) — bỏ qua whitespace rồi kiểm tra:
 *   - Ký tự tiếp theo là `;` → transaction control.
 *   - Từ tiếp theo là TRANSACTION / WORK / ISOLATION → transaction control.
 *   - Ngược lại (vd `SELECT`, `IF`, `DECLARE`...) → block thật, giữ hành vi cũ.
 */
function isBeginTransactionControl(sql: string, afterIndex: number): boolean {
  const j = skipWhitespaceAndComments(sql, afterIndex);
  const n = sql.length;
  if (j >= n) return false;
  if (sql[j] === ";") return true;
  let k = j;
  while (k < n && isIdContinue(sql[k])) k += 1;
  const word = sql.substring(j, k).toUpperCase();
  return word === "TRANSACTION" || word === "WORK" || word === "ISOLATION";
}

/**
 * Review fix round C, Finding #4 — shared forward-peek helper: skip
 * whitespace AND comments (`--...\n`, `/*...*\/`) starting at `from`. Used by
 * `isBeginTransactionControl` (was whitespace-only, so `BEGIN -- go\n;`
 * still misclassified as a real block) and by `isEndLoopSuffix` (Finding #2).
 */
function skipWhitespaceAndComments(sql: string, from: number): number {
  let j = from;
  const n = sql.length;
  for (;;) {
    while (j < n && isWhitespace(sql[j])) j += 1;
    if (sql.startsWith("--", j)) {
      const nl = sql.indexOf("\n", j);
      j = nl === -1 ? n : nl + 1;
      continue;
    }
    if (sql.startsWith("/*", j)) {
      const end = sql.indexOf("*/", j + 2);
      j = end === -1 ? n : end + 2;
      continue;
    }
    break;
  }
  return j;
}

/**
 * Review fix round C, Finding #2 — forward-peek from right after an `END`
 * keyword: is the NEXT word (skipping whitespace/comments) `WHILE` / `REPEAT`
 * / `FOR`? Those loop-header keywords (C2) never push onto `constructStack`
 * (to avoid the `SELECT ... FOR UPDATE` leak), so `END WHILE` / `END REPEAT`
 * / `END FOR` must NOT pop the stack either — nothing was ever pushed for
 * them to close. Only a bare `END` or `END IF` / `END CASE` / `END LOOP`
 * (constructs that DID push) should pop.
 */
function isEndLoopSuffix(sql: string, afterIndex: number): boolean {
  const j = skipWhitespaceAndComments(sql, afterIndex);
  const n = sql.length;
  let k = j;
  while (k < n && isIdContinue(sql[k])) k += 1;
  const word = sql.substring(j, k).toUpperCase();
  return word === "WHILE" || word === "REPEAT" || word === "FOR";
}

/**
 * TASK-004 C4: `GO` (MSSQL batch separator) CHỈ là boundary khi nó là token
 * DUY NHẤT trên dòng của nó (bỏ qua whitespace ngang 2 đầu dòng) — tránh
 * false-friend như cột/alias tên `go` (vd `SELECT go FROM t`).
 * `wordStart`/`wordEnd` là offset [start, end) của từ `GO` trong `sql`.
 */
function isGoAloneOnLine(
  sql: string,
  wordStart: number,
  wordEnd: number,
): boolean {
  let b = wordStart - 1;
  while (b >= 0 && (sql[b] === " " || sql[b] === "\t" || sql[b] === "\r")) {
    b -= 1;
  }
  if (b >= 0 && sql[b] !== "\n") return false;
  let f = wordEnd;
  const n = sql.length;
  while (f < n && (sql[f] === " " || sql[f] === "\t" || sql[f] === "\r")) {
    f += 1;
  }
  if (f < n && sql[f] !== "\n") return false;
  return true;
}

interface SplitResult {
  statements: ParsedStatement[];
  /** TEST-ONLY: kích thước constructStack còn lại sau khi parse hết `sql`. */
  finalConstructStackSize: number;
}

/**
 * Tách SQL thành các statement theo boundary `;` (NGOÀI string/comment/dollar-quote).
 * Trả về mảng `ParsedStatement[]`. Thứ tự theo xuất hiện trong SQL.
 *
 * Quy tắc:
 * - Bỏ qua `;` trong string literal `'...'`, identifier `"..."`, dollar-quote.
 * - Bỏ qua `;` trong comment dòng (`--`) và comment khối (`/` `* ... *` `/`).
 * - Từ khoá SQL không phân biệt hoa/thường (`begin` ≡ `BEGIN`).
 * - Khối `BEGIN ... END` là 1 statement; `;` bên trong là NỘI DUNG, không phải boundary.
 * - `BEGIN;` / `BEGIN TRANSACTION|WORK|ISOLATION ...` (TASK-004 C1) là điều khiển
 *   transaction, KHÔNG mở block — `;` sau nó là boundary bình thường.
 * - `END IF` / `END LOOP` / `END CASE` đóng construct đó chứ KHÔNG đóng `BEGIN` cha
 *   → plpgsql/T-SQL body lồng IF/CASE/LOOP vẫn là 1 statement.
 * - `FOR`/`WHILE` (TASK-004 C2) CHỈ mở construct LOOP khi keyword `LOOP` thực sự
 *   xuất hiện tiếp theo — `SELECT ... FOR UPDATE` không leak construct.
 * - `dialect === "mysql"` (TASK-004 C3): backslash `\` escape ký tự theo sau
 *   trong string literal (kể cả `\'`). Dialect khác giữ nguyên hành vi cũ.
 * - `dialect === "mssql"` (TASK-004 C4): `GO` đứng một mình trên 1 dòng là
 *   batch separator (không phải nội dung statement nào).
 * - Statement có thể KHÔNG có terminating `;` (vd file thiếu `;` cuối).
 * - Statement rỗng (chỉ whitespace + comment) bị BỎ QUA — không trả về.
 *
 * `start` / `end` là character offset trong SQL gốc, sao cho
 * `sql.substring(start, end) === text`. Text KHÔNG trim — giữ nguyên vị trí.
 *
 * `dialect` là optional (TASK-004) — bỏ qua ⇒ hành vi postgres-ish như trước.
 *
 * Limitation (documented): chuỗi escape PostgreSQL `E'...\'...'`
 * (backslash escape) KHÔNG được nhận khi KHÔNG phải dialect `mysql` — parser
 * chỉ hiểu `''` escape trong string literal ở các dialect khác. Tương tự
 * `U&'...'`. Đây là giới hạn cố ý của TASK-002 (spec chỉ yêu cầu `''`).
 */
export function splitStatements(
  sql: string,
  dialect?: SqlDialect,
): ParsedStatement[] {
  return splitStatementsInternal(sql, dialect).statements;
}

/**
 * TEST-ONLY (TASK-004 acceptance criteria cho C2): kích thước construct stack
 * còn lại SAU KHI parse toàn bộ `sql` — dùng để assert TRỰC TIẾP rằng không
 * còn construct nào bị "leak" (vd sau `SELECT ... FOR UPDATE`), thay vì chỉ
 * suy luận gián tiếp qua statement count. KHÔNG dùng trong runtime code khác.
 */
export function debugFinalConstructStackSizeForTest(
  sql: string,
  dialect?: SqlDialect,
): number {
  return splitStatementsInternal(sql, dialect).finalConstructStackSize;
}

function splitStatementsInternal(
  sql: string,
  dialect?: SqlDialect,
): SplitResult {
  const useBackslashEscape = dialect === "mysql";
  const goEnabled = dialect === "mssql";

  const out: ParsedStatement[] = [];
  const n = sql.length;

  let i = 0;
  let state: TokenState = { kind: TokenKind.Code, tag: "" };
  let stmtStart = -1; // start của statement hiện tại (đã skip whitespace đầu)

  // Stack các construct đang mở (push khi gặp BEGIN block/IF/CASE/LOOP,
  // pop khi gặp END tương ứng). BLOCK depth = số phần tử BLOCK trong stack.
  const constructStack: ConstructKind[] = [];

  // Buffer lưu từ khoá gần nhất để phát hiện BEGIN/END/IF/CASE/LOOP/WHILE/FOR/GO.
  // So sánh CASE-INSENSITIVE (SQL keyword không phân biệt hoa/thường).
  let kwBuffer = "";
  let kwStart = -1; // offset ký tự đầu của kwBuffer hiện tại trong sql
  // Cờ: keyword vừa xử lý là `END` — keyword kế tiếp (IF/CASE/LOOP) là phần của
  // cùng 1 cụm `END IF`/`END CASE`/`END LOOP`, KHÔNG mở construct mới.
  let prevWasEnd = false;

  while (i < n) {
    const { nextState, nextIndex } = readToken(sql, i, state, useBackslashEscape);
    // Nếu đang trong Code, cập nhật keyword buffer.
    if (state.kind === TokenKind.Code) {
      // Vùng vừa duyệt là ký tự đơn (nextIndex === i+1).
      const ch = sql[i];
      if (isIdContinue(ch)) {
        if (kwBuffer.length === 0) kwStart = i;
        kwBuffer += ch;
      } else {
        // Kết thúc 1 keyword → phân tích.
        if (kwBuffer.length > 0) {
          const upper = kwBuffer.toUpperCase();
          const blockDepthNow = countBlocks(constructStack);
          if (
            goEnabled &&
            upper === "GO" &&
            blockDepthNow === 0 &&
            isGoAloneOnLine(sql, kwStart, i)
          ) {
            // TASK-004 C4: `GO` batch separator — flush statement hiện tại,
            // KHÔNG bao gồm text "GO".
            const candidateStart = stmtStart;
            const candidateEnd = kwStart;
            if (
              candidateStart !== -1 &&
              candidateEnd > candidateStart &&
              sql.substring(candidateStart, candidateEnd).trim().length > 0
            ) {
              out.push({
                text: sql.substring(candidateStart, candidateEnd),
                start: candidateStart,
                end: candidateEnd,
              });
            }
            stmtStart = -1;
            prevWasEnd = false;
          } else {
            const isTxnBegin =
              upper === "BEGIN" ? isBeginTransactionControl(sql, i) : false;
            const isEndLoop =
              upper === "END" ? isEndLoopSuffix(sql, i) : false;
            // Finding #8 (review fix round C): MySQL `IF(a,b,c)` function
            // form — the char immediately after "IF" (no whitespace) is
            // `(` — is an expression, not the control-flow keyword. Without
            // this, every `IF(...)` call pushes an "IF" that has no
            // matching `END IF`, leaking a phantom stack entry that can
            // wrongly get popped by a later unrelated/unmatched `END` in
            // the same multi-statement batch. `IF (cond) THEN` / `IF cond
            // THEN` (space before the condition — used by this file's own
            // BEGIN/IF/END tests) keep whitespace right after "IF" and are
            // unaffected by this check.
            const isIfFunctionCall = upper === "IF" && sql[i] === "(";
            const result = handleKeyword(
              kwBuffer,
              constructStack,
              prevWasEnd,
              isTxnBegin,
              isEndLoop,
              isIfFunctionCall,
            );
            // Chỉ cập nhật cờ khi keyword thực sự được nhận (BEGIN/IF/CASE/
            // LOOP/WHILE/FOR/END). Non-keyword identifier (vd "i", "1") giữ
            // nguyên cờ trước đó.
            if (result.matched) {
              prevWasEnd = result.wasEnd;
            }
          }
        } else {
          // kwBuffer rỗng — ta đang ở giữa 2 identifier/token. Reset prevWasEnd
          // (vì whitespace/special cắt cụm `END ...`).
          prevWasEnd = false;
        }
        kwBuffer = "";
        kwStart = -1;
      }
    } else {
      // Trong string/identifier/dollar-quote/comment → reset keyword buffer.
      kwBuffer = "";
      kwStart = -1;
      prevWasEnd = false;
    }

    // Xử lý `;` chỉ khi ở Code và KHÔNG có block BEGIN đang mở.
    const blockDepth = countBlocks(constructStack);
    if (
      state.kind === TokenKind.Code &&
      blockDepth === 0 &&
      sql[i] === ";"
    ) {
      const candidateStart = stmtStart;
      const candidateEnd = i; // exclusive
      if (
        candidateStart !== -1 &&
        candidateEnd > candidateStart &&
        sql.substring(candidateStart, candidateEnd).trim().length > 0
      ) {
        out.push({
          text: sql.substring(candidateStart, candidateEnd),
          start: candidateStart,
          end: candidateEnd,
        });
      }
      // Reset cho statement tiếp theo — bắt đầu SAU `;`.
      stmtStart = -1;
    } else if (
      state.kind === TokenKind.Code &&
      blockDepth === 0 &&
      stmtStart === -1 &&
      !isWhitespace(sql[i])
    ) {
      // Bắt đầu statement mới: ký tự không phải whitespace đầu tiên ngoài block.
      stmtStart = i;
    }

    // Advance.
    state = nextState;
    i = nextIndex;
  }

  // EOF: `GO` cuối buffer (không có ký tự theo sau để trigger flush trong vòng
  // lặp) — nếu đủ điều kiện batch separator, cắt tail TRƯỚC "GO" thay vì gộp
  // "GO" vào statement cuối.
  let tailEnd = n;
  if (
    goEnabled &&
    kwBuffer.length > 0 &&
    kwBuffer.toUpperCase() === "GO" &&
    countBlocks(constructStack) === 0 &&
    isGoAloneOnLine(sql, kwStart, n)
  ) {
    tailEnd = kwStart;
  }

  // EOF: nếu statement đang mở và có nội dung thực (sau khi strip comment) → flush.
  if (stmtStart !== -1 && stmtStart < tailEnd) {
    const tail = sql.substring(stmtStart, tailEnd);
    if (isMeaningful(tail)) {
      out.push({
        text: tail,
        start: stmtStart,
        end: tailEnd,
      });
    }
  }

  return { statements: out, finalConstructStackSize: constructStack.length };
}

/**
 * Xử lý keyword kết thúc: đẩy construct tương ứng vào stack / pop khi gặp END.
 * So sánh CASE-INSENSITIVE.
 * Trả về true nếu keyword vừa xử lý là `END` (để keyword tiếp theo như IF/CASE/LOOP
 * biết rằng nó thuộc cụm `END ...` và KHÔNG push construct mới).
 */
function handleKeyword(
  kw: string,
  stack: ConstructKind[],
  prevWasEnd: boolean,
  isTxnBegin: boolean,
  isEndLoop: boolean,
  isIfFunctionCall: boolean = false,
): { matched: boolean; wasEnd: boolean } {
  const upper = kw.toUpperCase();
  if (upper === "BEGIN") {
    // TASK-004 C1: `BEGIN;` / `BEGIN TRANSACTION|WORK|ISOLATION ...` là điều
    // khiển transaction, KHÔNG phải block plpgsql/T-SQL — không push gì cả,
    // để `;` sau nó là 1 boundary bình thường và COMMIT/ROLLBACK không cần xử
    // lý riêng (không có gì phải pop). CHỈ áp dụng ở top-level (block depth 0)
    // — 1 `BEGIN` xuất hiện khi đã lồng trong block khác luôn coi là block
    // body thật (an toàn hơn, theo gợi ý của planner).
    if (isTxnBegin && countBlocks(stack) === 0) {
      return { matched: true, wasEnd: false };
    }
    stack.push("BLOCK");
    return { matched: true, wasEnd: false };
  }
  if (upper === "IF" || upper === "CASE" || upper === "LOOP") {
    // `END IF` / `END CASE` / `END LOOP` — KHÔNG push construct mới.
    // Ngược lại: `LOOP` đứng một mình HOẶC đóng 1 header `FOR ... LOOP` /
    // `WHILE ... LOOP` (TASK-004 C2: `FOR`/`WHILE` KHÔNG push nữa — chỉ
    // `LOOP` thực sự xuất hiện mới push, nên không còn double-push cần tránh).
    if (prevWasEnd) {
      return { matched: true, wasEnd: false };
    }
    if (upper === "IF") {
      // Finding #8: `IF(...)` function-call form — matched as the IF
      // keyword (so prevWasEnd resets correctly) but does NOT open a
      // construct, since there is no `END IF` to close it.
      if (isIfFunctionCall) {
        return { matched: true, wasEnd: false };
      }
      stack.push("IF");
    } else if (upper === "CASE") stack.push("CASE");
    else stack.push("LOOP");
    return { matched: true, wasEnd: false };
  }
  if (upper === "WHILE" || upper === "FOR" || upper === "REPEAT") {
    // TASK-004 C2 (+ Finding #2 REPEAT): KHÔNG push ở đây — `FOR`/`WHILE`/
    // `REPEAT` chỉ là ứng viên loop header. Chỉ push khi keyword `LOOP`
    // THỰC SỰ xuất hiện tiếp theo (nhánh trên). Nếu không có `LOOP` nào theo
    // sau trong statement này (vd `SELECT ... FOR UPDATE`, hoặc MySQL
    // `WHILE...DO`/`REPEAT...UNTIL` which never use `LOOP` at all) thì không
    // có gì bị đẩy vào stack → không leak. The matching `END WHILE`/`END
    // REPEAT`/`END FOR` is handled by the `isEndLoop` skip in the END branch
    // above, so this branch stays a true no-op regardless of prevWasEnd.
    return { matched: true, wasEnd: false };
  }
  if (upper === "END") {
    // Pop top construct; CHỈ giảm block depth khi top là BLOCK.
    // Nếu top là IF/CASE/LOOP → construct đó đóng, block depth giữ nguyên.
    // Cả `END` alone, `END IF`, `END CASE`, `END LOOP` đều pop 1 phần tử.
    //
    // Finding #2 (review fix round C): `END WHILE` / `END REPEAT` / `END
    // FOR` (MySQL `WHILE...DO...END WHILE`, `REPEAT...UNTIL...END REPEAT`)
    // close a loop header that NEVER pushed anything (see the WHILE/FOR/
    // REPEAT branch below, C2) — popping here would wrongly consume the
    // enclosing BEGIN block's entry. Skip the pop for that suffix only.
    if (!isEndLoop && stack.length > 0) {
      stack.pop();
    }
    return { matched: true, wasEnd: true };
  }
  // Non-keyword identifier (vd `i`, `1`, `COMMIT`, `ROLLBACK`, `TRANSACTION`)
  // — không khớp, caller giữ nguyên cờ. COMMIT/ROLLBACK không cần xử lý pop
  // riêng vì `BEGIN` transaction-control (nhánh trên) không push gì để pop.
  return { matched: false, wasEnd: false };
}

function countBlocks(stack: ConstructKind[]): number {
  let n = 0;
  for (const k of stack) if (k === "BLOCK") n += 1;
  return n;
}

/**
 * Kiểm tra text có chứa nội dung SQL thực (không chỉ whitespace/comment).
 * Dùng khi flush EOF và khi filter statement rỗng.
 */
function isMeaningful(text: string): boolean {
  // Tìm bất kỳ ký tự nào không phải whitespace và không thuộc comment.
  // Đơn giản: nếu sau khi loại bỏ comment-line + comment-block + whitespace
  // mà còn ký tự → meaningful.
  let j = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === "-" && j + 1 < text.length && text[j + 1] === "-") {
      // line comment tới newline
      j += 2;
      while (j < text.length && text[j] !== "\n") j += 1;
      continue;
    }
    if (c === "/" && j + 1 < text.length && text[j + 1] === "*") {
      // block comment
      j += 2;
      while (j + 1 < text.length && !(text[j] === "*" && text[j + 1] === "/")) {
        j += 1;
      }
      j = Math.min(j + 2, text.length);
      continue;
    }
    if (!isWhitespace(c)) return true;
    j += 1;
  }
  return false;
}

// ---- statementAtCursor -------------------------------------------------------

/**
 * Trả về statement chứa `offset`. Nếu offset nằm trong statement → statement đó.
 * Nếu offset nằm trong **gap** giữa 2 statement (whitespace/comment) → statement
 * gần nhất TRƯỚC cursor (user intent "chạy statement chứa con trỏ / statement đã viết
 * xong trước đó"). Nếu offset trước statement đầu → statement đầu. Nếu không có
 * statement nào → null.
 *
 * TASK-005 cycle R: rule mới thay cho fallback cũ (`stmts[stmts.length-1]` khi gap).
 */
export function statementAtCursor(
  sql: string,
  offset: number,
  dialect?: SqlDialect,
): ParsedStatement | null {
  const stmts = splitStatements(sql, dialect);
  if (stmts.length === 0) return null;

  const clamped = Math.max(0, Math.min(offset, sql.length));

  // Trường hợp 1: offset nằm trong range của 1 statement (kể cả = start) → stmt đó.
  for (const s of stmts) {
    if (clamped >= s.start && clamped < s.end) return s;
  }

  // Trường hợp 2: gap giữa 2 statement hoặc trước statement đầu → statement
  // gần nhất TRƯỚC cursor; nếu không có (cursor trước stmt đầu) → stmt đầu.
  let best: ParsedStatement | null = null;
  for (const s of stmts) {
    if (s.end <= clamped) best = s;
    else break;
  }
  return best ?? stmts[0];
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

// ---- sqlToRun ----------------------------------------------------------------

/**
 * Quyết định statements sẽ chạy:
 * - Nếu `selection` được cung cấp (kể cả khi start === end): cắt SQL theo vùng
 *   selection, sau đó `splitStatements` trên vùng đó. mode = 'selection'.
 * - Nếu không: lấy statement tại `cursorOffset`. mode = 'cursor'.
 *
 * Lưu ý: vùng selection trả về range theo SQL con — start được remap về 0.
 *
 * `dialect` (Finding #3, review fix round C) — optional & additive; threaded
 * straight into `splitStatements`/`statementAtCursor` so the ACTIVE
 * connection's driver actually reaches the splitter (previously `sqlToRun`
 * had no dialect param at all, so `extension.ts`'s "Run" command always
 * split MSSQL/MySQL SQL as if it were Postgres).
 */
export function sqlToRun(
  sql: string,
  selection: { start: number; end: number } | undefined,
  cursorOffset: number,
  dialect?: SqlDialect,
): { statements: ParsedStatement[]; mode: "selection" | "cursor" } {
  if (selection !== undefined) {
    const start = Math.max(0, Math.min(selection.start, sql.length));
    const end = Math.max(start, Math.min(selection.end, sql.length));
    const slice = sql.substring(start, end);
    const statements = splitStatements(slice, dialect);
    return { statements, mode: "selection" };
  }
  const found = statementAtCursor(sql, cursorOffset, dialect);
  const statements = found ? [found] : [];
  return { statements, mode: "cursor" };
}