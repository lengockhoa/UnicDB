// src/__tests__/releaseHygiene.test.ts
// Release hygiene guards (TASK-703):
//   - lock root version phải khớp package.json version (no hardcoded version).
//   - README giữ pattern install `vsdb-<version>.vsix`.
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

  it("README giữ pattern install vsdb-<version>.vsix", () => {
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf-8");
    // README phải giữ placeholder '<version>' (không hardcode số) để bump version
    // không phải sửa README. Test đọc từ file — không hardcode version cụ thể.
    expect(
      readme,
      "README phải chứa pattern 'vsdb-<version>.vsix' (placeholder, không hardcode số)",
    ).toContain("vsdb-<version>.vsix");
  });

  it("package.json version match semver X.Y.Z (3 thành phần số)", () => {
    const pkg = readJson<PackageJson>("package.json");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
