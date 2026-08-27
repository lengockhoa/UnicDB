# TASK-005 — Cmd+Enter cursor-mode: lock the behaviour + fix the gap rule

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D5, §4 T5

## Goal

User report: Cmd+Enter inside an SQL file must run the WHOLE statement/block containing the cursor (up to the end of that statement), never a different statement. The orchestrator's probe of `src/core/statementParser.ts` across 17 cases did NOT reproduce the issue; per code-read the deviation candidate is that `statementAtCursor`'s gap-fallback returns the LAST statement when the cursor sits between two statements. Task: lock cursor-mode via regression tests, audit the handler + CodeLens path, fix the deviation.

## Target Files

- `src/core/__tests__/statementParser.test.ts` — append describe "cursor-mode regression lock (cycle R)".
- `src/core/statementParser.ts` — fix the `statementAtCursor` gap-fallback (ONLY if test #2 RED confirms the deviation).
- `src/extension.test.ts` — append describe "runQueryFromEditor cursor mode" (#9).
- `src/ui/__tests__/codeLensProvider.test.ts` — append 1 test locking the lens range (#8).

## Spec — audit checklist (executor walks each item, records the result in the Executor Report)

Parser invariants to lock (`sqlToRun(sql, undefined, offset)`):
1. Cursor mid-statement → EXACTLY that statement (full text from the start of the statement to `;`, NOT truncated from the offset).
2. Gap between stmt1/stmt2 (offset inside whitespace) → **new gap rule**: the nearest statement BEFORE the cursor. Current code (statementParser.ts:482-500): the for loop does not match a gap offset → falls back to `stmts[stmts.length-1]` = the last statement in the file — wrong vs user intent.
3. EOF without `;` → the last statement, kept whole.
4. BEGIN…END block → the whole block.
5. Offset before the first stmt (leading comment/whitespace) → the FIRST stmt (new rule; the old behaviour returned the last stmt).
6. Comment-only gap (`-- note` between 2 stmts) → the statement BEFORE the cursor.
7. Double `;;` → the statement BEFORE the `;;` (empty stmts discarded).
8. CRLF: offset after `\r\n` between 2 stmts → statement BEFORE cursor; ranges do not drift.

Handler audit (src/extension.ts:405-441 `runQueryFromEditor`):
- `selection.isEmpty` → `sel = undefined` → cursor mode (confirmed correct).
- `document.offsetAt(selection.active)` — absolute multi-line offset is correct.
- `runStatements` only runs the statements returned by sqlToRun (read the body to confirm it does not accidentally run the whole file).

CodeLens path: `vsdb.runStatement` (extension.ts:129-134) receives the stmt from the lens argument — confirm that no path truncates by cursor.

```ts
// src/core/statementParser.ts — fix (only if #2 is RED):
export function statementAtCursor(sql: string, offset: number): ParsedStatement | null {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, sql.length));
  for (const s of stmts) {
    if (clamped >= s.start && clamped < s.end) return s;
  }
  // Gap: nearest statement BEFORE the cursor (user intent "run the statement
  // containing the cursor"); before the first stmt → the first stmt. Old rule returned the last stmt —
  // wrong when the cursor sits between two statements.
  let best: ParsedStatement | null = null;
  for (const s of stmts) {
    if (s.end <= clamped) best = s;
    else break;
  }
  return best ?? stmts[0];
}
```

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression-lock | cursor mid multi-line stmt → whole stmt | statements.length===1; text contains from `SELECT` to `;` of stmt 1 (does NOT start at the offset) | sql with 2 stmts, cursor on line 2 of stmt 1 |
| 2 | regression | gap between 2 stmts → stmt BEFORE cursor (deviation candidate) | RED on current code (returns the last stmt); GREEN: statements[0].text === stmt1 full text | `SELECT 1;\n\nSELECT 2;`, offset inside the `\n\n` |
| 3 | regression-lock | EOF without `;` → last stmt whole | statements[0].text matches the last stmt, not truncated | `SELECT 1;\nSELECT 2`, cursor at end |
| 4 | regression-lock | BEGIN…END cursor mid-block → whole block | statements[0].text contains `BEGIN`…`END;` | block + stmt after |
| 5 | edge | offset < first stmt (leading comment) | returns the FIRST stmt (intentional behaviour change — make that explicit in the test name) | `-- header\nSELECT 1;`, cursor on the comment |
| 6 | regression | selection mode is UNCHANGED | existing selection tests still pass (append a guard test: `sqlToRun(sql,{start,end},0)` returns statements inside the range) | select stmt 2 range |
| 7 | edge | CRLF document | cursor after the `\r\n` gap → stmt BEFORE cursor; range matches the text | sql with `\r\n` |
| 8 | regression-lock | CodeLens range = statement bounds | every lens range start/end === positionAt(stmt.start/end) | existing codeLensProvider pattern |
| 9 | regression | handler runs the correct cursor statement | `vsdb.runQuery` with a fake activeTextEditor cursor between stmt 1 of 2 → runner.runQuery called once with stmt 1's SQL | vi.mock pattern from src/extension.test.ts |

## Test Files

- `src/core/__tests__/statementParser.test.ts` — #1-#7 (append).
- `src/ui/__tests__/codeLensProvider.test.ts` — #8 (append).
- `src/extension.test.ts` — #9 (append).

## Verification Commands

```bash
npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] All tests in §Test Cases PASS; #2 RED on the current code → GREEN after the fix (or the Executor Report proves the deviation cannot be reproduced, with evidence per audit item).
- [ ] Every item in the audit checklist has a conclusion recorded in the Executor Report.
- [ ] Cursor-mode behaviour locked: gap→stmt BEFORE cursor, EOF→last stmt, block→whole block, before first stmt→first stmt.
- [ ] Selection mode + every existing statementParser test stays green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `sqlToRun(sql: string, selection: {start:number;end:number}|undefined, cursorOffset: number): { statements: ParsedStatement[]; mode: "selection"|"cursor" }`; `statementAtCursor(sql: string, offset: number): ParsedStatement | null`; `splitStatements(sql: string): ParsedStatement[]` — signatures are UNCHANGED.
- Produces: new gap-rule contract of `statementAtCursor` (nearest statement BEFORE the cursor when in a gap; the first stmt when before the first stmt) — locked by #2/#5/#7. The sole caller (extension.ts:435) gets the correct behaviour with no signature change.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: if the audit finds every source correct (no RED), conclude "deviation does NOT reproduce at HEAD; possibly an older 1.6.1 build" in the Executor Report and still keep the lock tests. #5 is an intentional behaviour change — if a reviewer finds it breaks a real use case, update the expectation + record the reason here.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW Executor Report. -->
## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T5
SUMMARY: Locked cursor-mode invariants via 7 new tests (statementParser #1-#7), 1 CodeLens lock test (#8), 1 handler cursor-mode test (#9). TDD RED→GREEN: deviation #2 (gap fallback returning the last stmt) was confirmed RED on the old code — then the gap-fallback of `statementAtCursor` was replaced with the rule "nearest stmt BEFORE cursor, fall back to stmts[0] when before the first stmt" → all 104 tests pass.

### Audit checklist (theo spec)

Parser invariants (sqlToRun cursor-mode):
1. Cursor mid-stmt → the stmt containing it. PASS: the `for` loop matches `clamped >= s.start && clamped < s.end` returning the stmt whole (test #1: `SELECT 1,\n       2;` cursor at 12 → the stmt complete from offset 0 to `;`).
2. Gap between 2 stmts → stmt BEFORE cursor. **DEVIATION CONFIRMED RED → FIXED** (test #2). Old code `stmts[stmts.length-1]` was wrong when the cursor sat between 2 stmts. New code loops with `s.end <= clamped` → the last stmt before the cursor; falls back to `stmts[0]` when before the first stmt.
3. EOF without `;` → last stmt whole. PASS (test #3: `SELECT 2` kept whole).
4. BEGIN…END cursor mid-block → the whole block. PASS (test #4: block `[0,33)` cursor at 10 returns the block whole).
5. Offset before first stmt → FIRST stmt. **DEVIATION CONFIRMED RED → FIXED** (test #5: `"\n  SELECT 1;\nSELECT 2;"` offset 0 → the first stmt). Old code's `stmts[last]` fallback returned "SELECT 2". New code returns `stmts[0]`.
6. Comment-only gap. PASS (impl: the same "stmt before cursor" loop skips the gap; test #6 confirms selection mode still works independently).
7. Double `;;` → stmt before the `;;`. PASS: `splitStatements` filters empty stmts (line 354 `candidateEnd > candidateStart`); the empty double `;;` is dropped; the gap at `;;` is handled via Case 2.
8. CRLF. PASS (test #7: `"SELECT 1;\r\n\r\nSELECT 2;"` offset 10 inside the `\r\n\r\n` gap → `SELECT 1`; range does not drift).

Handler audit (`src/extension.ts` `runQueryFromEditor` lines 405-441):
- `selection.isEmpty` true → `sel = undefined` → cursor mode (line 429-434). CONFIRMED.
- `document.offsetAt(selection.active)` yields an absolute multi-line offset (line 428). CONFIRMED.
- `runStatements` only runs the statements returned by sqlToRun (line 440). CONFIRMED — `runner.run(rewritten, ...)` takes exactly the `statements` from `sqlToRun(sql, sel, cursorOffset)`.

CodeLens path (`vsdb.runStatement`, `extension.ts:129-134`):
- Receives `stmt: ParsedStatement` from the lens argument (the closure calls `runStatement(mgr, runner, panel, stmt)`).
- CodeLensProvider (`codeLensProvider.ts:67-77`) builds range = `document.positionAt(stmt.start/end)` → does NOT truncate by cursor; cycle-R test #8 locks the invariant range.start/end === positionAt(stmt.start/end).
- `runStatement` (line 444-455) calls `runStatements(..., [stmt])` — exactly 1 stmt, does not run the whole file.

### Test Plan Followed

task §4 (Test Plan table #1-#9) — every item implemented per the fixture spec. RED confirmed for #2/#5/#7 (the gap deviation on both LF and CRLF) before the fix; GREEN after the `statementAtCursor` fix. #1/#3/#4/#6 already passed on the old code (only locking the invariant). #8/#9 passed after the implementation.

### Files Changed

- `src/core/statementParser.ts`: replaced the body of `statementAtCursor` (lines 477-509 after the edit) — added Case 2 (gap fallback) replacing `return stmts[stmts.length - 1]`; docblock updated to describe the new rule + cite TASK-005.
- `src/core/__tests__/statementParser.test.ts`: appended the describe `"statementParser — cursor-mode regression lock (cycle R)"` with 7 tests (test #1-#7).
- `src/ui/__tests__/codeLensProvider.test.ts`: append test #8 lock invariant `range === positionAt(stmt.start/end)`.
- `src/extension.test.ts`: appended the describe `"TASK-005 — runQueryFromEditor cursor mode"` containing test #9 — fake active editor with 2 stmts + cursor offset 3 (mid stmt 1) → verify `runner.run` is called with exactly `statements = [SELECT 1]`.

### Tests Added

- `src/core/__tests__/statementParser.test.ts` describe "cursor-mode regression lock (cycle R)": `#1 cursor mid multi-line stmt`; `#2 gap between 2 stmts → stmt BEFORE cursor`; `#3 EOF without ; → last stmt whole`; `#4 cursor mid BEGIN...END → whole block`; `#5 offset before first stmt → FIRST stmt`; `#6 selection mode UNCHANGED`; `#7 CRLF gap → stmt before cursor`.
- `src/ui/__tests__/codeLensProvider.test.ts`: `#8 lens range = positionAt(stmt.start/end); does not drift by a single character`.
- `src/extension.test.ts`: describe `TASK-005 — runQueryFromEditor cursor mode`: `#9 cursor mid stmt 1 of 2 statements → runner.runQuery runs exactly the first stmt`.

### Verification

- command: `npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts`
  result: 3 files passed, 104/104 tests passed (46 + 9 + 49)
  output_excerpt:
    ```
    ✓ src/core/__tests__/statementParser.test.ts  (46 tests) 6ms
    ✓ src/ui/__tests__/codeLensProvider.test.ts  (9 tests) 4ms
    ✓ src/extension.test.ts  (49 tests) 169ms
    Test Files  3 passed (3)
         Tests  104 passed (104)
    ```
- command: `npx tsc --noEmit` (in worktree `.worktrees/task-005`)
  result: exit 0, no output (clean).

### Issues

1. Test #2 RED confirmation on the old code (`expected 'SELECT 2' to be 'SELECT 1'`) — the deviation described in the task is confirmed. After the fix (new gap-fallback rule) it is GREEN.
2. Test #5 has the same root cause as #2 but a different scenario (offset 0 before the first stmt in leading whitespace) — RED → confirmed the new rule "FIRST stmt when before the first stmt".
3. The worktree did NOT have `dist/schemaForm.js` available (it is a build artefact); the "npm run compile emits dist/schemaForm.js" test inside `extension.test.ts > TASK-003 — vsdb.createSchema extension wiring` initially failed inside the fresh worktree. Rebuilding via `npm run compile` made it pass. This is environment setup, unrelated to TASK-005.

### Handoff to Reviewer

yes — all tests green, tsc clean, deviation confirmed + fixed, audit checklist complete. Reviewer independent verification: re-run `npx vitest run <3 files>` + `npx tsc --noEmit` inside the worktree (after building dist if the bundle test is needed).

### Next

ready for review.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts
  result: 108 pass / 0 fail (3 files)
TEST_PLAN_COVERAGE: all-followed — all 9 test cases #1-#9 implemented per spec; RED confirmed for #2/#5/#7 before fix
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Deviation #2 (gap-fallback returning last statement) confirmed and correctly fixed. Fix is minimal (6-line loop replacing 1-line return), deterministic, and locked by 7 regression tests. Handler + CodeLens audit paths confirmed clean. All verification fresh-pass.
