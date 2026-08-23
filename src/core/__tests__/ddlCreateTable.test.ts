// src/core/__tests__/ddlCreateTable.test.ts
// TASK-001 — Pure CREATE TABLE generator (TableSpec → executable SQL).
import { describe, it, expect } from "vitest";
import {
  quoteIdent,
  UUID_DEFAULT_EXPR,
  CREATED_AT_DEFAULT_EXPR,
  defaultColumnSpecs,
  generateCreateTable,
  specErrors,
} from "../ddl/createTable";

describe("TASK-001 — CREATE TABLE generator", () => {
  it("1. mandatory defaults produce the exact canonical SQL", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: defaultColumnSpecs("users"),
      keys: [],
    });
    const expected =
      'CREATE TABLE "public"."users" (\n' +
      '    "id_users" varchar DEFAULT uuid_in(overlay(overlay(md5(random()::text || \':\' || random()::text) placing \'4\' from 13) placing to_hex(floor(random() * (11 - 8 + 1) + 8)::int)::text from 17)::cstring),\n' +
      '    "created_at" varchar DEFAULT TO_CHAR(date_trunc(\'second\', now() AT TIME ZONE \'Asia/Ho_Chi_Minh\'), \'YYYY-MM-DD HH24:MI:SS\')::character varying\n' +
      ");\n";
    expect(sql).toBe(expected);
  });

  it("2. defaultColumnSpecs id tracks the table name", () => {
    expect(defaultColumnSpecs("orders")[0].name).toBe("id_orders");
  });

  it("3. named constraints render with CONSTRAINT / FOREIGN KEY / CHECK", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: [
        { name: "id", type: "bigint", isPrimaryKey: true },
        { name: "code", type: "varchar" },
        { name: "dept_id", type: "bigint" },
        { name: "age", type: "int" },
      ],
      keys: [
        { kind: "unique", name: "uq_users_code", columns: ["code"] },
        {
          kind: "foreignKey",
          name: "dept_id",
          columns: ["dept_id"],
          references: { table: "hr.departments", columns: ["id"] },
        },
        { kind: "check", name: "users_age_check", expr: "age >= 0" },
      ],
    });
    expect(sql).toContain('CONSTRAINT "uq_users_code" UNIQUE ("code")');
    expect(sql).toContain(
      'FOREIGN KEY ("dept_id") REFERENCES "hr"."departments" ("id")',
    );
    expect(sql).toContain('CONSTRAINT "users_age_check" CHECK (age >= 0)');
  });

  it("4. inline PRIMARY KEY renders on the column, no table PK", () => {
    const sql = generateCreateTable({
      name: "t",
      schema: "public",
      columns: [{ name: "id", type: "bigint", isPrimaryKey: true }],
      keys: [],
    });
    expect(sql).toContain('"id" bigint PRIMARY KEY');
    // No table-level PRIMARY KEY (line) anywhere
    expect(sql).not.toMatch(/PRIMARY KEY \(/);
  });

  it("5. quoteIdent: reserved words / mixed case / leading digit / empty", () => {
    expect(quoteIdent("order")).toBe('"order"');
    expect(quoteIdent("MyCol")).toBe('"MyCol"');
    expect(quoteIdent("col_1")).toBe("col_1");
    expect(quoteIdent("")).toBe('""');
    expect(quoteIdent("1a")).toBe('"1a"');
  });

  it("6. specErrors lists all detected errors", () => {
    const errors = specErrors({
      name: "  ",
      schema: "public",
      columns: [
        { name: "a", type: "" },
        { name: "a", type: "int" },
      ],
      keys: [{ kind: "primaryKey", columns: ["zz"] }],
    });
    expect(errors).toEqual([
      "Table name is required",
      "Column type is required: a",
      "Duplicate column name: a",
      "Key references unknown column: zz",
    ]);
    expect(errors.length).toBe(4);
  });

  it("7. specErrors returns [] for a valid spec (fixture #1)", () => {
    expect(
      specErrors({
        name: "users",
        schema: "public",
        columns: defaultColumnSpecs("users"),
        keys: [],
      }),
    ).toEqual([]);
  });

  it("8. ifNotExists + empty schema render accordingly", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "",
      ifNotExists: true,
      columns: [{ name: "id", type: "bigint" }],
      keys: [],
    });
    expect(sql.startsWith("CREATE TABLE IF NOT EXISTS \"users\" (")).toBe(true);
  });

  it("9. auto-generated unique constraint name is ≤63 chars", () => {
    const colA = "alpha_beta_gamma_delta_epsilon_zeta_eta";
    const colB = "theta_iota_kappa_lambda_mu_nu_xi_omicro";
    const colC = "pi_rho_sigma_tau_upsilon_phi_chi_psi_ome";
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: [
        { name: "id", type: "bigint" },
        { name: colA, type: "varchar" },
        { name: colB, type: "varchar" },
        { name: colC, type: "varchar" },
      ],
      keys: [{ kind: "unique", columns: [colA, colB, colC] }],
    });
    // Extract the unique constraint name and verify ≤63 chars
    const m = sql.match(/CONSTRAINT "([^"]+)" UNIQUE/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeLessThanOrEqual(63);
  });

  // ---- Regression tests for fix round 1 review findings ----

  it("PK dedupe: isPrimaryKey + primaryKey KeySpec → exactly ONE PRIMARY KEY clause (executable)", () => {
    // RowsToSpec sets BOTH isPrimaryKey on the id column AND a primaryKey
    // KeySpec (TASK-002). Re-emitting must collapse to a single PK clause —
    // either inline OR table-level — never both. Per Round-1 reviewer the
    // KeySpec wins (table-level CONSTRAINT … PRIMARY KEY).
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: [
        { name: "id", type: "bigint", isPrimaryKey: true, nullable: false },
        { name: "code", type: "varchar", nullable: true },
      ],
      keys: [
        { kind: "primaryKey", columns: ["id"], name: "users_pkey" },
      ],
    });
    // Inline PRIMARY KEY absent (KeySpec wins).
    expect(sql).not.toMatch(/\"id\" bigint PRIMARY KEY/);
    // Exactly one PRIMARY KEY in the SQL (table-level).
    const pkMatches = sql.match(/PRIMARY KEY/g) ?? [];
    expect(pkMatches.length).toBe(1);
    // Executability check: the whole statement parses as CREATE TABLE with
    // the canonical fixture shape (no duplicate PK).
    expect(sql).toContain('CONSTRAINT "users_pkey" PRIMARY KEY ("id")');
    expect(sql.startsWith('CREATE TABLE "public"."users" (')).toBe(true);
  });

  it("default quoting: bare identifier 'pending' → DEFAULT 'pending'", () => {
    const sql = generateCreateTable({
      name: "orders",
      schema: "public",
      columns: [
        {
          name: "status",
          type: "varchar",
          default: "pending",
          nullable: true,
        },
      ],
      keys: [],
    });
    expect(sql).toContain("DEFAULT 'pending'");
  });

  it("default quoting: function call 'now()' passes through bare", () => {
    const sql = generateCreateTable({
      name: "orders",
      schema: "public",
      columns: [
        { name: "expired_at", type: "varchar", default: "now()", nullable: true },
      ],
      keys: [],
    });
    expect(sql).toContain("DEFAULT now()");
    // No spurious quoting.
    expect(sql).not.toContain("DEFAULT 'now()'");
  });

  it("default quoting: boolean literal 'true' passes through bare (PG accepted)", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: [
        { name: "active", type: "boolean", default: "true", nullable: false },
      ],
      keys: [],
    });
    expect(sql).toContain("DEFAULT true");
    expect(sql).not.toContain("DEFAULT 'true'");
  });

  it("default quoting: pre-quoted literal stays as written", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: [
        {
          name: "status",
          type: "varchar",
          default: "'pending'",
          nullable: true,
        },
      ],
      keys: [],
    });
    expect(sql).toContain("DEFAULT 'pending'");
  });

  it("default quoting: numeric literal 42 → DEFAULT '42'", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: [
        { name: "qty", type: "integer", default: "42", nullable: true },
      ],
      keys: [],
    });
    expect(sql).toContain("DEFAULT '42'");
  });

  it("default quoting: uuid_in(...) expression passes through bare", () => {
    const sql = generateCreateTable({
      name: "users",
      schema: "public",
      columns: defaultColumnSpecs("users"),
      keys: [],
    });
    expect(sql).toContain("DEFAULT uuid_in(overlay(overlay(md5(");
  });
});