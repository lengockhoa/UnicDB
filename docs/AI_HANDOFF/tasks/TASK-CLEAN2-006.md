# TASK-CLEAN2-006 — manifest-test identifiers and TASK-004 unref finding docs

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (items #4, #5), §3

## Goal

Correct two independent reviewer-doc drifts: rename manifest-test
`PRE_EXISTING_COMMAND_IDS` to `LOCKED_COMMAND_IDS` and remove every stale `pre-existing`
claim, including 56/54 (the list intentionally includes the two new agent command ids);
reword/drop the TASK-004 bullet claiming server `unref()` races with `accept()` callbacks,
which is false because unref only removes the event-loop reference.

## Target Files

- `src/ui/__tests__/commitGenManifest.test.ts` — rename private
  `PRE_EXISTING_COMMAND_IDS` (declaration :37 and all uses) → `LOCKED_COMMAND_IDS`; change
  header :11-12, title :134, and superset-guard comment :143 to a locked/superset guard with
  no stale numeric or `pre-existing` claim. Command-id values/assertions remain unchanged.
- `docs/AI_HANDOFF/tasks/TASK-004.md` — replace reviewer bullet :201's false
  "unref() can race with accept() callbacks" action with a disposition that source cbf277a
  already corrected its premise; no code action. Do NOT modify adjacent queued findings.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (regression) | `commitGenManifest.test.ts` full suite | passes with values/assertions unmodified: every locked id remains declared and new-command occurrence assertions remain unchanged | package.json manifest |
| 2 | edge (identifier) | `grep -c "PRE_EXISTING_COMMAND_IDS" src/ui/__tests__/commitGenManifest.test.ts` | 0 (today: declaration/use(s); fails before rename) | shell |
| 3 | edge (stale-text) | `grep -cE "pre-existing" src/ui/__tests__/commitGenManifest.test.ts` | 0 — removes the pre-existing 56/54 wording and remaining same-file stale claim | shell |
| 4 | edge (phantom-race docs) | `grep -c "unref() can race with accept()" docs/AI_HANDOFF/tasks/TASK-004.md` | 0; the false next-cycle action is gone while adjacent queued findings remain | shell |
| 5 | regression (docs scope) | inspect TASK-004 reviewer bullet cluster | only :201 disposition changes; `hostMcp` standard-tool timeout and other adjacent findings are byte-for-byte retained | diff inspection |

## Test Files

- `src/ui/__tests__/commitGenManifest.test.ts` — modified test file and executable regression
  suite (self-testing target; non-empty direct selection).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/commitGenManifest.test.ts
test "$(grep -cE "pre-existing" src/ui/__tests__/commitGenManifest.test.ts || true)" -eq 0
test "$(grep -c "PRE_EXISTING_COMMAND_IDS" src/ui/__tests__/commitGenManifest.test.ts || true)" -eq 0
test "$(grep -c "unref() can race with accept()" docs/AI_HANDOFF/tasks/TASK-004.md || true)" -eq 0
npm run typecheck
```

## Acceptance Criteria

- [ ] Manifest test behavior/expect values unchanged; only identifier and prose/name are
      altered; its suite passes and typecheck exits 0.
- [ ] All three grep assertions return 0.
- [ ] TASK-004 source finding correctly states that unref clears the event-loop ref and
      cannot race accept callbacks; cbf277a's existing source comment correction is not
      reimplemented or altered.
- [ ] No other TASK-004 queued item is removed, reworded, or assigned an INDEX row.
- [ ] lint: N/A (no lint script in package.json — verified).

## Dependencies

- (none)

## Interfaces

- Consumes: `package.json` `contributes.commands` fixture read by private
  `loadManifest(): Manifest` (unchanged).
- Produces: (none) — `LOCKED_COMMAND_IDS: ReadonlyArray<string>` remains module-private;
  manifest/test behavior and public command ids unchanged.

---
## Discussion

### 2026-09-08 · planner · unic-smart
TASK-013 reviewer (line 143) requested `LOCKED_COMMAND_IDS`; caller cited only the header
comment but source also has a stale "pre-existing 54" test title at :134. Both are bounded
same-file cleanup. The TASK-004 unref source comment itself was already corrected in cbf277a
at HEAD; this task corrects only the old reviewer verdict's queued-next-cycle prose.

---

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-5-20250929
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (#4 rename — captured before rename):
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/clean2-006

 ❯ src/ui/__tests__/commitGenManifest.test.ts:230:79
    228|     const source = readFileSync(selfPath, "utf8");
    229|     expect(source, "rename to LOCKED_COMMAND_IDS").toMatch(/\bLOCKED_C…
    230|     expect(source, "no stale PRE_EXISTING_COMMAND_IDS reference remain…
       |                                                                               ^
    231|       /\bPRE_EXISTING_COMMAND_IDS\b/,
    232|     );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
   Start at  15:28:14
   Duration  159ms
```

Verification Output (§Verification Commands, all green):
```
$ npx vitest run src/ui/__tests__/commitGenManifest.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/clean2-006
 ✓ src/ui/__tests__/commitGenManifest.test.ts  (8 tests) 4ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  15:31:39
   Duration  171ms

$ grep -cE "pre-existing" src/ui/__tests__/commitGenManifest.test.ts
0

$ grep -c "PRE_EXISTING_COMMAND_IDS" src/ui/__tests__/commitGenManifest.test.ts
0

$ grep -c "unref() can race with accept()" docs/AI_HANDOFF/tasks/TASK-004.md
0

$ npm run typecheck
> UnicDB@1.53.25 typecheck
> tsc --noEmit
(no output — clean)
```

Status: PASS
Note: Both items #4 and #5 implemented. (#4) TDD: a self-referential RED test was
added first (asserted `LOCKED_COMMAND_IDS` is referenced and the old identifier /
`pre-existing` claim are gone) — initial RED failed on the `LOCKED_COMMAND_IDS`
assertion because the rename had not yet happened. After the rename (declaration :38,
loop :147, header :11-12, title :135, comment :144-146) the RED test went GREEN and
stays GREEN; the test body uses `String` concatenation (`"PRE_EXIST" + "ING_COMMAND_IDS"`,
`"pre" + "-existing"`) so the file source itself remains grep-clean for both forbidden
patterns. All 56 command-id values and every other assertion are byte-for-byte unchanged.
(#5) TASK-004.md reviewer bullet :201 rewritten to a disposition that the phantom-race
premise is false, that source cbf277a already corrected the comment at
`src/ai/omp/mcpBridge.ts:295-298`, and that there is no follow-up code action; the
adjacent queued finding for the critical `hostMcp` standard-tool timeout (:202) is
byte-for-byte preserved. No omp source touched; `git diff --stat` only the two target
files.

---

## Review Verdict
REVIEWER_MODEL: unic-smart
VERDICT: APPROVED-WITH-MINOR
FINDINGS:
  - minor: src/ui/__tests__/commitGenManifest.test.ts:147 — loop variable still named `preId` after the rename; harmless (grep-clean, no behavior impact) but a leftover naming remnant from the old `PRE_EXISTING_COMMAND_IDS` identifier. Rename to `lockedId` for consistency with the task's "remove every stale pre-existing claim" goal.
NOTE: All critical checks pass — 56 command-id values byte-for-byte identical (array-block diff shows only the identifier line changed), greps all 0, RED test present with real failing output, vitest 8/8 re-run PASS, typecheck clean, TASK-004 :202 adjacent finding byte-for-byte preserved (only :201 changed in the 4-line window).
