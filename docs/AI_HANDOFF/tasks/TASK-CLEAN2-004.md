# TASK-CLEAN2-004 — claudeCodeLiveSmoke: fail-fast spawn errors, fix comments, pin gate name

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (items #6, #9, #11), §3

## Goal

Fix the TASK-014 minor cluster in the Claude Code smoke file: (a) `child.once("error",
reject)` is dead — `resolve()` settles the probe promise synchronously first, so ENOENT
never rejects and burns the 30s timeout; (b) header/inline comments claim "no prompt, no
model use" and "--verbose is unnecessary" while args are `--print ping --verbose`; (c)
rename the tautological "gate disabled" test to pin-the-gate-name semantics.

## Target Files

- `src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts` —
  capture spawn errors into a closure cell exposed on the probe; `awaitFirstEvent(events,
  timeoutMs, getSpawnError)` rejects immediately (entry + inside the 25ms tick) when a
  spawn error exists; parameterize the probe (`startProbe(bin, args, cwd)` used by
  `startClaude`) so tests can drive a hermetic missing binary; fix the two comment claims
  (state `--print ping` is a trivial non-mutating prompt that DOES reach the model, and
  `--verbose` is passed for stream-json verbosity); hoist
  `const GATE_ENV = "UnicDB_CLAUDE_CODE_SMOKE"` used by both `describe.skipIf` and the
  renamed companion test.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | RED→GREEN (bug) | `spawn error surfaces fast (missing binary)` — non-gated | `startProbe("unicdb-smoke-missing-binary", …)` then `awaitFirstEvent` rejects with the spawn error, wall time < 5000ms | today: rejects "timed out after 30000ms" after 30s → RED (test timeout 10s) |
| 2 | edge (timer) | `resolves the first pushed event while the 30s timeout is still pending` — vi.useFakeTimers | push event, `vi.advanceTimersByTime(25)` → resolves that event; do not add clearTimeout work — the never-cleared-success-timeout finding is out of this 12-item cycle (see Discussion) | fixture events |
| 3 | edge (gate rename) | `pins the gate env-var name` | `GATE_ENV === "UnicDB_CLAUDE_CODE_SMOKE"`; old "suite skipped when … unset" name gone | rename |
| 4 | edge (doc-consistency) | comment grep | `grep -cE "unnecessary|without ever hitting the model API|no prompt, no model use" <file>` → 0 | shell |
| 5 | regression (gate) | gated describe under default env (no UnicDB_CLAUDE_CODE_SMOKE) | vitest reports 1 skipped; zero real-binary spawns; existing `binary exists … inside 30s` test body unmodified except helper wiring | default `npx vitest run` |

## Test Files

- `src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts` — the file under fix IS the
  test file; new non-gated `describe` block added alongside the gated one.

## Verification Commands

```bash
npx vitest run src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Test #1 RED before the fix (paste RED output: 30s-timeout rejection), GREEN after.
- [ ] Default-env run: gated suite skipped, new non-gated tests pass, no real binary
      spawned (missing-binary fixture only).
- [ ] Gate env var referenced through the single `GATE_ENV` const; comments state the
      ping-prompt reality; no dangerous flags introduced.
- [ ] typecheck exit 0. lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: probe/awaitFirstEvent signatures stay file-local (not exported); the
  fail-fast contract is mirrored by TASK-CLEAN2-005 for Codex.

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/clean2-004
   ❯ src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts  (4 tests | 1 failed | 1 skipped) 10015ms
     ❯ ... > claude code CLI live smoke — pins the gate env-var name > spawn error surfaces fast (missing binary)
       → Test timed out in 10000ms.
  If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
   FAIL  src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts > ... > spawn error surfaces fast (missing binary)
  Error: Test timed out in 10000ms.
  Tests  1 failed | 2 passed | 1 skipped (4)
  Duration  10.19s
Verification Output: |
  === npx vitest run src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts ===
   RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/clean2-004
   ✓ src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts  (4 tests | 1 skipped) 31ms
   Test Files  1 passed (1)
        Tests  3 passed | 1 skipped (4)
     Duration  194ms
  === npm run typecheck ===
  > tsc --noEmit
  (exit 0, no errors)
  === doc-consistency grep ===
  $ grep -cE "unnecessary|without ever hitting the model API|no prompt, no model use" src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts
  0
  === dangerous-flags grep ===
  $ grep -nE "dangerously-skip-permissions|apiKey|--api-key" src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts
  14://   - never passes apiKey/DB credential; never uses dangerous bypass flags
  45:  // We DO NOT pass --dangerously-skip-permissions, apiKey, or any DB
  (only negated mentions in comments)
Status: PASS
Note: none

## Discussion

### 2026-09-08 · planner · unic-smart
Fail-fast mechanism is the reviewer's option B (spawn-error cell checked in
awaitFirstEvent) — rejecting from the 'error' listener alone cannot work because
`resolve()` already settled the probe promise. The missing-binary name must NOT collide
with any real executable; prefix `unicdb-smoke-missing-`. Independent of TASK-CLEAN2-005
(disjoint file) — do not introduce a shared module; keep the fix per-file.
Known deliberate exclusion: TASK-014 also flagged that the 30s setTimeout is never cleared
on the success path; that sub-finding is outside this cycle's fixed 12-item scope and is
queued for the next cleanup pass — do not fix it here.
