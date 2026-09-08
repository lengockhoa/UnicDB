# Handoff INDEX

## Cycle RES-BAR — WHERE / ORDER BY inputs in the Results toolbar + toolbar hover polish

Base: main @ accf1b5 (release 1.53.26). Cycle kicked off 2026-09-08 after user reported
missing/empty WHERE + ORDER BY inputs on the Results webview toolbar (P0 locked answers:
server-side re-run · free SQL fragment · in existing toolbar between `tsv` dropdown and
`Search…`). After P0 closed, user added a hover-jitter / late-tooltip concern that was
folded into TASK-RES-003 in wave 2.

Plan written by `unic-smart` (self-audit 12/12). P2.5 reviewer also `unic-smart`
(plan-review mode has no model-isolation gate per P2.5 contract). 4 minor findings
applied (compile-on-wave-2, property-level hover assertion vs rect-equality, wave-1
census `title`-clause rewrite to wave 2, toolbar DOM-order pin).

Prior cycle AGT-CLEANUP-2 (7/7 done) archived at `docs/AI_HANDOFF/INDEX_CLEAN2.md`.

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-RES-001 | Webview: relocate WHERE/ORDER BY inputs into the toolbar; placeholder + Enter keydown handlers with IME-composition guard | ready | none | webview/main.ts, webview/styles.css, src/ui/__tests__/webviewRequery.test.ts, src/ui/__tests__/webviewToolbar.test.ts | unic-smart |
| TASK-RES-002 | Extension: `stripLeadingClauseKeyword` helper at the `handleRequery` message boundary (defensive contract enforcement) | pending_review | none | src/ui/queryComposer.ts, src/ui/resultsPanel.ts, src/ui/__tests__/requeryClauseNormalize.test.ts (new), src/ui/__tests__/resultsPanelRequery.test.ts | unic-smart |
| TASK-RES-003 | Webview wave 2: drop `btn.title` from `makeIconButton` + smooth hover `transition: background-color 80ms ease-out` on `.UnicDB-btn` | ready | TASK-RES-001 (shares webview/main.ts + webview/styles.css) | webview/main.ts, webview/styles.css, src/ui/__tests__/webviewRequery.test.ts, src/ui/__tests__/webviewToolbar.test.ts | unic-smart |

Waves: **wave 1 = TASK-RES-001 ∥ TASK-RES-002** (parallel, disjoint file sets: webview/* vs
src/ui/{queryComposer,resultsPanel}.ts and disjoint test files). **wave 2 = TASK-RES-003**
(sequenced after RES-001 — shares both `webview/main.ts` and `webview/styles.css`).

Wave-boundary gates: `npm run typecheck` exit 0 · `npm run compile` clean · targeted
`npx vitest run …` GREEN at every wave (bundle-eval tests require compile first; silent
skips DO NOT count as green) · full `npm test` GREEN at final closeout.

Constraints: no version bump this cycle (maintainer folds into next release); the existing
`requery` message discriminator is the only webview→extension contract (no new message
type); no `transition: all` on `.UnicDB-btn` (RES-003); no change to the
`data-tooltip` pseudo-element block at `webview/styles.css:78-115`.
