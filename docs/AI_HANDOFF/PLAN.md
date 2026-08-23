# PLAN — Cycle 2026-08-23-G · Release 1.5.0: Results-grid UI polish + Run .sh fix

Scope complexity: LOW-MEDIUM — one subsystem family (results-grid webview UI + the
extension's Run-.sh affordance). No decomposition into queued modules; all five tasks
ship in this cycle.

## §1 Intent

Four user requests (2026-08-23, incl. two mid-planning refinements relayed by the
orchestrator), shipped together as release 1.5.0:

1. **Excel-style set filter** — replace the current per-column text/number filter
   popover ("Contains" + free-text input + AND/OR conditions, TASK-402) with an Excel
   checkbox-list panel: Search box, Select All + per-value checkboxes with right-aligned
   counts (`BUMD 1`, `BUMN 1` …), footer-left `All` / `N of M`, footer-right Clear + Close.
2. **Toolbar icon buttons** — Cancel / Refresh / Add Row / Delete Row / Undo / Commit /
   CSV / Copy / Export-to-file become icon buttons (inline SVG, `currentColor`,
   theme-follow); text moves to `title` tooltip + `aria-label`. Same treatment for the
   WHERE/ORDER BY bar's Re-Run and Clear buttons; consistent sizing/padding and aligned
   groups across ALL webview action buttons.
3. **Single-row toolbar** — everything fits ONE tidy row, no wrapping, compact sizing,
   logical grouping (query: Cancel │ edit: Refresh/Add/Delete/Undo/Commit/CSV │ export:
   format dropdown + Header + Copy/Export │ search last), `flex-wrap: nowrap`,
   overflow-safe.
4. **Run .sh must actually work (bugfix)** — user: "Tôi vẫn chưa thể run file này nè.
   file SH này tôi muốn runable và có nút run giống SQL". Fix why `vsdb.runScript` is not
   runnable/visible AND add a SQL-like CodeLens `▶ Run` for `.sh` files.

Success = a user opening the results grid sees: a compact one-row icon toolbar that
never wraps; a column filter that opens a checkbox list with counts, search, Select All,
Clear/Close; multi-value (incl. case-variant and blank) filtering works; footer `N of M`,
quick-search, CSV toggle, loadMore gating, edit/commit/export flows all still work.
Separately, a user opening a `.sh` file sees a `▶ Run` CodeLens (like SQL) and a working
editor-title play button; clicking either runs the full file in a reused "VSDB Script"
terminal. Version 1.5.0 + README updated; full suite green.

## §2 Scope

**In-scope**
- Webview UI: `webview/main.ts` + `webview/styles.css`; pure helpers in
  `src/ui/resultsGridModel.ts`; their tests.
- Custom set-filter component for AG Grid Community v36 (Enterprise set filter BANNED).
- Toolbar + requery-bar button restyle; single-row layout CSS.
- Run .sh: `src/extension.ts`, `src/ui/codeLensProvider.ts`, `package.json`
  (activationEvents + `vsdb.showRunLensSh` config + menu robustness) + tests
  (`src/extension.test.ts`, `src/ui/__tests__/codeLensProvider.test.ts`,
  `src/scaffold.test.ts`).
- Version 1.5.0, README bullets, release-notes file.

**Out-of-scope**
- Host-side results behavior (`src/ui/resultsPanel.ts`, query runner) — no
  message-protocol changes.
- AI assist tab (queued in INDEX.md — still awaiting user spec).
- Any grid data/edit/undo/save logic change — presentation + filter semantics only.

**Wave file-disjointness (CONSTRAINT)** — W2/W3 are a forced chain (both own
`webview/main.ts` + `webview/styles.css`); W1 runs two fully disjoint tasks in parallel;
W4 owns `package.json` (version) and must follow 605 (also edits `package.json`).
- Wave 1: TASK-601 (`src/ui/resultsGridModel.ts` + new pure test) ∥ TASK-605
  (`src/extension.ts`, `src/ui/codeLensProvider.ts`, `package.json`, 3 test files)
- Wave 2: TASK-602 (`webview/main.ts`, `webview/styles.css`, new + migrated webview tests)
- Wave 3: TASK-603 (`webview/main.ts`, `webview/styles.css`, new + adjusted webview tests)
- Wave 4: TASK-604 (`package.json`, `README.md`, `.cache/release-notes-v1.5.0.md`; full suite)

No two same-wave tasks share a file. (601∥605: disjoint; 602→603 share webview files so
chain; 604 after 605 because both touch `package.json`.)

## §3 Approach

**A. Set filter — custom filter component (Community-only).**
AG Grid's built-in set filter is Enterprise. Community v36 supports custom filter
components referenced directly in colDef: `filter: <component function>` implementing
`init(params)` / `getGui()` / `isFilterActive()` / `doesFilterPass({ node, data })` /
`getModel()` / `setModel(model)`, applying via `params.filterChangedCallback()`. No
`ModuleRegistry` registration needed for a direct function reference.

- **Pure logic (TASK-601)** in `src/ui/resultsGridModel.ts` (no DOM, no ag-grid import —
  same discipline as the rest of that file):
  - `buildSetFilterEntries(values: unknown[]): SetFilterEntry[]` — groups cell values
    case-insensitively (`key = String(v).toLowerCase()`; `null`/`undefined`/`""` →
    sentinel `"(Blanks)"`), `display` = first-seen original casing, `count` per group,
    ascending case-insensitive sort with `"(Blanks)"` pinned last.
  - `setFilterPass(value, selectedKeys | null)` — membership test on normalized key;
    `null` selectedKeys = filter inactive (everything passes).
  - `selectedKeysFromModel(entries, values | null)` — maps model display-strings back to
    keys; `null`/`undefined` model → `null` (inactive).
- **Component (TASK-602)** in `webview/main.ts`: panel DOM = search input, Select All
  checkbox, scrollable value list (checkbox + value + right-aligned count), footer
  (`All` / `N of M` status left; Clear + Close right). Styles in `webview/styles.css`
  (`.vsdb-setfilter*`). Entries rebuild from LOADED rows (`api.forEachNode`) when the
  panel opens (batched loads refresh counts on reopen — documented accepted difference
  vs server-side truth). Live apply on every checkbox change (`filterChangedCallback`).
  Select All acts on search-VISIBLE entries only. Clear → select all → inactive →
  `getModel() === null`. Close hides the menu. Multi-column filters compose natively
  (AG Grid ANDs per-column filters).
- **Wiring**: colDef `filter` swaps from `agTextColumnFilter`/`agNumberColumnFilter` to
  the component for EVERY ColumnKind (Excel parity — number columns get the same
  checkbox list). `floatingFilter: true` → `false` (the floating text row is superseded
  by the panel's own search box). `onFilterChanged` → `isColumnFilterPresent()` gate,
  `setFilterModel(null)` on column-set change, footer `N of M`, quick-search box, CSV
  toggle — all untouched. Model shape: `{ values: string[] }` (display strings) or
  `null`.

  *Alternatives rejected:* Enterprise `agSetColumnFilter` (licence-banned); keeping the
  text filter and adding checkboxes beside it (user asked to replace); quick-filter-only
  (no per-column semantics).

**B. Toolbar icons + one row + requery bar (TASK-603).**
- Each of the 9 toolbar buttons keeps its className and click handler; `textContent` →
  `""`; `innerHTML` = one inline `<svg>` (16×16, `stroke="currentColor"`, no external
  asset); `title` + `aria-label` = the former label/tooltip. Theme-follow is automatic
  via `currentColor`.
- Requery bar Re-Run + Clear: same treatment (icon-only + existing `title`), classes
  `.vsdb-requery-run` / `.vsdb-requery-clear` preserved.
- Single row: `.vsdb-toolbar { display:flex; flex-wrap:nowrap; align-items:center;
  gap:4px; min-width:0 }`; buttons 24–26px tall, `flex-shrink:0`; two
  `<span class="vsdb-toolbar-sep">` dividers mark query│edit│export groups (flat
  children — no wrapper divs, keeps every existing `root.querySelector` selector
  working); search input `flex: 0 1 180px; min-width:120px` last. `nowrap` makes
  wrapping impossible by construction at any width; the test additionally asserts all
  toolbar children share one `offsetTop`.
- Export `<select>` + Header checkbox get compact sizing to match button height.

**C. Run .sh fix + CodeLens (TASK-605).**
Verified defects (planner, reading current sources — executor re-verifies + turns each
into a RED test):
1. `package.json` `activationEvents` contains `onCommand:` entries for 10 commands but
   NOT `vsdb.runScript`, and has NO `onLanguage:shellscript` — the lens below can never
   activate it, and on VS Code builds that don't fully honor implicit command
   activation the editor-title button is dead too.
2. The editor-title menu entry for `vsdb.runScript` exists
   (`when: "resourceLangId == shellscript"`, group navigation, icon `$(play)` on the
   command) — the wiring is plausible, but nothing pins it in tests; add manifest
   regression assertions (when-clause, icon, palette executability via
   `contributes.commands`).
3. `commandRunScript` (`src/extension.ts:573`) reads
   `vscode.window.activeTextEditor` with NO guard — invoked from the palette with no
   editor it silently sends `"\n"` to the terminal (wrong, and possibly what the user
   hit). Add a no-editor guard + `showWarningMessage`.
Fix = declare activation events, guard the handler, and add the discoverable affordance
the user asked for: **CodeLens `▶ Run` for shellscript documents** following the existing
`VsdbCodeLensProvider` pattern (`src/ui/codeLensProvider.ts`): accept
`languageId === "shellscript"` in addition to `"sql"`, one lens on the FIRST line
(line 0, above the shebang — VS Code renders lenses above the line), title
`$(play) Run`, command `vsdb.runScript` (no arguments), gated by new setting
`vsdb.showRunLensSh` (default `true`, config-subscription mirrors `showRunLens`).
Register the provider a second time for
`{ scheme: "file", language: "shellscript" }` in `src/extension.ts:83-90`. The lens and
the editor-title button share the same `commandRunScript` handler + "VSDB Script"
terminal (reuse semantics already tested in `src/extension.test.ts` TASK-505 describe).

**D. Release (TASK-604).** `package.json` → 1.5.0; README feature bullets (1.5.0:
Excel checkbox set filter; icon toolbar single row; requery-bar icons; Run .sh lens +
fix) + updated header note; `.cache/release-notes-v1.5.0.md`; full-suite + typecheck +
compile gate. Tag `v1.5.0` / `gh release` stay with the maintainer (post-cycle), NOT in
the task.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | 601: buildSetFilterEntries groups + counts + first-seen casing + sort | `['BUMD','bumd','BUMN',null]` → `[{key:'bumd',display:'BUMD',count:2},{key:'bumn',display:'BUMN',count:1},{key:'(blanks)',display:'(Blanks)',count:1}]` in that order |
| happy | 602: check one value → grid filters + footer `1 of 3` | displayed rows 1; footer matches `/1 of 3/`; entry count badges right-aligned in DOM |
| happy | 603: all toolbar buttons render svg + title + aria-label, empty text | each `.vsdb-btn` in toolbar has `querySelector('svg')`, `textContent === ''`, non-empty `title` and `aria-label` |
| happy | 605: shellscript document → 1 lens, `$(play) Run`, command `vsdb.runScript` | lens[0].command.command === `vsdb.runScript`, title `$(play) Run`, range starts at line 0 |
| happy | 605: existing TASK-505 handler tests still green | runScript creates/reuses "VSDB Script" terminal, sendText full text + `\n` |
| edge | 601: blank variants merge | `null`, `undefined`, `''` → ONE `(Blanks)` entry, combined count |
| edge | 601: case-variant membership boundary | `setFilterPass('BUMD', Set{'bumd'}) === true`; `setFilterPass(null, Set{'(blanks)'}) === true`; `setFilterPass(null, Set{'bumd'}) === false`; `setFilterPass('x', null) === true` (inactive) |
| edge | 602: `(Blanks)` entry filters blank rows only | checking only `(Blanks)` displays exactly the blank-row count |
| edge | 602: `BUMD` + `bumd` merge to one checkbox | single entry `BUMD` count 2; checking it displays 2 rows |
| edge | 602: panel search `bu` narrows list; Select All touches visible only | only matching entries listed; Select All → visible checked, hidden unchecked and excluded from model `values` |
| edge | 602: setModel/getModel round-trip + Clear | `setFilterModel({name:{values:['beta']}})` → `getModel().name.values` ≡ `['beta']`; `isColumnFilterPresent() === true`; Clear → `isColumnFilterPresent() === false`, `getModel().name === null` |
| edge | 603: toolbar single flex row | all `.vsdb-toolbar` children share equal `offsetTop`; search input is `lastElementChild`; exactly 2 `.vsdb-toolbar-sep`; styles.css matches `/\.vsdb-toolbar\s*{[^}]*flex-wrap:\s*nowrap/` |
| edge | 603: icon buttons keep behavior | icon Cancel/Commit/Copy/Export post `cancel`/`saveEdits`/`copy`/`exportFile`; icon Re-Run/Clear post `requery` / empty inputs |
| edge | 605: no active editor → guard, no terminal abuse | `vsdb.runScript` with no editor: warning shown, `createTerminal` NOT called |
| edge | 605: `vsdb.showRunLensSh=false` → no lens | `provideCodeLenses` on shellscript doc returns `[]`; SQL path unaffected |
| regression | 605 (RED): manifest activation | `activationEvents` contains `onCommand:vsdb.runScript` AND `onLanguage:shellscript` — fails against today's `package.json` (both missing) |
| regression | 605: manifest menu robustness | editor/title entry for `vsdb.runScript` with `resourceLangId == shellscript`, group navigation; command has `icon` — pins what TASK-505 shipped untested |
| regression | 602: migrated `webviewFilters` suite green | gate tests (filter active blocks loadMore; cleared filter re-allows; columnsChanged clears filter) pass with `{values:[…]}` model |
| regression | 602/603: footer + loadMore suites green | `webviewBundle` footer `N of M`, `resultsGridModel` loadMore gate unchanged |
| regression | 603: edit/export/save/requery suites green via icon buttons | `webviewEdit`, `webviewExport`, `webviewSaveEdits`, `webviewRequery` pass with class selectors unchanged |
| regression | 604: full suite | `npx vitest run` 0 fail; `npm run typecheck` exit 0 |

## §5 Verification

Project scripts (verified in `package.json`): `compile` = `node esbuild.js`,
`typecheck` = `tsc --noEmit`, `test` = `vitest run`. **There is NO lint script in this
repo — stated explicitly, not omitted.** Package manager is npm (yarn is not used here).
jsdom bundle-eval tests load `dist/webview.js` ⇒ `npm run compile` MUST run before them.

- TASK-601: `npx vitest run src/ui/__tests__/resultsGridModelSetFilter.test.ts && npm run typecheck`
- TASK-605: `npx vitest run src/extension.test.ts src/ui/__tests__/codeLensProvider.test.ts src/scaffold.test.ts && npm run typecheck`
- TASK-602: `npm run compile && npx vitest run src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck`
- TASK-603: `npm run compile && npx vitest run src/ui/__tests__/webviewToolbar.test.ts src/ui/__tests__/webviewExport.test.ts src/ui/__tests__/webviewEdit.test.ts src/ui/__tests__/webviewSaveEdits.test.ts src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewBundle.test.ts && npm run typecheck`
- TASK-604: `npm run compile && npx vitest run && npm run typecheck`
- Wave/cycle boundary (mandatory regression net): full `npx vitest run` at TASK-604.

## §6 Acceptance

- [ ] Column filter opens an Excel checkbox panel (search, Select All, counts, `All`/`N of M` status, Clear, Close) — TASK-602
- [ ] Case-insensitive grouping, `(Blanks)` sentinel, counts from loaded rows, live apply — TASK-601 + 602
- [ ] `getModel`/`setModel` `{values}` round-trip; Clear ⇒ `isColumnFilterPresent() === false` — TASK-602
- [ ] Multi-column set filters compose (native AG Grid AND) — TASK-602 (assert in test)
- [ ] Footer `N of M`, quick-search, CSV toggle, colFilterActive loadMore gate, `setFilterModel(null)` on column-set change all survive — TASK-602
- [ ] 9 toolbar buttons + Re-Run/Clear are icon buttons (svg, `currentColor`, title + aria-label, no text) — TASK-603
- [ ] Toolbar is one non-wrapping flex row with query│edit│export grouping, search last, compact 24–26px controls — TASK-603
- [ ] All button flows (cancel/refresh/add/delete/undo/commit/csv/copy/export/requery) work through icon buttons — TASK-603
- [ ] `.sh` file: CodeLens `▶ Run` on line 1; editor-title play button visible; palette command runs; full file executes in reused terminal; `vsdb.showRunLensSh` respected — TASK-605
- [ ] `package.json` activationEvents include `onCommand:vsdb.runScript` + `onLanguage:shellscript` (RED today) — TASK-605
- [ ] `package.json` 1.5.0, README updated (grid polish + .sh lens), release notes written — TASK-604
- [ ] Full suite + typecheck + compile green — TASK-604

## §7 Global Constraints (inherited by every TASK-xxx by reference)

- AG Grid **Community v36 only**; Enterprise features (incl. built-in set filter) banned.
- Theme via `themeQuartz` JS Theming API only — NO legacy CSS imports (error #106).
- `npm run compile` BEFORE dist-dependent vitest (jsdom bundle-eval).
- No results message-protocol changes; TASK-603 button click handlers unchanged
  (presentation + layout only).
- npm, not yarn. No `git commit` by executor/reviewer — commits belong to the maintainer.
- Webview test seams stay on the existing patterns: `dist/webview.js` eval +
  `window.__vsdb` hooks / class selectors.

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) TASK-602 file set extended beyond the wave sketch with
`src/ui/__tests__/webviewFilters.test.ts` — replacing the text/number filter necessarily
breaks that suite's `{filterType:'text'}` models, so migrating it is part of 602.
(2) `floatingFilter` flagged for flip to `false` with rationale. (3) 603's regression
list widened to include `webviewRequery` (mid-planning scope addition) and re-verified
that existing suites assert class selectors, not button text, so icon conversion is
low-risk. (4) Mid-planning addition #2 (Run .sh): grounded the defect by reading
`package.json` (activationEvents missing `onCommand:vsdb.runScript` +
`onLanguage:shellscript`) and `src/extension.ts:573` (unguarded `activeTextEditor`) —
folded into TASK-605 as a RED-first regression, and 604's dependency list extended with
605 (both touch `package.json`, sequential waves so no conflict).
Known gaps: (a) Set-filter counts reflect LOADED (batched) rows, not server truth —
accepted difference, documented in-panel behavior. (b) jsdom cannot lay out real widths,
so "no wrap at narrow widths" is guaranteed structurally (`flex-wrap: nowrap` +
source-level CSS assertion) plus equal-`offsetTop` DOM check, not a pixel-level browser
snapshot; a manual browser smoke at narrow width is recommended at release time
(maintainer step, noted in TASK-604 Discussion). (c) The exact VS Code runtime reason
the user's editor-title button was dead cannot be reproduced in jsdom — TASK-605 fixes
all statically-verifiable defects (activation events, guard, lens) and pins each with a
manifest/unit regression; if the button still misbehaves in the user's VS Code, the lens
path gives an independent affordance. (d) W2→W3→W4 is a chain — forced by shared
`webview/main.ts`/`styles.css`/`package.json` ownership; W1 is 2-wide.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Plan Review Log

### Round 1 — 2026-08-23 · unic/unic-smart (plan-reviewer context, isolated from planner invocation)

VERDICT: Approved

COMPLETENESS:
  - none — §1–§7 all present and substantive; all 4 user requests (Excel set filter, toolbar icons incl. WHERE-bar Re-Run/Clear, single-row layout, Run .sh fix + CodeLens) mapped to TASK-601..605; no TODO/TBD/placeholders; known gaps explicitly documented in the self-audit.
CONSISTENCY:
  - minor: §6 acceptance "Multi-column set filters compose (native AG Grid AND) — TASK-602 (assert in test)" has no corresponding row in the §4 test table — add one 602 test row (two columns set-filtered → intersection) when generating the task file.
  - otherwise consistent: §4 601 expectations match §3.A normalization/sort/blank rules; wave file ownership matches §2 task file lists; every §5 command that loads dist runs compile first (601's pure test correctly omits it).
CLARITY:
  - minor: §2 wave lists for 602/603 say "new + migrated/adjusted webview tests" without naming each file; §5 verification commands name them exactly — treat §5 as the authoritative test-file list.
SCOPE:
  - none — one declared release family (results-grid webview + Run-.sh affordance) with explicit out-of-scope fences; not silently spanning subsystems.
YAGNI:
  - none — `vsdb.showRunLensSh` mirrors the existing `showRunLens` pattern (consistency, not speculation); no unrequested features found.

NOTES: Test plan meets the ≥2 different-kind edges per feature bar and carries RED-first manifest regressions (activationEvents, menu/icon pins); 604 as regression-only is appropriate for a release task. Verification commands are asserted planner-verified against package.json scripts; reviewer confirmed their internal shape (npm, compile-before-vitest ordering) per the read-only-plan constraint.
