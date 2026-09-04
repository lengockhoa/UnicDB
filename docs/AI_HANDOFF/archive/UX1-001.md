# TASK-UX1-001 — Console opens from the schema tree with no active editor (R6+R7)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 1), §3 (UX1-001)

## Goal

Left-pane console entry points never produce a visible console when no text editor is
open: `ConsolePanel.show()` creates the webview with `ViewColumn.Active`, which resolves
to nothing without an active editor, and `commandGenerateSelect` refuses outright with
"VSDB: no active editor." Fix both so any left-pane node action opens (or falls back)
without an editor, keeping every editor-present path byte-identical.

## Target Files

- `src/ui/consolePanel.ts` — in `show()`: when `vscode.window.activeTextEditor ===
  undefined && vscode.window.visibleTextEditors.length === 0`, pass `ViewColumn.One` to
  `createWebviewPanel` instead of `ViewColumn.Active`. No other line of `show()` changes.
- `src/extension.ts` — in `commandGenerateSelect` (the `!editor` branch near line 2530):
  do not return early; instead generate the per-dialect SELECT via the existing
  `generateSelectForTable` and write it to the clipboard (`vscode.env.clipboard.writeText`)
  + info toast "VSDB: SELECT đã copy vào clipboard (không có editor để chèn)." The
  editor-present path is untouched. (Wave-1 region contract: this task owns ONLY the
  `commandGenerateSelect` function in extension.ts; UX1-010 concurrently owns ONLY the
  `runStatements` kind-stamping slot — disjoint functions, no serialisation edge.)
- `src/ui/__tests__/consolePanel.test.ts` — new describe block for the view-column choice.
- `src/extension.test.ts` — new describe block for the generateSelect clipboard fallback.
  (Wave-1 region contract: UX1-010 also appends to extension.test.ts in wave 1, but only
  inside its own describe block — keep this task's tests in a separate describe so no
  hunk overlaps.)

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `show()` with no active editor creates in ViewColumn.One | stubbed `vscode.window.activeTextEditor = undefined`, `visibleTextEditors = []` → `createWebviewPanel` received `ViewColumn.One` (numeric `1`), not `ViewColumn.Active` (`-1`) | ConsolePanel with FakeMemento; vscode.window stubbed |
| 2 | edge A — lifecycle | second `show()` call reveals instead of recreating | first call creates (column One); second call → `panel.reveal()` called, `createWebviewPanel` call count stays 1 | panel already created by case 1 |
| 3 | edge B — editor present | `show()` with an active editor keeps ViewColumn.Active | `activeTextEditor` set → `createWebviewPanel` received `ViewColumn.Active` | vscode.window stub with fake editor |
| 4 | edge C — only inactive editors | visible editors exist but none active → ViewColumn.One | `activeTextEditor = undefined`, `visibleTextEditors = [fakeEditor]` → column `One` | vscode.window stub |
| 5 | regression | commandGenerateSelect with no editor copies SELECT instead of toasting refusal | clipboard contains `SELECT * FROM "public"."users" LIMIT 100;`-shaped output and info message shown; RED on main today (early return, clipboard untouched) | `vsdb.generateSelect` invoked with table node meta, no editor |
| 6 | edge B — boundary | generateSelect with no node arg and no editor | info toast "right-click a table/view…", clipboard untouched | arg = undefined |

## Test Files

- `src/ui/__tests__/consolePanel.test.ts` — cases 1–4 (append to existing file).
- `src/extension.test.ts` — cases 5–6 (new describe; follow the existing
  `Spec test #5 — runQuery without connection…` block style at ~line 470).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/consolePanel.test.ts src/extension.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; cases 1 and 5 verified RED before the fix (run the
      targeted tests before editing source and record the failure output in Discussion).
- [ ] No regression in `consoleTabs.test.ts`, `consolePanelBundle.test.ts`,
      `consolePanelMessages.test.ts` or the rest of `src/extension.test.ts`.
- [ ] Editor-present behaviour unchanged (case 3 proves it).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: `ConsolePanel` class + its `show()` (src/ui/consolePanel.ts:173);
  `vscode.window.activeTextEditor` / `visibleTextEditors`; `generateSelectForTable({
  driver, table, schema })` (exported from src/ui/schemaTree.ts, already imported in
  extension.ts:13); `commandGenerateSelect(mgr, qualifiedOrNode)` (extension.ts:2521).
- Produces: `ConsolePanel.show()` now guarantees a visible panel even with no active
  editor — UX1-002/003's console-seeding flows (`seedTab` + `show`) inherit this
  guarantee and MUST NOT re-add an editor requirement.

---

## Discussion

### 2026-09-04 · planner · unic-smart
Root cause corrected from the P1 brief: `vsdb.openConsoleForObject` itself never requires
an editor (it takes a node argument, extension.ts:1942). The invisible-console defect is
`ViewColumn.Active` with no active editor (consolePanel.ts:178,181). The
"VSDB: no active editor." toast the user quoted is `commandGenerateSelect`
(extension.ts:2530) — a separate left-pane trigger, fixed via clipboard fallback. Both
fixes are in this task because they are one user-visible symptom ("không mở được console
từ leftpane").

### 2026-09-04 · executor · unic-code (feature-implementer)
**Discrepancy flagged between spec text and Test Cases table** — Target Files said
"`activeTextEditor === undefined && visibleTextEditors.length === 0`" but Test Case #4
expected `ViewColumn.One` for "visible editors exist but none active". Followed the
test cases table (TDD authority) — implemented the simpler rule
`activeTextEditor === undefined → ViewColumn.One`. All 6 new tests pass green; #1 and
#4 confirmed RED on consolePanel.test.ts (column was `-1`, expected `1`), #5 confirmed
RED on extension.test.ts (clipboard spy not called, `info` toast said "no active editor").
#5 SQL assertion adjusted to `SELECT * FROM public.users LIMIT 100;` (unquoted, matching
`generateSelectForTable({driver:'postgres',table:'users',schema:'public'})` output).
npm test shows `5 failed | 225 passed` — same 5 failures as baseline (esbuild ENOENT
infra in worktree's `node_modules/.bin/`), test count went 3342 → 3348 (+6 new).

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  consolePanel.test.ts TASK-UX1-001:
    ❯ #1 happy: show() with no active editor and no visible editors → ViewColumn.One (1), NOT ViewColumn.Active (-1)
       → expected -1 to be 1 // Object.is equality
    ❯ #4 edge C: visible editors exist but none active → ViewColumn.One
       → expected -1 to be 1 // Object.is equality
  extension.test.ts TASK-UX1-001:
    ❯ #5 regression: vsdb.generateSelect with no editor and a table-node meta → clipboard gets a runnable SELECT
       → expected "spy" to be called 1 times, but got 0 times
    ❯ #6 boundary: vsdb.generateSelect with NO arg and NO editor → info toast guides the user
       → expected 'VSDB: no active editor.' to match /right-click/i

Verification Output: |
  npx vitest run src/ui/__tests__/consolePanel.test.ts
    ✓ src/ui/__tests__/consolePanel.test.ts  (34 tests) 41ms
    Test Files  1 passed (1)
    Tests  34 passed (34)
  npx vitest run src/extension.test.ts
    ✓ src/extension.test.ts  (132 tests) 1289ms
    Test Files  1 passed (1)
    Tests  132 passed (132)
  npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
    ✓ src/adapters/__tests__/bq04SurfaceGuard.test.ts  (4 tests) 109ms
    Test Files  1 passed (1)
    Tests  4 passed (4)
  npm test
    Test Files  5 failed | 225 passed | 1 skipped (231)
    Tests  3348 passed | 2 skipped (3350)
    (5 failures pre-existing: aiChatPanel*Webview*.ts call esbuild directly via worktree node_modules — same on baseline HEAD)
  npm run typecheck
    > vsdb@1.51.0 typecheck
    > tsc --noEmit
    (no output = success)
  npm run compile
    esbuild: build complete (emitted dist/consolePanel.js, dist/schemaForm.js, etc.)
  Regression: consoleTabs.test.ts (9/9), consolePanelBundle.test.ts (18/18), consolePanelMessages.test.ts (31/31) — all green.
Status: PASS
Note: Spec test#1/#4 "no editor → ViewColumn.One" implemented as the simpler rule (Test Cases table authority over Target Files prose). Pre-existing 5 esbuild ENOENT failures in npm test are worktree infrastructure, not caused by this task — verified identical failure set at baseline HEAD.

## Reviewer Verdict
VERDICT: approved
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
  command: npx vitest run src/ui/__tests__/consolePanel.test.ts src/extension.test.ts
  result: 179 pass / 0 fail (34 + 145)
  command: npm run typecheck && npm run compile
  result: both clean (tsc exit 0; esbuild build complete)
  extra: consoleTabs (9) + consolePanelBundle (18) + consolePanelMessages (31) = 58/58 pass; npm test full run: only unrelated load-flaky jsdom-bundle/ssh tests fail (none import extension.ts/consolePanel.ts; webviewRetry passes 6/6 in isolation; executor's own npm test was clean)
TEST_PLAN_COVERAGE: all-followed — cases 1-6 implemented; RED_OUTPUT contains real assertion failures (expected -1 to be 1; spy not called; wrong toast text)
FINDINGS:
  critical: none
  important: none
  minor:
    - file: src/ui/consolePanel.ts:187-190 — rule implemented as `activeTextEditor === undefined -> ViewColumn.One`, simpler than Target Files prose (`&& visibleTextEditors.length === 0`); executor flagged it and Test Cases table #4 is the TDD authority — accepted, prose/case divergence already documented in Discussion.
    - file: src/ui/__tests__/consolePanel.test.ts:98 — ViewColumn mock `Beside: 2` collides numerically with `Two: 2`; harmless (only One/Active asserted) but inconsistent with the real API where Beside === -2.
    - file: src/extension.test.ts (TASK-UX1-001 describe) — no `vi.resetModules()` for the module-level consolePanel singleton (unlike the UX1-002 block); safe today because the no-editor path never creates a webview, but future edits to this block should keep that invariant.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Verified on stable main (6df3d41); worktree was transiently checked out at base dac6503 mid-review by pipeline activity, re-verified after it returned to main. Diff contains only UX1-001 hunks + sibling wave tasks' own hunks (each reviewed under its own task); no out-of-scope edits by this executor.
