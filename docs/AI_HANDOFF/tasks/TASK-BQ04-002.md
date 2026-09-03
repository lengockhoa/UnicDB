# TASK-BQ04-002 — webview cell-renderer switch to `formatBigQueryCell`

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 BQ-04.2, §3 Approach 3-4, §4 rows 002.a-e

## Goal

Add a pure switch helper `formatDataCellForDialect(value, field?, dialect?)` to `src/ui/resultsGridModel.ts` that renders BigQuery cells via the frozen-tested `formatBigQueryCell(value, field)` (imported from `../adapters/bigqueryPages`) when `dialect === "bigquery"`, and falls through to the verbatim `formatCell(value)` otherwise. Wire it into `webview/main.ts` at the value-viewer (line 2523) and the data-cell renderer (`formatDataCell`, line 2596). `formatCell` behavior and `formatBigQueryCell` itself stay byte-identical.

## Target Files

- `src/ui/resultsGridModel.ts` — add + export the pure helper `formatDataCellForDialect` (see Interfaces). Import `formatBigQueryCell` from `../adapters/bigqueryPages` (pure module — its only import is `./bigqueryTypes`, verified; no vscode, no I/O). Do NOT import the frozen `src/adapters/bigqueryTypes.ts` directly; type `field` with a local structural alias. Do NOT edit `formatCell` or the existing `StatementResult` mirror (TASK-BQ04-001 owns the mirror edit and runs in wave 1).
- `webview/main.ts` — replace the two direct `formatCell` render call sites with the switch helper: value-viewer `overlay.textContent = ...` (line 2523) and `formatDataCell`'s `return formatCell(v)` (line 2596). The helper needs `dialect` + `schemaFields` of the ACTIVE statement — read them from the statement object the grid is currently rendering (the `StatementResult` already carries both fields from TASK-BQ04-001 through the `state` payload; the webview holds `results` and `activeTab`). csvMode (`String(v)` raw) and the `(NULL)` wrapper in `formatDataCell` keep their existing precedence — only the final formatted (non-csv) branch switches. Import the helper from `../src/ui/resultsGridModel` (the file already imports `formatCell` from there at line 49).
- `src/ui/__tests__/resultsGridModel.test.ts` — append a new `describe("BQ-04 formatDataCellForDialect")` block with the tests below. Do NOT modify existing tests in this file.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | BQ REPEATED renders compact `[1,2]`, not JSON | `formatDataCellForDialect([{v:1},{v:2}], field, "bigquery")` returns exactly `"[1,2]"` (formatBigQueryCell's REPEATED branch), NOT `"[{\"v\":1},{\"v\":2}]"` | `field = { name: "arr", type: "INT64", mode: "REPEATED" }` |
| 2 | happy | BQ RECORD renders compact `{1,a}`, not JSON | `formatDataCellForDialect({f:[1,"a"]}, field, "bigquery")` returns exactly `"{1,a}"` | `field = { name: "r", type: "RECORD" }` |
| 3 | edge (non-BQ fall-through) | postgres/mysql/mssql/undefined fall through to `formatCell` | `formatDataCellForDialect(new Date(0), undefined, "postgres")` returns `"1970-01-01T00:00:00.000Z"` (formatCell ISO); `formatDataCellForDialect(10n, undefined, "mysql")` returns `"10"`; `formatDataCellForDialect(v, undefined, undefined)` equals `formatCell(v)` | plain JS values |
| 4 | edge (absent optional input) | BQ with `field` undefined renders without throwing | `formatDataCellForDialect("12345", undefined, "bigquery")` returns `"12345"` verbatim (INT64 string NOT Number-coerced) | no field |
| 5 | edge (null/empty) | null/undefined keeps each formatter's own empty semantics | `formatDataCellForDialect(null, field, "bigquery")` returns `""` (BQ marker); `formatDataCellForDialect(undefined, undefined, "mssql")` returns `""` (formatCell marker) | — |
| 6 | edge (BQ type variety through the switch) | INT64/NUMERIC/BIGNUMERIC/BYTES/JSON/temporal strings pass verbatim | table-driven: `NUMERIC "1.5"` → `"1.5"`; `BIGNUMERIC "1.23456789012345678901234567890123456789"` → verbatim; `BYTES "aGVsbG8="` → verbatim base64; `JSON "{\"a\":1}"` → verbatim; `TIMESTAMP "2026-01-01 00:00:00 UTC"` → verbatim — the switch must not mangle canonical strings | one case per family |
| 7 | regression | existing grid-model tests stay green; `formatCell` unchanged | all pre-existing tests in `src/ui/__tests__/resultsGridModel*.test.ts` pass unmodified; `formatCell`'s 5 branches still behave identically (assert via one spot-check `formatCell(new Date(0))` → ISO inside the new describe block) | current files |

## Test Files

- `src/ui/__tests__/resultsGridModel.test.ts` — new `describe("BQ-04 formatDataCellForDialect")` block appended. Match the file's existing import/style conventions (it imports the pure functions from `../resultsGridModel` directly — no jsdom, no webview bundle needed for the helper).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsGridModel.test.ts
npm run typecheck
npm test
```

(`npm test` is the cycle-end full gate — run it once at the end of this task to prove no cross-suite regression, since `webview/main.ts` is edited here.)

## Acceptance Criteria

- [ ] `formatDataCellForDialect` exported from `src/ui/resultsGridModel.ts`, pure (no vscode, no DOM, no I/O).
- [ ] `webview/main.ts` line-2523 value-viewer and line-2596 `formatDataCell` route through the helper for the non-csv formatted branch; csvMode `String(v)` and `(NULL)` wrapper behavior unchanged.
- [ ] BQ cells render via `formatBigQueryCell` (REPEATED `[1,2]`, RECORD `{1,a}`, INT64 strings never Number-coerced); non-BQ cells byte-identical to today.
- [ ] `formatBigQueryCell` itself NOT modified — `git diff 75cdb08 -- src/adapters/bigqueryPages.ts` is empty.
- [ ] All 7 test rows pass; no pre-existing test in `resultsGridModel*` suites regresses.
- [ ] `npm run typecheck` and full `npm test` green.
- [ ] No new webview message type; `dialect`/`schemaFields` read off the existing `state` payload's `results` entries.

## Dependencies

- TASK-BQ04-001 (consumes `StatementResult.dialect` + `StatementResult.schemaFields` on the mirror interface it stamps; wave 1 → wave 2 order also keeps the shared `src/ui/resultsGridModel.ts` file single-owner per wave).

## Interfaces

- Consumes (from TASK-BQ04-001): `StatementResult.dialect?: "bigquery" | SqlDialect`; `StatementResult.schemaFields?: ReadonlyArray<{ name?: string; type?: string; mode?: string }>`; `formatBigQueryCell(value: BigQueryValue | null | undefined, field?: BigQuerySchemaField): string` (exported at `src/adapters/bigqueryPages.ts:252`, reuse-only).
- Produces: `export function formatDataCellForDialect(value: unknown, field?: { name?: string; type?: string; mode?: string }, dialect?: string): string` — pure; `dialect === "bigquery"` → `formatBigQueryCell(value, field)`; otherwise → `formatCell(value)`.

---

## Discussion

<!--
AIs talk to each other HERE, not via any other tool.
-->

(no comments yet)

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
  Vitest ran the new `describe("BQ-04 formatDataCellForDialect")` block BEFORE the helper existed. The first 6 rows failed with `TypeError: formatDataCellForDialect is not a function` from `src/ui/__tests__/resultsGridModel.test.ts`; the 46 pre-existing rows continued to pass. Concretely:
    1. row 002.a REPEATED — `TypeError: formatDataCellForDialect is not a function` (call site in the test)
    2. row 002.a RECORD — same TypeError
    3. row 002.b postgres Date ISO — same TypeError
    4. row 002.b mysql bigint — same TypeError
    5. row 002.c BQ with `field` undefined — same TypeError
    6. row 002.d null/empty (BQ null + mssql undefined) — same TypeError
  Row 002.e (BQ type-variety table) was a single test with 5 sub-asserts; the same TypeError fired before the type-variety table even ran.
  Pre-existing 46 rows in resultsGridModel.test.ts remained green, proving the new describe block was the only RED contributor and no existing test was disturbed.
Verification Output:
  command: npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/webviewBundle.test.ts
  result: 61 passed (52 resultsGridModel incl. 6 new BQ-04 rows + 9 webviewBundle) | 0 failed
  command: npm run typecheck
  result: tsc --noEmit exit 0 (helper import resolves, all call sites compile)
  command: git diff 75cdb08 -- src/adapters/bigqueryPages.ts
  result: empty (0 lines — `formatBigQueryCell` byte-untouched, reused as-is)
  command: git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json
  result: empty (frozen surface intact)
  Full-suite (from main checkout, post-copy-back): npm test → 3402 passed | 2 skipped across 229 test files (was 3385|2 at v1.50.0; **+17 new tests**). 5 pre-existing `aiChatPanelWebview` ENOENT failures observed inside the worktree (worktree `node_modules` was empty rather than symlinked); those failures do NOT reproduce from the main checkout and are unrelated to BQ-04.
Status: PASS
Note: helper exported as `formatDataCellForDialect(value, field?, dialect?): string` from `src/ui/resultsGridModel.ts` (lines 463-540); `formatBigQueryCell` is imported from `../adapters/bigqueryPages` (pure module — its only import is `./bigqueryTypes`, frozen, import-only). `field` typed as a local structural alias `{ name?: string; type?: string; mode?: string }` matching the mirror interface, NOT the frozen `BigQuerySchemaField` — preserves the byte-untouched contract on `bigqueryTypes.ts`. Wired into `webview/main.ts` at the value-viewer (line 2523) and data-cell renderer (`formatDataCell`, line 2596); module-scope `currentDialect` and `currentSchemaFields` capture the active statement's marker fields (set in `setCurrentStatement` before any `renderGrid` call), and the closure-captured `r` in `renderGrid` carries them too. `formatCell` (lines 433-445) verbatim. No new postMessage type — fields ride the existing `state` payload's `results[i]`.

## Reviewer Verdict
VERDICT: changes_requested
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (from INDEX.md; self-report block missing — see BLOCKING)
VERIFICATION_RERUN: PASS (npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/webviewBundle.test.ts = 61/61; npm run typecheck clean; npm test = 3402 pass / 2 skip; npm run compile clean)
FINDINGS:
  critical: none
  important:
    - docs/AI_HANDOFF/tasks/TASK-BQ04-002.md:76-79 — missing `## Executor Report` (executor STATUS/model self-report + FILES_CHANGED + VERIFICATION block). The file ends at the Phase-4 separator; no commit or uncommitted edit adds the report. The handoff package requires it before a verdict approves the task. Action: append the report (model self-report `unic-code`, RED_OUTPUT from the wave-2 TDD cycle, fresh verification) and re-submit; the review evidence above will carry the approval on re-review.
  minor: none (code review complete: 7 checklist items clear — helper dispatch correct and byte-frozen formatter reuse confirmed via `git diff 75cdb08 -- src/adapters/bigqueryPages.ts` = 0 lines; wiring at webview/main.ts 1736/1757/2543-2567/2633/2652/3168 threads dialect+schemaFields through module-scope currentDialect/currentSchemaFields; no new postMessage type; resultsGridModel.ts vscode-free with only type-only `../core/statementParser` + pure `../adapters/bigqueryPages` imports; frozen surface diff empty; formatCell 433-445 verbatim; test block covers rows 002.a-e + spot-check; acceptance criteria match code)
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Technical review of the wave-2 diff is fully green (verdict will lift to approved once the Executor Report is appended — no code changes needed). Reviewer model unic-smart differs from executor unic-code per config .ukit/storage/config.json handoff.reviewer.model.
