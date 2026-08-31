// src/ai/__tests__/analysisReport.test.ts — TASK-AIX03-001
import { describe, it, expect } from "vitest";
import {
  parseExplainPlan,
  summarizeToolOutcome,
  capTokens,
} from "../analysisReport";

describe("parseExplainPlan", () => {
  it("counts non-empty lines, deepest = last line trimmed", () => {
    const plan = [
      "Seq Scan on users  (cost=0.00..10.00 rows=1000 width=42)",
      "  Output: id, name",
      "",
      "Planning Time: 0.1 ms",
    ].join("\n");
    expect(parseExplainPlan(plan)).toEqual({
      nodes: 3,
      deepest: "Planning Time: 0.1 ms",
    });
  });

  it("empty/whitespace plan → zero nodes, empty deepest", () => {
    expect(parseExplainPlan("")).toEqual({ nodes: 0, deepest: "" });
    expect(parseExplainPlan("  \n  \n")).toEqual({ nodes: 0, deepest: "" });
  });

  it("single line plan", () => {
    expect(parseExplainPlan("Index Scan on orders")).toEqual({
      nodes: 1,
      deepest: "Index Scan on orders",
    });
  });
});

describe("summarizeToolOutcome", () => {
  it("ok → check + tool + shape", () => {
    expect(summarizeToolOutcome("run_readonly_query", "ok", "3 cols × 20 rows")).toBe(
      "✓ run_readonly_query — 3 cols × 20 rows",
    );
  });

  it("denied → fixed denial text, shape ignored", () => {
    expect(summarizeToolOutcome("run_readonly_query", "denied", "ignored")).toBe(
      "✗ run_readonly_query — denied by user",
    );
  });

  it("failed → cross + failure detail", () => {
    expect(summarizeToolOutcome("count_rows", "failed", "syntax error")).toBe(
      "✗ count_rows — failed: syntax error",
    );
  });
});

describe("capTokens", () => {
  it("exact fit → unchanged", () => {
    expect(capTokens("a b c", 3)).toBe("a b c");
  });

  it("over → truncated with ellipsis", () => {
    expect(capTokens("a b c d e", 3)).toBe("a b c …");
  });

  it("non-positive max → just ellipsis", () => {
    expect(capTokens("a b", 0)).toBe("…");
    expect(capTokens("a b", -1)).toBe("…");
  });

  it("collapses whitespace", () => {
    expect(capTokens("a\n  b\tc", 3)).toBe("a b c");
  });
});
