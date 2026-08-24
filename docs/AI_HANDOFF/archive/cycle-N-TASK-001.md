# TASK-001 — Provider SSE streaming (streamComplete)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.A + §7

## Goal

Thêm `streamComplete(req, opts)` vào `createProviderClient` return — OpenAI-compatible
`/chat/completions` với `stream:true`, parse SSE thủ công (không dependency mới), inject
fetch như `complete()` hiện tại để unit test không chạm network.

## Target Files

- `src/ai/provider.ts` — thêm types `StreamTextEvent`, `StreamRequestOptions`, method
  `streamComplete` trên object return của `createProviderClient` (giữ `complete` nguyên vẹn).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | streamComplete SSE happy: 3 data chunk + `data: [DONE]` | `onText` lần lượt nhận `"Hel"`, `"lo"`, `"!"`; result `{text:"Hello!", toolCalls:[], finishReason:"stop", usage:{inputTokens:7, outputTokens:5}}` | fetch fake trả `new Response(sseBody, {status:200, headers:{"Content-Type":"text/event-stream"}})` với body = chuỗi SSE nhiều event |
| 2 | edge (malformed) | 1 data line JSON.parse fail + 1 event thiếu `choices` | event xấu bị skip, event tốt vẫn `onText`; KHÔNG throw; text = chỉ phần event tốt | SSE body: `data: {bad json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]` + 1 event `data: {}` |
| 3 | edge (boundary) | chunk boundary cắt giữa UTF-8 char + cắt giữa line + event có 2 dòng `data:` | đủ fragment đúng thứ tự, không lặp/không mất; multi-line data concat bằng `\n` trước parse | fetch fake trả ReadableStream pump thủ công: chunk `"data: {\"choices\":[{\"delta\":{\"content\":\"hél\"}}]}"` cắt giữa bytes của `é`, sau đó `\n\ndata: [DONE]\n\n` ở chunk sau |
| 4 | edge (error) | HTTP 401 stream | throw `ProviderError` với `status:401`, `bodySnippet` đã scrub apiKey (`***`), message không chứa apiKey | fetch fake trả 401 body chứa key `sk-secret-123` |
| 5 | edge (non-SSE) | HTTP 200 nhưng body là JSON thường (non-stream response) | throw `ProviderError` (invalid SSE/stream shape) — KHÔNG onText, không crash | fetch fake `jsonResponse({choices:[...]})` |
| 6 | edge (abort) | `opts.signal` aborted giữa stream → reject AbortError, KHÔNG bọc ProviderError | reject với error `name === "AbortError"`, `err instanceof ProviderError === false`; không onText sau abort | fetch fake nhận `opts.signal`; stream pump: enqueue 1 chunk tốt, `signal.addEventListener("abort", () => c.error(abortErr()))` với `abortErr = Object.assign(new Error("stream aborted"), {name:"AbortError"})`; test abort() sau tick |
| 7 | regression | `complete()` non-stream không đổi | 3 test hiện có (#1 request shape, #8 timeout, #10 scrub) vẫn pass nguyên — không edit test cũ | existing suite |

Cách viết fake ReadableStream: `new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(chunk)); ... c.close();}})` — Node 18 undici hỗ trợ; tham khảo pattern `makeFetch`/`jsonResponse` ở đầu `src/ai/__tests__/provider.test.ts` (đã verify tồn tại).

## Test Files

- `src/ai/__tests__/provider.test.ts` — append describe block mới `provider — streamComplete` (7 cases trên; case 7 = chạy lại selection có sẵn).
- `src/ai/__tests__/agent.test.ts` — KHÔNG sửa logic; chỉ thêm type import nếu cần khi `AgentDeps` mở rộng (TASK-002 mới mở rộng — task này không đụng agent.test.ts).

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước khi implement, GREEN sau).
- [ ] Không regression ở `provider.test.ts` cũ (case 6).
- [ ] Không dependency mới (`package.json` không diff).
- [ ] `complete()` behavior + public types cũ không đổi.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — provider.ts hiện tại, đặc biệt `FetchLike`, `ProviderRequest`, `ProviderResult`, `ProviderError`, `buildChatCompletionsBody`, `parseChatCompletionsResponse`, `createProviderClient` đều đã tồn tại, verified)
- Produces (TASK-002 tiêu thụ — chữ ký CHÍNH XÁC):
  ```ts
  export interface StreamTextEvent { text: string; }
  export interface StreamRequestOptions {
    onText(ev: StreamTextEvent): void;   // mỗi delta content chunk một lần
    signal?: AbortSignal;                // aborted giữa stream → reject Error name "AbortError" (fetch abort tự ném sẵn; KHÔNG bọc ProviderError)
  }
  // Quyết định include_usage: KHÔNG gửi `stream_options:{include_usage:true}` — không
  // universally supported bởi các server OpenAI-compatible (một số reject request).
  // usage lấy từ `usage` field của chunk cuối NẾU server tự gửi, else {inputTokens:0, outputTokens:0}.
  // trên object return của createProviderClient:
  streamComplete(req: ProviderRequest, opts: StreamRequestOptions): Promise<ProviderResult>;
  ```
  `streamComplete` với method `responses` → throw `new Error("streaming not supported for method responses")` (caller quyết định không gọi).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Lưu ý implementation: `tsconfig` chưa verify có `dom` lib cho `ReadableStreamDefaultReader` — nếu typecheck complain, khai báo structural type local (`interface BodyReader { read(): Promise<{done:boolean; value?:Uint8Array}>; releaseLock():void }`) thay vì import lib.dom. KHÔNG thêm lib vào tsconfig vì có thể ảnh hưởng typecheck toàn repo. Fallback `resp.body === null` → đọc `resp.text()` rồi cắt event từ chuỗi (không path network mới).


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
[6/6] #6 abort            → AssertionError: expected 'TypeError' to be 'AbortError'
Test Files  1 failed (1)
Tests  6 failed | 15 skipped (21)
```

### GREEN verification

command: `npm run typecheck && npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts`
result: typecheck exit 0; 33/33 tests pass (21 provider + 12 agent), 0 fail
output_excerpt:
```
> vsdb@1.5.1 typecheck
> tsc --noEmit
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB
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
    - file: src/ai/provider.ts:470-479 — caller `opts.signal` abort during the fetch phase (before headers arrive) is caught and rethrown as `ProviderError("request timed out after 60000ms")`, violating the frozen contract "abort → reject Error name 'AbortError', KHÔNG bọc ProviderError" (reproduced: observed rejection name "ProviderError", not "AbortError"; also mislabels a user abort as a timeout). Fix: in the fetch catch, when `err.name === "AbortError"`, rethrow bare if `streamOpts.signal?.aborted`, else throw the timeout ProviderError.
  minor:
    - file: src/ai/provider.ts:530-534 — converse of the above: an internal-timeout abort surfacing mid-read is rethrown bare as AbortError (indistinguishable from user abort). The same `streamOpts.signal?.aborted` disambiguation in the read-phase catch fixes it (timeout → ProviderError timeout:true).
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Happy path, malformed-event skip, UTF-8/mid-line splits, 401 scrub, non-SSE 200, and mid-stream abort all conform and pass fresh. No scope creep (git stat: provider.ts +255/-0, test +216/-1 where -1 is only an EOF-newline fix); no new deps; no vscode import. The two important findings are narrow fixes in streamComplete's error/boundary handling.

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

FAIL  src/ai/__tests__/provider.test.ts > provider — streamComplete (caller abort during fetch phase) > rejects with bare AbortError (name 'AbortError', not ProviderError) when caller signal aborts before response headers arrive
AssertionError: expected 'ProviderError' to be 'AbortError' // Object.is equality
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
> vsdb@1.5.1 typecheck
> tsc --noEmit
 ✓ src/ai/__tests__/agent.test.ts  (12 tests) 5ms
 ✓ src/ai/__tests__/provider.test.ts  (23 tests) 8ms
Test Files  2 passed (2)
     Tests  35 passed (35)
```

### Files Changed

- `src/ai/provider.ts`:
  - SSE main loop now finds earliest of `buffer.indexOf("\r\n\r\n")` and `buffer.indexOf("\n\n")` and slices by matched delimiter length (4 vs 2). `rawEvent.split(/\r?\n/)` already handles CRLF line endings inside the event. Trailing-flush already handles CRLF line endings via `/\r?\n/` so no change needed there.
  - Fetch-phase catch (`:467-490`): when `err.name === "AbortError"`, check `streamOpts.signal?.aborted` — if true, rethrow original `e` bare (or wrap minimally if not an Error) so name stays "AbortError" and it is not a ProviderError; otherwise throw timeout ProviderError.
  - Read-phase catch (`:534-553`): same disambiguation — caller abort surfaces bare AbortError; internal timeout → ProviderError timeout:true.
- `src/ai/__tests__/provider.test.ts`:
  - Appended describe `provider — streamComplete (CRLF body regression)` (CRLF-only happy path).
  - Appended describe `provider — streamComplete (caller abort during fetch phase)` (fetch-rejection with AbortError name, signal forwarded, expected bare AbortError + not ProviderError).

### Tests Added

- `src/ai/__tests__/provider.test.ts`: `parses events when server uses \r\n\r\n separators (legal SSE per spec)`, `rejects with bare AbortError (name 'AbortError', not ProviderError) when caller signal aborts before response headers arrive`.

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
NOTES: No contract drift — stream_options still omitted, usage defaults {0,0}, no vscode import (file has zero import statements), no new deps (package.json/package-lock.json clean in git status). Diff is additive-only (+282/−0 in provider.ts); complete() untouched. AbortError wrapping at :373 is pre-existing complete() code, explicitly out of scope per contract "complete() behavior không đổi".
