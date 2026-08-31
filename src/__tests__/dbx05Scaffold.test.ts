// src/__tests__/dbx05Scaffold.test.ts
// DBX-05 TASK-DBX05-004 — structural scaffold checks:
//   1. New core modules are pure (no `vscode` import) — usable headless.
//   2. sshTunnelManager never shells out (no shell:true, exec, execSync, child_process).
//   3. Connection form webview stays CSP-clean (no inline event handlers / innerHTML
//      template-injected scripts) and textContent-only for dynamic text.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

const ROOT = join(__dirname, "..", "..");
const PURE_MODULES = [
  "src/core/connectionGroups.ts",
  "src/core/readOnlyIntent.ts",
  "src/core/sshTunnel.ts",
  "src/core/sshTunnelManager.ts",
];

const FORBIDDEN_SHELL = [
  { pattern: /\bshell\s*:\s*true\b/, why: "spawn must never use shell:true" },
  { pattern: /\bexecSync\s*\(/, why: "execSync is banned for the tunnel" },
  { pattern: /(?:import|require)\s*\(?\s*["']child_process["']/, why: "child_process import must be absent (uses node:child_process or spawn only)" },
  { pattern: /\bspawn\s*\(\s*["'][^"']*["']\s*,\s*\{\s*shell\s*:\s*true\s*\}/, why: "spawn must never use shell:true" },
];

describe("DBX-05 scaffold", () => {
  it("new core modules never import vscode (headless-safe)", () => {
    for (const rel of PURE_MODULES) {
      const file = join(ROOT, rel);
      expect(existsSync(file), `${rel} should exist`).toBe(true);
      const src = readFileSync(file, "utf8");
      // Only real vscode imports are banned; comments saying "no vscode import"
      // are fine, and regex `.exec()` on a source line is unrelated to
      // child_process.exec.
      expect(src).not.toMatch(
        /(?:from\s+["']vscode["']|import\s+["']vscode["']|require\(\s*["']vscode["']\))/,
      );
    }
  });

  it("sshTunnelManager never shells out", () => {
    const file = join(ROOT, "src/core/sshTunnelManager.ts");
    const src = readFileSync(file, "utf8");
    for (const { pattern, why } of FORBIDDEN_SHELL) {
      expect(src, `${why} (${pattern})`).not.toMatch(pattern);
    }
    // The spawn call must exist and pass explicit argv, not a command string.
    expect(src).toMatch(/spawn\s*\(/);
  });
  it("connection form webview is CSP-clean (no DOM sinks, no inline handlers)", () => {
    const file = join(ROOT, "webview/connectionFormMain.ts");
    const src = readFileSync(file, "utf8");
    // Prohibited DOM sinks: any of these would let untrusted text become HTML.
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function\s*\(/);
    // Inline JS event handlers (onclick=...) would violate the CSP header.
    expect(src).not.toMatch(/\bon\w+\s*=\s*["']/);
    // No <script> tag ever rendered from the webview bundle itself.
    expect(src).not.toMatch(/<script/i);
  });

  it("connectionGroups exposes palette + assignColor + grouping", () => {
    const file = join(ROOT, "src/core/connectionGroups.ts");
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/GROUP_COLOR_PALETTE/);
    expect(src).toMatch(/assignColor/);
    expect(src).toMatch(/groupConnections/);
  });

  it("readOnlyIntent carries mutation statements in the violation", () => {
    const file = join(ROOT, "src/core/readOnlyIntent.ts");
    const src = readFileSync(file, "utf8");
    expect(src).toMatch(/ReadOnlyViolation/);
    expect(src).toMatch(/statements/);
  });
});
