// src/core/__tests__/ddlAlterTable.test.ts
// Unit tests for the pure ALTER TABLE diff engine — TASK-003 §Test Cases.
import { describe, it, expect } from "vitest";
import {
  diffTable,
  normalizeDefaultExpr,
  type AlterPlan,
} from "../ddl/alterTable";
import type { TableSpec, ColumnSpec, KeySpec } from "../ddl/createTable";

// ----------------------------- helpers -------------------------------------
function col(
  name: string,
  type: string,
  opts: Partial<ColumnSpec> = {},
): ColumnSpec {
  return {
    name,
    type,
    nullable: opts.nullable ?? true,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
    ...(opts.comment !== undefined ? { comment: opts.comment } : {}),
    ...(opts.originalName !== undefined ? { originalName: opts.originalName } : {}),
  };
}

function spec(
  name: string,
  schema: string,
  columns: ColumnSpec[],
  keys: KeySpec[] = [],
): TableSpec {
  return { name, schema, columns, keys };
}

// =============================== Tests =====================================
describe("TASK-003 #1 — rename + add + drop-key ordered", () => {
  it("emits EXACTLY rename→add→drop-constraint in that order", () => {
    const before: TableSpec = spec(
      "users",
      "public",
      [col("id", "bigint"), col("name", "varchar")],
      [
        { kind: "primaryKey", columns: ["id"], name: "users_pkey" } as KeySpec,
      ],
    );
    const after: TableSpec = {
      ...before,
      columns: [
        { ...col("user_id", "bigint"), originalName: "id" }, // renamed id→user_id
        col("name", "varchar"),
        col("email", "varchar"), // newly added
      ],
      keys: [],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME COLUMN "id" TO "user_id";',
      'ALTER TABLE "public"."users" ADD COLUMN "email" varchar;',
      'ALTER TABLE "public"."users" DROP CONSTRAINT "users_pkey";',
    ]);
  });
});

describe("TASK-003 #2 — type + default + nullability on paired column", () => {
  it("emits SET DATA TYPE → SET DEFAULT → SET NOT NULL in that order", () => {
    const before: TableSpec = spec("t", "public", [
      col("a", "int", { nullable: true }),
    ]);
    const after: TableSpec = {
      ...before,
      columns: [
        {
          ...col("a", "varchar(10)", { nullable: false, default: "'x'" }),
          originalName: "a",
        },
      ],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."t" ALTER COLUMN "a" SET DATA TYPE varchar(10);',
      `ALTER TABLE "public"."t" ALTER COLUMN "a" SET DEFAULT 'x';`,
      'ALTER TABLE "public"."t" ALTER COLUMN "a" SET NOT NULL;',
    ]);
  });
});

describe("TASK-003 #3 — default removed", () => {
  it("emits DROP DEFAULT when after.default is undefined", () => {
    const before: TableSpec = spec("t", "public", [
      col("a", "varchar", { default: "'x'" }),
    ]);
    const after: TableSpec = {
      ...before,
      columns: [{ ...col("a", "varchar"), originalName: "a" }],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."t" ALTER COLUMN "a" DROP DEFAULT;',
    ]);
  });
});

describe("TASK-003 #4 — table rename last", () => {
  it("emits exactly one ALTER TABLE … RENAME TO … statement", () => {
    const before: TableSpec = spec("users", "public", [col("id", "bigint")]);
    const after: TableSpec = { ...before, name: "clients" };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."users" RENAME TO "clients";',
    ]);
  });
});

describe("TASK-003 #5 — identical → empty plan", () => {
  it("returns {statements:[], errors:[]} when before === after structurally", () => {
    const before: TableSpec = spec(
      "users",
      "public",
      [col("id", "bigint"), col("name", "varchar")],
      [{ kind: "unique", name: "u_name", columns: ["name"] }],
    );
    const after: TableSpec = spec(
      "users",
      "public",
      [col("id", "bigint"), col("name", "varchar")],
      [{ kind: "unique", name: "u_name", columns: ["name"] }],
    );
    const plan = diffTable(before, after);
    expect(plan).toEqual({ statements: [], errors: [] } satisfies AlterPlan);
  });
});

describe("TASK-003 #5b — reorder-only → empty plan", () => {
  it("column reorder with originalName intact emits no statements", () => {
    const before: TableSpec = spec("t", "public", [
      col("a", "int"),
      col("b", "int"),
    ]);
    // after has same columns swapped, with originalName pointing back
    const after: TableSpec = {
      ...before,
      columns: [
        { ...col("b", "int"), originalName: "b" },
        { ...col("a", "int"), originalName: "a" },
      ],
    };
    const plan = diffTable(before, after);
    expect(plan).toEqual({ statements: [], errors: [] } satisfies AlterPlan);
  });
});

describe("TASK-003 #6 — rename + type diff never emits DROP+ADD", () => {
  it("a→b (originalName a) + int→bigint emits RENAME + SET DATA TYPE only", () => {
    const before: TableSpec = spec("t", "public", [col("a", "int")]);
    const after: TableSpec = {
      ...before,
      columns: [{ ...col("b", "bigint"), originalName: "a" }],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."t" RENAME COLUMN "a" TO "b";',
      'ALTER TABLE "public"."t" ALTER COLUMN "b" SET DATA TYPE bigint;',
    ]);
    // explicit no-DROP / no-ADD-COLUMN assertions
    expect(
      plan.statements.some((s) => s.includes("DROP COLUMN")),
    ).toBe(false);
    expect(
      plan.statements.some((s) => s.includes("ADD COLUMN")),
    ).toBe(false);
  });
});

// =============================== Fix-round-1 regressions ==================
describe("TASK-003 R1 — ADD COLUMN includes NOT NULL + DEFAULT (TASK-001 clause order)", () => {
  it("new column with NOT NULL + DEFAULT bare-literal → type, NOT NULL, DEFAULT 'literal' in that order", () => {
    const before: TableSpec = spec("t", "public", [col("id", "bigint")]);
    const after: TableSpec = {
      ...before,
      columns: [
        col("id", "bigint"),
        // newly-added column with NOT NULL + DEFAULT 'pending'
        {
          name: "status",
          type: "varchar",
          nullable: false,
          default: "pending",
        },
      ],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "public"."t" ADD COLUMN "status" varchar NOT NULL DEFAULT \'pending\';',
    ]);
  });

  it("new column with DEFAULT 'now()' (function-call) → DEFAULT emitted bare, single quoted form rejected", () => {
    const before: TableSpec = spec("t", "public", [col("id", "bigint")]);
    const after: TableSpec = {
      ...before,
      columns: [
        col("id", "bigint"),
        {
          name: "expired_at",
          type: "varchar",
          nullable: true,
          default: "now()",
        },
      ],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    const stmt = plan.statements[0];
    expect(stmt).toContain("DEFAULT now()");
    expect(stmt).not.toContain("DEFAULT 'now()'");
  });
});

describe("TASK-003 R1 — FK ADD CONSTRAINT references schema-qualification parity", () => {
  it("bare references.table + non-empty schema → 'schema'.'table'", () => {
    const before: TableSpec = spec("t", "public", [col("dept_id", "int")]);
    const after: TableSpec = {
      ...before,
      keys: [
        {
          kind: "foreignKey",
          name: "fk_x",
          columns: ["dept_id"],
          references: { table: "departments", columns: ["id"] },
        },
      ],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    const stmt = plan.statements.find((s) => s.includes("FOREIGN KEY"))!;
    expect(stmt).toContain('REFERENCES "public"."departments" ("id")');
  });

  it("already-qualified references.table 'hr.departments' → 'hr'.'departments' (no double prefix)", () => {
    const before: TableSpec = spec("t", "public", [col("dept_id", "int")]);
    const after: TableSpec = {
      ...before,
      keys: [
        {
          kind: "foreignKey",
          name: "fk_x",
          columns: ["dept_id"],
          references: { table: "hr.departments", columns: ["id"] },
        },
      ],
    };
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    const stmt = plan.statements.find((s) => s.includes("FOREIGN KEY"))!;
    expect(stmt).toContain('REFERENCES "hr"."departments" ("id")');
    expect(stmt).not.toContain('"public"."hr"');
  });
});

describe("TASK-003 #7 — invalid after blocks", () => {
  it("empty name + duplicate cols → errors contain both; statements empty", () => {
    const before: TableSpec = spec("t", "public", [col("x", "int")]);
    const after: TableSpec = {
      ...before,
      name: "",
      columns: [
        col("a", "int"),
        col("a", "int"), // duplicate
      ],
    };
    const plan = diffTable(before, after);
    expect(plan.statements).toEqual([]);
    expect(plan.errors.length).toBeGreaterThanOrEqual(2);
    const joined = plan.errors.join("\n").toLowerCase();
    expect(joined).toContain("table name");
    expect(joined).toContain("duplicate column");
  });
});

describe("TASK-003 #8 — schema change refused", () => {
  it('errors contain "Schema change is not supported"; statements empty', () => {
    const before: TableSpec = spec("users", "public", [col("id", "bigint")]);
    const after: TableSpec = { ...before, schema: "hr" };
    const plan = diffTable(before, after);
    expect(plan.statements).toEqual([]);
    expect(plan.errors).toContain("Schema change is not supported");
  });
});

describe("TASK-003 #9 — key identity unnamed", () => {
  it("named unique vs unnamed unique on same columns → no key statements", () => {
    const before: TableSpec = spec("t", "public", [col("code", "varchar")], [
      { kind: "unique", name: "u1", columns: ["code"] } as KeySpec,
    ]);
    const after: TableSpec = {
      ...before,
      keys: [{ kind: "unique", columns: ["code"] } as KeySpec],
    };
    // After also should not drop because identity (kind + columns.join) matches.
    const plan = diffTable(before, after);
    expect(plan.errors).toEqual([]);
    const keyStmts = plan.statements.filter(
      (s) => s.includes("ADD CONSTRAINT") || s.includes("DROP CONSTRAINT"),
    );
    expect(keyStmts).toEqual([]);
  });
});

describe("TASK-003 #10 — normalizeDefaultExpr", () => {
  it("(now()) === now()", () => {
    expect(normalizeDefaultExpr("(now())")).toBe(normalizeDefaultExpr("now()"));
  });
  it("'x' === ('x')", () => {
    expect(normalizeDefaultExpr("'x'")).toBe(normalizeDefaultExpr("('x')"));
  });
  it("a+b === a + b (whitespace-only difference)", () => {
    expect(normalizeDefaultExpr("a+b")).toBe(normalizeDefaultExpr("a + b"));
  });
  it("normalized pair → no SET DEFAULT in plan", () => {
    const before: TableSpec = spec("t", "public", [
      col("a", "int", { default: "(now())" }),
    ]);
    const after: TableSpec = {
      ...before,
      columns: [
        { ...col("a", "int", { default: "now()" }), originalName: "a" },
      ],
    };
    const plan = diffTable(before, after);
    expect(
      plan.statements.some(
        (s) =>
          s.includes("SET DEFAULT") || s.includes("DROP DEFAULT"),
      ),
    ).toBe(false);
  });
});
