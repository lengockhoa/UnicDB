// src/__tests__/aix06Scaffold.test.ts — TASK-AIX06-004
//
// AIX-06 structural scaffold checks.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const AIX06_MODULES = [
  "src/ai/trace.ts",
  "src/ai/agent.ts",
  "src/ai/omp/ompChatEngine.ts",
];

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("AIX-06 scaffold", () => {
  it("trace.ts exports TraceRecorder + redact", () => {
    const src = read("src/ai/trace.ts");
    expect(src).toMatch(/export class TraceRecorder/);
    expect(src).toMatch(/export function redact/);
  });

  it("OmpChatEvents has optional onTrace; OmpChatEngineOptions accepts trace", () => {
    const src = read("src/ai/omp/ompChatEngine.ts");
    expect(src).toMatch(/onTrace\?\(event: TraceEvent\): void/);
    expect(src).toMatch(/trace\?: TraceRecorder/);
  });

  it("runAgent accepts an optional trace param", () => {
    const src = read("src/ai/agent.ts");
    expect(src).toMatch(/trace\?: TraceRecorder/);
  });

  it("AIX-06 modules have no shell:true / execSync in non-comment code", () => {
    for (const rel of AIX06_MODULES) {
      const stripped = read(rel)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(stripped, rel).not.toMatch(/\bshell\s*:\s*true\b/);
      expect(stripped, rel).not.toMatch(/\bexecSync\s*\(/);
    }
  });

  it("trace.ts contains no apiKey/secret literals", () => {
    const src = read("src/ai/trace.ts");
    expect(src).not.toMatch(/apiKey\s*[:=]\s*["']/i);
    expect(src).not.toMatch(/\bsecret\s*[:=]\s*["']/i);
  });

  it("panel threads trace into both engines and exposes dump/clear", () => {
    const src = read("src/ui/aiChatPanel.ts");
    expect(src).toMatch(/private readonly trace = new TraceRecorder\(\)/);
    expect(src).toMatch(/dumpTrace\(turnId: string\)/);
    expect(src).toMatch(/clearTrace\(\): void/);
    expect(src).toMatch(/runAgent\([\s\S]{0,400}?this\.trace,/);
  });

  it("test files exist", () => {
    expect(existsSync(join(ROOT, "src/ai/__tests__/trace.test.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/ai/__tests__/agent.test.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src/ai/omp/__tests__/ompChatEngine.test.ts"))).toBe(true);
  });
});
