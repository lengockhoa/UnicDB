# PLAN — Cycle S: Lazy ctid (kill the eager browse wrap)

## §1 Intent

User report: **`Error: column "ctid" does not exist`** when opening a postgres **view / materialized view / foreign table** in the Results grid. Root cause: Cycle R TASK-006 added `maybeAppendCtidForNoPk()` (`src/ui/browseCommands.ts:140-160`), which wraps EVERY postgres no-PK browse as `SELECT __vsdb_browse__.*, ctid FROM (<rawSql>) __vsdb_browse__`. Views/matviews/foreign tables have no `ctid` system column → the wrapped SELECT fails the moment the tab opens. The wrap also slows the read path for every no-PK table and only ever helps at save time.

Success = (a) opening any PG view/matview/foreign table in the grid runs one plain `SELECT * FROM "schema"."object"` and renders rows — no error; (b) no-PK **tables** remain editable and save correctly, with ctid resolved **lazily at save time** via the existing value-match path (`fetchPostgresCtids`, `src/ui/resultsPanel.ts:759-808`) — always fresh, never stale from tab-open; (c) no-PK **DELETE** also resolves ctid at save time (today `buildSaveStatements` skips deletes entirely when `pkColumns.length === 0`); (d) read path carries no hidden ctid column anymore (grid hidden-column/export handling for ctid becomes dead weight and is removed).

**Design authority**: the user delegated design to the pipeline; the orchestrator chose **lazy ctid** (recorded in §3 with rejected alternatives).

## §2 Scope

**In-scope**
- `src/ui/browseCommands.ts` — delete `maybeAppendCtidForNoPk` + its call site; read path emits plain qualified SELECT.
- `src/ui/resultsPanel.ts` — save path: remove the result-set ctid fast-path (dead once the wrap is gone); keep/refine `fetchPostgresCtids` as the primary lazy resolver; extend the lazy ctid map to DELETE-row markers so no-PK deletes emit `DELETE FROM t WHERE ctid='(0,1)'`.
- `src/core/saveStatements.ts` — delete-marker branch: postgres no-PK + `ctidByRowId` → emit ctid-addressed DELETE instead of `continue`-skipping (line 347).
- `src/ui/resultsGridModel.ts` — remove ctid special-casing (auto-hide at :102-106, export-strip comments at :423-427, :611-613, :670) now that no code path produces a ctid column.
- `src/ui/__tests__/webviewBundle.test.ts` + `src/ui/__tests__/webviewExport.test.ts` — rewrite the two TASK-006-era blocks that assert ctid auto-hide / export-strip and carry `__vsdb_browse__` fixture literals (:561-622 and :380-443 respectively); the rewritten tests lock the NEW behavior (a user `ctid` column is ordinary data: visible in colDefs + present in exports). Owned by TASK-001 — without this, the §6 grep criterion is unsatisfiable and the rebuilt bundle fails `npm test`.
- `webview/main.ts` (repo root — esbuild entry, NOT under src/) — comment-only cleanup of the four stale TASK-006 ctid notes (:1378-1382, :2106-2111, :2133, :2158): reword to describe the generic `spec.hidden` / `hiddenColumns` mechanism without the ctid-wrap framing. Behavior untouched; owned by TASK-001 so doc drift is NOT tolerated — the comments go stale exactly when TASK-001's semantic change lands.
- Test updates in the six affected test files (see §4).

**Out-of-scope**
- Making views/matviews writable (they stay read-only in the save flow — no PK → ctid path, and ctid queries against views still fail server-side; the value-match refusal banner remains the correct UX).
- MySQL/MSSQL no-PK saves (unchanged: refused with `no_pk`).
- Batched-cursor / loadMore behavior, requery (`composeRequery`) internals, undo/redo stack.
- Any new UI surface or webview message protocol change.

**Wave constraint**: tasks in the same wave MUST NOT share a target file. Wave 1 = {TASK-001, TASK-003} — disjoint sets: TASK-001 owns `browseCommands.ts`, `resultsGridModel.ts`, `webview/main.ts` (comments), and four test files (`browseCommands`, `resultsGridModel`, `webviewBundle`, `webviewExport`); TASK-003 owns `saveStatements.ts` + `src/adapters/__tests__/saveStatements.test.ts`. Wave 2 = {TASK-002} (`resultsPanel.ts` + its test), sequenced after TASK-003 for the `ctidByRowId` DELETE contract.

## §3 Approach

**Chosen: lazy ctid resolution at save time.**
- Read path: `vsdb.browseTableData` builds the plain per-dialect SELECT (`buildBrowseSelect`), applies `qualifyKeywordTables` (unchanged, TASK-007 of cycle R), runs it. No wrap, no `listColumns` preflight, no relkind detection needed at all.
- Save path (`handleSaveEdits`): for `driver === "postgres" && pkColumns.length === 0 && (edits include updates OR deletes)`, call `fetchPostgresCtids(tableName, parsed.schema, columns, serverRows)` — already implemented, NULL-safe (`IS NULL` / `IS NOT DISTINCT FROM`, resultsPanel.ts:782-788), ambiguity-refusing. Its map feeds `buildSaveStatements` via `options.ctidByRowId` for BOTH the UPDATE branch (existing, saveStatements.ts:474-496) and a new DELETE branch.
- DELETE branch (saveStatements.ts:344-374): when `pkColumns.length === 0 && dialect === "postgres"`, look up `ctidByRowId.get(rowId)`; present → `DELETE FROM t WHERE ctid='<literal>'` + the existing "not safe under concurrent writes" warning shape; missing ctid → skip with warning (same honesty pattern as UPDATE). Non-PG no-PK deletes stay skipped (mysql/mssql no ctid equivalent — `ctidByRowId` is undefined there, natural fallthrough).
- Because the result set no longer carries a `ctid` column, the fast-path block at resultsPanel.ts:409-476 collapses to: always call `fetchPostgresCtids` when PG+no-PK+dirty rows. The hand-written-query case is identical to the browse case now — one code path.
- `resultsGridModel.ts` ctid special-casing removed: with no producer of a ctid column, `inferColumns` hiding and export `hiddenColumns` handling for ctid are dead. (The generic `hiddenColumns` option itself stays — it is a public `SerializeOptions` field other callers may use.)

**Rejected alternatives**
1. *Relkind whitelist on the eager wrap* (only wrap when `relkind IN ('r','p')`, precedent at `adapters/postgres.ts:366-367`): fixes the view error but keeps the heavier read path, keeps the stale-ctid window (ctid captured at open, row vacuumed/moved before save → silent misaddress), and still needs `listColumns` preflight on every browse. Rejected: treats one symptom, keeps the structural problem.
2. *Keep eager wrap for plain tables + lazy for everything else*: two divergent save paths to maintain, and the stale-ctid window remains for tables. Rejected: complexity without a user-visible win.
3. *View read-only guard via node contextValue* (`schemaTree.ts` wires both `table` and `view` nodes to the same command): would require plumbing `contextValue` through `resolveBrowseNode`. Unnecessary under lazy ctid — views open fine with a plain SELECT; the save flow already refuses them via the existing no-PK/ctid-refusal banner. Rejected: extra surface for no gain.

**Trade-off accepted**: no-PK saves now cost one ctid-lookup SELECT per dirty row at save time (previously amortized into the browse). Correctness (fresh ctid at commit) and the fixed view bug outweigh the save-time round-trips; the wrap's `Date/numeric literal round-trip` fragility that motivated cycle R TASK-006 no longer applies because `fetchPostgresCtids` matches on server values with `IS NOT DISTINCT FROM` + `IS NULL` — no literal round-trip of client-rendered strings.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| Regression (bug) | PG view browse emits plain SELECT — no wrap | executed SQL is exactly `SELECT * FROM "public"."v_notes"`; `listColumns` never called; no `ctid` substring |
| Happy | PG table WITH PK browse → SQL unchanged | `SELECT * FROM "public"."users"`, no ctid (existing #13, kept) |
| Happy | MySQL no-PK browse → SQL unchanged | `SELECT * FROM \`mydb\`.\`notes\`` (existing #14, kept) |
| Edge (failure path) | adapter.listColumns rejects → browse still runs plain SQL | SQL unchanged, no throw (existing #15, kept) |
| Regression (bug, save side) | PG no-PK + edits + result set WITHOUT ctid column → save SUCCEEDS via lazy `fetchPostgresCtids` | `UPDATE t SET name='alice-2' WHERE ctid='(0,1)'` issued; success ack; no "ctid lookup failed" banner |
| Happy | lazy resolver NULL-safe value match | ctid lookup SQL contains `col IS NULL` and `IS NOT DISTINCT FROM` (existing, kept) |
| Edge (ambiguity) | value-match returns >1 row | refuse: `ok:false` ack, no UPDATE issued (existing, kept) |
| Edge (all-fail) | 0 rows match | `all_failed` refusal banner (existing, kept) |
| Happy (new) | PG no-PK + delete marker + ctid resolvable | `DELETE FROM t WHERE ctid='(0,2)'` emitted |
| Edge (missing ctid on delete) | PG no-PK + delete marker + rowId absent from map | delete skipped, warning `delete row N skipped: postgres no-PK + missing ctid`, no DELETE statement |
| Edge (non-PG delete, boundary of dialect) | mysql no-PK + delete marker | no DELETE emitted, no crash — existing skip semantics preserved |
| Edge (dead fast-path removal) | result set that happens to contain a user column literally named `ctid` | host does NOT trust it as row address — resolver path still used; UPDATE `WHERE ctid='(0,1)'` comes only from resolver output. (User-column case: resolver also selects `ctid` from the table, so identity is server-side.) |
| Unit (grid model) | `inferColumns(["name","ctid"], …)` | NO `hidden: true` on any column spec (behavior change locked) |
| Unit (grid model) | export with `hiddenColumns: ["ctid"]` still generic | generic option keeps working (existing tests retained; only comments/hardcoded ctid auto-hide removed) |
| Bundle (webview, new) | `ctid` as a USER column — bundle colDefs keep it visible | displayed data columns `["created_at","ctid","name"]`; `getColumnState()` entry for ctid has `hide` falsy; requires `npm run compile` first (bundle embeds resultsGridModel) |
| Bundle (webview export, new) | `ctid` as a USER column — TSV export includes it | header `name\tcreated_at\tctid`; values `(0,1)` / `(0,2)` present in exported text; requires `npm run compile` first |

## §5 Verification

```bash
npm run typecheck
npm run compile   # REQUIRED before the two webview bundle test files — they eval dist/webview.js, which embeds src/ui/resultsGridModel.ts
npx vitest run src/ui/__tests__/browseCommands.test.ts
npx vitest run src/ui/__tests__/resultsPanelSaveEdits.test.ts
npx vitest run src/adapters/__tests__/saveStatements.test.ts
npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/resultsGridModelExport.test.ts
npx vitest run src/ui/__tests__/webviewBundle.test.ts src/ui/__tests__/webviewExport.test.ts
```

(`npm test` = `vitest run` full suite — run by the consolidator only, not per-task.) No lint script exists in this repo (package.json `scripts`: compile/watch/test/test:integration/typecheck/package/vscode:prepublish) — typecheck is the static gate.

## §6 Acceptance

- [ ] Opening a PG view/matview/foreign table from the tree runs plain SELECT and renders (regression test present: TASK-001).
- [ ] `grep -rn "__vsdb_browse__\|maybeAppendCtidForNoPk" src/` returns nothing — TASK-001 removes both the wrap in `browseCommands.ts` AND the `__vsdb_browse__` fixture literals in `webviewBundle.test.ts` / `webviewExport.test.ts`.
- [ ] PG no-PK UPDATE saves resolve ctid lazily at save time — no reliance on a result-set ctid column (TASK-002).
- [ ] PG no-PK DELETE saves emit ctid-addressed DELETE; missing ctid → per-row warning, never silent drop (TASK-003).
- [ ] Grid/export no longer special-case ctid; generic `hiddenColumns` still functional (TASK-001).
- [ ] `npm run typecheck` clean; all five targeted vitest files green.

## §7 Global Constraints

- No new dependencies; TS strict (`tsc --noEmit` must pass).
- Preserve existing code-comment style (English rationale blocks referencing task IDs).
- Do not touch webview message protocol (`src/ui/messages.ts`) — none needed.
- Postgres adapter query style: parameterized `this.query` where params exist; inline only for identifier-validated names (see `fetchPostgresCtids` precedent).
- Every task inherits this section by reference; do not repeat inside task files.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: nothing
Known gaps: none — manual/DB-backed verification against a live PG view (integration) is covered by existing `test:integration` config but not extended this cycle; the unit regression test reproduces the exact failing SQL shape (wrap removal) which is the user-visible bug surface.

Round 1 revision (2026-08-25, applied): CRITICAL — `webviewBundle.test.ts` + `webviewExport.test.ts` added to TASK-001 Target Files (grep criterion now satisfiable; `npm run compile` prepended to TASK-001 Verification because the rewritten bundle tests assert the new no-auto-hide behavior through `dist/webview.js`, which embeds `src/ui/resultsGridModel.ts`). Minor 1 — TASK-001 §4 citation corrected to rows 1-4, 13 & 15-16; TASK-002's to rows 5-9 & 12 (row 14 needs no implementing task — existing retained tests only). Minor 2 — §2 wave-constraint paragraph redrafted clean. Minor 3 — decided: `webview/main.ts` comment cleanup assigned to TASK-001 (doc drift NOT tolerated; behavior byte-identical). Real path is repo-root `webview/main.ts` — the review's `src/ui/webview/main.ts` prefix is wrong, line numbers verified correct against the real file.

## Plan Review Log

### Round 1 — 2026-08-25 · unic/unic-smart (PlanReview-S)
Status: Issues Found

COMPLETENESS:
  - CRITICAL — blast-radius gap: `src/ui/__tests__/webviewBundle.test.ts:566` (test 9, fixture SQL at :573) and `src/ui/__tests__/webviewExport.test.ts:383-443` (fixture SQL at :394) assert the exact ctid auto-hide/export-strip behavior TASK-001 removes, and both contain `__vsdb_browse__` literals inside `src/`. Neither file is in any task's Target Files. Consequence 1: TASK-001 acceptance criterion "`grep -rn \"__vsdb_browse__\\|maybeAppendCtidForNoPk\" src/` returns nothing" is UNSATISFIABLE as planned. Consequence 2: PLAN §6 item 2 ("grep clean") cannot hold. Consequence 3: once `dist/webview.js` is rebuilt (it exists now — `itIfBundle` tests run), these two tests FAIL the consolidator's `npm test`. Fix: add both files to TASK-001 Target Files — delete/rewrite the two TASK-006 blocks (drop the `ctid`-hidden assertions and the `__vsdb_browse__` fixture literals; the inferColumns behavior is already locked by the unit tests in resultsGridModel.test.ts). If the rewritten bundle tests assert new behavior, TASK-001's Verification Commands must add `npm run compile` first — bundle tests read the stale `dist/webview.js` otherwise.
  - minor — TASK-001 cites "Parent plan §4 rows 1-4" but also implements the two "Unit (grid model)" rows of the §4 table (its case 5). Cosmetic citation drift.
CONSISTENCY:
  - none — dep graph (003→002, W1={001,003}, W2={002}) matches INDEX.md and ACTIVE.md; same-wave target files verified disjoint; all cited source symbols/line ranges verified real (maybeAppendCtidForNoPk browseCommands.ts:140-160 + call site :206, fetchPostgresCtids resultsPanel.ts:763-808, fast-path block :397-476, delete-skip saveStatements.ts:347, ctidByRowId option :54-58, UPDATE ctid branch :474-496, grid ctid special-casing resultsGridModel.ts:102-106/423-427/611-613/670; package.json has no lint script as §5 claims).
CLARITY:
  - minor — PLAN §2 wave-constraint paragraph contains a self-correcting sentence ("resultsPanel.ts touched by TASK-001? no — …") that reads like leftover drafting; INDEX/task-file graph is unambiguous so no executor impact.
  - minor — webview/main.ts:1378-1382, 2106-2111, 2133, 2158 carry TASK-006 ctid comments that become stale after TASK-001; no task owns webview/main.ts. Mechanism is generic so behavior is correct — doc drift only; fold into TASK-001's comment cleanup or accept.
SCOPE:
  - none — DELETE-via-ctid (TASK-003) is explicitly in §1(c) intent, not scope creep; grid-model ctid cleanup is dead-code removal mandated by §1(d).
YAGNI:
  - none — keeping the generic `hiddenColumns`/`spec.hidden` mechanism while removing only ctid hardcoding is the right minimal cut; rejected alternatives (§3) are sound and recorded.

NOTES: Test plan is strong (mandatory view-open regression present; ≥2 edge cases of different kinds per task; `npm run typecheck` in every Verification block). Fix the one critical completeness gap (two unowned webview bundle test files + TASK-001 grep acceptance) and this plan is ready — no re-planning needed, only a TASK-001 Target Files/Verification amendment.

### Round 2 — 2026-08-25 · unic/unic-smart (PlanReview-S2)
Status: Approved

COMPLETENESS:
  - none — Round 1 CRITICAL resolved: TASK-001 Target Files now own webviewBundle.test.ts (rewrite test 9 :561-622) + webviewExport.test.ts (rewrite :380-443) with inverted-contract specs; grep of src/ for `__vsdb_browse__|maybeAppendCtidForNoPk` finds exactly the 3 TASK-001-owned sites (browseCommands.ts:140/159, webviewBundle.test.ts:573, webviewExport.test.ts:394), so §6 grep criterion is satisfiable; `npm run compile` prepended to TASK-001 Verification + PLAN §5 with embed rationale.
CONSISTENCY:
  - none — citations re-verified against §4 table rows (001→1-4,13,15-16; 002→5-9,12; 003→9-11); wave sets disjoint (W1 001∩003 = ∅; W2={002}); INDEX.md/ACTIVE.md/task Dependencies all agree; makePgBrowseFixture :527 and webview/main.ts comment sites :1378-1382/:2106-2111/:2133-2135/:2158 all real; resultsGridModelExport.test.ts carries no ctid assertions so TASK-001's verification set is stable.
CLARITY:
  - none — §2 wave paragraph redrafted clean (no drafting residue); comment-only acceptance criterion for webview/main.ts explicit.
SCOPE:
  - none — unchanged from Round 1; DELETE-via-ctid and grid cleanup remain intent-mandated.
YAGNI:
  - none — generic hiddenColumns/spec.hidden retained, ctid hardcoding removed; no new deps.

NOTES: All 4 Round 1 findings (1 critical + 3 minor) verified resolved in plan, task files, and live source. Plan is execution-ready; no new blocking findings.
PLAN_REVIEW: Approved by unic/unic-smart (Round 2, final — loop cap)
