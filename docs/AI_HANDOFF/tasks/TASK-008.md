# TASK-008 — Stabilize the webview server-sort bundle lifecycle

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 item 8, §3.8

## Goal

Eliminate the case-18 flake in `webviewServerSort.test.ts` at its lifecycle root: it currently
evaluates `dist/webview.js` in every `it`, leaving repeated `window` listeners and debounce
closures. Evaluate once per suite, reset only real test state between cases, and wait for
observable grid/debounce output rather than using the fixed 250 ms sleep.

## Target Files

- `src/ui/__tests__/webviewServerSort.test.ts` — single bundle lifecycle, deterministic reset,
  bounded observable waits, and shuffled-seed regression coverage. No production target files.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Case 18 filter requery posts once | After selecting `beta` in the set filter, exactly one requery is posted; it has `orderBy:"name ASC"` and defined `filters`. | Single evaluated bundle and state fixture from existing case 18. |
| 2 | edge — ordering | Sort inside debounce cancels stale post | Applying `name ASC` before the 150 ms filter debounce expires produces exactly one requery carrying both active sort and filter model. | Existing case-18(b) synchronous AG Grid dispatch sequence. |
| 3 | edge — cleanup | Prior case cannot retain listeners/timers | Before each case, received messages belong only to its fresh receiver and no old listener posts to a prior array; no fixed `setTimeout(250)` remains. | A preceding test may have set a filter and scheduled debounce work. |
| 4 | regression — stress | Five shuffled seeds are green | The entire file passes for seeds 1–5 with `--poolOptions.threads.singleThread --sequence.shuffle.tests`; no retry flag or test repetition. | Compiled `dist/webview.js`. |
| 5 | edge — missing bundle | Existing bundle guard stays honest | When `dist/webview.js` is absent, `it.runIf(bundleSrc !== null)` skips rather than pretending the tests passed. | Existing bundle-source guard. |

## Test Files

- `src/ui/__tests__/webviewServerSort.test.ts`

## Verification Commands

```bash
npm run compile
npx vitest run src/ui/__tests__/webviewServerSort.test.ts
for seed in 1 2 3 4 5; do npx vitest run src/ui/__tests__/webviewServerSort.test.ts --poolOptions.threads.singleThread --sequence.shuffle.tests --sequence.seed=$seed || exit 1; done
npm run typecheck
```

Compile is mandatory because the test evaluates `dist/webview.js`. `package.json` has no lint
script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [ ] The bundle is evaluated once per suite, not once per `it`.
- [ ] Each case gets a fresh received-message collector and clean DOM/grid state through existing
      behavior; no production test-only hook is added.
- [ ] Case 18 uses an observable bounded wait, not a larger arbitrary sleep or retry.
- [ ] All existing server-sort scenarios retain their semantic assertions.
- [ ] Isolated and five shuffled single-thread seed runs exit 0.
- [ ] `npm run typecheck` exits 0.

## Dependencies

- none

## Interfaces

- Consumes: existing `loadBundle()`, `dispatchState(msg)`, `getGridApi()`, `requeries(received)`,
  and `flushGridEvents()` helpers in `webviewServerSort.test.ts:78-155`; bundle debug getter
  `window.__vsdb?.gridApi`.
- Produces: deterministic test harness only; no production protocol or API.

---

## Discussion

1. **Grounded root cause.** The file’s `loadBundle()` evaluates source at `:98`; each `it` calls
   it. The bundle installs global handlers, so fresh full-suite execution accumulates listeners
   and debounce closure state. Cycle X TASK-003 solved the same class in
   `resultsGridModelNull.test.ts`; follow that pattern rather than adding retries.
2. **Do not remove coverage.** Case 18’s two subcases explicitly validate the filter/sort
   debounce interaction; keep both and make their time synchronization observable.
3. **TDD order.** First add the single-lifecycle setup and an assertion that demonstrates one
   receiver/listener path; then replace the 250 ms wait with bounded `vi.waitFor` or a verified
   event/observable state wait. The five-seed command is the regression proof.

---
