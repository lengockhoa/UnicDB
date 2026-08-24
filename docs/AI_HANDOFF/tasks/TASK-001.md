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

---
