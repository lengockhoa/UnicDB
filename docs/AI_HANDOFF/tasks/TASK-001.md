# TASK-001 — Kill the eager ctid browse wrap (read path = plain SELECT)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (lazy ctid), §4 rows 1-4, 13 & 15-16, §6 items 1-2 & 5

## Goal

Delete `maybeAppendCtidForNoPk` and its call site so `vsdb.browseTableData` executes one plain qualified SELECT for every object (table, view, matview, foreign table) — fixing `Error: column "ctid" does not exist` on view open. Also remove the now-dead ctid special-casing in the grid model (auto-hide + export-strip comments), rewrite the two TASK-006-era webview bundle test blocks that assert the removed behavior, and reword the stale TASK-006 ctid comments in `webview/main.ts` (comments only).

## Target Files

- `src/ui/browseCommands.ts` — remove `maybeAppendCtidForNoPk` (lines 119-160), remove the `noPkSql` step in `registerBrowseCommands` (lines 200-224 collapse: feed `rawSql` straight to `qualifyKeywordTables`), update header comments (file-top TASK-006 note, `AdapterWithTables` doc line 27-28 still needed for `qualifyKeywordTables`). `maybeGetAdapter` stays (used by qualifier).
- `src/ui/resultsGridModel.ts` — delete the `if (name === 'ctid') spec.hidden = true;` block + TASK-006 comment at lines 102-106; reword comments at lines 32, 423-427, 611-613, 670 to drop the ctid framing (the generic `hiddenColumns` option and its behavior REMAIN — only ctid-specific hardcoding/comments go).
- `src/ui/__tests__/browseCommands.test.ts` — rewrite the TASK-006 describe block (lines 508-706): #12 becomes the view regression (plain SELECT, `listColumns` NOT called), #13/#14/#15 kept as-is (still pass — they assert unchanged SQL), drop the wrap-specific assertion `sql.toLowerCase()).toContain("ctid")` from #12.
- `src/ui/__tests__/resultsGridModel.test.ts` — update `ctid column is auto-tagged hidden (TASK-006)` (lines 81-91) to assert NO column gets `hidden: true`; keep the serialize/hiddenColumns generic tests (lines 397-463) untouched.
- `src/ui/__tests__/webviewBundle.test.ts` — REWRITE test 9 (lines 561-622, `TASK-006 fix-round-1 — ctid column hidden in colDefs`): drop the `__vsdb_browse__` fixture SQL literal (use plain `SELECT * FROM "public"."notes"`), drop the `hide === true` / not-displayed assertions; assert the INVERTED contract — with `ctid` an ordinary user column it IS displayed (`visibleCols === ["created_at","ctid","name"]`) and `getColumnState()` entry for ctid has `hide` falsy. The inferColumns unit lock already lives in resultsGridModel.test.ts; this bundle test locks the end-to-end render path.
- `src/ui/__tests__/webviewExport.test.ts` — REWRITE the TASK-006 block (lines 380-443, `ctid column hidden from TSV export`): drop the `__vsdb_browse__` fixture literal; assert the INVERTED contract — header `name\tcreated_at\tctid`, values `(0,1)`/`(0,2)` present, text matches `/\bctid\b/`.
- `webview/main.ts` (repo root — the esbuild webview entry, NOT under `src/`) — comment-only: reword the four TASK-006 ctid notes at :1378-1382, :2106-2111, :2133-2135, :2158 to describe the generic `spec.hidden` → AG Grid `hide` / `hiddenColumns` export mechanism without the ctid-wrap framing. ZERO behavior change (no code lines touched — `hide: spec.hidden === true` and the `hiddenColumns` derivation stay byte-identical).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression (bug) | PG **view** browse → plain SELECT, no wrap, no listColumns | executed SQL `=== 'SELECT * FROM "public"."v_notes"'`; `adapter.listColumns` mock NOT called; `sql` contains no `ctid` substring | PG conn, adapter with `listColumns` spy; node arg `{ meta: { connection, schema: "public", objectName: "v_notes" } }` (reuse `makePgBrowseFixture` at test line 527) |
| 2 | happy | PG table WITH PK → SQL unchanged (existing #13) | `SELECT * FROM "public"."users"`, no ctid | existing fixture, kept verbatim |
| 3 | edge (failure path) | adapter.listColumns rejects → SQL unchanged, no throw (existing #15) | `SELECT * FROM "public"."notes"` | existing fixture, kept verbatim |
| 4 | edge (driver boundary) | MySQL no-PK → SQL unchanged (existing #14) | `` SELECT * FROM `mydb`.`notes` `` | existing fixture, kept verbatim |
| 5 | unit | `inferColumns(["name","ctid"], rows)` → no auto-hide | returned specs have NO `hidden` key on any column (ctid included) | rows `[["alice","(0,1)"]]` |
| 6 | bundle (behavior lock, RED today) | webview grid: `ctid` as USER column stays visible | displayed data columns `["created_at","ctid","name"]` (selection col filtered); `getColumnState()` ctid entry has `hide` falsy | plain fixture SQL (no `__vsdb_browse__`), columns `["name","created_at","ctid"]`, rows alice/bob with `(0,1)`/`(0,2)` — needs `npm run compile` first |
| 7 | bundle (behavior lock, RED today) | webview export: `ctid` as USER column appears in TSV | exported header `name\tcreated_at\tctid`; `(0,1)` and `(0,2)` present; text matches `/\bctid\b/` | same fixture shape as case 6, format tsv, header on — needs `npm run compile` first |

## Test Files

- `src/ui/__tests__/browseCommands.test.ts` — cases 1-4
- `src/ui/__tests__/resultsGridModel.test.ts` — case 5
- `src/ui/__tests__/webviewBundle.test.ts` — case 6
- `src/ui/__tests__/webviewExport.test.ts` — case 7

## Verification Commands

```bash
npm run compile   # MUST precede the two webview bundle tests below — they eval dist/webview.js, which embeds src/ui/resultsGridModel.ts; a stale bundle = stale assertions
npm run typecheck
npx vitest run src/ui/__tests__/browseCommands.test.ts
npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/resultsGridModelExport.test.ts
npx vitest run src/ui/__tests__/webviewBundle.test.ts src/ui/__tests__/webviewExport.test.ts
```

## Acceptance Criteria

- [ ] All Test Cases PASS (case 1 is RED against current code — run it first; cases 6-7 also RED until `npm run compile` reruns).
- [ ] `grep -rn "__vsdb_browse__\|maybeAppendCtidForNoPk" src/` returns nothing — covers `browseCommands.ts` AND the two rewritten webview test fixtures (the only other occurrences).
- [ ] `webview/main.ts` diff is comment-only (no executable line changed).
- [ ] `npm run typecheck` clean.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces: read-path contract — `vsdb.browseTableData` executes exactly `buildBrowseSelect(...)` output (post-`qualifyKeywordTables`); result sets NEVER carry a host-added `ctid` column. TASK-002 relies on this (it removes the result-set ctid fast-path in resultsPanel.ts).

---

## Discussion

### 2026-08-25 · planner · unic/unic-smart
`resolveBrowseNode` deliberately stays contextValue-blind — under lazy ctid there is nothing to branch on (see PLAN §3 rejected alternative 3).

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
