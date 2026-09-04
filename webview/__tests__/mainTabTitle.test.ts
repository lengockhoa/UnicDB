// webview/__tests__/mainTabTitle.test.ts
// TASK-UX2-002 — tabTitle / tabBadge pure helpers (extracted from webview/main.ts).
// Tests are pure unit tests against the extracted module — no jsdom needed.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { tabTitle, tabBadge } from "../tabTitle";

/** Minimal shape that the helper accepts. The webview's full
 *  `StatementResult` is a superset — the helper only reads these fields. */
type MinimalResult = {
  sql?: string;
  label?: string;
  status?: "running" | "done" | "error" | "cancelled";
  error?: string;
  runNo?: number;
  runStmtNo?: number;
};

const minimal = (overrides: MinimalResult): MinimalResult => ({
  status: "done",
  ...overrides,
});

describe("TASK-UX2-002 tabTitle", () => {
  it("unit: shows first 30 chars of SQL for a failed run with non-empty sql", () => {
    const sql = "CREATE TABLE public.customers (id int)";
    const got = tabTitle(minimal({ runNo: 1, sql, error: "syntax error" }), 0);
    // First 30 chars of `sql` — "CREATE TABLE public.customers" is exactly
    // 30 chars, but the source SQL has a space at position 30, so the
    // slice includes the trailing space.
    expect(got).toBe("Run 1 · CREATE TABLE public.customers ");
  });

  it("unit: shows r.label when host preset it (per-table browse)", () => {
    const got = tabTitle(minimal({ runNo: 2, label: "public.users" }), 1);
    expect(got).toBe("Run 2 · public.users");
  });

  it("edge: empty sql + no label falls back to Run N · Stmt M", () => {
    const got = tabTitle(minimal({ runNo: 3, sql: "" }), 2);
    expect(got).toBe("Run 3 · Stmt 3");
  });

  it("edge: very long sql truncates to 30 chars (no overflow)", () => {
    const sql = "a".repeat(200);
    const got = tabTitle(minimal({ runNo: 4, sql }), 3);
    // 30 'a's + nothing else (no extra suffix).
    expect(got.length).toBe("Run 4 · ".length + 30);
    expect(got).toBe(`Run 4 · ${"a".repeat(30)}`);
  });

  it("regression: healthy SELECT path remains readable as Run N · SELECT 1", () => {
    const got = tabTitle(minimal({ runNo: 5, sql: "SELECT 1", status: "done" }), 4);
    expect(got).toBe("Run 5 · SELECT 1");
  });
});

describe("TASK-UX2-002 tabBadge", () => {
  it("unit: returns '⚠ ' for status='error'", () => {
    expect(tabBadge(minimal({ status: "error" }))).toBe("⚠ ");
  });

  it("unit: returns '' for status='done'", () => {
    expect(tabBadge(minimal({ status: "done" }))).toBe("");
  });
});
