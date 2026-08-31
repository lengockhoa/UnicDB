// src/__tests__/aix03Scaffold.test.ts
// TASK-AIX03-004 — structural scaffold checks for AIX-03:
//   1. analysisReport + analysisTools are pure (no vscode import).
//   2. analysisTools has no shell/fs/child_process access.
//   3. Public exports present.
//   4. The tool_result wire kind exists in panel messages.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const PURE_MODULES = ["src/ai/analysisReport.ts", "src/ai/tools/analysisTools.ts"];

const VSCodeImport = /(?:from\s+["']vscode["']|import\s+["']vscode["']|require\(\s*["']vscode["']\s*\))/;
const FORBIDDEN = [
  { pattern: /\bshell\s*:\s*true\b/, why: "shell:true must never appear" },
  { pattern: /\bexecSync\s*\(/, why: "execSync is banned" },
  { pattern: /(?:from\s+["']|require\(\s*["'])node:?child_process["']/, why: "must not touch child_process" },
  { pattern: /(?:from\s+["']|require\(\s*["'])node:?fs(?:\/promises)?["']/, why: "must go through injected deps, not fs" },
];

describe("AIX-03 scaffold", () => {
  it("pure modules never import vscode", () => {
    for (const rel of PURE_MODULES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} vscode import`).not.toMatch(VSCodeImport);
    }
  });

  it("analysisTools has no shell/fs/child_process access", () => {
    const src = readFileSync(join(ROOT, "src/ai/tools/analysisTools.ts"), "utf8");
    for (const { pattern, why } of FORBIDDEN) {
      expect(src, why).not.toMatch(pattern);
    }
  });

  it("public exports present", () => {
    const report = readFileSync(join(ROOT, "src/ai/analysisReport.ts"), "utf8");
    expect(report).toMatch(/export function parseExplainPlan/);
    expect(report).toMatch(/export function summarizeToolOutcome/);
    expect(report).toMatch(/export function capTokens/);
    const tools = readFileSync(join(ROOT, "src/ai/tools/analysisTools.ts"), "utf8");
    expect(tools).toMatch(/export function createAnalyzeTableTool/);
    expect(tools).toMatch(/export function createDiagnoseQueryTool/);
    expect(tools).toMatch(/export function createAnalysisTools/);
  });

  it("tool_result wire kind exists in panel messages", () => {
    const src = readFileSync(join(ROOT, "src/ui/aiChatPanelMessages.ts"), "utf8");
    expect(src).toMatch(/type:\s*"tool_result"/);
    expect(src).toMatch(/AiChatPanelToolResult/);
  });
});
