# TASK-003 — Eliminate NULL/viewer aggregate flake at bundle lifecycle root

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2, §3.2

## Goal

Make `resultsGridModelNull.test.ts` deterministic by evaluating the webview bundle once, reusing/resetting one grid lifecycle, and waiting for observable AG Grid state rather than elapsed time. Do not add retries, production test hooks, or longer arbitrary sleeps.

## Target Files

- `src/ui/__tests__/resultsGridModelNull.test.ts` — one suite bundle lifecycle, per-test state reset, AG Grid animation flush, and bounded observable waits.

## Test Cases (REQUIRED — TDD)

| # | Type | Test Name | Expected | Pre-state / Fixture |
|---|---|---|---|---|
| 1 | happy | Long read-only value opens one viewer | After replacing column `s` with `editable: false`, a double-click creates exactly one `.vsdb-value-viewer` whose text is exactly 500 `x` characters. | One evaluated bundle; `GridApi.flushAllAnimationFrames()` then `vi.waitFor` |
| 2 | edge — ordering/load | Shuffled suite remains deterministic | Five single-thread shuffled seeds pass all NULL/viewer cases with no retry and no fixed 50 ms waits. | Seeds 1–5 after `npm run compile` |
| 3 | edge — cleanup/state | Prior editor/viewer cannot leak | Before each case there is no active editor and no viewer; after editable-null double-click editing count is `> 0` and viewer count is `0`. | Previous case may have opened viewer/editor |
| 4 | regression | Bundle installs one message lifecycle | Bundle evaluation occurs once for the describe block rather than once per `it`; case 6 no longer races five stale message handlers/timer closures. | Existing six cases currently call `loadBundle()` independently |
| 5 | edge — interaction | Viewer close path remains usable | Escape closes the open viewer and the following case starts with zero overlays. | Read-only long-string viewer open |

## Test Files

- `src/ui/__tests__/resultsGridModelNull.test.ts` — contains all cases; no new test-only production API.

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts
for seed in 1 2 3 4 5; do npx vitest run src/ui/__tests__/resultsGridModelNull.test.ts --poolOptions.threads.singleThread --sequence.shuffle.tests --sequence.seed=$seed || exit 1; done
npm run typecheck
```

`compile` must precede Vitest because the test loads `dist/webview.js`. `package.json` has no lint script.

## Acceptance Criteria

- [ ] Bundle evaluation and `window.message` listener installation happen once per suite.
- [ ] Tests use `GridApi.flushAllAnimationFrames()` and bounded `vi.waitFor` for observable transitions; no retry and no increased fixed sleep.
- [ ] Editor and overlay state is reset through existing APIs/interactions, not a production test-only method.
- [ ] Long content remains full, plain text, exactly 500 characters.
- [ ] Isolated run and all five shuffled single-thread seeds exit 0.
- [ ] `npm run typecheck` exits 0.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — the UI audit gate must complete before any Cycle X UI fix wave starts.

## Interfaces

- Consumes: existing `GridApi` methods `getEditingCells(): CellPosition[]`, `stopEditing(...)`, `setGridOption(...)`, and `flushAllAnimationFrames(): void`; bundle debug getter `window.__vsdb.gridApi`.
- Produces: deterministic test harness only; no production interface.

---

## Discussion

### 2026-08-26 · planner · bao-opus
Confirmed source evidence: each current `loadBundle()` executes the whole bundle, whose anonymous `window.addEventListener("message", ...)` cannot be removed by the test. Case 6 is the sixth evaluation. Preserve behavior while fixing this lifecycle leak.

---
