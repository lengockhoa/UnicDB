# PLAN_ARP02 — Shutdown-safe query ownership and connection provenance

Source: `docs/plans/2026-09-01-vsdb-additive-roadmap.md` §ARP-02 (P0; deps RLX-02 v1.31.0 + ARP-01 v1.37.0 both released).
Base: `main @ 367cb80` (v1.37.0). Executor: `unic-code`. Reviewer: `unic-smart`.
Full-suite baseline: **2963 passed | 2 skipped** (from `npm test`).

## §1 Intent

**Problem.** Disposal is intentionally uneven: ResultsPanel rolls back manual transactions on close
(`src/ui/resultsPanel.ts:277-285`), Console aborts autocomplete (`src/ui/consolePanel.ts:178-186`),
extension deactivation disposes panels/resources (`src/extension.ts:1012-1040`). Lifecycle seams exist —
they do NOT prove a query leak exists. This cycle proves by **fault-injection** that no query leak exists
across close / deactivate / connection-change races, and fixes the leaks the injection exposes.

**Success.** (1) One idempotent live-work ownership model during panel close/deactivate — cancellation
and cleanup are exactly-once, best-effort, and never use shared adapter/pool close as the cancellation
mechanism; (2) late completion can never render, clear busy, or emit an error to a disposed or
different-connection UI; (3) connection switch/edit/delete never lets a stale A-connection resource be
installed or reused as B's (or as anything after A is gone); (4) a concurrency review maps every deferred
settlement timeline with no unhandled promise path.

**Confirmed RED (empirically probed on 367cb80, probe files created and deleted, no src/ change left):**
- ARP-02.1 (queryRunner): double `cancel()` on an in-flight **non-batched** run fires the adapter seam
  TWICE (`cancelActiveQuery` spy 2x vs expected 1x — cancel is not idempotent for the seam branch).
- ARP-02.1 (queryRunner): a close-origin `cancel()` on an **idle** runner (run already settled) poisons a
  later `loadMore` — `loadMore` throws `Statement 0 cancelled` on a healthy open cursor.
- ARP-02.1 (queryRunner): a `loadMore` already in flight when `cancel()` fires **appends its batch after
  cancel settles** (`rows [[1],[42]]` vs expected `[[1]]` — late settle mutates a cancelled state).
- ARP-02.2 (resultsPanel): dispose during a deferred `loadMore`, then `render()` recreates the panel — the
  stale completion posts the OLD results into the NEW panel and clears the new session's busy state
  (posting a `state` with old SQL into the recreated panel; no session-lifetime guard exists).
- ARP-02.3 (connectionManager): `getAdapterFor(cX)` in flight while `deleteConnection(cX)` commits —
  the late candidate is re-installed into `passiveAdapters` and reused for a later request (factory not
  re-called; stale resource survives deletion).

**Verified GREEN (pin as regression, do NOT re-break):**
- `cancel()` batched→seam crossover is IMPOSSIBLE by construction: `activeAdapter` is cleared at
  `queryRunner.ts:195` (immediately after `runQuery` settles) BEFORE `currentBatched` is assigned at
  `:203`, so the PID window and the batched-cursor window never overlap. A double cancel on a **batched**
  in-flight run is already idempotent (probe passed).

## §2 Scope

**In**
- ARP-02.1 — runner ownership: idempotent `cancel()`; close-origin cancellation bounded to the run it was
  issued for; in-flight `loadMore` re-checks cancel after its `fetchBatch` await and drops the batch.
- ARP-02.2 — panel-close race: a session-lifetime guard on ResultsPanel so every deferred continuation
  (loadMore, requery, save, distinct, columnTypes, tx rollback) is inert after dispose; one cleanup only.
- ARP-02.3 — connection provenance: `getAdapterFor` late candidates cannot be installed after
  edit/delete/switch; no A resource/result attribution to B. Must NOT break the ARP-01 beginTransaction
  guard (`connectionManager.ts:652-689`) or RLX-03 ownership re-checks (`:525-537`, `:567-580`).
- ARP-02.4 — host integration: post-RLX-02 deactivate/command ordering and the `runStatements` busy
  lifecycle (extension.ts). Conditional gate — see §2 below.

**Out** (explicit, from roadmap)
- Reimplement RLX-02 adapter seams/cancellation; server kill SQL; pool closure used as cancellation.
- Public per-operation cancellation/operation IDs — unless the wave-1 audit proves no smaller design works
  (ARP-02.3 must prefer an internal per-connection revision or config re-validation; no public API).
- Shared adapter/pool close as the cancellation mechanism (acceptance item).

**Same-wave file disjointness (absolute)**
- Wave 1: ARP-02.1 owns `src/core/queryRunner.ts` (+ `src/core/__tests__/queryRunner.test.ts`).
  ARP-02.2 owns `src/ui/resultsPanel.ts` (+ `src/ui/__tests__/resultsPanel.test.ts`).
  ARP-02.3 owns `src/core/connectionManager.ts` (+ `src/core/__tests__/connectionManager.test.ts`).
  No file shared.
- **ARP-02.2 must NOT touch `src/extension.ts`.** The `runStatements` finally-busy leak and deactivate
  ordering are extension-host surfaces owned by ARP-02.4 (wave 2). ARP-02.2 only guards panel-*internal*
  continuations. If Wave 1 closes with no remaining host gap, ARP-02.4 closes as **not-needed** with
  evidence (mirrors TASK-ARP01-003's gate pattern).
- Wave 2: ARP-02.4 owns `src/extension.ts` (+ `src/extension.test.ts`) **only if a host gap is found**;
  otherwise closes as not-needed.

## §3 Approach

**ARP-02.1 — runner ownership (`queryRunner.ts`).** Three defects, three fixes:

1. **Seam idempotency.** `cancel()` (`queryRunner.ts:376-402`) fires `adapter.cancelActiveQuery()` on
   every call while `activeAdapter` is set. Fix: track that cancellation was already delivered for the
   current in-flight run — e.g. a `cancelDelivered` flag reset in `run()` (at the `cancelRequested`
   reset, `:127`) and set before the seam await, so a second `cancel()` returns without re-firing.
   The batched branch (`:378-391`) is already idempotent per run (verified) and must keep the seam
   exclusive.
2. **Close-origin cancel must not poison later work.** `cancelRequested` is set at `:377` and only reset
   at the START of the next `run()` (`:127`). A cancel delivered to an idle/settled runner therefore
   persists and makes a later `loadMore` throw at `loadMoreImpl:327`. Fix: bound the flag to the run —
   reset `cancelRequested = false` in `run()`'s `finally` (`:157-165`) as well as at entry, so a
   post-settle close-origin cancel is a no-op for later `loadMore` on an open cursor. Keep `loadMore`'s
   entry check but scope it to an in-flight run (executor chooses exact predicate; the RED test is the
   contract).
3. **Late settle cannot mutate a cancelled state.** `loadMoreImpl` (`:313-358`) checks `cancelRequested`
   only at entry (`:327`); a cancel during `fetchBatch` leaves the post-await append at `:334-351`
   unconditional. Fix: re-check `cancelRequested` after the `fetchBatch` await; if cancelled, close the
   cursor (idempotent) and return the pre-batch results (drop the batch), mirroring the post-await
   re-checks already in `executeAll` (`:206`, `:225`).

**ARP-02.2 — panel-close race (`resultsPanel.ts`).** `postMessage` already no-ops when `this.panel` is
null (`:435`); the leak is the RE-CREATED panel — after dispose + `render()`, `this.panel` is non-null
again, so a stale continuation posts old data and clears new busy. Fix: a **session epoch** on the panel,
bumped synchronously in `dispose()` (`:401-412`) and the `onDidDispose` handler (`:277-285`). Every
deferred continuation (loadMore `:692-721`, handleRequery `:1504`, handleSaveEdits `:837`, handleCommit
`:659`, handleRequestDistinctValues `:1295`, refreshColumnTypes `:532-576`, rollback→refreshManual
`:587-657`) captures the epoch at entry and re-checks after every await before `postMessage`/`setBusy`;
stale completions return silently (no post, no toast, no busy write). The existing `requerySeq`
(`:147`) / `statementGeneration` (`:163`) guards cover data staleness within a live panel; the epoch
covers panel lifetime. Exactly-once cleanup is already guaranteed by the `transaction === null` guard in
`rollbackOpenTransaction` (`:590-593`) — pin by test, do not regress.

**ARP-02.3 — connection provenance (`connectionManager.ts`).** `getAdapterFor` (`:343-374`) has NO
ownership re-check: it reads `cfg` at entry, awaits password/factory/testConnection, then
`passiveAdapters.set(cfg.id, adapter)` (`:372`) unconditionally. `editConnection` (`:190-255`) and
`deleteConnection` (`:260-286`) bump `activeGeneration` ONLY when the id is active (`:205-207`, `:267-269`),
so a passive in-flight `getAdapterFor` survives edit/delete of a non-active connection and re-installs a
stale adapter. Fix (no public API): capture an internal per-connection revision (bumped synchronously by
add/edit/delete before their first await, mirroring RLX-03's generation discipline) — or, the smaller
design, re-validate the captured cfg against the current persisted config after `testConnection`
(`connectionManager.ts` internal state) and discard/close the candidate when the config changed or the id
is gone (getAdapter's error style at `:567-580`). The ACTIVE path is already guarded (RLX-03 `:567-580` —
a slow `getAdapter()` for A after `setActive(B)` discards the stale candidate and throws "không còn
active") — pin as regression. Result attribution to the wrong connection at the UI is closed by ARP-02.2's
epoch + ARP-02.4's ordering; this task closes the resource (adapter/socket) provenance at the manager.

**ARP-02.4 — host integration (`extension.ts`, conditional).** Expected host gap from Wave 1:
`runStatements` (`:1689-1727`) does `panel.setBusy(true)` (`:1713`), awaits `runner.run(...)`, then
`finally { panel.setBusy(false) }` (`:1725`) — if the panel was disposed mid-run and a new run recreated
it, the old finally clears the NEW run's busy. Deactivate (`:1012-1040`) disposes panels without awaiting
in-flight runner work. The RLX-02 command path already awaits `runner.cancel()` before `setBusy(false)`
(`:476-486`) — preserved as a regression. **Gate:** if Wave 1 leaves no host gap (e.g. ARP-02.2's epoch
covers every continuation and the executor judges the busy leak fully closed at the panel), close 004 as
not-needed with `git diff` evidence; otherwise fix the ordering in `extension.ts`.

**Rejected alternatives.** Server kill SQL and pool-close-as-cancel (roadmap Out — destructive, shared,
not driver-agnostic). Public operation IDs (roadmap Out; ARP-02.3's internal revision/config-revalidation
is the smaller design). Reimplementing RLX-02's adapter seams (already shipped v1.31.0). A global "already
cancelled" latch in the runner (would break the per-run semantics the UI relies on — new run must start
uncancelled).

## §4 Test Plan

### ARP-02.1 — runner ownership (`src/core/__tests__/queryRunner.test.ts`; reuse `makeAdapter` :56-72, `makeBatched` :39-53, RLX-001 seam fixtures :616-840)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy (regression) | cancel active non-batched run once → seam once, status cancelled | `cancelActiveQuery` ×1; settle → `status === "cancelled"` (existing RLX-001 Test#1 stays green) |
| 2 | edge: idempotency | double cancel on non-batched in-flight run | seam exactly **1x** (RED today: 2x — probed) |
| 3 | edge: idempotency | double cancel on batched in-flight run | `batched.cancel` ×1, seam **never** (GREEN today — verified; pin) |
| 4 | edge: close-origin | cancel on idle/settled runner → later `loadMore` still works | after run done + cancel, `loadMore(0)` appends → rows `[[1],[2]]` (RED today: throws `Statement 0 cancelled` — probed) |
| 5 | edge: late settle | `loadMore` in-flight when cancel fires → batch NOT appended | rows stay `[[1]]` (RED today: `[[1],[42]]` — probed); cancelled cursor closed idempotently |
| 6 | edge: late settle | cancel mid-run; deferred `runQuery`/`fetchBatch` settle after → status stays cancelled, never done | regression pin on `executeAll` post-await re-checks (`:206`, `:225`) |

### ARP-02.2 — panel-close race (`src/ui/__tests__/resultsPanel.test.ts`; reuse FakeWebview/FakeWebviewPanel + `makeRunnerStub` :87-92)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | close idle panel → exactly-once cleanup, no message | `dispose()` + `onDidDispose` → `rollbackOpenTransaction` ran ≤1 time (no tx → 0); no `postMessage`, no toast |
| 2 | edge: dispose-during-run | deferred `loadMore`; `dispose()`; `render()` recreates panel; stale resolves | NO stale `state` posted into the recreated panel (RED today: 1 stale post — probed); no error toast |
| 3 | edge: dispose-during-run | deferred `handleRequery`; dispose; recreate; stale resolves | no `postMessage`, `showErrorMessage` NOT called (stale path returns silently) |
| 4 | edge: one-cleanup | `dispose()` called twice + panel fires `onDidDispose` | rollback executed exactly **once** (`transaction` null-guard) |
| 5 | edge: busy | dispose during run; new run `setBusy(true)`; stale finally must not clear | `busy:false` NEVER posted to the recreated panel (RED today — probed) |
| 6 | regression | postMessage after dispose (panel null) is a silent no-op | existing post sites keep `if (!this.panel) return` |

### ARP-02.3 — connection provenance (`src/core/__tests__/connectionManager.test.ts`; reuse `STUB_CTX` :395-404 + factory pattern :411-437; new fixture: deferred `testConnection` for the passive race)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | happy | `getAdapterFor` caches; second call reuses | factory ×1; same adapter instance returned |
| 2 | edge: delete-during-flight | `getAdapterFor(cX)` deferred; `deleteConnection(cX)` commits; late resolves | stale candidate discarded (closed); a later `getAdapterFor` for a stale cX cfg builds a FRESH adapter (factory re-called) (RED today: stale cached+reused — probed) |
| 3 | edge: edit-during-flight | `getAdapterFor(cX)` deferred; `editConnection(cX,{host})` commits; late resolves | discarded; next `getAdapterFor` builds an adapter for the NEW config (host asserted) |
| 4 | edge: switch-regression | `getAdapter()` in flight for A; `setActive(B)`; late A candidate | discarded + throws "không còn active" (GREEN via RLX-03 `:567-580` — regression pin) |
| 5 | edge: delete closes passive | cached passive adapter for a connection that is deleted | `close` ×1; `passiveAdapters` no longer returns it |
| 6 | edge: edit closes passive | cached passive adapter for an edited connection | `close` ×1; next `getAdapterFor` reconnects with new config |

### ARP-02.4 — host integration (`src/extension.test.ts`; conditional — see §2 gate)

| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | decision | host-gap gate | if Wave 1 closes with no host gap → close as not-needed with `git diff 367cb80 -- src/extension.ts` evidence (mirror TASK-ARP01-003) |
| 2 | edge (only if gap) | `runStatements` finally `setBusy(false)` after mid-run dispose+recreate | must not clear the NEW run's busy (or must be guarded by the panel epoch) |
| 3 | edge (only if gap) | `deactivate()` ordering: dispose panels after in-flight runner work settles | no unhandled rejection; panels disposed exactly once |
| 4 | regression | RLX-02 command await semantics preserved | `runner.cancel()` awaited before `setBusy(false)` (`extension.ts:476-486`) still holds |

## §5 Verification Commands

Run inside a clean worktree on `main @ 367cb80`. No real DB required — all suites are mocked
(`pg` Pool/Client, `vscode` module, fake adapters). No lint script exists; static gate =
`npm run typecheck` + `npm run compile` (scripts verified in `package.json`).

- **ARP-02.1** (wave 1):
  ```bash
  npx vitest run src/core/__tests__/queryRunner.test.ts
  npm run typecheck
  npm run compile
  ```
  (Selection per RULES: `queryRunner.ts` → `tests-map.json` `[queryRunner.test.ts,
  queryRunner.integration.test.ts]`. `queryRunner.integration.test.ts` is DB-gated and EXCLUDED from the
  DB-free focused run — the unit file is the pinned test target.)
- **ARP-02.2** (wave 1):
  ```bash
  npx vitest run src/ui/__tests__/resultsPanel.test.ts
  npm run typecheck
  npm run compile
  ```
  (Selection per RULES: `resultsPanel.ts` → `tests-map.json` lists 7 suites
  `[resultsPanel.test.ts, resultsPanelDistinctValues, resultsPanelOrderBy, resultsPanelRequery,
  resultsPanelRetry, resultsPanelSaveEdits, resultsPanelServerFilter]`. The pinned new-test target is
  `resultsPanel.test.ts`; the 6 sibling suites are exercised by the wave/cycle `npm test` net, NOT
  per-task.)
- **ARP-02.3** (wave 1):
  ```bash
  npx vitest run src/core/__tests__/connectionManager.test.ts
  npm run typecheck
  npm run compile
  ```
- **ARP-02.4** (wave 2, after 001+002+003):
  ```bash
  git diff 367cb80 -- src/extension.ts                       # gate evidence (empty if closed not-needed)
  npx vitest run src/extension.test.ts                        # only if a change was produced
  npm run typecheck
  npm run compile
  ```
- **Wave-2 net (after all tasks)**:
  ```bash
  npm test
  ```
  Expected: **≥ 2963 passed | 2 skipped** (baseline at 367cb80).

## §6 Acceptance Criteria

Every criterion traces to a task.

- [ ] **ARP-02.1** — double cancel on an in-flight non-batched run fires the seam exactly once (RED on
  367cb80: 2x; RED output pasted before implementation).
- [ ] **ARP-02.1** — close-origin cancel on an idle runner does not poison a later `loadMore` (RED on
  367cb80: throws `Statement 0 cancelled`).
- [ ] **ARP-02.1** — an in-flight `loadMore` when cancel fires does not append after settle (RED on
  367cb80: appended `[[42]]`).
- [ ] **ARP-02.1** — batched double-cancel stays idempotent and the seam stays exclusive (GREEN regression
  pin); `npm run typecheck` + `npm run compile` exit 0.
- [ ] **ARP-02.2** — after dispose+recreate, a stale deferred completion posts NOTHING to the new panel,
  shows NO error toast, and does NOT clear the new session's busy (RED on 367cb80 — stale `state` posted;
  RED output pasted).
- [ ] **ARP-02.2** — cleanup is exactly-once across `dispose()` ×2 + `onDidDispose`; `src/extension.ts`
  byte-identical to base (panel does NOT fix the host).
- [ ] **ARP-02.3** — a late `getAdapterFor` after edit/delete/switch is discarded, never re-installed into
  `passiveAdapters`, and a later request reconnects with the current config (RED on 367cb80 — stale
  re-installed and reused).
- [ ] **ARP-02.3** — RLX-03 `getAdapter` ownership re-check and ARP-01 `guardAdapter` transaction guard
  remain green (regression pins); no public operation-ID API added.
- [ ] **ARP-02.4** — gate recorded: closed-as-not-needed (both `extension.ts` diffs empty) OR host-gap fix
  shipped with RED-first proof; RLX-02 command await semantics preserved.
- [ ] **Cycle** — `npm test` full suite: **≥ 2963 passed | 2 skipped** (no regression).
- [ ] **Reviewer** verdict APPROVED or APPROVED-WITH-MINOR on PLAN and on each task.
- [ ] **Concurrency review** (roadmap acceptance): every deferred settlement timeline (cancelled-after-
  settle, dispose-during-run, switch-during-run) mapped with no unhandled promise path — recorded in the
  ARP-02.1/02.2/02.3 Executor Reports.

## §7 Global Constraints

- Base: `main @ 367cb80` (v1.37.0). All work in a fresh worktree; no git commit in P2/P3.
- Same-wave file disjointness absolute: 001 owns `queryRunner.ts`(+test); 002 owns `resultsPanel.ts`(+test);
  003 owns `connectionManager.ts`(+test); 004 owns `extension.ts`(+test) in wave 2 only.
- 002 must NOT modify `extension.ts`; 001/002/003 must NOT modify each other's files.
- TDD mandatory: RED output pasted before implementation in every task report.
- Do NOT use shared adapter/pool close as cancellation; do NOT reimplement RLX-02 adapter seams; no server
  kill SQL; no public operation IDs unless the wave-1 audit proves no smaller design works.
- 003 must NOT break the ARP-01 `guardAdapter` beginTransaction guard (`connectionManager.ts:652-689`) or
  the RLX-03 ownership re-checks (`:525-537`, `:567-580`).
- No lint script exists — static gate is `npm run typecheck` + `npm run compile`.
- Verification must be DB-free in a clean worktree.

---

## Planner Report

PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (Round 1, 1 minor clarity finding — non-blocking: ARP-02.1 must implement the in-flight-scoped loadMore entry check, not rely on the run()-finally reset alone)

## Planner Self-Audit

Checklist: 12/12 pass
Fixed during audit:
- RED claims made real by probe runs on 367cb80 (5 RED confirmed: seam 2x, loadMore poison, loadMore
  post-cancel append, panel stale post into recreated panel, manager stale passive re-install). One
  hypothesized RED (batched→seam crossover on double cancel) was PROVEN GREEN and re-pinned as a regression
  instead — the plan claims only what the probe proved.
- Line anchors re-verified against current source: `activeAdapter` cleared at queryRunner.ts:195 before
  `currentBatched` assigned at :203; `cancel()` :376-402; `loadMoreImpl` :313-358; panel `onDidDispose`
  :277-285, `dispose` :401-412, `postMessage` guard :435; `getAdapterFor` :343-374 (set at :372, no
  re-check), edit/delete activeGen bumps :205-207/:267-269; extension `runStatements` :1689-1727, deactivate
  :1012-1040.
- Tests-map resolution applied: queryRunner.ts → 2 files (integration excluded — DB-gated), resultsPanel.ts
  → 7 files (sibling suites moved to the cycle net), connectionManager.ts → 1 file, extension.ts →
  `src/extension.test.ts` pinned.
- Same-wave disjointness verified file-by-file; 004's conditional gate mirrors TASK-ARP01-003.
Known gaps:
- The exact predicate for bounding `cancelRequested` to the current run (vs. a separate in-flight flag) is
  left to the executor; the RED tests are the contract. Same for ARP-02.3's revision vs.
  config-revalidation choice — both documented, neither a public API.
- A close-origin cancel landing during a `loadMore` (not a `run`) leaves `cancelRequested` set until the
  next `run()` — the RED contract (#5) fixes the post-cancel append; whether a subsequent `loadMore` after
  THAT is also poisoned is covered by the executor's chosen flag scope and should be asserted in task 001
  case 4/5 to keep both green.

## Plan Review Log

### Round 1
(no review yet — this cycle's PLAN has not been submitted)

### Round 1
REVIEWER_MODEL: unic-smart
VERDICT: Approved

FINDINGS:
  1. minor (CLARITY) — PLAN_ARP02.md §3 ARP-02.1 fix #2: the sentence "reset `cancelRequested = false` in `run()`'s `finally` (:157-165) ... so a post-settle close-origin cancel is a no-op for later `loadMore`" is causally wrong. In the RED case (#4) the cancel arrives AFTER the run's finally has already run, so the finally-reset alone does NOT prevent the idle cancel from setting `cancelRequested=true` and poisoning the later `loadMore`. The load-bearing mechanism is the in-flight-scoped `loadMore` entry check (or a separate in-flight flag) that the plan requires in the following sentence. Required fix to plan: state that fix (b) — the scoped entry check — is what closes the idle-runner case, and that (a) (finally reset) only narrows the cancel-during-run-window; executor must implement (b), not rely on (a) alone.

COMPLETENESS:
  - §4 Test Plan: every task has 1 happy + ≥5 edge cases of distinct kinds; fault-injection timelines concrete (cancelled-after-settle ARP-02.1#5/#6, dispose-during-run ARP-02.2#2/#3/#5, switch-during-run ARP-02.3#4, delete/edit-during-flight ARP-02.3#2/#3). All match the task files verbatim.
  - §6 acceptance: every criterion verifiable; baseline "≥ 2963 passed | 2 skipped" re-confirmed by independent `npm test` on 367cb80 (exactly 2963 passed | 2 skipped).
CONSISTENCY:
  - none. Wave/file ownership in plan §2/§7 == task files 001-004 == INDEX_ARP02; no wave-1 file shared; 004 conditional gate mirrors TASK-ARP01-003 (verified). Roadmap ARP-02 IN (idempotent live-work ownership, late-completion provenance proof, fault-injection tests) and OUT (reimpl RLX-02 seam, server kill SQL, pool close-as-cancel, public operation IDs) mirrored exactly in §2/§7.
CLARITY:
  - covered by finding 1.
SCOPE:
  - none. Bound to 4 owned files; ARP-02.2 explicitly forbidden from extension.ts; no public API; ARP-02.3 fix choices internal-only.
YAGNI:
  - none. Rejected alternatives stay out; nothing beyond roadmap ARP-02.

NOTES: All source line anchors re-verified against current source (incl. the ARP-02.1 GREEN claim: activeAdapter cleared at :195 before currentBatched assigned at :203 — batched→seam crossover truly impossible). tests-map.json entries in §5 verified verbatim; no lint script exists (package.json) so typecheck+compile is the correct static gate.
