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
  it("3. well-formed XML, `&<>` escaped", () => {
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
    expect(out).toContain("<id>1</id>");
    expect(out).toContain("<msg>a&amp;b&lt;c&gt;d</msg>");
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
    expect(out).toBe(
      "INSERT INTO users (id, name, active) VALUES (1, 'alpha', TRUE);\n" +
        "INSERT INTO users (id, name, active) VALUES (2, 'beta, \"q\"', FALSE);\n" +
        "INSERT INTO users (id, name, active) VALUES (3, 'line\\nbreak', NULL);",
    );
  });

  it("6. multirow INSERT — 1 INSERT nhiều tuple groups", () => {
    const out = serializeSqlInserts(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      multirow: true,
    });
    expect(out).toBe(
      "INSERT INTO users (id, name, active) VALUES " +
        "(1, 'alpha', TRUE), (2, 'beta, \"q\"', FALSE), (3, 'line\\nbreak', NULL);",
    );
  });
});

// ---- 7. serializeSqlUpdates -------------------------------------------------
describe("serializeSqlUpdates", () => {
  it("7. UPDATE — `SET ...` theo non-PK cols, `WHERE` theo PK", () => {
    const out = serializeSqlUpdates(COLS, ROWS, {
      ...NO_OPT,
      includeHeader: true,
      tableName: "users",
      pkColumns: ["id"],
    });
    expect(out).toBe(
      "UPDATE users SET name='alpha', active=TRUE WHERE id=1;\n" +
        "UPDATE users SET name='beta, \"q\"', active=FALSE WHERE id=2;\n" +
        "UPDATE users SET name='line\\nbreak', active=NULL WHERE id=3;",
    );
  });

  it("7b. UPDATE with no PK columns → throws (caller must supply PK)", () => {
    expect(() =>
      serializeSqlUpdates(COLS, ROWS, {
        ...NO_OPT,
        includeHeader: true,
        tableName: "users",
        pkColumns: [],
      }),
    ).toThrow(/pk/i);
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
    expect(out).toBe("WHERE (id=1 AND name='alpha') OR (id=3 AND name='line\\nbreak')");
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
