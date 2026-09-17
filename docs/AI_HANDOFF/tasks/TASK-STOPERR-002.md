# TASK-STOPERR-002 — Editor marking module for failing statements

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 item 2

## Goal

Create `src/ui/statementErrorMarks.ts`: a self-contained marker that draws a red wavy
underline (TextEditorDecorationType) on the failing statement's document range and adds a
matching entry to a `DiagnosticCollection` so the error appears in Problems. Cleared on
each new run.

## Target Files

- `src/ui/statementErrorMarks.ts` — NEW. Owns one `TextEditorDecorationType`
  (`textDecoration: "underline wavy"` + theme-aware `overviewRulerColor`/gutter tint) and
  one `vscode.languages.createDiagnosticCollection("unicdb-run")`.
- `src/ui/__tests__/statementErrorMarks.test.ts` — NEW tests (mock vscode surface minimal:
  the file must keep vscode access injectable or the test provides a light `vi.mock`).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | `mark(editor, stmts, failedIdx, msg)` sets decoration on `Range(stmt.start, stmt.end)` of failed stmt + one Diagnostic | decoration + collection updated | 3 stmts, failedIdx=1 |
| 2 | edge | `mark` with `failedIdx` out of range / stmts empty | no-op, no throw | failedIdx=5 |
| 3 | edge | `clear()` before any mark | no-op, no throw | fresh marker |
| 4 | unit | second `mark` replaces prior decoration + diagnostic (single failure visible) | collection has exactly 1 entry | mark twice |
| 5 | regression | `dispose()` disposes decoration type + collection | dispose called on both | — |

## Test Files

- `src/ui/__tests__/statementErrorMarks.test.ts`

## Verification Commands

```bash
npx vitest run src/ui/__tests__/statementErrorMarks.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] Module exports `createStatementErrorMarker()` → `{ mark, clear, dispose }`.
- [ ] `mark(editor: vscode.TextEditor, statements: ParsedStatement[], failedIndex: number, message: string): void`
      decorates `editor.document.positionAt(stmt.start)..positionAt(stmt.end)` and publishes
      a `Diagnostic` (severity Error, source "UnicDB") on the document URI.
- [ ] `clear()` removes decorations + diagnostics; called by consumers at run start.
- [ ] No regression; typecheck + compile clean.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — module is self-contained; wiring into extension.ts is TASK-STOPERR-003.
  `ParsedStatement` import from `../config/types` (start/end are document offsets).

## Interfaces

- Consumes: `ParsedStatement { text; start; end }` (document-space offsets — produced by
  TASK-STOPERR-001's `baseOffset`).
- Produces: `createStatementErrorMarker(): { mark(editor, statements, failedIndex, message): void; clear(): void; dispose(): void }`
  — consumed by TASK-STOPERR-003 in `extension.ts`.

---

## Discussion

### 2026-09-18 · planner · claude-opus-4-8
Nothing in the codebase decorates the editor on run failure today (no
TextEditorDecorationType / DiagnosticCollection anywhere) — that is the user's "không
đứng lại, không đánh dấu" defect. Keep the module vscode-mock-friendly: the big
`extension.test.ts` mock lacks `createTextEditorDecorationType` /
`createDiagnosticCollection`; this task's own test file owns its minimal `vi.mock("vscode")`
(extension.test.ts mock extension belongs to 003).

(no further comments yet)

---
