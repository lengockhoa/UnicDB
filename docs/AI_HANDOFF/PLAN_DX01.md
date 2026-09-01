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
- A `src/__tests__/releaseHygiene.test.ts` Vitest file that asserts (a) the two new script names exist in `package.json`, (b) the names match `^verify:(fast|release)$`, (c) they reference the real existing commands (no shell-injection surface — no backticks, no `$(...)`, no `;`/`&&` chains inside a single string), and (d) `scripts/verify-release.sh` exists, is executable on POSIX, and begins with a POSIX `#!/bin/sh` (or `#!/usr/bin/env bash`) shebang.
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
- **TASK-DX01-003 `releaseHygiene` Vitest** — owns `src/__tests__/releaseHygiene.test.ts` only. Pure contract tests on `package.json` and `scripts/verify-release.sh` content; no `npm`/`tsc` execution, no filesystem side effects beyond reading.

The release itself (R5) is a 4th conventional step handled by the orchestrator, not a TASK: update CHANGELOG, bump `package.json` to 1.36.0, commit, tag `v1.36.0`, push, package `vsdb-1.36.0.vsix`. The R5 commit appends the "How to verify a release" subsection under the v1.36.0 entry.

## §4 Test Plan

The cycle ships tests for the new artifact (002) and the contract (003), not for the script entries (001 — those are pure `package.json` data verified by 003's contract test). The test plan covers happy + ≥2 edges of different kinds for each testable task, plus a cross-task regression to prove the new scripts compose the right existing commands.

| # | Type | Test name | Expected | Pre-state / Fixture | Task |
|---|------|-----------|----------|---------------------|------|
| 1 | unit | TASK-DX01-002 `verify-release.sh` prints PASS per stage and final OK on all-zero exit | Each stage prints `PASS <stage>`; final `OK verify:release`; exit 0 | Temp dir; `npm`/`tsc`/`node`/`esbuild` PATH-stubbed to `true` (exit 0, no stdout) | TASK-DX01-002 |
| 2 | edge | TASK-DX01-002 first non-zero stage aborts and prints FAIL | First stage exits 3 → `FAIL <stage>` line, summary `FAIL verify:release`, exit 3 (not 0); no later stage runs | Stub `npm` to `exit 3`; `tsc`/`node`/`esbuild` to `true` | TASK-DX01-002 |
| 3 | edge | TASK-DX01-002 stdout/stderr are separated, no trailing whitespace, no ANSI | No `\r`, no ``, no trailing space per line; stderr untouched | Same fixture as #1 | TASK-DX01-002 |
| 4 | unit | TASK-DX01-003 `verify:fast` exists, typecheck+compile only | `package.json.scripts["verify:fast"]` matches `/^npm run (typecheck|compile) && npm run (typecheck|compile)$/` (order-insensitive) | Read `package.json` from repo root | TASK-DX01-003 |
| 5 | unit | TASK-DX01-003 `verify:release` exists, test+typecheck+compile | `scripts["verify:release"]` matches `/^npm test && npm run typecheck && npm run compile$/` (exact order) | Same | TASK-DX01-003 |
| 6 | edge | TASK-DX01-003 script strings have no shell-injection surface | Neither string contains `` ` ``, `$(`, `;`, `|`, `>`, `<`, or backticks; matches a strict `^npm[^`]*$` per string | Same | TASK-DX01-003 |
| 7 | unit | TASK-DX01-003 runner script exists, executable, has POSIX shebang | `fs.existsSync` true; `mode & 0o111 !== 0`; first line matches `/^#!(\/bin\/sh\|\/usr\/bin\/env (sh\|bash))$/` | Read `scripts/verify-release.sh` | TASK-DX01-003 |
| 8 | regression | Existing `test`/`typecheck`/`compile`/`test:integration` scripts preserved | All four keys still present and unchanged from v1.35.0 baseline | Diff `package.json.scripts` against a known string fixture | TASK-DX01-003 |

## §5 Verification

Per-task verification (executor runs from a clean checkout of the worktree):

```bash
# TASK-DX01-001 (no dedicated tests; verified by 003's contract tests)
node -e 'const p=require("./package.json"); for (const k of ["verify:fast","verify:release"]) { if (typeof p.scripts[k] !== "string") process.exit(1); }'

# TASK-DX01-002
npx vitest run src/__tests__/releaseHygiene.test.ts -t "verify-release.sh"
# + a manual invocation with stubbed PATH (only when iterating on the runner; not in CI)
mkdir -p /tmp/dx01 && cd /tmp/dx01 && PATH="$(pwd)/stubbin:$PATH" /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/scripts/verify-release.sh ; echo "exit=$?"

# TASK-DX01-003
npx vitest run src/__tests__/releaseHygiene.test.ts

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
