# PLAN — Cycle STOPERR: stop multi-query run at first error + mark failing statement

Cycle: STOPERR | Date: 2026-09-18 | Base: main

## §1 Intent

User report (verbatim, translated): in a `.sql` file with 3 queries, a long run then a
highlight-and-run produced no error; and when a multi-statement run does error it does not
visibly stop — everything appears to "run to the end", so the user believed it succeeded.
Desired: (a) selection-run surfaces errors exactly like a normal run, (b) a sequential run
halts at the FIRST failing statement, (c) the failing statement is clearly marked
(editor-level highlight + which statement/line failed), (d) the user is explicitly notified
that the run stopped.

## §2 Scope

In scope:
- `src/core/statementParser.ts` — carry real document offsets for selection pieces.
- `src/core/queryRunner.ts` — pin (regression-test) stop-on-first-error semantics.
- `src/extension.ts` — `runQueryFromEditor` per-piece splitting + doc-offset preservation;
  audible feedback on silent no-op paths; post-run "stopped at statement N" notification;
  call the new marker.
- `src/ui/consolePanel.ts` — silent `runSelection` whitespace no-op.
- NEW `src/ui/statementErrorMarks.ts` — decoration/diagnostic marking of failing statements.
- `src/extension.test.ts` — mock additions (`createTextEditorDecorationType`,
  `createDiagnosticCollection`, `setDecorations`) + new tests.

Out of scope: results-panel webview redesign, AI chat paths, `.sh` runScript path,
version bump/package/publish.

## §3 Approach (root cause already diagnosed — do NOT re-derive)

Defect A (selection-run "không error") — silent no-op / divergent paths, verified in source:
1. `runQueryFromEditor` (`extension.ts:3138-3140`) returns SILENTLY when there is no active
   SQL editor (`!editor || languageId !== "sql"`) — e.g. focus is on the Console webview or
   a file bound to `pgsql`/`mssql` language ids. The run never happens and nothing says so.
2. Busy guard (`extension.ts:3420-3425`): while a previous run is in-flight, a second
   run is dropped with only an info toast ("a query is already running…"). Matches the
   report: "chạy 1 lúc" → re-run "không error" — it never executed.
3. `ConsolePanel.handleRunSelection` (`consolePanel.ts:665-672`) returns silently on
   whitespace-only selection text.
4. Split inconsistency: editor selection path uses `splitStatements(combined, dialect,
   { lineBoundaries: true })` on a re-joined string (`extension.ts:3196-3212`), while
   console `onRun` uses `sqlToRun(...)` → `splitStatements` WITHOUT `lineBoundaries`
   (`extension.ts:2801`, `statementParser.ts:1019-1035`). Unterminated multi-statement
   selections merge into one statement, so a different statement set runs than the user
   highlighted, and the error lands on merged text that doesn't match any one statement.
   Probe confirmed: `SELEC * FROM bad_table` un-terminated merges with neighbours.
5. Selection path loses document positions: pieces are `substring`ed, joined with `"\n"`,
   `trim()`ed (`extension.ts:3171-3196`) — `ParsedStatement.start/end` become offsets in
   `combined`, not in the document, so editor marking is impossible today.

Defect B (no visible stop / no mark):
- `QueryRunner.executeAll` ALREADY stops at first error (`queryRunner.ts:537-565`): catch
  marks the statement `error`, marks all remaining `cancelled`, emits `onUpdate`, returns.
  The "runs to the end" report is a VISIBILITY failure, not an execution-order failure:
  - cancelled statements still get tabs + Messages cards, looking like executed statements;
  - NO toast tells the user the run stopped at statement N;
  - NO editor marking exists anywhere — grep finds no `TextEditorDecorationType` /
    `DiagnosticCollection` in the codebase; errors only surface in the results panel.

Design:
1. `splitStatements` gains `opts.baseOffset` (default 0): emitted `start`/`end` =
   `baseOffset +` relative offsets. `runQueryFromEditor` splits EACH selection piece in
   place (baseOffset = document offset of the piece) instead of join+trim+re-split; cursor
   pieces already carry document offsets via `statementAtCursor`. Result: every executed
   statement has document-space `start/end` for marking, and the executed set is exactly
   what the user highlighted (per-piece parse, still `lineBoundaries` per piece).
2. New `src/ui/statementErrorMarks.ts`: owns a `TextEditorDecorationType` (red wavy
   underline + optional gutter/background tint) and a `DiagnosticCollection`
   (`"unicdb-run"`, severity Error) so the failure shows in the editor AND Problems.
   API: `createStatementErrorMarker()` → `{ mark(editor, statements, failedIndex, message),
   clear(), dispose() }`. Marker cleared at the start of each new run.
3. `runStatements` post-run (extension.ts success branch, after `runner.run` settles): if
   any statement `status === "error"`, fire `showErrorMessage("UnicDB: stopped at
   statement N of M — <error> (remaining statements not run)")` and, when the run came from
   an editor document, call `mark(...)` on the failing statement's document range.
   `runStatements` gains an optional `opts.editorContext?: { document, mapToDocument? }`
   — actually simplest: caller passes the already-parsed statements whose `start/end` are
   document-space plus the `TextEditor`; console/CodeLens paths pass nothing (console has
   no document; CodeLens statements already carry doc offsets, so pass editor when the
   active editor matches).
4. Audible no-ops: non-SQL/no-editor early return and whitespace console selection get
   `showInformationMessage` (or Warning) stating nothing ran; busy refusal is upgraded to
   `showWarningMessage` so it is not mistaken for success.
5. Regression-pin `executeAll` stop semantics in queryRunner tests (already implemented —
   tests assert remaining statements never hit the adapter and are `cancelled`).

## §4 Test Plan (TDD — RED first)

- statementParser.test.ts: `baseOffset` shifts start/end; default 0 unchanged; per-piece
  split with baseOffset yields doc-space offsets.
- queryRunner.test.ts: 3 statements, 2nd rejects → statuses `[done, error, cancelled]`,
  adapter called exactly twice (regression pin).
- extension.test.ts: selection-run with middle statement failing → `showErrorMessage`
  called with "stopped at statement 2 of 3"; `setDecorations`/`createDiagnosticCollection`
  invoked with the failing statement's document range; busy-second-run surfaces warning;
  non-sql editor run surfaces info message; per-piece split executes exactly the
  highlighted statements (regression for merged-split).
- consolePanel tests: whitespace runSelection → info message, no run.

## §5 Verification Commands

```bash
npm run typecheck
npm run compile
npx vitest run src/core/__tests__/statementParser.test.ts
npx vitest run src/core/__tests__/queryRunner.test.ts   # or wherever runner tests live
npx vitest run src/extension.test.ts
npm test        # full suite at each wave boundary
```

## §6 Acceptance

- Sequential multi-statement run stops at first error; remaining statements are `cancelled`,
  never executed; user gets an explicit error toast naming statement N of M.
- The failing statement is highlighted in the editor (decoration) and listed in Problems
  when a document context exists; mark clears on next run.
- Selection-run executes exactly the highlighted statements, errors surface identically to
  file runs; previously silent no-op paths (non-sql editor, whitespace selection, busy run)
  all produce visible feedback.
- No regressions: full `npm test` green, typecheck + compile clean.

## Planner Report

PLANNER_MODEL: claude-opus-4-8
PLAN_REVIEW: Approved by swe-2-high (Round 1)

## Plan Review Log

### Round 1

- Reviewer: independent plan reviewer (REVIEW_TARGET_TYPE=plan)
- Verdict: **Approved**

Checklist findings:

- Completeness: covers both diagnosed roots — (A) silent no-op paths (non-SQL editor early
  return, busy guard drop, whitespace console selection) and the editor-vs-console split
  divergence; (B) invisibility of the already-correct stop-on-first-error in
  `queryRunner.ts:537-565` via toast + decoration + diagnostics. Test plan pins each defect
  (regression test for merged split, stop semantics, per-statement marking). No gap found.
- Consistency: §2 scope, §3 design, §4 tests, and §6 acceptance all line up; per-piece
  `baseOffset` split consistently resolves both the offset-loss and the join+trim
  divergence in one move.
- Clarity: minor — §3 point 3 self-revises mid-paragraph (`opts.editorContext?` vs "pass
  editor + doc-space statements"); executor should implement the second variant. §5 runner
  test path is left as "or wherever runner tests live" — executor must locate it. Neither
  is blocking.
- Scope: tight — parser option, one new UI module, extension wiring, mocks/tests.
  `.sh`/webview/AI lanes explicitly excluded.
- YAGNI: `DiagnosticCollection` goes slightly beyond the literal "highlight the failing
  statement" ask, but Problems-panel surfacing is a small, standard complement to the
  decoration and directly serves "mark which statement failed". Acceptable. Note: the plan
  names cancelled-statement cards rendering like executed ones as part of the visibility
  defect but does not change that rendering — the explicit "stopped at statement N of M"
  toast makes this cosmetic rather than blocking.
