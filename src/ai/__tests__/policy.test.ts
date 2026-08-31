// src/ai/__tests__/policy.test.ts — TASK-AIX07-001
//
// TDD matrix for the pure, default-deny effective AI policy:
//   1. happy         — trusted valid builtin resolver route enables governed capabilities.
//   2. resolver edge — valid configured "builtin" stays ALLOWED when resolveEngine()
//                      legitimately selects OMP (detection-first is a route, not a conflict).
//   3. trust edge    — untrusted workspace denies every sensitive capability.
//   4. invalid edge  — unknown configured value and missing/invalid resolver
//                      choice fail closed with a concrete non-empty notice.
//   5. path edge     — credential/generated-config paths are excluded centrally.
// policy.ts must stay pure (no vscode/fs/net/child_process) — pinned by the
// source scan at the bottom.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvePolicy, isExcludedWorkspacePath, type PolicyInput } from "../policy";
import type { EngineChoice } from "../engineChoice";

const choice = (engine: "omp" | "builtin"): EngineChoice => ({
  engine,
  requiresConfig: false,
});

function input(over: Partial<PolicyInput>): PolicyInput {
  return {
    workspaceTrusted: true,
    configuredEngine: "builtin",
    resolvedEngine: choice("builtin"),
    ...over,
  };
}

describe("resolvePolicy — TASK-AIX07-001", () => {
  it("trusted valid builtin resolver route enables declared governed capabilities", () => {
    const p = resolvePolicy(input({}));
    expect(p.provider).toBe("builtin");
    expect(p.context).toEqual({ schema: true, workspace: true, rows: true });
    expect(p.tools).toEqual({ database: true, workspace: true });
    expect(p.auditExportAllowed).toBe(true);
    expect(p.notice).toBe("");
  });

  it("valid configured builtin remains allowed when resolveEngine selects OMP", () => {
    const p = resolvePolicy(
      input({ configuredEngine: "builtin", resolvedEngine: choice("omp") }),
    );
    // resolveEngine()'s detection-first branch legitimately returns omp for a
    // user-configured builtin default — that is a valid OMP posture, not a conflict.
    expect(p.provider).toBe("omp");
    expect(p.context).toEqual({ schema: true, workspace: true, rows: true });
    expect(p.tools).toEqual({ database: true, workspace: true });
    expect(p.auditExportAllowed).toBe(true);
    expect(p.notice).toBe("");
  });

  it("untrusted workspace defaults to no sensitive context or tools", () => {
    const p = resolvePolicy(
      input({
        workspaceTrusted: false,
        configuredEngine: "omp",
        resolvedEngine: choice("omp"),
      }),
    );
    expect(p.context).toEqual({ schema: false, workspace: false, rows: false });
    expect(p.tools).toEqual({ database: false, workspace: false });
    expect(p.auditExportAllowed).toBe(false);
    expect(p.notice.length).toBeGreaterThan(0);
    // The resolver route itself stays observable; capabilities are what fail closed.
    expect(p.provider).toBe("omp");
  });

  it("unknown configured value or invalid resolver fails closed with notice", () => {
    // Unsupported/migrated raw setting — vocabulary validation denies capabilities
    // even though the resolver route is valid.
    const migrated = resolvePolicy(input({ configuredEngine: "legacy" }));
    expect(migrated.provider).toBe("builtin");
    expect(migrated.context).toEqual({ schema: false, workspace: false, rows: false });
    expect(migrated.tools).toEqual({ database: false, workspace: false });
    expect(migrated.auditExportAllowed).toBe(false);
    expect(migrated.notice.length).toBeGreaterThan(0);

    // Missing resolver choice.
    const noResolver = resolvePolicy(input({ resolvedEngine: null }));
    expect(noResolver.provider).toBeNull();
    expect(noResolver.context).toEqual({ schema: false, workspace: false, rows: false });
    expect(noResolver.tools).toEqual({ database: false, workspace: false });
    expect(noResolver.auditExportAllowed).toBe(false);
    expect(noResolver.notice.length).toBeGreaterThan(0);

    // Resolver choice without a valid engine discriminator.
    const malformed = resolvePolicy(
      input({ resolvedEngine: { requiresConfig: false } as unknown as EngineChoice }),
    );
    expect(malformed.provider).toBeNull();
    expect(malformed.context).toEqual({ schema: false, workspace: false, rows: false });
    expect(malformed.tools).toEqual({ database: false, workspace: false });
    expect(malformed.auditExportAllowed).toBe(false);
    expect(malformed.notice.length).toBeGreaterThan(0);
  });
});

describe("isExcludedWorkspacePath — centralized path policy", () => {
  it("credential and generated configuration paths are excluded centrally", () => {
    expect(isExcludedWorkspacePath(".env")).toBe(true);
    expect(isExcludedWorkspacePath(".git/config")).toBe(true);
    expect(isExcludedWorkspacePath(".vscode/vsdb-ai-config.yml")).toBe(true);
    expect(isExcludedWorkspacePath("src/feature.ts")).toBe(false);
  });

  it("exclusion scans every segment and fails closed on unusable input", () => {
    expect(isExcludedWorkspacePath("packages/app/.env")).toBe(true);
    expect(isExcludedWorkspacePath("deep/nested/.git/HEAD")).toBe(true);
    expect(isExcludedWorkspacePath("./.env")).toBe(true);
    expect(isExcludedWorkspacePath("")).toBe(true);
  });
});

describe("purity guard — TASK-AIX07-001 acceptance", () => {
  it("policy.ts imports no vscode, fs, net, or child_process", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../policy.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']vscode["']|require\(["']vscode["']\)/);
    expect(src).not.toMatch(/["'](node:)?fs["']/);
    expect(src).not.toMatch(/["'](node:)?(net|http|https|child_process)["']/);
    expect(src).not.toMatch(/\bexecSync\b|\bspawnSync\b/);
  });
});
