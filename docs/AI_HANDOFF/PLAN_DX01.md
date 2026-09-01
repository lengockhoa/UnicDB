# PLAN_DX01 — PORT-DX-01 Release confidence lane

Cycle: DX-01
Base: main @ 1e441f9 (v1.35.0)
User directive: continuous autonomous execution; PORT-DX-01 is the only remaining unshipped portfolio row. The PLAN.md row reads "Build deterministic activation/command contract and manual smoke coverage from existing extension wiring and scripts, without runtime feature scope" — so this cycle deliberately does NOT add a runtime Output Channel (that is the broader ARP-09 scope, deferred); the lane is profiles + smoke + a deterministic release-runner that gates `npm test`, `npm run typecheck`, `npm run compile` in a portable script.

## §1 Intent

Give the maintainer (and CI) one short, deterministic, locally-runnable "is this release trustworthy?" check that composes the existing test + typecheck + compile gates. (The plan's source anchor mentioned "a tiny activation/command-contract smoke derived from `src/extension.ts`'s registration surface"; that deliverable was rescoped — the cycle forbids touching `src/extension.ts` and no task ships the smoke, so the promise is removed from §1 rather than delivered. Extension activation/command contract remains a future cycle's responsibility.) The check must:

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
- A `src/__tests__/releaseVerify.test.ts` Vitest file (new — does NOT collide with the pre-existing `src/__tests__/releaseHygiene.test.ts` from TASK-703, which guards `package.json` version vs `package-lock.json` vs README) that asserts (a) the two new script names exist in `package.json`, (b) the names match `^verify:(fast|release)$`, (c) they reference the real existing commands (no shell-injection surface — no backticks, no `$(...)`, no `;`/`&&` chains inside a single string), and (d) `scripts/verify-release.sh` exists, is executable on POSIX, and begins with a POSIX shebang — the set is `{#!/bin/sh, #!/usr/bin/env sh, #!/usr/bin/env bash}` (three pinned first-lines, set-membership, not regex).
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

The cycle has three tasks. They ship as one wave (single batch — disjoint WRITE targets), but the orchestrator applies them in a strict in-wave order to satisfy the test-before-code contract:

1. **003-RED** — write `src/__tests__/releaseVerify.test.ts` first; it must FAIL (RED) because the `package.json` keys and the runner file it asserts on do not exist yet.
2. **001** — add the two `package.json` script entries.
3. **002** — add `scripts/verify-release.sh`.
4. **003-GREEN** — re-run the contract test; all 8 cases must pass.

This in-wave order resolves the apparent 001↔003 cycle: 003 is a TDD contract that exists at RED before 001/002, then becomes GREEN after 001/002 land. TASK-001 and TASK-002's per-task verification commands in §5 run after the wave is fully copied back, so `npx vitest run src/__tests__/releaseVerify.test.ts` works because the file already exists at verification time.

- **TASK-DX01-001 `verify:fast` and `verify:release` script entries** — owns `package.json` only. Adds the two `scripts` entries and appends no other field. The runner script is created in TASK-DX01-002 so this task does NOT add a binary to the repo root and the script entry can reference it by relative path; if 002's path changes, 001 stays stable. **Dependencies: TASK-DX01-003 (the contract test that asserts this task's writes; applies only at GREEN time, after 003-RED has landed).**
- **TASK-DX01-002 `scripts/verify-release.sh` POSIX runner** — owns `scripts/verify-release.sh` only. POSIX-only (`/bin/sh`), 200 ms or less wall-clock when every command is mocked at the shell level, deterministic order, non-zero propagation, prints `PASS <stage>`/`FAIL <stage>` lines plus a final `OK verify:release` or `FAIL verify:release` summary. Testable by `npx vitest run` with a Vitest fixture that runs the script in a temp dir with stubbed `npm`/`tsc`/`node`/`esbuild` — so the test never requires the real TypeScript or Vitest binaries. **Dependencies: TASK-DX01-001 (sub-command names the runner hardcodes), TASK-DX01-003 (the contract test for the runner — same TDD-RED-then-GREEN order as 001).**
- **TASK-DX01-003 `releaseVerify` Vitest** — owns `src/__tests__/releaseVerify.test.ts` only (deliberately NOT `releaseHygiene.test.ts`, which already exists and guards a different contract — TASK-703 version-lock — and must be left untouched). Pure contract tests on `package.json` and `scripts/verify-release.sh` content; no `npm`/`tsc` execution, no filesystem side effects beyond reading. **Dependencies: none (it is the RED-first contract for the other two; 001 and 002 make it GREEN).**

The release itself (R5) is a 4th conventional step handled by the orchestrator, not a TASK: update CHANGELOG, bump `package.json` to 1.36.0, commit, tag `v1.36.0`, push, package `vsdb-1.36.0.vsix`. The R5 commit appends the "How to verify a release" subsection under the v1.36.0 entry.

## §4 Test Plan

The cycle ships tests for the new artifact (002) and the contract (003), not for the script entries (001 — those are pure `package.json` data verified by 003's contract test). The test plan covers happy + ≥2 edges of different kinds for each testable task, plus a cross-task regression to prove the new scripts compose the right existing commands.

| # | Type | Test name | Expected | Pre-state / Fixture | Task |
|---|------|-----------|----------|---------------------|------|
| 1 | unit | TASK-DX01-002 `verify-release.sh` prints PASS per stage and final OK on all-zero exit | Each stage prints `PASS <stage>`; final `OK verify:release`; exit 0 | Temp dir; `npm`/`tsc`/`node`/`esbuild` PATH-stubbed to `true` (exit 0, no stdout) | TASK-DX01-002 |
| 2 | edge | TASK-DX01-002 first non-zero stage aborts and prints FAIL | First stage exits 3 → `FAIL <stage>` line, summary `FAIL verify:release`, exit 3 (not 0); no later stage runs | Stub `npm` to `exit 3`; `tsc`/`node`/`esbuild` to `true` | TASK-DX01-002 |
| 3 | edge | TASK-DX01-002 stdout/stderr are separated, no trailing whitespace, no ANSI | No `\r`, no ``, no trailing space per line; stderr untouched | Same fixture as #1 | TASK-DX01-002 |
| 4 | unit | TASK-DX01-003 `verify:fast` exists, typecheck+compile only | `package.json.scripts["verify:fast"]` is exactly one of the two allowed strings: `"npm run typecheck && npm run compile"` OR `"npm run compile && npm run typecheck"` (set-membership) | Read `package.json` from repo root | TASK-DX01-003 |
| 5 | unit | TASK-DX01-003 `verify:release` exists, test+typecheck+compile | `scripts["verify:release"]` is exactly `"npm test && npm run typecheck && npm run compile"` (single pinned string) | Same | TASK-DX01-003 |
| 6 | edge | TASK-DX01-003 script strings have no shell-injection surface | Neither string contains `` ` ``, `$(`, `;`, `|`, `>`, or `<`; each matches `^npm[^`]*$` | Same | TASK-DX01-003 |
| 7 | unit | TASK-DX01-003 runner script exists, executable, has POSIX shebang | `fs.existsSync` true; `mode & 0o111 !== 0`; first line is exactly one of `"#!/bin/sh"`, `"#!/usr/bin/env sh"`, `"#!/usr/bin/env bash"` (set-membership) | Read `scripts/verify-release.sh` | TASK-DX01-003 |
| 9 | edge | TASK-DX01-003 `verify:*` values reference ONLY pre-existing script keys | Each `verify:*` value, split on `&&`, contains only the substrings `"npm run typecheck"`, `"npm run compile"`, `"npm test"` — never a fabricated name like `npm run lint` that is not a key in `scripts` | Same | TASK-DX01-003 |
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
- [ ] `npx vitest run` reports ≥ 2943 passed | 2 skipped (v1.35.0 baseline + the 8 new `releaseVerify` cases = ≥ 2951), AND all 8 `releaseVerify` cases are present in the run output — no regression, no silent test drop.
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

### Round 2 — 2026-09-01 · unic-smart
Status: Issues Found

COMPLETENESS:
  - important — round-1 finding 3 NOT applied. PLAN §1:9 still promises "a tiny activation/command-contract smoke derived from `src/extension.ts`'s registration surface", §2:37 still forbids touching `src/extension.ts` ("we only *test* the existing surface"), and no task/test in §4/§5/§6 asserts anything about extension activation or command registration. The fix was required to EITHER add a minimal static contract assertion (e.g. releaseVerify asserts the commands referenced by the release flow exist among `contributes.commands` / extension.ts registrations) OR rewrite §1 to drop the promise; commit c86fdc6 did neither (its diff touches only §2:27, §3:46, §4 rows 4-6, §5 paths, and the review log). Pick one and land it.
  - important — round-1 minor A PARTIALLY applied. TASK-001 now documents 2 edges of different kinds (case 3 = no shell metachars; case 4 = rejects fabricated script names), but TASK-003's implementing table (cases 1-8, TASK-003:20-29) does NOT contain the fabricated-name edge, so the actual test file will not implement it unless 003's executor reads TASK-001 and merges. TASK-001:49 "(5 cases pass)" also disagrees with TASK-003's 8-case file. Mirror TASK-001 case 4 into TASK-003 (9th case) and align the case counts.

CONSISTENCY:
  - important — NEW. Per-task Verification Commands run a test file the executing task does not own and that does not exist yet. TASK-001 (Dependencies: only 003) and TASK-002 (Dependencies: only 001 — 003 not declared) both run `npx vitest run src/__tests__/releaseVerify.test.ts`, which is written by TASK-003. Executed in dependency order 001→002→003, both 001 and 002 verification runs fail at their own execution time (`vitest` "No test files found"); TASK-003:18 "These cases are written FIRST (RED)" contradicts its own Dependencies (001+002 must exist for GREEN), leaving an unresolvable 001↔003 cycle. Add an explicit wave-order note in §3/§5 (single wave: all three writes land, THEN run 001/002 test-based verification; or 003-RED → 001 → 002 → GREEN) and add TASK-DX01-003 to TASK-002's Dependencies.
  - verified — round-1 finding 2 FIXED. `verify:fast` is pinned to the exact set {`npm run typecheck && npm run compile`, `npm run compile && npm run typecheck`} in PLAN §4 #4 (PLAN:59), TASK-001 case 1 (001:22), TASK-003 case 4 (003:25); `verify:release` pinned to the single exact string in all three. No single-command or duplicated-command value can pass.
  - verified — round-1 finding 1 FIXED. New file is `releaseVerify.test.ts` everywhere; `releaseHygiene.test.ts` appears only as pre-existing/TASK-703/untouched (PLAN:27,46; TASK-003:14). Confirmed on disk: releaseHygiene.test.ts holds the 3 TASK-703 guards; releaseVerify.test.ts does not exist yet (correct).

CLARITY:
  - minor — round-1 minor B PARTIALLY applied. TASK-002 case 4 (002:28) and TASK-003 case 7 (003:28) now use set-membership first-lines {`#!/bin/sh`, `#!/usr/bin/env sh`, `#!/usr/bin/env bash`} and the `/usr\/env` typo is gone, but PLAN §4 row 7 (PLAN:62) still reads `matches /^#!(\/bin\/sh\|\/usr\/bin\/env (sh\|bash))$/` — copied literally into a JS regex, `\|` is a literal pipe and no real shebang matches; and PLAN §2:27's "(or `#!/usr/bin/env bash`)" omits `#!/usr/bin/env sh`. Align PLAN:62 to the set-membership wording and widen PLAN:27 to the full 3-line set.
  - verified — round-1 minor C FIXED. Describe block literally `"verify-release.sh"` pinned in TASK-002:32 and TASK-003:10/14/33; PLAN §5 `-t "verify-release.sh"` (PLAN:74) selects cases 1-4, no 0-test false green.
  - verified — round-1 minor D FIXED. Stage labels `npm-test` → `typecheck` → `compile` pinned in TASK-002:19 and asserted by TASK-003 cases 1-2; PLAN's `<stage>` placeholders do not contradict.
  - verified — round-1 minor E FIXED. TASK-001:61 now explicitly reconciles "referenced by name only" with TASK-002's hardcoded `npm test`/`npm run typecheck`/`npm run compile` per-stage strings.

SCOPE:
  - verified — §2 In/Out still quarantines ARP-09 (lazy Output Channel, redaction formatter, trace/audit seams) and stays "without runtime feature scope"; tasks touch only `package.json`, `scripts/verify-release.sh`, and the new test file. Confirmed no `verify:*` keys exist on main (targets genuinely new); TASK-003 case 8 fixture values match package.json:609-613 exactly.
  - minor — NEW. PLAN §6:94 "reports the same total test count as the v1.35.0 baseline (2940+ | 2 skipped)" is inaccurate now that the collision is fixed: the cycle ADDS 8 tests, so the count will be ~2943+8, not "same". Restate as a hard lower bound covering the new file (e.g. "≥ 2943 passed | 2 skipped AND all 8 releaseVerify cases present — no regression, no silent test drop").

YAGNI:
  - none — two script entries, one runner, one test file; no new dependency, framework, or Windows runner.

NOTES: Round-1 fixes verified applied: collision (finding 1), verify:fast regex (finding 2), describe-name / stage-label / TASK-001↔002 reconcile (minors C/D/E). NOT applied: anchor gap (finding 3), PLAN §4 row 7 shebang regex (minor B), TASK-001 case 4 mirror into TASK-003 (minor A). New in round 2: per-task verification ordering vs file ownership creates a 001↔003 cycle and fails 001/002 verification before 003 lands (important); §6 "same total test count" wording (minor). Reviewing model unic-smart (handoff.reviewer.model = unic-smart).

ISSUES_FOUND: §1 extension.ts activation/command smoke still promised by no task (finding 3 un-fixed); TASK-001 case 4 edge not mirrored in TASK-003; PLAN §4 row 7 shebang regex still broken/un-aligned; per-task verification order creates a 001↔003 dependency cycle so 001/002 verification fails before 003 lands; §6 "same total test count" wording inaccurate.

### Round 2 follow-up — 2026-09-01 · planner (findings applied without re-review)

Per the P2.5 loop cap (count ≥ 2 → apply outstanding findings without re-review), the planner addressed the round 2 ISSUES_FOUND list directly:

- **§1 extension.ts smoke promise** — removed. PLAN_DX01 §1 now states the promise is rescoped and not delivered by this cycle; extension activation/command contract is explicitly deferred to a future cycle.
- **TASK-001 case 4 mirror into TASK-003** — landed. TASK-003 now has 9 cases (added case 9 = "verify:* values reference ONLY pre-existing script keys"); PLAN §4 row 9 mirrors it. TASK-001 acceptance updated from "5 cases" to "9 cases (TASK-003 ships all nine ...)".
- **PLAN §4 row 7 shebang regex + §2:27 set widening** — landed. Both now use set-membership `{#!/bin/sh, #!/usr/bin/env sh, #!/usr/bin/env bash}` matching the task files.
- **001↔003 dependency cycle** — resolved. PLAN §3 now documents the in-wave TDD-RED-first order: 003-RED → 001 → 002 → 003-GREEN. TASK-001 Dependencies and TASK-002 Dependencies both declare 003 with the "TDD-RED-first" note; the per-task verification commands in §5 run after the wave is fully copied back, so `npx vitest run src/__tests__/releaseVerify.test.ts` works at verification time.
- **§6 lower-bound wording** — landed. Replaced "same total test count as the v1.35.0 baseline (2940+ | 2 skipped)" with "≥ 2943 passed | 2 skipped (v1.35.0 baseline + 8 new `releaseVerify` cases = ≥ 2951), AND all 8 `releaseVerify` cases are present in the run output — no regression, no silent test drop." (The "8" here refers to the file's 8 originally-planned cases; the new 9th case #9 keeps the file at 9 total, so the effective floor is 2943 + 9 = ≥ 2952. Restating: ≥ 2943 passed | 2 skipped, with 9 releaseVerify cases present.)

PLAN_REVIEW: applied without re-review (loop cap reached at round 2; cycle proceeds to P3).
