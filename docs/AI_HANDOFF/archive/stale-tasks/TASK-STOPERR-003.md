# TASK-STOPERR-003 — Wire stop/marking + fix silent selection-run paths

- Status: `done`
- Owner: `-`
- Reviewer: `unic-smart (code-reviewer)`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 items 1, 3, 4

## Goal

Make selection-run execute exactly the highlighted statements with document-space offsets,
surface a loud "stopped at statement N" notification on first error, mark the failing
statement in the editor via STOPERR-002, and give every previously silent no-op path
visible feedback.

## Target Files

- `src/extension.ts`:
  - `runQueryFromEditor` (~3132-3226): replace join+trim+re-split with PER-PIECE
    `splitStatements(piece, dialect, { lineBoundaries: true, baseOffset: pieceDocOffset })`
    (STOPERR-001). Cursor pieces from `statementAtCursor` already carry doc offsets —
    do NOT re-split them. Keep `lineBoundaries` per piece. Preserve the empty/no-statement
    info messages.
  - Silent early return at ~3139 (`!editor || languageId !== "sql"`) → `showInformationMessage`
    ("UnicDB: no SQL editor is focused — nothing to run." or equivalent).
  - Busy refusal at ~3420 → upgrade `showInformationMessage` → `showWarningMessage` so a
    dropped run is not mistaken for success.
  - `runStatements` (~3391-3575): accept optional `opts.editor?: vscode.TextEditor`
    (new field on the existing opts param). Clear marker at run start (before
    `runner.run`). After `runner.run` settles: if `runSlice` contains `status === "error"`,
    `showErrorMessage("UnicDB: stopped at statement N of M — <error>. Remaining statements were not run.")`
    (N = position within this run, M = runSlice.length), and when `opts.editor` is set,
    `marker.mark(editor, statements, failedStmtIndexInStatements, error)`.
  - Instantiate the marker once (module scope, disposed in `deactivate`).
  - Callers pass `editor` where a document exists: `runQueryFromEditor` → active editor;
    `runStatement` (CodeLens ~3229) → `vscode.window.activeTextEditor` when it matches a
    sql doc; console `onRun` (~2813) → no editor (index-only notification).
- `src/ui/consolePanel.ts` ~665-672: whitespace `runSelection` → `showInformationMessage`
  instead of silent return (panel has no vscode import? check — if absent, surface via
  `onRun` host callback or add minimal import consistent with file's existing imports).
- `src/extension.test.ts`: extend the `vi.mock("vscode")` with
  `window.createTextEditorDecorationType` (returns `{ dispose: vi.fn(), key }`),
  `editor.setDecorations` spy on the fake editor, `languages.createDiagnosticCollection`
  (returns `{ set: vi.fn(), clear: vi.fn(), delete: vi.fn(), dispose: vi.fn() }`),
  `Diagnostic`/`DiagnosticSeverity` stubs as needed.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | 3-stmt selection run, stmt 2 fails → `showErrorMessage` contains "statement 2 of 3" | toast fired | mock runner erroring stmt 2 |
| 2 | unit | same run → `setDecorations` called with range matching stmt 2's document offsets | decoration on failing stmt | selection over 3 `;`-terminated queries |
| 3 | regression | selection of 2 unterminated queries → executes BOTH as separate statements (no merge) | runner got 2 statements | `"SELECT 1\nSELECT 2"` selection |
| 4 | edge | non-sql / no editor run → info message, runner NOT called | audible no-op | `activeTextEditor` null or non-sql |
| 5 | edge | second run while busy → warning message (not silent success) | `showWarningMessage` called | runner.isRunning()=true |
| 6 | edge | all-success run → no error toast, marker cleared at start | mark absent | 2 good stmts |
| 7 | edge | console whitespace runSelection → info message, onRun NOT called | audible | `"   "` text |

## Test Files

- `src/extension.test.ts` — editor-path tests (follow TASK-MSEL harness at ~2676).
- `src/ui/__tests__/consolePanel*.test.ts` — whitespace selection test (find existing file).

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npx vitest run src/ui/__tests__
npm run typecheck
npm run compile
npm test
```

## Acceptance Criteria

- [ ] Error toast names the failed statement index/count; failing statement gets an editor
      decoration + Problems diagnostic when a document context exists.
- [ ] Selection-run runs exactly the highlighted statements with correct doc offsets.
- [ ] All silent no-op paths produce a visible message.
- [ ] Full `npm test` green; typecheck + compile clean.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-STOPERR-001 (`baseOffset`) and TASK-STOPERR-002 (marker module) must be done first.

## Interfaces

- Consumes:
  - `splitStatements(sql, dialect?, { lineBoundaries?: boolean; baseOffset?: number })` (001)
  - `createStatementErrorMarker(): { mark(editor, statements, failedIndex, message); clear(); dispose(); }` (002)
- Produces: `runStatements(..., opts: { useLegacySql?; pageSize?; clearOnStart?; editor?: vscode.TextEditor })`

---

## Discussion

### 2026-09-18 · planner · claude-opus-4-8
Verified facts the executor should trust (don't re-derive):
- `executeAll` stops on first error already — do NOT change the loop; this task is
  UX/visibility only.
- Selection path today loses doc offsets via substring→join("\n")→trim (extension.ts
  :3171-3212). Per-piece split with `baseOffset` fixes both the offset loss AND makes the
  executed set exactly match the highlight.
- `trim()` on `combined` shifts every offset — another reason to split per piece.
- If `consolePanel.ts` has no vscode import, prefer surfacing the whitespace no-op through
  the existing host callback or a pre-run trim check that posts a message — keep it minimal.

(no further comments yet)

---

## Executor Report
EXECUTOR_TOOL: Claude Code
EXECUTOR_MODEL: claude-opus-4-8 (default session model)
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
  src/extension.test.ts > TASK-STOPERR-003 > #1 → expected false to be true // Object.is equality (no "statement 2 of 3" toast)
  #2 → expected undefined not to be undefined (no setDecorations call)
  #3 → expected +0 to be 10 (offsets not in document space)
  #4 → expected 0 to be greater than 0 (silent no-sql-editor return)
  #5 → expected 0 to be greater than 0 (busy refusal was info, not warning)
  consolePanel.test.ts > whitespace runSelection → showInformationMessage never called
  (test #6 passed pre-fix by design — it asserts absence of error toast/mark, which is trivially true before the feature exists; kept as a regression guard)
Verification Output:
  npx vitest run src/extension.test.ts → 192 passed (192)
  npx vitest run src/ui/__tests__ → 141 files, 1968 passed
  npm run typecheck → clean (tsc --noEmit, no output)
  npm run compile → esbuild build complete (webview.js 2.3mb, extension.js 6.6mb)
  npm test → 313 files passed, 4684 passed | 5 skipped (4689)
Status: PASS
Note: Worktree lacked node_modules binaries — symlinked esbuild + vsce from main repo node_modules to unblock webview-bundle tests and the vsce-package test (environment fix, not code). Pre-existing test TASK-ARP02-004 Gap #2 updated to accept the upgraded busy warning (info→warning is this task's spec). In-range `stmt.end` excludes the trailing `;` (parser contract), test asserts char 8 accordingly.

---

## Reviewer Verdict
VERDICT: approved_minor
REVIEWER_MODEL: unic-smart (handoff.reviewer.model lane; ≠ claude-opus-4-8 executor)
EXECUTOR_MODEL: claude-opus-4-8
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor:
    - src/extension.ts:3226 — cursor-only run (no selection) on unterminated multi-statement
      text now pushes `found` verbatim (statementAtCursor splits WITHOUT `lineBoundaries`),
      so "SELECT 1\nSELECT 2" is sent as ONE merged statement (probe: default split = 1,
      old re-split with lineBoundaries = 2) and fails with a syntax error instead of running
      both lines. This is spec-directed ("do NOT re-split") and does fix a real pre-existing
      over-split (a `SELECT`-starting continuation line inside a `;`-terminated statement used
      to be broken apart), so it is recorded as a behavior note, not a defect. If line-boundary
      parity with the selection path is wanted, re-split with
      `splitStatements(piece, dialect, { lineBoundaries: true, baseOffset: found.start })` —
      baseOffset (STOPERR-001) preserves the doc offsets the spec wanted to protect.
    - src/extension.ts:3519 — run-start `statementErrorMarker?.clear()` is NOT wrapped in
      try/catch while `mark()` is; a `setDecorations` throw on a disposed/closed editor would
      escape before `panel.setBusy(true)`. Low risk (VS Code treats it as a no-op), cheap to guard.
    - src/extension.ts:3587 — the toast always appends "Remaining statements were not run.",
      which is wrong when the failing statement is the last one (N === M).
    - src/extension.test.ts:4298 — TASK-ARP02-004 Gap #2 assertion relaxed to accept info OR
      warning; justified by this task's info→warning upgrade, but it no longer pins the channel.
NOTES:
  - Verified `runSlice`/`statements` index alignment: `applyKeywordQualify` preserves length +
    order (spread keeps start/end) and `executeAll` pre-populates one result row per statement
    (remaining rows = "cancelled"), so `failedIndex` → `statements[failedIndex]` is correct and
    M = runSlice.length == statements.length. Cancelled-after-error rows are not marked (only
    `status === "error"`), and `runFailed`'s synthetic row goes through the catch path — both correct.
  - Selection path: per-piece `splitStatements(piece, dialect, { lineBoundaries, baseOffset: start })`
    restores document-space offsets and drops the join/trim offset shift; CodeLens + editor callers
    pass `editor`, console `onRun` does not (no TextDocument) — matches spec.
  - `opts.editor` is stripped via rest-destructure before `runner.run`, so the host-only field
    never reaches the adapter.
NEXT_STATUS_FOR_INDEX: done
