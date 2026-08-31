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
  it("missing trailing newline emits sentinel", () => {
    const d = buildUnifiedDiff("a", "a\nb");
    expect(d).toContain("\\ No newline at end of file");
  });

  // AIX-02 review: the sentinel must sit next to the line it describes.
  it("sentinel placement: new side lacks newline → after last + line", () => {
    const d = buildUnifiedDiff("a\n", "a\nb");
    const lines = d.split("\n");
    const sentinel = lines.indexOf("\\ No newline at end of file");
    expect(sentinel).toBeGreaterThan(0);
    expect(lines[sentinel - 1]).toBe("+b"); // directly after the added line
  });

  it("sentinel placement: BOTH sides lack newline → two sentinels", () => {
    const d = buildUnifiedDiff("a", "b");
    const lines = d.split("\n");
    const at = lines.map((l, i) => (l === "\\ No newline at end of file" ? i : -1)).filter((i) => i >= 0);
    expect(at.length).toBe(2);
    expect(lines[at[0] - 1]).toBe("-a"); // old-side sentinel
    expect(lines[at[1] - 1]).toBe("+b"); // new-side sentinel
  });

  // AIX-02 review round 4: overflow truncation must not drop the sentinel
  // when the terminal line IS rendered.
  it("overflow branch still renders sentinels next to terminal lines", () => {
    const d = buildUnifiedDiff("a\n", "b", { maxLines: 3 }); // old has NL, new lacks
    const lines = d.split("\n");
    const at = lines.indexOf("\\ No newline at end of file");
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe("+b");
  });

  it("overflow branch renders BOTH sentinels when both sides lack newline", () => {
    // maxLines 4: header + (-a + sentinel) + (+b + sentinel) — every
    // rendered terminal line keeps its sentinel; 3 lines would cut +b.
    const d = buildUnifiedDiff("a", "b", { maxLines: 4 });
    const lines = d.split("\n");
    const at = lines
      .map((l, i) => (l === "\\ No newline at end of file" ? i : -1))
      .filter((i) => i >= 0);
    expect(at.length).toBe(2);
    expect(lines[at[0] - 1]).toBe("-a");
    expect(lines[at[1] - 1]).toBe("+b");
  });

  it("uncapped both-sides sentinel pairs stay adjacent", () => {
    const d = buildUnifiedDiff("a", "b");
    const lines = d.split("\n");
    const at = lines
      .map((l, i) => (l === "\\ No newline at end of file" ? i : -1))
      .filter((i) => i >= 0);
    expect(at.length).toBe(2);
    expect(lines[at[0] - 1]).toBe("-a");
    expect(lines[at[1] - 1]).toBe("+b");
  });

  it("sentinel placement: old side lacks newline → after last - line", () => {
    const d = buildUnifiedDiff("a\nb", "a\n");
    const lines = d.split("\n");
    const sentinel = lines.indexOf("\\ No newline at end of file");
    expect(sentinel).toBeGreaterThan(0);
    expect(lines[sentinel - 1]).toBe("-b");
  });

  it("sentinel placement: old side no-newline preserved as context", () => {
    // old='a' (no trailing \n) → new adds a line but keeps 'a' as context.
    const d = buildUnifiedDiff("a", "a\nb\n");
    const lines = d.split("\n");
    const sentinel = lines.indexOf("\\ No newline at end of file");
    expect(sentinel).toBeGreaterThan(0);
    expect(lines[sentinel - 1]).toBe(" a"); // right after the context line
  });

  it("overflowing single hunk still renders a prefix before truncation", () => {
    const old = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") + "\n";
    const neu = Array.from({ length: 50 }, (_, i) => `m${i}`).join("\n") + "\n";
    const d = buildUnifiedDiff(old, neu, { maxLines: 10 });
    expect(d).toContain("@@");
    expect(d).toContain("-l0");
    expect(d.split("\n").length).toBeLessThanOrEqual(11); // cap + marker
  });

  it("multi-hunk diff renders ALL hunks when under the cap", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) lines.push(`l${i}`);
    const neu = [...lines]; // clone BEFORE mutating
    lines[2] = "x2";
    lines[17] = "x17";
    const d = buildUnifiedDiff(lines.join("\n") + "\n", neu.join("\n") + "\n", { maxLines: 200 });
    expect(d.split("\n").filter((l) => l.startsWith("@@")).length).toBe(2);
    expect(d).not.toContain("more lines");
  });
});

describe("diffStats", () => {
  it("counts added/removed", () => {
    expect(diffStats("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    expect(diffStats("same\n", "same\n")).toEqual({ added: 0, removed: 0 });
  });
});
