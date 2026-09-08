// src/ui/__tests__/requeryClauseNormalize.test.ts
//
// TASK-RES-002 — pure-logic tests for `stripLeadingClauseKeyword`
// (src/ui/queryComposer.ts).
//
// The helper is the host-side boundary that defends the P0 input contract:
// WHERE box = boolean expression body (no leading `WHERE`), ORDER BY box =
// ORDER BY body (no leading `ORDER BY`). When the user types
// `WHERE id > 5` or `ORDER BY id DESC` into the requery boxes, the host
// strips exactly that ONE leading keyword before composing / parsing
// instead of producing `… WHERE WHERE id>5` or a confusing
// "Invalid ORDER BY" rejection.
//
// Strip happens ONCE (non-recursive), case-insensitively, and ONLY when
// the keyword is followed by a whitespace boundary (or IS the entire
// trimmed string). The helper is exported from `queryComposer.ts` for the
// boundary call sites in `resultsPanel.ts:1850-1851`; `parseOrderBy` and
// `composeRequery` themselves stay UNTOUCHED.
//
// No DOM, no vscode — plain vitest node environment. Mirrors the style of
// `resultsGridModelRequery.test.ts`.
import { describe, it, expect } from "vitest";
import {
  stripLeadingClauseKeyword,
  parseOrderBy,
  buildOrderByClause,
} from "../queryComposer";
import { composeRequery } from "../resultsGridModel";

// =============================================================================
// Test #1 — happy: WHERE keyword stripped
// =============================================================================
describe("stripLeadingClauseKeyword — WHERE happy path", () => {
  it("Test #1 — 'WHERE id > 5' strips the leading WHERE keyword", () => {
    expect(stripLeadingClauseKeyword("WHERE id > 5", "WHERE")).toBe("id > 5");
  });
});

// =============================================================================
// Test #2 — happy: ORDER BY keyword stripped, parses via real parseOrderBy
// =============================================================================
describe("stripLeadingClauseKeyword — ORDER BY happy path with parseOrderBy", () => {
  it("Test #2 — 'ORDER BY id DESC' strips to 'id DESC' and parses to one DESC term on postgres", () => {
    const stripped = stripLeadingClauseKeyword("ORDER BY id DESC", "ORDER BY");
    expect(stripped).toBe("id DESC");
    const parsed = parseOrderBy(stripped, "postgresql");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.terms).toHaveLength(1);
      expect(parsed.terms[0]).toMatchObject({ column: "id", direction: "DESC" });
    }
  });

  it("Test #2b — post-strip fragment composes through buildOrderByClause on all dialects", () => {
    const stripped = stripLeadingClauseKeyword("ORDER BY id ASC", "ORDER BY");
    expect(stripped).toBe("id ASC");
    for (const dialect of ["postgres", "mysql", "mssql"] as const) {
      const parsed = parseOrderBy(stripped, dialect);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const clause = buildOrderByClause(parsed.terms, dialect);
      expect(clause).toContain("id");
      expect(clause).toMatch(/ASC/);
    }
  });
});

// =============================================================================
// Test #4 — edge: keyword without whitespace boundary is NOT stripped
// =============================================================================
describe("stripLeadingClauseKeyword — boundary cases (no whitespace after keyword)", () => {
  it("Test #4a — 'WHEREx' is returned unchanged (no strip)", () => {
    expect(stripLeadingClauseKeyword("WHEREx", "WHERE")).toBe("WHEREx");
  });

  it("Test #4b — 'ORDER BYid' is returned unchanged (no whitespace after the BY)", () => {
    expect(stripLeadingClauseKeyword("ORDER BYid", "ORDER BY")).toBe("ORDER BYid");
  });

  it("Test #4c — 'WHEREBY x' is returned unchanged (no boundary)", () => {
    // Boundary check: a longer-prefix token that merely starts with the
    // keyword chars must not be stripped — the helper requires whitespace
    // (or end-of-string) after the keyword.
    expect(stripLeadingClauseKeyword("WHEREBY x", "WHERE")).toBe("WHEREBY x");
  });
});

// =============================================================================
// Test #5 — edge: empty / bare keyword
// =============================================================================
describe("stripLeadingClauseKeyword — empty and bare keyword", () => {
  it("Test #5a — 'WHERE' alone strips to ''", () => {
    expect(stripLeadingClauseKeyword("WHERE", "WHERE")).toBe("");
  });

  it("Test #5b — 'ORDER BY' alone strips to ''", () => {
    expect(stripLeadingClauseKeyword("ORDER BY", "ORDER BY")).toBe("");
  });

  it("Test #5c — '' returns ''", () => {
    expect(stripLeadingClauseKeyword("", "WHERE")).toBe("");
  });

  it("Test #5d — whitespace-only input returns ''", () => {
    expect(stripLeadingClauseKeyword("   \t  ", "WHERE")).toBe("");
    expect(stripLeadingClauseKeyword("\n  ", "ORDER BY")).toBe("");
  });

  it("Test #5e — bare keyword with surrounding whitespace strips to ''", () => {
    expect(stripLeadingClauseKeyword("  WHERE  ", "WHERE")).toBe("");
    expect(stripLeadingClauseKeyword("\tORDER BY\n", "ORDER BY")).toBe("");
  });

  it("Test #5f — composeRequery after empty strip returns the original SQL (no `;` corruption)", () => {
    // Belt-and-braces: the documented composeRequery behavior for empty
    // fragments is to return the original statement with a trailing `;`
    // stripped. After the strip, the requery lane behaves like a no-op
    // requery.
    const sql = "SELECT 1;";
    expect(composeRequery(sql, "", "")).toBe("SELECT 1");
  });
});

// =============================================================================
// Test #6 — edge: case-insensitive strip
// =============================================================================
describe("stripLeadingClauseKeyword — case-insensitive strip", () => {
  it("Test #6a — 'where a=1' strips (lowercase keyword)", () => {
    expect(stripLeadingClauseKeyword("where a=1", "WHERE")).toBe("a=1");
  });

  it("Test #6b — 'Where a=1' strips (capitalised keyword)", () => {
    expect(stripLeadingClauseKeyword("Where a=1", "WHERE")).toBe("a=1");
  });

  it("Test #6c — 'WHERE a=1' strips (uppercase keyword — canonical)", () => {
    expect(stripLeadingClauseKeyword("WHERE a=1", "WHERE")).toBe("a=1");
  });

  it("Test #6d — 'order by id' strips (ORDER BY case-insensitive)", () => {
    expect(stripLeadingClauseKeyword("order by id", "ORDER BY")).toBe("id");
  });

  it("Test #6e — 'Order By id DESC' strips (mixed-case ORDER BY)", () => {
    expect(stripLeadingClauseKeyword("Order By id DESC", "ORDER BY")).toBe(
      "id DESC",
    );
  });

  it("Test #6f — leading whitespace + case-mixed keyword still strips", () => {
    expect(stripLeadingClauseKeyword("  wHeRe a>1", "WHERE")).toBe("a>1");
  });
});

// =============================================================================
// Test #7 — edge: exactly ONE strip (non-recursive)
// =============================================================================
describe("stripLeadingClauseKeyword — exactly ONE strip (non-recursive)", () => {
  it("Test #7a — 'WHERE WHERE x=1' strips the FIRST WHERE only", () => {
    expect(stripLeadingClauseKeyword("WHERE WHERE x=1", "WHERE")).toBe(
      "WHERE x=1",
    );
  });

  it("Test #7b — 'ORDER BY ORDER BY id' strips the FIRST ORDER BY only", () => {
    expect(stripLeadingClauseKeyword("ORDER BY ORDER BY id", "ORDER BY")).toBe(
      "ORDER BY id",
    );
  });

  it("Test #7c — a triple-stacked WHERE still leaves exactly TWO copies", () => {
    expect(stripLeadingClauseKeyword("WHERE WHERE WHERE x=1", "WHERE")).toBe(
      "WHERE WHERE x=1",
    );
  });
});

// =============================================================================
// Test #8 — regression: keyword-free fragments byte-identical
// =============================================================================
describe("stripLeadingClauseKeyword — keyword-free fragments byte-identical (regression)", () => {
  it("Test #8a — keyword-free fragment is returned unchanged (only outer trim applied)", () => {
    expect(stripLeadingClauseKeyword("id > 5", "WHERE")).toBe("id > 5");
  });

  it("Test #8b — keyword-free fragment for ORDER BY is returned unchanged", () => {
    expect(stripLeadingClauseKeyword("id DESC", "ORDER BY")).toBe("id DESC");
  });

  it("Test #8c — already-trimmed keyword-free fragment passes through verbatim", () => {
    expect(stripLeadingClauseKeyword("name = 'x'", "WHERE")).toBe("name = 'x'");
  });

  it("Test #8d — keyword-free fragment with leading/trailing whitespace is trimmed (no other change)", () => {
    expect(stripLeadingClauseKeyword("  id > 5  ", "WHERE")).toBe("id > 5");
    expect(stripLeadingClauseKeyword("\nid DESC\n", "ORDER BY")).toBe("id DESC");
  });
});

// =============================================================================
// Test — additional property: parses after strip equals parse of pre-strip
// (for inputs that parse cleanly without the keyword)
// =============================================================================
describe("stripLeadingClauseKeyword — post-strip fragment is parser-acceptable", () => {
  it("'WHERE id > 5' after strip parses to the same where as raw 'id > 5'", () => {
    // parseOrderBy does not handle WHERE; this just asserts the strip does
    // not corrupt the body. We re-add the WHERE in composeRequery below.
    const stripped = stripLeadingClauseKeyword("WHERE id > 5", "WHERE");
    expect(stripped).toBe("id > 5");
    // Compose through the same lane the host uses — no double WHERE.
    expect(composeRequery("SELECT * FROM t", stripped, "")).toBe(
      "SELECT * FROM (SELECT * FROM t) UnicDB_sub WHERE id > 5",
    );
    // And critically the assembled SQL contains exactly ONE "WHERE " — the
    // double-strip regression guard from the task brief.
    const composed = composeRequery("SELECT * FROM t", stripped, "");
    const whereMatches = composed.match(/WHERE /g);
    expect(whereMatches).not.toBeNull();
    expect(whereMatches!.length).toBe(1);
  });
});