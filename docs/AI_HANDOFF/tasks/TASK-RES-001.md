# TASK-RES-001 — Results toolbar: WHERE / ORDER BY inputs in the toolbar row + Enter re-runs

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3 (TASK-RES-001), §4, §7

## Goal

Move the existing WHERE / ORDER BY inputs (and their Re-Run + Clear buttons) from the
standalone requery bar under the toolbar into the toolbar row itself — slot: after the
`tsv` export `<select>`, before the header checkbox — with placeholders `WHERE …` /
`ORDER BY …`, and make Enter inside either input fire the requery exactly once. The
existing `requery` message → `handleRequery` pipeline is untouched; this task is
webview-only.

## Target Files

- `webview/main.ts` — relocate `requeryWhere`, `requeryOrderBy`, `requeryRunBtn`,
  `requeryClearBtn` (built at lines 1066-1104 inside `gridWrap`) into the toolbar
  construction between `exportFormat` (line 902 append) and `exportHeader` (line 908
  append); change placeholders to `WHERE …` / `ORDER BY …` (U+2026); drop the
  `requeryBar` wrapper + the two `.UnicDB-requery-label` labels (label lives in the
  placeholder + `aria-label`); add per-input `keydown` listener:
  `if (ev.key !== "Enter" || ev.isComposing) return; ev.preventDefault(); onRequeryClick();`.
  Keep class names `.UnicDB-requery-where/-order/-run/-clear` and the returned `dom`
  fields (`requeryWhere` etc., lines 1153-1156) — `webviewPostCommit.test.ts` selects them.
- `webview/styles.css` — add a toolbar-context rule for the inputs (narrow, shrinkable:
  e.g. `flex: 0 1 140px; min-width: 90px;` height aligned to the existing 24-26px
  button/search-input heights so the toolbar stays one row tall); remove the now-dead
  `.UnicDB-requery-bar` / `.UnicDB-requery-label` blocks (lines ~1246-1261) and the
  bar-context flex values on `.UnicDB-requery-input.UnicDB-requery-where/-order`
  (lines ~1277-1282). Do NOT touch `.UnicDB-toolbar { flex-wrap: nowrap }` (line 33) —
  pinned by a structural regex test.
- `src/ui/__tests__/webviewRequery.test.ts` — REWRITE cases 5, 6, 7 (they pin the old
  bar-inside-gridWrap layout and the empty-state invisibility) to the new toolbar
  placement; ADD the Enter-key cases below. Cases 1-4 and 8 keep passing unchanged.
- `src/ui/__tests__/webviewToolbar.test.ts` — case 1 expects 10 toolbar `.UnicDB-btn`
  buttons; update to 12 (Re-Run + Clear join the toolbar via `makeIconButton`, which
  already satisfies the svg/title/aria contract).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Enter on WHERE input posts requery once | `received` contains exactly 1 `{type:"requery", index:0, where:"id > 1", orderBy:"id DESC"}` | bundle eval'd in jsdom; `dispatchState(selectState())`; set both inputs, `dispatchEvent(new KeyboardEvent("keydown", {key:"Enter"}))` on `.UnicDB-requery-where` |
| 2 | happy | Enter on ORDER BY input posts requery once (both boxes filled) | exactly 1 requery post carrying both values, same shape as #1 | same harness, keydown on `.UnicDB-requery-order` |
| 3 | happy | Toolbar placement (P0 slot) | `.UnicDB-requery-where` and `.UnicDB-requery-order` are children of `.UnicDB-toolbar`; sibling order: `.UnicDB-export-format` < `.UnicDB-requery-where` < `.UnicDB-requery-order` < `.UnicDB-export-header`; `document.querySelector("[data-UnicDB-requery-bar]")` is `null` | same harness; `useCapture`-free querySelector assertions |
| 4 | happy | New placeholders + a11y | `.UnicDB-requery-where.placeholder === "WHERE …"`, `.UnicDB-requery-order.placeholder === "ORDER BY …"`; both inputs have non-empty `aria-label` | same harness |
| 5 | edge (key-kind) | Non-Enter keys do not post | keydown `"a"` then `"Escape"` on WHERE input → 0 requery messages in `received` | same harness |
| 6 | edge (IME-kind) | Enter during IME composition does not post | keydown Enter with `isComposing: true` → 0 requery messages | `new KeyboardEvent("keydown", {key:"Enter", isComposing:true})` |
| 7 | edge (census) | Toolbar icon-button census updated | `.UnicDB-toolbar .UnicDB-btn` buttons = 12; every one: `<svg viewBox="0 0 16 16">` + currentColor + non-empty title + aria-label + empty text (UPDATE existing case 1) | bundle eval'd; `dispatchState(threeRowsState())` |
| 8 | regression | Re-Run click, empty-string post, Clear — unchanged | existing cases 2, 3, 4 stay GREEN without edits (click path + class names preserved) | existing tests in webviewRequery.test.ts |
| 9 | regression | Document order rewritten for new layout | `.UnicDB-toolbar` precedes `.UnicDB-grid-host` in document order; inputs exist in the DOM in the EMPTY state (REWRITE old cases 5-7 — the bar no longer hides inside gridWrap) | bundle eval'd, no state dispatched for the empty-state half |

## Test Files

- `src/ui/__tests__/webviewRequery.test.ts` — tests 1-6, 8, 9 (modify existing file).
- `src/ui/__tests__/webviewToolbar.test.ts` — test 7 (modify existing file).

## Verification Commands

```bash
npm run typecheck
npm run compile   # REQUIRED: bundle tests eval dist/webview.js; treat self-skips as failures
npx vitest run src/ui/__tests__/webviewRequery.test.ts src/ui/__tests__/webviewToolbar.test.ts
```

## Acceptance Criteria

- [ ] All 9 test cases above GREEN after `npm run compile` (no `skipped` suites).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` full suite GREEN (webviewPostCommit, webviewKeybinding, webviewExport etc. unaffected).
- [ ] No new message type; the post shape stays `{type:"requery", index, where, orderBy}`.
- [ ] `.UnicDB-toolbar { flex-wrap: nowrap }` rule intact; no unrelated CSS edits.

## Dependencies

- (none)

## Interfaces

- Consumes: `onRequeryClick(): void` (`webview/main.ts:3294`) — existing; posts
  `{type:"requery", index:number, where:string, orderBy:string}` via `postToHost`.
  Host-side consumer `ResultsPanel.handleRequery(msg)` is OUT OF SCOPE here (TASK-RES-002
  hardens its input boundary; no signature change).
- Produces: toolbar-resident `dom.requeryWhere: HTMLInputElement` and
  `dom.requeryOrderBy: HTMLInputElement` (same field names in the builder's return object,
  `webview/main.ts:1153-1156`); same class names as before, so `webviewPostCommit.test.ts`
  selectors stay valid.

---

## Discussion

### 2026-09-08 · planner · unic-smart
Design decisions recorded from PLAN §3 (binding for executor):
1. Re-Run + Clear buttons MOVE with the inputs (toolbar, after ORDER BY input). Removing
   them would silently drop mouse-user functionality the user never asked to remove, and
   keeps existing tests 2-4 green untouched.
2. Inputs are now visible in the empty state ("No results yet."). Enter then surfaces the
   existing host toast "UnicDB: requery failed — no statement at index N." — accepted; do
   not add disable-state plumbing.
3. Holding Enter fires repeated keydowns → repeated posts; host `requerySeq` guard drops
   stale runs. Debounce-free per instruction — do NOT add a timer.
4. `ev.preventDefault()` on the handled Enter is deliberate; plain Enter only (no
   Cmd/Ctrl+Enter binding — the app-wide Cmd/Ctrl+Enter commit shortcut lives on gridWrap
   and must not be extended to these inputs in this cycle).

---
