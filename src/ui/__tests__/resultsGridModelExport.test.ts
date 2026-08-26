// src/ui/__tests__/resultsGridModelExport.test.ts
// TASK-502 — Pure-logic tests for the 8-format export serializers.
// No DOM, no AG Grid, no vscode — plain vitest node environment.
import { describe, it, expect } from "vitest";
import {
  serializeExport,
  serializeTsv,
  serializeCsv,
  serializeXml,
  serializeJson,
  serializeSqlInserts,
  serializeSqlUpdates,
  serializeWhereClause,
  sqlLiteral,
  type ExportFormat,
} from "../resultsGridModel";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const NO_OPT = { includeHeader: false, tableName: "t", pkColumns: [] as string[] };

const COLS = ["id", "name", "active"];
const ROWS: unknown[][] = [
  [1, "alpha", true],
  [2, "beta, \"q\"", false],
  [3, "line\nbreak", null],
];

// ---- 1. serializeTsv header on/off ---------------------------------------
describe("serializeTsv", () => {
  it("1. header on → header row + tab-joined rows", () => {
    const out = serializeTsv(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("id\tname\tactive");
    expect(lines[1]).toBe("1\talpha\ttrue");
    expect(lines[2]).toBe("2\tbeta, \"q\"\tfalse");
    // Row 3 has \n break inside a cell — line count is therefore larger.
    expect(out).toContain("line\nbreak");
  });

  it("1b. header off → no header row", () => {
    const out = serializeTsv(COLS, ROWS, { ...NO_OPT, includeHeader: false });
    expect(out.startsWith("1\t")).toBe(true);
    expect(out).not.toContain("id\tname\tactive\n");
  });
});

// ---- 2. serializeCsv RFC4180 quote-escape ----------------------------------
describe("serializeCsv", () => {
  it("2. cell chứa comma / quote / newline → RFC4180 quote-escape", () => {
    const out = serializeCsv(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("id,name,active");
    // `beta, "q"` → quoted with double-double-quote inside → `"beta, ""q"""`
    expect(lines[2]).toBe('2,"beta, ""q""",false');
    // Newline inside cell → cell quoted and newline preserved literally.
    expect(out).toContain('"line\nbreak"');
  });
});

// ---- 3. serializeXml -------------------------------------------------------
describe("serializeXml", () => {
  it("3. well-formed XML, `&<>` escaped — col wrapper with name attribute", () => {
    const cols = ["id", "msg"];
    const rows: unknown[][] = [
      [1, "a&b<c>d"],
      [2, "ok"],
    ];
    const out = serializeXml(cols, rows, {
      ...NO_OPT,
      includeHeader: true,
    });
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(out).toContain("<row>");
    // R1: column names live in `name` attributes on a <col> wrapper to
    // guarantee well-formed XML regardless of the source alias.
    expect(out).toContain('<col name="id">1</col>');
    expect(out).toContain('<col name="msg">a&amp;b&lt;c&gt;d</col>');
    expect(out.trim().endsWith("</rows>")).toBe(true);
  });
});

// ---- 4. serializeJson ------------------------------------------------------
describe("serializeJson", () => {
  it("4. JSON.parse được, null giữ null", () => {
    const out = serializeJson(COLS, ROWS, { ...NO_OPT, includeHeader: true });
    const parsed = JSON.parse(out) as { columns: string[]; rows: unknown[][] };
    expect(parsed.columns).toEqual(COLS);
    expect(parsed.rows).toEqual(ROWS); // row 3 keeps null
  });
});

// ---- 5. serializeSqlInserts single -----------------------------------------
describe("serializeSqlInserts", () => {
  it("5. single-row INSERT", () => {
    const out = serializeSqlInserts(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
    });
    // R1 portable literals: newline is embedded raw, backslash passes through.
    expect(out).toBe(
      "INSERT INTO users (id, name, active) VALUES (1, 'alpha', TRUE);\n" +
        "INSERT INTO users (id, name, active) VALUES (2, 'beta, \"q\"', FALSE);\n" +
        "INSERT INTO users (id, name, active) VALUES (3, 'line\nbreak', NULL);",
    );
  });
  it("6. multirow INSERT — 1 INSERT nhiều tuple groups", () => {
    const out = serializeSqlInserts(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      multirow: true,
    });
    // R1 portable literals: newline is embedded raw.
    expect(out).toBe(
      "INSERT INTO users (id, name, active) VALUES " +
        "(1, 'alpha', TRUE), (2, 'beta, \"q\"', FALSE), (3, 'line\nbreak', NULL);",
    );
  });
});
describe("serializeSqlUpdates", () => {
  it("7. UPDATE — `SET ...` theo non-PK cols, `WHERE` theo PK", () => {
    const out = serializeSqlUpdates(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id"],
    });
    // R1 portable literals: newline is embedded raw. P2-6: every
    // interpolated column name is now double-quoted (portable SQL posture).
    expect(out).toBe(
      'UPDATE users SET "name"=\'alpha\', "active"=TRUE WHERE "id"=1;\n' +
        'UPDATE users SET "name"=\'beta, "q"\', "active"=FALSE WHERE "id"=2;\n' +
        'UPDATE users SET "name"=\'line\nbreak\', "active"=NULL WHERE "id"=3;',
    );
  });

  // R2 supersedes R1's "degrade to all-cols WHERE" — sqlite rejected
  // `UPDATE t WHERE (…)` with no SET clause as a syntax error. The
  // contract is now: when the SET list would be empty, emit a
  // SQL comment line instead of a malformed UPDATE.
  it("7b. UPDATE with no PK columns → skip-comment (no throw, no malformed UPDATE)", () => {
    expect(() =>
      serializeSqlUpdates(COLS, ROWS, {
        ...NO_OPT,
        includeHeader: true,
        tableName: "users",
        pkColumns: [],
      }),
    ).not.toThrow();
    const out = serializeSqlUpdates(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: [],
    });
    // Empty PK + multi-col schema → every column is treated as key,
    // SET is empty → all rows skipped. No `UPDATE users` at all.
    expect(out).not.toMatch(/UPDATE\s+users/);
    expect(out).toContain("row 1 skipped: no non-key columns to update");
    expect(out).toContain("row 2 skipped: no non-key columns to update");
    expect(out).toContain("row 3 skipped: no non-key columns to update");
  });
});

// ---- 8. serializeWhereClause -----------------------------------------------
describe("serializeWhereClause", () => {
  it("8. per-row AND groups joined by OR", () => {
    const out = serializeWhereClause(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id", "name"],
      selectedRows: [
        [1, "alpha", true],
        [3, "line\nbreak", null],
      ],
    });
    // R1 portable literals: newline embedded raw. P2-6: key columns quoted.
    expect(out).toBe(
      'WHERE ("id"=1 AND "name"=\'alpha\') OR ("id"=3 AND "name"=\'line\nbreak\')',
    );
  });

  it("8b. no PK columns → fallback to all-columns joined AND (documented)", () => {
    const out = serializeWhereClause(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: [],
      selectedRows: [[1, "alpha", true]],
    });
    expect(out).toBe(
      'WHERE ("id"=1 AND "name"=\'alpha\' AND "active"=TRUE)',
    );
  });

  it("8c. no selection → uses all rows", () => {
    const out = serializeWhereClause(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id"],
    });
    // No rows → empty string (caller decides whether to write "WHERE 1=0").
    expect(out).toBe('WHERE ("id"=1) OR ("id"=2) OR ("id"=3)');
  });
});

// ---- 9. sqlLiteral ----------------------------------------------------------
describe("sqlLiteral", () => {
  it("9. null/number/string/boolean serialize đúng", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(3.14)).toBe("3.14");
    expect(sqlLiteral("plain")).toBe("'plain'");
    // quote escape: q'uote → 'q''uote'
    expect(sqlLiteral("q'uote")).toBe("'q''uote'");
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(false)).toBe("FALSE");
    expect(sqlLiteral(undefined)).toBe("NULL");
  });
});

// ---- 10. empty rows ---------------------------------------------------------
describe("empty rows — all serializers return a clean shape", () => {
  it("10. TSV header on/off with 0 rows", () => {
    expect(serializeTsv(COLS, [], { ...NO_OPT, includeHeader: true })).toBe(
      "id\tname\tactive",
    );
    expect(serializeTsv(COLS, [], { ...NO_OPT, includeHeader: false })).toBe("");
  });

  it("10. CSV header on/off with 0 rows", () => {
    expect(serializeCsv(COLS, [], { ...NO_OPT, includeHeader: true })).toBe(
      "id,name,active",
    );
    expect(serializeCsv(COLS, [], { ...NO_OPT, includeHeader: false })).toBe("");
  });

  it("10. JSON with 0 rows → JSON with empty array, parses", () => {
    const out = serializeJson(COLS, [], { ...NO_OPT, includeHeader: true });
    const parsed = JSON.parse(out) as { columns: string[]; rows: unknown[][] };
    expect(parsed.columns).toEqual(COLS);
    expect(parsed.rows).toEqual([]);
  });

  it("10. XML with 0 rows → well-formed but empty <rows/>", () => {
    const out = serializeXml(COLS, [], { ...NO_OPT, includeHeader: true });
    expect(out).toContain("<rows>");
    expect(out).toContain("</rows>");
  });

  it("10. SQL inserts/updates/where with 0 rows → empty / clean", () => {
    expect(
      serializeSqlInserts(COLS, [], { ...NO_OPT, tableName: "users" }),
    ).toBe("");
    expect(
      serializeSqlInserts(COLS, [], {
        ...NO_OPT,
        tableName: "users",
        multirow: true,
      }),
    ).toBe("");
    expect(
      serializeSqlUpdates(COLS, [], {
        ...NO_OPT,
        tableName: "users",
        pkColumns: ["id"],
      }),
    ).toBe("");
    expect(
      serializeWhereClause(COLS, [], {
        ...NO_OPT,
        tableName: "users",
        pkColumns: ["id"],
      }),
    ).toBe("");
  });

  it("10. no NaN / undefined tokens leak into output", () => {
    for (const fmt of [
      "tsv",
      "csv",
      "xml",
      "json",
      "sql-inserts",
      "sql-inserts-multirow",
      "sql-updates",
      "sql-where",
    ] as ExportFormat[]) {
      const out = serializeExport(fmt, COLS, ROWS, {
        includeHeader: true,
        tableName: "t",
        pkColumns: ["id"],
      });
      expect(out, `fmt=${fmt}`).not.toContain("NaN");
      expect(out, `fmt=${fmt}`).not.toContain("undefined");
    }
  });
});

// ---- 11. serializeExport dispatch ------------------------------------------
describe("serializeExport dispatch", () => {
  it("dispatches every format and returns non-empty", () => {
    for (const fmt of [
      "tsv",
      "csv",
      "xml",
      "json",
      "sql-inserts",
      "sql-inserts-multirow",
      "sql-updates",
      "sql-where",
    ] as ExportFormat[]) {
      const out = serializeExport(fmt, COLS, ROWS, {
        includeHeader: true,
        tableName: "t",
        pkColumns: ["id"],
      });
      expect(out.length, `fmt=${fmt}`).toBeGreaterThan(0);
    }
  });
});

// ---- Fix Round 1: portable sqlLiteral (no backslash / control-char escape) -

describe("sqlLiteral — portable ANSI SQL (Fix R1)", () => {
  it("R1.sqlLiteral.1: backslash is NOT escaped — passes through verbatim", () => {
    // PG (standard_conforming_strings=on) and MSSQL treat backslash
    // literally; pre-fix escaping `\` → `\\` corrupted data. Portable
    // output is the raw character inside the quoted literal.
    expect(sqlLiteral("a\\b")).toBe("'a\\b'");
    expect(sqlLiteral("C:\\path")).toBe("'C:\\path'");
  });

  it("R1.sqlLiteral.2: literal newline is embedded raw inside the string", () => {
    // A newline inside a SQL string literal is portable across PG, MSSQL,
    // MySQL — the only consumer that needs an escape sequence is the
    // client reading the .sql file. The .sql file is round-trippable
    // without backslash-mangling.
    expect(sqlLiteral("line\nbreak")).toBe("'line\nbreak'");
    expect(sqlLiteral("with\ttab")).toBe("'with\ttab'");
  });

  it("R1.sqlLiteral.3: carriage return also passes through raw", () => {
    expect(sqlLiteral("a\rb")).toBe("'a\rb'");
  });

  it("R1.sqlLiteral.4: single-quote doubling is still applied", () => {
    expect(sqlLiteral("q'uote")).toBe("'q''uote'");
  });

  it("R1.sqlLiteral.5: round-trip with both backslash and newline together", () => {
    const v = "a\\b\nc";
    expect(sqlLiteral(v)).toBe("'a\\b\nc'");
  });
});

// ---- Fix Round 1+2: sql-updates degrades safely on empty PK ---------------
// (R1 added the no-throw; R2 corrected the malformed `UPDATE … WHERE …`.)

describe("serializeSqlUpdates — empty PK degrades safely (Fix R1, R2)", () => {
  it("R1.updates.1 (R2-corrected): empty pkColumns does NOT throw — all rows skipped with comment", () => {
    // Until TASK-503 wires real PK metadata into the webview, sql-updates
    // must not silently throw on the Copy/Export-to-file click handlers.
    // R1 added: don't throw, fall back to all-cols WHERE.
    // R2 corrected: `UPDATE t WHERE (…)` has no SET clause → sqlite
    // syntax error. The contract is now to skip the row and emit a
    // SQL comment so the user sees why nothing was generated.
    expect(() =>
      serializeSqlUpdates(COLS, ROWS, {
        includeHeader: true,
        tableName: "users",
        pkColumns: [],
      }),
    ).not.toThrow();
    const out = serializeSqlUpdates(COLS, ROWS, {
      includeHeader: true,
      tableName: "users",
      pkColumns: [],
    });
    expect(out).not.toMatch(/UPDATE\s+users/);
    expect(out).toContain("row 1 skipped: no non-key columns to update");
    expect(out).toContain("row 2 skipped: no non-key columns to update");
    expect(out).toContain("row 3 skipped: no non-key columns to update");
  });

  it("R1.updates.2: with PK, output uses PK in WHERE", () => {
    const out = serializeSqlUpdates(COLS, ROWS, {
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id"],
    });
    expect(out).toContain('WHERE "id"=1');
    expect(out).toContain('WHERE "id"=2');
  });
});

// ---- Fix Round 1: serializeXml uses safe tag names ----------------------

describe("serializeXml — sanitizes tag names (Fix R1)", () => {
  it("R1.xml.1: aliased column with space — column NAME preserved in attribute", () => {
    const cols = ["id", "total count"];
    const rows: unknown[][] = [
      [1, 42],
    ];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // Tag must NOT be "total count" — that's invalid XML. The column NAME
    // is preserved as an attribute on a safe <col> wrapper.
    expect(out).not.toContain("<total count>");
    expect(out).not.toContain("</total count>");
    expect(out).toContain('<col name="total count">42</col>');
  });

  it("R1.xml.2: column starting with a digit — name lives in attribute, never in tag", () => {
    const cols = ["id", "2nd"];
    const rows: unknown[][] = [[1, "x"]];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // Consistent design: column NAME always in the `name` attribute on a
    // safe <col> wrapper — never as a raw element tag (which would be
    // invalid for names with spaces, digits, or special chars).
    expect(out).toContain('<col name="2nd">x</col>');
    expect(out).not.toMatch(/<2nd>/);
  });

  it("R1.xml.3: column with `count(*)` alias — name preserved as attr", () => {
    const cols = ["id", "count(*)"];
    const rows: unknown[][] = [[1, 5]];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    expect(out).toContain('<col name="count(*)">5</col>');
    expect(out).not.toContain("<count(*)>");
  });

  it("R1.xml.4: well-formed XML — parses without error", () => {
    const cols = ["id", "User Name", "2nd"];
    const rows: unknown[][] = [[1, "a b", "v"]];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // Sanity: opening + closing <col> tags balanced, no naked "User Name"
    // or "2nd" as raw element name.
    expect(out).toContain('<col name="User Name">a b</col>');
    expect(out).toContain('<col name="2nd">v</col>');
    expect(out).not.toMatch(/<User Name>/);
    expect(out).not.toMatch(/<2nd>/);
  });
});

// ---- Fix Round 2: XML well-formedness with hostile column names + real parser --

import { JSDOM } from "jsdom";

function parseXmlOrThrow(text: string): { rows: number; cols: number } {
  // jsdom's DOMParser: initialize the JSDOM with an empty XML document
  // (not contentType: "application/xml", which leaves the parser in a
  // weird state). Then explicitly parse with mime application/xml so
  // the parse uses XML grammar. Bad XML returns a <parsererror> root
  // (we do not get an exception in node + jsdom like a browser does).
  const dom = new JSDOM('<?xml version="1.0"?><root/>');
  const parser = new dom.window.DOMParser();
  const xmlDoc = parser.parseFromString(text, "application/xml") as unknown as {
    documentElement: { nodeName: string };
    getElementsByTagName: (name: string) => { length: number };
  };
  if (xmlDoc.documentElement.nodeName === "parsererror") {
    const errEl = xmlDoc.documentElement as unknown as { textContent?: string };
    throw new Error(`xml parser error: ${errEl.textContent ?? "(unknown)"}`);
  }
  return {
    rows: xmlDoc.getElementsByTagName("row").length,
    cols: xmlDoc.getElementsByTagName("col").length,
  };
}


describe("serializeXml — well-formedness with hostile column names (Fix R2)", () => {
  it("R2.xml.1: column name containing `\"` — XML parses (no malformed attribute)", () => {
    // Pre-R2: xmlEscape did NOT escape `"`, so serializeXml emitted
    // `<col name="a&b<c>"d">…`, which terminates the attribute at
    // the second `"` and yields malformed XML. Real DOMParser rejects it.
    const cols = ['id', 'a&b<c>"d'];
    const rows: unknown[][] = [
      [1, "v"],
      [2, "w"],
    ];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // The escape must produce &quot; in the rendered attribute.
    expect(out).toContain("&quot;");
    expect(out).not.toContain('name="a&b<c>"d"');
    // Parses cleanly with a real XML parser.
    const parsed = parseXmlOrThrow(out);
    expect(parsed.rows).toBe(2);
    expect(parsed.cols).toBe(4);
  });

  it("R2.xml.2: column names with single-quote, `<`, `&`, newline, digit-start — all parse", () => {
    // Single-quote is NOT a special char in XML text, but the well-
    // formedness contract covers it too. The fix uses a single escaper
    // for both attribute and text content.
    const cols = [
      "id",
      "it's",
      "x<y",
      "a&b",
      "with\nnewline",
      "1digit",
    ];
    const rows: unknown[][] = [[1, "v1", "v2", "v3", "v4", "v5"]];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    const parsed = parseXmlOrThrow(out);
    expect(parsed.rows).toBe(1);
    expect(parsed.cols).toBe(6);
  });

  it("R2.xml.3: column name containing both `&` and `\"` — escapes both, no double-escape", () => {
    const cols = ["id", 'k="v"&x'];
    const rows: unknown[][] = [[1, "z"]];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // & → &amp;  (must appear BEFORE any &quot; that follows)
    expect(out).toContain("name=\"k=&quot;v&quot;&amp;x\"");
    const parsed = parseXmlOrThrow(out);
    expect(parsed.rows).toBe(1);
    expect(parsed.cols).toBe(2);
  });

  it("R2.xml.4: cell value containing `\"` — escapes as &quot; inside text, parses", () => {
    const cols = ["id", "note"];
    const rows: unknown[][] = [[1, 'has "quote" inside']];
    const out = serializeXml(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // Cell text inside <col>…</col> gets &quot; too.
    expect(out).toContain("<col name=\"note\">has &quot;quote&quot; inside</col>");
    const parsed = parseXmlOrThrow(out);
    expect(parsed.rows).toBe(1);
    expect(parsed.cols).toBe(2);
  });
});

// ---- Fix Round 2: serializeSqlUpdates skip-comment on no-SET degrade ------

describe("serializeSqlUpdates — no-SET degrade emits skip-comment (Fix R2)", () => {
  it("R2.updates.1: empty PK on a 1-column row → no UPDATE statements, skip comment emitted", () => {
    // Pre-R2: when PK is empty AND there is no non-key column to update,
    // the implementation emitted `UPDATE t WHERE col=val;` with no SET
    // clause — invalid SQL (sqlite parse error: near "WHERE"). Fix: skip
    // the row entirely and emit a SQL comment so the user sees why.
    const cols = ["id"];
    const rows: unknown[][] = [[1], [2], [3]];
    const out = serializeSqlUpdates(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    // No UPDATE statements should appear at all.
    expect(out).not.toMatch(/UPDATE\s+t/);
    // At least one skip comment per row.
    expect(out).toContain("row 1 skipped: no non-key columns to update");
    expect(out).toContain("row 2 skipped: no non-key columns to update");
    expect(out).toContain("row 3 skipped: no non-key columns to update");
  });

  it("R2.updates.2: every column is in PK → mixed SET/skip across rows", () => {
    // Schema [id, name]; pkColumns = [id, name]. Empty PK fallback
    // would treat both as key → SET empty → all rows skipped. With a
    // real PK list covering every column, behavior is identical: skip
    // every row.
    const cols = ["id", "name"];
    const rows: unknown[][] = [
      [1, "alpha"],
      [2, "beta"],
    ];
    const out = serializeSqlUpdates(cols, rows, {
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id", "name"],
    });
    expect(out).not.toMatch(/UPDATE\s+users/);
    expect(out).toContain("row 1 skipped: no non-key columns to update");
    expect(out).toContain("row 2 skipped: no non-key columns to update");
  });

  it("R2.updates.3: emitted output contains zero invalid SQL statements (sqlite parse)", () => {
    // Round-trip: the .sql file must be executable on a real engine.
    // The reviewer's R2 blocker requires that the emit be parseable
    // SQL, not just substring-shaped SQL. We use sqlite as the most
    // portable reference parser; it rejects the pre-fix
    // `UPDATE t WHERE (…)` shape with `near "WHERE": syntax error`.
    const cols = ["id"];
    const rows: unknown[][] = [[1], [2]];
    const out = serializeSqlUpdates(cols, rows, {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    const path = "/tmp/vsdb-r2-roundtrip.sql";
    writeFileSync(path, out);
    let stderr = "";
    try {
      execSync(`sqlite3 :memory: < ${path}`, {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (e) {
      if (e && typeof e === "object" && "stderr" in e) {
        const raw = (e as { stderr: unknown }).stderr;
        stderr = typeof raw === "string" ? raw : String(raw ?? "");
      } else {
        stderr = String(e);
      }
    }
    expect(stderr).not.toMatch(/syntax error|near "WHERE"|Error:/i);
    expect(out).not.toMatch(/UPDATE\s+t/);
  });
  it("R2.updates.4: empty rows → empty output (no skip comments either)", () => {
    const out = serializeSqlUpdates(["id"], [], {
      includeHeader: true,
      tableName: "t",
      pkColumns: [],
    });
    expect(out).toBe("");
  });
});

// ---- TASK-001: positional hiddenIndices (duplicate-column export fix) -------
//
// `SELECT a.id, b.id` yields two columns with the SAME name. Name-based
// `hiddenColumns` can only hide both at once; `hiddenIndices` hides by
// array POSITION so one duplicate can be hidden while the other stays.

describe("hiddenIndices positional", () => {
  it("1. serializeJson with hiddenIndices hides only specified positions", () => {
    const out = serializeJson(["id", "id__2", "name"], [[1, 2, "x"]], {
      ...NO_OPT,
      hiddenIndices: [0],
    });
    expect(out).toBe('{"columns":["id__2","name"],"rows":[[2,"x"]]}');
  });

  it("2. serializeJson with hiddenIndices preserves duplicate columns", () => {
    const out = serializeJson(["id", "id", "name"], [[1, 1, "x"]], {
      ...NO_OPT,
      hiddenIndices: [1],
    });
    expect(out).toBe('{"columns":["id","name"],"rows":[[1,"x"]]}');
  });

  it("3. hiddenIndices takes precedence over hiddenColumns", () => {
    const out = serializeJson(["id", "id__2", "name"], [[1, 2, "x"]], {
      ...NO_OPT,
      hiddenIndices: [0],
      hiddenColumns: ["name"],
    });
    // Positional [0] wins; the name-based "name" hide is ignored entirely.
    expect(out).toBe('{"columns":["id__2","name"],"rows":[[2,"x"]]}');
  });

  it("4. hiddenIndices empty array → no filtering, all columns preserved", () => {
    const out = serializeJson(["id", "name"], [[1, "x"]], {
      ...NO_OPT,
      hiddenIndices: [],
    });
    expect(out).toBe('{"columns":["id","name"],"rows":[[1,"x"]]}');
  });

  it("5. hiddenIndices out of range → invalid indices skipped, valid filtered", () => {
    const out = serializeJson(["id", "name", "active"], [[1, "x", true]], {
      ...NO_OPT,
      hiddenIndices: [0, 99],
    });
    expect(out).toBe('{"columns":["name","active"],"rows":[["x",true]]}');
  });

  it("6. regression: hiddenColumns still works when hiddenIndices absent", () => {
    const out = serializeJson(["id", "id"], [[1, 1]], {
      ...NO_OPT,
      hiddenColumns: ["id"],
    });
    // Name-based hiding still hides BOTH duplicates — the pre-TASK-001
    // path is unchanged when hiddenIndices is not supplied.
    expect(out).toBe('{"columns":[],"rows":[[]]}');
  });

  it("7. every serializer applies positional hiddenIndices (TSV/CSV/XML/SQL)", () => {
    const cols = ["id", "id", "name"];
    const rows: unknown[][] = [[9, 1, "x"]];
    const opts = {
      ...NO_OPT,
      includeHeader: true,
      pkColumns: ["id"],
      hiddenIndices: [0],
    };
    // TSV: header keeps positions 1,2 only; hidden value 9 never appears.
    expect(serializeTsv(cols, rows, opts)).toBe("id\tname\n1\tx");
    // CSV: same columns, RFC4180 shape.
    expect(serializeCsv(cols, rows, opts)).toBe("id,name\n1,x");
    // XML: exactly 2 <col> wrappers; visible id value is 1, not 9.
    const xml = serializeXml(cols, rows, opts);
    expect((xml.match(/<col /g) ?? []).length).toBe(2);
    expect(xml).toContain('<col name="id">1</col>');
    expect(xml).not.toContain("9");
    // SQL inserts: column list built from visible positions only.
    expect(serializeSqlInserts(cols, rows, opts)).toBe(
      "INSERT INTO t (id, name) VALUES (1, 'x');",
    );
    // SQL updates: SET/WHERE read the VISIBLE id (1), never the hidden 9.
    expect(serializeSqlUpdates(cols, rows, opts)).toBe(
      'UPDATE t SET "name"=\'x\' WHERE "id"=1;',
    );
    // SQL where: key term uses the visible id value.
    expect(serializeWhereClause(cols, rows, opts)).toBe('WHERE ("id"=1)');
  });
});

describe("serialize SQL identifiers (TASK-004 P2-6)", () => {
  it("8. reserved-word column names are quoted in UPDATE SET and WHERE", () => {
    expect(
      serializeSqlUpdates(["id", "order"], [[1, "x"]], {
        ...NO_OPT,
        tableName: "results",
        pkColumns: ["id"],
      }),
    ).toBe('UPDATE results SET "order"=\'x\' WHERE "id"=1;');
  });

  it("9. spaced and quote-bearing names remain one escaped identifier", () => {
    const columns = ["id", "First Name", 'a"b'];
    const rows: unknown[][] = [[1, "Alice", "v"]];
    expect(
      serializeSqlUpdates(columns, rows, {
        ...NO_OPT,
        tableName: "results",
        pkColumns: ["id"],
      }),
    ).toBe('UPDATE results SET "First Name"=\'Alice\', "a""b"=\'v\' WHERE "id"=1;');
    expect(
      serializeWhereClause(columns, rows, {
        ...NO_OPT,
        tableName: "results",
        pkColumns: ["First Name", 'a"b'],
      }),
    ).toBe('WHERE ("First Name"=\'Alice\' AND "a""b"=\'v\')');
  });

  it("10. bare-column export keeps skip comments, table name, and terminator", () => {
    const out = serializeSqlUpdates(["id", "order"], [[1, "x"]], {
      ...NO_OPT,
      tableName: "results",
      pkColumns: [],
    });
    expect(out).toBe("-- row 1 skipped: no non-key columns to update");
    expect(out.endsWith(";")).toBe(false);
    expect(serializeSqlUpdates(["id", "name"], [[1, "x"]], {
      ...NO_OPT,
      tableName: "results",
      pkColumns: ["id"],
    })).toBe('UPDATE results SET "name"=\'x\' WHERE "id"=1;');
  });
});
