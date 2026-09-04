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
