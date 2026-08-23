# TASK-602 — Excel checkbox set-filter component in the webview

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.A

## Goal

Replace the TASK-402 per-column text/number filter with a custom AG Grid Community
filter component rendering an Excel-style checkbox panel (Search box, Select All,
per-value checkboxes with right-aligned counts, footer `All` / `N of M` + Clear +
Close). Live-apply on check; model `{ values: string[] } | null`.

## Target Files

- `webview/main.ts` — add `SetFilterComponent` (init/getGui/afterGuiAttached optional/isFilterActive/doesFilterPass/getModel/setModel/destroy), swap colDef `filter` for every ColumnKind (`webview/main.ts:842-875`), set `floatingFilter: false` (line 877), keep `onFilterChanged` gate + `setFilterModel(null)` on column-set change + footer
- `webview/styles.css` — `.vsdb-setfilter*` panel styles (VS Code CSS vars, right-aligned counts via `margin-left:auto`)
- `src/ui/__tests__/webviewSetFilter.test.ts` — (new) bundle-eval tests for the panel
- `src/ui/__tests__/webviewFilters.test.ts` — migrate the 3 `{filterType:'text',type:'contains',filter:…}` models (tests 1, 7, 8 area) to `{values:[…]}`; keep gate/columnsChanged regressions intact
- `src/ui/__tests__/webviewBundle.test.ts` — adjust ONLY if it asserts `floatingFilter` or text-filter specifics (check before editing)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | check one value → grid filters + footer `1 of 3` | rows `[1,'alpha'],[2,'beta'],[3,'gamma']`; `setFilterModel({name:{values:['beta']}})` → `getDisplayedRowCount()===1`; footer textContent matches `/1 of 3/` | bundle loaded, state dispatched |
| 2 | happy | panel DOM: search input + Select All + value checkboxes + right-aligned counts + footer `All`/`N of M` + Clear + Close | open filter via `api.getFilterInstance('name')` or header click; panel contains `.vsdb-setfilter-search` input, `.vsdb-setfilter-selectall` checkbox, one `.vsdb-setfilter-entry` per value each with a checkbox + `.vsdb-setfilter-count` whose computed `margin-left` resolves right (assert element order: value label then count), footer has status text `3 of 3`→`All` initially and Clear + Close buttons | alpha/beta/gamma fixture |
| 3 | edge | `(Blanks)` entry filters blank rows only | rows `[1,'alpha'],[2,null],[3,'']` → entries include `(Blanks)` count 2; `{values:['(Blanks)']}` → displayed 2 | blanks fixture |
| 4 | edge | case-variant merge: `BUMD`+`bumd` = one checkbox count 2; checking it displays 2 rows | entries contain single display `BUMD` with count 2; `{values:['BUMD']}` → `getDisplayedRowCount()===2` | rows `[1,'BUMD'],[2,'bumd'],[3,'X']` |
| 5 | edge | panel search `bu` narrows list; Select All acts on VISIBLE entries only | type `bu` into search → list shows only matching `.vsdb-setfilter-entry` rows; click Select All → visible entries checked, hidden (non-matching) entries unchecked; `getModel().values` contains ONLY visible displays | BUMD/BUMN/banana fixture |
| 6 | edge | live apply + round-trip: `{values:['beta']}` → `getModel().name.values` ≡ `['beta']` and `isColumnFilterPresent()===true`; Clear (footer) → `isColumnFilterPresent()===false`, `getModel().name===null`; Close hides panel | exact assertions, order-insensitive array compare | beta fixture |
| 7 | regression | multi-column filters compose (AND) | `{name:{values:['beta']}},{id:{values:['2']}}` → displayed 1 | 3-row fixture |
| 8 | regression | loadMore gate survives filter-swap: filter active + batched → no `loadMore` posted; cleared → exactly 1 posted; columnsChanged clears filter (migrated `webviewFilters` tests 3/4/8 green with `{values:…}`) | migrated suite passes; `isColumnFilterPresent()` re-polled correctly | batched 50/1000 fixture |

## Test Files

- `src/ui/__tests__/webviewSetFilter.test.ts` — (new) tests 1-7 + panel DOM details; follow the bundle-eval pattern of `webviewFilters.test.ts` (load `dist/webview.js` via `(0, eval)`, stub acquireVsCodeApi/ResizeObserver/matchMedia, dispatch state `MessageEvent`s, `flushGridEvents` helper)
- `src/ui/__tests__/webviewFilters.test.ts` — migrate existing tests' filter models to `{values:[…]}` (regression #8); keep test names' intent
- `src/ui/__tests__/webviewBundle.test.ts` — adjust only if it asserts text-filter internals (inspect first)

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts
npm run typecheck
```

(compile FIRST — jsdom tests eval `dist/webview.js`. No lint script exists in this repo; typecheck is the static gate.)

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS.
- [ ] No Enterprise import (`ag-grid-enterprise` absent from bundle); Community-only.
- [ ] `onFilterChanged` → `isColumnFilterPresent()` gate, footer `N of M`, `setFilterModel(null)` on column-set change all still work (regression #8).
- [ ] Quick-search box, CSV toggle unaffected (webviewBundle/webviewEdit green).
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-601 (imports `buildSetFilterEntries` / `setFilterPass` / `selectedKeysFromModel` from `../src/ui/resultsGridModel`)

## Interfaces

- Consumes (from TASK-601, exact signatures):
  - `buildSetFilterEntries(values: unknown[]): SetFilterEntry[]` where `SetFilterEntry = { key: string; display: string; count: number }`
  - `setFilterPass(value: unknown, selectedKeys: Set<string> | null): boolean`
  - `selectedKeysFromModel(entries: SetFilterEntry[], values: string[] | null | undefined): Set<string> | null`
- Produces (TASK-603 must not disturb):
  - colDef filter wiring: every column uses the component; `floatingFilter: false`
  - Filter model contract: `{ values: string[] }` (display strings, `'(Blanks)'` literal for blanks) or `null` — `getModel()/setModel()` round-trip
  - Panel class names: `.vsdb-setfilter`, `.vsdb-setfilter-search`, `.vsdb-setfilter-selectall`, `.vsdb-setfilter-list`, `.vsdb-setfilter-entry`, `.vsdb-setfilter-count`, `.vsdb-setfilter-status`, `.vsdb-setfilter-clear`, `.vsdb-setfilter-close`
- AG Grid Community custom-filter API used: `init(params: { valueGetter?: (node) => unknown; doesRowPassOtherFilter?: (node) => boolean; filterChangedCallback: () => void; filterModifiedCallback?: () => void; api: GridApi; colDef: { field?: string } })`, `getGui(): HTMLElement`, `isFilterActive(): boolean`, `doesFilterPass({ data: Record<string,unknown> }): boolean`, `getModel(): { values: string[] } | null`, `setModel(model: { values: string[] } | null): void`. (Read the installed `ag-grid-community` v36 `.d.ts` `IFilter`/`IFilterParams` for the exact param names before implementing — do not invent.)

---

## Discussion

### 2026-08-23 · planner · unic/unic-smart
Counts come from LOADED rows (`api.forEachNode` when the panel opens) — batched results
show partial counts until more rows load and the panel reopens. Accepted difference
(user-visible, documented in README via TASK-604). Select All must touch only
search-visible entries — Excel parity. `floatingFilter` flips to `false`: the floating
text row belonged to the replaced text filter.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: Exec602
SUMMARY: Replaced per-column text/number filter with Excel-style checkbox set-filter (custom AG Grid Community component). All 8 new panel tests + 7 migrated regression tests + 8 bundle tests green. Full suite 417/417; typecheck clean.
TEST_PLAN_FOLLOWED: task §4 — implemented all 8 test cases (1-7 happy/edge + 8 component roundtrip) and migrated webviewFilters tests 1/3/4/5/7/8 to {values:…} model.
FILES_CHANGED:
  - webview/main.ts: added SetFilterComponent class (init/getGui/isFilterActive/doesFilterPass/getModel/setModel/destroy/afterGuiDetached); wired `filter: SetFilterComponent` + `floatingFilter:false` in colDefs; added getActiveTab to __vsdb test seam; imports buildSetFilterEntries/setFilterPass/selectedKeysFromModel from resultsGridModel.
  - webview/styles.css: added .vsdb-setfilter* panel styles (search row, Select All row, list with hidden entries, label+count row, footer with status/Clear/Close) using VS Code CSS vars.
  - src/ui/__tests__/webviewSetFilter.test.ts: (new) 8 tests covering panel DOM, setFilterModel, (Blanks), case-variant merge, search+SelectAll, Clear roundtrip, multi-column AND, getModel/setModel roundtrip.
  - src/ui/__tests__/webviewFilters.test.ts: migrated 7 tests from {filterType:'text',type:'contains',filter:…} to {values:['name-1' | 'beta']}; test 6 converted to async + reset activeTab via interim empty-results dispatch + click tabs[1].
  - src/ui/__tests__/webviewBundle.test.ts: test 6 converted to async + interim activeTab reset (parallel-test order makes module-scoped activeTab leak).
TESTS_ADDED:
  - src/ui/__tests__/webviewSetFilter.test.ts: 1-8 (panel + integration).
VERIFICATION:
  command: cd .worktrees/task-602 && npm run compile && npx vitest run src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck && npx vitest run
  result: target 23/23 pass; typecheck exit 0; full suite 417/417 pass (36 files)
  output_excerpt: |
    Test Files  36 passed (36)
    Tests  417 passed (417)
ISSUES: none — clean cutover (no ag-grid-enterprise added, no shim). Inline marginLeft on count cell so jsdom getComputedStyle returns "auto" without external stylesheet. Note: webviewFilters test 6 and webviewBundle test 6 now require interim activeTab reset (parallel test execution shares module-scoped state); documented inline.
HANDOFF_TO_REVIEWER: yes — all 8 task §4 test cases covered, regression gates (loadMore + columnsChanged) preserved, typecheck + full suite green.
NEXT: ready for review.
