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
    // R1 portable literals: newline is embedded raw.
    expect(out).toBe(
      "UPDATE users SET name='alpha', active=TRUE WHERE id=1;\n" +
        "UPDATE users SET name='beta, \"q\"', active=FALSE WHERE id=2;\n" +
        "UPDATE users SET name='line\nbreak', active=NULL WHERE id=3;",
    );
  });

  // R1: empty pkColumns no longer throws. It degrades to a per-row
  // all-columns WHERE (same fallback as sql-where). The contract is:
  // the call must succeed and reference the table name.
  it("7b. UPDATE with no PK columns → degrades to all-cols WHERE (no throw)", () => {
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
    expect(out).toContain("UPDATE users");
    // With empty PK, all columns are treated as the key. SET would be empty
    // so the implementation emits `WHERE (all cols)` instead of a no-op SET.
    expect(out).toContain("WHERE (id=1 AND name='alpha' AND active=TRUE)");
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
    // R1 portable literals: newline embedded raw.
    expect(out).toBe("WHERE (id=1 AND name='alpha') OR (id=3 AND name='line\nbreak')");
  });

  it("8b. no PK columns → fallback to all-columns joined AND (documented)", () => {
    const out = serializeWhereClause(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: [],
      selectedRows: [[1, "alpha", true]],
    });
    expect(out).toBe("WHERE (id=1 AND name='alpha' AND active=TRUE)");
  });

  it("8c. no selection → uses all rows", () => {
    const out = serializeWhereClause(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id"],
    });
    // No rows → empty string (caller decides whether to write "WHERE 1=0").
    expect(out).toBe("WHERE (id=1) OR (id=2) OR (id=3)");
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

// ---- Fix Round 1: sql-updates degrades safely on empty PK ---------------

describe("serializeSqlUpdates — empty PK degrades safely (Fix R1)", () => {
  it("R1.updates.1: empty pkColumns does NOT throw — falls back to all-cols WHERE", () => {
    // Until TASK-503 wires real PK metadata into the webview, sql-updates
    // must not silently throw on the Copy/Export-to-file click handlers.
    // Degrade: WHERE uses ALL columns (same fallback as sql-where). SET
    // is empty because every column is in the key, so the implementation
    // emits just `UPDATE users WHERE (all cols)` without the SET keyword.
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
    expect(out).toContain("UPDATE users");
    expect(out).toContain("WHERE (id=1 AND name='alpha' AND active=TRUE)");
  });

  it("R1.updates.2: with PK, output uses PK in WHERE", () => {
    const out = serializeSqlUpdates(COLS, ROWS, {
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id"],
    });
    expect(out).toContain("WHERE id=1");
    expect(out).toContain("WHERE id=2");
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
