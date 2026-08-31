// src/ai/__tests__/fileDiff.test.ts
// TASK-AIX02-001 — pure unified diff (LCS), deterministic.
import { describe, it, expect } from "vitest";
import { buildUnifiedDiff, diffStats } from "../fileDiff";

describe("buildUnifiedDiff", () => {
  it("identical texts → empty string", () => {
    expect(buildUnifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  it("single-line change: @@ header, -old, +new, context", () => {
    const d = buildUnifiedDiff("a\nb\nc\nd\ne\n", "a\nb\nC\nd\ne\n");
    expect(d).toContain("-c");
    expect(d).toContain("@@ -1,5 +1,5 @@");
  });

  it("pure addition at end", () => {
    const d = buildUnifiedDiff("a\n", "a\nb\n");
    expect(d).toContain("+b");
    expect(d).toContain("@@");
  });

  it("pure deletion", () => {
    const d = buildUnifiedDiff("a\nb\n", "a\n");
    expect(d).toContain("-b");
  });

  it("missing trailing newline emits sentinel", () => {
    const d = buildUnifiedDiff("a", "a\nb");
    expect(d).toContain("\\ No newline at end of file");
  });

  it("maxLines cap truncates with marker", () => {
    const old = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") + "\n";
    const neu = Array.from({ length: 50 }, (_, i) => `m${i}`).join("\n") + "\n";
    const d = buildUnifiedDiff(old, neu, { maxLines: 10 });
    expect(d).toContain("more lines");
    expect(d.split("\n").length).toBeLessThan(30);
  });
});

describe("diffStats", () => {
  it("counts added/removed", () => {
    expect(diffStats("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(diffStats("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  });
});
