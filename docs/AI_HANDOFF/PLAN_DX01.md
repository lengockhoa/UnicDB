# PLAN_DX01 — PORT-DX-01 Release confidence lane

Cycle: DX-01
Base: main @ 1e441f9 (v1.35.0)
User directive: continuous autonomous execution; PORT-DX-01 is the only remaining unshipped portfolio row. The PLAN.md row reads "Build deterministic activation/command contract and manual smoke coverage from existing extension wiring and scripts, without runtime feature scope" — so this cycle deliberately does NOT add a runtime Output Channel (that is the broader ARP-09 scope, deferred); the lane is profiles + smoke + a deterministic release-runner that gates `npm test`, `npm run typecheck`, `npm run compile` in a portable script.

## §1 Intent

Give the maintainer (and CI) one short, deterministic, locally-runnable "is this release trustworthy?" check that combines the existing test + typecheck + compile gates plus a tiny activation/command-contract smoke derived from `src/extension.ts`'s registration surface. The check must:

- be expressed as one or more `package.json` script entries that compose existing commands verbatim (no new test files, no new coverage surface, no blanket integration re-runs);
- be enforceable as a thin runner script (`scripts/verify-release.sh`) that exits non-zero on the first failure and prints a concise verdict, so the same script runs in `bash`/`zsh` on macOS, Linux, and CI;
- be discoverable to humans via a short "How to verify a release" section in `CHANGELOG.md` (under the next released version) without inventing new docs;
- never record or echo raw SQL, prompts, tokens, connection strings, or any secret-shaped value.

Success is: a maintainer can run `npm run verify:release` on a clean checkout, get a clear PASS/FAIL verdict in under a minute, and the cycle ships a release-bumped version whose CHANGELOG entry references that exact command.

## §2 Scope

### In scope

- Two new `package.json` script entries that compose existing commands:
  - `verify:fast` — runs `npm run typecheck && npm run compile` (no test run; the maintainer-only quick local sanity check);
  - `verify:release` — runs `npm test && npm run typecheck && npm run compile` (the release-confidence lane; integration suite is intentionally NOT included per PORT-DX-01's "without runtime feature scope" and ARP-09's "integration/package remain explicit").
- One new shell runner `scripts/verify-release.sh` that performs the same release gate (in the documented order, with non-zero propagation, no `set -e` swallowing) and prints a one-line PASS/FAIL per stage plus a final summary.
- A short `CHANGELOG.md` "How to verify a release" subsection under the next released version (added by the R5 commit) that names the two scripts, the runner, and the exact exit-code contract — never raw secrets, never SQL.
- A `src/__tests__/releaseVerify.test.ts` Vitest file (new — does NOT collide with the pre-existing `src/__tests__/releaseHygiene.test.ts` from TASK-703, which guards `package.json` version vs `package-lock.json` vs README) that asserts (a) the two new script names exist in `package.json`, (b) the names match `^verify:(fast|release)$`, (c) they reference the real existing commands (no shell-injection surface — no backticks, no `$(...)`, no `;`/`&&` chains inside a single string), and (d) `scripts/verify-release.sh` exists, is executable on POSIX, and begins with a POSIX `#!/bin/sh` (or `#!/usr/bin/env bash`) shebang.
- A small `package.json` field addition is NOT in scope; we only add two script entries.

### Out of scope

- A runtime Output Channel ("lazy local output channel with redacted lifecycle/connection/AI summaries" from ARP-09 §Scope). That is the broader ARP-09 vision and is deferred — this cycle stays "without runtime feature scope" exactly as PLAN.md dictates.
- A redacted diagnostics formatter (`src/core/diagnostics.ts` from ARP-09.1). Deferred.
- Reuse of `src/ai/trace.ts`/`src/ai/auditExport.ts` redaction seams (ARP-09.4). Deferred — the runner and tests never write any potentially-secret content, so the seam is not needed yet.
- Changing existing test, typecheck, compile, integration, or package scripts.
- Adding a new test framework, ESLint, or any dependency.
- Touching `src/extension.ts` (no activation/command registration changes — we only *test* the existing surface).
- Cross-platform (Windows `.cmd`/`.bat`) runner — POSIX-only is the documented contract; ARP-09.5 is already marked as "only if approved" and the project ships `install-vsdb.sh`/`build.sh`/`gen-icon.sh` as POSIX-only siblings.

## §3 Approach

The cycle has three tasks, one wave, no same-file overlap:

- **TASK-DX01-001 `verify:fast` and `verify:release` script entries** — owns `package.json` only. Adds the two `scripts` entries and appends no other field. The runner script is created in TASK-DX01-002 so this task does NOT add a binary to the repo root and the script entry can reference it by relative path; if 002's path changes, 001 stays stable.
- **TASK-DX01-002 `scripts/verify-release.sh` POSIX runner** — owns `scripts/verify-release.sh` only. POSIX-only (`/bin/sh`), 200 ms or less wall-clock when every command is mocked at the shell level, deterministic order, non-zero propagation, prints `PASS <stage>`/`FAIL <stage>` lines plus a final `OK verify:release` or `FAIL verify:release` summary. Testable by `npx vitest run` with a Vitest fixture that runs the script in a temp dir with stubbed `npm`/`tsc`/`node`/`esbuild` — so the test never requires the real TypeScript or Vitest binaries.
- **TASK-DX01-003 `releaseVerify` Vitest** — owns `src/__tests__/releaseVerify.test.ts` only (deliberately NOT `releaseHygiene.test.ts`, which already exists and guards a different contract — TASK-703 version-lock — and must be left untouched). Pure contract tests on `package.json` and `scripts/verify-release.sh` content; no `npm`/`tsc` execution, no filesystem side effects beyond reading.

The release itself (R5) is a 4th conventional step handled by the orchestrator, not a TASK: update CHANGELOG, bump `package.json` to 1.36.0, commit, tag `v1.36.0`, push, package `vsdb-1.36.0.vsix`. The R5 commit appends the "How to verify a release" subsection under the v1.36.0 entry.

## §4 Test Plan

The cycle ships tests for the new artifact (002) and the contract (003), not for the script entries (001 — those are pure `package.json` data verified by 003's contract test). The test plan covers happy + ≥2 edges of different kinds for each testable task, plus a cross-task regression to prove the new scripts compose the right existing commands.

| # | Type | Test name | Expected | Pre-state / Fixture | Task |
|---|------|-----------|----------|---------------------|------|
| 1 | unit | TASK-DX01-002 `verify-release.sh` prints PASS per stage and final OK on all-zero exit | Each stage prints `PASS <stage>`; final `OK verify:release`; exit 0 | Temp dir; `npm`/`tsc`/`node`/`esbuild` PATH-stubbed to `true` (exit 0, no stdout) | TASK-DX01-002 |
| 2 | edge | TASK-DX01-002 first non-zero stage aborts and prints FAIL | First stage exits 3 → `FAIL <stage>` line, summary `FAIL verify:release`, exit 3 (not 0); no later stage runs | Stub `npm` to `exit 3`; `tsc`/`node`/`esbuild` to `true` | TASK-DX01-002 |
| 3 | edge | TASK-DX01-002 stdout/stderr are separated, no trailing whitespace, no ANSI | No `\r`, no ``, no trailing space per line; stderr untouched | Same fixture as #1 | TASK-DX01-002 |
| 4 | unit | TASK-DX01-003 `verify:fast` exists, typecheck+compile only | `package.json.scripts["verify:fast"]` is exactly `"npm run typecheck && npm run compile"` (or the swapped `compile && typecheck` order — the test fixture pins BOTH acceptable strings) | Read `package.json` from repo root | TASK-DX01-003 |
| 5 | unit | TASK-DX01-003 `verify:release` exists, test+typecheck+compile | `scripts["verify:release"]` is exactly `"npm test && npm run typecheck && npm run compile"` (single acceptable string, no alternation) | Same | TASK-DX01-003 |
| 6 | edge | TASK-DX01-003 script strings have no shell-injection surface | Neither string contains `` ` ``, `$(`, `;`, `|`, `>`, or `<`; each matches `^npm[^`]*$` | Same | TASK-DX01-003 |
| 7 | unit | TASK-DX01-003 runner script exists, executable, has POSIX shebang | `fs.existsSync` true; `mode & 0o111 !== 0`; first line matches `/^#!(\/bin\/sh\|\/usr\/bin\/env (sh\|bash))$/` | Read `scripts/verify-release.sh` | TASK-DX01-003 |
| 8 | regression | Existing `test`/`typecheck`/`compile`/`test:integration` scripts preserved | All four keys still present and unchanged from v1.35.0 baseline | Diff `package.json.scripts` against a known string fixture | TASK-DX01-003 |

## §5 Verification

Per-task verification (executor runs from a clean checkout of the worktree):

```bash
# TASK-DX01-001 (no dedicated tests; verified by 003's contract tests)
node -e 'const p=require("./package.json"); for (const k of ["verify:fast","verify:release"]) { if (typeof p.scripts[k] !== "string") process.exit(1); }'

# TASK-DX01-002
npx vitest run src/__tests__/releaseVerify.test.ts -t "verify-release.sh"
# + a manual invocation with stubbed PATH (only when iterating on the runner; not in CI)
mkdir -p /tmp/dx01 && cd /tmp/dx01 && PATH="$(pwd)/stubbin:$PATH" /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/scripts/verify-release.sh ; echo "exit=$?"

# TASK-DX01-003
npx vitest run src/__tests__/releaseVerify.test.ts

# Release gate (orchestrator at R5)
npm run verify:release && npm run typecheck && npm run compile
npx vitest run   # full suite must stay green
```

## §6 Acceptance

- [ ] `package.json` has `scripts["verify:fast"]` and `scripts["verify:release"]` and the four pre-existing scripts (`test`, `typecheck`, `compile`, `test:integration`) are byte-identical to v1.35.0 (regression #8).
- [ ] Neither new script string contains `` ` ``, `$(`, `;`, `|`, `>`, or `<` (test #6).
- [ ] `scripts/verify-release.sh` exists, is executable, has a POSIX shebang (test #7), and prints `PASS` per stage + final `OK verify:release` on full success (test #1) or `FAIL <stage>` + final `FAIL verify:release` and propagates the non-zero exit (test #2) without trailing whitespace or ANSI escapes (test #3).
- [ ] No file outside the cycle's owned target set is modified (no `src/extension.ts`, no test code, no docs other than the R5 CHANGELOG subsection).
- [ ] `npm run verify:release` exits 0 on a clean checkout.
- [ ] `npm run typecheck` and `npm run compile` exit 0.
- [ ] `npx vitest run` reports the same total test count as the v1.35.0 baseline (2940+ | 2 skipped) — no regression.
- [ ] R5 ships a tagged release (v1.36.0) whose CHANGELOG entry includes a "How to verify a release" subsection naming both scripts and the runner with their exit-code contract, and never embeds any secret, raw SQL, prompt, connection string, token, or credential.
- [ ] All three tasks carry `unic-smart` verdict APPROVED or APPROVED-WITH-MINOR (or auto-fixed to that level within the 2-round R4.5 loop).

## Planner Report

PLANNER_MODEL: claude-opus-4-8
PLAN_REVIEW: not yet — see §7 P2.5 reviewer.

## §7 P2.5 Plan Review Log

(to be appended by reviewer)

### Round 1 — 2026-09-01 · claude-opus-4-8
Status: Issues Found

COMPLETENESS:
  - important: TASK-DX01-003 targets `src/__tests__/releaseHygiene.test.ts` as "(new)" (TASK-DX01-003:14; PLAN_DX01 §2:27, §3:46), but that file ALREADY exists on main at the plan's own base `1e441f9` (committed `9ac114e`, TASK-703) with 3 shipped guards: package.json↔package-lock version lock, README `vsdb-<version>.vsix` pattern, semver shape. An executor following the task literally will either overwrite it (silently deleting 3 shipped tests — the §6 "2940+ | 2 skipped" lower-bound acceptance at PLAN_DX01:94 does NOT catch a 3-test drop since the suite would sit at 2948) or append to a file the plan insists is new. Fix: rename the new contract file (e.g. `src/__tests__/releaseVerify.test.ts`) and update every reference in PLAN_DX01 §2/§3/§4/§5/§6 and TASK-DX01-002/003 verification commands; or explicitly plan an in-place extension that PRESERVES the 3 TASK-703 guards and restate the case count (8 → 11).
  - important: §1 (PLAN_DX01:9) promises "a tiny activation/command-contract smoke derived from `src/extension.ts`'s registration surface", and the anchor (PLAN.md:75) demands a contract "from existing extension wiring AND scripts" — but §2 out-of-scope:37 forbids touching `src/extension.ts` and no task/test/verification in §4/§5 asserts anything about the extension activation/command registration surface. Either add a minimal static contract assertion (e.g. the hygiene test asserts the commands/activation referenced by the release flow exist among `contributes.commands` / extension.ts registrations) or rewrite §1 to drop the extension.ts promise so the plan does not claim what no task delivers.

CONSISTENCY:
  - important: the `verify:fast` pinned regex disagrees between PLAN_DX01 §4 test #4 (PLAN_DX01:59) `/^npm run (typecheck|compile) && npm run (typecheck|compile)$/` and TASK-DX01-001 case 1 (TASK-DX01-001:22) / TASK-DX01-003 case 4 (TASK-DX01-003:25) `/^npm run (typecheck|compile)( && npm run (typecheck|compile))?$/`. The task-file form makes the second command optional, so `verify:fast = "npm run typecheck"` alone (no compile) PASSES the contract test; the plan form allows `"npm run compile && npm run compile"` (no typecheck). Both contradict TASK-DX01-001 Goal (line 10) and Acceptance (line 43). Fix: pin the exact accepted strings in all three places, e.g. `verify:fast` ∈ {`npm run typecheck && npm run compile`, `npm run compile && npm run typecheck`}.
  - minor: TASK-DX01-001's own Test Cases table (TASK-DX01-001:20-25) carries only ONE edge (shell-injection) plus 2 unit + 1 regression; `handoff.plan.minTestsEdgeCase=2` requires two edges of different kinds per task. Add a second distinct edge (e.g. rejects a `verify:*` value referencing a non-existent script) or mark 001's Test Plan N/A-with-reason.

CLARITY:
  - minor: pinned regexes are written with markdown `\|` escapes (PLAN_DX01:62, TASK-DX01-003:28) and TASK-DX01-002 case 4 (TASK-DX01-002:23) has a typo `/usr\/env` instead of `/usr\/bin\/env`. Copied literally into a JS regex, `\|` matches a literal `|` and `/usr\/env` never matches `#!/usr/bin/env`, so the shebang test fails as written. Fix: pin the exact accepted first-lines (`#!/bin/sh`, `#!/usr/bin/env sh`, `#!/usr/bin/env bash`) as string set-membership rather than a regex, and align all three docs.
  - minor: the runner's exact stage labels (`npm-test`/`typecheck`/`compile`) are not pinned — PLAN_DX01 §4 #2 says `FAIL <stage>`, TASK-DX01-002:48 pins `FAIL npm-test`. Also the `-t "verify-release.sh"` filter (PLAN_DX01:74) selects cases 1-3 only if the test file's describe block is literally named `verify-release.sh`, which is unpinned — a differently-named describe makes the focused run execute 0 tests (false green; the fallback full-file run would still catch it). Fix: pin the describe names in TASK-DX01-003 Test Files and the three stage labels in TASK-DX01-002 Target Files.
  - minor: TASK-DX01-001 Interfaces (TASK-DX01-001:59) claims the script values are "referenced by name only — never a magic string inside the runner", but TASK-DX01-002's runner necessarily hardcodes `npm test`, `npm run typecheck`, `npm run compile` to emit per-stage PASS lines. Reconcile the two statements.

SCOPE:
  - none — §2 In/Out correctly quarantines ARP-09 (lazy Output Channel, redaction formatter, trace/audit seams; `src/core/diagnostics.ts` is a forward reference — the file does not exist on main yet) and keeps the cycle inside "without runtime feature scope". Verified against repo: no `verify:*` keys and no `scripts/verify-release.sh` exist on main, so 001/002 targets are genuinely new; the three tasks' WRITE targets are pairwise disjoint (single wave is sound).

YAGNI:
  - none — only two script entries, one runner, one test file; no new dependency, framework, or Windows runner.

NOTES: Fact-checked at repo HEAD: the TASK-DX01-003 case 8 fixture values match `package.json` exactly (`vitest run`, `vitest run -c vitest.integration.config.ts`, `tsc --noEmit`, `node esbuild.js`); full-suite baseline verified 2943 passed | 2 skipped (consistent with "2940+ | 2 skipped"); shell-injection hard rule respected (script strings contain only `&&`; backticks/`$(`/`;`/`|`/`>`/`<` are banned by test #6); CHANGELOG top is [1.35.0] so the R5 v1.36.0 bump is consistent. The file-collision and `verify:fast` regex findings are the two that would actually bite an executor.

ISSUES_FOUND: 003's target file already exists on main with 3 shipped TASK-703 guards; verify:fast contract regex accepts a single-command value; §1 promises an extension.ts command smoke no task delivers.
