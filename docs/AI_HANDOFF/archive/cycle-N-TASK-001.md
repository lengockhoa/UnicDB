# TASK-001 — Provider SSE streaming (streamComplete)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.A + §7

## Goal

Add `streamComplete(req, opts)` to the `createProviderClient` return — OpenAI-compatible `/chat/completions` with `stream:true`, hand-written SSE parser (no new dependencies), fetch injected the same way as the existing `complete()` so unit tests never touch the network.

## Target Files

- `src/ai/provider.ts` — add the `StreamTextEvent`, `StreamRequestOptions` types, the `streamComplete` method on the object returned by `createProviderClient` (keep `complete` untouched).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit (happy) | streamComplete SSE happy: 3 data chunks + `data: [DONE]` | `onText` receives `"Hel"`, `"lo"`, `"!"` in order; result `{text:"Hello!", toolCalls:[], finishReason:"stop", usage:{inputTokens:7, outputTokens:5}}` | fake fetch returns `new Response(sseBody, {status:200, headers:{"Content-Type":"text/event-stream"}})` with body = a multi-event SSE string |
| 2 | edge (malformed) | 1 data line fails JSON.parse + 1 event missing `choices` | bad event is skipped, good events still trigger `onText`; does NOT throw; text = only the good event part | SSE body: `data: {bad json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]` + 1 event `data: {}` |
| 3 | edge (boundary) | chunk boundary cut mid UTF-8 char + cut mid line + event with 2 `data:` lines | all fragments received in order, no duplication/loss; multi-line data concat with `\n` before parse | fake fetch returns a manually-pumped ReadableStream: chunk `"data: {\"choices\":[\"delta\":{\"content\":\"plain ASCII text\"}}]}"` cut mid-byte of an accented Latin char (multi-byte UTF-8), then `\n\ndata: [DONE]\n\n` in the next chunk |
| 4 | edge (error) | HTTP 401 stream | throw `ProviderError` with `status:401`, `bodySnippet` apiKey scrubbed (`***`), message does not contain apiKey | fake fetch returns 401 body containing key `sk-secret-123` |
| 5 | edge (non-SSE) | HTTP 200 but body is regular JSON (non-stream response) | throw `ProviderError` (invalid SSE/stream shape) — no onText, no crash | fake fetch `jsonResponse({choices:[...]})` |
| 6 | edge (abort) | `opts.signal` aborted mid-stream → reject AbortError, NOT wrapped in ProviderError | rejects with error `name === "AbortError"`, `err instanceof ProviderError === false`; no onText after abort | fake fetch receives `opts.signal`; stream pump: enqueue 1 good chunk, `signal.addEventListener("abort", () => c.error(abortErr()))` with `abortErr = Object.assign(new Error("stream aborted"), {name:"AbortError"})`; test abort() after a tick |
| 7 | regression | `complete()` non-stream behavior unchanged | the 3 existing tests (#1 request shape, #8 timeout, #10 scrub) still pass untouched — no edits to existing tests | existing suite |

How to write a fake ReadableStream: `new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(chunk)); ... c.close();}})` — Node 18 undici supports it; see the `makeFetch`/`jsonResponse` pattern at the top of `src/ai/__tests__/provider.test.ts` (existence verified).

## Test Files

- `src/ai/__tests__/provider.test.ts` — append a new describe block `provider — streamComplete` (the 7 cases above; case 7 = re-run the existing selection).
- `src/ai/__tests__/agent.test.ts` — do NOT edit logic; only add a type import if needed once `AgentDeps` expands (TASK-002 expands it — this task does not touch agent.test.ts).

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts
```

## Acceptance Criteria

- [ ] Every test in §Test Cases PASSES (RED before implementation, GREEN after).
- [ ] No regression in the existing `provider.test.ts` (case 6).
- [ ] No new dependency (`package.json` has no diff).
- [ ] `complete()` behavior + existing public types unchanged.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — current provider.ts, especially `FetchLike`, `ProviderRequest`, `ProviderResult`, `ProviderError`, `buildChatCompletionsBody`, `parseChatCompletionsResponse`, `createProviderClient` all already exist, verified).
- Produces (consumed by TASK-002 — EXACT signature):
  ```ts
  export interface StreamTextEvent { text: string; }
  export interface StreamRequestOptions {
    onText(ev: StreamTextEvent): void;   // once per delta content chunk
    signal?: AbortSignal;                // aborted mid-stream → reject Error name "AbortError" (fetch abort throws on its own; NOT wrapped in ProviderError)
  }
  // include_usage decision: do NOT send `stream_options:{include_usage:true}` — not
  // universally supported by OpenAI-compatible servers (some reject the request).
  // usage comes from the `usage` field of the final chunk IF the server sends it, else {inputTokens:0, outputTokens:0}.
  // on the object returned by createProviderClient:
  streamComplete(req: ProviderRequest, opts: StreamRequestOptions): Promise<ProviderResult>;
  ```
  `streamComplete` with method `responses` → throw `new Error("streaming not supported for method responses")` (the caller decides not to call it).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Implementation note: `tsconfig` has not been verified for the `dom` lib for `ReadableStreamDefaultReader` — if typecheck complains, declare a local structural type (`interface BodyReader { read(): Promise<{done:boolean; value?:Uint8Array}>; releaseLock():void }`) instead of importing lib.dom. Do NOT add a lib to tsconfig because it may affect typechecking of the whole repo. Fallback when `resp.body === null` → read `resp.text()` and slice events from the string (no new network path).


## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -

### RED evidence (verbatim, captured before GREEN)

```
FAIL  src/ai/__tests__/provider.test.ts > provider — streamComplete (#1 happy) > emits onText per delta chunk, final result with usage from last chunk
TypeError: client.streamComplete is not a function
 ❯ src/ai/__tests__/provider.test.ts:472:33
[2/6] #2 malformed events → TypeError: client.streamComplete is not a function
[3/6] #3 chunk boundaries  → TypeError: client.streamComplete is not a function
[4/6] #4 HTTP 401         → AssertionError: expected TypeError to be an instance of ProviderError
[5/6] #5 non-SSE 200      → AssertionError: expected TypeError to be an instance of ProviderError
[6/6] #6 abort            → AssertionError: expected TypeError to be AbortError
Test Files  1 failed (1)
Tests  6 failed | 15 skipped (21)
```

### GREEN verification

command: `npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts`
result: typecheck exit 0; 33/33 tests pass (21 provider + 12 agent), 0 fail
output_excerpt:
```
> UnicDB@1.5.1 typecheck
> tsc --noEmit
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB
 ✓ src/ai/__tests__/agent.test.ts  (12 tests) 5ms
 ✓ src/ai/__tests__/provider.test.ts  (21 tests) 9ms
 Test Files  2 passed (2)
      Tests  33 passed (33)
```

### Files Changed

- `src/ai/provider.ts`: added `StreamTextEvent`, `StreamRequestOptions`; extended `createProviderClient` return with `streamComplete(req, opts)`. Hand-written SSE parser (TextDecoder stream, \n\n event split, multi-line `data:` join with `\n`, malformed-event skip, [DONE] sentinel). Streams `delta.content` to `onText`; collects `finish_reason` and `usage` from final chunks; throws `ProviderError` for non-2xx (apiKey scrubbed) and for non-`text/event-stream` content-type; AbortError surfaces bare (not wrapped). `method:"responses"` → throws `Error("streaming not supported for method responses")` synchronously. `complete()` unchanged.
- `src/ai/__tests__/provider.test.ts`: appended 6 describe blocks for `streamComplete` (cases 1, 2, 3, 4, 5, 6 from §Test Cases). Case 7 regression covered by existing tests still passing unchanged.

### Tests Added

- `src/ai/__tests__/provider.test.ts`: `provider — streamComplete (#1 happy)`, `(#2 malformed events)`, `(#3 chunk boundaries + multi-line data)`, `(#4 HTTP 401)`, `(#5 non-SSE 200)`, `(#6 abort mid-stream)`.

### Issues

none — frozen interfaces preserved; no new dependencies (`package.json`/`package-lock.json` unchanged); `complete()` behavior + public types unchanged.
---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic-smart (matches .ukit/storage/config.json handoff.reviewer.model)
EXECUTOR_MODEL: unic-code (differs from reviewer — isolation OK)
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts
  result: typecheck exit 0; 33/33 pass (0 fail) — fresh re-run PASS
TEST_PLAN_COVERAGE: all-followed (7/7; case 7 = 15 pre-existing tests unchanged and passing; RED output verbatim with real stack traces)
FINDINGS:
  critical:
    - none
  important:
    - file: src/ai/provider.ts:541 — CRLF-only SSE bodies never split: boundary search is literal `buffer.indexOf("\n\n")`, and `\r\n\r\n` contains no `\n\n` substring, so a server using CRLF line endings (legal per SSE spec) yields ZERO events → throws "invalid SSE/stream shape: no events parsed" (reproduced: scratch test with `\r\n\r\n` separators → ProviderError). The comment at :545 ("Some servers use \r\n\r\n") only handles `\r` inside events, not the boundary. Fix: in the main loop AND the trailing-flush path, find the earliest of `indexOf("\r\n\r\n")` and `indexOf("\n\n")` and slice by the matched delimiter length; add a CRLF-only-body test.
    - file: src/ai/provider.ts:470-479 — caller `opts.signal` abort during the fetch phase (before headers arrive) is caught and rethrown as `ProviderError("request timed out after 60000ms")`, violating the frozen contract "abort → reject Error name AbortError, NOT wrapped in ProviderError" (reproduced: observed rejection name "ProviderError", not "AbortError"; also mislabels a user abort as a timeout). Fix: in the fetch catch, when `err.name === "AbortError"`, rethrow bare if `streamOpts.signal?.aborted`, else throw the timeout ProviderError.
  minor:
    - file: src/ai/provider.ts:530-534 — converse of the above: an internal-timeout abort surfacing mid-read is rethrown bare as AbortError (indistinguishable from user abort). The same `streamOpts.signal?.aborted` disambiguation in the read-phase catch fixes it (timeout → ProviderError timeout:true).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Happy path, malformed-event skip, UTF-8/mid-line splits, 401 scrub, non-SSE 200, and mid-stream abort all conform and pass fresh. No scope creep (git stat: provider.ts +255/-0, test +216/-1 where -1 is only an EOF-newline fix); no new deps; no vscode import. The two important findings are narrow fixes in streamComplete error/boundary handling.
---

## Executor Report (fix round 1)

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: FixN-T001

### Scope

Fix review findings (important #1 CRLF, important #2 fetch-phase abort, minor read-phase abort disambiguation) in `src/ai/provider.ts`. No new deps, no `complete()` change, no public type change.

### RED evidence (verbatim, captured before GREEN)

```
FAIL  src/ai/__tests__/provider.test.ts > provider — streamComplete (CRLF body regression) > parses events when server uses \r\n\r\n separators (legal SSE per spec)
ProviderError: invalid SSE/stream shape: no events parsed
 ❯ Object.streamComplete src/ai/provider.ts:649:15

FAIL  src/ai/__tests__/provider.test.ts > provider — streamComplete (caller abort during fetch phase) > rejects with bare AbortError (name AbortError, not ProviderError) when caller signal aborts before response headers arrive
AssertionError: expected ProviderError to be AbortError // Object.is equality
- Expected
+ Received
- AbortError
+ ProviderError
 ❯ src/ai/__tests__/provider.test.ts:709:24
Test Files  1 failed (1)
     Tests  2 failed | 21 skipped (23)
```

### GREEN verification (fresh re-run in this turn)

command: `npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts`
result: typecheck exit 0; 35/35 tests pass (0 fail) — fresh re-run PASS (33 previous + 2 new regression tests)
output_excerpt:
```
> UnicDB@1.5.1 typecheck
> tsc --noEmit
 ✓ src/ai/__tests__/agent.test.ts  (12 tests) 5ms
 ✓ src/ai/__tests__/provider.test.ts  (23 tests) 8ms
 Test Files  2 passed (2)
     Tests  35 passed (35)
```

### Files Changed

- `src/ai/provider.ts`:
  - SSE main loop now finds the earliest of `buffer.indexOf("\r\n\r\n")` and `buffer.indexOf("\n\n")` and slices by the matched delimiter length (4 vs 2). `rawEvent.split(/\r?\n/)` already handles CRLF line endings inside the event. Trailing-flush already handles CRLF line endings via `/\r?\n/` so no change needed there.
  - Fetch-phase catch (`:467-490`): when `err.name === "AbortError"`, check `streamOpts.signal?.aborted` — if true, rethrow original `e` bare (or wrap minimally if not an Error) so the name stays "AbortError" and it is not a ProviderError; otherwise throw timeout ProviderError.
  - Read-phase catch (`:534-553`): same disambiguation — caller abort surfaces bare AbortError; internal timeout → ProviderError timeout:true.
- `src/ai/__tests__/provider.test.ts`:
  - Appended describe `provider — streamComplete (CRLF body regression)` (CRLF-only happy path).
  - Appended describe `provider — streamComplete (caller abort during fetch phase)` (fetch-rejection with AbortError name, signal forwarded, expected bare AbortError + not ProviderError).

### Tests Added

- `src/ai/__tests__/provider.test.ts`: `parses events when server uses \r\n\r\n separators (legal SSE per spec)`, `rejects with bare AbortError (name AbortError, not ProviderError) when caller signal aborts before response headers arrive`.

### Issues

none — frozen interfaces preserved; no new dependencies (`package.json`/`package-lock.json` unchanged); `complete()` behavior + public types unchanged; pre-existing 33 tests still pass; new 2 regression tests pass; typecheck clean.
---

---

## Reviewer Verdict (re-review, fix round 1)

VERDICT: APPROVED
REVIEWER_MODEL: unic-smart (matches handoff.reviewer.model)
EXECUTOR_MODEL: unic-code (differs — isolation OK)
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts
  result: typecheck exit 0; 35/35 pass (0 fail) — fresh re-run PASS
TEST_PLAN_COVERAGE: all-followed (7/7 original + both fix-round regression tests, RED evidence verbatim with real assertion/stack output)
FINDINGS:
  critical:
    - none
  important:
    - none — both prior findings fixed and verified: (1) CRLF boundary now finds earliest of \r\n\r\n / \n\n and slices by matched delimiter length (provider.ts:565-575); CRLF-only-body regression test added. (2) fetch-phase AbortError checks streamOpts.signal?.aborted and rethrows bare (:470-478); fetch-phase regression test added. Read-phase disambiguation (prior minor) also fixed (:537-545).
  minor:
    - none
NEXT_STATUS_FOR_INDEX: approved
NOTES: No contract drift — stream_options still omitted, usage defaults {0,0}, no vscode import (file has zero import statements), no new deps (package.json/package-lock.json clean in git status). Diff is additive-only (+282/−0 in provider.ts); complete() untouched. AbortError wrapping at :373 is pre-existing complete() code, explicitly out of scope per contract "complete() behavior unchanged".
