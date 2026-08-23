import { describe, it, expect } from "vitest";
import {
  INTROSPECT_COLUMNS_SQL,
  INTROSPECT_CONSTRAINTS_SQL,
  rowsToSpec,
  type PgColumnRow,
  type PgConstraintRow,
} from "../ddl/pgIntrospect";
import type { ColumnSpec,
KeySpec } from "../ddl/createTable";

// Helper: typed narrowing of unknown test extras
type ColumnWithExtras = ColumnSpec & { isPrimaryKey?: boolean };

// Helper: extract a specific key kind
function findKey<K extends KeySpec["kind"]>(
  keys: KeySpec[],
  kind: K,
): Extract<KeySpec, { kind: K }> {
  const k = keys.find((x) => x.kind === kind);
  if (!k) throw new Error(`expected key kind ${kind}`);
  return k as Extract<KeySpec, { kind: K }>;
}

describe("INTROSPECT_COLUMNS_SQL", () => {
  it("contains $1 and $2 parameters", () => {
    const sql = INTROSPECT_COLUMNS_SQL("public", "users");
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
  });

  it("does NOT interpolate unsanitized schema/table into SQL", () => {
    const sql = INTROSPECT_COLUMNS_SQL("a;b", "t");
    expect(sql.includes("a;b")).toBe(false);
  });
});

describe("INTROSPECT_CONSTRAINTS_SQL", () => {
  it("contains $1 and $2 parameters", () => {
    const sql = INTROSPECT_CONSTRAINTS_SQL("public", "users");
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
  });

  it("does NOT interpolate unsanitized schema/table into SQL", () => {
    const sql = INTROSPECT_CONSTRAINTS_SQL("a;b", "t");
    expect(sql.includes("a;b")).toBe(false);
  });
});

describe("rowsToSpec", () => {
  const colRows: PgColumnRow[] = [
    {
      column_name: "id",
      format_type: "bigint",
      is_nullable: "NO",
      column_default: "nextval('users_id_seq'::regclass)",
    },
    {
      column_name: "name",
      format_type: "character varying",
      is_nullable: "YES",
      column_default: null,
    },
    {
      column_name: "age",
      format_type: "integer",
      is_nullable: "YES",
      column_default: null,
    },
    {
      column_name: "dept_id",
      format_type: "integer",
      is_nullable: "YES",
      column_default: null,
    },
  ];

  const conRows: PgConstraintRow[] = [
    {
      conname: "users_pkey",
      contype: "p",
      conkey: [1],
      confrelidname: null,
      confkeycols: null,
      consrc: "PRIMARY KEY (id)",
    },
    {
      conname: "uq_users_name",
      contype: "u",
      conkey: [2],
      confrelidname: null,
      confkeycols: null,
      consrc: "UNIQUE (name)",
    },
    {
      conname: "fk_users_dept",
      contype: "f",
      conkey: [4],
      confrelidname: "hr.departments",
      confkeycols: ["id"],
      consrc: "FOREIGN KEY (dept_id) REFERENCES hr.departments(id)",
    },
    {
      conname: "users_age_check",
      contype: "c",
      conkey: [],
      confrelidname: null,
      confkeycols: null,
      consrc: "CHECK ((age > 0))",
    },
  ];

  it("full round-trip: 4 key kinds + columns", () => {
    const spec = rowsToSpec("public", "users", colRows, conRows);
    expect(spec.name).toBe("users");
    expect(spec.schema).toBe("public");
    expect(spec.columns).toHaveLength(4);

    // Column[0] = id (PK)
    const idCol = spec.columns[0] as ColumnWithExtras;
    expect(idCol.name).toBe("id");
    expect(idCol.type).toBe("bigint");
    expect(idCol.nullable).toBe(false);
    expect(idCol.default).toBe("nextval('users_id_seq'::regclass)");
    expect(idCol.originalName).toBe("id");
    expect(idCol.isPrimaryKey).toBe(true);

    // Column[1] = name
    const nameCol = spec.columns[1];
    expect(nameCol.name).toBe("name");
    expect(nameCol.type).toBe("character varying");
    expect(nameCol.nullable).toBe(true);
    expect("default" in nameCol).toBe(false);
    expect(nameCol.originalName).toBe("name");

    // keys
    expect(spec.keys).toHaveLength(4);

    const pk = findKey(spec.keys, "primaryKey");
    expect(pk.columns).toEqual(["id"]);
    expect(pk.name).toBe("users_pkey");

    const uq = findKey(spec.keys, "unique");
    expect(uq.columns).toEqual(["name"]);
    expect(uq.name).toBe("uq_users_name");

    const fk = findKey(spec.keys, "foreignKey");
    expect(fk.name).toBe("fk_users_dept");
    expect(fk.columns).toEqual(["dept_id"]);
    expect(fk.references.table).toBe("departments");
    expect(fk.references.columns).toEqual(["id"]);

    const ck = findKey(spec.keys, "check");
    expect(ck.name).toBe("users_age_check");
    expect(ck.expr).toBe("age > 0");
  });

  it("check normalization: strips leading 'CHECK ' and ONE outer paren layer only when wrapping whole expr", () => {
    const r1 = rowsToSpec(
      "public",
      "users",
      [
        {
          column_name: "name",
          format_type: "varchar",
          is_nullable: "YES",
          column_default: null,
        },
      ],
      [
        {
          conname: "ck1",
          contype: "c",
          conkey: [],
          confrelidname: null,
          confkeycols: null,
          consrc: "CHECK ((length(name) > 0))",
        },
      ],
    );
    const ck1 = findKey(r1.keys, "check");
    expect(ck1.expr).toBe("length(name) > 0");

    const r2 = rowsToSpec(
      "public",
      "users",
      [
        {
          column_name: "a",
          format_type: "int",
          is_nullable: "YES",
          column_default: null,
        },
        {
          column_name: "b",
          format_type: "int",
          is_nullable: "YES",
          column_default: null,
        },
      ],
      [
        {
          conname: "ck2",
          contype: "c",
          conkey: [],
          confrelidname: null,
          confkeycols: null,
          consrc: "CHECK ((a > 0) AND (b < 9))",
        },
      ],
    );
    const ck2 = findKey(r2.keys, "check");
    expect(ck2.expr).toBe("(a > 0) AND (b < 9)");
  });

  it("null default → no default key on column", () => {
    const spec = rowsToSpec(
      "public",
      "users",
      [
        {
          column_name: "name",
          format_type: "varchar",
          is_nullable: "YES",
          column_default: null,
        },
      ],
      [],
    );
    expect("default" in spec.columns[0]).toBe(false);
  });

  it("conkey ordering: key columns follow attnum order, NOT sorted", () => {
    const cols: PgColumnRow[] = [
      {
        column_name: "col_a",
        format_type: "int",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "col_b",
        format_type: "int",
        is_nullable: "NO",
        column_default: null,
      },
    ];
    const cons: PgConstraintRow[] = [
      {
        conname: "pk_test",
        contype: "p",
        conkey: [2, 1],
        confrelidname: null,
        confkeycols: null,
        consrc: "PRIMARY KEY (col_b, col_a)",
      },
    ];
    const spec = rowsToSpec("public", "test", cols, cons);
    const pk = findKey(spec.keys, "primaryKey");
    expect(pk.columns).toEqual(["col_b", "col_a"]);
  });

  it("FK schema prefix stripped: hr.departments → departments", () => {
    const cols: PgColumnRow[] = [
      {
        column_name: "dept_id",
        format_type: "int",
        is_nullable: "YES",
        column_default: null,
      },
    ];
    const cons: PgConstraintRow[] = [
      {
        conname: "fk_test",
        contype: "f",
        conkey: [1],
        confrelidname: "hr.departments",
        confkeycols: ["id"],
        consrc: "FOREIGN KEY (dept_id) REFERENCES hr.departments(id)",
      },
    ];
    const spec = rowsToSpec("public", "test", cols, cons);
    const fk = findKey(spec.keys, "foreignKey");
    expect(fk.references.table).toBe("departments");
    expect(fk.references.columns).toEqual(["id"]);
  });

  it("empty constraints → keys:[]", () => {
    const spec = rowsToSpec(
      "public",
      "users",
      [
        {
          column_name: "name",
          format_type: "varchar",
          is_nullable: "YES",
          column_default: null,
        },
      ],
      [],
    );
    expect(spec.keys).toEqual([]);
    expect(spec.columns).toHaveLength(1);
  });

  it("empty columns and constraints → {columns:[],keys:[]}", () => {
    const spec = rowsToSpec("public", "ghost", [], []);
    expect(spec.columns).toEqual([]);
    expect(spec.keys).toEqual([]);
    expect(spec.name).toBe("ghost");
    expect(spec.schema).toBe("public");
  });

  it("unknown contype skipped silently", () => {
    const cols: PgColumnRow[] = [
      {
        column_name: "x",
        format_type: "int",
        is_nullable: "YES",
        column_default: null,
      },
    ];
    // contype "x" is not one of "p"|"u"|"f"|"c"; tests must use a cast because
    // the type forbids it — use a structural row instead.
    const weirdRow = {
      conname: "weird",
      contype: "x",
      conkey: [] as number[],
      confrelidname: null as string | null,
      confkeycols: null as string[] | null,
      consrc: "??",
    } satisfies Omit<PgConstraintRow, "contype"> & { contype: string };
    const spec = rowsToSpec(
      "public",
      "t",
      cols,
      [weirdRow as unknown as PgConstraintRow],
    );
    expect(spec.keys).toEqual([]);
  });

  it("PK member columns carry isPrimaryKey:true", () => {
    const cols: PgColumnRow[] = [
      {
        column_name: "a",
        format_type: "int",
        is_nullable: "NO",
        column_default: null,
      },
      {
        column_name: "b",
        format_type: "int",
        is_nullable: "NO",
        column_default: null,
      },
    ];
    const cons: PgConstraintRow[] = [
      {
        conname: "pk_t",
        contype: "p",
        conkey: [1, 2],
        confrelidname: null,
        confkeycols: null,
        consrc: "PRIMARY KEY (a, b)",
      },
    ];
    const spec = rowsToSpec("public", "t", cols, cons);
    const a = spec.columns[0] as ColumnWithExtras;
    const b = spec.columns[1] as ColumnWithExtras;
    expect(a.isPrimaryKey).toBe(true);
    expect(b.isPrimaryKey).toBe(true);
  });
});