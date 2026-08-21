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
 * Tách SQL thành các statement theo boundary `;` (NGOÀI string/comment/dollar-quote).
 * Trả về mảng `ParsedStatement[]`. Thứ tự theo xuất hiện trong SQL.
 *
 * Quy tắc:
 * - Bỏ qua `;` trong string literal `'...'`, identifier `"..."`, dollar-quote.
 * - Bỏ qua `;` trong comment dòng (`--`) và comment khối (`/` `* ... *` `/`).
 * - Khối `BEGIN ... END` (không phân biệt hoa/thường, từ khoá whole-word) là 1 statement.
 * - Statement có thể KHÔNG có terminating `;` (vd file thiếu `;` cuối).
 * - Statement rỗng (chỉ whitespace + comment) bị BỎ QUA — không trả về.
 *
 * `start` / `end` là character offset trong SQL gốc, sao cho
 * `sql.substring(start, end) === text`. Text KHÔNG trim — giữ nguyên vị trí.
 */
export function splitStatements(sql: string): ParsedStatement[] {
  const out: ParsedStatement[] = [];
  const n = sql.length;

  let i = 0;
  let state: TokenState = { kind: TokenKind.Code, tag: "" };
  let stmtStart = -1; // start của statement hiện tại (đã skip whitespace đầu)
  let endOfLastToken = 0; // vị trí kết thúc của non-code/non-string token trước đó

  // BEGIN/END depth — khi >0, `;` không phải boundary.
  let beginDepth = 0;

  // Buffer lưu từ khoá gần nhất để phát hiện BEGIN / END.
  // Cách đơn giản: quét riêng để biết từ khoá BEGIN/END có whole-word trong Code hay không.
  // Để giữ đơn giản nhưng chính xác, ta theo dõi 1 buffer keyword detector.
  let kwBuffer = ""; // các chữ cái/số/_ hiện tại trong Code

  const resetKeywordBuffer = () => {
    kwBuffer = "";
  };

  while (i < n) {
    const before = i;
    const { nextState, nextIndex } = readToken(sql, i, state);
    // Nếu đang trong Code, cập nhật keyword buffer.
    if (state.kind === TokenKind.Code) {
      // Vùng vừa duyệt là ký tự đơn (nextIndex === i+1).
      const ch = sql[i];
      if (isIdContinue(ch)) {
        kwBuffer += ch;
      } else {
        // Kết thúc 1 keyword → check BEGIN/END.
        if (kwBuffer.length > 0) {
          if (kwBuffer === "BEGIN") beginDepth += 1;
          else if (kwBuffer === "END") {
            // Match `END` hoặc `END IF`, `END LOOP`, ...; đều giảm depth.
            beginDepth = Math.max(0, beginDepth - 1);
          }
        }
        kwBuffer = "";
      }
    } else {
      // Trong string/identifier/dollar-quote/comment → bỏ keyword buffer.
      kwBuffer = "";
    }

    // Nếu vừa thoát khỏi non-code token → cập nhật endOfLastToken để
    // statement bỏ qua phần whitespace/comment giữa các statement.
    if (state.kind !== TokenKind.Code && nextState.kind === TokenKind.Code) {
      endOfLastToken = nextIndex;
    }

    // Xử lý `;` chỉ khi ở Code và beginDepth === 0.
    if (
      state.kind === TokenKind.Code &&
      beginDepth === 0 &&
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
      endOfLastToken = nextIndex;
    } else if (
      state.kind === TokenKind.Code &&
      beginDepth === 0 &&
      stmtStart === -1
    ) {
      // Bắt đầu statement mới: tìm ký tự không phải whitespace/comment.
      // nextIndex là vị trí ngay sau ký tự vừa đọc.
      const peekIdx = nextIndex;
      // Nếu vừa đọc qua 1 non-code token, stmtStart lấy sau token đó.
      // Logic: stmtStart được set khi:
      //   - ta đang ở Code
      //   - ký tự hiện tại KHÔNG phải whitespace
      //   - chưa có stmtStart đang mở
      if (!isWhitespace(sql[i]) && stmtStart === -1) {
        stmtStart = i;
      }
      // peekIdx chỉ dùng để tránh TS noUnused; không ảnh hưởng logic.
      void peekIdx;
    }

    // Advance.
    state = nextState;
    i = nextIndex;
    void before;
  }

  // EOF: nếu statement đang mở và có nội dung → flush.
  if (
    stmtStart !== -1 &&
    stmtStart < n &&
    sql.substring(stmtStart, n).trim().length > 0
  ) {
    out.push({
      text: sql.substring(stmtStart, n),
      start: stmtStart,
      end: n,
    });
  }

  return out;
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