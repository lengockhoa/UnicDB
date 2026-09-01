# TASK-DX01-002 — `scripts/verify-release.sh` POSIX runner

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Parent plan: `docs/AI_HANDOFF/PLAN_DX01.md` §3

## Goal

Add a portable POSIX shell runner at `scripts/verify-release.sh` that composes the existing `verify:release` pipeline (`npm test && npm run typecheck && npm run compile`) into a single, exit-code-propagating, stage-labelled command. The runner is POSIX-only (`/bin/sh`), prints `PASS <stage>` per stage, prints a final `OK verify:release` or `FAIL verify:release`, and propagates the first non-zero exit code unchanged. It must be exercised by `TASK-DX01-003` without depending on the real `npm`/`tsc`/`node`/`esbuild` binaries (PATH-stubbed fixtures only).

## Target Files

- `scripts/verify-release.sh` (new) — POSIX shell script, executable, opens with a POSIX shebang. Pinned first-lines (set-membership, not regex):
  - `#!/bin/sh`
  - `#!/usr/bin/env sh`
  - `#!/usr/bin/env bash`

  Stages in fixed order with pinned labels: stage 1 = `npm-test`, stage 2 = `typecheck`, stage 3 = `compile`. Between stages, prints `PASS <stage>`; on a non-zero exit, prints `FAIL <stage>` to stdout, then prints `FAIL verify:release` to stdout, then exits with that non-zero code. No ANSI escapes, no trailing whitespace per line, no `set -e` swallowing. The exact stage labels are pinned to `npm-test`, `typecheck`, `compile` so the contract test in TASK-003 can match them literally.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `verify-release.sh` prints PASS per stage and final OK on all-zero exit | Three `PASS <stage>` lines in fixed order `npm-test` → `typecheck` → `compile`; final `OK verify:release`; exit 0 | Temp dir with stub `bin/{npm,tsc,node,esbuild}` symlinked to `true` (exit 0, no stdout); runner invoked with `PATH="$tmp/bin:$PATH"` |
| 2 | edge | first non-zero stage aborts and prints FAIL | First stage (`npm-test`) exits 3 → `FAIL npm-test` line printed, `FAIL verify:release`, runner exits 3 (not 0); no later stage runs; no `PASS` line for later stages | Same fixture; first stub (`npm`) symlinked to a 3-line script that does `exit 3`; `tsc`/`node`/`esbuild` to `true` |
| 3 | edge | stdout/stderr are separated, no trailing whitespace, no ANSI | Captured stdout/stderr contain no `\r`, no ``, no trailing space per line; stderr is empty on success | Same fixture as #1 |
| 4 | unit | runner is executable and has a POSIX shebang | `fs.statSync(...).mode & 0o111 !== 0`; first line is exactly one of `"#!/bin/sh"`, `"#!/usr/bin/env sh"`, `"#!/usr/bin/env bash"` (string set-membership, not regex) | Direct read of the file in the test, no exec |

## Test Files

- `src/__tests__/releaseVerify.test.ts` (added by TASK-DX01-003) — describe block literally named `"verify-release.sh"` so `npx vitest run -t "verify-release.sh"` matches cases 1–4; cases 1–3 use `child_process.spawnSync` against the script with a PATH-stubbed fixture created in a temp dir, capture stdout+stderr, and assert.

## Verification Commands

```bash
# Focused contract test for the runner behavior (pinned describe name "verify-release.sh"):
npx vitest run src/__tests__/releaseVerify.test.ts -t "verify-release.sh"

# Manual end-to-end on the developer's shell (POSIX bash or zsh only):
bash /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/scripts/verify-release.sh ; echo "exit=$?"

# Full gate
npm run typecheck
npm run compile
npx vitest run src/__tests__/releaseVerify.test.ts
```

## Acceptance Criteria

- [ ] `scripts/verify-release.sh` exists, is executable on POSIX (`chmod +x` semantics observable via `mode & 0o111`), and starts with a POSIX shebang (one of the three pinned first-lines above — test #4).
- [ ] On a clean checkout with real `npm`/`tsc`/`node`/`esbuild` available, the script exits 0 and prints three `PASS <stage>` lines (`PASS npm-test` → `PASS typecheck` → `PASS compile`) plus a final `OK verify:release` (test #1).
- [ ] If `npm test` exits non-zero, the script prints `FAIL npm-test`, prints `FAIL verify:release`, and exits with the same non-zero code; later stages do not run (test #2).
- [ ] No ANSI escape, no carriage return, no trailing whitespace on any printed line; stderr is empty on the success path (test #3).
- [ ] The script references `npm test`, `npm run typecheck`, and `npm run compile` by name (NOT by re-implementing the test runner or typecheck logic) — the contract test for `TASK-DX01-001` pins those exact script names. (Note: this is the only point where the runner's hardcoded command names overlap with `TASK-DX01-001`'s "referenced by name only" — the runner's stage labels are pinned separately above.)
- [ ] No file outside the cycle's owned target set (`scripts/verify-release.sh`) is modified by this task; the consumer (the orchestrator's R5 release run) MAY invoke the script, but the script is NOT referenced by any other source file.
- [ ] `npm run typecheck` and `npm run compile` exit 0; `npx vitest run` shows no regression vs. the v1.35.0 baseline.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-DX01-001 (the script entries the runner calls by name)
- TASK-DX01-003 (the contract test for the runner — TDD-RED-first: 003 writes the test, expects RED on cases 1–3/4, then this task's `scripts/verify-release.sh` write flips it GREEN)

## Interfaces

- Consumes: `package.json` script keys `scripts["verify:release"]` (composed as `npm test && npm run typecheck && npm run compile` by TASK-DX01-001). The runner invokes these via `npm` — it does NOT reimplement them. The three sub-command strings `npm test`, `npm run typecheck`, `npm run compile` are hardcoded in the runner so per-stage `PASS <stage>` / `FAIL <stage>` lines can be emitted; stage labels are pinned to `npm-test`, `typecheck`, `compile` and asserted by TASK-003 cases 1–2.
- Produces: an executable `scripts/verify-release.sh` whose contract is "exit 0 + three PASS lines (`npm-test` → `typecheck` → `compile`) + `OK verify:release` on full success, or exit N + `FAIL <stage>` + `FAIL verify:release` on first failure". This contract is asserted by `TASK-DX01-003` cases 1–4 and is the documented behaviour the R5 release gate calls.

---

## Discussion

(no comments yet)

---

## Executor Report

(to be appended by Phase 3 executor)

## Reviewer Verdict

(to be appended by Phase 4 reviewer)
