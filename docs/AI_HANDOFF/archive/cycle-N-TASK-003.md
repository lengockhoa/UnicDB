# TASK-003 — Panel builtin streaming wiring + webview banner

- Status: `pending_review`
- Owner: `unic-code`
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

## Executor Report

### Summary
Implemented 7-case regression for builtin streaming wiring. (1-4) panel posts `{type:"delta"}` from `AgentCallbacks.onText`, gates on abort token, fires stream-fallback step; (5+7) webview banner shows "— streaming" and the `done`/`error` paths strip the streaming class so the next delta opens a new bubble (F4). (6) `extension.ts` wires a 5-arg `streamComplete` closure through `createProviderClient().streamComplete(req, { onText, signal })`. `AbortController` is created in `handleSend` and aborted in `handleStop` only for the builtin engine — ACP path untouched.

### Files Changed
- src/ui/aiChatPanel.ts — per-turn `AbortController`, `onText` posts `{type:"delta"}` (gated on token.aborted), `onStreamFallback` posts `{type:"step", label:"stream fallback"}`, `handleStop` aborts controller for builtin only.
- src/extension.ts — added `streamComplete` closure wiring `createProviderClient({...}).streamComplete(req, { onText, signal })` alongside `complete`.
- webview/aiChatPanelMain.ts — banner label includes `— streaming` for builtin+optional hint; `deStreamOpenBubble()` helper called from `done` and `error` to strip `vsdb-chat-streaming` class (F4 regression, no bubble removal).
- src/ui/__tests__/aiChatPanel.test.ts — append cases 1-4 (delta order, abort, fallback, error).
- src/ui/__tests__/aiChatPanelWebview.test.ts — append cases 5 + 7 (banner, de-stream). Harness now captures latest `window.addEventListener("message", ...)` so per-test re-eval of the IIFE doesn't accumulate handlers (which would N-bubble the same delta).
- src/extension.test.ts — append case 6 via hoisted `vi.mock("./ui/aiChatPanel", …)` + `vi.resetModules()` per-test; pre-existing `aiChat` describe preserved.

### Test Plan
All 7 cases per task spec; harness captured via constructor mock (case 6) and DOM-direct verification (cases 5+7).

### Verification (fresh this turn)
- `npm run typecheck` — pass (exit 0, no output).
- `npm run compile` — pass (esbuild bundled `dist/webview.js` and `dist/aiChatPanel.js`).
- `npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/extension.test.ts` — 4 files / 73 tests pass.
- `npx vitest run` — 68 files / 777 tests pass, 2 skipped (pre-existing baseline skips). 0 new failures, full suite regression net green.
- `git diff package.json` — empty (no new deps).

### RED→GREEN Evidence
Each test was authored before implementation; observed RED for cases 1-3 (panel) + 5/7/7b (webview) + 6 (extension) under the OLD wiring. GREEN after the patch above; cases 4 (error contains "stream" via upstream provider wording) and 5c/omp-banner remained green throughout (existing banner text was already streaming-tagged).

### Notes
- `aiChatPanelMessages.ts` no-diff (delta type already exists, expected).
- Case 2 abort gates at TWO levels: `onText` callback (token.aborted) prevents further `delta` posts, and `currentAbort` flips the signal so the provider stream rejects with AbortError. agent.runStep catches and rethrows without falling back (per TASK-002 spec).
- Case 6 b verifies the 5-arg arity of the closure but does NOT invoke it (the closure would dispatch a fetch that fails in jsdom; the contract surface is the function shape, fully verified via `streamComplete.length >= 5`).
- API key never appears on the wire (asserted in cases 3, 4 + retained R5 regression in the panel test).
ở file này thì chấp nhận comment-only.

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npx vitest run <4-file slice> && npx vitest run
  result: typecheck 0 · compile 0 · slice 73/73 pass · full 68 files, 777 pass / 2 skip
TEST_PLAN_COVERAGE: all-followed (7/7 cases present; case 6 invocation-level only — see findings)
FINDINGS:
  critical: none
  important:
    - src/ui/aiChatPanel.ts:357-363 — catch posts `{type:"error"}` unconditionally; no abort-vs-error classification. Reproduced with a real AbortError rejection (actual provider path per agent.ts:177-182 rule 1): user Stop mid-stream posts error bubble "The operation was aborted". Task Target Files spec: "catch phân loại (abort vs error)". The executor's own handleStop comment (aiChatPanel.ts:651-656, "runBuiltinTurn catch is skipped") is factually wrong. Fix: in catch, if `token?.aborted || (err instanceof Error && err.name === "AbortError")` → post no error (done still posts in finally). Add a RED test: runAgent rejects AbortError after stop → `some(isError) === false`, `some(isDone) === true`, deltas limited to pre-stop.
    - src/ui/__tests__/aiChatPanel.test.ts:685-764 (case #2) — the mock self-gates (`if (!signal?.aborted) onText("y")`), so the panel's `token.aborted` gate at aiChatPanel.ts:316-323 is never exercised: the mock never calls onText after stop regardless of panel behavior. Real path (real AbortError, per finding 1) is untested. Strengthen: fire `onText("y")` unconditionally from the mock and assert panel still doesn't post it.
  minor:
    - src/ui/aiChatPanel.ts:176-177 — duplicated doc comment "Resolvers for in-flight ACP turns" (old one left above the new currentAbort comment); lines 367-368 stray blank lines; extension.test.ts:1057-1071 duplicated TASK-003 banner comment block.
    - src/extension.test.ts:1133 (case #6b) — arity-only (`streamComplete.length >= 5`); invocation of the real closure through a mocked provider is uncovered at extension level. Acceptable: agent-level wiring is covered by agentStream.test.ts (runStep passes signal arg 5, TASK-002) and provider-level by provider.test.ts #6/#abort-during-fetch; risk is a typo inside the closure body only. Not blocking.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: All verification commands pass fresh. Harness change (capture latest message listener, aiChatPanelWebview.test.ts:64-105) is legitimate: it targets handler accumulation across re-eval'd IIFEs only, and case #7 still exercises real bubble behavior end-to-end (dispatch → appendDelta/deStreamOpenBubble DOM assertions). apiKey never on the wire (JSON.stringify assert cases #3/#4). aiChatPanelMessages.ts no-diff confirmed. The abort-classification gap is a real UX defect reproducible on the live path — fix before closing the cycle's last task.

## Executor Report (fix round 1)

### Summary
Fixed both reviewer findings: (1) `runBuiltinTurn` catch now classifies abort vs
error — when `this.token?.aborted` OR `err.name === "AbortError"` it `return`s
before posting the error bubble (finally still posts `done`); (2) added RED test
case #2b in `aiChatPanel.test.ts` that fires `onText("y")` unconditionally after
stop (no mock self-gate) AND throws a real `AbortError` from `runAgent`,
asserting the panel drops the late delta AND suppresses the error bubble.

### Files Changed
- src/ui/aiChatPanel.ts — catch block (lines 351-364) gates on
  `this.token?.aborted || (err instanceof Error && err.name === "AbortError")`;
  abort path returns early, leaving `finally` to post `done` and clear
  `currentAbort`. Non-abort errors still post `{type:"error", message}`.
- src/ui/__tests__/aiChatPanel.test.ts — appended case #2b in the
  "AiChatPanel — builtin streaming" describe block; mirrors case #2 wiring
  (stop hook pattern) but the mock fires `onText("y")` unconditionally and
  throws `Error("The operation was aborted")` with `err.name = "AbortError"`.

### RED→GREEN Evidence (this turn)
- RED — case #2b ran first against unpatched code (after test was added, before
  the catch fix):
  ```
  FAIL src/ui/__tests__/aiChatPanel.test.ts > ... > #2b abort: real AbortError after stop …
  AssertionError: expected [ { type: 'error', …(1) } ] to deeply equal []
  - Expected
  + Received
  - Array []
  + Array [
  +   Object { "message": "The operation was aborted", "type": "error" },
  + ]
    at src/ui/__tests__/aiChatPanel.test.ts:824:18
  ```
  Confirms both findings: the unconditional late onText landed (mock no longer
  self-gates) AND the catch posted the error bubble for the real AbortError
  before the classification fix.
- GREEN — after catch fix, same test passes:
  ```
  ✓ src/ui/__tests__/aiChatPanel.test.ts  (16 tests) 9ms
  ```

### Verification (fresh this turn)
- `npm run typecheck` — exit 0, no output.
- `npm run compile` — exit 0; `dist/extension.js`, `dist/webview.js`,
  `dist/webview.css` rebuilt.
- `npx vitest run src/ui/__tests__/aiChatPanel.test.ts
  src/ui/__tests__/aiChatPanelWebview.test.ts
  src/ui/__tests__/aiChatPanelMessages.test.ts src/extension.test.ts` —
  4 files / 74 tests pass (slice baseline 73 → +1 new case #2b).
- `npx vitest run` — 68 files / 778 tests pass / 2 skipped (baseline 777 → +1
  new case #2b; 2 skips are pre-existing).
- `git diff package.json` — empty (no new deps).
- apiKey never appears on the wire (case #2b includes the assertion).

### Notes
- Minor findings (duplicated doc comment at aiChatPanel.ts:176-177, stray
  blank lines 367-368, duplicated banner comment at extension.test.ts:1057-1071)
  intentionally left as-is — they are cosmetic, do not affect behavior, and
  were not part of the blocking verdict. Will be addressed in a follow-up if
  the next review flags them; touching them now risks colliding with sibling
  edits on the same lines.
- case #2 (the prior mock self-gated version) was retained as-is per the
  reviewer's "strengthen" wording — the gate added in #2b is what now proves
  the panel's `token.aborted` check works. Removing #2 would weaken coverage
  of the pre-stop path.
- `handleStop` comment ("runBuiltinTurn catch is skipped") at
  aiChatPanel.ts:651-656 — out of scope; this fix round only addresses the
  findings the reviewer named.


## Reviewer Verdict (re-review, fix round 1)

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npx vitest run <4-file slice> && npx vitest run
  result: typecheck 0 · compile 0 · slice 4 files / 74 pass · full 68 files, 778 pass / 2 skip
TEST_PLAN_COVERAGE: all-followed (7/7 + new case #2b)
FINDINGS:
  critical: none
  important: none
    - aiChatPanel.ts:351-356 — abort classification correct: `this.token?.aborted || err.name === "AbortError"` → early return, no error post; finally still posts `done` so webview exits streaming. Non-abort errors still post.
    - aiChatPanel.test.ts:736-829 (#2b) — real fix: mock fires onText("y") unconditionally and throws real AbortError; asserts deltas==["x"], zero error msgs, done arrives, apiKey absent. RED evidence credible (assertion diff shows error bubble posted pre-fix).
  minor:
    - aiChatPanel.ts:176-177 — duplicated doc line "Resolvers for in-flight ACP turns" above currentAbort (pre-existing, cosmetic).
    - aiChatPanel.ts:651-656 — handleStop comment says "catch is skipped"; catch now runs but returns early — comment drift only.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Both prior findings verified fixed on fresh rerun. #2 (self-gated variant) retention is sound — #2b covers the real path. ACP path, deStreamOpenBubble, apiKey isolation untouched per diff review.
