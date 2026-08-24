import { describe, it, expect } from "vitest";
import {
  buildTableStructure,
  buildViewStructure,
  quoteIdentIfNeeded,
} from "../exportStructure";

describe("exportStructure — pure builder", () => {
  it("1. basic table: columns, NOT NULL, PK constraint", () => {
    const ddl = buildTableStructure("public", "users", [
      { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
      { name: "name", dataType: "character varying(100)", nullable: false },
      { name: "created_at", dataType: "timestamp with time zone", nullable: true },
    ]);
    expect(ddl).toBe(
      [
        "CREATE TABLE public.users (",
        "    id integer NOT NULL,",
        "    name character varying(100) NOT NULL,",
        "    created_at timestamp with time zone,",
        "    CONSTRAINT pk_users PRIMARY KEY (id)",
        ");",
      ].join("\n"),
    );
  });

  it("2. no PK → no CONSTRAINT line; all nullable → no NOT NULL", () => {
    const ddl = buildTableStructure("public", "log", [
      { name: "msg", dataType: "text", nullable: true },
    ]);
    expect(ddl).toBe(
      ["CREATE TABLE public.log (", "    msg text", ");"].join("\n"),
    );
  });

  it("3. compound PK → comma-joined inside constraint", () => {
    const ddl = buildTableStructure("s", "t", [
      { name: "a", dataType: "int", nullable: false, isPrimaryKey: true },
      { name: "b", dataType: "int", nullable: false, isPrimaryKey: true },
    ]);
    expect(ddl).toContain("PRIMARY KEY (a, b)");
  });

  it("4. mixed-case / keyword column names → quoted identifiers", () => {
    const ddl = buildTableStructure("public", "Order", [
      { name: "UserId", dataType: "int", nullable: false },
      { name: "select", dataType: "text", nullable: true },
    ]);
    expect(ddl).toContain('"Order"');
    expect(ddl).toContain('"UserId"');
    expect(ddl).toContain('"select"');
  });

  it("5. quoteIdentIfNeeded: plain lowercase stays bare, else double-quoted", () => {
    expect(quoteIdentIfNeeded("user_id")).toBe("user_id");
    expect(quoteIdentIfNeeded("Order")).toBe('"Order"');
    expect(quoteIdentIfNeeded('we"ird')).toBe('"we""ird"');
  });

  it("6. empty schema/table name rejected by caller guard — builder tolerates empty columns", () => {
    const ddl = buildTableStructure("public", "empty", []);
    expect(ddl).toBe(["CREATE TABLE public.empty (", "", ");"].join("\n"));
  });

  it("7. view structure: header + column list + viewdef note", () => {
    const txt = buildViewStructure("public", "v_users", [
      { name: "id", dataType: "integer", nullable: false },
    ]);
    expect(txt).toContain("-- View structure: public.v_users");
    expect(txt).toContain("-- Output columns (1):");
    expect(txt).toContain("    id integer");
    expect(txt).toContain("pg_get_viewdef");
  });
});
