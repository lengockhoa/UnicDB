# TASK-008 — Stabilize the webview server-sort bundle lifecycle

- Status: `pending_review`
- Owner: claude-code/bao-sonnet
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

| # | Type | Test name | Expected | Pre-state / Fixture |
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
  `window.__UnicDB?.gridApi`.
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
4. **Executor decision — isolation strategy.** The Cycle-X TASK-003 pattern (reset via
   `resetGrid` message pairs) did not transfer directly: this suite's cases intentionally vary
   column sets and header text per case, and the render lifecycle's `columnsChanged` reset
   triggers on column COUNT only (`webview/main.ts` ~1717). Two same-count statements in a row
   therefore keep the previous case's column defs. Chosen fix, still zero production hooks:
   every case mounts through a `mountStatement()` helper that parks the shared grid on a
   1-column statement first, so each real mount lands as a full defs rebuild + filter clear
   through the production branch, then absorbs the resulting api-source debounce post via the
   observable settle wait. Header/dialect variation needs no reload because `headerText` is
   re-read from every state message (`webview/main.ts` ~3337).
5. **Executor decision — quiescence semantics.** A pending debounce timer has no grid-state
   signature; the only observable completion is the post itself. The replaced fixed sleeps use
   "stream unchanged for one full debounce window (+50 ms slack)" (`waitForSettledStream`,
   `vi.waitFor`, timeout = 10× debounce) — a real timeout that fails loudly with the stream
   tail attached.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: not reproducible — root cause documented. ~25+ shuffled baseline rounds of the
ORIGINAL file (seeds 1-8, 90-92, 100-108, 200-201, 300-302; serial, concurrent trios, and with
concurrent heavy-suite load generators) all passed on this host (M-series, 10 cores, background
load avg 7-8): the old 250 ms fixed sleep leaves a 100 ms margin over the 150 ms debounce, which
masks the race locally. Root cause remains proven from source: the bundle's anonymous
`window.addEventListener("message", ...)` (`webview/main.ts` :3334) is unremovable, so every
per-`it` `loadBundle()` eval installed ANOTHER listener generation whose own debounce closures
could post behind the current case (the documented aggregate-run case-18 failures). Conversion
proceeded per task instruction ("if you cannot reproduce locally, say so and proceed").
Interim RED during conversion (before final form): case 3/15/16/17/18 posted 0 requeries
(shape-mixed defs on the shared lifecycle), case 5 leaked a second post (premature settle check),
two ReferenceError typos — all fixed as described below.

Verification Output:
```
$ npm run compile          (mandatory — tests evaluate dist/webview.js)
⚡ dist/webview.js 2.2mb … esbuild: build complete   [exit 0]

$ npx vitest run src/ui/__tests__/webviewServerSort.test.ts
 ✓ src/ui/__tests__/webviewServerSort.test.ts  (12 tests) 8351ms
 Test Files  1 passed (1)
      Tests  12 passed (12)

$ for seed in 1 2 3 4 5; do npx vitest run src/ui/__tests__/webviewServerSort.test.ts \
    --poolOptions.threads.singleThread --sequence.shuffle.tests --sequence.seed=$seed || exit 1; done
--- seed 1 --- ✓ src/ui/__tests__/webviewServerSort.test.ts  (12 tests) 8412ms | Tests 12 passed (12)
--- seed 2 --- ✓ src/ui/__tests__/webviewServerSort.test.ts  (12 tests) 8444ms | Tests 12 passed (12)
--- seed 3 --- ✓ src/ui/__tests__/webviewServerSort.test.ts  (12 tests) 8530ms | Tests 12 passed (12)
--- seed 4 --- ✓ src/ui/__tests__/webviewServerSort.test.ts  (12 tests) 8323ms | Tests 12 passed (12)
--- seed 5 --- ✓ src/ui/__tests__/webviewServerSort.test.ts  (12 tests) 8484ms | Tests 12 passed (12)

Extra stress (beyond required commands):
- seeds 6-10 shuffled single-thread: 5 × Tests 12 passed (12)
- seeds 11-12 shuffled single-thread WITH webviewBundle.test.ts running concurrently: pass + pass
- npm run typecheck → tsc --noEmit [exit 0]
```

Status: PASS
Note: Conversion specifics worth reviewer attention. (1) Case-18a/b now share one evaluated
bundle across sub-cases via fresh `mountStatement()` remounts instead of a second `loadBundle()`;
assertions byte-identical. (2) The old case 15 kept ONE grid for its three dialect loops relying
on per-load grids; here each dialect remounts (defs rebuild per driver header), assertions
unchanged. (3) Fixed `setTimeout(250)`/`setTimeout(50)` drains replaced everywhere by
`waitForSettledStream()` (quiet-window ≥ debounce+50ms, loud timeout at 1500ms); the ONLY remaining
`setTimeout(resolve, 0)` is the pre-existing macrotask yield `flushGridEvents()`. (4) `beforeEach`
also stops surviving editors so no case depends on prior-case DOM remnants. (5) Skipped-bundle
honesty preserved unchanged (`it.runIf(bundleSrc !== null)` / `describe.runIf`). No production
file touched — `git status --porcelain` shows only `src/ui/__tests__/webviewServerSort.test.ts`
(plus this handoff doc update).

---

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: bao-opus (config handoff.reviewer.model = unic-smart → opus tier; differs from executor)
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run <file> && seeds 1-5 (--poolOptions.threads.singleThread --sequence.shuffle.tests) && npm run typecheck
  result: compile exit 0; plain run 14 pass / 0 fail; seeds 1,2,3,4,5 each 14 pass / 0 fail; typecheck exit 0
TEST_PLAN_COVERAGE: all-followed (5/5 — case 1 :728-763, case 2 :778-799, case 3 beforeEach :270-274 + mountStatement :233-254, case 4 five seeds re-run green, case 5 it.runIf/describe.runIf :258-259 intact)
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ui/__tests__/webviewServerSort.test.ts:233-254 — mountStatement's park hop is correct
      ONLY because every real mount uses exactly 2 columns while park uses 1; a future 1-column
      case would silently skip the columnsChanged rebuild (webview/main.ts:1762,1945) and inherit
      the prior case's defs/filters. Add an `expect(columns.length).toBeGreaterThan(1)` guard
      inside mountStatement so the invariant fails loudly instead of degrading to a stale mount.
    - src/ui/__tests__/webviewServerSort.test.ts:49-77,262-264 — no afterAll teardown: the single
      evaluated bundle's anonymous window "message" listener and the grid survive the suite by
      design (it is unremovable), but there is also no gridApi.destroy()/document reset. Harmless
      today at one bundle eval; worth a one-line afterAll if a second describe block is ever added.
    - src/ui/__tests__/webviewServerSort.test.ts:270-274 — the between-cases beforeEach settle
      always burns a full SETTLE_QUIET_MS (200ms) even when the stream is already idle, and each
      mountStatement burns another; that is most of the ~8.4s file runtime. Acceptable cost for
      determinism, but note it before adding many more cases.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Independently confirmed zero production change (webview/main.ts absent from d0cd195 stat;
grep for park/remount/testHook/resetForTest across src+webview returns nothing outside __tests__).
Assertion-intent diff vs cee00ac shows only `expect(api).toBeTruthy()` moved into mountStatement
and the case-18b legacy `legacy.received` collapsed to the shared collector — no assertion
weakened; the two later TASK-007 cases (14 vs 12 tests) came from wave-2 commit abde88b, not this
task. Mutation probe (orderBy "name ASC" → "MUTANT") failed loudly, proving assertions are live,
and the file was restored byte-identical. Waits are genuinely bounded: vi.waitFor with
SETTLE_TIMEOUT_MS=1500 and a named throw carrying the stream tail; no while/for/setInterval poll.
