# PLAN — Cycle N: Builtin engine streaming (AI Chat)

## §1 Intent

UX: engine builtin hiện post một `assistant` message DUY NHẤT khi agent chạy xong — người
dùng chờ full response (có thể hàng chục giây với tool loop nhiều step) nhìn spinner mù mờ,
trong khi engine ACP đã stream delta từ cycle L/M (`agent_message_chunk` → `{type:"delta"}` →
webview `appendDelta`). Người dùng có quyền thấy chữ chảy dần ở MỌI engine.

Vấn đề nằm ở 3 tầng, none-of-them-streaming:
1. `src/ai/provider.ts` — `complete()` post `/chat/completions` **không** `stream` flag (đã
   verify: không có key `stream` nào trong body builder) rồi `await resp.text()` + `JSON.parse`
   — chỉ parse được non-stream JSON.
2. `src/ai/agent.ts` — `deps.complete(cfg, role, req)` trả cả câu; không có kênh delta ra ngoài.
3. `src/ui/aiChatPanel.ts` `runBuiltinTurn` — chỉ post assistant MỘT lần khi runAgent settle.

Success = builtin turn stream delta ra webview theo thời gian thực; Stop giữa stream hủy
được (không post thêm delta/assistant, done vẫn tới); stream fail → fallback non-streaming
hoặc error rõ ràng (chọn fallback, xem §3); **0 dependency mới, 0 network call trong test,
0 apiKey trong webview/history/error message**.

Cycle J từng freeze provider/agent theo scope policy — ghi chú ở HISTORY; bản ghi ở ACTIVE
cho phép unfreeze trong N (regression net = full suite 751 baseline).

## §2 Scope

**In-scope**
- `src/ai/provider.ts` — thêm `streamComplete(req, { onText, signal })` bên cạnh `complete()`
  (method chat/completions). SSE parse tự viết, `resp.body.getReader()` + TextDecoder.
- `src/ai/agent.ts` — `AgentCallbacks` thêm `onText?(text: string): void` +
  `onStreamFallback?(): void` (kênh fallback, F1); `AgentDeps` thêm `streamComplete`
  5 tham số + `runAgent` tham số 4 `signal` (F2); loop 2 chế độ (deps có/không
  `streamComplete`), fallback non-stream khi stream fail pre-emit theo abort-rule (F3).
- `src/ui/aiChatPanel.ts` — `runBuiltinTurn` nối `onText` → `post({type:"delta"})` (gate abort
  token), `onStreamFallback` → step label, AbortController + `signal` cho stop, error
  message ghi rõ chế độ fail.
- `src/extension.ts` — `aiChatDeps` thêm `streamComplete` closure pattern y hệt `complete`
  hiện tại (line 270–279), nhận `(cfg, role, req, onText, signal)`.
- Banner builtin đổi chữ "— streaming" + webview de-stream bubble ở `done`/`error` (F4) —
  file `webview/aiChatPanelMain.ts`, xem TASK-003 Target Files.

**Out-of-scope (Non-goals)**
- ACP engine — untouched (đã stream).
- DB tools, settings UI, README.
- Streaming cho method `responses` — `streamComplete` throw NotImplemented; `runAgent` ưu
  tiên `complete` khi config `method === "responses"` (chọn để không bắt buộc viết NDJSON
  responses parser không có user).
- Tool-call streaming (argumentsJson từng fragment) — fake registry emit tool call nguyên khối.
- History persistence, DB, package.json deps.

**Wave/file constraint (from brief)**: webview main + messages protocol là shared surface —
một task/wave owns. Không có 2 task wave 1 nào share file.

## §3 Approach

### A. Provider streaming — SSE, không dependency mới

Wire protocol (OpenAI-compatible chat/completions `stream:true`):
- Request: y hệt `complete()` nhưng body thêm `"stream": true` + header
  `Accept: text/event-stream`.
- Response 200: body là SSE theo line, event = `data: <json>` mỗi dòng, stream kết thúc bằng
  `data: [DONE]`. Delta text nằm ở `choices[0].delta.content` (string, có thể vắng —
  `role`-only chunk đầu, hoặc tool_call chunk). Finish_reason ở chunk cuối có `choices[0].finish_reason`.

Parse strategy (tự viết ~60 dòng trong provider.ts, không lib):
1. `resp.body.getReader()` (Node 18 undici + webview-môi-trường-host đều có; fallback nếu
   `resp.body` null: đọc `resp.text()` rồi cắt line như non-stream — belt and braces, không
   thêm path network mới). **esbuild CJS-compatible**: chỉ dùng `ReadableStreamDefaultReader`
   type từ lib.dom (tsconfig đã dom, chưa verify — executor check; nếu thiếu dùng
   `getReader()` không annotate).
2. TextDecoder streaming (`{stream:true}`) + buffer thủ công: tách theo `"\n"`, giữ remainder.
   Event boundary = blank line; event có thể `data:` nhiều dòng → concat bằng `\n` trước JSON.parse.
3. Mỗi event: `data: [DONE]` → kết thúc; khác → `JSON.parse` an toàn (throw trong event →
   skip event đó, không kill stream — sai số 1 chunk vẫn còn full text), extract
   `choices[0].delta.content` khi là string, gọi `onText(delta)`, ghi finish_reason + usage.
4. Kết thúc: resolve `ProviderResult` với text tổng (đã onText từng phần — consumer tự buffer),
  toolCalls từ các `delta.tool_calls` chunk (index-based merge: `tool_calls[i]` có `id`/`name`
  ở chunk đầu, `arguments` fragment concat dần — nên accumulated string chính là final),
  `finishReason` từ chunk cuối, `usage` từ chunk `usage` cuối nếu có (else 0).

**Degradation decision (planner picks per brief)**: `streamComplete` stream request FAIL
(network/HTTP ≥400/truncated mid-stream) → **throw** `ProviderError` như mọi path khác.
**Fallback to non-streaming `complete()` nằm ở `runAgent` (agent.ts), KHÔNG phải provider** —
lý do: (a) provider giữ role "thin fetch client" theo frozen comment đầu file, không tự quy
ết retry policy; (b) agent là nơi biết step-semantics (một step = một provider call, retry
an toàn vì chưa commit gì vào history); (c) agent sẽ pass `complete` cho fallback — đúng
dependency-injection pattern mà test inject fake vào. Vòng đời (pin ở §3.B): stream throw
non-abort TRƯỚC khi text nào được emit (`emitted === 0`) → agent báo
`callbacks.onStreamFallback?.()` rồi dùng `deps.complete` lại request đó — panel hiện step
label "stream fallback" qua handler riêng (F1: callback là kênh DUY NHẤT, không đổi
AgentStep). Khi stream die GIỮA stream (đã emit ≥1 delta) → throw tiếp lên panel → error
message ghi rõ "stream failed mid-response" — không lặp lại full request vì user đã thấy
chữ khập khiễng, nhảy textarea reset đáng ngờ hơn là giữ text + error.

### B. Agent loop — opt-in streaming qua AgentDeps

`AgentDeps` thêm optional — signal là tham số thứ 5 (F2 pin):
```ts
streamComplete?(cfg: AiConfig, role: AiModelRole, req: ProviderRequest,
                onText: (text: string) => void,
                signal?: AbortSignal): Promise<ProviderResult>;
runAgent(input, deps, callbacks?, signal?: AbortSignal)  // signal = tham số 4
```
Signal transport (MỘT kênh end-to-end): panel `handleSend` tạo `AbortController`
(cùng chỗ token, line ~271) → `runAgent(..., signal)` → `deps.streamComplete(..., signal)`
→ provider `streamComplete(req, { onText, signal })` → fetch. `handleStop` flip token +
`abortController.abort()`. KHÔNG nhét signal vào callbacks/input.

`AgentCallbacks` thêm optional `onText?(text: string): void` (delta) và
`onStreamFallback?(): void` (F1 pin — kênh fallback DUY NHẤT; AgentStep giữ shape).
`runAgent` mỗi step: `deps.streamComplete && cfg.method !== "responses"` → stream.

**Fallback + abort rule (F1/F3 pin — thứ tự kiểm tra bắt buộc trong catch)**:
1. `err.name === "AbortError" || signal?.aborted` → rethrow ngay, KHÔNG fallback,
   KHÔNG `onStreamFallback` — Stop của user không bao giờ kích hoạt re-request non-stream
   (kể cả abort trong tool step khi `emitted === 0`). AbortError shape thống nhất:
   `Error` với `name === "AbortError"`, KHÔNG bọc ProviderError (TASK-001 case 6 pin).
2. `err instanceof ProviderError && emitted === 0` (chưa onText lần nào) →
   `callbacks.onStreamFallback?.()` đúng 1 lần → `deps.complete(cfg, role, req)` cùng
   request (step non-stream, không onText). Step hoàn tất vẫn phát `onStep` bình thường.
   Panel hiển thị qua handler riêng: `onStreamFallback: () => post({type:"step", label:"stream fallback"})`.
3. Còn lại (`emitted >= 1` — stream die giữa chừng, hoặc non-ProviderError) → rethrow
   lên panel → error message ghi rõ "stream failed mid-response".

### C. Panel — delta + abort token + signal

`handleSend`: tạo `AbortController` cùng chỗ token (line ~271), lưu
`this.currentAbort`; `handleStop` flip token + `this.currentAbort?.abort()`. `runBuiltinTurn`
pass signal qua **tham số 4 của `runAgent`** (không qua callbacks — F2 pin). `onText` →
`if (token.aborted) return; post({type:"delta", text})`. `onStreamFallback` →
`post({type:"step", label:"stream fallback"})`. Stop giữa stream: signal aborted → agent
throw AbortError → panel catch, KHÔNG post assistant/history, vẫn `done` (y hệt test #4
pattern hiện có). Webview đổi banner label + thêm `deStreamOpenBubble()` gọi ở
`case "done"`/`case "error"` (F4 pin — remove class `vsdb-chat-streaming` khỏi bubble đang
mở, giữ partial text; bubble của turn sau luôn mới, không merge text cũ).

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| unit (happy) | T1.1 streamComplete SSE happy — fetch fake trả 3 data chunk + [DONE] | onText nhận "Hel","lo","!" theo thứ tự; result.text==="Hello!", finishReason==="stop", usage mapping đúng |
| unit (edge-malformed) | T1.2 malformed SSE — 1 data line fail JSON.parse, 1 line thiếu choices | event xấu bị skip, 2 event tốt vẫn onText; result không throw; tổng text = concat 2 tốt |
| unit (edge-boundary) | T1.3 chunk-boundary split — "data: {...}" bị cắt giữa UTF-8 char, cắt giữa line, event có 2 dòng data: | onText nhận đủ, không lặp/không mất fragment; multi-line data concat bằng \n |
| unit (edge-error) | T1.4 HTTP 401 stream → ProviderError status 401, bodySnippet scrubbed apiKey; HTTP 200 nhưng body non-SSE (JSON thường) | throw ProviderError đúng message/shape; không onText; apiKey không xuất hiện |
| unit (edge-abort) | T1.6 opts.signal aborted giữa stream → reject AbortError thuần (không bọc ProviderError) | err.name === "AbortError", err instanceof ProviderError === false; không onText sau abort |
| unit (regression) | T1.7 complete() non-stream không đổi behavior | 3 test hiện có của #1/#8/#10 vẫn pass nguyên — không diff ngoài expected |
| unit (happy) | T2.1 runAgent stream happy — deps.streamComplete emit 2 delta, kết thúc final "hi" | onText gọi 2 lần, result.steps đúng, history y hệt non-stream shape |
| unit (happy-tool) | T2.2 stream tool loop — step 1 stream tool_calls, step 2 stream text | tool step KHÔNG onText, text step onText; ProviderResult merge đúng argumentsJson |
| unit (edge-fallback) | T2.3 streamComplete throw ProviderError trước khi onText → fallback deps.complete | `onStreamFallback` gọi đúng 1 lần trước complete; deps.complete được gọi 1 lần cùng request, result khớp, run tiếp bình thường |
| unit (edge-midstream) | T2.4 stream die sau 1 delta → throw lên caller (KHÔNG fallback) | runAgent throw ProviderError gốc, deps.complete không được gọi thêm |
| unit (edge-abort) | T2.5 signal aborted → AbortError propagate, KHÔNG fallback (kể cả emitted===0, ví dụ abort trong tool step) | runAgent rejects err.name==="AbortError"; deps.complete KHÔNG được gọi; không step nào được commit thêm vào history |
| unit (happy) | T3.1 send builtin turn → delta messages theo thứ tự + assistant cuối | posted: delta "a", delta "b", assistant, done — đúng thứ tự; history push đúng |
| unit (edge-abort) | T3.2 stop giữa stream: delta trước đó giữ, delta/assistant sau stop KHÔNG post | onText sau abort bị gate; assistant không post; done vẫn tới (pattern test #4) |
| unit (edge-fallback) | T3.3 stream fail pre-emit + fallback → `onStreamFallback` handler post step label "stream fallback" | posted chứa {type:"step", label:"stream fallback"}; assistant vẫn post; done tới |
| unit (edge-error) | T3.4 stream + fallback đều fail → error message có "stream" + "AI" | error bubble đúng nội dung, panel không dispose |
| jsdom (happy) | T3.5 engine banner builtin hiện "Engine: builtin — streaming" | banner.textContent match đúng |
| unit (wiring) | T3.6 extension deps: streamComplete 5 tham số (cfg, role, req, onText, signal), capture qua vi.mock AiChatPanel constructor options | typeof === "function"; gọi với fake cfg/req/spy/signal resolve, không crash; vsdb.aiChat vẫn registered |
| jsdom (regression) | T3.7 stop giữa stream → done de-stream bubble; delta turn sau vào bubble MỚI | sau delta("x")+done: không còn .vsdb-chat-streaming; delta("y") tạo bubble riêng, không chứa "x" (F4) |
| typecheck | contract AiChatPanelOptions/AgentDeps extension.ts | npm run typecheck pass — closure pattern đúng, không ts error |

## §5 Verification Commands

**Per-task narrowed selection** (theo RULES.md test-selection, mỗi task ≤2 file):
- TASK-001: `npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts` —
  provider = file bị sửa; agent = consumer trực tiếp của type mới.
- TASK-002: `npx vitest run src/ai/__tests__/agent.test.ts` (regression) + viết mới
  `src/ai/__tests__/agentStream.test.ts`.
- TASK-003: `npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/extension.test.ts` (case 6 wiring ở extension.test.ts).

**Mỗi task** thêm (project script có sẵn trong package.json — verified):
```bash
npm run typecheck && npx vitest run <selection>
```

**Wave boundary / cuối cycle (regression net — bắt buộc)**:
```bash
npm run compile && npm run typecheck && npx vitest run
```
(751 baseline + skipped opt-in smoke, không được thêm fail.)

## §6 Acceptance

- [ ] T1: `streamComplete` stream SSE thật (fetch inject), AbortError thuần khi signal abort, fallback không, type pass — TASK-001
- [ ] T2: runAgent stream qua injected deps; `onStreamFallback` đúng 1 lần pre-emit; mid-stream throw; abort KHÔNG fallback (kể cả emitted===0) — TASK-002
- [ ] T3: builtin turn post delta thứ tự + assistant + done; stop gate; `onStreamFallback` step label; error path; banner streaming; webview de-stream bubble ở done/error (F4) — TASK-003
- [ ] extension.ts closure `streamComplete(cfg, role, req, onText, signal)` compile + typecheck — TASK-003
- [ ] Full suite pass cuối cycle (regression net) — TASK-003/wave boundary
- [ ] Không dependency mới trong package.json — TASK-003 (audit cuối)

## §7 Task Split

| Task | Files (owner per wave) | Dependencies | Wave |
|---|---|---|---|
| TASK-001 | src/ai/provider.ts | none | 1 |
| TASK-002 | src/ai/agent.ts | TASK-001 (consumes AgentStreamDeps) | 2 |
| TASK-003 | src/ui/aiChatPanel.ts, src/ui/aiChatPanelMessages.ts, webview/aiChatPanelMain.ts, src/extension.ts | TASK-002 | 3 |

Wave layout: `wave 1: 1 task | wave 2: 1 task | wave 3: 1 task` — chuỗi là DO THIẾT KẾ
(interface dependency thật mỗi tầng), không thể widen vì mỗi task consumes symbols của
task trước. §2 đã note: nếu TASK-002 và TASK-003 có thể tách file riêng để chạy song song
wave 2 → nhưng agent.ts là interface gate — TASK-003 cần signature chính xác của
`onText`/`streamComplete` để compile, nên chain giữ nguyên cho cycle nhỏ này (3 tasks max
theo brief).

Files shared giữa task: không (đã verify từng đường dẫn target tồn tại; không file nào bị
2 task cùng wave đụng).

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: nothing
Known gaps:
- `ReadableStreamDefaultReader` type annotation có thể không có trong tsconfig hiện tại —
  TASK-001 Discussion đã note cách xử lý (dùng không-annotate hoặc khai báo local structural
  type), không phải blocker.
- lib.dom/dom.iterable trong tsconfig chưa verify từng flag — chỉ ảnh hưởng annotation,
  không ảnh hưởng runtime (getReader() là structural).
- Coverage: mọi acceptance criterion §6 đều map task; §1 success definition (stream real-time
  + stop + fallback + no-dep/no-key/no-network) phủ đủ bởi T1.x–T3.x; unhappy path (401,
  malformed, truncated, abort, non-SSE body, mid-stream fail) nằm trong §4.
- T1.5 là regression check (3 test cũ không đổi) — không phải test mới, chỉ là bộ selection
  narrowed theo RULES.

## Planner Self-Audit — Round 2 (post plan-review)
Checklist: 12/12 pass (re-run sau khi áp F1-F6; task chain + file ownership không đổi).
Fixed during audit: F1-F6 resolution (chi tiết ở "Round 2 — Resolution" dưới).
Known gaps: giữ nguyên các gap round 1 (ReadableStreamDefaultReader annotation,
lib.dom flags — không blocker). Mới: case 6 TASK-003 phụ thuộc khả năng vi.mock class
`AiChatPanel` capture constructor options — đã ghi rõ fallback capture qua
`commandOpenAiChat`; nếu cả hai đều không khả thi, executor báo về Discussion thay vì tự
invent mechanism (không còn type-level escape hatch).

## Round 2 — Resolution (planner response to review findings)

F1 [IMP] Fallback channel: chọn **callback** — `AgentCallbacks.onStreamFallback?(): void`,
fire đúng 1 lần trước `deps.complete` fallback; `AgentStep` giữ shape; bỏ
`STREAM_FALLBACK_STEP_LABEL` (label "stream fallback" là literal của panel). Pin ở
§3.A/§3.B + TASK-002 Produces + TASK-003 case 3/Interfaces.
F2 [IMP] Abort transport: signal đi QUA MỘT kênh — `runAgent(input, deps, callbacks,
signal?)` tham số 4 → `deps.streamComplete(cfg, role, req, onText, signal?)` tham số 5 →
extension closure `streamComplete(req, { onText, signal })`. Pin ở §3.B/§3.C + TASK-002
case 5 fixture + TASK-003 case 6 + Discussion round 2.
F3 [IMP] Abort-vs-fallback: rule thống nhất cả 3 tài liệu — catch order: (1)
`err.name === "AbortError" || signal?.aborted` → rethrow, KHÔNG fallback (kể cả
emitted===0/tool-step abort); (2) ProviderError && emitted===0 → onStreamFallback +
complete; (3) còn lại rethrow. AbortError shape pin: `Error` với `name === "AbortError"`,
không bọc ProviderError — TASK-001 case 6 (mới) + T2.5 update.
F4 [IMP] Orphaned streaming bubble: webview thêm `deStreamOpenBubble()` gọi ở
`case "done"` + `case "error"` — remove class streaming, giữ bubble + partial text. TASK-003
case 7 (mới, jsdom regression): delta("x") → done → delta("y") mở bubble mới, không merge.
F5 [MIN] Case 6: bỏ escape hatch type-level — capture thật qua vi.mock `./ui/aiChatPanel`
class constructor options (hoặc `commandOpenAiChat`); nếu không khả thi → Discussion, không
type-assert.
F6 [MIN] include_usage: QUYẾT ĐỊNH **không gửi** `stream_options:{include_usage:true}` —
không universally supported (một số server OpenAI-compatible reject); usage từ chunk cuối
nếu server tự gửi, else {0,0}. Ghi ở TASK-001 §Interfaces.

Chain/wave KHÔNG đổi: TASK-001 → TASK-002 → TASK-003 (interface dependency thật).
Mỗi task vẫn ≥1 happy + ≥2 edge khác loại + regression.
## Plan Review Log

### Round 1 — 2026-08-24 · unic/unic-smart
Status: Issues Found

COMPLETENESS:
  - none — every task has Goal/Target Files/Test Cases (happy + ≥2 distinct edge types + regression)/Test Files/Verification incl. typecheck+compile/Acceptance/Interfaces; test-file anchors verified real (provider.test.ts makeFetch/jsonResponse :22/:30; aiChatPanelWebview.test.ts makeHarness :50; extension.test.ts TASK-004 aiChat wiring :951).
CONSISTENCY:
  - F1, F2, F3 below (cross-document interface contradictions).
CLARITY:
  - F4 (stale streaming bubble), F5 (case-6 escape hatch self-contradiction).
SCOPE:
  - none — 3 tasks, chained waves, zero shared file per wave (verified against repo paths).
YAGNI:
  - none — no tool-call streaming, no responses streaming, no new deps; degradation policy explicit.

FINDINGS (numbered, severity):
1. [IMPORTANT] Fallback notification channel is undefined. PLAN §3.A says the fallback decision is reported via `onStreamFallback` ("quyết định ghi vào onStreamFallback (panel hiện step label)"), but TASK-002 §Interfaces frozen `AgentCallbacks` = {onStep, onError, onText} only, and states "step fallback vẫn phát onStep bình thường... không có field riêng trên AgentStep". With AgentStep unchanged and onStep firing normally, the panel cannot distinguish a fallback step from a normal one — its onStep handler (src/ui/aiChatPanel.ts:325-333) only posts labels for tool-carrying steps, so TASK-003 case 3 (`posted contains {type:"step", label:"stream fallback"}`) is unimplementable as specified. Fix: add `onStreamFallback?(): void` to AgentCallbacks in TASK-002 Produces; agent calls it when the pre-emit fallback fires; TASK-003 case 3 mock invokes it and panel posts `{type:"step", label: STREAM_FALLBACK_STEP_LABEL}`.
2. [IMPORTANT] AbortSignal has no transport from panel to provider. TASK-001 `StreamRequestOptions.signal?: AbortSignal` (good), but TASK-002's frozen `AgentDeps.streamComplete?(cfg, role, req, onText)` carries no signal, `AgentCallbacks` carries no signal, and TASK-003 Discussion leaves it open ("truyền qua runAgent input hoặc callbacks"). Consequences: TASK-002 case-5 fixture "streamComplete nhận opts.signal" is unsatisfiable against the frozen signature, and TASK-003's extension closure `streamComplete(req, { onText, signal })` has no signal source (extension.ts:270-279 receives only cfg/role/req). Fix: pin ONE channel — recommended 5th optional param `signal?: AbortSignal` on `AgentDeps.streamComplete` — in PLAN §3.B/§3.C + TASK-002 Produces + TASK-003 Consumes + extension.ts wiring sketch.
3. [IMPORTANT] Abort can trigger the fallback retry, and the abort error shape contradicts itself across tasks. TASK-001 says opts.signal aborted mid-stream → "throw ProviderError timeout-like"; the fallback rule (PLAN §3.B, TASK-002 case 3) is "catch ProviderError với emitted === 0 → deps.complete cùng request". A user Stop during a tool step (no text emitted yet) would therefore re-issue a FULL non-stream provider request after the user pressed Stop — violating §1 "Stop giữa stream hủy được". Also T2.5 expects rejection "message chứa 'abort'" while T1's timeout-like ProviderError message contains no "abort". Fix: pin in TASK-002 — if `signal?.aborted` (or error is AbortError), rethrow immediately, NEVER fallback; and pick one abort representation (recommend rethrowing the AbortError as-is, or ProviderError with timeout:true whose message contains "abort") consistently in T1 Produces + T2 case 5 + T3 catch classification.
4. [IMPORTANT] Orphaned streaming bubble merges next turn's text after mid-stream stop. Webview `appendDelta` (webview/aiChatPanelMain.ts:251-266) reuses the existing `.vsdb-chat-streaming` bubble; only `case "assistant"` (:423-434) removes it. T3.2 deliberately keeps pre-stop deltas visible, so after Stop the orphaned bubble stays marked streaming and the NEXT turn's first `delta` appends into it — aborted partial text merges into the new answer. Fix in TASK-003: de-stream or remove the open streaming bubble on turn end/turn start (e.g. `done` handler or on send), and extend case 2 to assert a second turn's delta starts a fresh bubble.
5. [MINOR] TASK-003 case 6 contradicts itself: "phải đạt được reference thật (không copy-paste code)" then offers "chấp asserted type-level" as fallback. Pick one; capturing the real deps is feasible by vi.mock-ing the panel/command module and asserting on the constructor/options argument.
6. [MINOR] TASK-001 stream body does not send `stream_options:{include_usage:true}`; most OpenAI-compatible servers then omit usage and T1.1's real-world usage will be {0,0} (plan accepts else-0, tests are self-contained so they still pass). One line in TASK-001 deciding whether to send it would remove the ambiguity.

VERIFIED-GOOD (no action): §1 diagnosis exact (complete() = await resp.text() + JSON.parse, no stream key — provider.ts:300-411; runAgent single await deps.complete — agent.ts:152; panel posts one assistant — aiChatPanel.ts:284-323); ACP delta path exists (aiChatPanel.ts:467-468) and webview already renders delta + replaces streaming bubble on assistant — TASK-003 correctly scopes webview change to the banner label only (aiChatPanelMain.ts:278-282); AiChatPanelDelta exists at aiChatPanelMessages.ts:47 so expected-no-diff is right; package.json has no lint script so typecheck is the correct gate, and all three task Verification Commands include `npm run typecheck` (+ compile at cycle boundary); tsconfig lib includes DOM so `ReadableStreamDefaultReader` annotates (planner's structural-type fallback remains a safe fallback); test anchors (makeFetch :22, jsonResponse :30, makeHarness :50, extension TASK-004 describe :951, vi.mock ../../ai/agent :30) all exist; provider/agent stay vscode-free and fetch-injected (no network in tests); no file owned by two tasks in the same wave; 751 baseline consistent with HISTORY cycle M.

REQUIRED REWORK: apply F1-F4 (interface pins in PLAN §3 + TASK-002 §Interfaces + TASK-003 cases 2/3 + TASK-001 abort-shape line) before wave 1 starts — they are one-contract edits, not re-splitting; quick Round-2 re-review after planner applies.

NOTES: Plan structure, diagnosis, and test design are sound; all six findings are cross-document contract pins an executor cannot resolve without inventing interfaces the plan itself forbids inventing.

### Round 2 — 2026-08-24 · unic/unic-smart
Status: Approved

RESOLUTION CHECK (F1-F6 re-verified against working tree, not planner claims):
  - F1 OK — `AgentCallbacks.onStreamFallback?(): void` is the sole fallback channel (TASK-002 Interfaces), fires exactly once before `deps.complete` (PLAN §3.B rule 2 ≡ TASK-002 rule 2, identical wording); AgentStep unchanged; `STREAM_FALLBACK_STEP_LABEL` survives only in historical Round-1/resolution prose, zero live contracts; TASK-003 case 3 implementable — webview `case "step"` → `appendStep` exists (aiChatPanelMain.ts:414).
  - F2 OK — exactly one abort transport, identical in PLAN §3.B, TASK-002 Interfaces + case-5 fixture ("tham số 5"), TASK-003 case 6 + Discussion (incl. extension.ts closure `(cfg, _role, req, onText, signal) => ...`); anchor verified: `complete` closure pattern exists at extension.ts:270-279.
  - F3 OK — catch order pinned identically in PLAN + TASK-002: (1) `err.name==="AbortError" || signal?.aborted` → rethrow, never fallback (explicitly even emitted===0 / tool-step abort); (2) `ProviderError && emitted===0` → onStreamFallback + complete; (3) else rethrow. Abort shape = bare `Error` with `name==="AbortError"`, never ProviderError-wrapped (TASK-001 case 6 + StreamRequestOptions comment + TASK-002 case 5 sub-case). Round-1 contradiction (timeout-like ProviderError) is gone from TASK-001.
  - F4 OK — `deStreamOpenBubble()` pinned for `case "done"` + `case "error"`; both cases exist today without de-stream (aiChatPanelMain.ts:436/:439) so the spec targets a real gap; TASK-003 case 7 asserts delta(x)→done→delta(y) opens a fresh bubble, no merge.
  - F5 OK — case 6 is real capture (vi.mock `./ui/aiChatPanel` class → read `options.deps` from `mock.calls`), secondary capture via `commandOpenAiChat`, explicit "KHÔNG dùng type-level assert"; escalation-to-Discussion path recorded in Self-Audit round 2.
  - F6 OK — decision recorded both places (PLAN Round-2 Resolution + TASK-001 §Interfaces): do not send `stream_options:{include_usage:true}`; usage from final chunk if server sends, else {0,0}.

COMPLETENESS:
  - none — every task ≥1 happy + ≥2 distinct edge types + regression; wave-boundary full-suite gate present in TASK-003 Verification Commands.
CONSISTENCY:
  - none blocking. Minor gloss: PLAN §5 parenthetical "mỗi task ≤2 file" conflicts with TASK-003's 4-file selection; RULES.md test-selection actually resolves per target file (4 targets → 4 test files), so the task file is RULES-correct — PLAN gloss stale, cosmetic only.
CLARITY:
  - none blocking. PLAN §4 bundles non-SSE-200 into row T1.4's name while TASK-001 numbers it case 5 (and Round-1 audit mis-references it as "T1.5"); coverage identical, task file is authoritative for executors.
SCOPE:
  - none — chain TASK-001→002→003 unchanged, zero shared file per wave.
YAGNI:
  - none — no tool-call streaming, no responses streaming, no new deps.

NOTES: All pins re-checked against current source anchors (extension.ts:270-279; aiChatPanelMessages.ts:47 delta type; aiChatPanelMain.ts:414/436/439; package.json scripts typecheck/compile exist, no lint → typecheck gate correct). INDEX already shows all three tasks `ready` — no index change required. Wave 1 cleared to start.
