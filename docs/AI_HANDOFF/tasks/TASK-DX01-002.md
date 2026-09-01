# TASK-DX01-002 — `scripts/verify-release.sh` POSIX runner

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_DX01.md` §3

## Goal

Add a portable POSIX shell runner at `scripts/verify-release.sh` that composes the existing `verify:release` pipeline (`npm test && npm run typecheck && npm run compile`) into a single, exit-code-propagating, stage-labelled command. The runner is POSIX-only (`/bin/sh`), prints `PASS <stage>` per stage, prints a final `OK verify:release` or `FAIL verify:release`, and propagates the first non-zero exit code unchanged. It must be exercised by `TASK-DX01-003` without depending on the real `npm`/`tsc`/`node`/`esbuild` binaries (PATH-stubbed fixtures only).

## Target Files

- `scripts/verify-release.sh` (new) — POSIX shell script, executable, opens with a POSIX shebang (`#!/bin/sh` preferred; `#!/usr/bin/env bash` accepted). Stages in fixed order: `npm test` → `npm run typecheck` → `npm run compile`. Between stages, prints `PASS <stage>`; on a non-zero exit, prints `FAIL <stage>` to stderr (or stdout — contract is one-line per stage; per-stage channel is the runner's choice but the test fixture pins the channel), then exits with that non-zero code. No ANSI escapes, no trailing whitespace per line, no `set -e` swallowing.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `verify-release.sh` prints PASS per stage and final OK on all-zero exit | Three `PASS <stage>` lines (one per stage) in fixed order; final `OK verify:release`; exit 0 | Temp dir with stub `bin/{npm,tsc,node,esbuild}` symlinked to `true` (exit 0, no stdout); runner invoked with `PATH="$tmp/bin:$PATH"` |
| 2 | edge | first non-zero stage aborts and prints FAIL | First stage exits 3 → `FAIL <stage>` line printed, summary `FAIL verify:release`, runner exits 3 (not 0); no later stage runs; no `PASS` line for later stages | Same fixture; first stub (`npm`) symlinked to a 3-line script that does `exit 3`; `tsc`/`node`/`esbuild` to `true` |
| 3 | edge | stdout/stderr are separated, no trailing whitespace, no ANSI | Captured stdout/stderr contain no `\r`, no ``, no trailing space per line; stderr is empty on success | Same fixture as #1 |
| 4 | unit | runner is executable and has a POSIX shebang | `fs.statSync(...).mode & 0o111 !== 0`; first line matches `/^#!(\/bin\/sh\|\/usr\/env (sh\|bash))$/` (POSIX variants) | Direct read of the file in the test, no exec |

## Test Files

- `src/__tests__/releaseHygiene.test.ts` (added by TASK-DX01-003) — cases 1–4; case 1–3 use `child_process.spawnSync` against the script with a PATH-stubbed fixture created in a temp dir, capture stdout+stderr, and assert.

## Verification Commands

```bash
# Focused contract test for the runner behavior:
npx vitest run src/__tests__/releaseHygiene.test.ts -t "verify-release.sh"

# Manual end-to-end on the developer's shell (POSIX bash or zsh only):
bash /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/scripts/verify-release.sh ; echo "exit=$?"

# Full gate
npm run typecheck
npm run compile
npx vitest run src/__tests__/releaseHygiene.test.ts
```

## Acceptance Criteria

- [ ] `scripts/verify-release.sh` exists, is executable on POSIX (`chmod +x` semantics observable via `mode & 0o111`), and starts with a POSIX shebang.
- [ ] On a clean checkout with real `npm`/`tsc`/`node`/`esbuild` available, the script exits 0 and prints three `PASS <stage>` lines plus a final `OK verify:release` (test #1).
- [ ] If `npm test` exits non-zero, the script prints `FAIL npm-test`, prints `FAIL verify:release`, and exits with the same non-zero code; later stages do not run (test #2).
- [ ] No ANSI escape, no carriage return, no trailing whitespace on any printed line; stderr is empty on the success path (test #3).
- [ ] The script references `npm test`, `npm run typecheck`, and `npm run compile` by name (NOT by re-implementing the test runner or typecheck logic) — the contract test for `TASK-DX01-001` pins those exact script names.
- [ ] No file outside the cycle's owned target set (`scripts/verify-release.sh`) is modified by this task; the consumer (the orchestrator's R5 release run) MAY invoke the script, but the script is NOT referenced by any other source file.
- [ ] `npm run typecheck` and `npm run compile` exit 0; `npx vitest run` shows no regression vs. the v1.35.0 baseline.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DX01-001 (the script entries the runner calls by name)

## Interfaces

- Consumes: `package.json` script keys `scripts["verify:release"]` (composed as `npm test && npm run typecheck && npm run compile` by TASK-DX01-001). The runner invokes these via `npm` — it does NOT reimplement them.
- Produces: an executable `scripts/verify-release.sh` whose contract is "exit 0 + three PASS lines + `OK verify:release` on full success, or exit N + `FAIL <stage>` + `FAIL verify:release` on first failure". This contract is asserted by `TASK-DX01-003` cases 1–3 and is the documented behaviour the R5 release gate calls.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

## Reviewer Verdict

(to be appended by Phase 4 reviewer)
