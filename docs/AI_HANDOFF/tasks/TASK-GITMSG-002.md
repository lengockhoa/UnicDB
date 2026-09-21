# TASK-GITMSG-002 — Commit-gen wiring: cancellable progress + omp driver cancel

- Status: `done`
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
## Progress

- 2026-09-21T21:51:00+0700 · milestone: red→green — driver.cancel + createCommitGenOmpTurn + extension wiring (gate/cancellable progress/token ports) · last-green: `npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts` (32 pass) + `npm run typecheck` (0 errors) + `npx vitest run src/ai/__tests__/ src/ui/__tests__/commitGen src/extension.test.ts` (608 pass, 1 skipped — no regression; one env-only failure resolved by `npm run compile` emitting dist/schemaForm.js) · files: src/ai/commitGenOmpOneShot.ts, src/extension.ts, src/ai/__tests__/commitGenOmpOneShot.test.ts, src/ui/__tests__/commitGenManifest.test.ts, src/ui/__tests__/commitGenIntegration.test.ts · drift: none

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: other (Oh My Pi harness)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecG2
SUMMARY: Wired the host side of the commit-gen UX fix: module-scope
  commitGenGate + cancellable withProgress((progress, token)) in the
  UnicDB.generateCommitMessage registration; buildCommitGenDeps now takes
  progress+token and supplies report/isCancelled/signal ports (token →
  AbortController → ProviderRequest.signal); builtinComplete client pinned
  to COMMIT_GEN_TIMEOUT_MS; token.onCancellationRequested → oneShot.cancel()
  in buildOmpEngine. CommitGenOneShotDriver gained cancel() (settles with
  "commit-gen: cancelled", onSettle once); new pure createCommitGenOmpTurn
  wraps send/shutdown into the OmpOneShot {generate,cancel} shape so the
  cancel path is unit-testable — buildCommitGenOmpOneShot now returns it.
TEST_PLAN_FOLLOWED: task §Test Cases — all 6 cases implemented (1–3, 5 in
  commitGenOmpOneShot.test.ts; 4 in commitGenManifest.test.ts; 6 in
  commitGenIntegration.test.ts)
FILES_CHANGED:
  - src/ai/commitGenOmpOneShot.ts: CommitGenOneShotDriver.cancel() (settle
    once with "commit-gen: cancelled"); NEW createCommitGenOmpTurn(engine)
    returning {generate,cancel} — hoisted live-driver per planner note
  - src/extension.ts: module-scope commitGenGate; command callback acquires
    gate (null → TOAST_GENERATION_IN_PROGRESS + return), withProgress gains
    cancellable:true + (progress, token) callback, release() in finally;
    buildCommitGenDeps(progress, token) wires report/isCancelled/signal +
    token→oneShot.cancel() + COMMIT_GEN_TIMEOUT_MS provider client
  - src/ai/__tests__/commitGenOmpOneShot.test.ts: +5 tests — cases 1–3, 5 +
    cancel-before-generate no-op
  - src/ui/__tests__/commitGenManifest.test.ts: +1 test — case 4 wiring
    source-scan (acquire<withProgress, toast<withProgress, cancellable:true,
    finally release, (progress, token) callback)
  - src/ui/__tests__/commitGenIntegration.test.ts: +1 test — case 6
    early-return order scan (acquire→toast→withProgress→handler, return in
    refusal slice)
TESTS_ADDED:
  - commitGenOmpOneShot.test.ts: cancel mid-turn rejects + onSettle once;
    cancel after onDone no-op; cancel before events clears timer;
    OmpOneShot.cancel settles in-flight generate; cancel pre-generate no-op
  - commitGenManifest.test.ts: gate/cancellable/finally source-scan
  - commitGenIntegration.test.ts: second-invocation refusal order scan
RED_OUTPUT: |
  FAIL commitGenOmpOneShot.test.ts — 5 failed: "d.cancel is not a function"
    (cases 1–3), "createCommitGenOmpTurn is not a function" (case 5 + no-op)
  FAIL commitGenManifest.test.ts — case 4: "gate acquire() before
    withProgress: expected -1 to be greater than -1"
  FAIL commitGenIntegration.test.ts — case 6: "acquire() present in command
    block: expected -1 to be greater than -1"
  (7 failed | 25 passed)
VERIFICATION:
  command: npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts
  result: 32 pass / 0 fail
  output_excerpt: |
    ✓ src/ui/__tests__/commitGenManifest.test.ts  (9 tests) 6ms
    ✓ src/ai/__tests__/commitGenOmpOneShot.test.ts  (15 tests) 5ms
    ✓ src/ui/__tests__/commitGenIntegration.test.ts  (8 tests) 6ms
    Test Files 3 passed (3)
    Tests 32 passed (32)
  command: npm run typecheck
  result: exit 0 — 0 errors
  command: npx vitest run src/ai/__tests__/ src/ui/__tests__/commitGen src/extension.test.ts
  result: 608 pass / 0 fail / 1 skipped (live smoke) — no regression
ISSUES: |
  - extension.test.ts "npm run compile emits dist/schemaForm.js" failed on
    first regression run because the worktree had no dist/ build; after
    `npm run compile` (esbuild, exit 0) the suite is 192/192. Environmental
    precondition, unrelated to this change.
  - Deviation from planner note: instead of hoisting `let driver` inside
    buildCommitGenOmpOneShot (untestable in extension.ts), the turn shape
    lives in pure createCommitGenOmpTurn — same hoisted-driver semantics,
    unit-tested directly (case 5). Fresh-AcpProcess-per-invocation contract
    unchanged.
HANDOFF_TO_REVIEWER: no — handoff.reviewer not configured; status set to
  done matching TASK-GITMSG-001 precedent.
NEXT: ready for review — GITMSG wave complete; orchestrator merges worktree.
```

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (self-reported; differs from reviewer — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts
  result: 32 pass / 0 fail
  command: npm run typecheck
  result: exit 0 — 0 errors
  command: npx vitest run src/extension.test.ts (shared-host regression net)
  result: 192 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed — cases 1–3, 5 + pre-generate no-op in commitGenOmpOneShot.test.ts; case 4 in commitGenManifest.test.ts; case 6 in commitGenIntegration.test.ts; RED_OUTPUT contains real failing assertions ("d.cancel is not a function", "expected -1 to be greater than -1")
FINDINGS:
  critical: none
  important: none
  minor:
    - file: src/extension.ts:4348-4353 — cancel landing after buildOmpEngine resolves but before oneShot.generate() is a no-op (driver still null inside createCommitGenOmpTurn); the turn then runs to its 120s ceiling. Silent-return contract still holds via isCancelled checkpoints; bounded, narrow window.
    - file: src/ui/__tests__/commitGenIntegration.test.ts:457 — file now ends without trailing newline.
    - file: src/extension.ts:4340 — stray double blank line after the AbortController comment block.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Deviation from planner note (pure createCommitGenOmpTurn instead of hoisted let-driver inside buildCommitGenOmpOneShot) is a strict improvement — same semantics, directly unit-testable; fresh-AcpProcess-per-invocation contract unchanged.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code (EXECUTOR_SUBAGENT: ExecG2) — isolation OK
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/commitGenOmpOneShot.test.ts src/ui/__tests__/commitGenManifest.test.ts src/ui/__tests__/commitGenIntegration.test.ts
  result: 32 pass / 0 fail
  command: npm run typecheck
  result: exit 0 — 0 errors
  command: npx vitest run src/extension.test.ts + commit-gen suites (shared-code regression net — extension.ts touched)
  result: 252 pass / 0 fail
TEST_PLAN_COVERAGE: all-followed — 6/6 cases implemented; cases 4/6 are source-scans per plan; RED_OUTPUT contains genuine failure output
FINDINGS:
  critical: none
  important: none
  minor:
    - file: src/ai/commitGenOmpOneShot.ts:169 — cancel landing between buildOmpEngine resolving and generate() creating the driver is a no-op; turn still runs to completion in background (post-outcome isCancelled checkpoint still returns silently, so UX is correct — only wasted work). Optional hardening: check token.isCancellationRequested inside generate().
    - file: src/extension.ts:4340,4356 — token.onCancellationRequested disposables not retained; harmless (token scoped to the progress callback) but inconsistent with disposables hygiene elsewhere.
    - file: src/ui/__tests__/commitGenIntegration.test.ts:457 — file now ends without trailing newline.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Deviation from planner note (createCommitGenOmpTurn vs hoisted let in buildCommitGenOmpOneShot) is justified — same semantics, directly unit-testable; fresh-AcpProcess-per-invocation contract preserved.
