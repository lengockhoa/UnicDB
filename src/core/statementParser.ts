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
): { nextState: TokenState; nextIndex: number } {
  // Đang trong token → tìm đóng.
  if (state.kind === TokenKind.String) {
    return readString(sql, i);
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
): { nextState: TokenState; nextIndex: number } {
  // Vào đây khi đã thấy `'` mở; i trỏ tới ký tự SAU dấu `'` mở.
  while (i < sql.length) {
    const ch = sql[i];
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
 * Tách SQL thành các statement theo boundary `;` (NGOÀI string/comment/dollar-quote).
 * Trả về mảng `ParsedStatement[]`. Thứ tự theo xuất hiện trong SQL.
 *
 * Quy tắc:
 * - Bỏ qua `;` trong string literal `'...'`, identifier `"..."`, dollar-quote.
 * - Bỏ qua `;` trong comment dòng (`--`) và comment khối (`/` `* ... *` `/`).
 * - Từ khoá SQL không phân biệt hoa/thường (`begin` ≡ `BEGIN`).
 * - Khối `BEGIN ... END` là 1 statement; `;` bên trong là NỘI DUNG, không phải boundary.
 * - `END IF` / `END LOOP` / `END CASE` đóng construct đó chứ KHÔNG đóng `BEGIN` cha
 *   → plpgsql/T-SQL body lồng IF/CASE/LOOP vẫn là 1 statement.
 * - Statement có thể KHÔNG có terminating `;` (vd file thiếu `;` cuối).
 * - Statement rỗng (chỉ whitespace + comment) bị BỎ QUA — không trả về.
 *
 * `start` / `end` là character offset trong SQL gốc, sao cho
 * `sql.substring(start, end) === text`. Text KHÔNG trim — giữ nguyên vị trí.
 *
 * Limitation (documented): chuỗi escape PostgreSQL `E'...\'...'`
 * (backslash escape) KHÔNG được nhận — parser chỉ hiểu `''` escape trong string literal.
 * Tương tự `U&'...'`. Đây là giới hạn cố ý của TASK-002 (spec chỉ yêu cầu `''`).
 */
export function splitStatements(sql: string): ParsedStatement[] {
  const out: ParsedStatement[] = [];
  const n = sql.length;

  let i = 0;
  let state: TokenState = { kind: TokenKind.Code, tag: "" };
  let stmtStart = -1; // start của statement hiện tại (đã skip whitespace đầu)

  // Stack các construct đang mở (push khi gặp BEGIN/IF/CASE/LOOP/WHILE/FOR,
  // pop khi gặp END tương ứng). BLOCK depth = số phần tử BLOCK trong stack.
  const constructStack: ConstructKind[] = [];

  // Buffer lưu từ khoá gần nhất để phát hiện BEGIN/END/IF/CASE/LOOP/WHILE/FOR.
  // So sánh CASE-INSENSITIVE (SQL keyword không phân biệt hoa/thường).
  let kwBuffer = "";
  // Cờ: keyword vừa xử lý là `END` — keyword kế tiếp (IF/CASE/LOOP) là phần của
  // cùng 1 cụm `END IF`/`END CASE`/`END LOOP`, KHÔNG mở construct mới.
  let prevWasEnd = false;
  // Cờ: keyword vừa xử lý là `FOR` hoặc `WHILE` — keyword `LOOP` tiếp theo
  // chỉ là syntactic marker của cú pháp `FOR ... LOOP` / `WHILE ... LOOP`,
  // KHÔNG mở construct mới.
  let prevWasLoopStarter = false;

  while (i < n) {
    const { nextState, nextIndex } = readToken(sql, i, state);
    // Nếu đang trong Code, cập nhật keyword buffer.
    if (state.kind === TokenKind.Code) {
      // Vùng vừa duyệt là ký tự đơn (nextIndex === i+1).
      const ch = sql[i];
      if (isIdContinue(ch)) {
        kwBuffer += ch;
      } else {
        // Kết thúc 1 keyword → phân tích.
        if (kwBuffer.length > 0) {
          const result = handleKeyword(
            kwBuffer,
            constructStack,
            prevWasEnd,
            prevWasLoopStarter,
          );
          // Chỉ cập nhật cờ khi keyword thực sự được nhận (BEGIN/IF/CASE/
          // LOOP/WHILE/FOR/END). Non-keyword identifier (vd "i", "1") giữ
          // nguyên cờ trước đó — và `LOOP` sau `FOR`/`WHILE` cũng vậy
          // (handleKeyword đã trả về wasLoopStarter=false).
          if (result.matched) {
            prevWasEnd = result.wasEnd;
            prevWasLoopStarter = result.wasLoopStarter;
          }
        } else {
          // kwBuffer rỗng — ta đang ở giữa 2 identifier. CHỈ reset prevWasEnd
          // (vì whitespace/special cắt cụm `END ...`); giữ nguyên prevWasLoopStarter
          // để `FOR i IN 1..3 LOOP` vẫn nhận diện `LOOP` cuối.
          prevWasEnd = false;
        }
        kwBuffer = "";
      }
    } else {
      // Trong string/identifier/dollar-quote/comment → reset keyword buffer.
      kwBuffer = "";
      prevWasEnd = false;
      prevWasLoopStarter = false;
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

  // EOF: nếu statement đang mở và có nội dung thực (sau khi strip comment) → flush.
  if (stmtStart !== -1 && stmtStart < n) {
    const tail = sql.substring(stmtStart, n);
    if (isMeaningful(tail)) {
      out.push({
        text: tail,
        start: stmtStart,
        end: n,
      });
    }
  }

  return out;
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
  prevWasLoopStarter: boolean,
): { matched: boolean; wasEnd: boolean; wasLoopStarter: boolean } {
  const upper = kw.toUpperCase();
  if (upper === "BEGIN") {
    stack.push("BLOCK");
    return { matched: true, wasEnd: false, wasLoopStarter: false };
  }
  if (upper === "IF" || upper === "CASE" || upper === "LOOP") {
    // `END IF` / `END CASE` / `END LOOP` — KHÔNG push construct mới.
    // `FOR ... LOOP` / `WHILE ... LOOP` — `LOOP` là syntactic marker, không push.
    if (prevWasEnd || (upper === "LOOP" && prevWasLoopStarter)) {
      return { matched: true, wasEnd: false, wasLoopStarter: false };
    }
    if (upper === "IF") stack.push("IF");
    else if (upper === "CASE") stack.push("CASE");
    else stack.push("LOOP");
    return { matched: true, wasEnd: false, wasLoopStarter: false };
  }
  if (upper === "WHILE" || upper === "FOR") {
    stack.push("LOOP");
    return { matched: true, wasEnd: false, wasLoopStarter: true };
  }
  if (upper === "END") {
    // Pop top construct; CHỈ giảm block depth khi top là BLOCK.
    // Nếu top là IF/CASE/LOOP → construct đó đóng, block depth giữ nguyên.
    // Cả `END` alone, `END IF`, `END CASE`, `END LOOP` đều pop 1 phần tử.
    if (stack.length > 0) {
      stack.pop();
    }
    return { matched: true, wasEnd: true, wasLoopStarter: false };
  }
  // Non-keyword identifier (vd `i`, `1`) — không khớp, caller giữ nguyên cờ.
  return { matched: false, wasEnd: false, wasLoopStarter: false };
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
 * Trả về statement chứa `offset`. Nếu offset nằm trước statement đầu (vd whitespace đầu),
 * trả về statement đầu. Nếu không có statement nào (file rỗng/whitespace) → null.
 */
export function statementAtCursor(
  sql: string,
  offset: number,
): ParsedStatement | null {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return null;

  const clamped = Math.max(0, Math.min(offset, sql.length));

  for (const s of stmts) {
    // [start, end) — nếu clamped nằm trong range (kể cả = start).
    if (clamped >= s.start && clamped < s.end) return s;
  }
  // Offset vượt quá statement cuối → trả về statement cuối.
  return stmts[stmts.length - 1];
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
 */
export function sqlToRun(
  sql: string,
  selection: { start: number; end: number } | undefined,
  cursorOffset: number,
): { statements: ParsedStatement[]; mode: "selection" | "cursor" } {
  if (selection !== undefined) {
    const start = Math.max(0, Math.min(selection.start, sql.length));
    const end = Math.max(start, Math.min(selection.end, sql.length));
    const slice = sql.substring(start, end);
    const statements = splitStatements(slice);
    return { statements, mode: "selection" };
  }
  const found = statementAtCursor(sql, cursorOffset);
  const statements = found ? [found] : [];
  return { statements, mode: "cursor" };
}