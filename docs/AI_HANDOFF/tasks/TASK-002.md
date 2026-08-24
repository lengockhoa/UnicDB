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
