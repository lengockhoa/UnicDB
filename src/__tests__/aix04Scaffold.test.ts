// src/__tests__/aix04Scaffold.test.ts
// TASK-AIX04-004 — structural scaffold checks for AIX-04:
//   1. changePlan + changePlanTool (pure modules) never import vscode
//      (confirmDangerous excluded — it IS the vscode modal).
//   2. changePlan/changePlanTool have no shell/fs/child_process access.
//   3. Public exports present (classifyStatements, validatePlanStatements,
//      detectDrift, createPlanChangeTool, createChangePlanTools).
//   4. plan_change registered in BOTH builtin and OMP registries
//      (aiChatPanel.ts: two createChangePlanTools call sites).
//   5. change_plan / plan_approve / plan_reject wire kinds in messages.
//   6. Consent gate is the ONE implementation: extension.ts re-exports
//      confirmDangerousStatements from ./ui/confirmDangerous (no local
//      copy of the modal).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const PURE_MODULES = [
  "src/ai/changePlan.ts",
  "src/ai/tools/changePlanTool.ts",
];

const VSCodeImport = /(?:from\s+["']vscode["']|import\s+["']vscode["']|require\(\s*["']vscode["']\s*\))/;
const FORBIDDEN = [
  { pattern: /\bshell\s*:\s*true\b/, why: "shell:true must never appear" },
  { pattern: /\bexecSync\s*\(/, why: "execSync is banned" },
  { pattern: /(?:from\s+["']|require\(\s*["'])node:?child_process["']/, why: "must not touch child_process" },
  { pattern: /(?:from\s+["']|require\(\s*["'])node:?fs(?:\/promises)?["']/, why: "must go through injected deps, not fs" },
];

describe("AIX-04 scaffold", () => {
  it("pure modules never import vscode", () => {
    for (const rel of PURE_MODULES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} vscode import`).not.toMatch(VSCodeImport);
    }
  });

  it("changePlan modules have no shell/fs/child_process access", () => {
    for (const rel of PURE_MODULES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      for (const { pattern, why } of FORBIDDEN) {
        expect(src, `${rel}: ${why}`).not.toMatch(pattern);
      }
    }
  });

  it("public exports present", () => {
    const plan = readFileSync(join(ROOT, "src/ai/changePlan.ts"), "utf8");
    expect(plan).toMatch(/export function classifyStatements/);
    expect(plan).toMatch(/export function validatePlanStatements/);
    expect(plan).toMatch(/export function detectDrift/);
    const tool = readFileSync(join(ROOT, "src/ai/tools/changePlanTool.ts"), "utf8");
    expect(tool).toMatch(/export function createPlanChangeTool/);
    expect(tool).toMatch(/export function createChangePlanTools/);
  });

  it("plan_change registered in BOTH builtin and OMP registries (via shared registerStandardToolset)", () => {
    const src = readFileSync(join(ROOT, "src/ui/aiChatPanel.ts"), "utf8");
    // AIX-05 collapsed the two createChangePlanTools call sites into a
    // single `registerStandardToolset` helper invoked from both code
    // paths. The plan_change tool still appears inside that helper
    // exactly once, and the helper is called twice (builtin + OMP/MCP).
    const helperCalls = (src.match(/this\.registerStandardToolset\(/g) ?? []).length;
    expect(helperCalls).toBe(2);
    expect(src).toMatch(/createChangePlanTools\(/);
  });

  it("change_plan / plan_approve / plan_reject wire kinds exist in messages", () => {
    const src = readFileSync(join(ROOT, "src/ui/aiChatPanelMessages.ts"), "utf8");
    expect(src).toMatch(/type:\s*"change_plan"/);
    expect(src).toMatch(/type:\s*"plan_approve"/);
    expect(src).toMatch(/type:\s*"plan_reject"/);
  });

  it("appendChangePlan is textContent-only (no innerHTML/outerHTML/insertAdjacentHTML/eval/new Function)", () => {
    const src = readFileSync(join(ROOT, "webview/aiChatPanelMain.ts"), "utf8");
    const start = src.indexOf("function appendChangePlan");
    expect(start).toBeGreaterThan(-1);
    // Function body = from the opening brace after the signature to its
    // closing brace. The next top-level function is appendAssistant.
    const nextFn = src.indexOf("function appendAssistant", start);
    const body = src.slice(start, nextFn > -1 ? nextFn : start + 4000);
    expect(body).not.toMatch(/innerHTML/);
    expect(body).not.toMatch(/outerHTML/);
    expect(body).not.toMatch(/insertAdjacentHTML/);
    expect(body).not.toMatch(/\beval\s*\(/);
    expect(body).not.toMatch(/new\s+Function/);
    // The card must render SQL via textContent.
    expect(body).toMatch(/textContent/);
  });

  it("consent gate is ONE implementation (extension re-exports, no local modal copy)", () => {
    const ext = readFileSync(join(ROOT, "src/extension.ts"), "utf8");
    expect(ext).toMatch(/from "\.\/ui\/confirmDangerous"/);
    // The local TASK-606 modal body must be gone from extension.ts.
    expect(ext).not.toMatch(/TASK-606 — Hỏi lại user trước khi chạy statement phá hoại/);
    const shared = readFileSync(join(ROOT, "src/ui/confirmDangerous.ts"), "utf8");
    expect(shared).toMatch(/export async function confirmDangerousStatements/);
    expect(shared).toMatch(/export const RED_DETAIL_CAP/);
  });
});
