// src/__tests__/releaseHygiene.test.ts
// Release hygiene guards (TASK-703):
//   - lock root version phải khớp package.json version (no hardcoded version).
//   - README giữ pattern install `UnicDB-<version>.vsix`.
//   - package.json version phải là semver hợp lệ X.Y.Z.
//
// Đọc động từ file on disk; bump version không phải sửa test.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

function readJson<T>(relPath: string): T {
  const raw = fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
  return JSON.parse(raw) as T;
}

interface PackageJson {
  version: string;
}

interface PackageLock {
  version?: string;
  packages?: { "": { version?: string } };
}

describe("release hygiene (TASK-703)", () => {
  it("lock root version khớp package.json version (đọc động)", () => {
    const pkg = readJson<PackageJson>("package.json");
    const lock = readJson<PackageLock>("package-lock.json");

    // npm v7+ dùng `packages[""].version`; npm v6 dùng `version` ở root.
    // Accept cả hai để robust qua các npm version.
    const lockRoot =
      lock.packages?.[""]?.version ??
      lock.version ??
      (() => {
        throw new Error(
          "package-lock.json thiếu root version (packages[''].version hoặc top-level version)",
        );
      })();

    expect(lockRoot, "package-lock.json root version phải khớp package.json")
      .toBe(pkg.version);
  });

  it("README giữ pattern install UnicDB-<version>.vsix", () => {
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf-8");
    // README phải giữ placeholder '<version>' (không hardcode số) để bump version
    // không phải sửa README. Test đọc từ file — không hardcode version cụ thể.
    expect(
      readme,
      "README phải chứa pattern 'UnicDB-<version>.vsix' (placeholder, không hardcode số)",
    ).toContain("UnicDB-<version>.vsix");
  });

  it("package.json version match semver X.Y.Z (3 thành phần số)", () => {
    const pkg = readJson<PackageJson>("package.json");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// Release confidence profiles (ARP-09) — TASK-ARP09-002:
//   - Named profile keys `profile:fast` / `profile:release` over the SAME stage
//     sets as `verify:*`, deliberately kept in lockstep (roadmap "named profiles").
//   - `profile:fast` byte-identical in effect to `verify:fast` is INTENDED —
//     the deliverable is the named profile key itself, not a third implementation.
//   - Baseline + verify scripts MUST stay byte-identical (regression guard).
// Đọc động từ package.json on disk (same approach as releaseVerify.test.ts).
interface ScriptsPackageJson {
  scripts?: Record<string, string>;
  contributes?: { configuration?: { properties?: Record<string, unknown> } };
}

describe("release confidence profiles (ARP-09)", () => {
  // Expected strings captured literally — pin against silent drift.
  const expectedPinnedScripts: Record<string, string> = {
    test: "vitest run",
    typecheck: "tsc --noEmit",
    compile: "node esbuild.js",
    "test:integration": "vitest run -c vitest.integration.config.ts",
    "verify:fast": "npm run typecheck && npm run compile",
    "verify:release": "npm test && npm run typecheck && npm run compile",
  };

  function readScripts(): Record<string, string> {
    const pkg = readJson<ScriptsPackageJson>("package.json");
    return pkg.scripts ?? {};
  }

  function profileKeys(scripts: Record<string, string>): string[] {
    return Object.keys(scripts).filter((k) => k.startsWith("profile:"));
  }

  it("profile:fast exists and equals the pinned fast-profile string", () => {
    expect(readScripts()["profile:fast"]).toBe("npm run typecheck && npm run compile");
  });

  it("profile:release exists and delegates to the pinned verify:release", () => {
    expect(readScripts()["profile:release"]).toBe("npm run verify:release");
  });

  it("profile:* keys are exactly the two named profiles (no extras)", () => {
    expect(profileKeys(readScripts()).sort()).toEqual(["profile:fast", "profile:release"]);
  });

  it("profile:* values reference ONLY real existing script keys", () => {
    const scripts = readScripts();
    const keys = profileKeys(scripts);
    expect(keys.length, "profile:* keys phải tồn tại để pin này có ý nghĩa").toBeGreaterThan(0);
    const allowed = new Set(Object.keys(scripts));
    for (const key of keys) {
      for (const frag of (scripts[key] ?? "").split("&&")) {
        const t = frag.trim();
        const m = /^npm run (.+)$/.exec(t);
        expect(m, `fragment '${t}' of ${key} is not an 'npm run <key>' invocation`).not.toBeNull();
        expect(allowed.has(m?.[1] as string), `${key} references unknown script '${m?.[1]}'`).toBe(true);
      }
    }
  });

  it("profile:* values have no shell-injection surface", () => {
    const scripts = readScripts();
    const keys = profileKeys(scripts);
    expect(keys.length, "profile:* keys phải tồn tại để pin này có ý nghĩa").toBeGreaterThan(0);
    for (const key of keys) {
      const v = scripts[key] ?? "";
      expect(v).not.toMatch(/[`$]/); // no backticks, no $(...)
      expect(v).not.toMatch(/[;|><]/);
      expect(v).toMatch(/^npm[^`]*$/);
    }
  });

  it("baseline + verify pins preserved byte-identical (ARP-09 regression guard)", () => {
    const scripts = readScripts();
    for (const [k, v] of Object.entries(expectedPinnedScripts)) {
      expect(scripts[k], `script '${k}' must stay byte-identical`).toBe(v);
    }
  });

  it("contributes.configuration.properties does NOT add UnicDB.diagnostics.verbosity (YAGNI rejection — PLAN §3)", () => {
    const pkg = readJson<ScriptsPackageJson>("package.json");
    const props = pkg.contributes?.configuration?.properties ?? {};
    expect(Object.keys(props)).not.toContain("UnicDB.diagnostics.verbosity");
  });
});
