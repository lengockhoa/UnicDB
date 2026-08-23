// src/core/__tests__/sampleData.test.ts
// TASK-005 — Pure generator for INSERT … VALUES sample rows.
// Spec: src/core/ddl/sampleData.ts
import { describe, it, expect } from "vitest";
import { generateSampleInserts } from "../ddl/sampleData";
import type { ColumnSpec, TableSpec } from "../ddl/createTable";

function col(name: string, type: string, overrides: Partial<ColumnSpec> = {}): ColumnSpec {
  return { name, type, ...overrides };
}

function spec(name: string, schema: string, columns: ColumnSpec[]): TableSpec {
  return { name, schema, columns, keys: [] };
}

describe("generateSampleInserts — multi-row INSERT", () => {
  it("#1 n=3 (id integer, name varchar) → exact canonical SQL", () => {
    const s = spec("t", "public", [
      col("id", "integer"),
      col("name", "varchar"),
    ]);
    const sql = generateSampleInserts(s, 3);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("id","name") VALUES\n' +
        " (1, 'row-1 c1'),\n" +
        " (2, 'row-2 c1'),\n" +
        " (3, 'row-3 c1');\n",
    );
  });
});

describe("generateSampleInserts — type variety", () => {
  it("#2 (flag boolean, amt numeric, d date, u uuid) n=2 → exact canonical SQL", () => {
    const s = spec("t", "public", [
      col("flag", "boolean"),
      col("amt", "numeric"),
      col("d", "date"),
      col("u", "uuid"),
    ]);
    const sql = generateSampleInserts(s, 2);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("flag","amt","d","u") VALUES\n' +
        " (true, 1.5, '2026-01-01', '00000000-0000-0000-4000-000000000001'),\n" +
        " (false, 2.5, '2026-01-02', '00000000-0000-0000-4000-000000000002');\n",
    );
  });
});

describe("generateSampleInserts — boundaries", () => {
  it("#3 n=0 → ''", () => {
    const s = spec("t", "public", [col("id", "integer")]);
    expect(generateSampleInserts(s, 0)).toBe("");
  });

  it("#3b n=-5 → ''", () => {
    const s = spec("t", "public", [col("id", "integer")]);
    expect(generateSampleInserts(s, -5)).toBe("");
  });

  it("#4 n=1000 → 1000 value rows, no throw", () => {
    const s = spec("t", "public", [col("id", "integer")]);
    const sql = generateSampleInserts(s, 1000);
    // First row + 998 rows separated by ",\n" + final row → 1000 lines starting with " ("
    const rowLines = sql.split("\n").filter((l) => l.startsWith(" ("));
    expect(rowLines).toHaveLength(1000);
    // Spot check last row's id = 1000
    expect(rowLines[999]).toBe(" (1000);");
  });
});

describe("generateSampleInserts — type-prefix dispatch", () => {
  it("int/serial/bigint/smallint → per-column counter 1..n", () => {
    const s = spec("t", "public", [
      col("a", "integer"),
      col("b", "serial"),
      col("c", "bigint"),
      col("d", "smallint"),
    ]);
    const sql = generateSampleInserts(s, 2);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("a","b","c","d") VALUES\n' +
        " (1, 1, 1, 1),\n" +
        " (2, 2, 2, 2);\n",
    );
  });

  it("numeric/decimal/money → '(i+1).5'", () => {
    const s = spec("t", "public", [
      col("a", "numeric"),
      col("b", "decimal(10,2)"),
      col("c", "money"),
    ]);
    const sql = generateSampleInserts(s, 2);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("a","b","c") VALUES\n' +
        " (1.5, 1.5, 1.5),\n" +
        " (2.5, 2.5, 2.5);\n",
    );
  });

  it("float/double/real → '(i+1).25'", () => {
    const s = spec("t", "public", [
      col("a", "float"),
      col("b", "double precision"),
      col("c", "real"),
    ]);
    const sql = generateSampleInserts(s, 1);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("a","b","c") VALUES\n' +
        " (1.25, 1.25, 1.25);\n",
    );
  });

  it("varchar/char/text → 'row-<i+1> c<j>'", () => {
    const s = spec("t", "public", [
      col("a", "varchar(50)"),
      col("b", "char(3)"),
      col("c", "text"),
    ]);
    const sql = generateSampleInserts(s, 1);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("a","b","c") VALUES\n' +
        " ('row-1 c1', 'row-1 c2', 'row-1 c3');\n",
    );
  });

  it("boolean → alternating true/false", () => {
    const s = spec("t", "public", [col("flag", "boolean")]);
    const sql = generateSampleInserts(s, 4);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("flag") VALUES\n' +
        " (true),\n" +
        " (false),\n" +
        " (true),\n" +
        " (false);\n",
    );
  });

  it("date → '2026-01-<dd>' zero-pad 2, dd=(i%28)+1", () => {
    const s = spec("t", "public", [col("d", "date")]);
    const sql = generateSampleInserts(s, 3);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("d") VALUES\n' +
        " ('2026-01-01'),\n" +
        " ('2026-01-02'),\n" +
        " ('2026-01-03');\n",
    );
  });

  it("timestamp / timestamp with time zone → '2026-01-<dd> 10:00:00'", () => {
    const s = spec("t", "public", [
      col("a", "timestamp"),
      col("b", "timestamptz"),
      col("c", "timestamp with time zone"),
    ]);
    const sql = generateSampleInserts(s, 2);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("a","b","c") VALUES\n' +
        " ('2026-01-01 10:00:00', '2026-01-01 10:00:00', '2026-01-01 10:00:00'),\n" +
        " ('2026-01-02 10:00:00', '2026-01-02 10:00:00', '2026-01-02 10:00:00');\n",
    );
  });

  it("uuid → '00000000-0000-0000-4000-0000000000<zero-pad(i+1,3)>'", () => {
    const s = spec("t", "public", [col("u", "uuid")]);
    const sql = generateSampleInserts(s, 1);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("u") VALUES\n' +
        " ('00000000-0000-0000-4000-000000000001');\n",
    );
  });

  it("json/jsonb → '{}'", () => {
    const s = spec("t", "public", [col("j", "jsonb"), col("k", "json")]);
    const sql = generateSampleInserts(s, 1);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("j","k") VALUES\n' +
        " ('{}', '{}');\n",
    );
  });

  it("default (unknown type) → 'v<j>-<i+1>'", () => {
    const s = spec("t", "public", [
      col("a", "bytea"),
      col("b", "inet"),
    ]);
    const sql = generateSampleInserts(s, 2);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("a","b") VALUES\n' +
        " ('v1-1', 'v2-1'),\n" +
        " ('v1-2', 'v2-2');\n",
    );
  });

  it("column order follows spec order, keys ignored", () => {
    const s: TableSpec = {
      name: "t",
      schema: "public",
      columns: [col("z", "integer"), col("a", "integer")],
      keys: [
        {
          kind: "primaryKey",
          columns: ["z"],
          name: "t_pkey",
        },
      ],
    };
    const sql = generateSampleInserts(s, 1);
    expect(sql).toBe(
      'INSERT INTO "public"."t" ("z","a") VALUES\n' +
        " (1, 1);\n",
    );
  });
});
