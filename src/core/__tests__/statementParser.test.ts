// src/core/__tests__/statementParser.test.ts
// Bảng test table-driven cho statementParser — TASK-002 §Test Cases.
import { describe, it, expect } from "vitest";
import {
  splitStatements,
  statementAtCursor,
  sqlToRun,
} from "../statementParser";
import type { ParsedStatement } from "../../config/types";

// Helper: so sánh text + start + end đúng như spec.
function stmt(text: string, start: number, end: number): ParsedStatement {
  return { text, start, end };
}

describe("statementParser — splitStatements", () => {
  it("Test #1 — tách nhiều statement, text/positions đúng", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[0].text).toBe("SELECT 1");
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(8); // exclusive end của "SELECT 1"
    expect(out[1].text).toBe("SELECT 2");
    expect(out[1].start).toBe(10); // sau "SELECT 1;\n"
    expect(out[2].text).toBe("SELECT 3");
    expect(out[2].start).toBe(20);
  });

  it("Test #2 — `;` trong string literal không tách", () => {
    const sql = "SELECT 'a;b' AS x;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("SELECT 'a;b' AS x");
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(17); // exclusive end, ngay trước `;` terminator
  });

  it("Test #3 — dollar-quote chứa `;` vẫn 1 statement", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN SELECT 1; END $$ LANGUAGE plpgsql;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    // Phải chứa toàn bộ function, không bị tách giữa dollar-quote
    expect(out[0].text).toBe(
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN SELECT 1; END $$ LANGUAGE plpgsql",
    );
  });

  it("Test #3b — dollar-quote có tag `$tag$ ... $tag$` cũng 1 statement", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN SELECT 1; END $fn$ LANGUAGE plpgsql;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "CREATE FUNCTION f() RETURNS void AS $fn$ BEGIN SELECT 1; END $fn$ LANGUAGE plpgsql",
    );
  });

  it("Test #4 — comment `--` và `/* */` chứa `;` không phải boundary", () => {
    const sql = "SELECT 1 -- note; x\n;\nSELECT /* a;b */ 2;";
    const out = splitStatements(sql);
    // `;` trong `-- note; x` không phải boundary, cũng như `;` trong `/* a;b */`.
    // Chỉ `;` ngoài comment (sau newline) mới tách.
    expect(out).toHaveLength(2);
    // Statement 1: bắt đầu từ `SELECT 1`, kết thúc trước `;` terminator.
    // Parser giữ nguyên text trong [start, end) → comment vẫn còn.
    expect(out[0].text).toBe("SELECT 1 -- note; x\n");
    expect(out[0].start).toBe(0);
    // Statement 2: `SELECT /* a;b */ 2`
    expect(out[1].text).toBe("SELECT /* a;b */ 2");
  });

  it("Test #5 — khối BEGIN...END là 1 statement", () => {
    const sql = "BEGIN\n SELECT 1;\n SELECT 2;\nEND";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(sql);
  });

  it("Test #6a — file rỗng → []", () => {
    expect(splitStatements("")).toEqual([]);
  });

  it("Test #6b — whitespace-only → []", () => {
    expect(splitStatements("  \n")).toEqual([]);
  });

  it("Test #8 — escape `''` và identifier double-quote `\"a;b\"`", () => {
    const sql = "SELECT 'it''s; ok' AS a, \"col;x\" FROM t;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "SELECT 'it''s; ok' AS a, \"col;x\" FROM t",
    );
  });

  it("Test #extra — không có terminating `;` vẫn nhận 1 statement", () => {
    const sql = "SELECT 1";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("SELECT 1");
  });
});

describe("statementParser — statementAtCursor", () => {
  it("Test #6 — offset 0 (trước statement đầu) trả về statement đầu", () => {
    const sql = "SELECT 1;";
    const out = statementAtCursor(sql, 0);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 1");
  });

  it("offset nằm giữa statement thứ 2 trong chuỗi nhiều statement", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    // offset 12 nằm trong "SELECT 2" (bắt đầu ở 10)
    const out = statementAtCursor(sql, 12);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 2");
  });

  it("offset nằm trong string literal vẫn trả statement bao nó", () => {
    const sql = "SELECT 'a;b' AS x;";
    const out = statementAtCursor(sql, 9); // giữa 'a;b'
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 'a;b' AS x");
  });

  it("offset nằm giữa BEGIN...END trả về khối", () => {
    const sql = "BEGIN\n SELECT 1;\n SELECT 2;\nEND";
    // offset giữa khối
    const out = statementAtCursor(sql, 10);
    expect(out).not.toBeNull();
    expect(out!.text).toBe(sql);
  });

  it("file rỗng → null", () => {
    expect(statementAtCursor("", 0)).toBeNull();
  });

  it("whitespace-only → null", () => {
    expect(statementAtCursor("  \n", 2)).toBeNull();
  });

  it("offset vượt quá độ dài → statement cuối hoặc null tuỳ nội dung", () => {
    const sql = "SELECT 1;";
    const out = statementAtCursor(sql, sql.length);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 1");
  });

  it("file chỉ có whitespace trước statement đầu → offset 0 vẫn trả statement đầu", () => {
    const sql = "\n  SELECT 1;";
    const out = statementAtCursor(sql, 0);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 1");
  });
});

describe("statementParser — sqlToRun", () => {
  it("Test #7 — selection chứa nhiều statement → mode=selection, split theo `;`", () => {
    const sql = "-- header\nSELECT 1; SELECT 2;\n";
    // Selection bao phủ "SELECT 1; SELECT 2;" — từ index 10 đến 29 (inclusive của ';' thứ 2).
    const selStart = sql.indexOf("SELECT 1"); // 10
    const firstSemi = sql.indexOf(";", selStart); // 18
    const secondSemi = sql.indexOf(";", firstSemi + 1); // 28
    const selEnd = secondSemi + 1; // 29 — sau ';' thứ 2
    const result = sqlToRun(sql, { start: selStart, end: selEnd }, 0);
    expect(result.mode).toBe("selection");
    expect(result.statements.length).toBeGreaterThanOrEqual(2);
    const texts = result.statements.map((s) => s.text.trim());
    expect(texts).toContain("SELECT 1");
    expect(texts).toContain("SELECT 2");
  });

  it("không selection → mode=cursor, lấy statement tại con trỏ", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const result = sqlToRun(sql, undefined, 12); // giữa SELECT 2
    expect(result.mode).toBe("cursor");
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].text).toBe("SELECT 2");
  });

  it("không selection, con trỏ trước statement đầu → statement đầu", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const result = sqlToRun(sql, undefined, 0);
    expect(result.mode).toBe("cursor");
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].text).toBe("SELECT 1");
  });

  it("không selection, file rỗng → statements rỗng, mode=cursor", () => {
    const result = sqlToRun("", undefined, 0);
    expect(result.mode).toBe("cursor");
    expect(result.statements).toEqual([]);
  });

  it("selection trống về text → statements rỗng, mode=selection", () => {
    const sql = "SELECT 1;";
    const result = sqlToRun(sql, { start: 0, end: 0 }, 0);
    expect(result.mode).toBe("selection");
    expect(result.statements).toEqual([]);
  });

  it("selection chỉ chứa 1 statement → 1 phần tử", () => {
    const sql = "SELECT 1; SELECT 2;";
    const result = sqlToRun(
      sql,
      { start: 0, end: sql.indexOf(";") + 1 },
      0,
    );
    expect(result.mode).toBe("selection");
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0].text).toBe("SELECT 1");
  });
});

// ---- Regression tests — fix round 1 (TASK-002 review findings) ----

describe("statementParser — regression (review fix round 1)", () => {
  // Finding #1: nested END IF inside BEGIN block must NOT decrement BEGIN depth.
  it("regression: nested END IF inside BEGIN block stays one statement", () => {
    const sql =
      "BEGIN\n  IF x THEN SELECT 1; END IF;\n  SELECT 2;\nEND;\nSELECT 3;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe(
      "BEGIN\n  IF x THEN SELECT 1; END IF;\n  SELECT 2;\nEND",
    );
    expect(out[1].text).toBe("SELECT 3");
  });

  it("regression: nested END LOOP inside BEGIN block stays one statement", () => {
    const sql =
      "BEGIN\n  FOR i IN 1..3 LOOP\n    SELECT i;\n  END LOOP;\nEND;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "BEGIN\n  FOR i IN 1..3 LOOP\n    SELECT i;\n  END LOOP;\nEND",
    );
  });

  it("regression: CASE ... END inside BEGIN block stays one statement", () => {
    const sql =
      "BEGIN\n  SELECT CASE WHEN x THEN 1 ELSE 2 END AS v FROM t;\nEND;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "BEGIN\n  SELECT CASE WHEN x THEN 1 ELSE 2 END AS v FROM t;\nEND",
    );
  });

  it("regression: BEGIN...END with nested IF and CASE — depth=1", () => {
    const sql =
      "BEGIN\n  IF x THEN\n    SELECT CASE WHEN y THEN 1 ELSE 2 END;\n  END IF;\nEND;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(sql.slice(0, sql.length - 1)); // drop trailing ;
  });

  // Finding #2: keyword matching must be case-insensitive.
  it("regression: lowercase begin...end works as one statement", () => {
    const sql = "begin\n SELECT 1;\nend;\nSELECT 2;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("begin\n SELECT 1;\nend");
    expect(out[1].text).toBe("SELECT 2");
  });

  it("regression: mixed-case Begin...End works as one statement", () => {
    const sql = "Begin\n SELECT 1;\nEnd;\nSELECT 2;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("Begin\n SELECT 1;\nEnd");
    expect(out[1].text).toBe("SELECT 2");
  });

  it("regression: lowercase end if still does NOT close BEGIN block", () => {
    const sql = "begin\n  if x then select 1; end if;\nend;\nSELECT 2;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe(
      "begin\n  if x then select 1; end if;\nend",
    );
    expect(out[1].text).toBe("SELECT 2");
  });

  // Finding #3: trailing comment-only text must NOT produce phantom statement.
  it("regression: trailing comment-only text produces no extra statement", () => {
    const sql = "SELECT 1;\n-- note\n";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("SELECT 1");
  });

  it("regression: trailing block-comment-only text produces no extra statement", () => {
    const sql = "SELECT 1;\n/* trailing */";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("SELECT 1");
  });

  it("regression: comment-only file → splitStatements returns []", () => {
    expect(splitStatements("-- foo;\n/* bar */")).toEqual([]);
  });

  it("regression: comment-only file → statementAtCursor returns null", () => {
    expect(statementAtCursor("-- foo;\n/* bar */", 0)).toBeNull();
  });

  it("regression: comment-only file → sqlToRun returns empty statements", () => {
    const result = sqlToRun("-- foo;\n/* bar */", undefined, 0);
    expect(result.mode).toBe("cursor");
    expect(result.statements).toEqual([]);
  });

  // Sanity: BEGIN...END around nested END IF still works through statementAtCursor.
  it("regression: statementAtCursor returns full BEGIN block with nested END IF", () => {
    const sql =
      "BEGIN\n  IF x THEN SELECT 1; END IF;\n  SELECT 2;\nEND;\nSELECT 3;";
    // offset 25 nằm giữa khối — phải trả về cả khối
    const out = statementAtCursor(sql, 25);
    expect(out).not.toBeNull();
    expect(out!.text).toBe(
      "BEGIN\n  IF x THEN SELECT 1; END IF;\n  SELECT 2;\nEND",
    );
  });
});

// Sanity cho types — đảm bảo shape ParsedStatement khớp interface.
describe("statementParser — ParsedStatement shape", () => {
  it("mỗi statement có text + start + end (start/end là character offset)", () => {
    const sql = "SELECT 1; SELECT 2;";
    const out = splitStatements(sql);
    for (const s of out) {
      expect(typeof s.text).toBe("string");
      expect(typeof s.start).toBe("number");
      expect(typeof s.end).toBe("number");
      expect(s.end).toBeGreaterThan(s.start);
      expect(sql.substring(s.start, s.end)).toBe(s.text);
    }
  });

  it("smoke — runner helper stmt() khớp interface", () => {
    const s = stmt("SELECT 1", 0, 8);
    expect(s.text).toBe("SELECT 1");
    expect(s.start).toBe(0);
    expect(s.end).toBe(8);
  });
});
// ---- Regression tests — cursor-mode regression lock (cycle R, TASK-005) ----
describe("statementParser — cursor-mode regression lock (cycle R)", () => {
// Lock parser invariants for Cmd+Enter cursor mode. #2 is the deviation
// candidate from code-read (gap-fallback returns stmts[last], but user intent
// for cursor in whitespace is the statement TRƯỚC).

  // #1: cursor giữa stmt multi-line → nguyên stmt (không cắt từ offset).
  it("#1 cursor giữa multi-line stmt → full stmt (không bắt đầu ở offset)", () => {
    const sql = "SELECT 1,\n       2;\nSELECT 3;";
    // sql.length = 28. splitStatements: stmt1 = [0,18) = "SELECT 1,\n       2",
    // stmt2 = [20,28) = "SELECT 3".
    const stmt1Start = sql.indexOf("SELECT 1,");
    const stmt1End = 18;
    const midOffset = 12; // bên trong stmt 1, sau dấu phẩy.
    expect(midOffset).toBeGreaterThanOrEqual(stmt1Start);
    expect(midOffset).toBeLessThan(stmt1End);
    const out = statementAtCursor(sql, midOffset);
    expect(out).not.toBeNull();
    expect(out!.start).toBe(stmt1Start);
    expect(out!.end).toBe(stmt1End);
    expect(out!.text).toBe(sql.substring(stmt1Start, stmt1End));
  });

  // #2: deviation candidate — gap giữa 2 stmt → stmt TRƯỚC (not stmt cuối).
  it("#2 gap giữa 2 stmt (cursor trong whitespace) → stmt TRƯỚC", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    // stmt1 = [0,8), stmt2 = [10,18). gap `\n\n` ở [8,10).
    const stmt1End = 8;
    const stmt2Start = 10;
    const gapOffset = 9; // giữa gap
    expect(gapOffset).toBeGreaterThanOrEqual(stmt1End);
    expect(gapOffset).toBeLessThan(stmt2Start);
    const out = statementAtCursor(sql, gapOffset);
    expect(out).not.toBeNull();
    // Gap rule mới: stmt gần nhất TRƯỚC cursor → stmt 1.
    expect(out!.text).toBe("SELECT 1");
    expect(out!.start).toBe(0);
    expect(out!.end).toBe(stmt1End);
  });

  // #3: EOF không `;` → stmt cuối full.
  it("#3 EOF không `;` → stmt cuối full text", () => {
    const sql = "SELECT 1;\nSELECT 2";
    const out = statementAtCursor(sql, sql.length);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 2");
    expect(sql.substring(out!.start, out!.end)).toBe(out!.text);
  });

  // #4: BEGIN...END cursor giữa → cả block.
  it("#4 cursor giữa BEGIN...END block → cả block", () => {
    const sql = "BEGIN\n  SELECT 1;\n  SELECT 2;\nEND;\nSELECT 3;";
    // splitStatements: block=[0,33) "BEGIN\n  SELECT 1;\n  SELECT 2;\nEND", stmt2=[35,43) "SELECT 3".
    const blockStart = 0;
    const blockEnd = 33;
    const midOffset = 10; // giữa khối (trong `BEGIN\n  S`).
    expect(midOffset).toBeGreaterThanOrEqual(blockStart);
    expect(midOffset).toBeLessThan(blockEnd);
    const out = statementAtCursor(sql, midOffset);
    expect(out).not.toBeNull();
    expect(out!.start).toBe(blockStart);
    expect(out!.end).toBe(blockEnd);
    expect(out!.text.startsWith("BEGIN")).toBe(true);
    expect(out!.text.includes("END")).toBe(true);
  });

  // #5: offset < stmt đầu (leading whitespace) → stmt ĐẦU (rule mới).
  // Trước fix: stmts[0].start > 0 → vòng for không match → fallback trả last stmt.
  // Sau fix: rule mới — offset trước stmt đầu → stmt đầu.
  it("#5 offset trước stmt đầu (leading whitespace) → stmt ĐẦU (behavior change có chủ đích)", () => {
    const sql = "\n  SELECT 1;\nSELECT 2;";
    // splitStatements bỏ leading whitespace → stmts[0].start = 3 (vị trí 'S').
    const stmt1Start = 3;
    const stmt1End = 11;
    expect(stmt1Start).toBeGreaterThan(0);
    // offset 0 nằm TRƯỚC stmt đầu.
    const out = statementAtCursor(sql, 0);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 1");
    expect(out!.start).toBe(stmt1Start);
    expect(out!.end).toBe(stmt1End);
  });

  // #6: selection mode KHÔNG đổi — selection trong range stmt → statements trong vùng.
  it("#6 selection mode KHÔNG đổi — chọn vùng stmt 2 → statements trong vùng", () => {
    const sql = "SELECT 1; SELECT 2; SELECT 3;";
    const start = sql.indexOf("SELECT 2");
    const end = sql.indexOf(";", start) + 1;
    const result = sqlToRun(sql, { start, end }, 0);
    expect(result.mode).toBe("selection");
    expect(result.statements.length).toBeGreaterThanOrEqual(1);
    const texts = result.statements.map((s) => s.text);
    expect(texts.some((t) => t.includes("SELECT 2"))).toBe(true);
  });

  // #7: CRLF — offset sau \r\n giữa 2 stmt → stmt trước; ranges không lệch.
  it("#7 CRLF offset sau \\r\\n gap giữa 2 stmt → stmt trước; ranges không lệch", () => {
    const sql = "SELECT 1;\r\n\r\nSELECT 2;";
    // stmt1 = [0,8), stmt2 = [12,20). Gap `\r\n\r\n` ở [8,12).
    const stmt1End = 8;
    const stmt2Start = 12;
    const gapOffset = 10; // giữa gap, sau `\r\n` thứ 2.
    expect(gapOffset).toBeGreaterThanOrEqual(stmt1End);
    expect(gapOffset).toBeLessThan(stmt2Start);
    const out = statementAtCursor(sql, gapOffset);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("SELECT 1");
    // Ranges không lệch — substring[start,end] === text.
    expect(sql.substring(out!.start, out!.end)).toBe(out!.text);
    expect(out!.start).toBeLessThan(stmt2Start);
  });
});
