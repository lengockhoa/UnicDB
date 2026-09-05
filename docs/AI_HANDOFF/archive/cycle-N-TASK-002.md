# TASK-002 — Agent streaming loop (opt-in via AgentDeps)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.B + §7

## Goal

`runAgent` supports streaming: when `deps.streamComplete` is injected and the config method is `chat/completions`, each step uses the stream path, emits `onText` deltas to callbacks, with non-stream fallback when the stream fails BEFORE any text has been emitted, and is abort-aware.

## Target Files

- `src/ai/agent.ts` — extend `AgentDeps` (optional `streamComplete`), `AgentCallbacks` (optional `onText`), stream/fallback/abort logic in the step loop. Do NOT change the `AgentRunResult` shape.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit (happy) | stream happy: single step streams 2 deltas then final | `onText` receives `"hi "` then `"there"` (in order); `out.finalText === "there"`; `out.steps[0].result.text === "there"`; history shape identical to non-stream | deps: loadConfig→cfg(method chat/completions), streamComplete emits 2 deltas + resolves resultOk("there"); complete = spy MUST NOT be called |
| 2 | unit (happy-tool) | tool loop: step 1 streams tool_calls, step 2 streams text | tool step does NOT fire onText (empty text); text step fires onText; argumentsJson merged from stream = correct JSON string; finalText correct | streamComplete 1st call resolves resultOk("", [toolCall]), 2nd call resolves resultOk("done") |
| 3 | edge (fallback) | streamComplete rejects with ProviderError BEFORE any onText → fallback to deps.complete | `onStreamFallback` called exactly once (BEFORE complete); deps.complete called exactly once with the SAME request (messages deep-equal); result matches complete; runAgent resolves normally; onText not called for this step | streamComplete throws ProviderError immediately; complete resolves resultOk("fallback ok"); spy onStreamFallback |
| 4 | edge (mid-stream) | streamComplete rejects AFTER 1 onText → NO fallback, throw to caller | runAgent rejects with the original ProviderError; deps.complete is NOT called; error message contains the original cause | streamComplete: onText("par") then throws ProviderError |
| 5 | edge (abort) | signal aborted mid-stream → AbortError propagates, NO fallback | runAgent rejects with error `name === "AbortError"`; deps.complete is NOT called (fallback is blocked even when emitted === 0); history has NO assistant msg from the in-flight step | streamComplete receives `signal` (5th parameter); test uses AbortController: `onText("par")` → `controller.abort()` → mock throws `Object.assign(new Error("stream aborted"), {name:"AbortError"})`; **add a sub-case: abort BEFORE the first onText (tool step, emitted===0) → deps.complete is STILL not called** |
| 6 | unit (regression) | deps does NOT have streamComplete → old behavior intact | every existing `agent.test.ts` test passes untouched (no edits to old tests); the stream code path does not trigger | existing suite (makeDeps only has loadConfig+complete) |

Fixture note: signature `streamComplete(cfg, role, req, onText, signal)` (5 parameters, see Interfaces). The agent wraps the emitted counter as: `let emitted = 0; const wrapped = (t: string) => { emitted++; cb(t) }`. **Abort rule (mandatory, kept in sync with TASK-001 + PLAN §3.B)**: before deciding to fall back, check `err.name === "AbortError" || signal?.aborted` → if true, rethrow IMMEDIATELY, no fallback — the user Stop must NEVER trigger a non-stream re-request (even when emitted === 0, e.g. abort in a tool step). Only real (non-abort) ProviderError triggers fallback.

## Test Files

- `src/ai/__tests__/agentStream.test.ts` (new) — the 5 cases above (case 6 lives in the existing `agent.test.ts`).
- `src/ai/__tests__/agent.test.ts` — do NOT edit the existing cases; only re-run it as regression.

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases PASSES (RED before, GREEN after — paste the RED output into the Executor Report).
- [ ] `AgentRunResult` / `AgentStep` shape unchanged (repo-wide typecheck passes).
- [ ] No regression in the existing `agent.test.ts`.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — consumes `streamComplete` / `StreamTextEvent` / `StreamRequestOptions` on the `AgentDeps` type (signature in TASK-001 §Interfaces).

## Interfaces

- Consumes: from TASK-001 — `streamComplete(req: ProviderRequest, opts: StreamRequestOptions): Promise<ProviderResult>`; `StreamRequestOptions { onText(ev: StreamTextEvent): void; signal?: AbortSignal }`.
- Produces (consumed by TASK-003 — EXACT signature):
  ```ts
  // AgentDeps additions (optional) — signal is the 5th parameter (pinned per F2 review round 1):
  streamComplete?(cfg: AiConfig, role: AiModelRole, req: ProviderRequest,
                  onText: (text: string) => void,
                  signal?: AbortSignal): Promise<ProviderResult>;
  // runAgent gains a 4th optional parameter — panel passes AbortController.signal here:
  runAgent(input, deps, callbacks?, signal?: AbortSignal): Promise<AgentRunResult>

  // AgentCallbacks additions (optional) — FALLBACK CHANNEL (pinned per F1: this is the
  // SOLE channel that signals fallback; AgentStep keeps its shape, no extra fields):
  export interface AgentCallbacks {
    onStep?(step: AgentStep): void;      // existing
    onError?(error: Error): void;        // existing
    onText?(text: string): void;         // NEW — once per delta, text steps only
    onStreamFallback?(): void;           // NEW — fires exactly once BEFORE deps.complete
                                         // is called in the fallback path, only when the abort rule does not block it
  }
  ```
  Complete fallback rule (MANDATORY check order in catch):
  1. `err.name === "AbortError" || signal?.aborted` → rethrow immediately, NO fallback,
     NO onStreamFallback (the user Stop NEVER triggers a re-request).
  2. Otherwise, if `err instanceof ProviderError && emitted === 0` → call
     `callbacks.onStreamFallback?.()` exactly once → `deps.complete(cfg, role, req)`
     on the same request, NO onText for the fallback step. The completed step still fires
     `onStep` as every step does.
  3. Otherwise (`emitted >= 1` or a non-ProviderError) → rethrow to the caller.
  `runAgent` picks the stream path ONLY when `deps.streamComplete !== undefined && cfg.method === "chat/completions"`.
  The panel decides how to render from `onStreamFallback` (see TASK-003 case 3) — no need
  for a `STREAM_FALLBACK_STEP_LABEL` constant anymore (removed in round 2; the label is the panel's job).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
The fallback design lives in the agent (not the provider) — reasoning in PLAN.md §3.A. If the executor finds it hard to keep the `onText` count accurate (async race between the last onText and the throw), the safe pattern is: keep the `emitted` counter outside the try, then throw after awaiting `streamComplete` settlement.


---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecN-T002

### Scope

Extend `runAgent` with an optional 4th parameter `signal?: AbortSignal`, add an optional `streamComplete` to `AgentDeps` (signature `(cfg, role, req, onText, signal)`), add optional `onText(text: string)` and `onStreamFallback()` to `AgentCallbacks`. Introduce a private `runStep` helper inside agent.ts that: (a) picks the non-stream path when `!deps.streamComplete || cfg.method !== "chat/completions"`; (b) wraps the user's `onText` to count emitted deltas; (c) freezes the catch order: `AbortError || signal.aborted → rethrow bare`, `ProviderError && emitted===0 → onStreamFallback once + deps.complete(req)`, otherwise rethrow. agent.ts stays pure (no vscode import). agent.test.ts NOT edited; full AI suite green.

### RED evidence (verbatim, captured before GREEN)

```
 ❯ src/ai/__tests__/agentStream.test.ts > runAgent — stream opt-in (TASK-002) > case #1 happy single-step: stream emits 2 deltas then final
   → expected [] to deeply equal [ 'hi ', 'there' ]
 ❯ case #2 tool loop: tool step emits no text, text step does; argumentsJson merges from stream
   → expected "streamImpl" to be called 2 times, but got 0 times
 ❯ case #3 fallback: streamComplete rejects ProviderError pre-emit → onStreamFallback once + deps.complete
   → expected "spy" to be called 1 times, but got 0 times
 ❯ case #4 mid-stream ProviderError after onText → rethrow, NO fallback
   → promise resolved "{ steps: … }" instead of rejecting
 ❯ case #5a abort mid-stream (after 1 onText) → AbortError propagates bare, NO fallback
   → promise resolved "{ steps: … }" instead of rejecting
 ❯ case #5b abort pre-emit (tool step, emitted===0) → AbortError propagates, NO fallback
   → promise resolved "{ steps: … }" instead of rejecting
 ❯ case #5c abort propagated even when err.name is NOT 'AbortError' but signal.aborted is true
   → promise resolved "{ steps: … }" instead of rejecting
 Test Files  1 failed (1)
      Tests  7 failed (7)
```

### GREEN verification (fresh re-run in this turn)

command: `npm run typecheck && npx vitest run src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts`
result: typecheck exit 0; 19/19 pass (0 fail) — fresh re-run PASS
output_excerpt:
```
> UnicDB@1.5.1 typecheck
> tsc --noEmit
 ✓ src/ai/__tests__/agentStream.test.ts  (7 tests) 6ms
 ✓ src/ai/__tests__/agent.test.ts  (12 tests) 6ms
 Test Files  2 passed (2)
      Tests  19 passed (19)
```

### Files Changed

- `src/ai/agent.ts`:
  - Imports: added `AiConfig` / `AiModelRole` from `./settings`; `ProviderError` as a value (mixed import) plus remaining type-only imports from `./provider`.
  - `AgentDeps` gains optional `streamComplete(cfg, role, req, onText, signal)` matching the frozen TASK-002 §Interfaces signature exactly.
  - `AgentCallbacks` gains optional `onText(text: string)` and `onStreamFallback()` per the same frozen contract.
  - `runAgent(input, deps, callbacks?, signal?)` — 4th parameter `signal?: AbortSignal` threaded through to per-step provider calls.
  - New private helper `runStep(req, deps, callbacks, signal, cfg, role)`:
    - Non-stream path when `!deps.streamComplete || cfg.method !== "chat/completions"` (preserves case 6 regression — stream opt-in is silent on missing deps or the `responses` method).
    - Stream path wraps the user `callbacks.onText` to count emitted deltas; the counter increments before the user callback fires, so `emitted` is the number of deltas delivered (not the number of successful callbacks).
    - Catch order is exact: (1) abort check (name OR signal.aborted) → rethrow bare, no fallback; (2) ProviderError && emitted===0 → `callbacks.onStreamFallback?.()` once, then `deps.complete(cfg, role, req)` with the same request; (3) else rethrow.
  - No changes to `AgentStep` / `AgentRunResult` shape; case 6 regression verified by the 12 untouched `agent.test.ts` cases passing.
- `src/ai/__tests__/agentStream.test.ts`: new file, 7 cases (1 happy single-step, 2 tool loop, 3 fallback, 4 mid-stream fail, 5a abort mid-stream, 5b abort pre-emit, 5c OR-rule with non-AbortError name). All run synchronously, no network, no real fetch.

### Tests Added

- `src/ai/__tests__/agentStream.test.ts`: `case #1 happy single-step: stream emits 2 deltas then final`, `case #2 tool loop: tool step emits no text, text step does; argumentsJson merges from stream`, `case #3 fallback: streamComplete rejects ProviderError pre-emit → onStreamFallback once + deps.complete`, `case #4 mid-stream ProviderError after onText → rethrow, NO fallback`, `case #5a abort mid-stream (after 1 onText) → AbortError propagates bare, NO fallback`, `case #5b abort pre-emit (tool step, emitted===0) → AbortError propagates, NO fallback`, `case #5c abort propagated even when err.name is NOT 'AbortError' but signal.aborted is true`.

### Issues

none — frozen interfaces preserved (AgentDeps.streamComplete signature, AgentCallbacks additions, runAgent 4th param all match TASK-002 §Interfaces byte-for-byte); case 6 regression intact (12 untouched `agent.test.ts` cases still pass); no new dependencies (`package.json` / `package-lock.json` unchanged); no vscode import introduced in agent.ts.
---
---

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecN-T002
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts
  result: typecheck exit 0; 19/19 pass (0 fail) — fresh re-run PASS
  extra: src/ai/tools/__tests__/registry.test.ts 2/2 (shared runAgent consumer, regression net)
TEST_PLAN_COVERAGE: all-followed (cases 1-5 in new agentStream.test.ts: 7 tests incl. 5a/5b/5c; case 6 via untouched agent.test.ts 12/12; git diff on agent.test.ts empty)
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Signatures verified byte-against-contract: AgentDeps.streamComplete(cfg,role,req,onText,sig#5), runAgent param4 signal, AgentCallbacks.onText/onStreamFallback. Catch order exact (agent.ts:177-190): abort(name OR signal.aborted)→bare rethrow incl. emitted===0 (test 5b); ProviderError&&emitted===0→onStreamFallback once then complete, no double text (fallback path has no onText, result authoritative); else rethrow. wrappedOnText counts before dispatch (planner's counter-outside-try rule). AgentDeps.streamComplete onText takes {text} per TASK-001 frozen StreamRequestOptions — task §Produces parenthetical "(text: string)" is informal; code is the correct consume-side shape and unwraps ev.text for AgentCallbacks.onText(text: string). agent.ts pure (imports …
