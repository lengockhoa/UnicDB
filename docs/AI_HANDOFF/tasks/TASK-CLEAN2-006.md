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
