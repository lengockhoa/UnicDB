# TASK-DX01-003 — `releaseVerify` Vitest contract tests

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_DX01.md` §3, §4

## Goal

Add `src/__tests__/releaseVerify.test.ts` — a pure contract test that pins the new `verify:fast`/`verify:release` script entries (TASK-DX01-001) and the `scripts/verify-release.sh` runner (TASK-DX01-002) against the v1.35.0 script baseline, and exercises the runner under PATH-stubbed fixtures so the test never depends on the real `npm`/`tsc`/`node`/`esbuild` binaries. No new dependency, no new test framework, no real-network or real-filesystem side effects beyond a temp dir. The describe block is literally named `"verify-release.sh"` so `npx vitest run -t "verify-release.sh"` matches the runner cases.

## Target Files

- `src/__tests__/releaseVerify.test.ts` (new) — describe block name `describe("verify-release.sh", ...)` with the nine cases below. Cases 1–3 use `node:child_process.spawnSync` to invoke the script with a temp-dir `bin` of stub executables prepended to `PATH`; cases 4–9 read `package.json` and the runner file via `node:fs`. This file is intentionally separate from the pre-existing `src/__tests__/releaseHygiene.test.ts` (TASK-703, 3 guards: version-lock, README vsix pattern, semver) — that file is NOT touched by this cycle.

## Test Cases (REQUIRED — TDD)

These cases are written FIRST (RED), then made GREEN by the executor after TASK-DX01-001 (script entries) and TASK-DX01-002 (runner) land. The contract test is the single source of truth for the cycle's behaviour.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | runner prints PASS per stage and final OK on all-zero exit | Three `PASS <stage>` lines in fixed order `npm-test` → `typecheck` → `compile`; final `OK verify:release`; `spawnSync(...).status === 0` | Temp dir with `bin/{npm,tsc,node,esbuild}` symlinked to `true`; `PATH="$tmp/bin:$PATH"` |
| 2 | edge | first non-zero stage aborts and prints FAIL | `npm` stub exits 3 → `FAIL npm-test` line, `FAIL verify:release`, `spawnSync.status === 3`; no `PASS` line for later stages; later stubs are NOT executed (verify via stub-write counter) | Same fixture; `npm` symlinked to a script that writes a marker file then `exit 3` |
| 3 | edge | stdout/stderr are separated, no trailing whitespace, no ANSI | `stdout.toString()` and `stderr.toString()` contain no `\r`, no ``, no trailing space per line; `stderr.length === 0` on the success path | Same fixture as #1 |
| 4 | unit | `verify:fast` exists, composed of typecheck + compile only | `scripts["verify:fast"]` is exactly one of the two allowed strings: `"npm run typecheck && npm run compile"` OR `"npm run compile && npm run typecheck"` (set-membership check, not regex) | `fs.readFileSync("package.json", "utf8")` then `JSON.parse` |
| 5 | unit | `verify:release` exists, exact order test→typecheck→compile | `scripts["verify:release"]` is exactly `"npm test && npm run typecheck && npm run compile"` (string equality, no alternation) | Same |
| 6 | edge | script strings have no shell-injection surface | Neither string contains `` ` ``, `$(`, `;`, `|`, `>`, or `<`; each matches `^npm[^`]*$` | Same |
| 7 | unit | runner script exists, is executable, has a POSIX shebang | `fs.existsSync("scripts/verify-release.sh") === true`; `stat.mode & 0o111 !== 0`; first line is exactly one of `"#!/bin/sh"`, `"#!/usr/bin/env sh"`, `"#!/usr/bin/env bash"` (set-membership, not regex) | Direct read of the file in the test, no exec |
| 8 | regression | existing four scripts preserved | `test`, `typecheck`, `compile`, `test:integration` byte-identical to the v1.35.0 fixture (`"vitest run"`, `"vitest run -c vitest.integration.config.ts"`, `"tsc --noEmit"`, `"node esbuild.js"`) | Hard-coded fixture in the test (acceptable for this scope) |
| 9 | edge | `verify:*` values reference ONLY pre-existing script keys | For each `verify:*` value, split on `&&` → every fragment is exactly `"npm run typecheck"`, `"npm run compile"`, or `"npm test"`; reject any value that contains a substring like `npm run lint` not present as a key in `scripts` | Same |

## Test Files

- `src/__tests__/releaseVerify.test.ts` (new) — contains the nine cases above. Pure read+exec; no mocked imports, no `vi.mock` of `node:fs`/`node:child_process`. The describe block is named `"verify-release.sh"` so focused `-t` runs from PLAN_DX01 §5 and TASK-002 §Verification Commands actually select cases 1–4 (no 0-test false green).

## Verification Commands

```bash
# Focused runner cases (pinned describe name):
npx vitest run src/__tests__/releaseVerify.test.ts -t "verify-release.sh"

# Full contract test:
npx vitest run src/__tests__/releaseVerify.test.ts
npm run typecheck
npm run compile
npx vitest run   # full suite must stay green
```

## Acceptance Criteria

- [ ] All nine cases pass on a clean checkout.
- [ ] Cases 1–3 use only `node:fs`/`node:child_process`/`node:os`/`node:path` (no real `npm`/`tsc`/`node`/`esbuild` execution, no network, no host-filesystem side effects beyond `os.tmpdir()` cleanup).
- [ ] Cases 4–8 read `package.json` and `scripts/verify-release.sh` only via `node:fs`; no `import` of any project module (the test is intentionally framework-light).
- [ ] No file outside the cycle's owned target set (`src/__tests__/releaseVerify.test.ts`) is modified by this task.
- [ ] `npm run typecheck` and `npm run compile` exit 0.
- [ ] `npx vitest run` shows no regression vs. the v1.35.0 baseline.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DX01-001 (script entries must exist for cases 4–6 to pass)
- TASK-DX01-002 (runner must exist for cases 1–3, 7 to pass)

## Interfaces

- Consumes: `package.json` (TASK-DX01-001) and `scripts/verify-release.sh` (TASK-DX01-002).
- Produces: a contract test file that future cycles reference. Adding a third `verify:*` script in a later cycle MUST update the fixture/case here — documented in the cycle's CHANGELOG entry as the "release-hygiene contract" line item.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

## Reviewer Verdict

(to be appended by Phase 4 reviewer)
