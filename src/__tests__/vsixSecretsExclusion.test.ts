// src/__tests__/vsixSecretsExclusion.test.ts
//
// v1.53.33 regression guard — the `.secrets/` folder (Marketplace publish PAT
// cache, see docs/MEMORY.md §Active Constraints) MUST NEVER end up inside
// the packaged .vsix. `vsce package` does NOT read `.gitignore` — it reads
// `.vscodeignore` exclusively. If the .vscodeignore entry is ever removed,
// the Azure DevOps PAT inside `.secrets/.pat` ships to every user who
// installs the extension (full publisher-account compromise).
//
// We pin the .vscodeignore rule statically + run a real `vsce package`
// pass on a tmp staging copy and assert no `.secrets/` directory appears
// in the produced archive. The tmp-staging copy is needed because the
// production `.vscodeignore` lives at repo root, but our test runner is
// rooted in the same repo — a real package there would race with
// concurrent test runs and pollute the working tree.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..", "..");
const VSIXIGNORE = path.join(repoRoot, ".vscodeignore");

describe("vsix secrets exclusion", () => {
  it(".vscodeignore contains .secrets/** exclusion", () => {
    // Static pin. If this line is removed, the rest of the test
    // (real-package round-trip) will also fail.
    const content = fs.readFileSync(VSIXIGNORE, "utf-8");
    expect(content, ".vscodeignore must exclude .secrets/**").toMatch(
      /^\.secrets\/\*\*/m,
    );
  });

  it("a freshly packaged .vsix does NOT contain the .secrets folder (real vsce round-trip)", () => {
    // Stage a tmp copy of the repo so the real .vsixignore + .secrets/.pat
    // get exercised, but our package run can't collide with anything else.
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "unicdb-vsixcheck-"));
    try {
      // Stage a minimal UnicDB-shaped directory: vsce reads package.json
      // from the cwd and packages everything except .vscodeignore rules.
      // We plant `.secrets/.pat` to verify the `.secrets/**` rule fires.
      fs.copyFileSync(VSIXIGNORE, path.join(stage, ".vscodeignore"));
      fs.mkdirSync(path.join(stage, ".secrets"), { recursive: true });
      fs.writeFileSync(path.join(stage, ".secrets", ".pat"), "FAKE-PAT-FOR-TEST");
      fs.writeFileSync(
        path.join(stage, "package.json"),
        JSON.stringify({
          name: "unicdb-vsixcheck",
          version: "9.9.9-test",
          publisher: "test",
          displayName: "VSIX Check",
          description: "test",
          engines: { vscode: "^1.75.0" },
          main: "extension.js",
          activationEvents: ["*"],
          contributes: {},
        }),
      );
      fs.writeFileSync(path.join(stage, "extension.js"), "// stub");
      // Run vsce package from the staged root. The `.vscodeignore` rule
      // for `.secrets/**` MUST filter the fake PAT out of the archive.
      execFileSync(
        "node",
        [path.join(repoRoot, "node_modules", ".bin", "vsce"), "package", "--no-dependencies", "--allow-missing-repository"],
        { cwd: stage, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
      );
      // Locate the produced .vsix (vsce names it <publisher>.<name>-<version>.vsix).
      const vsixFiles = fs.readdirSync(stage).filter((f) => f.endsWith(".vsix"));
      expect(vsixFiles.length, "vsce must produce exactly one .vsix").toBe(1);
      const vsixPath = path.join(stage, vsixFiles[0]);
      // Use `unzip -l` (POSIX) to list archive entries without extracting.
      const listing = execFileSync("unzip", ["-l", vsixPath], {
        encoding: "utf-8",
      });
      // The .secrets directory MUST be absent — neither the .pat file nor
      // any sub-path of `.secrets/` may appear in the archive.
      expect(
        listing,
        ".vsix contains a .secrets entry — vsce is packaging the PAT cache!",
      ).not.toMatch(/\.secrets\//);
      expect(
        listing,
        ".vsix contains .pat at any path",
      ).not.toMatch(/\.pat(\s|$)/);
    } finally {
      // Best-effort cleanup. macOS tmpdir is rotated automatically; we
      // additionally nuke the staging dir when possible.
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch {
        // ignore — tmpdir sweep will catch it
      }
    }
  }, 120_000);
});
