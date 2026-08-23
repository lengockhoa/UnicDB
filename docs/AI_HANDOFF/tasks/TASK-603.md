# TASK-603 — Icon toolbar (one row) + requery-bar icons

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.B

## Goal

All 9 toolbar buttons + WHERE/ORDER BY bar's Re-Run and Clear become icon buttons
(inline SVG, `currentColor`, `title` + `aria-label`, no visible text), and the toolbar
rearranges into ONE compact non-wrapping flex row grouped query│edit│export with the
search input last. Handlers and class selectors unchanged — presentation + layout only.

## Target Files

- `webview/main.ts` — icon-buttonize `cancelBtn/refreshBtn/addRowBtn/deleteRowBtn/undoBtn/commitBtn/csvToggleBtn/exportCopyBtn/exportFileBtn` (buildPersistentDom, lines 394-492) + `requeryRunBtn/requeryClearBtn` (lines 645-659): `textContent=""`, `innerHTML` = 16×16 inline svg (`stroke="currentColor"`), `title`+`aria-label` = former label/tooltip; insert 2 `<span class="vsdb-toolbar-sep">` group dividers; move `searchInput` append last (already last); NO handler changes
- `webview/styles.css` — `.vsdb-toolbar { display:flex; flex-wrap:nowrap; align-items:center; gap:4px; min-width:0 }`; `.vsdb-btn` compact 24–26px (svg 16×16, padding ≤4px); `.vsdb-toolbar-sep`; `.vsdb-export-format`/`.vsdb-export-header` compact height; `.vsdb-search-input { flex:0 1 180px; min-width:120px }`
- `src/ui/__tests__/webviewToolbar.test.ts` — (new) icon + single-row tests
- `src/ui/__tests__/webviewExport.test.ts` — adjust only selectors that relied on button TEXT (today's tests use classes — verify, adjust if any textContent assertions appear)
- `src/ui/__tests__/webviewEdit.test.ts` — adjust if any button-text assertions (verify first)
- `src/ui/__tests__/webviewSaveEdits.test.ts` — adjust if any button-text assertions (verify first)
- `src/ui/__tests__/webviewRequery.test.ts` — adjust if any button-text assertions (verify first)

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | every toolbar `.vsdb-btn` renders svg + non-empty title + aria-label + empty text | 9 buttons; each has `querySelector('svg')` truthy, `svg` uses `currentColor` (attribute `stroke="currentColor"`), `textContent.trim()===''`, `title!==''`, `getAttribute('aria-label')!==''` | bundle loaded, any grid state |
| 2 | happy | icon flows keep behavior: Cancel posts `{type:'cancel'}`; Commit (with dirty edit) posts `saveEdits`; Copy posts `copy`; Export posts `exportFile`; CSV toggle flips formatter | each click produces the SAME message as before the icon change (assert message types + payloads) | 3-row fixture + a simulated cell edit for commit |
| 3 | edge | single flex row: all `.vsdb-toolbar` element children share equal `offsetTop`; search input is `lastElementChild`; exactly 2 `.vsdb-toolbar-sep` dividers; group order query│edit│export (Cancel first, then Refresh…CSV, then select+header+copy+export, search last) | `new Set(children.map(c=>c.offsetTop)).size===1`; order assertions exact | jsdom (offsetTop is 0 for all — equal set trivially true; rely on #4 for the structural guarantee) |
| 4 | edge | styles.css pins nowrap: source matches `/\.vsdb-toolbar\s*\{[^}]*flex-wrap:\s*nowrap/` and `.vsdb-btn` svg sizing rule exists | regex match true — wrapping is impossible by construction at ANY width | readFileSync `webview/styles.css` |
| 5 | edge | requery-bar icons: `.vsdb-requery-run`/`.vsdb-requery-clear` have svg + title, empty text; Re-Run icon posts `{type:'requery', where:'id > 1', orderBy:'id DESC'}`; Clear icon empties both inputs | message payload exact; inputs `""` after Clear | inputs set then icon clicks |
| 6 | regression | existing suites green through icon buttons: `webviewExport` (5 tests), `webviewSaveEdits`, `webviewEdit` toolbar tests, `webviewRequery`, `webviewSetFilter`, `webviewBundle` | 0 fail with selectors unchanged | full targeted run |

## Test Files

- `src/ui/__tests__/webviewToolbar.test.ts` — (new) tests 1-5; bundle-eval pattern (compile first)
- `src/ui/__tests__/webviewExport.test.ts` / `webviewEdit.test.ts` / `webviewSaveEdits.test.ts` / `webviewRequery.test.ts` — adjust ONLY text-dependent assertions (planner grep found NONE today — all use class selectors; edit only if the executor's run reveals one)

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewToolbar.test.ts src/ui/__tests__/webviewExport.test.ts src/ui/__tests__/webviewEdit.test.ts src/ui/__tests__/webviewSaveEdits.test.ts src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewBundle.test.ts
npm run typecheck
```

(compile FIRST — jsdom bundle-eval. No lint script exists in this repo; typecheck is the static gate.)

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS.
- [ ] No button lost its click handler — messages identical pre/post (tests 2, 5, 6).
- [ ] Toolbar single row, no wrap structurally guaranteed (flex-wrap: nowrap in styles.css, test 4).
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-602 (same files `webview/main.ts` + `webview/styles.css`; builds on its colDef state and must keep the set filter + its tests green)

## Interfaces

- Consumes: TASK-602's filter wiring (do not touch colDef `filter` or panel classes); existing `PersistentDom` fields (`cancelBtn`…`searchInput`, `requeryRunBtn`, `requeryClearBtn`).
- Produces: (none — terminal presentation task; TASK-604 only bumps version)
- Class contract preserved for tests: `.vsdb-btn`, `.vsdb-btn-danger`, `.vsdb-commit`, `.vsdb-export-format`, `.vsdb-export-header`, `.vsdb-export-copy`, `.vsdb-export-file`, `.vsdb-search-input`, `.vsdb-requery-run`, `.vsdb-requery-clear` + NEW `.vsdb-toolbar-sep`, `.vsdb-btn-icon` (svg wrapper class if used).

---

## Discussion

### 2026-08-23 · planner · unic/unic-smart
jsdom gives `offsetTop = 0` for everything — test 3's equal-offsetTop assertion is
structurally weak there, so test 4 pins `flex-wrap: nowrap` in the CSS source (no wrap
at any width, by construction). Recommended manual browser smoke at a narrow window
before release (maintainer, see TASK-604). Buttons stay flat children of
`.vsdb-toolbar` (no wrapper divs) so every existing `root.querySelector('.vsdb-…')`
keeps working.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
