// src/__tests__/aix05Scaffold.test.ts — TASK-AIX05-004
//
// AIX-05 structural scaffold checks.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
// Pure / vscode-free modules — these MUST have no shell/execSync patterns
// (and no apiKey literal). acpProcess.ts is intentionally excluded: it
// spawns the omp child process and contains an explanatory comment that
// matches the regex.
const PURE_MODULES = [
  "src/ai/engineChoice.ts",
  "src/ai/omp/ompChatEngine.ts",
  "src/ai/omp/hostMcp.ts",
  "src/ai/omp/detect.ts",
  "src/ai/omp/acp.ts",
];

const FORBIDDEN = [
  { pattern: /\bshell\s*:\s*true\b/, why: "shell:true must never appear" },
  { pattern: /\bexecSync\s*\(/, why: "execSync is banned" },
];

const read = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8");

describe("AIX-05 scaffold", () => {
  it("pure omp modules have no shell:true / execSync in non-comment code", () => {
    for (const rel of PURE_MODULES) {
      const src = read(rel);
      // Strip line comments + block comments so explanatory comments
      // mentioning "shell: true" / execSync don't false-positive.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const f of FORBIDDEN) {
        expect(stripped, `${rel}: ${f.why}`).not.toMatch(f.pattern);
      }
    }
  });

  it("ompChatEngine never embeds apiKey / token in wire-frame literals", () => {
    const src = read("src/ai/omp/ompChatEngine.ts");
    expect(src).not.toMatch(/apiKey\s*:/i);
    expect(src).not.toMatch(/\btoken\s*[:=]\s*["']/);
  });

  it("OmpChatEngine interface declares cancel()", () => {
    const src = read("src/ai/omp/ompChatEngine.ts");
    expect(src).toMatch(
      /export interface OmpChatEngine \{[\s\S]*cancel\(\): void;/,
    );
  });

  it("AiChatPanelSessionState is in the HostMessage union", () => {
    const src = read("src/ui/aiChatPanelMessages.ts");
    expect(src).toMatch(
      /export interface AiChatPanelSessionState \{[\s\S]*turnId: string;/,
    );
    expect(src).toMatch(/AiChatPanelSessionState/);
  });

  it("exports present: createOmpChatEngine, detectOmp, MIN_OMP_VERSION, resolveEngine", () => {
    const e1 = read("src/ai/omp/ompChatEngine.ts");
    expect(e1).toMatch(/export function createOmpChatEngine/);
    const e2 = read("src/ai/omp/detect.ts");
    expect(e2).toMatch(/export async function detectOmp/);
    expect(e2).toMatch(/export const MIN_OMP_VERSION/);
    const e3 = read("src/ai/engineChoice.ts");
    expect(e3).toMatch(/export function resolveEngine/);
  });

  it("handleStop routes omp+ompChatEngine to engine.cancel()", () => {
    const src = read("src/ui/aiChatPanel.ts");
    expect(src).toMatch(
      /if \(this\.engine === "omp" && this\.options\.ompChatEngine !== undefined\) \{\s*this\.options\.ompChatEngine\.cancel\(\);/,
    );
  });

  it("aiChatPanel calls registerStandardToolset on both builtin and OMP/MCP paths", () => {
    const src = read("src/ui/aiChatPanel.ts");
    const calls = src.match(/this\.registerStandardToolset\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("engineChoice has a reason-keyed hint (AIX-05 spec)", () => {
    const src = read("src/ai/engineChoice.ts");
    expect(src).toMatch(/detection\.reason === "version-too-old"/);
  });

  it("engineChoice wired in extension (no local copy)", () => {
    const ext = read("src/extension.ts");
    expect(ext).toMatch(/resolveEngine/);
  });

  it("session_state wire kind is rendered textContent-only in webview", () => {
    const src = read("webview/aiChatPanelMain.ts");
    const block = src.match(/function applySessionState[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/textContent/);
    expect(block![0]).not.toMatch(/innerHTML/);
  });

  it("sessionState host fields present in aiChatPanel", () => {
    const src = read("src/ui/aiChatPanel.ts");
    expect(src).toMatch(/postSessionState/);
    expect(src).toMatch(/sessionTurnSeq/);
  });

  it("currentSessionId tracking present in ompChatEngine", () => {
    const src = read("src/ai/omp/ompChatEngine.ts");
    expect(src).toMatch(/currentSessionId/);
  });

  it("session_state test files exist (host + webview + parity)", () => {
    expect(
      existsSync(join(ROOT, "src/ui/__tests__/aiChatPanelSessionState.test.ts")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "src/ui/__tests__/aiChatPanelSessionStateWebview.test.ts")),
    ).toBe(true);
    expect(
      existsSync(join(ROOT, "src/ui/__tests__/aiChatPanelToolParity.test.ts")),
    ).toBe(true);
  });
});
