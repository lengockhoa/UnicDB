# TASK-004 — Chat panel omp engine switch + install/update UX + README

## Goal
Panel chọn engine: detectOmp ok ⇒ omp RPC mode (spawn process, set_host_tools, stream events, host-tool executor); không ok ⇒ builtin như cũ + notification 1 lần với install/update hint. README document story.

## Target Files
- `src/ui/aiChatPanel.ts` (sửa — thêm engine mode, KHÔNG đổi builtin behavior), `src/ui/aiChatPanelMessages.ts` (thêm streaming/step messages nếu cần)
- `src/extension.ts` (sửa — truyền deps omp: detectOmp + OmpProcess factory injectable)
- `README.md` (section "AI engine: oh-my-pi (optional)")
- Tests: `src/ui/__tests__/aiChatOmp.test.ts` (mới), `src/ui/__tests__/aiChatPanel.test.ts` (chỉ thêm regression — builtin path nguyên)

## Spec (frozen)
```ts
// aiChatPanel.ts — new optional constructor field (options object pattern, cycle K):
export interface AiChatPanelOptions { /* existing fields */ omp?: {
  detect: () => Promise<OmpDetection>;
  spawn: (cwd: string) => Promise<{ rpc: OmpRpcClient; version: string; onExit(cb: (code: number | null) => void): void; kill(): void }>;
  toolDefs: () => Record<string, unknown>[];
  toolExecutor: (name: string, args: unknown) => Promise<string>;
} }
```
- Engine resolution khi panel show lần đầu (cache trong panel): detect ok ⇒ omp mode; else builtin + post `{type:"engine", name:"builtin", hint: install/update hint}` một lần.
- omp send flow: rpc.request({ type: "set_host_tools", tools: toolDefs() }) một lần khi start → mỗi user msg rpc.request({ type: "prompt", message: text }) + onEvent streaming (message_update assistantMessageEvent text_delta → post `{type:"delta", text}`). **Turn completion KHÔNG dựa vào response success** — response chỉ xác nhận nhận lệnh; gate trên event `agent_end` (isTerminal !== false) → post assistant final + done. Host tool call wire vào rpc.handleHostToolCall với mapping toolName→executor.
- Stop trong omp mode: rpc.request({ type: "abort" }) + token gating như cũ; isTerminal:false agent_end KHÔNG kết thúc turn (test edge).
- Process exit giữa chừng: onExit → post error bubble "omp session ended (code N)" + `{type:"engine", name:"builtin"}` fallback cho turn hiện tại KHÔNG TỰ Ý respawn (nút retry của user sẽ re-detect).
- Builtin path: mọi test cycle K phải còn xanh nguyên (regression net).
- `src/extension.ts`: build omp spawn closure từ OmpProcess + hostToolDefsFromRegistry/createHostToolExecutor với adapterFactory POSTGRES-only như cycle K; inject như options.omp — test qua fake (không spawn thật).
- README: yêu cầu omp >= 17.0.0 (optional), install 1 lệnh `curl -fsSL https://omp.sh/install | sh`, update `omp update`; VSDB extension tự nâng cấp qua lệnh install-vsdb.sh có sẵn (không đổi); security note: omp mode cho agent quyền tool workspace (read/edit/bash scoped cwd) — DB access vẫn read-only qua host tools.

## Test Cases
| # | Loại | Tên | Expected |
|---|------|-----|----------|
| 1 | happy | detect ok + fake spawn + fake rpc | set_host_tools gửi 1 lần với defs; prompt gửi text; delta events post; assistant final + done |
| 2 | happy | host_tool_call qua fake rpc | toolExecutor gọi với name/args; result frame viết lại transport |
| 3 | edge (not installed) | detect → not-installed | builtin engine chạy như cũ (runAgent path); engine message với install hint 1 lần |
| 4 | edge (old version) | detect → version-too-old | builtin + hint update |
| 5 | edge (crash) | fake onExit(1) giữa turn | error bubble + fallback builtin cho turn hiện tại; không respawn tự động |
| 6 | edge (abort/terminal) | send rồi stop: `{type:"abort"}` gửi, delta sau bị gate, done posted. VÀ agent_end với isTerminal=false không kết thúc turn |
| 7 | regression | builtin suite cycle K nguyên vẹn | mọi test cycle K của aiChatPanel (11 host hiện có sau fix round K) + toàn suite xanh |

## Test Files
`src/ui/__tests__/aiChatOmp.test.ts`, `src/ui/__tests__/aiChatPanel.test.ts` (regression additions only)

## Verification Commands
```
npm run compile && npx vitest run src/ui/__tests__/aiChatOmp.test.ts src/ui/__tests__/aiChatPanel.test.ts src/extension.test.ts && npx tsc --noEmit
```

## Acceptance
- [ ] 7 test PASS RED→GREEN (output thật)
- [ ] Không spawn thật omp trong tests (mọi thứ fake/inject)
- [ ] Builtin behavior unchanged (regression #7)
- [ ] README section có install + update + security note
- [ ] `npx tsc --noEmit` + compile sạch

## Interfaces
- Consumes: T1 `OmpRpcClient`/`OmpProcess`, T2 defs/executor, T3 `detectOmp`/hints, cycle K panel/registry/adapterFactory.
- Produces: `(none)` — final consumer.

## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecL-T004
SUMMARY: Added omp engine switch to AiChatPanel (lazy spawn + set_host_tools once + agent_end gating + crash fallback) plus delta/engine messages; wired extension.ts buildOmpDeps closure; README oh-my-pi section.
TEST_PLAN_FOLLOWED: inline (task did not provide one) — 7 cases written first per spec
FILES_CHANGED:
  - src/ui/aiChatPanelMessages.ts: added `AiChatPanelDelta` + `AiChatPanelEngine` host messages.
  - src/ui/aiChatPanel.ts: added `OmpPanelDeps` interface, `omp?` option; lazy engine resolution on first ready; `runOmpTurn` (set_host_tools once → prompt → wait for terminal agent_end → post assistant+done); `ensureOmpSession` wires onExit/onEvent/handleHostToolCall; `handleStop` sends abort request; `handleOmpEvent` streams text_delta deltas + gates on `isTerminal:false`; crash handler post error + done + falls back to builtin.
  - src/ui/__tests__/aiChatOmp.test.ts (new): 7 TDD cases (1 happy detect+spawn+set_host_tools+delta+done; 2 host_tool_call roundtrip via fake rpc; 3 not-installed → builtin + install hint; 4 version-too-old → builtin + update hint; 5 crash mid-turn → error + no respawn + follow-up uses builtin; 6 stop → abort + isTerminal:false does NOT end turn; 7 builtin regression with no omp deps).
  - src/extension.ts: added `buildOmpDeps(adapterFactory)` closure wiring `OmpProcess` + `hostToolDefsFromRegistry` + `createHostToolExecutor` over cycle-K `DbToolRegistry`; inject as `options.omp` to AiChatPanel in `commandOpenAiChat`.
  - README.md: new "AI engine: oh-my-pi (optional)" subsection — install/update commands, VSDB self-upgrade via install-vsdb.sh, security note (DB stays read-only via host tools), crash fallback behavior.
TESTS_ADDED:
  - src/ui/__tests__/aiChatOmp.test.ts: 7 tests (AiChatPanel — omp engine happy path / host tool call / omp not-installed / omp version too old / omp crash mid-turn / omp stop + terminal gating / builtin regression no omp deps).
VERIFICATION:
  command: npm run compile && npx vitest run src/ui/__tests__/aiChatOmp.test.ts src/ui/__tests__/aiChatPanel.test.ts src/extension.test.ts && npx tsc --noEmit
  result: 51/51 pass; tsc clean; compile clean
  output_excerpt: |
    ✓ src/ui/__tests__/aiChatPanel.test.ts  (11 tests) 6ms
    ✓ src/ui/__tests__/aiChatOmp.test.ts    (7 tests) 6ms
    ✓ src/extension.test.ts                 (33 tests) 92ms
ISSUES: none
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review (Rev-T004-2) — reviewer must differ from unic-code per handoff policy

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: ExecL-T004
EXECUTION ISOLATION: OK — executor unic-code, reviewer unic-smart (differs per handoff.reviewer.model)
VERIFICATION_RERUN:
  command: npm run compile && npx vitest run src/ui/__tests__/aiChatOmp.test.ts src/ui/__tests__/aiChatPanel.test.ts src/extension.test.ts && npx tsc --noEmit
  result: 51/51 pass, compile clean, tsc clean
TEST_PLAN_COVERAGE: partial — case #2 asserts executor+result-frame via fake, but cases #1/#6 never assert the panel-to-webview `delta` contract against the real renderer; no case catches that thinking_delta leaks (fake only feeds text_delta); no case asserts single-`done` on crash.
FINDINGS:
  important:
    - file: webview/aiChatPanelMain.ts:236-245 — host posts `{type:"delta"}` and `{type:"engine"}` but the webview message switch has no case for either: both messages are silently dropped by the renderer (verified in dist/aiChatPanel.js — zero occurrences of "delta"/"engine"). The spec's streaming UX (delta text + install hint surfaced) is dead on arrival in the real panel; only the mocked postMessage tests see it. Fix: handle `delta` (append to a streaming bubble) and `engine` (render hint) in the webview switch, or drop both host messages.
    - file: src/ui/aiChatPanel.ts:452-461 — `handleOmpEvent` never checks `assistantMessageEvent.type`. Live-probed omp 18.0.1 (2026-08-23, `--mode rpc --no-session`): thinking events also carry a `delta` field — `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"The user is asking me to reply with..."}}` observed in a real turn. The panel appends every `delta` to `session.buffer` and posts it, so the final assistant message contains model chain-of-thought (thinking) interleaved with the actual text. Fix: only append/post when `assistantMessageEvent.type === "text_delta"`.
    - file: src/ui/aiChatPanel.ts:420-436 — crash handler (onExit) posts `error` + `done` but never sets `this.turnDonePosted = true`. The in-flight `runOmpTurn` (resolver fired at line 434) then posts assistant + a SECOND `done` after the crash's `done`. The turn-boundary contract ("done = no further assistant/step/error") is broken on every crash: user sees crash error + done, then a stale assistant bubble (from the accumulated buffer, which includes leaked thinking) + done again. Fix: set `turnDonePosted = true` in the onExit handler before posting.
    - file: src/ui/aiChatPanel.ts:452-461 — `session.buffer` is never reset between turns (only initialized at spawn, line 416). Turn 2's assistant final contains turn 1's accumulated text (plus turn 1's leaked thinking). Live probe: each assistant turn produces its own message_start/message_update/message_end cycle; nothing on the wire resets the buffer. Fix: clear `session.buffer = ""` at the start of each omp turn.
    - file: src/ui/aiChatPanel.ts:417-437 — spec: "onExit → post error bubble + `{type:"engine", name:"builtin"}` fallback" — the crash handler sets `this.engine = "builtin"` (line 424) but never posts the engine message, so the webview never learns omp mode ended. (Currently masked by the missing webview handling above, but the spec'd UX contract is violated.) Fix: post `{type:"engine", name:"builtin"}` in the onExit handler.
  minor:
    - file: src/ui/aiChatPanel.ts:236 — `{ ...(hint !== null ? { hint } : {}) }` is needlessly indirect; `hint: hint ?? undefined` reads cleaner and behaves identically.
    - file: src/ui/aiChatPanel.ts:326-330 — `runOmpTurn`'s `_registry` param is built unconditionally in `handleSend` even for omp turns; build it only for the builtin branch or drop the param.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: 5 important findings are user-visible: thinking leakage is a correctness/privacy defect (chain-of-thought rendered to end user), stale-buffer duplication and double-done break the chat transcript on every second turn and every crash. The webview gap means the spec'd streaming UX does not exist at runtime despite green tests.
