// src/core/__tests__/statementParser.test.ts
// Bảng test table-driven cho statementParser — TASK-002 §Test Cases.
import { describe, it, expect } from "vitest";
import {
  splitStatements,
  statementAtCursor,
  sqlToRun,
  debugFinalConstructStackSizeForTest,
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

// ---- TASK-004 — transaction scripts, loop-stack leak, MySQL escapes, MSSQL GO ----

describe("statementParser — TASK-004 splitStatements dialect fixes", () => {
  // Happy
  it("Happy — plain script splits into 2", () => {
    const out = splitStatements("SELECT 1; SELECT 2;");
    expect(out).toHaveLength(2);
  });

  it("Happy — transaction script BEGIN; INSERT; COMMIT; → 3, correct texts", () => {
    const sql = "BEGIN; INSERT INTO t VALUES (1); COMMIT;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[0].text).toBe("BEGIN");
    expect(out[1].text.trim()).toBe("INSERT INTO t VALUES (1)");
    expect(out[2].text.trim()).toBe("COMMIT");
  });

  // Edge — nesting
  it("Edge (nesting) — plpgsql BEGIN...END body inside $$ is NOT split (2 statements total)", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql; SELECT 1;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toContain("BEGIN RETURN 1; END");
    expect(out[1].text.trim()).toBe("SELECT 1");
  });

  it("Edge (nesting) — BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT 1; ROLLBACK; → 3", () => {
    const sql =
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE; SELECT 1; ROLLBACK;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[2].text.trim()).toBe("ROLLBACK");
  });

  // Edge — dialect (C3)
  it("Edge (dialect) — MySQL backslash escape `\\'` does not split the string", () => {
    const out = splitStatements("SELECT 'it\\'s'; SELECT 2;", "mysql");
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe("SELECT 'it\\'s'");
    expect(out[1].text.trim()).toBe("SELECT 2");
  });

  it("Edge (dialect) — postgres dialect keeps today's (buggy-for-mysql) result unchanged", () => {
    const withDialect = splitStatements(
      "SELECT 'it\\'s'; SELECT 2;",
      "postgres",
    );
    const withoutDialect = splitStatements("SELECT 'it\\'s'; SELECT 2;");
    expect(withDialect).toEqual(withoutDialect);
    expect(withDialect).toHaveLength(1);
  });

  // Edge — batch separator (C4)
  it("Edge (batch separator) — MSSQL GO alone on its own line splits into 2, no GO in text", () => {
    const out = splitStatements("SELECT 1\nGO\nSELECT 2\nGO", "mssql");
    expect(out).toHaveLength(2);
    for (const s of out) {
      expect(s.text.toUpperCase()).not.toContain("GO");
    }
    expect(out[0].text.trim()).toBe("SELECT 1");
    expect(out[1].text.trim()).toBe("SELECT 2");
  });

  it("Edge (false friend) — column named `go` (mssql) is NOT treated as a separator", () => {
    const out = splitStatements("SELECT go FROM t", "mssql");
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("SELECT go FROM t");
  });

  // Regression (C1)
  it("R (C1) — BEGIN; INSERT...; COMMIT; used to collapse into 1 statement", () => {
    const out = splitStatements("BEGIN; INSERT INTO t VALUES (1); COMMIT;");
    expect(out).toHaveLength(3);
  });

  // Regression (C2)
  it("R (C2) — SELECT ... FOR UPDATE; SELECT 1; splits into 2 with an empty construct stack", () => {
    const sql = "SELECT * FROM t FOR UPDATE; SELECT 1;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text.trim()).toBe("SELECT * FROM t FOR UPDATE");
    expect(out[1].text.trim()).toBe("SELECT 1");
    // Direct assertion on the construct stack (not just statement count) —
    // guards against the leaked LOOP entry silently desyncing later parses.
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  it("R (C2) — leaked FOR UPDATE stack entry does not desync a later BEGIN...END block", () => {
    const sql =
      "SELECT * FROM t FOR UPDATE; BEGIN\n SELECT 1;\nEND;\nSELECT 2;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[0].text.trim()).toBe("SELECT * FROM t FOR UPDATE");
    expect(out[1].text).toBe("BEGIN\n SELECT 1;\nEND");
    expect(out[2].text).toBe("SELECT 2");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Regression (C3)
  it("R (C3) — MySQL `\\'` used to collapse into 1 statement", () => {
    const out = splitStatements("SELECT 'it\\'s'; SELECT 2;", "mysql");
    expect(out).toHaveLength(2);
  });

  // Regression (C4)
  it("R (C4) — MSSQL GO used to collapse into 1 statement", () => {
    const out = splitStatements("SELECT 1\nGO\nSELECT 2\nGO", "mssql");
    expect(out).toHaveLength(2);
  });

  // Interface / no-dialect-arg regression guard — must stay byte-identical to
  // today's behavior when dialect is omitted (optional & additive).
  it("no dialect argument behaves exactly like today for an existing case", () => {
    const sql = "BEGIN\n SELECT 1;\n SELECT 2;\nEND";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(sql);
  });
});

describe("statementParser — review fix round C regressions", () => {
  // Finding #2 — `END WHILE` (MySQL WHILE...DO...END WHILE, no LOOP keyword)
  // must NOT pop the enclosing BEGIN block. Before the C2 fix this was 2
  // statements; the WHILE-push removal broke it to 3.
  it("regression (finding 2): END WHILE inside BEGIN stays part of the same statement", () => {
    const sql =
      "CREATE PROCEDURE p() BEGIN WHILE i<3 DO SET i=i+1; END WHILE; END; SELECT 1;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe(
      "CREATE PROCEDURE p() BEGIN WHILE i<3 DO SET i=i+1; END WHILE; END",
    );
    expect(out[1].text.trim()).toBe("SELECT 1");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  it("regression (finding 2): END REPEAT inside BEGIN stays part of the same statement", () => {
    const sql =
      "BEGIN\n  REPEAT\n    SET i=i+1;\n  UNTIL i>3 END REPEAT;\nEND;\nSELECT 1;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[1].text.trim()).toBe("SELECT 1");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Must NOT reintroduce the FOR UPDATE leak while fixing finding 2.
  it("regression (finding 2 guard): SELECT ... FOR UPDATE still leaves stack size 0", () => {
    const sql = "SELECT * FROM t FOR UPDATE; SELECT 1;";
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Existing END IF / END LOOP / END CASE pairing must still work (no change
  // in behavior for constructs that DO push).
  it("regression (finding 2 guard): END LOOP/END IF/END CASE pairing unaffected", () => {
    const sql =
      "BEGIN\n  FOR i IN 1..3 LOOP\n    IF i=1 THEN SELECT 1; END IF;\n  END LOOP;\nEND;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(1);
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Finding #4 — BEGIN forward-peek must skip comments, not just whitespace.
  it("regression (finding 4): BEGIN -- comment\\n; is still transaction-control", () => {
    const sql = "BEGIN -- go\n;\nUPDATE t SET a=1;\nCOMMIT;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  it("regression (finding 4): BEGIN /* txn */; is still transaction-control", () => {
    const sql = "BEGIN /* txn */;\nUPDATE t SET a=1;\nCOMMIT;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(3);
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Finding #8 — MySQL `IF(a,b,c)` function-call form (no space before `(`)
  // must not be treated as the control-flow IF keyword: it has no matching
  // `END IF`, so pushing it onto the construct stack leaks a phantom entry.
  it("regression (finding 8): standalone IF(a,b,c) function call leaves stack size 0", () => {
    const sql = "SELECT IF(a,b,c);";
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  it("regression (finding 8): IF(a,b,c) inside a BEGIN...END routine body no longer corrupts block detection — previously the leaked IF got popped by the routine's own END instead of the real BLOCK, gluing the entire rest of the script into one undividable statement", () => {
    const sql =
      "CREATE PROCEDURE p() BEGIN SELECT IF(a,b,c); END; SELECT 2;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text.trim()).toBe(
      "CREATE PROCEDURE p() BEGIN SELECT IF(a,b,c); END",
    );
    expect(out[1].text.trim()).toBe("SELECT 2");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Must NOT regress the real control-flow `IF` (space before condition,
  // used pervasively by this file's own BEGIN/IF/END tests above).
  it("regression (finding 8 guard): real control-flow IF x THEN ... END IF (space before condition) still pushes/pops normally", () => {
    const sql =
      "BEGIN\n  IF x THEN SELECT 1; END IF;\n  SELECT 2;\nEND;\nSELECT 3;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[1].text.trim()).toBe("SELECT 3");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });
});

// ---- Regression tests — fix round E (root cause: pop decided by TOP-OF-STACK
// KIND, not lookahead text after END) ----
describe("statementParser — review fix round E regressions (root cause: stack-kind pop)", () => {
  // Finding #1 — CRITICAL. T-SQL has NO `END WHILE` construct at all: two
  // sequential `WHILE ... BEGIN ... END` loops mean the first `END` really
  // does close its `BEGIN`, and the `WHILE` right after it is just the next
  // unrelated statement's leading keyword — must be dialect-aware (mssql
  // never treats an `END WHILE` lookahead as a skip-pop).
  it("regression (finding 1): mssql sequential WHILE BEGIN...END loops — GO after both flushes cleanly, no leak", () => {
    const sql =
      "WHILE @i<10 BEGIN\n  SET @i=@i+1\nEND\nWHILE @j<5 BEGIN\n  SET @j=@j+1\nEND\nGO\nSELECT 1;";
    const out = splitStatements(sql, "mssql");
    expect(out).toHaveLength(2);
    for (const s of out) {
      expect(s.text.toUpperCase()).not.toContain("GO");
    }
    expect(out[1].text.trim()).toBe("SELECT 1");
    expect(debugFinalConstructStackSizeForTest(sql, "mssql")).toBe(0);
  });

  // Guard: mysql `END WHILE` (real construct, WHILE never pushes) must still
  // be a true no-op and NOT pop the enclosing BEGIN block.
  it("regression (finding 1 guard): mysql CREATE PROCEDURE ... END WHILE ... END still parses as ONE statement", () => {
    const sql =
      "CREATE PROCEDURE p() BEGIN WHILE i<3 DO SET i=i+1; END WHILE; END; SELECT 1;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe(
      "CREATE PROCEDURE p() BEGIN WHILE i<3 DO SET i=i+1; END WHILE; END",
    );
    expect(out[1].text.trim()).toBe("SELECT 1");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Finding #2 — CRITICAL. `IF(x=1) THEN ... END IF;` inside a BEGIN block:
  // IF( skips the push (function-call heuristic), so the later `END IF` must
  // NOT pop the enclosing BLOCK either — the pop is now conditional on
  // top-of-stack being IF, not on END IF lookahead text alone.
  it("regression (finding 2): CREATE PROCEDURE with IF(...) THEN ... END IF; body stays ONE statement (no stored-proc splitting)", () => {
    const sql =
      "CREATE PROCEDURE p() BEGIN IF(x=1) THEN SELECT 1; END IF; SELECT 2; END; SELECT 9;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe(
      "CREATE PROCEDURE p() BEGIN IF(x=1) THEN SELECT 1; END IF; SELECT 2; END",
    );
    expect(out[1].text.trim()).toBe("SELECT 9");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });

  // Finding #3 — IMPORTANT. `FOR` is dropped from the END-suffix list
  // entirely: `END FOR UPDATE` / `END FOR XML` must be treated as a bare
  // END, popping whatever construct (e.g. CASE) is actually on top.
  it("regression (finding 3): CASE ... END FOR UPDATE does not leak the CASE frame", () => {
    const sql =
      "SELECT * FROM t WHERE s = CASE WHEN a THEN 'x' ELSE 'y' END FOR UPDATE; SELECT 2;";
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0].text.trim()).toBe(
      "SELECT * FROM t WHERE s = CASE WHEN a THEN 'x' ELSE 'y' END FOR UPDATE",
    );
    expect(out[1].text.trim()).toBe("SELECT 2");
    expect(debugFinalConstructStackSizeForTest(sql)).toBe(0);
  });
});

// ---- TASK-DBX02-004 — parsed SQL identifier references ---------------------
//
// extractIdentifierReferences(sql, dialect) walks SQL token boundaries
// (String, Identifier, DollarQuote, LineComment, BlockComment) the same way
// the parser's splitStatements does and emits one IdentifierReference per
// direct code-side identifier it finds. For `qualifier.identifier` it emits
// exactly ONE reference for the RIGHT side, with the LEFT side's span
// recorded as `qualifier`. Bare identifiers come back with no qualifier.
// Aliases are NOT resolved at this layer — see the provider for catalog
// filtering.
import { extractIdentifierReferences } from "../statementParser";
import type { IdentifierReference } from "../statementParser";

describe("statementParser — extractIdentifierReferences", () => {
  it("Test #1 — emits direct table/column/FK-target identifiers across statements with qualifier spans", () => {
    const sql =
      "SELECT orders.user_id FROM orders JOIN users ON orders.user_id = users.id;";
    // Offsets (verified by indexOf on the literal above):
    //   SELECT          [ 0,  6)
    //   orders (proj)   [ 7, 13)   ← qualifies user_id
    //   user_id (proj)  [14, 21)   ← right side of projection
    //   FROM            [22, 26)
    //   orders (FROM)   [27, 33)
    //   JOIN            [34, 38)
    //   users (JOIN)    [39, 44)
    //   ON              [45, 47)
    //   orders (ON)     [48, 54)   ← qualifies user_id
    //   user_id (ON)    [55, 62)   ← right side
    //   users (ON rhs)  [65, 70)
    //   id (ON rhs)     [71, 73)   ← right side of users.id
    //
    // For `qualifier.identifier`, extractor emits ONE reference for the
    // RIGHT side (column) and records the LEFT side as `qualifier`. Bare
    // identifiers come back with no qualifier. SELECT/FROM/JOIN/ON are SQL
    // keywords and stay out of the result. Expected sequence (in source
    // order):
    //   1. user_id  [14, 21)  qual orders  [ 7, 13)
    //   2. orders   [27, 33)  (bare, FROM target)
    //   3. users    [39, 44)  (bare, JOIN target)
    //   4. user_id  [55, 62)  qual orders  [48, 54)
    //   5. users    [65, 70)  (bare, ON rhs)
    //   6. id       [71, 73)  qual users   [65, 70)
    //
    // CORRECTION (post-implementation alignment): the contract in
    // TASK-DBX02-004 §Interfaces says for `qualifier.identifier` the LEFT
    // side is recorded ONLY as `qualifier` and is NOT emitted as its own
    // bare reference (matching refs[0]: bare `orders`@[7,13) is absent).
    // `users`@[65,70) is the LEFT side of `users.id` — the same shape —
    // so the earlier expectation of a bare users ref there contradicted
    // refs[0]. The emitted stream is 5 refs, not 6.
    const refs = extractIdentifierReferences(sql);
    expect(refs.length).toBe(5);
    expect(refs[0]).toEqual({
      name: "user_id",
      start: 14,
      end: 21,
      quoted: false,
      qualifier: { name: "orders", start: 7, end: 13, quoted: false },
    });
    expect(refs[1]).toEqual({
      name: "orders",
      start: 27,
      end: 33,
      quoted: false,
    });
    expect(refs[2]).toEqual({
      name: "users",
      start: 39,
      end: 44,
      quoted: false,
    });
    expect(refs[3]).toEqual({
      name: "user_id",
      start: 55,
      end: 62,
      quoted: false,
      qualifier: { name: "orders", start: 48, end: 54, quoted: false },
    });
    expect(refs[4]).toEqual({
      name: "id",
      start: 71,
      end: 73,
      quoted: false,
      qualifier: { name: "users", start: 65, end: 70, quoted: false },
    });
  });

  it("Test #2 — identifier in line/block comments, strings, and dollar-quote is NOT emitted", () => {
    const sql = [
      "-- orders in line comment",
      "/* orders in block comment */",
      "SELECT 'orders in string', $$orders in dollar quote$$;",
    ].join("\n");
    const refs = extractIdentifierReferences(sql);
    const names = refs.map((r) => r.name);
    // Only the SELECT keyword left as bare identifier (none expected — SELECT
    // is a keyword and gets filtered). Nothing else should be emitted because
    // every occurrence of `orders` lives in a non-code span.
    expect(names).toEqual([]);
    expect(refs).toEqual([]);
  });

  it("Test #3 — quoted mixed-case identifier keeps its quoted flag and exact text", () => {
    // "SalesOrders" (quoted mixed-case) vs `salesorders` (lowercase, unquoted)
    // — extractor emits each with the correct `quoted` flag and verbatim
    // text (NO case folding). Catalog matching uses these exact strings.
    const sql = 'SELECT "SalesOrders".id FROM "SalesOrders";';
    const refs = extractIdentifierReferences(sql);
    // Expected:
    //   - id with qualifier "SalesOrders" (the SELECT projection)
    //   - "SalesOrders" (the FROM target, bare, quoted)
    const projection = refs.find((r) => r.name === "id");
    expect(projection).toBeDefined();
    expect(projection?.quoted).toBe(false);
    expect(projection?.start).toBe(sql.indexOf(".id") + 1);
    expect(projection?.end).toBe(sql.indexOf(".id") + 1 + "id".length);
    expect(projection?.qualifier).toEqual({
      name: "SalesOrders",
      start: sql.indexOf('"SalesOrders"'),
      end: sql.indexOf('"SalesOrders"') + '"SalesOrders"'.length,
      quoted: true,
    });
    const fromTarget = refs.find(
      (r) => r.name === "SalesOrders" && r.qualifier === undefined,
    );
    // Unquoted `salesorders` does NOT appear in this SQL — there is no
    // lowercase occurrence, so nothing else should be emitted.
    const lower = refs.find((r) => r.name === "salesorders");
    expect(lower).toBeUndefined();
  });

  it("Test #4 — alias declaration and alias-qualified columns are emitted as raw tokens (filtering is the provider's job)", () => {
    // `orders o` declares alias `o`; `o.user_id` references through the alias.
    // `bare` is an unqualified ambiguous column. The parser emits raw tokens
    // regardless — `o` appears as a qualifier span and `bare` as a bare
    // identifier. The provider is responsible for rejecting both, since this
    // cycle only matches direct unaliased qualified identifiers.
    const sql = "SELECT o.user_id, bare FROM orders o;";
    const refs = extractIdentifierReferences(sql);
    // We expect:
    //   - user_id with qual { name: "o", start: <o decl position>, ... }
    //   - bare (no qualifier)
    const userId = refs.find((r) => r.name === "user_id");
    expect(userId).toBeDefined();
    expect(userId?.qualifier?.name).toBe("o");
    // The qualifier span must point at the alias declaration `o` — the
    // parser does NOT skip alias declarations, so the LEFT side of
    // `o.user_id` is recorded for the provider to filter out.
    expect(userId?.qualifier?.start).toBe(sql.indexOf(".user_id") - 1);
    expect(userId?.qualifier?.end).toBe(sql.indexOf(".user_id"));
    const bare = refs.find((r) => r.name === "bare");
    expect(bare).toBeDefined();
    expect(bare?.qualifier).toBeUndefined();
    // `orders` (FROM target) still emitted — provider filter will reject
    // alias-side references but the raw token stream is complete.
    const orders = refs.find((r) => r.name === "orders");
    expect(orders).toBeDefined();
  });
});
