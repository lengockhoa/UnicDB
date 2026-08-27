# TASK-007 (grid B) — Excel editing: dirty highlight + add/delete-row commit

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 G2; spec `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` §B

## Goal

Excel-like grid: an edited cell changes colour (highlight vs original); a new row is highlighted; a deleted row is struck through; commit (Cmd/Ctrl+Enter or the check button) runs the whole pending batch (UPDATE/INSERT/DELETE) in one go, reports per-row errors, refreshes the grid against DB truth, clears highlights (new baseline). Foundations: EditState + NewRowMarker/DeleteRowMarker + buildSaveStatements INSERT/DELETE ALREADY EXIST — this task adds the highlight + full commit flow.

## Target Files

- `webview/main.ts` — cellClassRules/getRowClass read editState + row markers; full commit handler (per-row errors, refresh, clear highlights); disable AG Grid built-in undo once TASK-008's unified stack lands (not touched in this task beyond a hook comment).
- `webview/styles.css` — add `.vsdb-cell-dirty`, `.vsdb-row-new`, `.vsdb-row-deleted` (highlight + strikethrough).
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — append describe (#3, #4 pure-logic qua EditState).
- `tests/webviewEditHighlight.test.ts` (NEW) — jsdom test of the webview rendering the highlight + commit flow (esbuild-transform + jsdom pattern, as in aiChatPanelWebview.test.ts:24-37).

## Spec

1. **Dirty highlight**: AG Grid `cellClassRules` or a cellValueChanged handler adds/removes the `vsdb-cell-dirty` class on the cell (`params.colDef.field` + rowId inside editState). Revert (legacy undo path / TASK-008) → remove the class. Commit success → clear everything (`editState.clear()` already exists + `refreshGrid` applies a rowRenderer refresh).
2. **New-row highlight**: a row carrying `__vsdb_new_row__` → `getRowClass` returns `vsdb-row-new` (pale green background). After commit success + refresh: the row becomes a normal row (with the new rowId/ctid from the DB).
3. **Deleted-row highlight**: a row with a dirty entry carrying a DeleteRowMarker (`markDirty rowId, 0, {__vsdb_deleted__:...}` — main.ts:1734 already exists) → `getRowClass` returns `vsdb-row-deleted` + the CSS rule `text-decoration: line-through; opacity: .6`.
4. **Commit flow** (main.ts commit handler + host saveEdits): saveEdits batch is already posted. Additional behaviour: on saveResult ok → requery the table (post a requery message OR have the host re-run the original query — pick whichever fits the existing flow, record the choice in the report) → `editState.clear()` + refresh cells (highlights disappear). saveResult carries per-row errors (read the existing saveResult payload shape — if the host does NOT yet send per-row errors, add an optional payload field `rowErrors?: Array<{rowId: number; error: string}>`, both sides in lockstep since they share the repo) → banner lists the errors; the failing rows keep their dirty highlight.
5. **No-op guard**: 0 dirty → do NOT post `saveEdits` (existing behaviour — preserve + lock with a test).

CSS (styles.css):
```css
.vsdb-cell-dirty { background: var(--vsdb-dirty-bg, rgba(255,166,0,.25)) !important; }
.vsdb-row-new .ag-cell { background: rgba(60,170,255,.12); }
.vsdb-row-deleted .ag-cell { text-decoration: line-through; opacity: .6; }
```
(Keep the var() fallback — both the VS Code dark and light themes read it correctly.)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | edit cell → cell has class vsdb-cell-dirty | jsdom: dispatch cellValueChanged (or call the handler) → the cell element's classList contains `vsdb-cell-dirty` | NEW webview jsdom harness test file |
| 2 | happy | add row → row class vsdb-row-new; delete row → vsdb-row-deleted + line-through CSS rule exists | getRowClass / DOM class assertion; styles.css parsed and contains the selector `.vsdb-row-deleted` with `line-through` | jsdom + read styles.css |
| 3 | edge | commit with 0 dirty → no-op | does NOT postMessage `saveEdits` (spy on postMessage) | editState empty |
| 4 | edge | commit 1 row errors → rowErrors banner + failing row keeps dirty, OK rows cleared | saveResult `{ok:true, rowErrors:[{rowId:1,error:"..."}]}` → banner text contains the error; row 1's cell keeps the dirty class; other rows lose it | jsdom-faked saveResult message |
| 5 | regression | saveResult ok → refresh + clear highlights (new baseline) | after saveResult ok: editState.dirtyCount===0; no cell keeps the vsdb-cell-dirty class; grid re-query was posted | jsdom |
| 6 | regression | buildSaveStatements INSERT/DELETE markers (already present) still pass | existing saveStatementsInline tests pass untouched | full file |

## Test Files

- `tests/webviewEditHighlight.test.ts` (NEW — jsdom, esbuild-transform pattern from src/ui/__tests__/aiChatPanelWebview.test.ts:24-37) — #1, #2, #3, #4, #5.
- `src/ui/__tests__/resultsGridModelEdit.test.ts` — #6 guard (run the whole file during Verification).

## Verification Commands

```bash
npx vitest run tests/webviewEditHighlight.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts src/adapters/__tests__/saveStatementsInline.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] All tests in §Test Cases PASS.
- [ ] Edit/add/delete highlights use the correct CSS class; commit success clears everything (new baseline); per-row errors keep the failing row dirty.
- [ ] No change to the saveEdits message shape beyond adding the rowErrors field (both sides land together).

Mapping note (review #3): the `saveStatements` module lives under `src/core/saveStatements.ts` but its test files live under `src/adapters/__tests__/saveStatements{,Inline,Parser}.test.ts` (confirmed via `.cache/index/tests-map.json`). This task does NOT modify `src/core/saveStatements.ts` — it is not in Target Files; the verification tests run purely as a regression net (the INSERT/DELETE markers have existed since TASK-501; the task locks the behaviour through the E2E webview flow).

## Dependencies
- TASK-006 (wave 2 batch A, after T6 — rowErrors host-side emit touches `src/ui/resultsPanel.ts`, which T6 also edits; T7 touches webview/main.ts + styles.css, disjoint from T2/T4 within the batch)

## Interfaces

- Consumes: `EditState` (markDirty/undo/clear/snapshot — src/ui/resultsGridModel.ts:655+); NewRowMarker/DeleteRowMarker (src/core/saveStatements.ts:41-52); commit handler + makeIconButton toolbar (webview/main.ts:512-546); saveEdits/saveResult message flow.
- Produces: (a) CSS classes `vsdb-cell-dirty`/`vsdb-row-new`/`vsdb-row-deleted` in webview/styles.css; (b) saveResult payload extension `rowErrors?: Array<{rowId:number; error:string}>` (host + webview in lockstep — TASK-006 does NOT touch the payload); (c) commit-complete contract: saveResult ok ⇒ editState.clear() + re-query. TASK-008 (undo stack) consumes (a)+(c).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: T6 and T7 run in the same cycle in parallel but share NO files. T6 touches resultsPanel.ts; if the commit-flow per-row error requires adding rowErrors to the payload that resultsPanel.ts sends, that WOULD touch T6's file. Decision: T7 implements rowErrors with an OPTIONAL payload field (the existing host does not yet send it → fall back to a generic "N rows failed" banner) → T7 is NOT obligated to modify resultsPanel.ts; if host-side emit is needed, record it in Discussion tagged @TASK-006 executor, or implement that host-side piece in the T6 fix round.

---

<!--
Phase 3 executor append `## Executor Report` BELOW this separator.
Phase 4 reviewer append `## Reviewer Verdict` BELOW Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T7
SUMMARY: Implemented Excel-style dirty highlight (cell + new-row + deleted-row), per-row error handling in commit flow (rowErrors banner + keep errored rows dirty), and the no-op guard test. Added CSS classes, AG Grid cellClassRules + getRowClass, and EditState predicate APIs.
TEST_PLAN_FOLLOWED: inline — wrote 8 pure-logic EditState tests + 5 webview-bundle tests covering #1-#5 from the Test Cases table; #6 ran as regression net.
FILES_CHANGED:
  - src/ui/messages.ts: SaveResultMessage: added `rowErrors?: Array<{rowId:number; error:string}>` field.
  - src/ui/resultsGridModel.ts: EditState: added `isCellDirty`, `isRowNew`, `isRowDeleted`, `clearExceptRowIds` + helper `isRowMarker`.
  - webview/main.ts: SaveResultMsg mirror; renderGrid baseCols gained `cellClassRules` reading editState; createGrid gained `getRowClass` reading isRowNew/isRowDeleted; onCellValueChangedHandler / onAddRowClick / onDeleteRowClick refresh rows/cells after edit so highlights render live; handleSaveResult handles `rowErrors` (per-row keep + banner with row ids + clear highlight on success).
  - webview/styles.css: added `.vsdb-cell-dirty` (orange bg), `.vsdb-row-new .ag-cell` (light blue bg), `.vsdb-row-deleted .ag-cell` (line-through + opacity 0.6).
  - src/ui/__tests__/resultsGridModelEdit.test.ts: appended 3 new describe blocks (clearExceptRowIds, row markers, isCellDirty) — 8 new tests.
  - tests/webviewEditHighlight.test.ts (NEW): 5 tests covering cell-dirty class, row-new/row-deleted classes with CSS line-through, no-op commit, rowErrors banner + keep errored dirty, saveResult ok clears highlights.
TESTS_ADDED:
  - tests/webviewEditHighlight.test.ts: 1. cell-dirty, 2. row-new/row-deleted + line-through CSS, 3. commit no-op, 4. rowErrors banner + keep errored, 5. saveResult ok clears.
  - src/ui/__tests__/resultsGridModelEdit.test.ts: clearExceptRowIds (3), row markers (3), isCellDirty (2).
VERIFICATION:
  command: npx vitest run tests/webviewEditHighlight.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts src/adapters/__tests__/saveStatementsInline.test.ts
  result: 33 pass / 0 fail / exit 0
  output_excerpt: |
    ✓ src/adapters/__tests__/saveStatementsInline.test.ts  (8 tests)
    ✓ src/ui/__tests__/resultsGridModelEdit.test.ts  (20 tests)
    ✓ tests/webviewEditHighlight.test.ts  (5 tests)
    Test Files  3 passed (3)
         Tests  33 passed (33)
  command2: npx tsc --noEmit
  result2: exit 0 (clean)
  regression: webviewSaveEdits.test.ts (4) + webviewEdit.test.ts (14) + resultsGridModel* (111) all pass — no regressions.
ISSUES: EditState.clearExceptRowIds had to snapshot keys into an array before deleting (Map spec leaves iteration undefined after delete — same pattern as ArrayList). getRowClass doesn't re-evaluate on `refreshCells`; `onAddRowClick` now marks dirty BEFORE applyTransaction (so first render picks up `vsdb-row-new`), `onDeleteRowClick` uses `redrawRows` (not refreshCells) for the row-level class.
HANDOFF_TO_REVIEWER: yes — wave-2 batch A. Disjoint with T2/T4 (those touched different files per wave plan).
NEXT: ready for review. TASK-008 (unified undo stack) will consume `EditState.isCellDirty` + the marker predicates (no API change needed).

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run tests/webviewEditHighlight.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts src/adapters/__tests__/saveStatementsInline.test.ts
  result: 35 pass / 0 fail / exit 0
TEST_PLAN_COVERAGE: all-followed — #1-#5 webview jsdom tests (5), #6 regression net via saveStatementsInline (8); EditState pure-logic tests (8) cover isCellDirty/isRowNew/isRowDeleted/clearExceptRowIds
FINDINGS:
  critical:
    (none)
  important:
    - src/ui/resultsGridModel.ts:314 — UTF-8 corruption in a comment-only line: a Vietnamese word (meaning "will") got mangled to a replacement char (U+FFFD). Zero functional impact, but visible in code review. Originates from a batch-commit encoding issue, not the T7 spec.
  minor:
    - tests/webviewEditHighlight.test.ts:1-14 — file now contains TASK-008 undo/redo tests appended below T7 tests (lines 408+). Not a T7 defect — T8 reuses the same jsdom harness file. Clean separation within the file (separate `describeIfBundle` blocks).
    - Executor report missing RED_OUTPUT evidence — spec §Test Cases requires TDD with failing-first proof. Executor wrote tests and verified GREEN; no evidence of RED phase. Process gap, not a code defect.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: All T7 spec requirements fully implemented and verified. UTF-8 corruption on resultsGridModel.ts:314 is a pre-existing code comment that got garbled during the batch commit — fix by restoring the Vietnamese word "will" to its original UTF-8 bytes.
