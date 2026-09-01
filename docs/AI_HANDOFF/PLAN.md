# Cycle ARP-03 Plan — Retained-Result Memory Budget

Base: `main` @ `f17cc6f` (release v1.38.0). Source roadmap (authoritative): `docs/plans/2026-09-01-vsdb-additive-roadmap.md` → `## ARP-03` (lines 153-191).

## §1 Intent

**Problem.** `QueryRunner.loadMore()` appends every fetched batch to `result.rows` with no retained-row or byte ceiling, and `appendBatch()` allocates a fresh larger array each time. Cursor streaming bounds *initial retrieval* and webview virtualization bounds *DOM*, but neither bounds **extension-host retention** — a user can click Load More until the host heap holds the full unbounded result.

**Success definition.** The extension host retains at most a documented, conservative number of rows per statement; retained rows are a deterministic prefix (never a shuffled/mid-stream slice); the cap is enforced by closing the batched cursor exactly once and performing no further fetch; the user sees a distinct "result truncated" state that is **not an error** (no failure toast) and **not false EOF** (not presented as the full result); results that never approach the cap behave byte-for-byte as today.

**In scope.**
- Explicit conservative retained-row cap (`RETAINED_ROW_CAP`), deterministic prefix retention, no input mutation.
- Runner enforcement: at the cap, close the cursor once, stop fetching, mark the statement `resultLimited`; later `loadMore` on a limited statement is a graceful no-op (no throw).
- Panel state: a limited statement posts its `resultLimited` marker on the wire and suppresses the "Load more failed" error notification.
- Webview UX: distinct, accessible truncated copy in the grid footer, distinct from empty / EOF / cancel; Load More gate disabled for limited statements.

**Out of scope.** Server-side pagination redesign; exact JavaScript heap accounting (byte cap is not enforced — row cap is the deterministic primary gate; see §3); full-result auto-export; changing the default batch size; touching the adapter layer, `extension.ts`, or `connectionManager.ts`.

## §2 Scope

| Task | Owned files | Wave | Depends on |
|---|---|---|---|
| TASK-ARP03-001 — pure budget helper | `src/core/resultBatcher.ts` (+ its test) | 1 | none |
| TASK-ARP03-002 — runner enforcement | `src/core/queryRunner.ts` (+ its test) | 2 | TASK-ARP03-001 |
| TASK-ARP03-003 — panel state | `src/ui/resultsPanel.ts` (+ its test) | 3 | TASK-ARP03-002 |
| TASK-ARP03-004 — webview UX | `webview/main.ts` + `src/ui/__tests__/webviewResultLimit.test.ts` (new) | 3 | TASK-ARP03-002 |

**Same-wave file disjointness.** Wave 3 pairs TASK-ARP03-003 (`resultsPanel.ts`, `resultsPanel.test.ts`) with TASK-ARP03-004 (`webview/main.ts`, new `webviewResultLimit.test.ts`) — no shared file. Wave 1 and wave 2 are single-task waves.

Out of scope for this cycle (queued portfolio rows, not planned): ARP-04 (tunnel/endpoint identity), ARP-05 (cross-driver resilience), ARP-06 (AI policy/usage), ARP-07 (DDL cache invalidation), ARP-08 (console draft recovery, depends on ARP-03), ARP-09 (diagnostics/profiles).

## §3 Approach

**Design in one paragraph.** 03.1 adds a pure, constant-free helper to `resultBatcher.ts` — `appendBatchBounded(current, batch, maxRows)` — that returns `{ rows, limited }` where `rows` is the deterministic prefix of `current ++ batch` up to `maxRows`, never mutating its inputs. 03.2 owns the cap constant (`RETAINED_ROW_CAP = 10_000`, exported from `queryRunner.ts`) and wires the helper into `loadMoreImpl`: on a truncation it closes the batched cursor exactly once (`cursorClosed = true`, best-effort idempotent close), sets a new optional `StatementResult.resultLimited` field, and keeps `rowCount` at the retained length (`rows.length`). A later `loadMore` on a limited statement returns the unchanged results (graceful no-op) instead of throwing — so the limit is neither an error nor false EOF. 03.3 makes the panel honor the marker: the loadMore error path suppresses the "Load more failed" toast when `lastResults[index].resultLimited` is set, pins that `resultLimited` survives sanitize on the `state` wire post, **and owns the save-refresh leak pin** — `handleSaveEdits` (`src/ui/resultsPanel.ts:1242`) and `refreshManualStatement` (`:674`) build the refreshed statement as `{ ...r, result, batched, durationMs }`, which would copy `resultLimited` AND `cursorClosed` (both set by 002) onto a FRESH open cursor; both paths must strip the two fields so the fresh cursor stays reachable by `loadMore` and by `run()`'s stale-cursor sweep (`src/core/queryRunner.ts:177-187`). `handleRequery` (`:1880`) already builds fresh without `...r` and is the only correct model. 03.4 renders it: the webview statement mirror gains `resultLimited`, the grid model sync passes `hasMore = !!r.batched && !r.resultLimited` (so scroll/hook Load More gates close), and the footer shows distinct truncated copy that **replaces** `footerText`'s output entirely — `updateFooter` short-circuits on `r.resultLimited` before composing `footerText(...)`, so the copy wins over `footerText`'s `N of N` total branch (`src/ui/resultsGridModel.ts:414-416`) and never appends onto a count.

**Dependency decision (03.2 → 03.1, wave 2).** The prompt offered two options for the pure budget logic: 03.2 consumes 03.1's exported helper (wave 2 dependency) or 03.2 inlines a tiny local cap constant. Chosen: **consume the helper**. The truncation semantics — deterministic prefix, no input mutation, correct `limited` flag at and past the boundary — are non-trivial and must be unit-tested once in the pure module; duplicating a `slice()`-and-flag approximation inside the runner would fork the logic and leave 03.1's helper dead code. 03.2 still owns the cap *constant* (the pure helper is constant-free so it is testable across any boundary). This makes the first two waves a chain; the fork at wave 3 restores parallelism (2 tasks). The chain is a real dependency (03.2 imports a symbol 03.1 creates; 03.3/03.4 test behavior 03.2 produces), not an ordering preference.

**Cap value & byte-cap decision.** `RETAINED_ROW_CAP = 10_000` — conservative and driver-independent. 500-row default batches reach it in 20 Load More clicks; 10k rows × typical cell widths are a small fraction of the extension-host heap while keeping the webview's `rowsToObjects` materialization bounded. The roadmap's "retained-row **and/or** estimated-byte cap" is satisfied by the row cap as the deterministic primary gate. The estimated-byte branch is **rejected for the primary gate** because per-cell byte cost is data- and driver-dependent (BigInt vs string vs nested object) and would make the cap non-deterministic; the copy/allocation trade-off of the prefix truncation (one fresh array of ≤ `maxRows`, references copied, inputs untouched) is the review item. The byte-cap option is recorded as a deferred follow-up in §2/§7, not implemented — no dead helper.

**Composition with ARP-02 cancel ownership (must-not-break).** `loadMoreImpl` already snapshots `cancelSeq` before the `fetchBatch` await and re-checks after (discarding a late batch when the cancel sequence advanced). 03.2 runs the budget check **after** that re-check, so a cancel landing mid-fetch (a) discards the batch, (b) closes the cursor via the ARP-02 cancel path (delivered-once guard → exactly one close), and (c) never sets `resultLimited` — the limit close and the cancel close are mutually exclusive by ordering. The ARP-02 entry guard (`cancelRequested && cancelPending`) is unchanged; the new limited-entry guard (`if (r.resultLimited) return this.results.slice()`) is checked **before** the existing `cursorClosed` throw so a limited statement never surfaces the "run this statement alone" error. `appendBatch`, `batchStats`, and `mergeBatchIntoResult` are left untouched (still used / kept for API stability) — the bounded helper is purely additive.

**Rejected alternatives.** (a) Byte-based cap as primary gate — rejected (non-deterministic, data-dependent). (b) Evicting *old* rows to keep the newest `N` — rejected: the roadmap requires deterministic **prefix** retention so streamed appends and grid `__rowId`-anchored identities stay stable. (c) Throwing a dedicated `LimitReachedError` on later `loadMore` — rejected: acceptance requires the limit to be "neither an error nor false EOF"; a graceful no-op returning unchanged rows is the honest contract. (d) Relying on the panel to swallow the existing `cursorClosed` throw — rejected: that couples the panel to an error-shaped path; the graceful no-op at the runner is cleaner and the panel suppression is kept only as belt-and-braces for defensive/stale throw paths.

**Webview test convention (verified at commissioning).** `webview/__tests__/` does NOT exist; the established convention for `webview/main.ts` behavior is the jsdom bundle suite under `src/ui/__tests__/webview*.test.ts` (e.g. `webviewBundle.test.ts`), which loads `dist/webview.js` (built by `npm run compile`), stubs `acquireVsCodeApi`/`ResizeObserver`/`matchMedia`, dispatches `state` messages, and asserts DOM. TASK-ARP03-004 therefore owns a NEW file `src/ui/__tests__/webviewResultLimit.test.ts` following that convention, and its verification runs `npm run compile` **before** the focused vitest run. This is stated explicitly because the tests-map entry for `webview/main.ts` is empty.

## §4 Test Plan

Test-first (RED) is mandatory per task. All cases below are per-task slices with concrete expectations.

### ARP-03.1 — pure budget (`resultBatcher.ts`)

| Type | Test name | Expected |
|---|---|---|
| happy | under-budget append keeps all rows | `appendBatchBounded([[a],[b]],[c,d],100)` → `rows` length 4, `limited === false`, order `a,b,c,d` |
| edge: boundary | exact cap is not limited | current 3 + batch 2, `maxRows = 5` → `rows` length 5, `limited === false` |
| edge: oversized | oversized next batch retains deterministic prefix, inputs unmutated | current 3 + batch 5, `maxRows = 5` → `rows` length 5 = first 3 of current + first 2 of batch; `limited === true`; both `current` and `batch` deep-equal their inputs after the call |
| edge: zero/negative/NaN cap | `maxRows = 0` (or negative, or NaN) → `rows === []`; `limited === true` when any input row exists, `false` when both inputs empty | deterministic, no throw |
| edge: empty inputs | `current=[]`,`batch=[]` → `rows=[]`,`limited=false`; `current=[]`,`batch=2 rows` → `rows=batch`,`limited=false` | |
| edge: current already at cap | current length 5, batch 3, `maxRows = 5` → `rows` = first 5 of current only, batch contributes nothing, `limited === true` | |

### ARP-03.2 — runner enforcement (`queryRunner.ts`)

| Type | Test name | Expected |
|---|---|---|
| happy (regression pin) | smaller result unchanged | batched total rows « RETAINED_ROW_CAP fetched across several `loadMore` → all rows appended, `resultLimited` undefined, cursor stays open, EOF at `null` behaves as today; `batched.close` NOT called |
| edge: boundary | exact cap reached across batches is not limited | batches sum to exactly `RETAINED_ROW_CAP` → `resultLimited` undefined, cursor still open, `close` not called, a following EOF `loadMore` returns unchanged |
| edge: oversized | next batch crosses the cap → capped prefix, close once, no future fetch | rows at `RETAINED_ROW_CAP - 2`, batch of 3 → `result.rows.length === RETAINED_ROW_CAP`, prefix equals current rows + first batch row; `resultLimited === true`; `cursorClosed === true`; `batched.close` called exactly **1x**; `batched.fetchBatch` NOT called again |
| edge: idempotent no-op | `loadMore` on a limited statement is a graceful no-op | second `loadMore` after `resultLimited` set → resolves with unchanged rows (no throw), `batched.close` still exactly **1x** total, `batched.fetchBatch` call count frozen |
| edge: concurrent cancel wins | cancel during the cap-crossing `loadMore` discards the batch | deferred `fetchBatch` resolves with an oversized batch **after** `cancel()` → rows unchanged (no append), `resultLimited` undefined, cursor closed exactly once (by the cancel path), no unhandled rejection |

### ARP-03.3 — panel state (`resultsPanel.ts`)

| Type | Test name | Expected |
|---|---|---|
| happy | limited statement rides the wire | render a done statement with `resultLimited: true` → every `state` post carries `resultLimited: true` on that statement (survives `sanitizeStatementResult`); no `showErrorMessage` during render |
| edge | save/refresh of a limited statement clears the markers (leak pin) | render a limited statement (`resultLimited: true`, `cursorClosed: true`), drive the save-refresh / manual-commit refresh path (`handleSaveEdits` `:1242` or `refreshManualStatement` `:674`) with `runSql` resolving a fresh result → the refreshed statement in the `state` post has `resultLimited` absent/falsy AND `cursorClosed` falsy (fresh cursor reachable by `loadMore` + the stale-cursor sweep); a following `loadMore` dispatch reaches the runner stub. RED on base: the `{ ...r }` spread copies `resultLimited: true`/`cursorClosed: true` onto the fresh cursor |
| edge (unit-level, defensive) | loadMore rejection on a limited statement is silent at the panel boundary | with `lastResults[index].resultLimited === true`, a stub `loadMore` that REJECTS → **no** "Load more failed" toast (limited branch mirrors the cancel branch `:760-778`); a `state` post reposts `lastResults`. Labeled defensive/unit-level: the real runner never rejects for a limited statement (002's entry guard no-ops first) — this pins the panel's own branch via a synthetic rejecting stub, reachable only at the panel boundary |
| edge (regression pin) | genuine loadMore error on a non-limited statement still toasts | runner `loadMore` rejects (`connection refused`) with `resultLimited` absent → "Load more failed: connection refused" toast fires exactly once |

### ARP-03.4 — webview UX (`webview/main.ts`)

| Type | Test name | Expected |
|---|---|---|
| happy | limited state shows distinct truncated copy that REPLACES footerText (precedence) | dispatch `state` with a done statement `{ batched: true, resultLimited: true, rowCount: 20, rows: 20 }` (total known, mimics 002's `rowCount = rows.length`) into `dist/webview.js` (jsdom bundle harness) → `.vsdb-grid-footer` contains the truncation copy AND does NOT match `/\d+ of \d+/` (no "20 of 20" — `updateFooter` short-circuits on `resultLimited` before `footerText`'s total branch at `src/ui/resultsGridModel.ts:414-416`); `.vsdb-error` absent. RED on base: footer shows "20 of 20" with no truncation marker |
| edge | distinct from EOF | done statement `{ batched: false, rowCount: 20 }` (EOF) → footer is plain footerText output, NOT the truncation copy |
| edge | distinct from empty | empty `results` → `.vsdb-empty` "No results yet." placeholder, NOT the truncation copy |
| edge | distinct from cancel (re-anchored) | a cancelled statement `{ status: "cancelled" }` has NO `result` → `renderGrid` returns early (`webview/main.ts:1634-1640`) and `updateFooterNow` blanks the footer (`:3274-3277`), so there is NO footer to assert. Assert instead: truncation marker appears NOWHERE, and the cancelled tab badge `⌀` renders (`tabBadge`, `:1089`; `.vsdb-tab-cancelled` class, `:1120`) — or the `.vsdb-msg-card.vsdb-msg-cancelled` card with `CANCELLED` title on the messages tab (`:3296-3300`) |
| edge: gate | limited statement never posts loadMore (rowCount: null) | after a limited state with `rowCount: null` (total unknown — `resultsGridModel.ts:325` EOF branch cannot close `hasMore`), invoking `__vsdbCheckLoadMoreForHost` posts **no** `loadMore` — only `resultLimited` closes the gate in this shape |
| edge: gate regression | non-limited streaming still load-mores | done statement `{ batched: true, resultLimited: false, rowCount: null }` → the same hook **does** post a `loadMore` message (streaming unchanged) |

## §5 Verification Commands

Repository scripts (verified in `package.json`): `test` (`vitest run`), `test:integration` (DB-gated — NOT used here), `typecheck` (`tsc --noEmit`), `compile` (`node esbuild.js`), `package` (release gate — not used). **No `lint` script exists** (roadmap §portfolio constraint: "No lint script exists"); typecheck + compile are the static gates. There is no `yarn` and no `test:release-core` script in this npm repo — the RULES.md "test selection" floor's `yarn test:release-core` is satisfied here by the focused vitest runs below plus the mandated full `npm test` on TASK-ARP03-003.

Per-task:

```bash
# TASK-ARP03-001
npx vitest run src/core/__tests__/resultBatcher.test.ts
npm run typecheck
npm run compile

# TASK-ARP03-002  (queryRunner.ts → tests-map [queryRunner.test.ts, queryRunner.integration.test.ts];
#                  integration is DB-gated/excluded — the unit file is the pinned target)
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck
npm run compile

# TASK-ARP03-003  (full suite mandated for at least one task — this is it)
npx vitest run src/ui/__tests__/resultsPanel.test.ts
npm run typecheck
npm run compile
npm test

# TASK-ARP03-004  (jsdom bundle test — dist/webview.js must exist first; tests-map has no
#                  webview/main.ts entry; repo convention is the src/ui/__tests__/webview*.test.ts suite)
npm run compile
npx vitest run src/ui/__tests__/webviewResultLimit.test.ts
npm run typecheck
npm run compile
```

## §6 Acceptance Criteria

- [ ] A documented, conservative retained-row cap bounds host retention per statement, and retained rows are a deterministic prefix. → TASK-ARP03-001 (pure helper), TASK-ARP03-002 (cap + wiring).
- [ ] At the cap the runner closes the cursor **once**, performs **no further fetch**, and is **neither an error nor false EOF** (later `loadMore` is a graceful no-op). → TASK-ARP03-002.
- [ ] Concurrent cancel wins over the budget close (cancel during a cap-crossing fetch discards the batch; the limit close and the cancel close are mutually exclusive). → TASK-ARP03-002.
- [ ] Results that never approach the cap are unchanged (byte-for-byte prior behavior). → TASK-ARP03-002 regression pin.
- [ ] The limited state reaches the webview with no error notification (toast suppressed; `resultLimited` on the wire). → TASK-ARP03-003.
- [ ] The marker never leaks onto a fresh cursor: a save/refresh of a limited statement posts a refreshed statement with `resultLimited`/`cursorClosed` stripped, so the new cursor stays reachable by `loadMore` and the stale-cursor sweep. → TASK-ARP03-003.
- [ ] The webview shows a distinct truncated explanation that REPLACES `footerText`'s output (wins over the `N of N` total branch), distinguishable from empty / EOF / cancel (cancel anchored to the `⌀` tab badge / `.vsdb-msg-cancelled` card — a cancelled statement renders no footer), and its Load More gate is disabled. → TASK-ARP03-004.
- [ ] Focused tests + `npm run typecheck` + `npm run compile` green; full `npm test` green on TASK-ARP03-003 (release-boundary net). → all tasks.
- [ ] Performance review (reviewer) checks the copy/allocation trade-off of the prefix truncation; manual check: load substantially beyond the cap on each driver — panel stays responsive and a subsequent query succeeds. → review gate.

## §7 Global Constraints

- TypeScript 5.4 / VS Code `^1.75.0` compatibility; no new dependencies; keep the ES2018-era `any[][]` row model (`QueryResult.rows`).
- Preserve existing batched contract: `BatchedQuery.fetchBatch(): Promise<any[][] | null>` (`null` = EOF); `close()` is best-effort idempotent; `cancel()` delivered-once per in-flight cursor.
- Do NOT change default `batchSize` (500) — the cap is additive and independent of batch size.
- Do NOT touch adapter files, `extension.ts`, `connectionManager.ts`, `src/ui/messages.ts`, or `src/ui/resultsGridModel.ts` in this cycle (file ownership per §2); `StatementResult` type changes are additive (`resultLimited?: boolean`) only.
- Same-wave tasks must not share a file (see §2); the executor must not open files owned by a different task.
- The `{ ...r }` spreads that build a FRESH statement — `handleSaveEdits` (`src/ui/resultsPanel.ts:1242`) and `refreshManualStatement` (`:674`) — must NOT carry `resultLimited`/`cursorClosed` onto the new cursor (destructure them out); `handleRequery` (`:1880`) builds fresh without `...r` and is the only correct model.
- No `lint` script exists — do not invent one; static gates are `typecheck` + `compile`.
- Row-cap-only primary gate; byte-level heap accounting is out of scope (deferred, recorded in §2/§3).

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit (P2 revision — Round 1 review findings applied): (1) added the save-refresh marker-leak pin to §4 ARP-03.3 and TASK-ARP03-003 — `{ ...r }` spreads in `handleSaveEdits`/`refreshManualStatement` would copy `resultLimited` + `cursorClosed` onto a fresh cursor; both must strip the fields (requery is exempt). (2) Re-anchored §4 ARP-03.4 "distinct from cancel" to the cancelled tab badge `⌀` / `.vsdb-msg-cancelled` card — a cancelled statement has no `result`, so no footer exists to assert against. (3) Spelled out the precedence rule: the truncation copy REPLACES `footerText`'s output, winning over the `N of N` total branch. (4) Dropped the redundant `retained` field from the `appendBatchBounded` result across §3/§4 and TASK-ARP03-001/002 (runner derives `rowCount = rows.length`); re-worded 003's defensive-toast case as an explicit unit-level panel-boundary contract. Traced every revised §6 criterion to its task; verified all new source anchors (`resultsPanel.ts:674,1242,1880`, `queryRunner.ts:177-187`, `webview/main.ts:1086-1091,1634-1640,3248-3277,3296`, `resultsGridModel.ts:404-421`) against the current files.
Known gaps: The save-refresh leak-pin test (003 case 4) requires driving the panel's save/commit flow (stub `runSql`/`beginTransaction`/`transaction.commit`; precedent at `resultsPanel.test.ts:1449-1496`) — the highest-stubbing test in the cycle, but the marker-clear assertion is load-bearing: a leaked marker silently disables Load More on a healthy cursor and pins the max=1 pool client. The webview "Load More gate disabled" check relies on the `__vsdbCheckLoadMoreForHost` test hook (existing convention, verified at `webview/main.ts:2116-2127`) — if the executor refactors that hook, 03.4's gate cases need re-anchoring. The batch-close-once and cancel-vs-limit mutual-exclusion cases depend on ARP-02's delivered-once guards being present in `queryRunner.ts`; they are (verified in the current file), and the plan pins them as the load-bearing seam. No test covers byte-level heap accounting — deliberately out of scope (row cap is the deterministic primary gate).

## Planner Report

PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 2 — all Round 1 findings verified resolved; advisory nits only)

## Plan Review Log

### Round 1 — 2026-09-02 · code-reviewer (unic-smart)
Status: Issues Found

VERDICT: Issues Found — design is sound and source-verified; two important findings are small plan amendments, not structural changes.

COMPLETENESS:
- (important) ARP-03.3 has no test for the save-refresh / requery path, but `resultLimited` will leak onto a FRESH cursor there. `handleSaveEdits` (`src/ui/resultsPanel.ts:1242-1250`) and `refreshManualStatement` (`src/ui/resultsPanel.ts:674-679`) build the refreshed statement as `{ ...r, result: freshResult, batched: refreshed.batched }`. For a limited statement, 002 sets `r.resultLimited = true` AND `r.cursorClosed = true`; the `...r` spread copies both onto a statement whose cursor is NEW and open. After `adopt()` installs it, a later `loadMore(index)` hits the new limited-entry guard and silently no-ops (gate closed on a healthy cursor), and `cursorClosed=true` excludes it from the run() stale-cursor sweep (`src/core/queryRunner.ts:177-187`) so the fresh cursor is never drained/closed and pins the max=1 pool client. `handleRequery` builds `newStmt` WITHOUT `...r` (`src/ui/resultsPanel.ts:1880-1887`), so requery naturally clears the marker — the save paths must be pinned to drop `resultLimited` (and re-derive `cursorClosed`) too. Add an ARP-03.3 test: save-edits refresh of a limited statement must post a refreshed statement with `resultLimited` absent and `loadMore` working on the new cursor.

CONSISTENCY:
- (confirmed, no change) The 03.2 ordering claim is sound: the budget check runs after the cancelSeq post-await re-check (`src/core/queryRunner.ts:403-405`) with no await between them, so a mid-fetch cancel always discards via the re-check before the limit check runs — no window where both the cancel close and the limit close fire. The `cancelRequested && cancelPending` entry guard is untouched (`queryRunner.ts:385`), and `concurrent cancel wins` IS specified as §4 ARP-03.2 "edge: concurrent cancel wins" + §6 criterion 3.

CLARITY:
- (important) ARP-03.4 "edge: distinct from cancel" (`{ status: "cancelled" }`) is not implementable as written. A cancelled statement has no `result`, so `renderGrid`'s `!r.result` branch (`webview/main.ts:1634-1640`) returns before rendering any footer and sets `currentStatement(null)`; `updateFooterNow` (`webview/main.ts:3274-3277`) then blanks the footer. There is no "existing cancelled copy" in the footer to assert against — the assertion would fail for the wrong reason. Re-anchor it to the cancelled tab badge (`⌀`, `webview/main.ts:1089`) or the messages-tab cancelled card (`webview/main.ts:3296`), or give the fixture a `result` and verify the footer path actually renders for a cancelled statement.
- (minor) The plan does not state that the footer truncation copy takes precedence over `footerText`'s `total != null` branch. 002 sets the limited statement's `rowCount` to the retained length (10 000), which makes `footerText` render "10000 of 10000" (`src/ui/resultsGridModel.ts:401-413`) unless `updateFooter` in `webview/main.ts:3248-3267` short-circuits on `resultLimited` first. Implementable (main.ts is owned by 004) but the precedence should be spelled out so 004 does not append truncation copy onto an existing count.

SCOPE:
- none. Wave 1 → 001, wave 2 → 002, wave 3 → 003 + 004 are file-disjoint (003 owns `resultsPanel.ts` + test, 004 owns `webview/main.ts` + new `webviewResultLimit.test.ts`); no shared file. The webview jsdom-bundle convention claim is REAL and verified: `src/ui/__tests__/webviewBundle.test.ts` loads `dist/webview.js`, stubs `acquireVsCodeApi`/`ResizeObserver`/`matchMedia`, dispatches `state`, asserts DOM, and requires `npm run compile` first; `webview/__tests__/` does NOT exist. `resultLimited` rides the wire via `sanitizeStatementResult`'s `...r` spread (`src/ui/resultsPanel.ts:2152-2165`); `StateMessage.results` is core `StatementResult[]` (`src/ui/messages.ts:25`), so the additive `resultLimited?: boolean` needs no `messages.ts` change. Cap-boundedness holds: post-truncation retention is exactly `RETAINED_ROW_CAP`; a single cap-crossing loadMore holds at most one extra ~500-row batch + the pre-truncation merged array transiently.

YAGNI:
- (minor) `appendBatchBounded`'s `retained` field is always `rows.length` and is consumed only by tests — harmless, but redundant API surface.
- (minor) ARP-03.3's "loadMore error on a limited statement is silent" test can only fire against a synthetic rejecting mock: the runner's limited-entry guard makes `loadMore` a no-throw no-op, so the panel's suppression branch is defensive-only. Fine as belt-and-braces, but the test pins code the real runner cannot reach — keep it clearly labeled as defensive.
- No roadmap out-of-scope item crept back in: byte-cap is explicitly deferred and recorded (§2/§3), no dead helper, no batch-size change, no adapter/extension/connectionManager touch.

NOTES: Verified Q1-Q5 against current source (`resultBatcher.ts:15-21`, `queryRunner.ts:341-429,463-506`, `resultsPanel.ts:674-679,1242-1250,2152-2165`, `webview/main.ts:1634-1640,2116-2127,3248-3277`). The two important findings are test/edge amendments (refresh-path marker leak, cancelled-fixture anchor), not redesigns.

### P2 revision (planner) — 2026-09-02
PLANNER_REVISION: Round 1 findings applied — (1) TASK-ARP03-003 now owns the save-refresh leak pin: `handleSaveEdits`/`refreshManualStatement` must strip `resultLimited`+`cursorClosed` from the `{ ...r }` spread so a fresh cursor is never gated (requery exempt); test + acceptance added; (2) ARP-03.4 "distinct from cancel" re-anchored from the non-existent cancelled footer to the `⌀` tab badge / `.vsdb-msg-cancelled` card; (3) truncation copy precedence over `footerText`'s "N of N" spelled out in §3/§4/§6 + 004's Interfaces/Discussion; (4) redundant `retained` field dropped from the batcher result (001/002 updated), and 003's defensive-toast case re-worded as an explicit unit-level panel-boundary contract.

### Round 2 — 2026-09-02 · code-reviewer (unic-smart)
VERDICT: Approved

Round 1's four findings verified as GENUINELY resolved — confirmed in both PLAN.md and the task files, and the load-bearing source anchors re-verified against the current code:

COMPLETENESS:
- Leak pin is now a first-class ARP-03.3 deliverable: Goal (strip both markers), RED case 4, test case 4 (AUTO + manual-commit fixtures, assert LAST state post), acceptance, Interfaces code snippet, Discussion rationale. Anchors confirmed: resultsPanel.ts:674 and :1242 both build `{ ...r, result, batched, durationMs }`; :1880 builds fresh without `...r` — the "requery exempt / only correct model" claim is accurate.
- `retained` field gone everywhere: PLAN §3/§4, 001 (Goal/Interfaces/Discussion: "cut at review"), 002 (rowCount = rows.length, no separate field). Defensive-toast case re-worded as unit-level/panel-boundary in PLAN §4 + 003 case 2 + Discussion.
CONSISTENCY:
- Cancel re-anchor consistent across PLAN §4/§6/self-audit and 004 (case 5, Discussion): cancelled statement has no `result` → no footer to assert; anchored to `⌀` tab badge (:1089/:1120) or `.vsdb-msg-cancelled` card (:3296). Precedence rule consistent across PLAN §3/§4/§6 and 004 Goal/Interfaces/Discussion (short-circuit BEFORE `footerText`, "REPLACES" never appends).
- Ordering claims verified in source: cursorClosed throw at queryRunner.ts:368-370 (limited guard must precede), cancelSeq re-check at :403-405 discards late batches before the budget check, bare `appendBatch` at :414 is the replacement point, stale sweep at :177-187 excludes `cursorClosed` entries (leak consequence is real).
CLARITY:
- RED expectations and fixtures concrete and implementable; precedence and re-anchored cancel are spelled out to assertion level (no `/\d+ of \d+/`, badge class names).
SCOPE:
- File ownership per §2 holds; wave-3 pair 003/004 stays file-disjoint; out-of-scope list intact.
YAGNI:
- (nit, advisory) 002's `QueryRunnerOptions.maxRetainedRows?: number` option is not consumed by any test in the cycle (cases build `RETAINED_ROW_CAP`-sized sequences via the real constant). Harmless + additive + defaulted, but drop it in the implementation if it ends up unused.
- (nit, advisory) 003 case 4 references "the case-7/8 `saveContext` stub" inside existing resultsPanel.test.ts — fragile cross-reference if those cases renumber; the manual-commit fallback (:1449-1496) is already documented.
- (nit, advisory) 003's destructure strips `cursorClosed` off `StatementResult`; this requires `cursorClosed` to remain a real top-level statement field (it is, per queryRunner.ts:368) — 002 must not make it internal-only.

NOTES: Round 1 issues are genuinely fixed and re-verified; remaining items are advisory nits only. Loop cap reached — Approved.
