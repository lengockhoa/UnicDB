// src/__tests__/aix02Scaffold.test.ts
// TASK-AIX02-004 — structural scaffold checks for AIX-02:
//   1. fileDiff + fileOpsTool are pure (no vscode import).
//   2. fileOpsTool never shells out or touches fs/child_process directly —
//      all I/O is injected (readFile/writeFile deps).
//   3. Existing webview CSP scaffold (DBX-05) stays green.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const PURE_MODULES = ["src/ai/fileDiff.ts", "src/ai/tools/fileOpsTool.ts"];

const VSCodeImport = /(?:from\s+["']vscode["']|import\s+["']vscode["']|require\(\s*["']vscode["']\s*\))/;
const FORBIDDEN = [
  { pattern: /\bshell\s*:\s*true\b/, why: "shell:true must never appear" },
  { pattern: /\bexecSync\s*\(/, why: "execSync is banned" },
  { pattern: /(?:from\s+["']|require\(\s*["'])node:?child_process["']/, why: "file ops must not touch child_process" },
  { pattern: /(?:from\s+["']|require\(\s*["'])node:?fs(?:\/promises)?["']/, why: "file ops must go through injected deps, not fs" },
];

describe("AIX-02 scaffold", () => {
  it("pure modules never import vscode", () => {
    for (const rel of PURE_MODULES) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} vscode import`).not.toMatch(VSCodeImport);
    }
  });

  it("fileOpsTool has no shell/fs/child_process access", () => {
    const src = readFileSync(join(ROOT, "src/ai/tools/fileOpsTool.ts"), "utf8");
    for (const { pattern, why } of FORBIDDEN) {
      expect(src, why).not.toMatch(pattern);
    }
  });

  it("fileDiff is deterministic surface (exports both APIs)", () => {
    const src = readFileSync(join(ROOT, "src/ai/fileDiff.ts"), "utf8");
    expect(src).toMatch(/export function buildUnifiedDiff/);
    expect(src).toMatch(/export function diffStats/);
  });
});
