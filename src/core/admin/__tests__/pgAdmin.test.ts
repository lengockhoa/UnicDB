import { describe, it, expect } from "vitest";
import {
  listRolesSql,
  listRoleGrantsSql,
  listSessionsSql,
  listLockWaitsSql,
  buildGrantSql,
  buildRevokeSql,
  validateRoleName,
  AdminError,
  NAMEDATALEN_MINUS_ONE,
} from "../pgAdmin";

describe("pgAdmin - SQL templates (parameterized)", () => {
  it("listRolesSql returns sql+$1 params and excludes pg_* roles by default", () => {
    const r = listRolesSql();
    expect(r.sql).toContain("$1");
    expect(r.params).toEqual(["^pg_"]);
    expect(r.sql).not.toMatch(/;\s*$/);
    expect(r.sql.toLowerCase()).toMatch(/rolname/);
  });

  it("listRolesSql with includeSystemRoles=true emits no $1 and no filter", () => {
    const r = listRolesSql({ includeSystemRoles: true });
    expect(r.sql).not.toContain("$1");
    expect(r.sql).not.toContain("^pg_");
    expect(r.params).toEqual([]);
  });

  it("listRoleGrantsSql(role) uses $1 parameter so embedded quotes flow as parameter", () => {
    const sql = listRoleGrantsSql('ro"le');
    expect(sql).toContain("$1");
    expect(sql).not.toContain('ro"le');
  });

  it("listRoleGrantsSql uses $1 parameter and does NOT inline role names", () => {
    const sql = listRoleGrantsSql("alice");
    expect(sql).toContain("$1");
    expect(sql).not.toContain(" alice ");
  });

  it("listSessionsSql truncates query to 500 chars and includes LIMIT", () => {
    const sql = listSessionsSql({ limit: 200 });
    expect(sql).toContain("LIMIT 200");
    expect(sql.toUpperCase()).toMatch(/LEFT\(.*\)|SUBSTRING\(.*\)/);
    expect(sql.toLowerCase()).toContain("pg_stat_activity");
  });

  it("listSessionsSql default limit is 200", () => {
    const sql = listSessionsSql();
    expect(sql).toContain("LIMIT 200");
  });

  it("listLockWaitsSql uses pg_blocking_pids() and LIMIT", () => {
    const sql = listLockWaitsSql();
    expect(sql.toLowerCase()).toContain("pg_blocking_pids(");
    expect(sql.toLowerCase()).toContain("pg_locks");
    expect(sql).toContain("LIMIT 200");
  });
});

describe("pgAdmin - buildGrantSql", () => {
  it("builds a properly quoted GRANT for a table", () => {
    const sql = buildGrantSql({
      grantee: "bob",
      privileges: ["SELECT", "INSERT"],
      on: { kind: "table", schema: "public", table: "t" },
    });
    expect(sql).toBe('GRANT SELECT, INSERT ON TABLE "public"."t" TO "bob"');
  });

  it("builds a GRANT for a sequence", () => {
    const sql = buildGrantSql({
      grantee: "app",
      privileges: ["USAGE", "SELECT"],
      on: { kind: "sequence", schema: "public", sequence: "users_id_seq" },
    });
    expect(sql).toBe('GRANT USAGE, SELECT ON SEQUENCE "public"."users_id_seq" TO "app"');
  });

  it("builds a GRANT for a schema", () => {
    const sql = buildGrantSql({
      grantee: "app",
      privileges: ["USAGE"],
      on: { kind: "schema", schema: "public" },
    });
    expect(sql).toBe('GRANT USAGE ON SCHEMA "public" TO "app"');
  });

  it("rejects grant to PUBLIC unless allowGrantPublic=true", () => {
    expect(() =>
      buildGrantSql(
        {
          grantee: "PUBLIC",
          privileges: ["SELECT"],
          on: { kind: "table", schema: "public", table: "t" },
        },
        { allowGrantPublic: false },
      ),
    ).toThrow(AdminError);
    try {
      buildGrantSql(
        {
          grantee: "PUBLIC",
          privileges: ["SELECT"],
          on: { kind: "table", schema: "public", table: "t" },
        },
        { allowGrantPublic: false },
      );
    } catch (e) {
      expect((e as AdminError).code).toBe("granteePublicForbidden");
    }
    const sql = buildGrantSql(
      {
        grantee: "PUBLIC",
        privileges: ["SELECT"],
        on: { kind: "table", schema: "public", table: "t" },
      },
      { allowGrantPublic: true },
    );
    expect(sql).toBe('GRANT SELECT ON TABLE "public"."t" TO "PUBLIC"');
  });

  it("rejects empty grantee", () => {
    expect(() =>
      buildGrantSql({
        grantee: "  ",
        privileges: ["SELECT"],
        on: { kind: "table", schema: "public", table: "t" },
      }),
    ).toThrow(AdminError);
    try {
      buildGrantSql({
        grantee: "",
        privileges: ["SELECT"],
        on: { kind: "table", schema: "public", table: "t" },
      });
    } catch (e) {
      expect((e as AdminError).code).toBe("emptyGrantee");
    }
  });

  it("rejects empty privileges", () => {
    expect(() =>
      buildGrantSql({
        grantee: "bob",
        privileges: [],
        on: { kind: "table", schema: "public", table: "t" },
      }),
    ).toThrow(AdminError);
    try {
      buildGrantSql({
        grantee: "bob",
        privileges: [],
        on: { kind: "table", schema: "public", table: "t" },
      });
    } catch (e) {
      expect((e as AdminError).code).toBe("emptyPrivileges");
    }
  });

  it("rejects unknown kind", () => {
    expect(() =>
      buildGrantSql({
        grantee: "bob",
        privileges: ["SELECT"],
        // @ts-expect-error: runtime check on unknown kind
        on: { kind: "view", schema: "public", table: "v" },
      }),
    ).toThrow(AdminError);
    try {
      buildGrantSql({
        grantee: "bob",
        privileges: ["SELECT"],
        // @ts-expect-error: runtime check on unknown kind
        on: { kind: "view", schema: "public", table: "v" },
      });
    } catch (e) {
      expect((e as AdminError).code).toBe("unknownKind");
    }
  });

  it("wraps every identifier in double-quotes", () => {
    const sql = buildGrantSql({
      grantee: "bob",
      privileges: ["SELECT"],
      on: { kind: "table", schema: "public", table: "t" },
    });
    expect(sql).toBe('GRANT SELECT ON TABLE "public"."t" TO "bob"');
  });
});

describe("pgAdmin - buildRevokeSql", () => {
  it("mirrors grant shape", () => {
    const sql = buildRevokeSql({
      grantee: "bob",
      privileges: ["SELECT"],
      on: { kind: "table", schema: "public", table: "t" },
    });
    expect(sql).toBe('REVOKE SELECT ON TABLE "public"."t" FROM "bob"');
  });

  it("appends CASCADE when cascade=true", () => {
    const sql = buildRevokeSql(
      {
        grantee: "bob",
        privileges: ["SELECT"],
        on: { kind: "table", schema: "public", table: "t" },
      },
      { cascade: true },
    );
    expect(sql.endsWith("CASCADE")).toBe(true);
    expect(sql).toBe('REVOKE SELECT ON TABLE "public"."t" FROM "bob" CASCADE');
  });

  it("does NOT append CASCADE when omitted", () => {
    const sql = buildRevokeSql({
      grantee: "bob",
      privileges: ["SELECT"],
      on: { kind: "table", schema: "public", table: "t" },
    });
    expect(sql.endsWith("CASCADE")).toBe(false);
  });
});

describe("pgAdmin - validateRoleName", () => {
  it("accepts a valid identifier and exports NAMEDATALEN_MINUS_ONE=63", () => {
    expect(() => validateRoleName("app_read_only")).not.toThrow();
    expect(() => validateRoleName("a")).not.toThrow();
    expect(() => validateRoleName("role_123")).not.toThrow();
    expect(NAMEDATALEN_MINUS_ONE).toBe(63);
  });

  it("accepts exactly 63-char names", () => {
    const name = "a".repeat(63);
    expect(() => validateRoleName(name)).not.toThrow();
  });

  it("rejects empty / whitespace-only names", () => {
    expect(() => validateRoleName("")).toThrow(AdminError);
    expect(() => validateRoleName("   ")).toThrow(AdminError);
    try {
      validateRoleName("");
    } catch (e) {
      expect((e as AdminError).code).toBe("invalidIdentifier");
    }
  });

  it("rejects embedded NUL", () => {
    expect(() => validateRoleName("ab\u0000cd")).toThrow(AdminError);
    try {
      validateRoleName("ab\u0000cd");
    } catch (e) {
      expect((e as AdminError).code).toBe("invalidIdentifier");
    }
  });

  it("rejects embedded quote", () => {
    expect(() => validateRoleName('ro"le')).toThrow(AdminError);
    try {
      validateRoleName('ro"le');
    } catch (e) {
      expect((e as AdminError).code).toBe("invalidIdentifier");
    }
  });

  it("rejects names longer than NAMEDATALEN_MINUS_ONE (64+)", () => {
    const name = "a".repeat(64);
    expect(() => validateRoleName(name)).toThrow(AdminError);
    try {
      validateRoleName(name);
    } catch (e) {
      expect((e as AdminError).code).toBe("nameTooLong");
    }
  });
});
