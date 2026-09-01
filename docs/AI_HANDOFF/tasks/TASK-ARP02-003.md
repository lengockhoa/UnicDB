# TASK-ARP02-003 — Connection provenance: late getAdapterFor candidate cannot be installed after edit/delete/switch

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor-model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_ARP02.md` §3, §4 (ARP-02.3)

## Goal

Close the passive-adapter provenance gap in `ConnectionManager`. The ACTIVE path is already guarded by
RLX-03 (`getAdapter()` ownership re-check at `src/core/connectionManager.ts:567-580` — a stale candidate is
closed and throws "không còn active"). The PASSIVE path `getAdapterFor` (`:343-374`) has NO such guard: it
reads `cfg` at entry, awaits password/factory/testConnection, then `passiveAdapters.set(cfg.id, adapter)`
(`:372`) unconditionally. `editConnection` (`:190-255`) and `deleteConnection` (`:260-286`) bump
`activeGeneration` ONLY when the id is active (`:205-207`, `:267-269`), so an in-flight `getAdapterFor` for a
NON-active connection survives edit/delete and re-installs a stale adapter. Confirmed RED by probe on
`main @ 367cb80`: `getAdapterFor(cX)` deferred while `deleteConnection(cX)` commits → the late candidate is
re-installed into `passiveAdapters` and a later `getAdapterFor` for a stale cX cfg returns it (factory not
re-called).

Deliverable: after switch/edit/delete, no stale A-connection resource is installed or reused — a late
`getAdapterFor` candidate is discarded (closed) and a later request reconnects with the CURRENT config.
**No public API** (roadmap Out — internal revision or config re-validation only).

## Target Files

- `src/core/connectionManager.ts` — only. Do NOT touch `src/ui/resultsPanel.ts` / `src/core/queryRunner.ts`
  (TASK-ARP02-002 / -001) and NOT `src/extension.ts` (TASK-ARP02-004).
- `src/core/__tests__/connectionManager.test.ts` — ADD cases; keep all existing blocks (incl. the RLX-03
  recovery suite and the ARP-01 transaction-guard suite) intact.

## Test Cases (REQUIRED — TDD)

RED-first: write case 2 FIRST, run it, paste the RED output, then implement. Cases 1, 4, 5, 6 are expected
GREEN on base (regression pins). New fixture needed: a factory whose `testConnection` is DEFERRED
(gate-releasable) so the passive race is deterministic.

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `getAdapterFor` caches; second call reuses | factory ×1; the SAME adapter instance is returned on the second `getAdapterFor` | `STUB_CTX` `:395-404`, factory pattern `:411-437`, connection seeded in memento before ctor |
| 2 | edge: delete-during-flight | `getAdapterFor(cX)` deferred; `deleteConnection(cX)` commits; late resolves → candidate discarded | after the late resolve, a subsequent `getAdapterFor` for a stale cX cfg builds a FRESH adapter (factory call count grows) and the stale candidate was closed. **RED on 367cb80** (probe: factory stayed 1x — stale cached+reused) | deferred `testConnection` fixture; seed cX in memento; `deleteConnection("cX")` |
| 3 | edge: edit-during-flight | `getAdapterFor(cX)` deferred; `editConnection(cX,{host:"h2"})` commits; late resolves → discarded | next `getAdapterFor` builds an adapter whose captured `cfg.host === "h2"` (fresh connect, not the stale one) | same fixture; edit after the deferred starts |
| 4 | edge: switch-regression | `getAdapter()` in flight for A; `setActive(B)`; late A candidate | discarded (closed) + throws "không còn active" — GREEN via RLX-03 `:567-580`; pin (do not regress) | existing RLX-03 `getAdapter` ownership tests |
| 5 | edge: delete closes passive | cached passive adapter for a deleted connection | `close` called exactly once; a later `getAdapterFor` for the (now deleted) id does NOT return the cached adapter | `getAdapterFor` success first, then `deleteConnection` |
| 6 | edge: edit closes passive | cached passive adapter for an edited connection | `close` called once; next `getAdapterFor` reconnects with the NEW config | `getAdapterFor` success, then `editConnection({host})` |

## Test Files

- `src/core/__tests__/connectionManager.test.ts` — ADD cases 1-6. Add a gated-`testConnection` helper
  (deferred promise released by the test) for the deterministic race; reuse `STUB_CTX`, the memento-seed
  pattern at `:486-489`, and `makeFakeAdapter` `:77-90`.

## Verification Commands

```bash
npx vitest run src/core/__tests__/connectionManager.test.ts
npm run typecheck
npm run compile
```

(Selection per RULES: `connectionManager.ts` → `.cache/index/tests-map.json` =
`[connectionManager.test.ts]` — single file. No lint script; typecheck + compile are the static gates.)

## Acceptance Criteria

- [ ] RED-first proof pasted: case 2 fails on base 367cb80 BEFORE implementation (probe: factory call count
      stayed 1 — stale passive adapter re-installed and reused after delete).
- [ ] After fix: case 2 GREEN (late candidate discarded+closed; later request reconnects), case 3 GREEN
      (edit-during-flight reconnects with new config).
- [ ] Cases 4/5/6 GREEN unchanged — RLX-03 `getAdapter` ownership re-check, delete/edit passive close.
- [ ] ARP-01 transaction guard regression: the `guardAdapter` beginTransaction suite
      (`connectionManager.test.ts` ARP-01 block) still green — do NOT weaken `guardAdapter`
      (`:652-689`).
- [ ] No new public API: `getActive()`, `getAdapter()`, `getAdapterFor()`, `setActive()`,
      `addConnection()`, `editConnection()`, `deleteConnection()` signatures unchanged.
- [ ] `npm run typecheck` + `npm run compile` exit 0.
- [ ] Executor Report records the provenance timeline (getAdapterFor-in-flight × edit/delete/switch) and
      confirms no adapter/socket leak (each discarded candidate is closed exactly once).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- `none` (wave 1 — parallel with TASK-ARP02-001 and TASK-ARP02-002; no shared files).

## Interfaces

- Consumes:
  - `ConnectionManager.getAdapterFor(cfg: ConnectionConfig): Promise<DbAdapter>` — `:343-374`.
  - `ConnectionManager.editConnection(...)` / `deleteConnection(...)` — `:190-255` / `:260-286`.
  - `closePassiveAdapter(id)` — `:381-390`; `activeGeneration` / `lifecycleGeneration` — `:101-102`.
  - `ConnectionManager.getAdapter()` ownership re-check — `:567-580` (RLX-03, pin as regression).
- Produces: internal only. Either (a) a per-connection revision counter (bumped synchronously by
  add/edit/delete before their first await, mirroring the RLX-03 generation discipline at `:205-207` /
  `:267-269`), or (b) a post-`testConnection` config re-validation against the current persisted config.
  Whichever is chosen, discarded candidates go through `close()` exactly once (best-effort) and are never
  installed in `passiveAdapters`.

## Discussion

- The ACTIVE path (`getAdapter`, `:543-586`) is already closed by RLX-03 — this task must NOT duplicate or
  weaken it; case 4 pins it. The gap is ONLY the passive `getAdapterFor` late-install. Verify the chosen
  fix also covers the edit case where `editConnection` commits a config change while `getAdapterFor` is
  past the cache lookup but before `passiveAdapters.set`.
- The ARP-01 transaction guard wraps adapters at `guardAdapter` — if the fix closes a candidate, the
  `close()` must run against the GUARDED adapter reference (or be idempotent), never double-close.
- Result attribution to the wrong connection at the UI is closed by TASK-ARP02-002 (panel session epoch)
  and TASK-ARP02-004 (host ordering); this task owns the manager-level resource/socket provenance only.
- (no comments yet)

---

## Executor Report

```
STATUS: PASS
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (base b032b98 == 367cb80 source, TDD step 2, before implementation):
 ❯ src/core/__tests__/connectionManager.test.ts  (34 tests | 2 failed) 71ms
   ❯ ... ARP-02.3 passive provenance > case 2 — getAdapterFor(cX) deferred; deleteConnection(cX) commits; late resolves -> candidate discarded
     → promise resolved "{ connect: [Function spy], …(8) }" instead of rejecting
   ❯ ... ARP-02.3 passive provenance > case 3 — getAdapterFor(cY) deferred; editConnection(cY,{host:h2}) commits; late resolves -> discarded, next connect uses new config
     → promise resolved "{ connect: [Function spy], …(8) }" instead of rejecting

 FAIL  ... case 2 — AssertionError: promise resolved (stale adapter object) instead of rejecting
 ❯ src/core/__tests__/connectionManager.test.ts:1206
 Test Files  1 failed (1) | Tests  2 failed | 32 passed (34)

=> RED for exactly the expected reason: the late getAdapterFor candidate RESOLVED with the
   stale adapter (passiveAdapters.set unconditionally at :372) instead of being discarded —
   matches the probe on 367cb80 (factory stayed 1x; stale cached + reused). Cases 1/4/5/6 were
   GREEN on base as predicted by the task (1/5/6 regression pins, 4 = RLX-03 pin). No
   immediately-GREEN case among the new race cases.

IMPLEMENTATION SUMMARY (option (a) + re-resolve composition):
- Per-connection revision map `connRevisions: Map<string, number>`; `bumpConnRevision(id)`
  bumped SYNCHRONOUSLY (before any await) in editConnection (:195-200, next to the RLX-03
  activeGeneration discipline) and deleteConnection (:260-266) — mirrors :205-207 / :267-269.
- getAdapterFor rewritten: snapshots `rev` at entry; re-resolves the CURRENT persisted config
  (`currentConfigFor(id) ?? cfg` fallback) and builds the candidate from that, so post-edit
  reconnects use the new host/port even if the caller passed a stale cfg snapshot (schema-tree).
- Provenance re-check AFTER every await (same discipline as RLX-03 ACTIVE path :567-580):
  revision changed OR effective current config no longer the one built from → candidate is
  closed EXACTLY ONCE (best-effort try/catch, runs against the guardAdapter-wrapped reference
  returned by resolveAdapter — ARP-01 note honored, idempotent fake close semantics preserved)
  and NEVER installed into passiveAdapters; throws "không còn hợp lệ — đã bỏ kết nối cũ".
- No public API changed (getActive/getAdapter/getAdapterFor/setActive/add/edit/delete signatures
  untouched). No RLX-03/ARP-01 code weakened — guardAdapter (:652-689) untouched.

PROVENANCE TIMELINE (recorded per acceptance criteria):
- getAdapterFor(cX) in flight (rev snapshot N) × deleteConnection(cX) commits (rev → N+1):
  late candidate closed ×1, not installed; next request builds FRESH adapter (factory grows).
- getAdapterFor(cY) in flight (built from OLD persisted cfg) × editConnection(cY,{host:h2})
  commits (rev → N+1, persisted cfg replaced): late candidate closed ×1, not installed; next
  request reconnects with host=h2.
- getAdapter() in flight for A × setActive(B): unchanged RLX-03 ACTIVE path — candidate closed
  ×1 + throws "không còn active" (case 4 pin, was GREEN on base).
- No adapter/socket leak: every discarded candidate path calls close() exactly once on the
  guarded reference; testConnection-failure path keeps its pre-existing close-then-rethrow.

VERIFICATION OUTPUT (fresh, this turn, worktree .worktrees/task-arp02-003):
1) npx vitest run src/core/__tests__/connectionManager.test.ts
   ✓ src/core/__tests__/connectionManager.test.ts  (34 tests) 64ms
   Test Files  1 passed (1)
   => 34 pass / 0 fail; zero unhandled rejections/warnings (eager .catch pattern in races).
   New block "ConnectionManager ARP-02.3 passive provenance": 6/6 GREEN (cases 1-6).
   Existing blocks intact: CRUD §7/7, design §8 fallback, EventEmitter, DBX-05 read-only+tunnel
   5/5, RLX-03 recovery 7/7, ARP-01 transaction guard 7/7.
2) npm run typecheck  → tsc --noEmit, exit 0
3) npm run compile    → esbuild: build complete, exit 0

TESTS_ADDED: 6 cases in src/core/__tests__/connectionManager.test.ts
  case 1 caching/reuse; case 2 delete-during-flight; case 3 edit-during-flight; case 4
  switch-during-active-connect (RLX-03 pin); case 5 delete closes cached passive exactly once;
  case 6 edit closes cached passive + reconnect with new config. New gated-testConnection
  fixture (makeGatedFactory / makeDeferred gate) + setupProvenanceHarness.

ISSUES:
- First strict-entry draft of the fix rejected the untracked-cfg calls used by the DBX-05 /
  ARP-01 blocks (they call getAdapterFor with cfgs never persisted in state). Resolved by the
  `?? cfg` fallback both at entry and in the re-check — untracked cfgs keep the historical
  pass-through behavior while mid-flight edit/delete for TRACKED ids is still caught (cases
  2/3/5/6 prove both sides). No existing test block was modified.
- One cosmetic note: the vitest tsconfig "ES2024" target warnings pre-exist on this branch
  (unrelated to this task).

HANDOFF_TO_REVIEWER: yes — reviewer model unic-smart (differs from executor unic-code).
NEXT: set pending_review in docs/AI_HANDOFF/INDEX.md; reviewer verifies RED reasoning + the
untracked-cfg fallback semantics.
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
