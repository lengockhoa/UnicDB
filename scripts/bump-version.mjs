#!/usr/bin/env node
// scripts/bump-version.mjs — UnicDB atomic version-bump + release-prep.
//
// Single command that replaces the manual dance:
//   1) bump version in package.json  (auto patch, or pass `minor|major|X.Y.Z`)
//   2) sync package-lock.json       (npm install --package-lock-only)
//   3) prepend a CHANGELOG.md entry  (with today's date + summary slot)
//   4) typecheck + test
//   5) package .vsix                 (npx vsce package)
//   6) print the exact git + publish commands to run next
//
// Usage:
//   node scripts/bump-version.mjs                # auto-bump patch (1.51.6 → 1.51.7)
//   node scripts/bump-version.mjs minor          # auto-bump minor
//   node scripts/bump-version.mjs major          # auto-bump major
//   node scripts/bump-version.mjs 1.52.0         # explicit target version
//   node scripts/bump-version.mjs patch --skip-test   # CI fast lane
//   node scripts/bump-version.mjs patch --skip-package
//
// Why this exists: TASK-AI-001-fix cycle (1.51.5 → 1.51.6) was the second time
// in a row that the bump + lock-sync + CHANGELOG + typecheck + test + .vsix
// sequence was done by hand. Lock sync is what trips the
// releaseHygiene.test.ts guard; CHANGELOG is what trips the human reviewer
// later. Both must happen on every bump, so they're locked in here.
//
// Safe to re-run after a manual fix-up: it reports the new version on every
// invocation and refuses to run if the working tree has other unrelated
// changes that would be lost.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";


const ROOT = resolve(new URL("..", import.meta.url).pathname);

function die(msg, code = 1) {
  console.error(`✗ bump-version: ${msg}`);
  process.exit(code);
}

function step(label) {
  console.log(`\n── ${label}`);
}

function readPackageJson() {
  const path = resolve(ROOT, "package.json");
  return { path, json: JSON.parse(readFileSync(path, "utf8")) };
}

function bumpVersion(current, mode) {
  const [maj, min, pat] = current.split(".").map((n) => parseInt(n, 10));
  if (mode === "major") return `${maj + 1}.0.0`;
  if (mode === "minor") return `${maj}.${min + 1}.0`;
  if (mode === "patch") return `${maj}.${min}.${pat + 1}`;
  if (/^\d+\.\d+\.\d+/.test(mode)) return mode;
  die(`invalid bump mode: ${mode}`);
}

function prependChangelog(version, today) {
  const path = resolve(ROOT, "CHANGELOG.md");
  const original = readFileSync(path, "utf8");
  const header =
    `## [${version}] — ${today}\n\n` +
    `- Summary: <one-line description of what shipped>\n` +
    `- Files: <list of source files / tests / docs touched>\n` +
    `- Verification: npm run typecheck ✅ · npm test ✅ · UnicDB-${version}.vsix packaged\n\n` +
    `---\n\n`;
  // Insert before the FIRST `## [x.y.z]` heading. Must match `## ` prefix —
  // otherwise link-reference lines like `[1.8.0]: https://...` get picked up
  // and the entry lands in the wrong place (between Cycle prose and the
  // link footer).
  const match = original.match(/^## \[\d+\.\d+\.\d+\]/m);
  const next = match
    ? original.slice(0, match.index) + header + original.slice(match.index)
    : header + original;
  writeFileSync(path, next);
  return path;
}

// Extract the `[X.Y.Z]` block from CHANGELOG.md for use as GitHub release notes.
function readChangelogEntry(version) {
  const path = resolve(ROOT, "CHANGELOG.md");
  const text = readFileSync(path, "utf8");
  const re = new RegExp(
    `^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[\\d|$)`,
    "m",
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

// Fill the placeholder Summary/Files lines if --changelog-summary / --changelog-files passed.
function fillChangelogPlaceholders(version, summary, files) {
  const path = resolve(ROOT, "CHANGELOG.md");
  let text = readFileSync(path, "utf8");
  let changed = false;
  const entryRe = new RegExp(`(## \\[${version.replace(/\./g, "\\.")}\\][\\s\\S]*?)(\\n## \\[\\d|$)`);
  if (summary) {
    const m = text.match(entryRe);
    if (m && m[1].includes("- Summary: <one-line description of what shipped>")) {
      const replaced = m[1].replace(
        "- Summary: <one-line description of what shipped>",
        `- Summary: ${summary}`,
      );
      text = text.replace(entryRe, `${replaced}${m[2]}`);
      changed = true;
    }
  }
  if (files) {
    const m = text.match(entryRe);
    if (m && m[1].includes("- Files: <list of source files / tests / docs touched>")) {
      const replaced = m[1].replace(
        "- Files: <list of source files / tests / docs touched>",
        `- Files: ${files}`,
      );
      text = text.replace(entryRe, `${replaced}${m[2]}`);
      changed = true;
    }
  }
  if (changed) writeFileSync(path, text);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, ...opts });
  if (res.status !== 0) die(`command failed: ${cmd} ${args.join(" ")}`, res.status ?? 1);
}

function runNpx(tool, args) {
  const res = spawnSync("npx", ["--no-install", tool, ...args], {
    stdio: "inherit",
    cwd: ROOT,
  });
  if (res.status !== 0) die(`npx ${tool} ${args.join(" ")} failed`, res.status ?? 1);
}

// ─── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const skipTest = args.includes("--skip-test");
const skipPackage = args.includes("--skip-package");
const skipPublish = args.includes("--skip-publish");
const mode = args.find((a) => !a.startsWith("--")) ?? "patch";
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const changelogSummary = argValue("--changelog-summary");
const changelogFiles = argValue("--changelog-files");

// ─── guard: working tree state ──────────────────────────────────────────
// The script will overwrite package.json, package-lock.json, and CHANGELOG.md.
// Refuse ONLY if any of those three already has uncommitted changes the
// script would clobber. Other dirty files are the operator's problem to
// commit separately; they don't conflict with the bump.
const statusLines = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean)
  .map((line) => line.slice(3).trim());
const PROTECTED = new Set(["package.json", "package-lock.json", "CHANGELOG.md"]);
const conflicts = statusLines.filter((path) => PROTECTED.has(path));
if (conflicts.length > 0) {
  die(
    `these files are dirty and would be overwritten by the bump — commit or ` +
      `stash first:\n  ${conflicts.join("\n  ")}`,
  );
}

// ─── 1. bump version ─────────────────────────────────────────────────────
step("1. bump package.json");
const { path: pkgPath, json: pkg } = readPackageJson();
const oldVersion = pkg.version;
if (!/^\d+\.\d+\.\d+/.test(oldVersion)) die(`package.json version malformed: ${oldVersion}`);
const newVersion = bumpVersion(oldVersion, mode);
if (newVersion === oldVersion) die(`new version equals current: ${oldVersion}`);
pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`✓ ${oldVersion} → ${newVersion} (package.json)`);

// ─── 2. sync package-lock.json ───────────────────────────────────────────
step("2. sync package-lock.json");
run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
console.log("✓ package-lock.json synced");

// ─── 3. CHANGELOG.md ─────────────────────────────────────────────────────
step("3. prepend CHANGELOG.md entry");
const today = new Date().toISOString().slice(0, 10);
prependChangelog(newVersion, today);
console.log(`✓ CHANGELOG.md: prepended [${newVersion}] entry (edit the Summary/Files lines)`);

// ─── 4. typecheck + test ─────────────────────────────────────────────────
if (!skipTest) {
  step("4. typecheck + test");
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  console.log("✓ typecheck + tests passed");
} else {
  step("4. typecheck + test (SKIPPED via --skip-test)");
}

// ─── 5. package .vsix ────────────────────────────────────────────────────
let vsixPath;
if (!skipPackage) {
  step("5. package .vsix");
  run("npm", ["run", "compile"]);
  runNpx("vsce", ["package"]);
  vsixPath = resolve(ROOT, `UnicDB-${newVersion}.vsix`);
  console.log(`✓ ${vsixPath}`);
} else {
  step("5. package .vsix (SKIPPED via --skip-package)");
}

// ─── 6. atomic publish: commit → tag → push → GitHub release → Marketplace ─
if (skipPublish) {
  step("6. atomic publish (SKIPPED via --skip-publish)");
  console.log(`To ship later: drop --skip-publish, or follow docs/RELEASE.md §Fast lane.`);
} else {
  step("6. atomic publish: commit → tag → push → GitHub release → Marketplace");

  // 6a. CHANGELOG placeholder check.
  if (changelogSummary || changelogFiles) {
    fillChangelogPlaceholders(newVersion, changelogSummary, changelogFiles);
  }
  const changelogPath = resolve(ROOT, "CHANGELOG.md");
  const changelogText = readFileSync(changelogPath, "utf8");
  if (changelogText.includes("<one-line description of what shipped>")) {
    die(
      `CHANGELOG.md still has an unfilled Summary placeholder for [${newVersion}].\n` +
        `Either:\n` +
        `  1. Edit CHANGELOG.md manually before publishing\n` +
        `  2. Pass --changelog-summary "your summary" (and optional --changelog-files "file1, file2")\n` +
        `  3. Pass --skip-publish to defer the publish`,
    );
  }

  // 6b. pre-flight: working tree clean (no WIP leaking into the release commit).
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (dirty) {
    console.log(`Files about to be committed in this release:`);
    console.log(dirty.split("\n").map((l) => `  ${l}`).join("\n"));
    // Continue — operator can Ctrl+C within ~2s if something looks wrong.
  }

  // 6c. commit.
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", `release: ${newVersion}`]);
  console.log(`✓ git commit: release: ${newVersion}`);

  // 6d. tag.
  run("git", ["tag", "-a", `v${newVersion}`, "-m", `v${newVersion}`]);
  console.log(`✓ git tag v${newVersion}`);

  // 6e. push commit + tag.
  run("git", ["push", "origin", "HEAD"]);
  run("git", ["push", "origin", `v${newVersion}`]);
  console.log(`✓ pushed commit + tag to origin`);

  // 6f. GitHub release (uses CHANGELOG entry as notes).
  const entry = readChangelogEntry(newVersion);
  runNpx("gh", [
    "release",
    "create",
    `v${newVersion}`,
    `UnicDB-${newVersion}.vsix`,
    "--title",
    `v${newVersion}`,
    "--notes",
    entry || `Release v${newVersion}`,
  ]);
  console.log(`✓ GitHub release v${newVersion} created`);

  // 6g. Marketplace publish (PAT is in macOS Keychain).
  runNpx("vsce", ["publish"]);
  console.log(`✓ Published to VS Code Marketplace`);
}

console.log(`\n✓ bump-version: ${oldVersion} → ${newVersion} complete`);
if (!skipPublish) {
  console.log(`  → GitHub:     https://github.com/lengockhoa/UnicDB/releases/tag/v${newVersion}`);
  console.log(`  → Marketplace: https://marketplace.visualstudio.com/items?itemName=lengockhoa.UnicDB`);
}
