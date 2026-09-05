# PLAN — Cycle N: Builtin engine streaming (AI Chat)

## §1 Intent

UX: the builtin engine currently posts ONE `assistant` message when the agent finishes — the user waits for the full response (potentially tens of seconds with a multi-step tool loop) looking at a blind spinner, while the ACP engine has been streaming deltas since Cycle L/M (`agent_message_chunk` → `{type:"delta"}` → webview `appendDelta`). The user has the right to see text streaming in for EVERY engine.

The problem lives in 3 layers, none-of-them-streaming:
1. `src/ai/provider.ts` — `complete()` posts `/chat/completions` WITHOUT the `stream` flag (verified: no `stream` key anywhere in the body builder), then `await resp.text()` + `JSON.parse` — can only parse non-stream JSON.
2. `src/ai/agent.ts` — `deps.complete(cfg, role, req)` returns the whole sentence; there is no delta channel going out.
3. `src/ui/aiChatPanel.ts` `runBuiltinTurn` — posts an assistant message ONCE when runAgent settles.

Success = the builtin turn streams deltas to the webview in real time; mid-stream Stop cancels cleanly (no further delta/assistant is posted, `done` still arrives); on stream failure → fallback to non-streaming or a clear error (pick fallback, see §3); **0 new dependencies, 0 network calls in tests, 0 apiKey in the webview/history/error message**.

Cycle J once froze provider/agent per the scope policy — recorded in HISTORY; the ACTIVE record permits unfreezing in N (regression net = full suite 751 baseline).

## §2 Scope

**In-scope**
- `src/ai/provider.ts` — add `streamComplete(req, { onText, signal })` next to `complete()` (chat/completions method). Hand-written SSE parser, `resp.body.getReader()` + TextDecoder.
- `src/ai/agent.ts` — `AgentCallbacks` adds `onText?(text: string): void` + `onStreamFallback?(): void` (fallback channel, F1); `AgentDeps` adds `streamComplete` with 5 parameters + `runAgent` 4th parameter `signal` (F2); loop with 2 modes (deps has/does not have `streamComplete`), fallback to non-stream on pre-emit stream failure per the abort rule (F3).
- `src/ui/aiChatPanel.ts` — `runBuiltinTurn` wires `onText` → `post({type:"delta"})` (abort-token gated), `onStreamFallback` → step label, AbortController + `signal` for stop, error message states the failure mode explicitly.
- `src/extension.ts` — `aiChatDeps` adds a `streamComplete` closure using the exact same pattern as the current `complete` (lines 270–279), accepting `(cfg, role, req, onText, signal)`.
- Builtin banner changes text to "— streaming" + webview de-streams the bubble on `done`/`error` (F4) — file `webview/aiChatPanelMain.ts`, see TASK-003 Target Files.

**Out-of-scope (Non-goals)**
- ACP engine — untouched (already streams).
- DB tools, settings UI, README.
- Streaming for the `responses` method — `streamComplete` throws NotImplemented; `runAgent` prefers `complete` when config `method === "responses"` (chosen so we do not have to write an NDJSON responses parser without a user).
- Tool-call streaming (per-fragment argumentsJson) — the fake registry emits tool calls as a whole block.
- History persistence, DB, package.json deps.

**Wave/file constraint (from brief)**: webview main + messages protocol is a shared surface — one task/wave owns it. No two wave-1 tasks share a file.

## §3 Approach

### A. Provider streaming — SSE, no new dependencies

Wire protocol (OpenAI-compatible chat/completions `stream:true`):
- Request: identical to `complete()` but the body adds `"stream": true` + the header `Accept: text/event-stream`.
- Response 200: body is line-by-line SSE, event = `data: <json>` per line, stream ends with `data: [DONE]`. Delta text lives at `choices[0].delta.content` (string, may be absent — `role`-only opening chunk, or a tool_call chunk). `finish_reason` on the last chunk carries `choices[0].finish_reason`.

Parse strategy (hand-written ~60 lines in provider.ts, no library):
1. `resp.body.getReader()` (Node 18 undici + the host-side webview environment both have it; fallback if `resp.body` is null: read `resp.text()` and split lines as in non-stream — belt and braces, no new network path). **esbuild CJS-compatible**: only use the `ReadableStreamDefaultReader` type from lib.dom (tsconfig already has dom, not yet verified — executor checks; if missing, use `getReader()` without an annotation).
2. Streaming TextDecoder (`{stream:true}`) + manual buffer: split on `"
"`, keep the remainder. Event boundary = blank line; an event may have multiple `data:` lines → concat with `
` before JSON.parse.
3. Per event: `data: [DONE]` → end; otherwise → `JSON.parse` safely (a throw inside the event → skip that event, do not kill the stream — losing 1 chunk still leaves full text), extract `choices[0].delta.content` when it is a string, call `onText(delta)`, record `finish_reason` + `usage`.
4. End: resolve `ProviderResult` with the accumulated text (already streamed via `onText` — the consumer buffers on its own), `toolCalls` from the `delta.tool_calls` chunks (index-based merge: `tool_calls[i]` carries `id`/`name` in the opening chunk, with `arguments` fragments concatenated over time — so the accumulated string is already final), `finishReason` from the last chunk, `usage` from the last `usage` chunk if present (else 0).

**Degradation decision (planner picks per brief)**: `streamComplete` stream request FAILURE (network / HTTP ≥400 / truncated mid-stream) → **throws** `ProviderError` like every other path. **Fallback to non-streaming `complete()` lives in `runAgent` (agent.ts), NOT in provider** — reasons: (a) provider keeps the "thin fetch client" role per the frozen comment at the top of the file and does not decide retry policy; (b) agent is where step semantics live (one step = one provider call, retry is safe because nothing has been committed to history yet); (c) the agent will pass `complete` for fallback — the dependency-injection pattern tests inject a fake into. Lifecycle (pinned in §3.B): stream throws non-abort BEFORE any text has been emitted (`emitted === 0`) → agent signals `callbacks.onStreamFallback?.()` and then uses `deps.complete` for the same request — the panel shows the step label "stream fallback" via a dedicated handler (F1: the callback is the ONLY channel, `AgentStep` stays unchanged). When the stream dies MID-stream (already emitted ≥1 delta) → throw up to the panel → error message reads "stream failed mid-response" — we do not retry the full request because the user has already seen partial text, and resetting the textarea would be more suspicious than keeping text + error.

### B. Agent loop — opt-in streaming through AgentDeps

`AgentDeps` adds optional — signal is the 5th parameter (F2 pin):
```ts
streamComplete?(cfg: AiConfig, role: AiModelRole, req: ProviderRequest,
                onText: (text: string) => void,
                signal?: AbortSignal): Promise<ProviderResult>;
runAgent(input, deps, callbacks?, signal?: AbortSignal)  // signal = 4th parameter
```
Signal transport (ONE end-to-end channel): panel `handleSend` creates an `AbortController` (alongside the token, around line ~271) → `runAgent(..., signal)` → `deps.streamComplete(..., signal)` → provider `streamComplete(req, { onText, signal })` → fetch. `handleStop` flips the token + `abortController.abort()`. NEVER stuff the signal into callbacks/input.

`AgentCallbacks` adds optional `onText?(text: string): void` (delta) and `onStreamFallback?(): void` (F1 pin — the SOLE fallback channel; `AgentStep` keeps its shape). `runAgent` per step: `deps.streamComplete && cfg.method !== "responses"` → stream.

**Fallback + abort rule (F1/F3 pin — MANDATORY check order in catch)**:
1. `err.name === "AbortError" || signal?.aborted` → rethrow immediately, NO fallback, NO `onStreamFallback` — the user Stop MUST NEVER trigger a non-stream re-request (even when abort lands in a tool step with `emitted === 0`). AbortError shape is unified: an `Error` with `name === "AbortError"`, NOT wrapped in `ProviderError` (TASK-001 case 6 pin).
2. `err instanceof ProviderError && emitted === 0` (no `onText` yet) → `callbacks.onStreamFallback?.()` exactly once → `deps.complete(cfg, role, req)` on the same request (non-stream step, no `onText`). The completed step still fires `onStep` as normal. The panel renders via a dedicated handler: `onStreamFallback: () => post({type:"step", label:"stream fallback"})`.
3. The rest (`emitted >= 1` — stream dies mid-stream, or a non-ProviderError) → rethrow up to the panel → error message reads "stream failed mid-response".

### C. Panel — delta + abort token + signal

`handleSend`: creates the `AbortController` alongside the token (around line ~271), stores `this.currentAbort`; `handleStop` flips the token + `this.currentAbort?.abort()`. `runBuiltinTurn` passes the signal through the **4th parameter of `runAgent`** (not through callbacks — F2 pin). `onText` → `if (token.aborted) return; post({type:"delta", text})`. `onStreamFallback` → `post({type:"step", label:"stream fallback"})`. Stop mid-stream: signal aborted → agent throws AbortError → panel catches, does NOT post assistant/history, still sends `done` (exactly matching the existing test #4 pattern). The webview changes the banner label and adds `deStreamOpenBubble()` called in `case "done"` / `case "error"` (F4 pin — remove the `UnicDB-chat-streaming` class from the open bubble, keep the partial text; the next turn bubble is always new and never merges with the old text).

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| unit (happy) | T1.1 streamComplete SSE happy — fake fetch returns 3 data chunks + [DONE] | onText receives "Hel","lo","!" in order; result.text==="Hello!", finishReason==="stop", usage mapped correctly |
| unit (edge-malformed) | T1.2 malformed SSE — 1 data line fails JSON.parse, 1 line missing choices | the bad event is skipped, 2 good events still trigger onText; result does not throw; total text = concat of the 2 good ones |
| unit (edge-boundary) | T1.3 chunk-boundary split — "data: {...}" cut mid UTF-8 char, cut mid line, event with 2 data: lines | onText receives everything, no duplication/loss of fragments; multi-line data concat with \n |
| unit (edge-error) | T1.4 HTTP 401 stream → ProviderError with status 401, bodySnippet with apiKey scrubbed; HTTP 200 but body is non-SSE (regular JSON) | throws ProviderError with correct message/shape; no onText; apiKey never appears |
| unit (edge-abort) | T1.6 opts.signal aborted mid-stream → rejects with a bare AbortError (not wrapped in ProviderError) | err.name === "AbortError", err instanceof ProviderError === false; no onText after abort |
| unit (regression) | T1.7 complete() non-stream behavior unchanged | the 3 existing tests for #1/#8/#10 still pass untouched — no diff outside expected |
| unit (happy) | T2.1 runAgent stream happy — deps.streamComplete emits 2 deltas, ends with final "hi" | onText called twice, result.steps correct, history matches non-stream shape |
| unit (happy-tool) | T2.2 stream tool loop — step 1 streams tool_calls, step 2 streams text | tool step does NOT call onText, text step calls onText; ProviderResult merges argumentsJson correctly |
| unit (edge-fallback) | T2.3 streamComplete throws ProviderError before any onText → fallback to deps.complete | `onStreamFallback` called exactly once before complete; deps.complete called once on the same request, result matches, run continues normally |
| unit (edge-midstream) | T2.4 stream dies after 1 delta → throw to caller (NO fallback) | runAgent throws the original ProviderError, deps.complete is not called again |
| unit (edge-abort) | T2.5 signal aborted → AbortError propagates, NO fallback (even with emitted===0, e.g. abort in tool step) | runAgent rejects with err.name==="AbortError"; deps.complete is NOT called; no further step is committed to history |
| unit (happy) | T3.1 send builtin turn → delta messages in order + assistant at the end | posted: delta "a", delta "b", assistant, done — correct order; history pushed correctly |
| unit (edge-abort) | T3.2 stop mid-stream: deltas before stop kept, delta/assistant after stop NOT posted | onText after abort is gated; assistant not posted; done still arrives (test #4 pattern) |
| unit (edge-fallback) | T3.3 stream fail pre-emit + fallback → `onStreamFallback` handler posts step label "stream fallback" | posted contains {type:"step", label:"stream fallback"}; assistant still posted; done arrives |
| unit (edge-error) | T3.4 both stream and fallback fail → error message contains "stream" + "AI" | error bubble has the right content, panel does not dispose |
| jsdom (happy) | T3.5 engine banner builtin shows "Engine: builtin — streaming" | banner.textContent matches exactly |
| unit (wiring) | T3.6 extension deps: streamComplete with 5 parameters (cfg, role, req, onText, signal), captured via vi.mock on AiChatPanel constructor options | typeof === "function"; called with fake cfg/req/spy/signal it resolves without crashing; UnicDB.aiChat stays registered |
| jsdom (regression) | T3.7 stop mid-stream → done de-streams the bubble; the next turn delta lands in a NEW bubble | after delta("x")+done: no more .UnicDB-chat-streaming; delta("y") creates a separate bubble that does not contain "x" (F4) |
| typecheck | contract AiChatPanelOptions/AgentDeps extension.ts | npm run typecheck passes — closure pattern correct, no ts errors |

## §5 Verification Commands

**Per-task narrowed selection** (per RULES.md test-selection, each task ≤2 files):
- TASK-001: `npx vitest run src/ai/__tests__/provider.test.ts src/ai/__tests__/agent.test.ts` — provider = the file edited; agent = the direct consumer of the new types.
- TASK-002: `npx vitest run src/ai/__tests__/agent.test.ts` (regression) + new file `src/ai/__tests__/agentStream.test.ts`.
- TASK-003: `npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts src/extension.test.ts` (case 6 wiring lives in extension.test.ts).

**Each task** adds (project script already exists in package.json — verified):
```bash
npm run typecheck && npx vitest run <selection>
```

**Wave boundary / end of cycle (regression net — mandatory)**:
```bash
npm run compile && npm run typecheck && npx vitest run
```
(751 baseline + skipped opt-in smoke, no new failures.)

## §6 Acceptance

- [ ] T1: `streamComplete` streams real SSE (injected fetch), bare AbortError on signal abort, no fallback, types pass — TASK-001
- [ ] T2: runAgent streams through injected deps; `onStreamFallback` exactly once pre-emit; mid-stream throw; abort NEVER falls back (even with emitted===0) — TASK-002
- [ ] T3: builtin turn posts delta in order + assistant + done; stop gating; `onStreamFallback` step label; error path; streaming banner; webview de-streams bubble on done/error (F4) — TASK-003
- [ ] extension.ts closure `streamComplete(cfg, role, req, onText, signal)` compiles + typechecks — TASK-003
- [ ] Full suite passes at end of cycle (regression net) — TASK-003/wave boundary
- [ ] No new dependency in package.json — TASK-003 (final audit)

## §7 Task Split

| Task | Files (owner per wave) | Dependencies | Wave |
|---|---|---|---|
| TASK-001 | src/ai/provider.ts | none | 1 |
| TASK-002 | src/ai/agent.ts | TASK-001 (consumes AgentStreamDeps) | 2 |
| TASK-003 | src/ui/aiChatPanel.ts, src/ui/aiChatPanelMessages.ts, webview/aiChatPanelMain.ts, src/extension.ts | TASK-002 | 3 |

Wave layout: `wave 1: 1 task | wave 2: 1 task | wave 3: 1 task` — the chain is BY DESIGN (real interface dependency at every layer), cannot be widened because each task consumes symbols from the previous one. §2 already noted: if TASK-002 and TASK-003 could be split into separate files to run wave 2 in parallel → but agent.ts is the interface gate — TASK-003 needs the exact signature of `onText`/`streamComplete` to compile, so the chain stays for this small cycle (3 tasks max per brief).

Files shared between tasks: none (verified each target path exists; no file is touched by 2 tasks in the same wave).

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: nothing
Known gaps:
- `ReadableStreamDefaultReader` type annotation may not exist in the current tsconfig — TASK-001 Discussion already noted the workaround (use unannotated `getReader()` or declare a local structural type), not a blocker.
- lib.dom/dom.iterable flags in tsconfig not yet verified individually — only affects annotations, not runtime (`getReader()` is structural).
- Coverage: every acceptance criterion in §6 maps to a task; §1 success definition (real-time stream + stop + fallback + no-dep/no-key/no-network) is fully covered by T1.x–T3.x; unhappy paths (401, malformed, truncated, abort, non-SSE body, mid-stream failure) live in §4.
- T1.5 is a regression check (3 existing tests unchanged) — not a new test, just a selection narrowed per RULES.

## Planner Self-Audit — Round 2 (post plan-review)
Checklist: 12/12 pass (re-run after applying F1-F6; task chain + file ownership unchanged).
Fixed during audit: F1-F6 resolution (details in "Round 2 — Resolution" below).
Known gaps: keep the round-1 gaps (ReadableStreamDefaultReader annotation, lib.dom flags — not blockers). New: TASK-003 case 6 depends on the ability of vi.mock to capture the `AiChatPanel` constructor options — fallback capture via `commandOpenAiChat` is documented; if neither works, the executor reports to Discussion instead of inventing a mechanism (no type-level escape hatch).

## Round 2 — Resolution (planner response to review findings)

F1 [IMP] Fallback channel: choose **callback** — `AgentCallbacks.onStreamFallback?(): void`, fires exactly once before `deps.complete` fallback; `AgentStep` keeps its shape; remove `STREAM_FALLBACK_STEP_LABEL` (the "stream fallback" label is a literal owned by the panel). Pinned in §3.A/§3.B + TASK-002 Produces + TASK-003 case 3/Interfaces.
F2 [IMP] Abort transport: signal goes through ONE channel — `runAgent(input, deps, callbacks, signal?)` 4th parameter → `deps.streamComplete(cfg, role, req, onText, signal?)` 5th parameter → extension closure `streamComplete(req, { onText, signal })`. Pinned in §3.B/§3.C + TASK-002 case 5 fixture + TASK-003 case 6 + Discussion round 2.
F3 [IMP] Abort-vs-fallback: rule unified across all 3 documents — catch order: (1) `err.name === "AbortError" || signal?.aborted` → rethrow, no fallback (even emitted===0/tool-step abort); (2) ProviderError && emitted===0 → onStreamFallback + complete; (3) otherwise rethrow. AbortError shape pinned: `Error` with `name === "AbortError"`, never wrapped in ProviderError — TASK-001 case 6 (new) + T2.5 update.
F4 [IMP] Orphaned streaming bubble: webview adds `deStreamOpenBubble()` called in `case "done"` + `case "error"` — removes the streaming class, keeps the bubble + partial text. TASK-003 case 7 (new, jsdom regression): delta("x") → done → delta("y") opens a new bubble, no merge.
F5 [MIN] Case 6: remove the type-level escape hatch — capture real values via vi.mock on the `./ui/aiChatPanel` class constructor options (or `commandOpenAiChat`); if infeasible → Discussion, no type-assert.
F6 [MIN] include_usage: DECISION to NOT send `stream_options:{include_usage:true}` — not universally supported (some OpenAI-compatible servers reject the request); usage is taken from the last chunk if the server sends it, else {0,0}. Recorded in TASK-001 §Interfaces.

Chain/wave UNCHANGED: TASK-001 → TASK-002 → TASK-003 (real interface dependency).
Each task still has ≥1 happy + ≥2 distinct edge types + regression.

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
1. [IMPORTANT] Fallback notification channel is undefined. PLAN §3.A says the fallback decision is reported via `onStreamFallback` ("the decision is recorded in onStreamFallback (panel shows the step label)"), but TASK-002 §Interfaces frozen `AgentCallbacks` = {onStep, onError, onText} only, and states "the fallback step still fires onStep as usual... no extra field on AgentStep". With AgentStep unchanged and onStep firing normally, the panel cannot distinguish a fallback step from a normal one — its onStep handler (src/ui/aiChatPanel.ts:325-333) only posts labels for tool-carrying steps, so TASK-003 case 3 (`posted contains {type:"step", label:"stream fallback"}`) is unimplementable as specified. Fix: add `onStreamFallback?(): void` to AgentCallbacks in TASK-002 Prod…
2. [IMPORTANT] AbortSignal has no transport from panel to provider. TASK-001 `StreamRequestOptions.signal?: AbortSignal` (good), but TASK-002 frozen `AgentDeps.streamComplete?(cfg, role, req, onText)` carries no signal, `AgentCallbacks` carries no signal, and TASK-003 Discussion leaves it open ("pass it via runAgent input or callbacks"). Consequences: TASK-002 case-5 fixture "streamComplete receives opts.signal" is unsatisfiable against the frozen signature, and TASK-003 extension closure `streamComplete(req, { onText, signal })` has no signal source (extension.ts:270-279 receives only cfg/role/req). Fix: pin ONE channel — recommended 5th optional param `signal?: AbortSignal` on `AgentDeps.streamComplete` — in PLAN §3.B/§3.C + TASK-002 Produces + TASK-003 C…
3. [IMPORTANT] Abort can trigger the fallback retry, and the abort error shape contradicts itself across tasks. TASK-001 says opts.signal aborted mid-stream → "throw ProviderError timeout-like"; the fallback rule (PLAN §3.B, TASK-002 case 3) is "catch ProviderError with emitted === 0 → deps.complete same request". A user Stop during a tool step (no text emitted yet) would therefore re-issue a FULL non-stream provider request after the user pressed Stop — violating §1 "Stop mid-stream cancels cleanly". Also T2.5 expects rejection "message contains abort" while T1 timeout-like ProviderError message contains no "abort". Fix: pin in TASK-002 — if `signal?.aborted` (or error is AbortError), rethrow immediately, NEVER fallback; and pick one abort representation (recommen…
4. [IMPORTANT] Orphaned streaming bubble merges next turn text after mid-stream stop. Webview `appendDelta` (webview/aiChatPanelMain.ts:251-266) reuses the existing `.UnicDB-chat-streaming` bubble; only `case "assistant"` (:423-434) removes it. T3.2 deliberately keeps pre-stop deltas visible, so after Stop the orphaned bubble stays marked streaming and the NEXT turn first `delta` appends into it — aborted partial text merges into the new answer. Fix in TASK-003: de-stream or remove the open streaming bubble on turn end/turn start (e.g. `done` handler or on send), and extend case 2 to assert a second turn delta starts a fresh bubble.
5. [MINOR] TASK-003 case 6 contradicts itself: "must obtain a real reference (no copy-paste code)" then offers "accept a type-level assert" as fallback. Pick one; capturing the real deps is feasible by vi.mock-ing the panel/command module and asserting on the constructor/options argument.
6. [MINOR] TASK-001 stream body does not send `stream_options:{include_usage:true}`; most OpenAI-compatible servers then omit usage and T1.1 real-world usage will be {0,0} (plan accepts else-0, tests are self-contained so they still pass). One line in TASK-001 deciding whether to send it would remove the ambiguity.

VERIFIED-GOOD (no action): §1 diagnosis exact (complete() = await resp.text() + JSON.parse, no stream key — provider.ts:300-411; runAgent single await deps.complete — agent.ts:152; panel posts one assistant — aiChatPanel.ts:284-323); ACP delta path exists (aiChatPanel.ts:467-468) and webview already renders delta + replaces streaming bubble on assistant — TASK-003 correctly scopes webview change to the banner label only (aiChatPanelMain.ts:278-282); AiChatPanelDelta exists at aiChatPanelMessages.ts:47 so expected-no-diff is right; package.json has no lint script so typecheck is the correct gate, and all three task Verification Commands include `npm run typecheck` (+ compile at cycle boundary); tsconfig lib includes DOM so `ReadableStreamDefaultReader` annota…

REQUIRED REWORK: apply F1-F4 (interface pins in PLAN §3 + TASK-002 §Interfaces + TASK-003 cases 2/3 + TASK-001 abort-shape line) before wave 1 starts — they are one-contract edits, not re-splitting; quick Round-2 re-review after planner applies.

NOTES: Plan structure, diagnosis, and test design are sound; all six findings are cross-document contract pins an executor cannot resolve without inventing interfaces the plan itself forbids inventing.

### Round 2 — 2026-08-24 · unic/unic-smart
Status: Approved

RESOLUTION CHECK (F1-F6 re-verified against working tree, not planner claims):
  - F1 OK — `AgentCallbacks.onStreamFallback?(): void` is the sole fallback channel (TASK-002 Interfaces), fires exactly once before `deps.complete` (PLAN §3.B rule 2 ≡ TASK-002 rule 2, identical wording); AgentStep unchanged; `STREAM_FALLBACK_STEP_LABEL` survives only in historical Round-1/resolution prose, zero live contracts; TASK-003 case 3 implementable — webview `case "step"` → `appendStep` exists (aiChatPanelMain.ts:414).
  - F2 OK — exactly one abort transport, identical in PLAN §3.B, TASK-002 Interfaces + case-5 fixture ("5th parameter"), TASK-003 case 6 + Discussion (incl. extension.ts closure `(cfg, _role, req, onText, signal) => ...`); anchor verified: `complete` closure pattern exists at extension.ts:270-279.
  - F3 OK — catch order pinned identically in PLAN + TASK-002: (1) `err.name==="AbortError" || signal?.aborted` → rethrow, never fallback (explicitly even emitted===0 / tool-step abort); (2) `ProviderError && emitted===0` → onStreamFallback + complete; (3) else rethrow. Abort shape = bare `Error` with `name==="AbortError"`, never ProviderError-wrapped (TASK-001 case 6 + StreamRequestOptions comment + TASK-002 case 5 sub-case). Round-1 contradiction (timeout-like ProviderError) is gone from TASK-001.
  - F4 OK — `deStreamOpenBubble()` pinned for `case "done"` + `case "error"`; both cases exist today without de-stream (aiChatPanelMain.ts:436/:439) so the spec targets a real gap; TASK-003 case 7 asserts delta(x)→done→delta(y) opens a fresh bubble, no merge.
  - F5 OK — case 6 is real capture (vi.mock `./ui/aiChatPanel` class → read `options.deps` from `mock.calls`), secondary capture via `commandOpenAiChat`, explicit "DO NOT use type-level assert"; escalation-to-Discussion path recorded in Self-Audit round 2.
  - F6 OK — decision recorded both places (PLAN Round-2 Resolution + TASK-001 §Interfaces): do not send `stream_options:{include_usage:true}`; usage from final chunk if server sends, else {0,0}.

COMPLETENESS:
  - none — every task ≥1 happy + ≥2 distinct edge types + regression; wave-boundary full-suite gate present in TASK-003 Verification Commands.
CONSISTENCY:
  - none blocking. Minor gloss: PLAN §5 parenthetical "each task ≤2 files" conflicts with TASK-003 4-file selection; RULES.md test-selection actually resolves per target file (4 targets → 4 test files), so the task file is RULES-correct — PLAN gloss stale, cosmetic only.
CLARITY:
  - none blocking. PLAN §4 bundles non-SSE-200 into row T1.4 name while TASK-001 numbers it case 5 (and Round-1 audit mis-references it as "T1.5"); coverage identical, task file is authoritative for executors.
SCOPE:
  - none — chain TASK-001→002→003 unchanged, zero shared file per wave.
YAGNI:
  - none — no tool-call streaming, no responses streaming, no new deps.

NOTES: All pins re-checked against current source anchors (extension.ts:270-279; aiChatPanelMessages.ts:47 delta type; aiChatPanelMain.ts:414/436/439; package.json scripts typecheck/compile exist, no lint → typecheck gate correct). INDEX already shows all three tasks `ready` — no index change required. Wave 1 cleared to start.
