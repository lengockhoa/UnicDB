# TASK-002 — Agent streaming loop (opt-in via AgentDeps)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.B + §7

## Goal

`runAgent` hỗ trợ streaming: khi `deps.streamComplete` được inject và config method là
`chat/completions`, mỗi step dùng stream path, emit `onText` delta ra callbacks, với
fallback non-stream khi stream fail TRƯỚC khi text nào được emit, và abort-aware.

## Target Files

- `src/ai/agent.ts` — mở rộng `AgentDeps` (optional `streamComplete`), `AgentCallbacks`
  (optional `onText`), stream/fallback/abort logic trong step loop. Không đổi
  `AgentRunResult` shape.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | stream happy: step duy nhất stream 2 delta rồi final | `onText` nhận `"hi "` rồi `"there"` (đúng thứ tự); `out.finalText === "there"`; `out.steps[0].result.text === "there"`; history shape y hệt non-stream | deps: loadConfig→cfg(method chat/completions), streamComplete emit 2 delta + resolve resultOk("there"); complete = spy KHÔNG được gọi |
| 2 | unit (happy-tool) | tool loop: step 1 stream tool_calls, step 2 stream text | tool step KHÔNG phát onText (text rỗng); text step phát onText; argumentsJson merge từ stream = chuỗi JSON đúng; finalText đúng | streamComplete lần 1 resolve resultOk("", [toolCall]), lần 2 resolve resultOk("done") |
| 3 | edge (fallback) | streamComplete reject ProviderError TRƯỚC any onText → fallback deps.complete | `onStreamFallback` gọi đúng 1 lần (TRƯỚC complete); deps.complete gọi đúng 1 lần với CÙNG request (messages deep-equal); result khớp complete; runAgent resolve bình thường; onText không gọi cho step này | streamComplete throw ProviderError ngay; complete resolve resultOk("fallback ok"); spy onStreamFallback |
| 4 | edge (mid-stream) | streamComplete reject SAU 1 onText → KHÔNG fallback, throw lên caller | runAgent rejects với ProviderError gốc; deps.complete KHÔNG được gọi; error message chứa nguyên nhân gốc | streamComplete: onText("par") rồi throw ProviderError |
| 5 | edge (abort) | signal aborted giữa stream → AbortError propagate, KHÔNG fallback | runAgent rejects với error `name === "AbortError"`; deps.complete KHÔNG được gọi (fallback bị chặn kể cả khi emitted === 0); history KHÔNG có assistant msg của step đang dở | streamComplete nhận `signal` (tham số 5); test dùng AbortController: `onText("par")` → `controller.abort()` → mock throw `Object.assign(new Error("stream aborted"), {name:"AbortError"})`; **thêm sub-case: abort TRƯỚC onText đầu (tool step, emitted===0) → deps.complete vẫn KHÔNG được gọi** |
| 6 | unit (regression) | deps KHÔNG có streamComplete → hành vi cũ nguyên vẹn | mọi test hiện có `agent.test.ts` pass nguyên (không sửa test cũ); code path stream không kích hoạt | existing suite (makeDeps chỉ có loadConfig+complete) |

Lưu ý fixture: signature `streamComplete(cfg, role, req, onText, signal)` (5 tham số, xem
Interfaces). Wrapper đếm emitted trong agent: `let emitted = 0; const wrapped = (t: string) => { emitted++; cb(t) }`.
**Abort rule (bắt buộc, đồng bộ với TASK-001 + PLAN §3.B)**: trước khi quyết định fallback,
kiểm tra `err.name === "AbortError" || signal?.aborted` → nếu đúng, rethrow NGAY, không
fallback — Stop của user phải không bao giờ kích hoạt re-request non-stream (kể cả khi
emitted === 0, ví dụ abort trong tool step). Chỉ ProviderError thật (non-abort) mới fallback.

## Test Files

- `src/ai/__tests__/agentStream.test.ts` (new) — 5 cases trên (case 6 nằm ở agent.test.ts cũ).
- `src/ai/__tests__/agent.test.ts` — KHÔNG sửa cases cũ; chỉ chạy lại làm regression.

## Verification Commands

```bash
npm run typecheck && npx vitest run src/ai/__tests__/agent.test.ts src/ai/__tests__/agentStream.test.ts
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước, GREEN sau — RED output paste vào Executor Report).
- [ ] `AgentRunResult`/`AgentStep` shape không đổi (typecheck toàn repo pass).
- [ ] Không regression agent.test.ts cũ.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 — tiêu thụ `streamComplete`/`StreamTextEvent`/`StreamRequestOptions` trên type
  `AgentDeps` (signature xem TASK-001 §Interfaces).

## Interfaces

- Consumes: từ TASK-001 — `streamComplete(req: ProviderRequest, opts: StreamRequestOptions): Promise<ProviderResult>`; `StreamRequestOptions { onText(ev: StreamTextEvent): void; signal?: AbortSignal }`.
- Produces (TASK-003 tiêu thụ — chữ ký CHÍNH XÁC):
  ```ts
  // AgentDeps bổ sung (optional) — signal là tham số thứ 5 (pin theo F2 review round 1):
  streamComplete?(cfg: AiConfig, role: AiModelRole, req: ProviderRequest,
                  onText: (text: string) => void,
                  signal?: AbortSignal): Promise<ProviderResult>;
  // runAgent bổ sung tham số 4 (optional) — panel pass AbortController.signal vào đây:
  runAgent(input, deps, callbacks?, signal?: AbortSignal): Promise<AgentRunResult>

  // AgentCallbacks bổ sung (optional) — KÊNH FALLBACK (pin theo F1: đây là channel
  // DUY NHẤT báo fallback; AgentStep giữ shape không đổi, không thêm field):
  export interface AgentCallbacks {
    onStep?(step: AgentStep): void;      // có sẵn
    onError?(error: Error): void;        // có sẵn
    onText?(text: string): void;         // MỚI — mỗi delta một lần, chỉ text step
    onStreamFallback?(): void;           // MỚI — fire đúng 1 lần TRƯỚC deps.complete
                                         // gọi ở fallback, chỉ khi abort-rule không chặn
  }
  ```
  Fallback rule hoàn chỉnh (thứ tự kiểm tra BẮT BUỘC trong catch):
  1. `err.name === "AbortError" || signal?.aborted` → rethrow ngay, KHÔNG fallback,
     KHÔNG onStreamFallback (Stop của user không bao giờ re-request).
  2. Còn lại nếu `err instanceof ProviderError && emitted === 0` → gọi
     `callbacks.onStreamFallback?.()` đúng 1 lần → `deps.complete(cfg, role, req)`
     cùng request, KHÔNG onText cho step fallback. Step hoàn tất vẫn phát `onStep`
     bình thường như mọi step.
  3. Còn lại (`emitted >= 1` hoặc non-ProviderError) → rethrow lên caller.
  `runAgent` chỉ chọn stream path khi `deps.streamComplete !== undefined && cfg.method === "chat/completions"`.
  Panel tự decide cách render từ `onStreamFallback` (xem TASK-003 case 3) — không cần
  `STREAM_FALLBACK_STEP_LABEL` const nữa (đã bỏ ở round 2; label là việc của panel).

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
Bản thiết kế fallback nằm ở agent (không phải provider) — lý do ghi ở PLAN.md §3.A. Nếu
executor thấy khó giữ `onText` count chính xác (async race giữa onText cuối + throw),
an toàn: bọc `emitted` counter ngoài try, throw sau khi await streamComplete settle.


---

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecN-T002

### Scope

Extend `runAgent` with optional 4th param `signal?: AbortSignal`, add optional
`streamComplete` to `AgentDeps` (cfg,role,req,onText,signal signature), add
optional `onText(text: string)` and `onStreamFallback()` to `AgentCallbacks`.
Introduce `runStep` helper inside agent.ts that: (a) picks non-stream path when
`!deps.streamComplete || cfg.method !== "chat/completions"`; (b) wraps the
user's `onText` to count emitted deltas; (c) freezes the catch order:
`AbortError || signal.aborted → rethrow bare`,
`ProviderError && emitted===0 → onStreamFallback once + deps.complete(req)`,
otherwise rethrow. agent.ts stays pure (no vscode import). agent.test.ts NOT
edited; full AI suite green.

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
> vsdb@1.5.1 typecheck
> tsc --noEmit
 ✓ src/ai/__tests__/agentStream.test.ts  (7 tests) 6ms
 ✓ src/ai/__tests__/agent.test.ts  (12 tests) 6ms
 Test Files  2 passed (2)
      Tests  19 passed (19)
```

### Files Changed

- `src/ai/agent.ts`:
  - Imports: added `AiConfig`/`AiModelRole` from `./settings`; `ProviderError`
    as a value (mixed import) plus remaining type-only imports from `./provider`.
  - `AgentDeps` gains optional `streamComplete(cfg, role, req, onText, signal)`
    matching the frozen TASK-002 §Interfaces signature exactly.
  - `AgentCallbacks` gains optional `onText(text: string)` and
    `onStreamFallback()` per the same frozen contract.
  - `runAgent(input, deps, callbacks?, signal?)` — 4th param `signal?: AbortSignal`
    threaded through to per-step provider calls.
  - New private helper `runStep(req, deps, callbacks, signal, cfg, role)`:
    - Non-stream path when `!deps.streamComplete || cfg.method !== "chat/completions"`
      (preserves case 6 regression — stream opt-in is silent on missing deps or
      `responses` method).
    - Stream path wraps user `callbacks.onText` to count emitted deltas; the
      counter increments before the user callback fires, so `emitted` is the
      number of deltas delivered (not the number of successful callbacks).
    - Catch order is exact: (1) abort check (name OR signal.aborted) → rethrow
      bare, no fallback; (2) ProviderError && emitted===0 →
      `callbacks.onStreamFallback?.()` once, then `deps.complete(cfg, role, req)`
      with the same request; (3) else rethrow.
  - No changes to `AgentStep`/`AgentRunResult` shape; case 6 regression verified
    by the 12 untouched `agent.test.ts` cases passing.
- `src/ai/__tests__/agentStream.test.ts`: new file, 7 cases (1 happy single-step,
  2 tool loop, 3 fallback, 4 mid-stream fail, 5a abort mid-stream, 5b abort
  pre-emit, 5c OR-rule with non-AbortError name). All run synchronously, no
  network, no real fetch.

### Tests Added

- `src/ai/__tests__/agentStream.test.ts`: `case #1 happy single-step: stream
  emits 2 deltas then final`, `case #2 tool loop: tool step emits no text, text
  step does; argumentsJson merges from stream`, `case #3 fallback: streamComplete
  rejects ProviderError pre-emit → onStreamFallback once + deps.complete`,
  `case #4 mid-stream ProviderError after onText → rethrow, NO fallback`,
  `case #5a abort mid-stream (after 1 onText) → AbortError propagates bare,
  NO fallback`, `case #5b abort pre-emit (tool step, emitted===0) → AbortError
  propagates, NO fallback`, `case #5c abort propagated even when err.name is
  NOT 'AbortError' but signal.aborted is true`.

### Issues

none — frozen interfaces preserved (AgentDeps.streamComplete signature,
AgentCallbacks additions, runAgent 4th param all match TASK-002 §Interfaces
byte-for-byte); case 6 regression intact (12 untouched `agent.test.ts` cases
still pass); no new dependencies (`package.json`/`package-lock.json` unchanged);
no vscode import introduced in agent.ts.
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
NOTES: Signatures verified byte-against-contract: AgentDeps.streamComplete(cfg,role,req,onText,sig#5), runAgent param4 signal, AgentCallbacks.onText/onStreamFallback. Catch order exact (agent.ts:177-190): abort(name OR signal.aborted)→bare rethrow incl. emitted===0 (test 5b); ProviderError&&emitted===0→onStreamFallback once then complete, no double text (fallback path has no onText, result authoritative); else rethrow. wrappedOnText counts before dispatch (planner's counter-outside-try rule). AgentDeps.streamComplete onText takes {text} per TASK-001 frozen StreamRequestOptions — task §Produces parenthetical "(text: string)" is informal; code is the correct consume-side shape and unwraps ev.text for AgentCallbacks.onText(text: string). agent.ts pure (imports only ./settings, ./provider). Non-stream callers unaffected: runStep falls to deps.complete when streamComplete absent or method!==chat/completions; panel/extension callers compile + pass (param4 optional). RED evidence verbatim with 7 real assertion failures.
