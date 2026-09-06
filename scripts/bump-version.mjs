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
const mode = args.find((a) => !a.startsWith("--")) ?? "patch";

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

// ─── 6. next steps ───────────────────────────────────────────────────────
step("6. next steps");
const lines = [
  `# commit the bump`,
  `git add -A`,
  `git commit -m "release: ${newVersion}"`,
  ``,
  `# publish to VS Code Marketplace (PAT must be in Keychain: vsce login lengockhoa)`,
  `#   -- when package.json was already bumped manually, use \`vsce publish\` (no level)`,
  `#   -- when bumping from this script, use \`vsce publish patch\` (since pkg.json is now ${newVersion})`,
  `npx vsce publish patch`,
  ``,
  `# OR push tag + attach .vsix to GitHub release (does NOT publish to Marketplace)`,
  `git tag v${newVersion}`,
  `git push origin v${newVersion}`,
];
console.log(lines.join("\n"));

console.log(`\n✓ bump-version: ${oldVersion} → ${newVersion} complete`);
