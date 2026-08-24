# TASK-003 — Panel builtin streaming wiring + webview banner

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.C + §7

## Goal

`runBuiltinTurn` phát `{type:"delta"}` real-time (gate abort token), AbortController +
signal cho stop giữa stream, stream-fallback step label, extension.ts inject
`streamComplete`; webview banner builtin ghi "— streaming". Đây là task đóng cycle —
chạy full-suite regression net ở cuối.

## Target Files

- `src/ui/aiChatPanel.ts` — `runBuiltinTurn` + `handleSend`: AbortController per turn,
  `onText` callback → `post({type:"delta"})`, catch phân loại (abort vs error), error
  message nêu rõ stream origin. `AiChatPanelOptions.deps` giữ type `AgentDeps` (đã mở rộng
  optional ở TASK-002 — không đổi type ở đây).
- `src/extension.ts` — `aiChatDeps` (line ~270) thêm `streamComplete` closure cùng pattern
  `complete` (createProviderClient per call).
- `webview/aiChatPanelMain.ts` — banner label builtin: `Engine: builtin${hint} — streaming`.
- `src/ui/aiChatPanelMessages.ts` — KHÔNG đổi protocol (delta đã tồn tại line 47). Chỉ đụng
  nếu cần doc-comment; owner file để tránh wave-collision, expected no-diff.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit (happy) | send builtin → delta đúng thứ tự + assistant + done | posted messages chứa `delta("a")`, `delta("b")`, `assistant("ab" hoặc finalText)`, `done` theo thứ tự index tăng dần; history push userMsg + assistantMsg | runAgentMock invoke `callbacks.onText("a")`, `onText("b")`, resolve finalText "ab" — mirror pattern test #2 hiện có (vi.mock ../../ai/agent) |
| 2 | edge (abort) | stop giữa stream: delta sau stop KHÔNG post; assistant KHÔNG post; done VẪN tới | posted deltas = chỉ các delta trước stop; `some(isAssistant) === false`; `some(isDone) === true`; token.aborted === true | runAgentMock: onText("x") → gate (test fire stop qua handler) → onText("y") → resolve; pattern test #4 |
| 3 | edge (fallback) | stream fail pre-emit + complete fallback → step label `"stream fallback"` posted | posted chứa `{type:"step", label:"stream fallback"}` (panel tự viết label trong handler `onStreamFallback` → `this.post({type:"step", label:"stream fallback"})`; KHÔNG import const từ agent.ts); assistant cuối cùng vẫn post; done tới; onStep tool-labels vẫn hoạt động như cũ | runAgentMock invoke `callbacks.onStreamFallback()` rồi resolve finalText (contract xem Interfaces TASK-002) |
| 4 | edge (error) | stream + fallback đều fail → error bubble, panel alive | error message chứa "stream" (case-insensitive); `p.disposed === false`; done tới | runAgentMock reject Error("provider stream failed") |
| 5 | jsdom (happy) | engine banner builtin: "Engine: builtin — streaming" | `#engineBanner.textContent === "Engine: builtin — streaming"` (không hint) và match `— streaming$` khi có hint | dispatch `{type:"engine", name:"builtin"}` qua harness `makeHarness()` (aiChatPanelWebview.test.ts) |
| 6 | unit (wiring) | extension activate: `aiChatDeps.streamComplete` là function, nhận đủ 5 tham số (cfg, role, req, onText, signal), không crash khi gọi với fake; cmd vsdb.aiChat vẫn registered | captured `deps.streamComplete` là function; gọi `deps.streamComplete(fakeCfg, "chat", fakeReq, spy, controller.signal)` → resolve ProviderResult từ fake fetch (vi.mock `./ai/provider` như provider.test.ts pattern, hoặc assert call tới `createProviderClient().streamComplete`); `state.registeredCommands.has("vsdb.aiChat")` vẫn true | vi.mock vscode như extension.test.ts hiện có; **capture deps qua `AiChatPanel` constructor**: vi.mock `./ui/aiChatPanel` class, gọi activate() rồi trigger command → mock constructor nhận options; đọc `options.deps` từ `mock.calls`. Nếu vi.mock class không capture được options thì capture qua `commandOpenAiChat` — KHÔNG dùng type-level assert (đã bỏ fallback "chấp asserted type-level" ở round 2) |
| 7 | jsdom (regression, F4) | stop giữa stream → bubble streaming bị de-stream ở `done`; turn sau delta vào bubble MỚI, không merge text cũ | sau khi nhận `delta("x")` rồi `done` (không assistant): `querySelector(".vsdb-chat-streaming")` === null (bubble cũ đã de-stream — class streaming bị remove, text "x" giữ nguyên visible); dispatch `delta("y")` → bubble chứa "y" là bubble MỚI (không chứa "x"), trong thread có 2 bubble assistant riêng biệt | jsdom harness hiện có; gửi sequence `delta("x")` → `done` → `delta("y")` qua `window.postMessage`, assert DOM |

Case 7 spec (F4 — orphaned streaming bubble): `done`/`error` handler trong
webview/aiChatPanelMain.ts gọi helper mới `deStreamOpenBubble()`: tìm
`.vsdb-chat-streaming` đang mở, `classList.remove("vsdb-chat-streaming")` — KHÔNG remove
bubble (giữ partial text hiển thị cho user, đúng tinh thần T3.2 giữ delta trước stop).
Việc này đảm bảo delta của turn sau luôn mở bubble mới. `assistant` handler giữ nguyên
(đã remove streaming bubble sẵn). Target: `webview/aiChatPanelMain.ts` case `"done"` và
`"error"` trong message listener.

## Test Files

- `src/ui/__tests__/aiChatPanel.test.ts` — append describe "AiChatPanel — builtin streaming" (cases 1–4).
- `src/ui/__tests__/aiChatPanelWebview.test.ts` — append case 5 + case 7 (de-stream regression).
- `src/extension.test.ts` — append case 6 vào describe TASK-004 wiring.

## Verification Commands

```bash
# Per-task narrowed (RULES test-selection):
npm run typecheck && npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/extension.test.ts

# Wave/cycle boundary — regression net (BẮT BUỘC trước khi claim done):
npm run compile && npm run typecheck && npx vitest run
```

## Acceptance Criteria

- [ ] Mọi test ở §Test Cases PASS (RED trước, GREEN sau).
- [ ] Full suite `npx vitest run` pass (751 baseline + các test mới, 0 fail mới).
- [ ] `npm run compile` (esbuild) pass — no CJS incompat.
- [ ] Không dependency mới (`git diff package.json` trống).
- [ ] apiKey không xuất hiện trong bất kỳ posted message (case 4 assert thêm `not.toMatch(/sk-/i)` như test #5 hiện có).
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- TASK-002 — tiêu thụ `AgentCallbacks.onText` + `AgentDeps.streamComplete` signature.

## Interfaces

- Consumes: từ TASK-002 — `AgentCallbacks.onText?(text: string): void`; `AgentCallbacks.onStreamFallback?(): void` (channel fallback DUY NHẤT, xem TASK-002 Interfaces); `AgentDeps.streamComplete?(cfg, role, req, onText, signal?)` — 5 tham số, `signal` chuyền thẳng từ `runAgent` tham số 4; `runAgent(input, deps, callbacks?, signal?)`. Từ TASK-001 (gián tiếp qua deps closure ở extension.ts): `createProviderClient(opts).streamComplete(req, { onText, signal })`.
- Produces: (none — task cuối cycle)
- Contract fallback event (cho case 3): TASK-002 phát `callbacks.onStreamFallback?.()` đúng 1 lần trước khi gọi `deps.complete` fallback. Panel handler: `onStreamFallback: () => this.post({type:"step", label:"stream fallback"})` — label là literal của panel (KHÔNG import const từ agent.ts; `STREAM_FALLBACK_STEP_LABEL` đã bị bỏ ở round 2 vì kênh notification giờ là callback riêng).
- Webview (cho case 7): thêm helper `deStreamOpenBubble()` gọi trong `case "done"` và `case "error"` — remove class `vsdb-chat-streaming` khỏi bubble đang mở, KHÔNG remove bubble. Spec chi tiết ở "Case 7 spec" trên.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart (round 2 — F2/F4)
Abort transport pin (F2): `AbortController` tạo trong `handleSend` cùng chỗ token
(line ~271), lưu `this.currentAbort`; `handleStop` flip token + `this.currentAbort?.abort()`
(builtin turn chỉ; ACP path không đụng). Signal đi qua MỘT kênh: tham số 4 của
`runAgent(input, deps, callbacks, signal)` → agent pass xuống tham số 5 của
`deps.streamComplete(cfg, role, req, onText, signal)` → extension closure
`streamComplete: (cfg, _role, req, onText, signal) => createProviderClient({...}).streamComplete(req, { onText, signal })` (extension.ts line 270–279 pattern). KHÔNG nhét signal vào callbacks hay input.

### 2026-08-24 · planner · unic/unic-smart
AbortController per turn tạo trong `handleSend` (cùng chỗ token được tạo) và truyền qua
`runAgent` tham số 4 (pin ở trên). Stop hiện chỉ flip token (handleStop line 608) — thêm
`this.currentAbort?.abort()` field riêng cho builtin turn; ACP path không đụng.
Δ `aiChatPanelMessages.ts` expected no-diff (delta type đã có) — nếu reviewer thấy diff
ở file này thì chấp nhận comment-only.

---
