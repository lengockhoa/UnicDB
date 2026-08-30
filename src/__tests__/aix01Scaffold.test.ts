// src/__tests__/aix01Scaffold.test.ts
// AIX-01 scaffold — purity guards for the grounding modules + secret
// pattern word-safety (no bare-anchored regex that would over-match).

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

describe("AIX-01 scaffold — pure grounding modules", () => {
  const modules = [
    "src/ai/grounding/selection.ts",
    "src/ai/grounding/attribution.ts",
    "src/ai/grounding/fileSearch.ts",
    "src/ui/groundingService.ts",
    "src/ui/groundingMessages.ts",
    "src/ai/tools/workspaceSearchTool.ts",
  ];

  it("grounding modules import no vscode and no network", () => {
    for (const rel of modules) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf-8");
      expect(src, `${rel} imports vscode`).not.toMatch(/from ["']vscode["']/);
      expect(src, `${rel} hits the network`).not.toMatch(/\b(fetch|XMLHttpRequest|axios|http|https)\b/);
      expect(src, `${rel} uses eval`).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
    }
  });

  it("secret regexes are word-bounded (no over-match on common prose)", async () => {
    const { containsSecretHeuristic } = await import("../ai/grounding/fileSearch");
    expect(containsSecretHeuristic("innovation")).toBe(false);
    expect(containsSecretHeuristic("sketch")).toBe(false);
    expect(containsSecretHeuristic("ghp is just a prefix; not a token")).toBe(false);
  });

  it("grounding service / messages stay vscode-free", () => {
    const gs = fs.readFileSync(path.join(repoRoot, "src/ui/groundingService.ts"), "utf-8");
    const gm = fs.readFileSync(path.join(repoRoot, "src/ui/groundingMessages.ts"), "utf-8");
    expect(gs).not.toMatch(/from ["']vscode["']/);
    expect(gm).not.toMatch(/from ["']vscode["']/);
  });

  it("aiChatPanel wires the grounding block (source-level check)", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "src/ui/aiChatPanel.ts"),
      "utf-8",
    );
    expect(src).toContain("Grounded workspace context");
    expect(src).toContain("collectGrounding");
  });

  it("aiChatPanelMessages exports a grounding_state type", () => {
    const src = fs.readFileSync(
      path.join(repoRoot, "src/ui/aiChatPanelMessages.ts"),
      "utf-8",
    );
    expect(src).toContain("AiChatPanelGroundingState");
  });
});
