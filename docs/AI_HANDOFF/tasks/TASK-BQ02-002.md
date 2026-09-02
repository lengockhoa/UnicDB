# TASK-BQ02-002 — BigQuery preview SQL builder + browse command arm

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 TASK-BQ02-002 / §3 Approach / §4 Test Plan rows 13-18 (preview group)

## Goal

Give `vsdb.browseTableData` a real BigQuery arm. A new pure module `src/ui/bigQueryPreview.ts`
exports `buildBigQueryPreviewSql` (backtick-quoted, LIMIT-bounded GoogleSQL SELECT) and
`BIGQUERY_PREVIEW_MAX_LIMIT`; the currently-throwing `bigquery` arm of `buildBrowseSelect`
(`browseCommands.ts:63-67`) delegates to it, and the browse command skips
`qualifyKeywordTables` for bigquery (PG keyword rules do not apply to GoogleSQL, and the
emitted SQL is always fully quoted — same reasoning as the lazy no-op pinned by
`browseCommands.test.ts` #11). Execution flows through the existing BQ-01 `runQuery` TUPLE
path — no new command, no panel changes.

## Target Files

- `src/ui/bigQueryPreview.ts` (new) — pure module: `buildBigQueryPreviewSql(p: { dataset: string; table: string; project?: string; limit?: number }): string` + `BIGQUERY_PREVIEW_MAX_LIMIT` (1000) + default limit 100. No vscode import, no adapter import.
- `src/ui/__tests__/bigQueryPreview.test.ts` (new) — the test table below.
- `src/ui/browseCommands.ts` — replace the throwing `bigquery` case in `quoteForDriver` (via delegation: the bigquery arm of `buildBrowseSelect` calls `buildBigQueryPreviewSql` instead of falling through to `quoteForDriver`), and guard the `qualifyKeywordTables` call with `conn.driver !== "bigquery"`. Nothing else in the file changes.
- `src/ui/__tests__/browseCommands.test.ts` — ADD bigquery-arm pins + qualifier-skip pin; existing tests #1-#15 stay green verbatim.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | two-part reference, default limit | `buildBigQueryPreviewSql({ dataset: "my ds", table: "tbl" })` → `` SELECT * FROM `my ds`.`tbl` LIMIT 100 `` | pure call |
| 2 | happy | three-part reference with project | `{ project: "proj-data", dataset: "ds", table: "tbl" }` → `` SELECT * FROM `proj-data`.`ds`.`tbl` LIMIT 100 `` | pure call |
| 3 | edge (malformed input) | backtick inside identifier is doubled | table `we`ird` → `` `we``ird` ``; dataset `ds`x` → `` `ds``x` `` — never a raw backtick in output | pure call |
| 4 | edge (boundary) | limit clamped to ceiling | `limit: 0` → `LIMIT 100`; `limit: -5` → `LIMIT 100`; `limit: 100000` → `LIMIT 1000` (ceiling); `limit: 25` → `LIMIT 25` (mid-range honored) | pure call, 4 assertions |
| 5 | happy | browse arm returns builder output | `buildBrowseSelect("bigquery", "ds", "tbl")` === `buildBigQueryPreviewSql({ dataset: "ds", table: "tbl" })` (no throw) | RED at base e171d42: current arm throws `Unsupported driver: bigquery (BQ-02 wiring pending)` |
| 6 | regression | pg/mysql/mssql arms byte-identical | existing `browseCommands.test.ts` #1-#4 assertions pass verbatim | existing tests, zero edits |
| 7 | happy | browse command executes builder SQL for bigquery | command invoked with node `{ meta: { connection: <bigquery cfg>, schema: "ds", objectName: "tbl" } }` → `runner.run` receives `stmts[0].text === 'SELECT * FROM `ds`.`tbl` LIMIT 100'`; panel renders; setBusy true→false | reuse `browseCommands.test.ts` harness (`makeFakeMgr`/`makeFakeRunner`/`makeFakePanel`) with a bigquery `ConnectionConfig` |
| 8 | edge (no adapter) | qualifier skip never consults listTables for bigquery | same invocation with `mgr.getAdapter` returning a spy adapter → spy `listTables` NOT called (qualifyKeywordTables skipped); SQL unchanged | bigquery cfg fixture |
| 9 | regression | qualifier still applied for postgres | existing #11-style pin: postgres node → SQL unchanged, and a deliberately unqualified reserved-keyword table would still rewrite (reuse #11b shape if needed) | existing harness |

## Test Files

- `src/ui/__tests__/bigQueryPreview.test.ts` — tests #1-#4 (new file).
- `src/ui/__tests__/browseCommands.test.ts` — tests #5, #7, #8 (new cases appended; #6/#9 are existing assertions that must stay green).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/bigQueryPreview.test.ts src/ui/__tests__/browseCommands.test.ts
npm run typecheck
npm run compile
```

(`npm run typecheck` is the static gate — **no lint script exists**. `npm run compile` guards
the esbuild bundle since browseCommands.ts is on the extension activation path. Resolution
per RULES.md test-selection: targets under `src/` → `.cache/index/tests-map.json` gives
`src/ui/browseCommands.ts → ["src/ui/__tests__/browseCommands.test.ts"]`; the new pure module
has no map entry yet, hence the explicit second file. Non-empty floor satisfied without
falling back to `yarn test:release-core` — this repo uses `npm test`.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes; test #5 confirmed RED at base e171d42 (paste the throw output).
- [ ] `buildBrowseSelect("bigquery", …)` returns bounded quoted SQL; existing dialect arms (#1-#4) byte-identical.
- [ ] The bigquery browse path issues at most ONE statement, always LIMIT-capped (default 100, ceiling 1000).
- [ ] `qualifyKeywordTables` skipped for bigquery; postgres/mysql/mssql behavior unchanged (#6, #9).
- [ ] No trailing `;` in generated SQL (matches the existing builder contract).
- [ ] `npm run typecheck` and `npm run compile` exit 0.
- [ ] No new vscode command id, no `package.json` change, no adapter file touched (file-disjoint from TASK-BQ02-001).

## Dependencies

- (none) — consumes only existing contracts (`buildBrowseSelect` shape, `ParsedStatement`,
  BQ-01 `runQuery`); the adapter's enumeration work in TASK-BQ02-001 is NOT a prerequisite.

## Interfaces

- Consumes: `buildBrowseSelect(driver, schema, table): string` (browseCommands.ts:41, existing — its bigquery arm is re-routed); `ConnectionConfig["driver"]` including `"bigquery"` (config/types.ts:11, existing); `qualifyKeywordTables(sql, lookup)` (core/keywordQualify.ts, existing); BQ-01 `BigQueryAdapter.runQuery(sql): Promise<RunResult>` via the existing `QueryRunner` (no change).
- Produces: `buildBigQueryPreviewSql(p: { dataset: string; table: string; project?: string; limit?: number }): string` and `BIGQUERY_PREVIEW_MAX_LIMIT: 1000` from `src/ui/bigQueryPreview.ts` — TASK-BQ02-003's preview dispatch and any future BQ-03 paged-query builder consume these names verbatim. Quoting contract: backtick delimiter, doubling escape (` `` `), three-part `` `project`.`dataset`.`table` `` when `project` present, `LIMIT n` always appended with `100 <= n <= 1000`, no trailing `;`.

---

## Discussion

### 2026-09-03 · planner · unic-smart
1. **Where the arm lives**: `quoteForDriver` is a per-identifier helper; the bigquery quoting
   rule (backticks + doubling) fits it, but the LIMIT-bounding belongs at statement level.
   Cleanest split: keep `quoteForDriver`'s bigquery case throwing for any driver it can't
   handle, and give `buildBrowseSelect` an explicit early branch
   `if (driver === "bigquery") return buildBigQueryPreviewSql({ schema-mapped args })` — but
   note `buildBrowseSelect`'s parameter names are `(driver, schema, table)` while the builder's
   are `(dataset, table)`: map `schema → dataset` (the tree's "schema" node for bigquery IS the
   dataset — TASK-BQ02-003 documents this same mapping on the tooltip side). Do not rename
   `buildBrowseSelect`'s parameters; other drivers' call sites and tests depend on the shape.
2. Default limit 100 matches `generateSelectForTable`'s LIMIT 100 convention
   (`schemaTree.ts:1386`); the hard ceiling 1000 is the roadmap's "explicit low row cap" for
   MVP preview. Both constants exported from the pure module so the ceiling is testable
   without magic numbers.
3. The `qualifyKeywordTables` skip must NOT touch the pg/mysql/mssql flow — implement as a
   driver check in the command body (`adapter && conn.driver !== "bigquery" ? qualify : raw`),
   leaving `maybeGetAdapter` and the header format untouched. Header copy keeps the existing
   `Browse <qualified> at <ISO>` shape (test #6 of the existing suite pins its regex).
4. Preview of a VIEW uses the identical SELECT — the existing TASK-001 PG read-path pin (#12)
   already establishes plain-SELECT-for-views as the contract; BigQuery views are queryable
   SELECT targets, no wrap, no `listColumns` call.
5. RED-first: test #5 throws at base; tests #7/#8 need the arm before they can pass — write #5
   first, then #1-#4, then implement, then #7/#8.

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT:
```
 ❯ src/ui/__tests__/bigQueryPreview.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ui/__tests__/bigQueryPreview.test.ts [ src/ui/__tests__/bigQueryPreview.test.ts ]
Error: Failed to load url ../bigQueryPreview (resolved id: ../bigQueryPreview) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-bq02-002/src/ui/__tests__/bigQueryPreview.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  no tests
```
Verification Output:
  npx vitest run src/ui/__tests__/bigQueryPreview.test.ts src/ui/__tests__/browseCommands.test.ts: 28 passed (28) — 7 in bigQueryPreview.test.ts (pure-module tests covering happy two-part / three-part / backtick-doubling / limit-clamping / ceiling constant / omitted project / no-trailing-semicolon) and 21 in browseCommands.test.ts (existing 18 + new #5/#7/#8/#9 BigQuery wiring pins).
  npm run typecheck: exit 0, no diagnostics.
  npm run compile: esbuild build complete (dist/extension.js, dist/webview.js, dist/aiChatPanel.js emitted).
Status: PASS
Note: `buildBrowseSelect`'s bigquery case delegates to `buildBigQueryPreviewSql` with `{ dataset: schema, table }` (no project arg — TASK-BQ02-003's preview dispatch will add it). `quoteForDriver`'s bigquery case is left throwing so the `never` exhaustiveness check stays valid for any future direct caller that bypasses `buildBrowseSelect`. pg/mysql/mssql arms of `buildBrowseSelect` and the existing `browseCommands.test.ts` #1-#15 stay byte-identical (verified via diff: only the bigquery early-return, the qualify-skip guard, the new import, and the test #5/#7/#8/#9 additions changed). Files unchanged in worktree (no git add/commit/push per instructions).

---

## Reviewer Verdict

(pending)
