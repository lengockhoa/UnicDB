# TASK-AIX03-102 — Connection-loss bounded propagation (RLX-03 consumer)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX03.md` §3 (connection-loss axis)

## Goal

Close the RLX-03-consumer gap: the panel never observes
`ConnectionManager.onDidChangeRecoveryStatus`, so an in-flight turn continues
against a recovering or failed connection. Pass the existing event reference
from the host into a panel-owned subscription, cancel unsafe turns, and pin the
existing OMP `session/new` lifecycle invariant.

## Target Files

- `src/ui/aiChatPanel.ts` — add the precisely named optional
  `onDidChangeRecoveryStatus?: vscode.Event<ConnectionRecoveryStatus>` option,
  own its subscription, and fail-close an in-flight turn on `recovering` or
  `failed`.
- `src/extension.ts` — thread the activation-scoped `mgr` (created at line
  207) through the `vsdb.aiChat` registration at lines 628–632 into
  `commandOpenAiChat(aiStore, adapterFactory, aiChatDeps, mgr)`, then at the
  verified panel construction site, lines 1132–1163 (grep:
  `rg -n -C 8 "new AiChatPanel|commandOpenAiChat|onDidChangeRecoveryStatus" src/extension.ts` → `1132: aiChatPanel = new AiChatPanel({`), pass
  `onDidChangeRecoveryStatus: mgr.onDidChangeRecoveryStatus`; never re-import
  or re-create a `ConnectionManager`.
- `src/ai/omp/ompChatEngine.ts` — no behavior change; pin the existing
  `currentSessionId`-cleared invariant with regression tests.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy (recovery subscription) | panel subscribes, receives `recovering`, and visibly enters its existing error session state | fake event holds exactly one listener; emitting `{ connectionId:"c1", state:"recovering", attempt:1, maxAttempts:2 }` posts exactly the existing `{ type:"session_state", state:"error" }` shape, produces no rejection and no `error` message bubble, and leaves prior messages uncorrupted | real `AiChatPanel` test harness with fake `vscode.Event`; idle panel |
| 2 | edge (recovery/builtin) | `recovering` arrives during a builtin turn | the exact status object reaches the panel listener; `handleStop()` aborts the builtin `AbortController`, cancels pending `DbToolPermissionGate` requests, and posts the existing visible `session_state: "error"` rather than a fabricated error message | deferred builtin stream plus recovery fake emits `{ connectionId:"c1", state:"recovering", attempt:1, maxAttempts:2 }` |
| 2b | edge (recovery/no-op) | `recovered` status arrives after `recovering` | NO new cancellation, NO visible-state mutation, NO error message bubble is posted; the panel's prior error-state remains exactly as it was. Matches plan §4 no-op requirement. | recovery fake emits `{ connectionId:"c1", state:"recovered", attempt:2, maxAttempts:2 }` after a `recovering`; capture all panel side-effect channels |
| 3 | edge (recovery/OMP) | `failed` arrives during an OMP-engine turn | the exact status object reaches the panel listener; `OmpChatEngine.cancel()` is invoked once and the panel posts existing visible `session_state: "error"` without an extra error bubble | OMP fake plus recovery fake emits `{ connectionId:"c1", state:"failed", attempt:2, maxAttempts:2 }` |
| 4 | edge (listener containment) | recovery listener throws while handling a status | the listener error is swallowed at the panel subscription boundary; event emission does not throw and no malformed/error message reaches the webview | fake event invokes registered callback around a forced panel handler throw |
| 5 | edge (dispose/re-subscription) | panel dispose releases its recovery subscription; the next host-created panel subscribes anew | old subscription `dispose()` is called exactly once; a later `vsdb.aiChat` construction receives the same `mgr.onDidChangeRecoveryStatus` event reference and registers one fresh listener | extension constructor mock + disposable fake event |
| 6 | regression (pin) | OMP `send` success leaves no stale session id | after settle, a later `cancel()` sends no `session/cancel` | fake `AcpSession` with `notify` spy |
| 7 | regression (pin) | `sessionNew` rejects mid-turn | `onError` fires exactly once; `currentSessionId` is cleared | fake `sessionNew` rejecting |

## Test Files

- `src/ui/__tests__/aiChatPanelDbAware.test.ts` — cases 1–4; reuse its real
  `AiChatPanel`/`DbToolPermissionGate` harness.
- `src/extension.test.ts` — case 5; extend the existing mocked
  `AiChatPanel` constructor-capture tests at the verified chat-command site.
- `src/ai/omp/__tests__/ompChatEngine.test.ts` — cases 6–7.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/aiChatPanelDbAware.test.ts src/extension.test.ts src/ai/omp/__tests__/ompChatEngine.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `AiChatPanelOptions` exposes exactly
      `onDidChangeRecoveryStatus?: vscode.Event<ConnectionRecoveryStatus>`.
      `ConnectionRecoveryStatus` carries exactly `connectionId`, `state`,
      `attempt`, and `maxAttempts`; this unchanged status object is delivered
      to the panel listener.
- [ ] The panel subscribes with
      `this.options.onDidChangeRecoveryStatus((status) => { try { ... } catch { ... } })`,
      owns the returned `vscode.Disposable`, and disposes it during teardown.
      A newly constructed panel after disposal receives a new subscription.
- [ ] `src/extension.ts:628–632` threads the existing activation-scoped `mgr`
      into `commandOpenAiChat`; `src/extension.ts:1132–1163` passes
      `mgr.onDidChangeRecoveryStatus` as that exact option. It does not
      re-import or create a manager.
- [ ] On `recovering` or `failed`, the panel calls the existing `handleStop()`
      path and posts existing visible `session_state: "error"`; it adds no new
      webview message shape and emits no fabricated error text. `recovered`
      cancels nothing and leaves visible state/messages intact.
- [ ] A thrown recovery listener is swallowed; it cannot escape through the
      `ConnectionManager` event emitter.
- [ ] OMP `session/new` exit invariant remains pinned: session id clears on
      success and failure, preventing stale `session/cancel` addressing.
- [ ] `npm run typecheck` exits 0 and `npm run compile` succeeds.

## Dependencies

- (none)

## Interfaces

- Consumes:
  - `ConnectionRecoveryStatus = { readonly connectionId: string; readonly state: "recovering" | "recovered" | "failed"; readonly attempt: number; readonly maxAttempts: number }` from `src/core/connectionManager.ts:56–61`.
  - `ConnectionManager.onDidChangeRecoveryStatus: vscode.Event<ConnectionRecoveryStatus>` from `src/core/connectionManager.ts:89–91`.
  - `vscode.Event<T>` subscription shape used by `src/ui/statusBar.ts:80`:
    `const subRecovery = mgr.onDidChangeRecoveryStatus((s) => renderRecovery(s));`,
    returning a disposable.
  - `AiChatPanelOptions` and `AiChatPanel.handleStop(): void`; `handleStop`
    already aborts builtin turns, cancels `DbToolPermissionGate`, and invokes
    `OmpChatEngine.cancel(): void` for OMP turns.
- Produces:
  - One host-to-panel seam named `onDidChangeRecoveryStatus`, which carries the
    event reference (not a callback direction ambiguity and not a manager).
    The panel's one subscription receives the four-field status object, catches
    listener failures, calls `handleStop()` plus `postSessionState("error")`
    only for `recovering`/`failed`, and ignores `recovered`.

---

## Discussion

### 2026-09-01 · planner · unic-smart
Source grounding: `rg -n -C 8 "new AiChatPanel|commandOpenAiChat|onDidChangeRecoveryStatus" src/extension.ts` reports the live constructor at line 1132; the full option object ends at line 1163. The `mgr` needed for wiring is activation-scoped (`const mgr = new ConnectionManager(...)` at line 207), so this task must thread that reference into `commandOpenAiChat` rather than re-importing/reconstructing it. Existing webview protocol supports `session_state: "error"`; no webview file is in scope.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
  cases 1..4 (src/ui/__tests__/aiChatPanelDbAware.test.ts):
    > AiChatPanel — recovery subscription seam (case 1): expected +0 to be 1
    > AiChatPanel — recovery/builtin turn (case 2): expected "abort" to be called 1 times, but got 0 times
    > AiChatPanel — recovery/no-op (case 2b): expected "abort" to be called 1 times, but got 0 times
    > AiChatPanel — recovery/OMP turn (case 3): expected "spy" to be called 1 times, but got 0 times
  case 5 (src/extension.test.ts):
    > case 5: expected 'undefined' to be 'function' // Object.is equality
  cases 6/7 (src/ai/omp/__tests__/ompChatEngine.test.ts):
    > These two tests pin the existing sessionId-cleared invariant; both passed pre-implementation and continued to pass after — they document the contract being preserved, not a regression being fixed.

Verification Output:
  npx vitest run src/ui/__tests__/aiChatPanelDbAware.test.ts src/extension.test.ts src/ai/omp/__tests__/ompChatEngine.test.ts
    129 passed (129) | Test Files: 3 passed (3)
  npx vitest run src/ui/         (regression sweep)
    1457 passed (1457) | Test Files: 108 passed (108)
  npx vitest run src/ai/omp/ src/extension.test.ts  (broader sweep)
    198 passed | 2 skipped (200) | Test Files: 8 passed | 1 skipped
  npm run typecheck
    exit 0 (no errors)
  npm run compile
    esbuild: build complete (all dist/*.js emitted, no errors)

Status: PASS
Note: All 7 test cases green; existing test suite unaffected; build clean.

## Reviewer Verdict
VERDICT: changes_requested
REVIEWER_MODEL: unic-smart
EXECUTOR_MODEL: unic-code
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important:
    - src/ui/__tests__/aiChatPanelDbAware.test.ts:553 — case 4 assigns a nonexistent `recoveryHandler` property; the subscribed callback still calls `handleRecoveryStatus`, so no throw reaches its catch wrapper. Invoke a throwing handler through the registered callback and assert `fire()` does not throw and posts nothing.
    - src/ui/__tests__/aiChatPanelDbAware.test.ts:423 — case 2 only mutates private abort fields; it never creates a pending `DbToolPermissionGate` request or verifies recovery cancels it. Add a deferred builtin turn with a pending gate request and assert the cancelled result.
    - src/extension.test.ts:1388 — case 5 invokes only a mocked panel's `onDispose` callback and never calls a real panel teardown or checks the event disposable. Exercise real disposal, assert the first subscription disposes exactly once, then assert a new panel registers one fresh listener.
  minor: none
NEXT_STATUS_FOR_INDEX: changes_requested

## Executor Report (fix round 1)
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT (each finding proven via mutation of the reviewed behavior — the strengthened test fails against mutated source and the OLD test demonstrably passed, proving the gap):
  finding 1 (case 4, listener containment):
    Mutation: constructor subscription try/catch removed (listener throws escape to the emitter).
    OLD test result under mutation: PASS (vacuous — assigned a nonexistent `recoveryHandler` field; the real handler never threw).
    NEW test result under mutation:
      FAIL src/ui/__tests__/aiChatPanelDbAware.test.ts > AiChatPanel — listener containment (TASK-AIX03-102 case 4) > recovery listener throws → the throw is swallowed at the subscription boundary; no message reaches the webview
        → AssertionError: expected true to be false // Object.is equality   (threw === true: the escape reached the emitter)
  finding 2 (case 2, recovery/builtin + pending gate):
    Mutation: `handleStop()` no longer calls `this.dbToolGate.cancelAll()`.
    OLD test result under mutation: PASS (gap proven — it never created a pending gate request).
    NEW test result under mutation:
      FAIL src/ui/__tests__/aiChatPanelDbAware.test.ts > AiChatPanel — recovery/builtin turn (TASK-AIX03-102 case 2) > …
        → AssertionError: expected true to be false // Object.is equality   (late gate.respond() still accepted ⇒ pending request was NOT cancelled)
    Second mutation (recovery handler skips handleStop entirely):
        → AssertionError: expected "abort" to be called 1 times, but got 0 times
  finding 3 (case 5, real dispose/re-subscription):
    Mutation: `teardown()` no longer disposes `recoverySub`.
    NEW test result under mutation:
      FAIL src/extension.test.ts > TASK-011 (B3) … > case 5: real panel dispose releases its recovery subscription; the next panel re-subscribes on the same mgr event
        → AssertionError: expected +0 to be 1 // Object.is equality   (subDisposeCalls === 0 after real dispose())

Verification Output:
  npx vitest run src/ui/__tests__/aiChatPanelDbAware.test.ts src/extension.test.ts src/ai/omp/__tests__/ompChatEngine.test.ts
    129 passed (129) | Test Files: 3 passed (3)
  npx vitest run src/ui/ (regression sweep)
    1457 passed (1457) | Test Files: 108 passed (108)
  npx vitest run src/ai/omp/ src/extension.test.ts
    198 passed | 2 skipped (200)
  npm run typecheck
    exit 0 (no errors)
  npm run compile
    esbuild: build complete

Status: PASS
Note: All three IMPORTANT findings fixed as test-only changes (no production edit needed, per reviewer prediction): case 2 now drives a REAL deferred builtin turn with a pending DbToolPermissionGate request and asserts abort + gate-cancel + session_state:error; case 4 provokes a real synchronous throw through the registered callback (throwing gate stub) and asserts fire() swallows it posting nothing; case 5 subclasses the REAL AiChatPanel, exercises real teardown via dispose(), asserts the recovery subscription's dispose() runs exactly once and the next panel registers one fresh listener on the SAME counting-wrapped mgr event reference (doMock restored afterward to prevent leakage).
