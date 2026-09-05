# TASK-BQ03-004 — ResultsPanel BigQuery job states + token-gated Load More

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (BQ-03.4), §3 Approach "Panel state", §4 row 14

## Goal

Make the ResultsPanel distinguish the BigQuery job lifecycle states (pending / running / cancelled / limited / error as visually DISTINCT states), gate Load More on the presence of a continuation capability rather than row count or the always-true `rowCount === null` signal, and keep the existing `sessionEpoch`/`requerySeq` staleness guarantees so a new connection/run can never render a prior BigQuery page. Host-side changes only — the wire protocol gains no breaking shape (reuse `StatementResult` fields; add nothing the webview must parse unless a state marker is genuinely required, and if so keep it additive/optional).

## Target Files

- `src/ui/resultsPanel.ts` — extend the host-side state handling: (a) surface `resultLimited`/`cursorClosed` statements as the distinct "limited"/ended states they already carry instead of hiding behind generic done; (b) ensure the Load More path treats a token-less (cursorClosed/no batched) statement as a no-op — do not post busy or toast on it; (c) keep pending→running distinct where the runner exposes it (a BigQuery `pending` statement maps to the existing `running` status until 03.3's contract provides finer state — if no new field is needed, pin the mapping in tests instead of inventing one). Reuse `sanitizeStatementResult` normalization for any added optional field.
- `src/ui/__tests__/resultsPanel.test.ts` — add a "BQ-03.4 BigQuery states" describe block with host-level fakes (existing `ResultsPanel` test harness style). Existing tests untouched.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | pending/running states are distinct | a BigQuery statement rendered with `status: "running"` while its job is pending shows the busy/spinner affordance; after settle with rows it shows done — the two posted `state` messages differ in the statement's status and the busy flag | fake runner emitting two onUpdate snapshots |
| 2 | happy | cancelled and error states are distinct from done and from each other | three statements with `status: "cancelled"`, `status: "error"` (error message set), `status: "done"` → the posted state preserves all three distinct statuses and the error text; none is re-rendered as another | fake results array |
| 3 | happy | limited state is distinct and suppresses the Load More toast | statement with `resultLimited: true, cursorClosed: true` → posted state marks it; a `loadMore` message for it performs NO runner call (spy), no busy flip, no "Load more failed" toast (existing suppression pinned + kept) | fake runner with loadMore spy |
| 4 | edge (empty/token-less) | Load More only when a token exists | `loadMore` for a statement with `batched: false` (token-less BigQuery final page) → runner.loadMore NOT called (or its rejection swallowed as the documented no-op), no busy state, state re-posted unchanged | spy runner |
| 5 | edge (stale) | new connection/run cannot display a prior BigQuery page | render results (epoch captured), `panel.dispose()`, `render()` fresh results (new epoch) → the stale in-flight `loadMore` completion posts NOTHING (epoch guard) — the new session's state is untouched | existing sessionEpoch harness pattern from resultsPanel.test.ts |
| 6 | edge (concurrency) | requery/re-render while a loadMore is in flight does not resurrect old rows | start loadMore, render() a newer result set before it resolves → the loadMore completion does not overwrite the newer `lastResults` (generation/seq guard) | existing requerySeq/`statementGeneration` pattern |
| 7 | regression | header passes through unchanged for non-BigQuery drivers | postgres results render with the same header string and states as before this task (snapshot/verbatim assertions from existing tests still pass) | current test file green |

## Test Files

- `src/ui/__tests__/resultsPanel.test.ts` — appended describe block; existing describes untouched.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
npx vitest run src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts   # adjacent panel suites sanity
```

(`npm run typecheck` is the static gate — **no lint script exists** in this repo.)

## Acceptance Criteria

- [ ] Every test in §Test Cases passes.
- [ ] Pending/running/cancelled/limited/error render as distinct states on the wire (statuses preserved, not collapsed).
- [ ] Load More fires only when the statement actually has a continuation capability (open handle); token-less/limited statements are silent no-ops with no busy flip and no error toast.
- [ ] Epoch/generation guards hold: a disposed panel or a newer render/requery can never receive or overwrite state from a stale BigQuery loadMore.
- [ ] No wire-protocol breaking change; any added field is optional and sanitized through `sanitizeStatementResult`.
- [ ] Existing resultsPanel suites stay green unmodified; `npm run typecheck` exits 0.

## Dependencies

- (none) — this task consumes only `StatementResult` fields that already exist at base (`status`, `cursorClosed`, `resultLimited`, `batched`) and fakes the runner in its own tests. TASK-BQ03-003 (same wave, disjoint file `src/core/queryRunner.ts`) pins the runner-side EOF→`cursorClosed` behavior; the panel's gating reads the marker, it does not create it, so no ordering constraint applies.

## Interfaces

- Consumes: `StatementResult` (`src/core/queryRunner.ts:49-71` — `status`, `result`, `batched`, `cursorClosed`, `resultLimited`, `error` — all present at base, plus the OPTIONAL `pending?: boolean` field that 03.3 adds for the BigQuery job-submitted-pre-first-fetch window); `QueryRunner.loadMore/isCancelled` (existing); `StateMessage` (`src/ui/messages.ts:20-44`); existing `sessionEpoch`/`requerySeq`/`statementGeneration` guards (resultsPanel.ts:162-190); `sanitizeStatementResult` (resultsPanel.ts:2191).
- Produces: no new public API. Pinned behavior for TASK-BQ03-005: the header string the host builds flows through `render(results, header)` unchanged and every state post re-applies it (`decorateStateMessage` interception point) — 03.5's BigQuery header must only supply a better header STRING, not change panel code.
- **Pending state mechanism (locked by PLAN.md round-1 review)**: `StatementResult.pending` is the field. 03.3 sets it to `true` when a BigQuery `runQuery` returns `{ results: [], batched }` (job submitted, first page not yet fetched) and clears it on the first successful page resolution. 03.4 reads `result.pending === true` to render the pending state as VISUALLY distinct from `running` (e.g. an explicit "submitting" affordance) — no `batched` boolean re-derivation, no `status` enum widening. When `pending` is `undefined` (every non-BigQuery path), behavior is byte-identical to base. The field flows through `sanitizeStatementResult` automatically (it spreads `...r`); the webview sees an optional `pending` field it can ignore if not yet aware of it — a backward-compatible additive change.

---

## Discussion

### 2026-09-03 · planner · unic-smart
Grounding notes for the executor:

1. **Do not invent a parallel state enum.** `StatementResult.status` already has `running/done/error/cancelled`, and `resultLimited`/`cursorClosed` already express "limited/ended". The distinctness the roadmap asks for is: preserve these distinct values on the wire and gate the affordances (spinner, Load More, toasts) per state. If a genuinely new marker proves necessary (e.g. BigQuery `pending` distinct from `running`), add an OPTIONAL field on `StatementResult`, default-undefined for every non-BigQuery path, sanitized through `sanitizeStatementResult` (which spreads `...r` so new fields flow automatically — verify byte behavior).
2. **The panel must not learn what a page token is.** Continuation stays encapsulated (plan §3). The panel's gate is "does this statement have an open handle / not limited / not closed" — that is the token's existence, proxied.
3. Existing suppression logic for cancel-during-loadMore and limited statements lives in the `loadMore` message handler (resultsPanel.ts:763-818). Extend the same guards for the token-less case; do not add a second error lane.
4. The webview bundle (dist/webview.js) is NOT in this task: state distinctness is pinned at the `postMessage` boundary (what the host sends), not the webview's rendering of it. If the webview needs a new visual, that is a follow-up — record it in Discussion rather than expanding scope here.
5. RED-first: test #4 should fail against current code only if the current code actually calls loadMore for a batched-less statement — verify first (the runner throws "no batched cursor"; the panel toasts). Pin the improved behavior: no call, no toast, silent re-post.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 FAIL  src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — BQ-03.4 BigQuery states > #3 — resultLimited + cursorClosed statement: loadMore is a silent panel-level no-op (no runner call, no busy flip, no toast)
AssertionError: expected "spy" to not be called at all, but actually been called 1 times
  1st spy call: Array [ 0 ]
 ❯ src/ui/__tests__/resultsPanel.test.ts:1983:33

 FAIL  src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — BQ-03.4 BigQuery states > #4 — token-less statement (batched: false): loadMore is a silent panel-level no-op; no runner call, no busy state, state re-posted unchanged
AssertionError: expected "spy" to not to be called at all, but actually been called 1 times
  1st spy call: Array [ 0 ]
 ❯ src/ui/__tests__/resultsPanel.test.ts:2025:33

 FAIL  src/ui/__tests__/resultsPanel.test.ts > ResultsPanel — BQ-03.4 BigQuery states > #6 — render() during an in-flight loadMore does not let the stale completion overwrite the newer lastResults
AssertionError: expected 1 to be 99 // Object.is equality
 ❯ src/ui/__tests__/resultsPanel.test.ts:2134:56

 Test Files  1 failed (1)
      Tests  3 failed | 49 passed (52)
```

Tests #1, #2, #5, #7 already passed against base (they pin wire-shape
preservation which the `...r` spread in `sanitizeStatementResult` already
guarantees — the field is additive and flows through). The 3 RED tests
(targets of the new gate + generation guard) failed as expected: the
panel was calling `runner.loadMore` unconditionally (#3, #4) and the
loadMore completion overwrote the newer render's `lastResults` (#6).

Verification Output:

```
$ npx vitest run src/ui/__tests__/resultsPanel.test.ts
 ✓ src/ui/__tests__/resultsPanel.test.ts  (52 tests) 435ms
 Test Files  1 passed (1)
      Tests  52 passed (52)

$ npm run typecheck
> UnicDB@1.49.0 typecheck
> tsc --noEmit
(clean exit, no output)

$ npx vitest run src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts
 ✓ src/ui/__tests__/resultsPanelRequery.test.ts  (15 tests) 10ms
 ✓ src/ui/__tests__/resultsPanelServerFilter.test.ts  (16 tests) 13ms
 Test Files  2 passed (2)
      Tests  31 passed (31)
```

Status: PASS
Note:
- Implementation adds a panel-level gate before `runner.loadMore`:
  when `stmt.batched === false` (BigQuery token-less) or
  `stmt.cursorClosed === true` (closed cursor), loadMore is a silent
  no-op — no runner call, no busy flip, no error toast, state re-posted
  unchanged. The existing ARP03-003 catch-path suppression is preserved
  for the synthetic limited-only throw case.
- Captures `statementGeneration` before the loadMore await and re-checks
  after every await: a render()/requery() that lands during the in-flight
  loadMore bumps the generation, and the stale completion is dropped
  (mirrors the requerySeq guard in handleRequery).
- `pending?: boolean` is read via the `...r` spread in
  `sanitizeStatementResult` — no explicit slot needed. Tests use
  `as unknown as StatementResult` casts since the field will be added to
  the base type by TASK-BQ03-003 (out of scope for this cycle).
- Files touched: `src/ui/resultsPanel.ts` (loadMore handler) and
  `src/ui/__tests__/resultsPanel.test.ts` (appended describe block; all
  existing describes untouched). `src/core/queryRunner.ts` and
  `src/extension.ts` not touched.

## Reviewer Verdict

REVIEWER_MODEL: unic-smart (per .ukit/storage/config.json handoff.reviewer.model)
EXECUTOR_MODEL: unic-code — differs from reviewer; isolation check OK
Verdict: Approved-with-minor
VERIFICATION_RERUN (fresh, reviewer-run):
  - npx vitest run src/ui/__tests__/resultsPanel.test.ts → 52 passed / 0 failed
  - npm run typecheck → exit 0
  - npx vitest run src/ui/__tests__/resultsPanelRequery.test.ts src/ui/__tests__/resultsPanelServerFilter.test.ts → 31 passed / 0 failed
TEST_PLAN_COVERAGE: all-followed — tests #1-#7 implemented as pinned; RED_OUTPUT is genuine vitest failure output (3 real assertion failures: loadMore-called-once twice, rows-resurrected 1≠99); ≥2 heterogeneous edge cases (#4 token-less, #5 dispose/recreate, #6 mid-flight render).
FINDINGS:
  minor:
    - src/ui/resultsPanel.ts:780-784 — the `batched === false` token-less sentinel is unrepresentable in `StatementResult.batched?: BatchedQuery` (src/core/queryRunner.ts:54); BQ03-003 landed without the promised type widening, so the panel keeps an `as unknown` cast and tests cast literals. Safe today (no host producer emits `false`; the real BQ EOF path surfaces as `cursorClosed: true`, which the gate catches). Follow-up: widen the type so the sentinel is type-safe.
    - src/ui/resultsPanel.ts:855-864 — the finally's new `generation === this.statementGeneration` condition delegates the busy clear to whoever caused the generation bump. Verified safe today (every render/requery source pairs with an actor that clears busy: extension run lifecycle at src/extension.ts:2113, requery finally at resultsPanel.ts:2046), but a future render source without a busy owner would strand busy=true. Add one sentence to the finally comment naming that contract.
    - PLAN.md Interfaces says 03.4 "reads result.pending === true" — implemented as wire passthrough only (sanitize `...r` spread, no explicit host read). This matches the task's own Discussion #4 postMessage-boundary scope and tests #1/#2 pin the acceptance criterion; recorded so the follow-up cycle owns the actual webview visual.
SCOPE: footprint is exactly the loadMore hunk in src/ui/resultsPanel.ts + one appended test describe (existing 45 tests untouched); queryRunner.ts/extension.ts changes in the cycle diff belong to BQ03-003/005; no formatBigQueryCell wiring in the panel; `pending` is optional, sanitized, undefined on every non-BQ path (no wire break).
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Gate, generation guard, and epoch guards are correct and test-pinned; busy-clear delegation in the finally is sound under every current render source. Minors are type/doc hygiene for a follow-up; none blocking.
