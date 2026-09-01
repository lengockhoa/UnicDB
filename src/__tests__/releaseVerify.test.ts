// src/__tests__/releaseVerify.test.ts
// Release verify contract (TASK-DX01-003):
//   - Pins the new `verify:fast` / `verify:release` script entries (TASK-DX01-001)
//     and the `scripts/verify-release.sh` runner (TASK-DX01-002) against the
//     v1.35.0 script baseline.
//   - Exercises the runner under PATH-stubbed fixtures so the test never
//     depends on the real `npm`/`tsc`/`node`/`esbuild` binaries.
//
// Describe block literally named "verify-release.sh" so focused `-t` runs
// (`npx vitest run -t "verify-release.sh"`) match the runner cases.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, "..", ".."); // src/__tests__/foo.test.ts → repo root
const packageJsonPath = join(repoRoot, "package.json");
const runnerPath = join(repoRoot, "scripts", "verify-release.sh");

const baselineScripts = {
  test: "vitest run",
  typecheck: "tsc --noEmit",
  compile: "node esbuild.js",
  "test:integration": "vitest run -c vitest.integration.config.ts",
};

const allowedVerifyFast = new Set([
  "npm run typecheck && npm run compile",
  "npm run compile && npm run typecheck",
]);

const allowedShebangs = new Set([
  "#!/bin/sh",
  "#!/usr/bin/env sh",
  "#!/usr/bin/env bash",
]);

describe("verify-release.sh", () => {
  // Cases 1-3: runner behaviour via PATH-stubbed fixture
  function makeStubBin(stubFn: (name: string) => string): { binDir: string; cleanup: () => void } {
    const binDir = mkdtempSync(join(tmpdir(), "verify-release-"));
    const cmds = ["npm", "tsc", "node", "esbuild"];
    for (const cmd of cmds) {
      const target = stubFn(cmd);
      const link = join(binDir, cmd);
      writeFileSync(link, target);
      chmodSync(link, 0o755);
    }
    return { binDir, cleanup: () => rmSync(binDir, { recursive: true, force: true }) };
  }

  function runRunner(extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
    const res = spawnSync("sh", [runnerPath], {
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
    });
    return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  it("prints PASS per stage and final OK on all-zero exit", () => {
    const { binDir, cleanup } = makeStubBin(() => "#!/bin/sh\nexit 0\n");
    try {
      const { status, stdout, stderr } = runRunner({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
      expect(status).toBe(0);
      expect(stdout).toContain("PASS npm-test");
      expect(stdout).toContain("PASS typecheck");
      expect(stdout).toContain("PASS compile");
      // ordering
      const i1 = stdout.indexOf("PASS npm-test");
      const i2 = stdout.indexOf("PASS typecheck");
      const i3 = stdout.indexOf("PASS compile");
      expect(i1).toBeGreaterThanOrEqual(0);
      expect(i2).toBeGreaterThan(i1);
      expect(i3).toBeGreaterThan(i2);
      expect(stdout.trim().endsWith("OK verify:release")).toBe(true);
      expect(stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("first non-zero stage aborts and prints FAIL npm-test", () => {
    const { binDir, cleanup } = makeStubBin((cmd) => {
      if (cmd === "npm") return "#!/bin/sh\nexit 3\n";
      return "#!/bin/sh\nexit 0\n";
    });
    try {
      const { status, stdout, stderr } = runRunner({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
      expect(status).toBe(3);
      expect(stdout).toContain("FAIL npm-test");
      expect(stdout).toContain("FAIL verify:release");
      expect(stdout).not.toContain("PASS typecheck");
      expect(stdout).not.toContain("PASS compile");
      expect(stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  it("stdout/stderr are separated, no trailing whitespace, no ANSI", () => {
    const { binDir, cleanup } = makeStubBin(() => "#!/bin/sh\nexit 0\n");
    try {
      const { status, stdout, stderr } = runRunner({ PATH: `${binDir}:${process.env.PATH ?? ""}` });
      expect(status).toBe(0);
      for (const line of stdout.split("\n")) {
        expect(line).not.toMatch(/[\r]/);
        expect(line === line.trimEnd()).toBe(true);
      }
      for (const line of stderr.split("\n")) {
        expect(line).not.toMatch(/[\r]/);
        expect(line === line.trimEnd()).toBe(true);
      }
      expect(stderr).toBe("");
    } finally {
      cleanup();
    }
  });

  // Cases 4-9: package.json + runner file contract
  it("verify:fast is exactly one of the two allowed strings", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> };
    expect(allowedVerifyFast.has(pkg.scripts["verify:fast"])).toBe(true);
  });

  it("verify:release is the exact pinned string", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["verify:release"]).toBe("npm test && npm run typecheck && npm run compile");
  });

  it("script strings have no shell-injection surface", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> };
    for (const key of ["verify:fast", "verify:release"] as const) {
      const v = pkg.scripts[key];
      expect(v).toBeDefined();
      expect(v).not.toMatch(/[`$]/);  // no backticks, no $(...)
      expect(v).not.toMatch(/[;|>]/);
      expect(v).toMatch(/^npm[^`]*$/);
    }
  });

  it("runner script exists, is executable, has a POSIX shebang", () => {
    expect(existsSync(runnerPath)).toBe(true);
    const st = statSync(runnerPath);
    expect((st.mode & 0o111) !== 0).toBe(true);
    const firstLine = readFileSync(runnerPath, "utf8").split("\n", 1)[0] ?? "";
    expect(allowedShebangs.has(firstLine)).toBe(true);
  });

  it("existing four baseline scripts preserved", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> };
    for (const [k, v] of Object.entries(baselineScripts)) {
      expect(pkg.scripts[k]).toBe(v);
    }
  });

  it("verify:* values reference ONLY pre-existing script keys", () => {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts: Record<string, string> };
    const allowed = new Set(Object.keys(pkg.scripts));
    // Each new verify:* value, when split on `&&`, must contain only substrings
    // of the form `npm run <existing-key>` or `npm test` (which references `test`).
    const valueToKey = (fragment: string): string | null => {
      const t = fragment.trim();
      const m = /^npm run (.+)$/.exec(t);
      if (m) return m[1];
      if (t === "npm test") return "test";
      return null;
    };
    for (const key of ["verify:fast", "verify:release"] as const) {
      const v = pkg.scripts[key];
      expect(v).toBeDefined();
      for (const frag of v.split("&&")) {
        const k = valueToKey(frag);
        expect(k, `fragment ${frag} of ${key} is not a recognised npm invocation`).not.toBeNull();
        expect(allowed.has(k as string), `${key} references unknown script ${k}`).toBe(true);
      }
    }
  });
});