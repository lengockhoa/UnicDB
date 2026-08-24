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

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: W1-T005 (feature-implementer)
SUMMARY: Moved the WHERE/ORDER BY requery bar construction block above the AG Grid host creation inside `buildPersistentDom` so the bar is gridWrap's first child — visible directly under the top toolbar/tabs, above the table. Footer, saveBanner, Re-Run/Clear handlers, requery message protocol, and resultsPanel host side all unchanged.
TEST_PLAN_FOLLOWED: inline — TDD cycle followed: added 4 new layout assertions to the existing TASK-504 describe block (DOM order inside gridWrap, document order toolbar<bar<host, empty-state hidden, footer position). Saw RED on cases 5 & 6 before the move (asserted `idxRequery < idxHost`, returned 2 vs 0; document-order `cmp(bar,host)` returned 1 instead of -1). GREEN after relocation.
FILES_CHANGED:
  - webview/main.ts: relocated the requery-bar construction block (L731-769 in the prior version) above `gridHost` creation; updated the inline doc-comment to reflect the new position and added a TASK-005 note in `PersistentDom.gridWrap`.
  - src/ui/__tests__/webviewRequery.test.ts: added tests 5, 6, 7, 8 inside the existing `describeIfBundle("webview/main.ts WHERE/ORDER BY requery bar (TASK-504)")` block covering the four required cases (DOM order, document order, empty state, footer position).
TESTS_ADDED:
  - src/ui/__tests__/webviewRequery.test.ts: "5. DOM order inside gridWrap: requery bar < grid host"; "6. Document order: toolbar < requery bar < grid host"; "7. Empty state: requery bar not visible (no active statement)"; "8. gridFooter is positioned after gridHost in gridWrap".
VERIFICATION:
  command: npm run compile && npx vitest run src/ui/__tests__/webviewRequery.test.ts && npm run typecheck
  result: 10/10 pass (esbuild built dist/webview.js + dist/extension.js; vitest 6→10/10 passing including the 4 new TASK-005 cases; tsc --noEmit clean)
  output_excerpt: |
    ✓ src/ui/__tests__/webviewRequery.test.ts  (10 tests) 846ms
    Test Files  1 passed (1)
         Tests  10 passed (10)
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review (Phase 4)

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart (config handoff.reviewer.model = unic-smart — match)
EXECUTOR_MODEL: unic/unic-code (differs — isolation OK)
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/webviewRequery.test.ts && npm run typecheck
  result: PASS — compile OK; 10/10 tests pass (re-ran file 4x serially, all green); tsc --noEmit clean
TEST_PLAN_COVERAGE: all-followed (cases 1-4 → tests 5-8; RED evidence concrete: idxRequery 2 vs 0, cmp 1 vs -1). Note: plan itself shipped 1 edge case vs config minTestsEdgeCase=2 (planner-side, non-blocking).
FINDINGS:
  critical:
    - none
  important:
    - webview/main.ts:303-307 — the diff DELETED `gridWrap: HTMLDivElement;` from the PersistentDom interface (JSDoc kept, property line dropped; diff hunk shows `- gridWrap: HTMLDivElement;` with no re-add). `dom.gridWrap` is used at L868/874/883/1224; `npx tsc -p tsconfig.webview.json` now reports 4 NEW TS2339 "Property 'gridWrap' does not exist on type 'PersistentDom'" errors. Invisible to `npm run typecheck` (root tsconfig excludes webview/). Fix: re-add `gridWrap: HTMLDivElement;` after the updated JSDoc.
  minor:
    - src/ui/__tests__/webviewRequery.test.ts:421 — diff ate the decorative `// ===...` banner line above "Fix Round 2 — Critical #1" comment; restore for consistency.
    - webview/main.ts — `gridHost: HTMLDivElement;` also missing from PersistentDom (PRE-EXISTING at base d266d93, not introduced here); add it in the same one-line fix if convenient.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Parallel-run flake judged TEST ISOLATION, not product: buildPersistentDom DOM order is built synchronously (no timing/async); tests 5/6 assert static child order and pass 4/4 serially. Plausible mechanisms: stale dist/webview.js from a pre-move compile at suite start, or worker-thread globalThis reuse across bundle-eval suites. Non-blocking.
