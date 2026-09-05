// src/adapters/__tests__/ddl.integration.test.ts
// Integration tests cho DDL stack (TASK-006):
//   1. create + introspect round-trip
//   2. alter round-trip (rename / add / drop key / SET NOT NULL)
//   3. multi-statement single runQuery
//   4. regenerated CREATE executes
//   5. sample INSERTs count
//   6. duplicate create rejects
//
// Chỉ chạy khi UnicDB_IT=1; PG ở 127.0.0.1:5433 (UnicDB/UnicDB/UnicDB).
// Mỗi test tự tạo table `UnicDB_it_ddl_<seq>` unique, DROP qua dedicated
// one-off Client trong afterAll — bypass pool max=1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client, type Pool } from "pg";
import { PostgresAdapter } from "../postgres";
import {
  generateCreateTable,
  defaultColumnSpecs,
  type ColumnSpec,
  type KeySpec,
  type TableSpec,
} from "../../core/ddl/createTable";
import {
  INTROSPECT_COLUMNS_SQL,
  INTROSPECT_CONSTRAINTS_SQL,
  rowsToSpec,
  type PgColumnRow,
  type PgConstraintRow,
} from "../../core/ddl/pgIntrospect";
import { diffTable } from "../../core/ddl/alterTable";
import { generateSampleInserts } from "../../core/ddl/sampleData";

const IT = process.env.UnicDB_IT === "1";
const HOST = process.env.UnicDB_PG_HOST ?? "127.0.0.1";
const PORT = Number(process.env.UnicDB_PG_PORT ?? 5433);
const USER = process.env.UnicDB_PG_USER ?? "UnicDB";
const PASS = process.env.UnicDB_PG_PASS ?? "UnicDB";
const DB = process.env.UnicDB_PG_DB ?? "UnicDB";

// Stable but unique-per-run suffix to avoid cross-test collision when the
// suite is rerun against the same DB.
const RUN_SUFFIX = `${Date.now().toString(36)}_${Math.floor(
  Math.random() * 1e6,
).toString(36)}`;

function uniqTableName(prefix: string): string {
  return `UnicDB_it_ddl_${prefix}_${RUN_SUFFIX}`;
}

/** Unique constraint key-name suffix reused across tests for hand-named keys. */
function uniqKeyName(base: string): string {
  return `${base}_${RUN_SUFFIX}`;
}

// PostgresAdapter keeps `pool` and `cfg` private; expose typed aliases so
// the test can reach them without inline-cast member access.
type AdapterInternals = PostgresAdapter & {
  pool: Pool;
  cfg: { host: string; port: number; user: string; database: string };
};

/** Run SQL via runQuery. DDL/DML returns results[]; defensive drain for cursor. */
async function runSql(adapter: PostgresAdapter, sql: string): Promise<void> {
  const r = await adapter.runQuery(sql);
  if (r.results) return;
  if (r.batched) {
    await r.batched.fetchBatch();
    await r.batched.close();
  }
}

/** Drop a table via a DEDICATED one-off Client — bypasses pool max=1 so a
 *  cursor's held AccessShare lock on the same table can't block DROP. */
async function dropTable(
  adapter: PostgresAdapter,
  schema: string,
  name: string,
): Promise<void> {
  const cfg = (adapter as AdapterInternals).cfg;
  const dedicated = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: PASS,
    database: cfg.database,
  });
  await dedicated.connect();
  try {
    await dedicated.query(`DROP TABLE IF EXISTS "${schema}"."${name}" CASCADE`);
  } finally {
    await dedicated.end();
  }
}

/** Introspect via the SQL constants from pgIntrospect (executes through pool). */
async function introspect(
  adapter: PostgresAdapter,
  schema: string,
  table: string,
): Promise<TableSpec> {
  const pool = (adapter as AdapterInternals).pool;
  const colRes = await pool.query(INTROSPECT_COLUMNS_SQL(schema, table), [
    schema,
    table,
  ]);
  const conRes = await pool.query(INTROSPECT_CONSTRAINTS_SQL(schema, table), [
    schema,
    table,
  ]);
  const colRows = colRes.rows as PgColumnRow[];
  const conRows = conRes.rows as PgConstraintRow[];
  return rowsToSpec(schema, table, colRows, conRows);
}

/** Type-guard narrowing for foreignKey KeySpec — keeps FK access typed. */
function isForeignKey(
  k: KeySpec,
): k is KeySpec & {
  kind: "foreignKey";
  references: { table: string; columns: string[] };
} {
  return k.kind === "foreignKey";
}

describe.skipIf(!IT)("DDL — integration (PostgresAdapter)", () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = new PostgresAdapter(
      {
        id: "it-ddl",
        name: "pg-it-ddl",
        driver: "postgres",
        host: HOST,
        port: PORT,
        user: USER,
        database: DB,
      },
      PASS,
    );
    await adapter.connect();
  });

  afterAll(async () => {
    if (adapter) await adapter.close();
  });

  // -----------------------------------------------------------------------
  // Test #1 — create + introspect round-trip
  // -----------------------------------------------------------------------
  it("create + introspect round-trip preserves defaults/nullability/keys", async () => {
    const refTable = uniqTableName("ref");
    const mainTable = uniqTableName("c");

    try {
      // 1a. create referenced table first (FK + check reference it)
      const refSpec: TableSpec = {
        name: refTable,
        schema: "public",
        columns: [
          { name: "id_ref", type: "integer", nullable: false },
          { name: "active", type: "boolean", nullable: false, default: "true" },
        ],
        keys: [
          {
            kind: "primaryKey",
            columns: ["id_ref"],
            name: uniqKeyName("pk_ref"),
          },
        ],
      };
      await runSql(adapter, generateCreateTable(refSpec));

      // 1b. build main spec via defaultColumnSpecs + extra column + 4 key kinds
      const defaults = defaultColumnSpecs(mainTable); // id_<t>, created_at
      const cols: ColumnSpec[] = [
        ...defaults,
        { name: "ref_id", type: "integer", nullable: false },
        { name: "email", type: "varchar", nullable: false },
        { name: "score", type: "integer", nullable: true },
      ];
      const keys: KeySpec[] = [
        {
          kind: "primaryKey",
          columns: [defaults[0].name],
          name: uniqKeyName("pk_main"),
        },
        {
          kind: "unique",
          columns: ["email"],
          name: uniqKeyName("uq_main_email"),
        },
        {
          kind: "foreignKey",
          columns: ["ref_id"],
          name: uniqKeyName("fk_main_ref"),
          references: { table: refTable, columns: ["id_ref"] },
        },
        {
          kind: "check",
          name: uniqKeyName("ck_main_score"),
          expr: "score >= 0",
        },
      ];
      const spec: TableSpec = {
        name: mainTable,
        schema: "public",
        columns: cols,
        keys,
      };

      await runSql(adapter, generateCreateTable(spec));

      // 1c. introspect
      const got = await introspect(adapter, "public", mainTable);

      // column count/order
      expect(got.columns.map((c) => c.name)).toEqual([
        defaults[0].name,
        "created_at",
        "ref_id",
        "email",
        "score",
      ]);
      expect(got.columns).toHaveLength(5);

      // id_<t> default — pg_get_expr wraps in extra parens + uppercases;
      // match stable fragments case-insensitively.
      const idCol = got.columns[0];
      expect(idCol.default).toBeDefined();
      expect(idCol.default!.toLowerCase()).toContain("uuid_in");
      expect(idCol.default!.toLowerCase()).toContain("overlay(md5");

      // created_at default — pg_get_expr typecasts 'second'::text and wraps
      // in parens. Match stable fragments.
      const createdCol = got.columns[1];
      expect(createdCol.default).toBeDefined();
      const defaultText = createdCol.default!.toLowerCase();
      expect(defaultText).toContain("to_char");
      expect(defaultText).toContain("date_trunc");
      expect(defaultText).toContain("asia/ho_chi_minh");

      // nullability round-trips. PG enforces NOT NULL on PK columns
      // implicitly, so id_<t> (a PK member) reports is_nullable=NO even
      // when the spec did not set NOT NULL.
      expect(got.columns[0].nullable).toBe(false); // id_<t> is PK member
      expect(got.columns[1].nullable).toBe(true); // created_at (no NOT NULL)
      expect(got.columns[2].nullable).toBe(false); // ref_id NOT NULL
      expect(got.columns[3].nullable).toBe(false); // email NOT NULL
      expect(got.columns[4].nullable).toBe(true); // score nullable

      // PK member column carries isPrimaryKey flag
      expect(idCol.isPrimaryKey).toBe(true);

      // 4 key kinds present
      const pk = got.keys.find((k) => k.kind === "primaryKey");
      const uq = got.keys.find((k) => k.kind === "unique");
      const fk = got.keys.find((k) => k.kind === "foreignKey");
      const ck = got.keys.find((k) => k.kind === "check");
      expect(pk).toBeDefined();
      expect(uq).toBeDefined();
      expect(fk).toBeDefined();
      expect(ck).toBeDefined();
      expect(pk!.columns).toContain(defaults[0].name);
      expect(uq!.columns).toEqual(["email"]);
      expect(fk.columns).toEqual(["ref_id"]);
      expect(fk.references.table).toBe(refTable);
      // pg node-postgres returns text[] as a literal-string like '{id_ref}'
      // unless a custom type parser is installed; parse defensively.
      const fkRefCols = Array.isArray(fk.references.columns)
        ? fk.references.columns
        : (fk.references.columns as unknown as string)
            .slice(1, -1)
            .split(",");
      expect(fkRefCols).toEqual(["id_ref"]);
      expect(ck!.expr).toContain(">=");
    } finally {
      await dropTable(adapter, "public", mainTable);
      await dropTable(adapter, "public", refTable);
    }
  });

  // -----------------------------------------------------------------------
  // Test #2 — alter round-trip
  // -----------------------------------------------------------------------
  it("alter round-trip: rename/add/drop-unique/SET NOT NULL", async () => {
    const mainTable = uniqTableName("alt");
    const refTable = uniqTableName("alt_ref");

    try {
      const refSpec: TableSpec = {
        name: refTable,
        schema: "public",
        columns: [{ name: "id_ref", type: "integer", nullable: false }],
        keys: [
          {
            kind: "primaryKey",
            columns: ["id_ref"],
            name: uniqKeyName("pk_alt_ref"),
          },
        ],
      };
      await runSql(adapter, generateCreateTable(refSpec));

      const baseSpec: TableSpec = {
        name: mainTable,
        schema: "public",
        columns: [
          { name: "id_main", type: "uuid", nullable: false },
          { name: "old_name", type: "varchar", nullable: true },
          { name: "ref_id", type: "integer", nullable: true },
        ],
        keys: [
          {
            kind: "primaryKey",
            columns: ["id_main"],
            name: uniqKeyName("pk_alt"),
          },
          {
            kind: "unique",
            columns: ["old_name"],
            name: uniqKeyName("uq_alt_old"),
          },
          {
            kind: "foreignKey",
            columns: ["ref_id"],
            name: uniqKeyName("fk_alt_ref"),
            references: { table: refTable, columns: ["id_ref"] },
          },
        ],
      };
      await runSql(adapter, generateCreateTable(baseSpec));

      const before = await introspect(adapter, "public", mainTable);

      // Build edited spec: rename old_name → new_name, add `tag`, drop UNIQUE,
      // SET NOT NULL on ref_id.
      const after: TableSpec = {
        name: mainTable,
        schema: "public",
        columns: [
          ...before.columns
            .filter((c) => c.name === "id_main")
            .map((c) => ({ ...c })),
          {
            name: "new_name",
            type: "varchar",
            nullable: true,
            originalName: "old_name",
          },
          {
            name: "ref_id",
            type: "integer",
            nullable: false,
            originalName: "ref_id",
          },
          { name: "tag", type: "varchar", nullable: true },
        ],
        keys: [
          ...before.keys.filter((k) => k.kind === "primaryKey"),
          ...before.keys.filter((k) => k.kind === "foreignKey"),
        ],
      };

      const plan = diffTable(before, after);
      expect(plan.errors).toEqual([]);
      expect(plan.statements.length).toBeGreaterThan(0);
      await runSql(adapter, plan.statements.join("\n"));

      const got = await introspect(adapter, "public", mainTable);

      // renamed column present with NEW name, old absent
      expect(got.columns.map((c) => c.name)).toContain("new_name");
      expect(got.columns.map((c) => c.name)).not.toContain("old_name");

      // added column present with type
      const tagCol = got.columns.find((c) => c.name === "tag");
      expect(tagCol).toBeDefined();
      expect(tagCol!.type).toMatch(/^(character varying|varchar)$/i);

      // unique key gone
      expect(got.keys.filter((k) => k.kind === "unique")).toHaveLength(0);

      // ref_id nullable = false
      const refCol = got.columns.find((c) => c.name === "ref_id");
      expect(refCol!.nullable).toBe(false);

      // PK + FK retained
      expect(got.keys.some((k) => k.kind === "primaryKey")).toBe(true);
      expect(got.keys.some((k) => k.kind === "foreignKey")).toBe(true);
    } finally {
      await dropTable(adapter, "public", mainTable);
      await dropTable(adapter, "public", refTable);
    }
  });

  // -----------------------------------------------------------------------
  // Test #3 — multi-statement single runQuery
  // -----------------------------------------------------------------------
  it("multi-statement single runQuery resolves (CREATE + ALTER in one call)", async () => {
    const t = uniqTableName("multi");

    try {
      const sql =
        `CREATE TABLE "${t}" ("id" integer NOT NULL, "note" varchar);\n` +
        `ALTER TABLE "${t}" ADD COLUMN "extra" integer;\n`;
      await runSql(adapter, sql);

      const got = await introspect(adapter, "public", t);
      expect(got.columns.map((c) => c.name)).toEqual(["id", "note", "extra"]);
      expect(got.columns.find((c) => c.name === "id")!.nullable).toBe(false);
      expect(got.columns.find((c) => c.name === "extra")!.type).toMatch(
        /^integer$/i,
      );
    } finally {
      await dropTable(adapter, "public", t);
    }
  });

  // -----------------------------------------------------------------------
  // Test #4 — regenerated CREATE executes
  // -----------------------------------------------------------------------
  it("regenerated CREATE executes on a fresh table name (Copy CREATE DDL guard)", async () => {
    const srcTable = uniqTableName("regen_src");
    const dstTable = uniqTableName("regen_dst");

    try {
      const baseSpec: TableSpec = {
        name: srcTable,
        schema: "public",
        columns: [
          { name: "id_src", type: "uuid", nullable: false },
          { name: "label", type: "varchar", nullable: true },
        ],
        keys: [
          {
            kind: "primaryKey",
            columns: ["id_src"],
            name: uniqKeyName("pk_regen_src"),
          },
        ],
      };
      await runSql(adapter, generateCreateTable(baseSpec));
      const introspected = await introspect(adapter, "public", srcTable);
      // product path: rowsToSpec → generateCreateTable verbatim. The
      // createTable renderer now dedupes PK rendering (R1 fix — when a
      // primaryKey KeySpec is present, the inline `isPrimaryKey` does NOT
      // also render `PRIMARY KEY`), so this no longer emits the
      // double-PK bug. We still re-key PK + unique under the destination
      // table because constraint names are schema-scoped and the
      // introspected names contain the source-table suffix.
      const renamedKeys: KeySpec[] = introspected.keys.map((k) => {
        switch (k.kind) {
          case "primaryKey":
            return {
              kind: "primaryKey",
              columns: k.columns,
              name: `pk_${dstTable}`.slice(0, 63),
            };
          case "unique":
            return {
              kind: "unique",
              columns: k.columns,
              name: `uq_${dstTable}_${k.columns.join("_")}`.slice(0, 63),
            };
          default:
            return k;
        }
      });
      const regenSpec: TableSpec = {
        ...introspected,
        name: dstTable,
        keys: renamedKeys,
      };
      const sql = generateCreateTable(regenSpec);

      await runSql(adapter, sql);

      const dst = await introspect(adapter, "public", dstTable);
      expect(dst.columns.map((c) => c.name)).toEqual(["id_src", "label"]);
      expect(dst.keys.some((k) => k.kind === "primaryKey")).toBe(true);
    } finally {
      await dropTable(adapter, "public", srcTable);
      await dropTable(adapter, "public", dstTable);
    }
  });

  // -----------------------------------------------------------------------
  // Test #5 — sample INSERTs executable
  // -----------------------------------------------------------------------
  it("generateSampleInserts(spec, 5) inserts 5 rows (SELECT count(*) === 5)", async () => {
    const t = uniqTableName("sample");

    try {
      const spec: TableSpec = {
        name: t,
        schema: "public",
        columns: [
          { name: "id", type: "varchar", nullable: false },
          { name: "name", type: "varchar", nullable: true },
          { name: "qty", type: "integer", nullable: true },
        ],
        keys: [
          {
            kind: "primaryKey",
            columns: ["id"],
            name: uniqKeyName("pk_sample"),
          },
        ],
      };
      await runSql(adapter, generateCreateTable(spec));

      const inserts = generateSampleInserts(spec, 5);
      await runSql(adapter, inserts);

      const r = await adapter.runQuery(
        `SELECT count(*)::int AS n FROM "${t}"`,
      );
      if (!r.batched) throw new Error("expected cursor path for SELECT");
      const rows = await r.batched.fetchBatch();
      // cancel() destroys the cursor client so the BEGIN tx releases any
      // AccessShare lock before DROP TABLE on pool max=1 (PG 55006).
      await r.batched.cancel();
      expect(rows).not.toBeNull();
      expect(rows![0][0]).toBe(5);
    } finally {
      await dropTable(adapter, "public", t);
    }
  });

  // -----------------------------------------------------------------------
  // Test #6 — duplicate create rejects
  // -----------------------------------------------------------------------
  it("duplicate CREATE rejects with 'already exists'", async () => {
    const t = uniqTableName("dup");

    try {
      const spec: TableSpec = {
        name: t,
        schema: "public",
        columns: [{ name: "x", type: "integer", nullable: false }],
        keys: [],
      };
      await runSql(adapter, generateCreateTable(spec));

      let err: unknown = null;
      try {
        await runSql(adapter, generateCreateTable(spec));
      } catch (e) {
        err = e;
      }
      const msg = err instanceof Error ? err.message : String(err ?? "");
      expect(msg.toLowerCase()).toContain("already exists");
    } finally {
      await dropTable(adapter, "public", t);
    }
  });
});
