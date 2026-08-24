# TASK-005 — Requery bar above the grid (webview layout)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Feature D)

## Goal

Move the WHERE + ORDER BY condition bar (requery bar) from below the table to above it —
directly under the top control toolbar — inside the results webview, keeping Re-Run/Clear
behavior and the bottom footer exactly as today.

## Target Files

- `webview/main.ts` — in the gridWrap construction (verified current append order ~L708-771:
  `gridHost` → `gridFooter` → `requeryBar` → `saveBanner`): move the requery-bar construction
  block (~L731-768) ABOVE the `gridHost` creation so `gridWrap.appendChild(requeryBar)` happens
  BEFORE `gridWrap.appendChild(gridHost)` — bar becomes gridWrap's first child (visually under
  toolbar/tabs, above the table). Do not change the bar's element structure, persistence
  semantics (created once, values read on click), or handlers. `saveBanner` stays above
  `gridFooter`; footer stays at bottom.
- `webview/styles.css` — ONLY if the relocation needs a spacing tweak (e.g. `.vsdb-requery-bar`
  margin/border against the toolbar); no redesign.
- `src/ui/__tests__/webviewRequery.test.ts` (modify) — add DOM-order assertions to the existing
  `describeIfBundle("webview/main.ts WHERE/ORDER BY requery bar (TASK-504)")` block; keep
  existing requery behavior tests green.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy (behavior change) | DOM order inside gridWrap | `[...gridWrap.children].findIndex(isRequeryBar) < findIndex(isGridHost)`; and in document order toolbar < requery bar < grid host | bundle loaded, grid active |
| 2 | regression | Re-Run click with WHERE/ORDER BY | clicking Re-Run posts `requery` message with `where` + `orderBy` values (existing behavior intact) | fill inputs, click |
| 3 | edge (empty state) | no statement rendered | requery bar not visible (gridWrap hidden) — bar must not float in empty state | initial state message |
| 4 | regression | footer/saveBanner placement | `gridFooter` is the LAST child of gridWrap (after gridHost, before/after saveBanner as today); footer text still at bottom | bundle loaded, grid active |

## Test Files

- `src/ui/__tests__/webviewRequery.test.ts` (modify — the suite that loads the dist bundle in
  jsdom and already asserts the bar's elements; tests-map selection for `webview/main.ts`).

## Verification Commands

```bash
npm run compile && npx vitest run src/ui/__tests__/webviewRequery.test.ts && npm run typecheck
```

(`npm run compile` required: webviewRequery.test.ts loads `dist/main.js`. tests-map step 1
selection; no lint script exists — N/A.)

## Acceptance Criteria

- [ ] Case 1 shown RED (failing DOM-order output pasted) before the move, GREEN after.
- [ ] All cases PASS; `npm run typecheck` clean; `npm run compile` builds dist/main.js.
- [ ] No changes to requery message protocol, Re-Run/Clear handlers, or resultsPanel host side.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `webview/main.ts` internal DOM build (gridWrap/gridHost/requeryBar/saveBanner,
  `makeIconButton`, `onRequeryClick`); host message `requery { index, where, orderBy }`
  protocol (unchanged).
- Produces: (none) — pure layout change, no new exports.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Keep the move minimal: relocate the construction block, do not restructure it into a helper
unless the diff stays under ~30 lines. The bar must remain INSIDE gridWrap (not appended to
root) so grid-panel visibility keeps hiding it in empty state (case 3 depends on this).

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
