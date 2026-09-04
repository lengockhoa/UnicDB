// src/adapters/__tests__/bq04SurfaceGuard.test.ts
//
// TASK-BQ04-003 proof: the BQ frozen surfaces are byte-untouched relative to
// the v1.50.0 release snapshot (`75cdb08`). This is a guard-only task — the
// tests fail the moment ANY frozen file is edited relative to that base.
//
// Frozen surfaces (NON-NEGOTIABLE):
//  - BQ-00: src/adapters/bigqueryTypes.ts, src/adapters/bigqueryAdc.ts
//  - BQ-01: src/adapters/types.ts (BigQueryClientLike + BatchedQuery)
//  - deps:  package.json dependency manifest (no new/removed/upgraded
//           deps, @google-cloud/bigquery stays 9.0.3). The top-level
//           `version` line, the `commands` array, the `menus` entries,
//           and any non-dependency contributes are intentionally NOT
//           frozen — every release cycle can bump `version` and add new
//           command/menu contributions (this guard exists to catch
//           ADAPTER drift, not version/contributes drift).
//
// Test cases (TDD):
//  1. BQ-00 surface byte-untouched vs v1.50.0 (primary, regression)
//  2. BigQueryClientLike + BatchedQuery unchanged (regression)
//  3. package.json dependency manifest unchanged (regression)
//
// A `sanity check` block at the end runs the same execSync call against an
// obviously-different ref (HEAD) to prove the assertion isn't a tautology:
// if `git diff` is wired up correctly, a ref with real edits must produce
// NON-empty stdout.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BASE_REF = "75cdb08";

function gitDiff(ref: string, paths: readonly string[]): string {
  // `git -C <repoRoot>` makes the call independent of the harness cwd.
  // `encoding: "utf8"` returns a string so trim() works directly.
  // `stdio: ["ignore", "pipe", "pipe"]` keeps stderr from leaking on stderr.
  const quoted = paths.map((p) => `"${p}"`).join(" ");
  return execSync(`git -C "${REPO_ROOT}" diff ${ref} -- ${quoted}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Strip version bumps and non-dependency contributes from a `package.json`
 * diff. Every release cycle:
 *  - bumps `version` from one cycle to the next (intentional);
 *  - may add new command palette entries / menu bindings for new features
 *    (intentional, e.g. `vsdb.openConsoleForObject` shipped after BQ-04).
 * The guard exists to catch ADAPTER drift (new / removed / upgraded
 * dependencies, @google-cloud/bigquery version drift), not version or
 * contributes drift. Returns the +/- lines that remain after filtering;
 * the test asserts that set is empty.
 *
 * Implementation: drop any +/- line whose key is one of the contributes
 * keys (`command`, `title`, `category`, `icon`, `when`, `group`,
 * `keybinding`, `mac`, `win`, `linux`) when the line is part of a command
 * block or menu binding. The simpler approach — filter by a single
 * `+/- "command": "vsdb.X",` anchor — works for the command block but
 * misses the surrounding `title`/`category`/`icon`/`when`/`group` lines
 * that live in the same diff hunk. Filtering on a whitelist of safe
 * contributes keys covers both the command palette block and the menu
 * binding block in one pass.
 */
function packageJsonDepsDiff(ref: string): string {
  const raw = gitDiff(ref, ["package.json"]);
  // Keys that are part of command palette entries or menu bindings. ANY
  // +/- line with one of these keys is treated as a non-dependency
  // contributes change and dropped. The dependency manifest (deps,
  // devDependencies, peerDependencies, engines) uses different keys and
  // is never matched here.
  const contributesKeyPattern =
    /^[+-]\s+"(command|title|category|icon|when|group|order|keybinding|mac|win|linux)":/;
  // Menu block headers (`"webview/<id>/context":`, `"view/title":`,
  // `"editor/title":`, ...) appear on their own lines as the JSON key of
  // the contributes.menus map. Drop them too — they are part of the
  // contributes surface, not the dependency manifest. The key is anchored
  // to a whitelist of known contributes.menus sub-keys (`webview/`,
  // `view/`, `editor/`, `scm/`, `file/`, `commandPalette`, `menus`) so
  // this filter can never silently drop a top-level package.json key
  // like `"dependencies":` or `"devDependencies":` that happens to end
  // in `": {`. The JSON key is followed by `": [` (or `": {` for nested
  // menus), which the regex tolerates via `\s*[?[{]?\s*$`.
  const contributesMenuKeyPattern =
    /^[+-]\s+"(webview\/[a-zA-Z0-9/._-]+|view\/[a-zA-Z0-9/._-]+|editor\/[a-zA-Z0-9/._-]+|scm\/[a-zA-Z0-9/._-]+|file\/[a-zA-Z0-9/._-]+|commandPalette|menus)":\s*[?[{]?\s*$/;
  // TASK-UX1-006 (R8a) — extension 1: `activationEvents` lines of the
  // shape `+        "onCommand:vsdb.<id>",` are non-dependency contributes
  // (UX1 tasks add new onCommand activation events). Anchored to the FULL
  // line shape so unrelated `onCommand:` strings in dependencies/scripts
  // never match.
  const onCommandLinePattern =
    /^[+-]\s+"onCommand:[a-zA-Z0-9.]+",?\s*$/;
  // Drop the block delimiters (`{` / `}`) that wrap a contributes hunk —
  // they carry no dependency info and only show up because the
  // command/menu lines they bracket were added.
  const bareBlockDelimiter = /^[+-]\s*[{}]\s*,?\s*$/;
  // Drop standalone opening `[` / closing `]` of a menu entries block
  // (the key itself is filtered above; the bracket is not).
  const bareListDelimiter = /^[+-]\s*\[\s*,?\s*$/;
  const bareListClose = /^[+-]\s*\]\s*,?\s*$/;

  // TASK-UX1-006 (R8a) — extension 2: a `vsdb.<dotted.id>` configuration
  // PROPERTY KEY opens a sub-block whose content is non-dependency
  // contributes. To detect when a +/- line is INSIDE such a block we
  // need to know the property block's line range in the SOURCE file
  // (a block can contain +/- changes that affect only the inner
  // content, leaving the property key line itself as a context line —
  // no `+`/`-` for the key, but plenty of `+`/`-` for the values).
  //
  // Approach: parse the package.json at the BASE_REF and at the
  // current commit to find every `vsdb.<dotted>` property key and the
  // line range of its block (open `{` line through matching close `}`
  // line). Then walk the diff hunk headers to translate each `+`/`-`
  // line to its corresponding line number in the new (or old) file;
  // any line that falls inside a `vsdb.*` property block range in the
  // respective file is dropped. The negative-control tests
  // (dependencies / devDependencies / peerDependencies) have ranges
  // that do NOT intersect with the vsdb block set, so they keep
  // firing the guard.
  const newFileLines = readCurrentPackageJsonLines();
  const oldFileLines = readPackageJsonAtRef(ref);
  const newVsdbBlockRanges = findVsdbPropertyBlockRanges(newFileLines);
  const oldVsdbBlockRanges = findVsdbPropertyBlockRanges(oldFileLines);

  const inNewVsdbBlock = new Set<number>();
  for (const { start, end } of newVsdbBlockRanges) {
    for (let n = start; n <= end; n++) inNewVsdbBlock.add(n);
  }
  const inOldVsdbBlock = new Set<number>();
  for (const { start, end } of oldVsdbBlockRanges) {
    for (let n = start; n <= end; n++) inOldVsdbBlock.add(n);
  }

  const lines = raw.split("\n");
  // Only +/- content lines (and hunk-relative metadata we use for line
  // tracking) are processed; everything else is dropped. This matches
  // the pre-UX1-006 contract: the filtered result is the +/- diff.
  const hunkHeaderRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let newLine = 0;
  let oldLine = 0;
  const out: string[] = [];
  for (const line of lines) {
    const m = hunkHeaderRe.exec(line);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      continue;
    }
    if (line.startsWith(" ")) {
      newLine += 1;
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      // Diff metadata header `+++ b/<file>` — NOT an addition line.
      if (line.startsWith("+++ ")) continue;
      // A `+` line: present at `newLine` in the NEW file.
      if (inNewVsdbBlock.has(newLine)) {
        // Inside a `vsdb.*` configuration property block — non-dependency
        // contributes. Drop.
        newLine += 1;
        continue;
      }
      if (
        /^[+-]\s+"version":\s+"[^"]+",?\s*$/.test(line) ||
        contributesKeyPattern.test(line) ||
        contributesMenuKeyPattern.test(line) ||
        onCommandLinePattern.test(line) ||
        bareBlockDelimiter.test(line) ||
        bareListDelimiter.test(line) ||
        bareListClose.test(line)
      ) {
        newLine += 1;
        continue;
      }
      out.push(line);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      // Diff metadata header `--- a/<file>` — NOT a deletion line.
      if (line.startsWith("--- ")) continue;
      // A `-` line: present at `oldLine` in the OLD file only.
      if (inOldVsdbBlock.has(oldLine)) {
        continue;
      }
      if (
        /^[+-]\s+"version":\s+"[^"]+",?\s*$/.test(line) ||
        contributesKeyPattern.test(line) ||
        contributesMenuKeyPattern.test(line) ||
        onCommandLinePattern.test(line) ||
        bareBlockDelimiter.test(line) ||
        bareListDelimiter.test(line) ||
        bareListClose.test(line)
      ) {
        continue;
      }
      out.push(line);
      continue;
    }
    // Blank / metadata / anything else: drop (matches pre-UX1-006
    // behavior — the function returns ONLY +/- lines).
  }
  return out.join("\n");
}

/**
 * Read the current `package.json` from disk and return its lines.
 * Exposed for the test mirror below.
 */
function readCurrentPackageJsonLines(): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  return fs.readFileSync("package.json", "utf8").split("\n");
}

/**
 * Read `package.json` at the given git ref into lines. Used to translate
 * OLD-side `-` line numbers in the diff to the OLD file's
 * `vsdb.*` property block ranges.
 */
function readPackageJsonAtRef(ref: string): string[] {
  const out = execSync(`git -C "${REPO_ROOT}" show ${ref}:package.json`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.split("\n");
}

/**
 * Scan the current package.json lines and return every `vsdb.<dotted.id>`
 * configuration property block as `{ keyLine, start, end }` where:
 *  - `keyLine` is the 1-based line number of `"vsdb.<id>": {`
 *  - `start`   is the 1-based line number of the opening `{` line (== keyLine)
 *  - `end`     is the 1-based line number of the matching closing `}`
 *
 * Implemented as a brace-depth scan restricted to lines whose leading
 * key matches the `vsdb.` prefix. A bare `": {` catch-all is intentionally
 * avoided — `dependencies`, `devDependencies`, and `peerDependencies`
 * must NOT be in the returned ranges.
 */
function findVsdbPropertyBlockRanges(
  fileLines: string[],
): Array<{ keyLine: number; start: number; end: number }> {
  const ranges: Array<{ keyLine: number; start: number; end: number }> = [];
  const keyRe = /^\s*"(vsdb\.[a-zA-Z0-9.]+)"\s*:\s*\{/;
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i]!;
    const m = keyRe.exec(line);
    if (!m) continue;
    const startLine = i + 1; // 1-based
    // Walk forward tracking brace depth, starting at depth 1 (the
    // opening `{` on this line).
    let depth =
      (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) {
      // Single-line block — close immediately.
      ranges.push({ keyLine: startLine, start: startLine, end: startLine });
      continue;
    }
    let j = i + 1;
    while (j < fileLines.length && depth > 0) {
      const next = fileLines[j]!;
      depth += (next.match(/\{/g) ?? []).length - (next.match(/\}/g) ?? []).length;
      j += 1;
    }
    const endLine = j; // 1-based line of the line AFTER the closing `}`
    // `endLine` is the line just after the close; the close itself is
    // endLine - 1. We want the range to include the close, so:
    ranges.push({ keyLine: startLine, start: startLine, end: endLine - 1 });
    i = j - 1;
  }
  return ranges;
}

describe(`TASK-BQ04-003 frozen-surface guard (base ${BASE_REF})`, () => {
  it("1. BQ-00 surface byte-untouched vs v1.50.0", () => {
    const out = gitDiff(BASE_REF, [
      "src/adapters/bigqueryTypes.ts",
      "src/adapters/bigqueryAdc.ts",
    ]);
    expect(out.trim()).toBe("");
  });

  it("2. BigQueryClientLike + BatchedQuery unchanged", () => {
    const out = gitDiff(BASE_REF, ["src/adapters/types.ts"]);
    expect(out.trim()).toBe("");
  });

  it("3. package.json dependency manifest unchanged (version bumps are allowed)", () => {
    // Release-time version bump is intentional — see packageJsonDepsDiff.
    // We assert the +/- set is empty AFTER dropping the version line.
    const filtered = packageJsonDepsDiff(BASE_REF);
    expect(filtered).toBe("");
  });
});

// =============================================================================
// TASK-UX1-006 (R8a) — extend the packageJsonDepsDiff filter so that
// `activationEvents` lines (`onCommand:vsdb.foo`) and `contributes.configuration`
// property keys (`"vsdb.foo": {`) are recognised as non-dependency
// contributes — required BEFORE any later UX1 task edits package.json
// contributes/activationEvents.
//
// The extension is two narrow whitelists, anchored to the EXACT shapes:
//   1. `^[+-]\s+"onCommand:[a-zA-Z0-9.]+",?\s*$`   (single-line activation
//      event lines — full match including the optional trailing comma).
//   2. `"vsdb\.[a-zA-Z0-9.]+"\s*:\s*\{`           (configuration property
//      keys INSIDE the contributes.configuration block; the block
//      delimiters are already dropped by the existing filter).
//
// These are pinned by a pure-function test that re-implements the filter
// in-place (avoids git wiring) and asserts:
//   - synthetic diffs containing ONLY the whitelisted lines filter to EMPTY;
//   - a synthetic `+  "dependencies": {` line STILL FAILS the filter
//     (negative control — the guard must still bite on real dependency drift).
// =============================================================================
describe("TASK-UX1-006 — packageJsonDepsDiff filter extension (R8a)", () => {
  /**
   * Mirror of `packageJsonDepsDiff`'s filter logic, but operates on a
   * caller-supplied raw diff string (no git wiring). Any change to the
   * production filter MUST be mirrored here to keep this test honest.
   *
   * Mirror strategy: for synthetic diffs (which DO include a `vsdb.X`
   * property key line), use the simpler "stripped-line" detection
   * (vsdb.X: { opens a block, `}` closes it) — this matches the
   * production filter's intent for synthetic inputs where the property
   * key itself appears in the diff. The production filter additionally
   * consults the live package.json file for cases where the property
   * key is a context line and only inner content is +/-, but those
   * cases are not exercised by the synthetic tests below.
   */
  function filterRawDiff(raw: string): string {
    const contributesKeyPattern =
      /^[+-]\s+"(command|title|category|icon|when|group|order|keybinding|mac|win|linux)":/;
    const contributesMenuKeyPattern =
      /^[+-]\s+"(webview\/[a-zA-Z0-9/._-]+|view\/[a-zA-Z0-9/._-]+|editor\/[a-zA-Z0-9/._-]+|scm\/[a-zA-Z0-9/._-]+|file\/[a-zA-Z0-9/._-]+|commandPalette|menus)":\s*[?[{]?\s*$/;
    const onCommandLinePattern =
      /^[+-]\s+"onCommand:[a-zA-Z0-9.]+",?\s*$/;
    const configPropertyKeyPattern = /^\s*"?vsdb\.[a-zA-Z0-9.]+"?\s*:\s*\{/;
    const bareBlockDelimiter = /^[+-]\s*[{}]\s*,?\s*$/;
    const bareListDelimiter = /^[+-]\s*\[\s*,?\s*$/;
    const bareListClose = /^[+-]\s*\]\s*,?\s*$/;

    const lines = raw.split("\n");
    const insideBlock: boolean[] = new Array(lines.length).fill(false);
    let openDepth = 0;
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (inBlock) {
        const stripped = line.replace(/^[ +\-]/, "");
        const opens = (stripped.match(/\{/g) ?? []).length;
        const closes = (stripped.match(/\}/g) ?? []).length;
        openDepth += opens - closes;
        insideBlock[i] = true;
        if (openDepth <= 0) {
          inBlock = false;
          openDepth = 0;
        }
        continue;
      }
      const stripped = line.replace(/^[ +\-]/, "");
      if (configPropertyKeyPattern.test(stripped)) {
        const opens = (stripped.match(/\{/g) ?? []).length;
        const closes = (stripped.match(/\}/g) ?? []).length;
        openDepth = opens - closes;
        inBlock = true;
        insideBlock[i] = true;
        if (openDepth <= 0) {
          inBlock = false;
          openDepth = 0;
        }
      }
    }

    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!/^[+-] [^]/.test(line)) {
        out.push(line);
        continue;
      }
      if (insideBlock[i]) continue;
      if (
        /^[+-]\s+"version":\s+"[^"]+",?\s*$/.test(line) ||
        contributesKeyPattern.test(line) ||
        contributesMenuKeyPattern.test(line) ||
        onCommandLinePattern.test(line) ||
        bareBlockDelimiter.test(line) ||
        bareListDelimiter.test(line) ||
        bareListClose.test(line)
      ) {
        continue;
      }
      out.push(line);
    }
    return out.join("\n");
  }

  it("T-UX1-006 #7a — activationEvents + configuration property lines are filtered (empty remaining diff)", () => {
    const synthetic = [
      '+      "onCommand:vsdb.openUserGuide",',
      '+      "onCommand:vsdb.runStatement",',
      '+      "vsdb.resultsPlacement": {',
      '+        "type": "string",',
      '+        "enum": [',
      '+          "below",',
      '+          "beside",',
      '+          "top"',
      '+        ],',
      '+        "default": "below"',
      '+      },',
      '+      "vsdb.showRunLens": {',
      '+        "type": "boolean"',
      '+      }',
    ].join("\n");
    expect(filterRawDiff(synthetic)).toBe("");
  });

  it("T-UX1-006 #7b — `+  \"dependencies\": {` is NOT filtered (negative control: guard must still bite)", () => {
    const synthetic = [
      '+  "dependencies": {',
      '+    "@google-cloud/bigquery": "^10.0.0"',
      '+  }',
    ].join("\n");
    const remaining = filterRawDiff(synthetic);
    expect(remaining).toContain('"dependencies":');
    // The full diff survives — the guard would fire on this in production.
    expect(remaining.trim().length).toBeGreaterThan(0);
  });

  it("T-UX1-006 #7c — bare `': {'` in a non-vsdb key is NOT filtered (anchored to `vsdb.`) ", () => {
    const synthetic = [
      '+  "devDependencies": {',
      '+    "typescript": "^5.5.0"',
      '+  }',
    ].join("\n");
    const remaining = filterRawDiff(synthetic);
    expect(remaining).toContain('"devDependencies":');
    expect(remaining.trim().length).toBeGreaterThan(0);
  });

  it("T-UX1-006 #7d — bare 'onCommand:' without the `vsdb.` prefix is NOT filtered (anchored shape)", () => {
    // The activationEvents whitelist matches the full line shape
    // `+        "onCommand:vsdb.X",` — a generic `onCommand:` key outside
    // the activationEvents block (e.g. an unrelated package.json key
    // shape) must NOT be silently dropped.
    const synthetic = [
      '+    "onCommand:unrelatedpkg.doSomething": "handler.js"',
    ].join("\n");
    const remaining = filterRawDiff(synthetic);
    // The onCommand anchor in the test filter requires the FULL line shape
    // (start with `+ "onCommand:..."` then optional comma then EOL). The
    // line above has additional content after the closing quote, so it
    // must survive the filter.
    expect(remaining).toContain("onCommand:unrelatedpkg.doSomething");
  });
});

// Sanity check: the assertion `diff === ""` is only meaningful if execSync
// actually returns a non-empty string for refs that DO differ. This block
// proves the wiring is live (not a tautology).
//
// The release series between BASE_REF~1 and BASE_REF is known to touch
// CHANGELOG.md (the R5 commit's entire purpose). We use `git diff
// BASE_REF~1..BASE_REF -- CHANGELOG.md` (two-dot range) to produce a
// guaranteed non-empty diff. This is independent of rows 1-3 (which use
// `git diff BASE_REF -- <path>` against frozen surfaces) and proves that
// the same execSync wiring returns a non-empty string when the inputs
// actually differ.
describe("sanity check (proves the assertion is not tautological)", () => {
  it("execSync returns NON-empty for a ref range that actually differs", () => {
    const quoted = `"CHANGELOG.md"`;
    const out = execSync(
      `git -C "${REPO_ROOT}" diff ${BASE_REF}~1..${BASE_REF} -- ${quoted}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    expect(out.trim().length).toBeGreaterThan(0);
    // Log for the Executor Report / reviewer.
    // eslint-disable-next-line no-console
    console.info(
      `[bq04-guard] sanity diff vs ${BASE_REF}~1..${BASE_REF} on CHANGELOG.md: ${out.trim().split("\n").length} non-empty lines (proves execSync is live)`
    );
  });
});