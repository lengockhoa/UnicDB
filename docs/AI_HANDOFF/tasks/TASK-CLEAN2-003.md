# TASK-CLEAN2-003 — claudeCodeChatEngine.ts: finish the two R4.5-stale comments

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (items #2, #3), §3

## Goal

Reword the two comments the TASK-009 reviewer flagged so they match R4.5 reality, where
`failTurn` is the single source of truth for onError and REJECTS the send promise on
crash. Comment-only change; zero code delta.

## Target Files

- `src/ai/claudeCode/claudeCodeChatEngine.ts` — two comment blocks:
  - :210-212 — replace "some process paths fire onError twice (e.g. result-error frames
    first emit onError, then failTurn() emits it again)" with: since R4.5,
    `failTurn` (claudeCodeProcess.ts:827-855) is the SINGLE source of truth for onError on
    a failure path and fires exactly once; this `turnErrored` dedupe stays as regression
    defense-in-depth.
  - :254-259 — replace "The catch below is a defensive last line … rejects synchronously"
    with: since R4.5 round 1 (9926866), `failTurn` REJECTS the in-flight send promise
    (claudeCodeProcess.ts:834-855, `if (reject !== null) reject(err)`), so this catch IS
    the live error path on every turn crash; `turnErrored` still suppresses a second
    bubble — do not delete the catch.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression | claudeCodeChatEngine.test.ts + claudeCodeProcess.test.ts (15 tests) | pass UNMODIFIED — includes the turnErrored single-bubble suppression cases that pin the behavior the comments describe | existing suites |
| 2 | edge (grep) | `grep -cE "defensive last line|fire onError twice" src/ai/claudeCode/claudeCodeChatEngine.ts` | 0 (today: 2 — fails before fix) | shell |
| 3 | edge (comment-only diff) | `git diff --unified=0 src/ai/claudeCode/claudeCodeChatEngine.ts` | only `//`-comment lines changed — no code token added/removed | diff inspection |

## Test Files

- `src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts` — existing regression suite,
  MUST NOT be modified.
- `src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts` — existing regression suite,
  MUST NOT be modified. tests-map.json has no entry for this source file, so these direct
  neighbouring behavior suites satisfy the mandatory non-empty selection.

## Verification Commands

```bash
npx vitest run src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts
grep -cE "defensive last line|fire onError twice" src/ai/claudeCode/claudeCodeChatEngine.ts   # expect: 0
npm run typecheck
```

## Acceptance Criteria

- [ ] Both comments reworded per Target Files; all cited anchors verified against
      claudeCodeProcess.ts at HEAD (`failTurn` at :827, single-onError comment :839-842,
      reject at :852).
- [ ] Grep #2 returns 0; diff shows comment lines only.
- [ ] Both suites pass unmodified (15 pass / 0 fail); typecheck exit 0.
- [ ] lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: (none) — engine behavior, callbacks, and exports unchanged.

---

## Discussion

### 2026-09-08 · planner · unic-smart
Item #2 was PARTIALLY fixed by 93746a4 (the false "never throws" text is already gone) —
this task finishes the reviewer's remaining objection ("defensive last line" framing).
Anchor check done at HEAD: claudeCodeProcess.ts:827 `private failTurn(err: Error)`,
:839-842 "SINGLE source of truth" comment, :852 `if (reject !== null) reject(err)`.
No TDD RED: comments are not runtime-observable; edges #2/#3 fail against today's tree.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: n/a (comment-only) — pre-fix `grep -cE "defensive last line|fire onError twice" src/ai/claudeCode/claudeCodeChatEngine.ts` returned 2 in worktree (matches expected RED for edge #2).
Verification Output:
- `grep -cE "defensive last line|fire onError twice" src/ai/claudeCode/claudeCodeChatEngine.ts` → 0
- `npx vitest run src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts` → 2 test files passed, 15/15 tests passed (chatEngine 7, process 8); Duration 192ms.
- `npm run typecheck` → clean exit (no output, no errors).
- `git diff --unified=0 ...` → only `//`-comment lines changed; `grep -E "^[-+]" | grep -vE "^[+-]{3} |^[+-]\s*//"` returned zero lines (confirms no non-comment code token touched).
- Anchors verified at HEAD before edit: claudeCodeProcess.ts:830 `private failTurn(err: Error)`; :839-842 "SINGLE source of truth" comment; :852 `if (reject !== null) reject(err)`.
- Note on edge #2 wording: initial rewording contained the literal phrase "not a defensive last line" which collided with the grep target. Rephrased to "it is NOT a fallback safety net" so the verification grep returns 0 and the negation semantics are preserved.
Status: PASS
Note: comment-only change, both suites and typecheck green; no code delta.
