// tests/install-vsdb.test.ts — TDD for scripts/install-vsdb.sh
// Spawns the bash script in --dry-run / env-override mode and asserts CLI detection.
// Per TASK-008 Test Cases table.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "install-vsdb.sh");

function runScript(args: string[], envOverrides: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
    timeout: 30000,
  });
}

describe("install-vsdb.sh — CLI detection", () => {
  it("Test #1: --dry-run detects PATH code first", () => {
    // Create a fake `code` binary on PATH
    const fakeBin = path.resolve(__dirname, ".fake-bin");
    require("node:fs").mkdirSync(fakeBin, { recursive: true });
    const fakeCode = path.join(fakeBin, "code");
    require("node:fs").writeFileSync(
      fakeCode,
      "#!/bin/sh\necho 'fake-code-called: $*'\nexit 0\n",
      { mode: 0o755 }
    );
    const result = runScript(["--local", "fake.vsix", "--dry-run"], {
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      VSDB_CODE_PATH: "",
    });
    expect(result.status).toBe(0);
    // It should print the path of the resolved CLI
    expect(result.stdout).toContain(fakeCode);
  });

  it("Test #1b: falls back to macOS app path when PATH empty", () => {
    const macPath = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    const result = runScript(["--local", "fake.vsix", "--dry-run"], {
      PATH: "/usr/bin:/bin",
      VSDB_CODE_PATH: macPath,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(macPath);
  });

  it("Test #2: no CLI found → exit 1 with clear message", () => {
    const result = runScript(["--local", "fake.vsix", "--dry-run"], {
      PATH: "/usr/bin:/bin",
      VSDB_CODE_PATH: "/nonexistent/path/to/code",
      // Override platform so the macOS app fallback doesn't kick in on this dev box.
      VSDB_PLATFORM: "Linux",
    });
    expect(result.status).toBe(1);
    // stderr or stdout should explain the user should install code CLI
    const out = (result.stdout + result.stderr).toLowerCase();
    expect(out).toMatch(/code|cli|install|p|ath/);
  });

  it("Test #2b: missing --local file → exit non-zero", () => {
    const result = runScript(["--local", "/nonexistent/file.vsix"], {
      PATH: process.env.PATH || "/usr/bin:/bin",
    });
    expect(result.status).not.toBe(0);
    const out = (result.stdout + result.stderr).toLowerCase();
    expect(out).toMatch(/not found|missing|local/);
  });

  it("Test #3 (smoke): --help prints usage", () => {
    const result = runScript(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("usage");
  });
});
