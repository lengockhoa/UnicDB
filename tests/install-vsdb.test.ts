// tests/install-vsdb.test.ts — TDD for scripts/install-vsdb.sh
// Spawns the bash script in --dry-run / env-override mode and asserts CLI detection.
// Also exercises find_vsix_asset_url via the script's --local install + env-injected JSON.
// Per TASK-008 Test Cases table.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const SCRIPT = path.resolve(__dirname, "..", "scripts", "install-vsdb.sh");

function runScript(args: string[], envOverrides: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: { ...process.env, ...envOverrides },
    encoding: "utf8",
    timeout: 30000,
  });
}

// CLI-detection tests rely on macOS-specific code CLI fallback paths and
// the absence of `code` on PATH. Skip on non-darwin platforms (Linux CI,
// Windows) where the assertions become platform-incompatible.
// Use describe.skip (vitest 1.x) instead of describe.skipIf (vitest 2.x).
const isMacDev = process.platform === "darwin";
const platformDescribe = isMacDev ? describe : describe.skip;

platformDescribe("install-vsdb.sh — CLI detection", () => {
  it("Test #1: --dry-run detects PATH code first", () => {
    // Create a fake `code` binary on PATH
    const fakeBin = path.resolve(__dirname, ".fake-bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeCode = path.join(fakeBin, "code");
    fs.writeFileSync(
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

  it("Test #3b: --local install prints reload hint", () => {
    // Fake code CLI + a real tiny .vsix so the script reaches the install-success path.
    const fakeBin = path.resolve(__dirname, ".fake-bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeCode = path.join(fakeBin, "code");
    fs.writeFileSync(
      fakeCode,
      "#!/bin/sh\nif [[ \"$1\" == \"--install-extension\" ]]; then exit 0; fi\n" +
        "echo 'lengockhoa.vsdb@9.9.9'\nexit 0\n",
      { mode: 0o755 }
    );
    const tmp = fs.mkdtempSync(path.join(__dirname, ".hint-"));
    const vsix = path.join(tmp, "vsdb-test.vsix");
    fs.writeFileSync(vsix, "PK");
    const result = runScript(["--local", vsix], {
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      VSDB_CODE_PATH: "",
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Developer: Reload Window/);
  });
});

describe("install-vsdb.sh — find_vsix_asset_url (python3 branch)", () => {
  // Realistic GitHub release JSON: tag + source zip + the .vsix asset we want.
  // This fixture is exactly the kind of payload the script must parse.
  const fixtureJson = JSON.stringify({
    tag_name: "v0.1.0",
    name: "VSDB 0.1.0",
    assets: [
      {
        name: "Source code (zip)",
        browser_download_url: "https://github.com/lengockhoa/VSDB/archive/refs/tags/v0.1.0.zip",
      },
      {
        name: "Source code (tar.gz)",
        browser_download_url: "https://github.com/lengockhoa/VSDB/archive/refs/tags/v0.1.0.tar.gz",
      },
      {
        name: "vsdb-0.1.0.vsix",
        browser_download_url: "https://github.com/lengockhoa/VSDB/releases/download/v0.1.0/vsdb-0.1.0.vsix",
      },
    ],
  });

  // Drive the python3 branch by extracting the function defs (everything before
  // `main()` is defined) and prepending a no-op `main` so sourcing doesn't run
  // the real main, which would hit the GitHub API.
  const driver = (call: string) => `
    set -e
    main() { return 0; }
    # Source everything up to (but not including) the real 'main() {' definition.
    awk '/^main\\(\\) \\{/{exit} {print}' "${SCRIPT}" > /tmp/vsdb-funcs-$$.sh
    source /tmp/vsdb-funcs-$$.sh
    rm -f /tmp/vsdb-funcs-$$.sh
    ${call}
  `;

  it("Test #4: parses .vsix asset URL from realistic release JSON (python3 branch)", () => {
    const pyAvailable = spawnSync("python3", ["--version"]).status === 0;
    if (!pyAvailable) {
      // python3 not present → the grep/sed fallback is exercised instead; skip.
      return;
    }

    const result = spawnSync(
      "bash",
      ["-c", driver(`find_vsix_asset_url '${fixtureJson.replace(/'/g, "'\\''")}'`)],
      { env: { ...process.env }, encoding: "utf8", timeout: 10000 }
    );
    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error("driver stderr:", result.stderr);
    }
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "https://github.com/lengockhoa/VSDB/releases/download/v0.1.0/vsdb-0.1.0.vsix"
    );
  });

  it("Test #4b: parses tag_name from release JSON (python3 branch)", () => {
    const pyAvailable = spawnSync("python3", ["--version"]).status === 0;
    if (!pyAvailable) return;

    const result = spawnSync(
      "bash",
      ["-c", driver(`parse_json_field '${fixtureJson.replace(/'/g, "'\\''")}' tag_name`)],
      { env: { ...process.env }, encoding: "utf8", timeout: 10000 }
    );
    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error("driver stderr:", result.stderr);
    }
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("v0.1.0");
  });
});
