// src/core/__tests__/text.test.ts
// TASK-702 — truncateAtBoundary: code-point-safe slice with `…` suffix.
import { describe, it, expect } from "vitest";
import { stripTrailingSemicolon, truncateAtBoundary } from "../text";

describe("stripTrailingSemicolon (TASK-004)", () => {
  // Case 6 — edge (lexical): strip one terminator, preserve interior `;`
  it("6. strips one trailing terminator but preserves interior semicolons", () => {
    expect(stripTrailingSemicolon("SELECT ';' AS s;  ")).toBe("SELECT ';' AS s");
    // wrappers retain the literal semicolon
    expect(stripTrailingSemicolon("SELECT * FROM (SELECT ';' AS s) t;")).toBe(
      "SELECT * FROM (SELECT ';' AS s) t",
    );
  });

  // Case 7 — edge (empty/boundary): whitespace-only input is stable
  it("7. whitespace-only input becomes empty; a bare statement is unchanged", () => {
    expect(stripTrailingSemicolon("   \t ")).toBe("");
    expect(stripTrailingSemicolon("SELECT 1")).toBe("SELECT 1");
  });
});


describe("TASK-702 — truncateAtBoundary", () => {
  it("1. ASCII dưới cap → nguyên vẹn, không có `…`", () => {
    const s = "DELETE FROM t";
    expect(truncateAtBoundary(s, 2000)).toBe(s);
  });

  it("2. ASCII vượt cap → prefix + `…`", () => {
    const s = "a".repeat(3000);
    const out = truncateAtBoundary(s, 100);
    expect(out).toBe("a".repeat(100) + "…");
  });

  it("3. emoji tại biên → không có lone surrogate, popped code point là `…` hoặc full emoji", () => {
    const s = "x".repeat(99) + "🔥" + "y".repeat(50);
    const out = truncateAtBoundary(s, 100);
    // No lone surrogate anywhere in the output
    for (let i = 0; i < out.length; i++) {
      const cp = out.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        // high surrogate must be followed by low surrogate
        expect(out.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(out.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        // low surrogate must be preceded by high surrogate
        expect(out.charCodeAt(i - 1)).toBeGreaterThanOrEqual(0xd800);
        expect(out.charCodeAt(i - 1)).toBeLessThanOrEqual(0xdbff);
      }
    }
    // Last code point is `…` OR the full emoji made it in
    const lastCp = [...out].pop();
    expect(["…", "🔥"]).toContain(lastCp);
  });

  it("4. cap = 0 → không crash, trả về `…` hoặc rỗng", () => {
    const out = truncateAtBoundary("anything here", 0);
    expect(out === "" || out === "…").toBe(true);
  });
});
