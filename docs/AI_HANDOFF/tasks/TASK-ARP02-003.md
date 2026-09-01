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
(write here: STATUS / EXECUTOR_TOOL / EXECUTOR_MODEL / EXECUTOR_SUBAGENT / RED_OUTPUT /
 VERIFICATION output / ISSUES / HANDOFF_TO_REVIEWER)
```

## Reviewer Verdict

```
(write here: VERDICT / REVIEWER_MODEL / EXECUTOR_MODEL / VERIFICATION_RERUN / TEST_PLAN_COVERAGE /
 FINDINGS / NEXT_STATUS_FOR_INDEX)
```
