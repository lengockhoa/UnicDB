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
    /^[+-]\s+"(command|title|category|icon|when|group|keybinding|mac|win|linux)":/;
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
  return raw
    .split("\n")
    .filter(
      (line) =>
        /^[+-] [^]/.test(line) && // keep only add/remove content lines
        !/^[+-]\s+"version":\s+"[^"]+",?\s*$/.test(line) && // drop version bump
        !contributesKeyPattern.test(line) && // drop command/menu/keybinding contributes
        !contributesMenuKeyPattern.test(line) && // drop menu block headers
        // Drop the block delimiters (`{` / `}`) that wrap a contributes
        // hunk — they carry no dependency info and only show up because
        // the command/menu lines they bracket were added.
        !/^[+-]\s*[{}]\s*,?\s*$/.test(line) &&
        // Drop standalone opening `[` / closing `]` of a menu entries
        // block (the key itself is filtered above; the bracket is not).
        !/^[+-]\s*\[\s*,?\s*$/.test(line) &&
        !/^[+-]\s*\]\s*,?\s*$/.test(line)
    )
    .join("\n");
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