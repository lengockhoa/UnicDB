# PLAN — Results Panel: replace VirtualGrid with AG Grid Community + fix Cancel

Cycle: 2026-08-22-A · Base: main · Planner: Planner (unic-smart)

## §1 Intent

**Problem (3 bugs verified in real browser, see `.cache/webview-repro/scroll.html`):**
1. Empty grid at the top viewport — custom `VirtualGrid` (webview/grid.ts) rebuilds DOM when new state arrives, rAF render with stale scrollTop → startIdx too large → 0 rows rendered (measured: scrollTop=471 stale, rowsRendered=0).
2. Run a new SELECT → nothing visible (same stale-scroll mechanism).
3. Cancel button disabled while loadMore is fetching — host does not call `setBusy(true)` around `runner.loadMore()`.

**User requirement:** use AG Grid ("that one is extremely good, display + filter are great"). Reference UI (internal QAS tool) requires: per-column filter, sortable, row selection (checkbox), search box, ellipsis truncation for long columns (UUID/JSON), row count "176 row(s)", footer bar.

**Success definition:** Results panel uses AG Grid Community (bundled locally via esbuild, NOT CDN) and renders every StatementResult; sort/filter/quick-filter/selection/copy work; batched infinite scroll (loadMore) keeps working; the 3 bugs above disappear; Cancel stays enabled and can cancel an in-flight fetch; version 1.3.0.

## §2 Scope

**In scope:**
- `ag-grid-community` (MIT, ^36.1.0) via npm, bundle into `dist/webview.js` (iife, es2022, browser) + CSS (ag-grid.css + theme Quartz) bundle into `dist/webview.css` via esbuild CSS import. NO CDN (CSP only allows `cspSource`).
- Pure-logic module `src/ui/resultsGridModel.ts`: column inference, loadMore state machine + in-flight gate, append-delta, cancel-more, copy text, footer text — unit tests do NOT require real AG Grid.
- `webview/main.ts`: replace `VirtualGrid` with AG Grid (client-side row model + `applyTransaction` append — see §3), toolbar adds a search box (quick filter), keep tabs + Messages tab + non-SELECT ok-message + copy protocol.
- Host: `resultsPanel.ts` wraps `setBusy(true/false)` around loadMore; cancel-during-loadMore does not toast an error.
- Version 1.3.0 + README feature bullet + build vsix (GitHub release by orchestrator).

**Out of scope:**
- Enterprise features (range selection, clipboard service, set filter, side bar) — paid license, FORBIDDEN.
- Modify queryRunner.ts (cancel-during-loadMore already works via `currentBatched`; do NOT touch).
- Schema Explorer, connection form, adapters, parser.
- Edit-table features from the reference UI (Commit/paste-Excel/CSV toggle) — read-only results cycle.
- Change message protocol `src/ui/messages.ts` (frozen).

**File ownership (no tasks in the same wave share a file):**
- W1: TASK-201 (package.json, package-lock.json, webview/main.ts-css-imports-only, src/ui/__tests__/agGridSmoke.test.ts) · TASK-202 (src/ui/resultsGridModel.ts, src/ui/__tests__/resultsGridModel.test.ts) · TASK-204 (src/ui/resultsPanel.ts, src/ui/__tests__/resultsPanel.test.ts) — strictly disjoint.
- W2: TASK-203 (webview/main.ts, webview/styles.css, webview/grid.ts [delete], esbuild.js, src/ui/__tests__/webviewBundle.test.ts, .cache/webview-repro/aggrid.html) — depends on 201+202.
- W3: TASK-205 (package.json version, README.md) — depends on 201+203+204.

## §3 Approach

**Core choice — client-side row model + append transaction, NOT the Infinite Row Model.** Every state message from the host already carries **all** rows that have been loaded (`r.result.rows` complete, not a window). The data is always memory-resident in the webview:
- Client-side model: AG Grid virtualizes rendering itself (eliminates the bug class of hand-written windowing), sort/filter/quick-filter run LOCALLY on the full set of loaded rows (matches the constraint "sort/filter local on loaded rows"). The Infinite Row Model can only sort on blocks already fetched, and `refreshInfiniteCache` is exactly the layer that risks resetting scroll — same bug family we are fixing.
- LoadMore: `onBodyScroll` → `checkLoadMore()`: if `model` still has `hasMore`, no quick filter is active, and `api.getLastDisplayedRow() >= loaded - 10` → `postToHost({type:'loadMore', index})`. The 1-shot gate lives inside the model (onNeedMore dedup until new state arrives).
- New state arrives: `model.sync(index, …)` → if same statement (no reset) and rows grew → `api.applyTransaction({add: delta, addIndex})` — NOT `setRowData` → scroll position preserved (bugs 1+2 die).
- New query (reset): `shouldResetGrid(results)` = any status `'running'` → `model.reset()` + `setRowData` + scroll top.

**Bundle/CSS:** `webview/main.ts` imports `ag-grid-community/styles/ag-grid.css` + `ag-theme-quartz.css` + `./styles.css` (custom override last). esbuild emits CSS imports automatically → `dist/webview.css`, overwriting the file copied by `copyWebviewCss()` (runs before build). If package exports fail to resolve `ag-grid-community/styles/*`, fall back to a relative import `../node_modules/ag-grid-community/styles/*.css`. TASK-203 fully removes `copyWebviewCss()` (clean cutover). `connectionForm` links `dist/webview.css` — styles.css now lives inside the bundle, so the form does NOT lose its style; TASK-203 only deletes the `.vsdb-grid*` VirtualGrid rules, every selector the connection form currently uses is kept.

**Grid features (Community, matching reference UI):** `sortable:true, filter:true, resizable:true` on every column; `floatingFilter:true` (text filter — per-column icon/row filter); `rowSelection:{mode:'multiRow', checkboxes:true, headerCheckbox:true}`; toolbar search input → `api.setQuickFilter(text)`; ellipsis via `cellStyle` + `valueFormatter: formatCell` + `enableBrowserTooltips` (hover shows full UUID/JSON); footer `N row(s)` from `api.getDisplayedRowCount()` (event `modelUpdated`). Copy: range selection is Enterprise → use row checkboxes + Ctrl/Cmd+C keydown handler on the grid host → `selectionToText(selectedRows)` (tab-separated) → `postToHost({type:'copy'})` — keep the old protocol.

**Column mapping:** cells are already sanitized (BigInt→string/number, Date→ISO), so the practical kinds are number/boolean/string. `inferColumns(columns, rows)` takes the first non-null cell per column → `ColumnSpec{field, headerName, kind, alignRight}`. `formatCell` keeps its existing behavior, moved verbatim from `webview/grid.ts` into the model module.

**Host busy/cancel (TASK-204):** `handleMessage('loadMore')` → `setBusy(true)` → `await runner.loadMore()` → post state → `finally setBusy(false)`. Webview Cancel button `disabled=!busy` → now enabled exactly while a batch is fetching. Cancel-during-loadMore: fetchBatch rejects (cursor already cancelled via `currentBatched`) → catch: if `runner.isCancelled()` or the message matches /cancel/i → swallow the toast, only re-post state; other real errors → toast as before.

**Trade-offs:** vsix grows ~1MB (ag-grid min) — accepted for production grid quality. jsdom tests against the real bundle are a bit chatty (stub ResizeObserver) but give a real regression net for bugs 1/2 without needing VS Code.

**Alternatives rejected:** (a) Infinite Row Model — see above; (b) fix VirtualGrid windowing — the bug lives in the rebuild-DOM design, replacing with AG Grid is cheaper than fixing; (c) CDN JS/CSS — violates webview CSP; (d) Enterprise — paid license.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| unit (201) | ag-grid smoke jsdom | createGrid + rowData 3 rows → `getDisplayedRowCount()===3` |
| unit (202) | inferColumns | int/bigint-sample column → kind number + alignRight; string/date-ISO → string; boolean → boolean |
| unit (202) | loadMore gate | requestWindow past loaded + hasMore → onNeedMore fires EXACTLY 1 time; called again before sync → does NOT fire a 2nd time |
| unit (202) | append delta + EOF | sync 500 more rows → appendDelta returns exactly 500 new rows; EOF → total=rows.length |
| edge (202) | cancelMore | after cancelMore(), bottom requestWindow NEVER fires onNeedMore |
| unit (202) | selectionToText | 2 rows × 2 cols → `a	b
c	d`; null cell → empty string |
| unit (202) | shouldResetGrid/footerText | any running status → true, all-terminal → false; footer batched vs filtered exact strings |
| bundle (203) | 3 statements render | state msg (select 200 rows + insert ok-message + error) → 4 tabs, `getDisplayedRowCount()===200`, ok-message element present |
| edge (203) | new query reset (bug 2) | state 200 rows → state running → state 50 rows → count===50, no stale |
| edge (203) | batched loadMore (bug 1) | state 500 batched → `checkLoadMore()` → postToHost receives `loadMore`; state 1000 rows → applyTransaction add (count 1000, NOT full setRowData) |
| unit (204) | busy around loadMore | busy:true postMessage sent BEFORE runner.loadMore resolves; busy:false + state after |
| edge (204) | cancel inside loadMore | loadMore reject "cancelled" → does NOT call showErrorMessage; busy:false |
| edge (204) | real error | loadMore reject generic → showErrorMessage "Load more failed: …" |
| regression (204) | full resultsPanel suite | old tests (sanitize BigInt, postMessage rejection) still pass |
| smoke (205) | version + package | `package.json` 1.3.0; `npm run package` produces vsdb-1.3.0.vsix |

## §5 Verification Commands

No lint script in the repo (scripts: compile/watch/test/test:integration/typecheck/package) → typecheck is the substitute gate, mandatory in every task.

```bash
# TASK-201
npm install && npx tsc --noEmit && npx vitest run src/ui/__tests__/agGridSmoke.test.ts && npm run compile
# TASK-202
npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts
# TASK-203
npm run compile && npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/webviewBundle.test.ts
# TASK-204
npx tsc --noEmit && npx vitest run src/ui/__tests__/resultsPanel.test.ts
# TASK-205
npx tsc --noEmit && npx vitest run && npm run compile && npm run package
# Wave boundary (every task): npx vitest run   # full suite regression net
```

## §6 Acceptance Criteria

- [ ] AG Grid renders rows at EVERY scroll position; a new SELECT replaces the grid immediately without stale state (bugs 1, 2 dead — TASK-203)
- [ ] Per-column filter (floating text filter), sort, resize, checkbox selection, search-box quick filter, ellipsis + tooltip, footer "N row(s)" (TASK-203)
- [ ] Batched infinite scroll: scroll near bottom → loadMore → rows append, scroll does NOT jump (TASK-202+203)
- [ ] Cancel enabled during loadMore fetch; click cancels the waiting fetchBatch; NO toast for the cancel (TASK-204)
- [ ] Non-SELECT ok-message, statement tabs, Messages tab, copy tab-separated, BigInt/Date sanitize — kept unchanged (TASK-203, regression suite)
- [ ] `npx tsc --noEmit` + `npx vitest run` full pass; `npm run compile` produces 3 bundles + webview.css containing AG Grid CSS (TASK-201/203)
- [ ] Version 1.3.0, vsix builds (TASK-205)

## §7 Global Constraints

- AG Grid **Community only**: forbidden to import `ag-grid-enterprise`, forbidden range selection / clipboard service / set filter / license key.
- Forbidden to load JS/CSS from CDN — every asset goes through esbuild bundle (CSP `script-src cspSource`).
- Message protocol `src/ui/messages.ts` is frozen: state/busy/loadMore(index)/cancel/copy(text)/ready.
- Pure logic MUST live in `src/ui/resultsGridModel.ts` (inside tsc include) — webview/main.ts is NOT typechecked by tsc (tsconfig include src/**), type risks MUST be blocked by compile + bundle tests.
- npm (NOT yarn); no new devDeps besides `jsdom`.
- Version bump follows the user's rule: between = major update → 1.2.2 → 1.3.0.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (a) TASK-201 must add css imports into main.ts right at W1 to actually demonstrate the CSS pipeline end-to-end (instead of waiting until W2); (b) dropped the idea of fixing queryRunner.ts — cancel-during-loadMore is already reachable via `currentBatched` (queryRunner.ts:276), TASK-204 only touches resultsPanel; (c) locked client-side row model instead of Infinite Row Model — data is memory-resident, rationale captured in §3; (d) tsconfig does not typecheck webview/ — discovered and captured in §7.
Known gaps: (1) Which CSS selectors in styles.css belong to the connection form are not enumerated line-by-line — TASK-203 may ONLY DELETE the `.vsdb-grid*`/ `.vsdb-scroll*`/ `.vsdb-spacer*`/ `.vsdb-viewport*` rules (VirtualGrid-only), everything else is kept; connectionForm regression = test suite + manual form open. (2) ag-grid `styles/*` exports-map resolution not yet verified locally (no install during planning) — relative-path fallback import is captured in TASK-201 Discussion. (3) Final browser smoke (Playwright/`.cache/webview-repro/aggrid.html`) is the orchestrator's job before release, not an executor gate.

## Plan Review Log

### Round 1 — 2026-08-22 · unic-smart (PlanRev2)

Status: Approved

COMPLETENESS:
  - none — bugs, approach, waves, file ownership, tests, commands, version bump all specified; known gaps self-declared and acceptable.
CONSISTENCY:
  - minor (advisory): §3 + Self-Audit gap (1) delete-glob `.vsdb-grid*` also matches `.vsdb-grid-footer` (webview/main.ts:185) and `.vsdb-grid-host` (main.ts:150) which MUST be KEPT — TASK-203.md line 15 already says "footer `.vsdb-grid-footer` keep" and re-adds `.vsdb-grid-host`; task text governs, executor must NOT glob-delete those two.
CLARITY:
  - minor (advisory): §7 "type risks must be blocked by compile + bundle test" overstates esbuild — esbuild transpiles without type diagnostics (only catches resolve/syntax errors). The real net is the jsdom smoke/bundle tests; `npm run compile` passing must NOT be read as type safety.
SCOPE:
  - none — Results panel + version only; out-of-scope list explicit (queryRunner, protocol, adapters, Enterprise).
YAGNI:
  - none — every feature maps to reference-UI/user requirements; Enterprise/CDN/protocol changes rejected.

NOTES: Plan claims cross-checked against repo: tsconfig excludes webview/ and **/*.test.ts (so tsc never sees AG Grid types — plan's mitigation acknowledged); package.json has no lint script, typecheck gate correct; messages.ts matches frozen set; cancel-during-loadMore reachable via currentBatched (queryRunner.ts:274) and isCancelled() exists (queryRunner.ts:78); styles.css `.vsdb-row` is connectionForm-only and untouched by the deletion list. Minor items are advisory — task files disambiguate; no flawed build expected.
