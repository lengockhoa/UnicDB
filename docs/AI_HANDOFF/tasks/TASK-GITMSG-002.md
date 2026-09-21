# TASK-GITMSG-002 — Commit-gen wiring: cancellable progress + omp driver cancel

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3
- Spec references: `docs/AI_HANDOFF/SPEC.md` FR-001, FR-002, FR-004, FR-005 (§5); API §8.4; state machine §7.1; edge cases §10

## Goal

Wire the host side of the commit-gen UX fix: the `UnicDB.generateCommitMessage`
command acquires the single-flight gate, runs inside a cancellable
`withProgress`, forwards stage reports + an `AbortSignal` into the deps, and
the omp one-shot driver gains `cancel()` so a user cancel settles the turn
early instead of waiting out the 120s ceiling.

## Target Files

- `src/extension.ts` — command registration (~:1277-1289): module-scope
  `commitGenGate`, `cancellable: true`, `(progress, token)` callback,
  `deps.report`/`isCancelled` wiring, `AbortController` → `req.signal` in
  `builtinComplete`, `token.onCancellationRequested` → `oneShot.cancel()`,
  commit-gen provider client `timeoutMs: COMMIT_GEN_TIMEOUT_MS`.
- `src/ai/commitGenOmpOneShot.ts` — `CommitGenOneShotDriver` gains
  `cancel(): void` (settles with `commit-gen: cancelled`, runs `onSettle`
  once); `buildCommitGenOmpOneShot`'s returned `OmpOneShot` exposes
  `cancel()` delegating to the live driver.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | `driver.cancel()` mid-turn | `driver.promise` rejects with `commit-gen: cancelled`; `onSettle` called exactly once | `driveCommitGenOneShot` with fake timers |
| 2 | edge (ordering) | cancel after `onDone` | no-op — promise stays resolved with buffered text, `onSettle` still once | driver settled via `events.onDone()` |
| 3 | edge (boundary) | cancel before any event | rejects `commit-gen: cancelled`; timer cleared (no later timeout reject) | driver, fake timers advanced past timeoutMs after cancel |
| 4 | regression | command wiring source-scan + manifest unchanged | `extension.ts` registers `UnicDB.generateCommitMessage` with `cancellable: true` and a gate acquire before `withProgress` (fails today — neither exists); existing manifest guards in `commitGenManifest.test.ts` still pass | readFileSync of `src/extension.ts` + `package.json` |
| 5 | unit (happy) | `OmpOneShot.cancel` reaches driver | calling `oneShot.cancel()` settles the in-flight `generate()` promise | `buildCommitGenOmpOneShot`-shaped fake or driver-level wiring test |
| 6 | edge (concurrent) | second invocation while first in flight | gate returns `null` → toast `TOAST_GENERATION_IN_PROGRESS`, `runGenerateCommitMessage` not called | deps-level test through the exported wiring seam (or source-scan asserting the early-return order) |

## Test Files

- `src/ai/__tests__/commitGenOmpOneShot.test.ts` — extend, cases 1–3, 5.
- `src/ui/__tests__/commitGenManifest.test.ts` — extend, case 4 (source-scan; manifest guards unchanged).
- `src/ui/__tests__/commitGenIntegration.test.ts` — extend, case 6.

## Verification Commands

```bash
npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first for #4).
- [ ] `withProgress` options include `cancellable: true`; callback uses `(progress, token)`.
- [ ] Gate acquired before `withProgress`; `null` → `TOAST_GENERATION_IN_PROGRESS` toast + return; release in `finally`.
- [ ] `builtinComplete` passes an `AbortSignal` into `req.signal`; provider client uses `COMMIT_GEN_TIMEOUT_MS`.
- [ ] `CommitGenOneShotDriver.cancel` + `OmpOneShot.cancel` implemented; cancel settles exactly once.
- [ ] No regression in `src/extension.test.ts` or commit-gen suites.

## Dependencies

- TASK-GITMSG-001 must complete first (consumes `createCommitGenGate`,
  `COMMIT_GEN_TIMEOUT_MS`, `TOAST_GENERATION_IN_PROGRESS`,
  `CommitGenDeps.report`/`isCancelled`, `OmpOneShot.cancel`,
  `ProviderRequest.signal`).

## Interfaces

- Consumes: everything listed under TASK-GITMSG-001 `Produces` — exact
  signatures there.
- Produces:
  - `CommitGenOneShotDriver.cancel(): void` — `src/ai/commitGenOmpOneShot.ts`
    (settles with `Error("commit-gen: cancelled")`, runs `onSettle` once)

---

## Discussion

### 2026-09-21 · planner · unic-smart
`buildCommitGenOmpOneShot` currently creates the driver INSIDE
`generate()`; to expose `cancel()` on the returned `OmpOneShot`, hoist a
`let driver: CommitGenOneShotDriver | null` in the closure — `cancel()`
calls `driver?.cancel()` (no-op before first `generate()`). Keep the
fresh-`AcpProcess`-per-invocation contract unchanged.
