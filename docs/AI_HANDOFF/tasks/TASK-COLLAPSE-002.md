# TASK-COLLAPSE-002 — Webview: enforce exactly 2-row results toolbar (row 2 starts at WHERE)

- Status: `ready`  <!-- ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | blocked | done -->
- Owner: `-`       <!-- tool currently holding the task -->
- Reviewer: `-`    <!-- reviewer model name, set in Phase 4 -->
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §1-§7 (cycle RES2ROW)

## Goal

Split the results webview toolbar into EXACTLY 2 rows, as the user demanded ("Chia đôi cho
tôi menu này. Từ Where là đưa xuống dòng dưới. TÔi cần 2 dòng"): `.UnicDB-toolbar` becomes a
column with two `.UnicDB-toolbar-row` wrapper divs (each row `flex-wrap: nowrap` +
`overflow: hidden`, so a third line can never appear — narrow widths clip within a row).
Row 1 = cancel, refresh, sep, add-row, delete-row, undo, redo, commit, csv-toggle, sep,
`tsv` select. Row 2 = `WHERE …`, `ORDER BY …`, Re-Run, Clear, header checkbox, Copy,
Export-file, schema chip, `Search…` (last). This REVERSES the TASK-COLLAPSE-001 single-row
contract and flips its 4 test pins.

## Target Files

- `webview/styles.css` — lines 27-49: `.UnicDB-toolbar` block → `display: flex;
  flex-direction: column; gap: 4px; min-width: 0; overflow: hidden; margin-bottom: 8px;`
  (drop `flex-wrap: nowrap`); rewrite the stale TASK-COLLAPSE-001 comment above it. ADD a
  new `.UnicDB-toolbar-row` rule right after: `display: flex; flex-wrap: nowrap;
  align-items: center; gap: 4px; min-width: 0; overflow: hidden;`. Lines 1350-1371: 
  `.UnicDB-requery-input.UnicDB-requery-where` and `.UnicDB-requery-input.UnicDB-requery-order`
  → `flex: 1 1 100%; min-width: 0;` (inside a nowrap row this shares leftover space; it is
  NOT the old full-row claim) + rewrite the TASK-RES-002/TASK-COLLAPSE-001 comment above.
  DO NOT touch the `data-tooltip` block (lines 98-134 — covers ::after body 98-122 + ::before
  arrow 124-134) or `.UnicDB-btn` transition.
- `webview/main.ts` — (a) `PersistentDom` interface (~lines 692-745): add
  `toolbarRow1: HTMLDivElement;` and `toolbarRow2: HTMLDivElement;`; (b) `render()` lines
  817-821: change `dom.toolbar.insertBefore(dom.transactionControls, dom.csvToggleBtn)` →
  `dom.toolbarRow1.insertBefore(dom.transactionControls, dom.csvToggleBtn)` (the current
  call THROWS NotFoundError once csvToggleBtn lives inside row 1); (c) `buildPersistentDom()`
  lines ~932-1210: create `row1`/`row2` divs with className `UnicDB-toolbar-row`,
  `toolbar.append(row1, row2)`, and redirect every `toolbar.appendChild(...)` to the right
  row: row1 ← cancelBtn(952), refreshBtn(960), sep(962), addRowBtn(971), deleteRowBtn(978),
  undoBtn(988), redoBtn(998), commitBtn(1010), csvToggleBtn(1038), sep(1040),
  exportFormat(1062); row2 ← requeryWhere(1083), requeryOrderBy(1095), requeryRunBtn(1103),
  requeryClearBtn(1114), exportHeader(1120), exportCopyBtn(1128), exportFileBtn(1136),
  schemaChip(1178), searchInput(1203); expose both rows on the returned `PersistentDom`.
  Keep `makeToolbarSep()` usage and all handlers byte-identical.
- `src/ui/__tests__/webviewToolbar.test.ts` — FLIP 2 tests + constants: header comment
  (lines 11-14, "flat children" wording), `EXPECTED_ORDER` (lines 181-216) → split into
  `EXPECTED_ORDER_ROW1` / `EXPECTED_ORDER_ROW2`, test #3 (lines 321-367) → two-row census
  (`toolbar.children.length === 2`, both `.UnicDB-toolbar-row`; walk each row with the
  existing predicate map; search is last child of ROW 2; both seps in ROW 1), test #4
  (lines 369-400) → assert `/\.UnicDB-toolbar\s*\{[^}]*flex-direction:\s*column/` matches,
  `nowrap` does NOT appear in the toolbar block, `/\.UnicDB-toolbar-row\s*\{[^}]*flex-wrap:\s*nowrap/`
  matches, and the requery-input regexes flip from `flex:\s*1\s+1\s+(\d+)px` to
  `flex:\s*1\s+1\s+100\s*%`. Keep the `.UnicDB-btn svg` sizing check.
- `tests/webviewRequeryAlignment.test.ts` — FLIP the two `it()` bodies (lines 188-206):
  `.UnicDB-requery-where/-order` must match `flex:\s*1\s+1\s+100\s*%` + `min-width:\s*0` and
  NOT match `140px`/`80px`; update the stale single-row comments (lines 173-178 + it names).
- `src/ui/__tests__/aiChatPanelCloneCss.test.ts` — FLIP line 119 (inside test #3): 
  `ruleBody(".UnicDB-toolbar")` must match `/flex-direction:\s*column/i` and NOT
  `/flex-wrap:\s*nowrap/i`; update the assertion message (it currently cites
  TASK-COLLAPSE-001 single-row). Note: this file READS `webview/styles.css` directly — no
  chat CSS exists to change; the flip only re-mirrors the new toolbar contract.

## Test Cases (REQUIRED — TDD)

Write/flip the tests FIRST; they must fail against today's single-row code (RED), then pass
after the CSS + main.ts edits (GREEN).

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (css) | `.UnicDB-toolbar` pins the 2-row column contract; `nowrap` gone from the block | regex `/\.UnicDB-toolbar\s*\{[^}]*flex-direction:\s*column/` matches styles.css; `not.toMatch(/flex-wrap:\s*nowrap/)` inside the same block | read `webview/styles.css`, extract `.UnicDB-toolbar` rule body (readRuleBody pattern) |
| 2 | happy (css) | `.UnicDB-toolbar-row` rule exists and locks each line | regex `/\.UnicDB-toolbar-row\s*\{[^}]*flex-wrap:\s*nowrap/` matches AND same body contains `overflow:\s*hidden` | source regex on styles.css |
| 3 | happy (webview, bundle) | toolbar renders exactly 2 rows with the agreed split | `toolbar.children.length === 2` and both are `.UnicDB-toolbar-row`; ROW1 order `[UnicDB-btn-danger, UnicDB-btn, UnicDB-toolbar-sep, UnicDB-btn, UnicDB-btn, UnicDB-btn, UnicDB-btn, UnicDB-commit, UnicDB-btn, UnicDB-toolbar-sep, UnicDB-export-format]`; ROW2 order `[requery-where, requery-order, btn, btn, export-header, export-copy, export-file, schema-chip, search-input]`, search LAST in row 2 | `loadBundle()` + `dispatchState(threeRowsState())` — requires `npm run compile`; rewrite of today's test #3 flat-children census |
| 4 | edge (structural split point) | `.UnicDB-requery-where` is the FIRST child of row 2 | `row2.firstElementChild.classList.contains("UnicDB-requery-where") === true` — the break is exactly where the user pointed ("Từ Where") | same bundle fixture as #3 |
| 5 | edge (overflow/boundary, css) | rows clip instead of scrolling; inputs absorb the squeeze | `.UnicDB-requery-where/-order` bodies match `flex:\s*1\s+1\s+100\s*%` + `min-width:\s*0` and NOT `140px`/`80px`; `.UnicDB-toolbar` AND `.UnicDB-toolbar-row` bodies contain `overflow:\s*hidden` (no horizontal scrollbar at any viewport) | source regex on styles.css; flip of today's `webviewRequeryAlignment` 140px pins |
| 6 | edge (state/re-parenting, bundle) | manual transaction open → controls insert into ROW 1 without throwing | render completes with NO exception; `transactionControls.parentElement.classList.contains("UnicDB-toolbar-row")` AND `transactionControls.nextElementSibling === csvToggleBtn` (insertBefore anchor preserved); transaction closed → controls removed again | bundle fixture with a state that opens a manual transaction (`transactionOpen` render path, `webview/main.ts:817-821`) — exact fixture message: `dispatchState({ type: "transactionStatus", open: true })`. RED against today's code is an `assertion` failure (`transactionControls.parentElement` is `.UnicDB-toolbar`, not `.UnicDB-toolbar-row`); the NotFoundError throw only fires post-wrapper without the re-target — both modes covered by case #6 |
| 7 | regression (webview, bundle) | requery behavior unchanged | Enter in WHERE posts exactly 1 `{type:"requery", index, where, orderBy}`; Clear empties both inputs; existing test #5 + `webviewRequeryAlignment` bundle cases stay GREEN UNTOUCHED | today's `webviewToolbar.test.ts` test #5 + alignment bundle tests — must pass without modification |
| 8 | regression (webview, bundle) | toolbar census + tooltip contract survive re-parenting | `.UnicDB-toolbar .UnicDB-btn` button count still 12 (descendant selector crosses row wrappers), each with inline svg + aria-label; `aiChatPanelCloneCss` non-chat checks (`.UnicDB-btn`, `.UnicDB-tab`, `.UnicDB-grid-host`) stay GREEN | existing test #1 / census — pass without modification |
| 9 | regression (css) | RES-BAR hover polish + data-tooltip block intact | `.UnicDB-btn` body still matches `transition:\s*background-color`; block `styles.css:98-123` byte-identical (`git diff` shows no hunk between those lines) | existing `aiChatPanelCloneCss` / RES-BAR pins — pass without modification |

## Test Files

- `src/ui/__tests__/webviewToolbar.test.ts` — cases 2 (`.UnicDB-toolbar-row` regex + body), 3 (two-row census), 4 (split-point), 6 (re-parenting), 7 (requery regression), 8 (census + tooltip regression).
- `tests/webviewRequeryAlignment.test.ts` — cases 1 (partially), 5, 7 (flips + stale-comment cleanup).
- `src/ui/__tests__/aiChatPanelCloneCss.test.ts` — cases 1 (mirror), 8, 9 (line-119 flip).

## Verification Commands

```bash
npm run typecheck      # tsc --noEmit — MUST exit 0 (repo has NO lint script; typecheck is the gate)
npm run compile        # node esbuild.js — REQUIRED before any bundle test (they eval dist/webview.js; self-skips are NOT green)
npx vitest run src/ui/__tests__/webviewToolbar.test.ts tests/webviewRequeryAlignment.test.ts src/ui/__tests__/aiChatPanelCloneCss.test.ts
npm test               # full-suite final gate (baseline ≥ 4104 passed | 0 failed)
```

Re-run `npm run compile` after any further `webview/main.ts` / `webview/styles.css` edit
before re-running the targeted tests.

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for #1-#6 against pre-edit code, then GREEN).
- [ ] Toolbar renders exactly 2 rows; row 1 = icons + tsv; row 2 = WHERE…Search with WHERE first and Search last.
- [ ] No third row can ever appear (rows pin `flex-wrap: nowrap` + `overflow: hidden`); no horizontal scrollbar at viewport ≥ 600px.
- [ ] `npm run typecheck` exits 0; `npm run compile` clean; targeted vitest run GREEN; full `npm test` GREEN.
- [ ] All 5 pin assertions across 3 test sites REWRITTEN with updated comments (webviewToolbar #3 + #4, requeryAlignment ×2, cloneCss ×1) — none silently deleted.
- [ ] Manual smoke (dev host): 2-row toolbar; manual transaction open/close inserts/removes commit+rollback icons in ROW 1 without error; Enter in WHERE/ORDER BY re-runs; hover tooltips instant.
- [ ] `data-tooltip` block (styles.css:98-134), `.UnicDB-btn` transition, placeholders, and all `.UnicDB-requery-*` class names unchanged.
- [ ] No file outside §Target Files modified.

## Dependencies

- (none) <!-- single-task cycle; wave 1 -->

## Interfaces

<!--
The executor usually ONLY sees this task file, not other tasks. This block is how it learns the
exact names/types that other tasks expect — preventing the kind of bug where "TASK-3 calls
clearLayers() but TASK-7 calls clearFullLayers()". Record real signatures (function/endpoint/type),
not placeholders.
-->

- Consumes: (none) — no cross-task inputs; builds on the existing
  `buildPersistentDom(): PersistentDom` (`webview/main.ts:932`), `makeIconButton(
  className: string, title: string, svg: string, onClick: () => void): HTMLButtonElement`
  (`webview/main.ts:837`), and `makeToolbarSep(): HTMLSpanElement` (`webview/main.ts:863`).
- Produces: (a) DOM contract — `.UnicDB-toolbar` has exactly 2 `.UnicDB-toolbar-row`
  children; row 1 ends with `.UnicDB-export-format`; row 2 = `[.UnicDB-requery-where,
  .UnicDB-requery-order, .UnicDB-requery-run, .UnicDB-requery-clear, .UnicDB-export-header,
  .UnicDB-export-copy, .UnicDB-export-file, #schemaChip(.UnicDB-schema-chip),
  .UnicDB-search-input]`; (b) `PersistentDom` gains `toolbarRow1: HTMLDivElement` +
  `toolbarRow2: HTMLDivElement`; (c) CSS contract — `.UnicDB-toolbar { flex-direction:
  column; overflow: hidden }`, `.UnicDB-toolbar-row { flex-wrap: nowrap; overflow: hidden }`,
  `.UnicDB-requery-input.UnicDB-requery-where/-order { flex: 1 1 100%; min-width: 0 }`.
  No later task this cycle, but the flipped tests pin all three.

---

## Discussion

<!--
AIs talk to each other HERE, not via any other tool.
Format for each comment:

### <date> · <role: planner|executor|reviewer> · <tool/model>
<content — question, note, suggestion, push back to a previous phase>

Reply at one heading level lower (####). Mark "-> @planner" / "-> @executor" / "-> @reviewer" when there is a specific recipient.
-->

### 2026-09-09 · planner · unic-smart
Notes for @executor:
1. Grounding found a 4th pin the P1 brief did not list: `webviewToolbar.test.ts` test #3
   asserts toolbar children are FLAT (`children[children.length-1]` = search, walk of
   `toolbar.children`, line 330-365). Under row wrappers this fails structurally — its
   rewrite (case #3) is mandatory, not optional.
2. Grounding found the `webview/main.ts:818` re-target (`dom.toolbar.insertBefore` →
   `dom.toolbarRow1.insertBefore`). Do NOT skip it: the manual-transaction path throws
   NotFoundError otherwise, and case #6 is the RED→GREEN proof.
3. `flex: 1 1 100%` inside a NOWRAP row does NOT claim a full line — flex-basis 100% with
   `flex-shrink: 1` + `min-width: 0` just makes the two inputs split whatever space the
   fixed-size buttons leave. This is the intended row-2 sizing. The old
   "not.toMatch(/100%/) guards flip direction: 100% is now REQUIRED, 140px/80px forbidden.
4. `.UnicDB-search-input` keeps its existing `flex: 0 1 180px; min-width: 120px` rule — do
   not change it. At < ~600px viewport row 2 clips its tail (accepted trade-off, PLAN §3);
   do not add media queries or a third row.
5. `dom.transactionControls.remove()` (line 820) needs no change — `remove()` is
   parent-agnostic. Only line 818 changes.

---

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->
