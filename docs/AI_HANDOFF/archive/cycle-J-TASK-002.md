# TASK-002 — OpenAI-compatible provider client (src/ai/provider.ts)
- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §2,§3,§7

## Goal
Pure thin fetch client for OpenAI-compatible endpoints: method switch
(`chat/completions` vs `responses`), timeout via AbortController, typed error mapping with
apiKey-scrubbed snippets, vision content parts. Injectable `fetch` — unit-testable with
fakes, zero network. NO vscode import, NO `src/ai/*` import (fully standalone in wave 1).

## Target Files
- `src/ai/provider.ts` (new) · `src/ai/__tests__/provider.test.ts` (new)

## Spec — contract (normative, frozen)
```ts
// src/ai/provider.ts
export type FetchLike = (url: string, init: {
  method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<Response>;

/** Chat-shaped message — method-agnostic internal currency (agent + callers use this). */
export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;                        // type:"text"
  imageUrl?: string;                    // type:"image_url" — data URL or https URL
}
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];  // tool role: string (result payload)
  toolCallId?: string;                  // tool role
  toolCalls?: ToolCall[];               // assistant role
}
export interface ToolCall { id: string; name: string; argumentsJson: string }
export interface ToolDef {
  name: string; description: string;
  /** JSON Schema for the parameters object. */
  parameters: Record<string, unknown>;
}
export interface ProviderRequest {
  modelId: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxOutputTokens?: number;
  temperature?: number;
}
export interface ProviderResult {
  text: string;                 // concatenated assistant text ("" when none)
  toolCalls: ToolCall[];        // [] when none
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage: { inputTokens: number; outputTokens: number };  // 0 when server omits
}
export class ProviderError extends Error {
  status?: number;   // HTTP status when server responded
  timeout: boolean;  // true iff AbortController fired
  endpoint: string;  // full URL attempted
  bodySnippet: string; // ≤300 chars of response body, apiKey SCRUBBED (all occurrences → "***")
}
export interface ProviderOptions {
  baseUrl: string; apiKey: string; method: "responses" | "chat/completions";
  timeoutMs?: number;              // default 60000
  fetch?: FetchLike;               // default globalThis.fetch (Node 18)
}
export function createProviderClient(opts: ProviderOptions): {
  complete(req: ProviderRequest): Promise<ProviderResult>;
};
export function buildChatCompletionsBody(req: ProviderRequest): Record<string, unknown>;
export function parseChatCompletionsResponse(json: unknown): ProviderResult;
export function buildResponsesBody(req: ProviderRequest): Record<string, unknown>;
export function parseResponsesResponse(json: unknown): ProviderResult;
```
Wire behavior (normative):
- URL: `` `${normalize-trimmed baseUrl}/${method === "responses" ? "responses" : "chat/completions"}` `` — treat trailing-slash baseUrl safely (no `//`).
- Headers: `{"Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`}`.
- chat/completions body: `{model, messages, tools?, max_tokens?, temperature?}`; message
  mapping: content parts → `[{type:"text",text}, {type:"image_url",image_url:{url}}]`;
  tool result message → `{role:"tool", tool_call_id, content}`; assistant with toolCalls →
  `tool_calls: [{id, type:"function", function:{name, arguments}}]`.
- chat/completions parse: first `choices[0]`; `finish_reason` map `stop|tool_calls|length`
  else `other`; `message.content` string or `""`; `message.tool_calls[]` → ToolCall
  (`arguments` passthrough); `usage.prompt_tokens/completion_tokens` → input/output, 0 when absent.
- responses body: `{model, instructions, input: [...], tools?, max_output_tokens?, temperature?}`
  where `instructions` = concatenated SYSTEM messages; input items: user → `{role:"user",
  content:[{type:"input_text",text},{type:"input_image",image_url}]}`, assistant → `{role:"assistant",
  content:[{type:"output_text",text}]}` (+ `""` if empty), tool → `{type:"function_call_output",
  call_id, output}`; tools → `{type:"function", name, description, strict:false, parameters}`.
- responses parse: `output_text` (string) or concatenated `output[].content[].text` where
  `type === "output_text"`; toolCalls from `output[]` items `type === "function_call"` →
  `{id: item.call_id, name: item.name, argumentsJson: item.arguments}`; finishReason:
  `status` `"completed"` → `toolCalls.length ? "tool_calls" : "stop"`; `incomplete` → `length`;
  else `other`; `usage.input_tokens/output_tokens`, 0 when absent.
- Errors (all → ProviderError, message lowercase-first):
  non-2xx → `${status} ${statusText} — ${snippet}` (no timeout); fetch reject with
  `e.name === "AbortError"` → `request timed out after ${timeoutMs}ms` (`timeout:true`);
  other fetch reject → `network error: ${e.message}`; JSON.parse fail on 2xx body →
  `invalid JSON in response`. `bodySnippet` scrubs the apiKey BEFORE storage on the error.

## Test Cases (REQUIRED — TDD)
| # | Type | Test name | Expected |
|---|------|----------|----------|
| 1 | unit | chat request shape | fake fetch; complete(validReq) → URL `https://x/v1/chat/completions`, headers Bearer `sk-1`, body JSON: model, messages[0].role/content, `max_tokens`, `temperature` keys present; usage parsed |
| 2 | unit | responses request shape | method `responses` → URL `.../responses`; body has `instructions` (system text), `input` items in responses shape (user text part → `input_text`), `max_output_tokens` |
| 3 | unit | chat parse: text + finishReason | `choices[0].finish_reason:"stop"`, content "Hello", no tool_calls, usage present → `{text:"Hello", toolCalls:[], finishReason:"stop", usage:{inputTokens:10,outputTokens:5}}` |
| 4 | unit | chat parse: tool calls | `finish_reason:"tool_calls"`, `tool_calls[0] {id:"c1", function:{name:"get_schema", arguments:"{\"q\":1}"}}` → toolCalls deep-equal, finishReason `"tool_calls"` |
| 5 | unit | responses parse: output_text | `{output_text:"Hi", status:"completed", usage:{input_tokens:3, output_tokens:2}}` → text "Hi", toolCalls [], finishReason "stop", usage {3,2} |
| 6 | unit | responses parse: function_call item | output `[{"type":"function_call","call_id":"c9","name":"run_sql","arguments":"{}"}]`, status "completed" → toolCalls `[{id:"c9",name:"run_sql",argumentsJson:"{}"}]`, finishReason "tool_calls", text "" |
| 7 | unit | vision parts both methods | user message `[{type:"text",text:"what is this"},{type:"image_url",imageUrl:"data:image/png;base64,AAA"}]` → chat body `image_url:{url:"data:image/png;base64,AAA"}`; responses body `input_image` with same URL |
| 8 | edge (timing) | timeout aborts | fetch rejects `{name:"AbortError"}` → ProviderError `timeout === true`, message contains `timed out after 100ms`, endpoint = attempted URL |
| 9 | edge (malformed) | 200 non-JSON | resolves `Response` with body `"not json{"` → ProviderError message `invalid JSON in response`, `status` undefined |
| 10 | edge (security) | apiKey scrubbed from error snippet | 401 body `"Unauthorized for key sk-secret-123"` (echoes key), apiKey `sk-secret-123` → thrown ProviderError `bodySnippet === "Unauthorized for key ***"` (every occurrence) |
| 11 | edge (boundary) | trailing-slash baseUrl | baseUrl `"https://x/v1/"` → fetch URL exactly `https://x/v1/chat/completions` (single slash) |
| 12 | edge (missing data) | empty/absent optionals | chat JSON with no `usage`, content `null`, empty `tool_calls` → `{usage:{0,0}, text:"", toolCalls:[], finishReason:"other"}` for unknown finish_reason |
| 13 | edge (network) | connection refused | fetch rejects `TypeError("fetch failed")` → ProviderError `timeout:false`, message `network error: fetch failed` |

## Test Files
- `src/ai/__tests__/provider.test.ts`

## Verification Commands
```bash
npx vitest run src/ai/__tests__/provider.test.ts && npx tsc --noEmit
```
(New file → own test file is the selection. No lint script in this repo; typecheck is `npx tsc --noEmit`.)

## Acceptance Criteria
- [ ] All 13 §Test Cases PASS (RED→GREEN, real output pasted).
- [ ] `src/ai/provider.ts` has ZERO vscode import and ZERO import from `src/ai/config.ts`/`settings.ts` (standalone wave-1 file; may inline its own `method` union if desired).
- [ ] No `console.*` anywhere in provider.ts; apiKey never in a thrown message.
- [ ] Exports match §Spec contract exactly. Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- (none)

## Interfaces
- Consumes: (none — standalone by design; `AiCompletionMethod`-compatible string union declared inline)
- Produces (frozen — TASK-003/004 import exactly these): `FetchLike`, `ChatMessage`, `ChatContentPart`, `ToolCall`, `ToolDef`, `ProviderRequest`, `ProviderResult`, `class ProviderError extends Error { status?: number; timeout: boolean; endpoint: string; bodySnippet: string }`, `ProviderOptions`, `createProviderClient(opts: ProviderOptions): { complete(req: ProviderRequest): Promise<ProviderResult> }`, `buildChatCompletionsBody(req): Record<string, unknown>`, `parseChatCompletionsResponse(json: unknown): ProviderResult`, `buildResponsesBody(req): Record<string, unknown>`, `parseResponsesResponse(json: unknown): ProviderResult` — all from `src/ai/provider.ts`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
No `src/ai/*` imports keeps wave 1 parallel-safe (TASK-001 touches settings/config only). @executor: for #8 the fake fetch should reject immediately with an AbortError-shaped object — no real timers needed; keep the AbortController wiring real so the signal is actually passed to fetch (assert `init.signal` is an AbortSignal in #1).

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T002-2
SUMMARY: Implemented src/ai/provider.ts (pure OpenAI-compatible fetch client, method switch chat/completions vs responses, AbortController timeout, ProviderError with apiKey-scrubbed snippets, vision content parts mapping) plus 15 vitest cases covering all 13 spec Test Cases.
TEST_PLAN_FOLLOWED: inline — wrote 15 tests covering all 13 spec cases + 2 builder regression tests; ran RED then GREEN.
FILES_CHANGED:
  - src/ai/provider.ts (new): pure client, no vscode import, no src/ai/* import.
  - src/ai/__tests__/provider.test.ts (new): 15 tests.
TESTS_ADDED:
  - src/ai/__tests__/provider.test.ts: chat request shape (#1), responses request shape (#2), chat parse text+finishReason (#3), chat parse tool_calls (#4), responses parse output_text (#5), responses parse function_call item (#6), vision both methods (#7), timeout abort (#8), 200 non-JSON (#9), apiKey scrub (#10), trailing-slash baseUrl (#11), empty/absent optionals (#12), connection refused (#13), buildChatCompletionsBody tool/assistant mapping (regression), buildResponsesBody system messages join (regression).
VERIFICATION:
  command: npx vitest run src/ai/__tests__/provider.test.ts && npx tsc --noEmit
  result: 15 pass / 0 fail, tsc exit 0
  RED_OUTPUT (vitest run on stub — all 15 fail with "not implemented"):
    Test Files  1 failed (1)
    Tests       15 failed (15)
  GREEN_OUTPUT (vitest run on implementation):
    RUN  v1.6.1
     ✓ src/ai/__tests__/provider.test.ts  (15 tests) 7ms
     Test Files  1 passed (1)
          Tests  15 passed (15)
ISSUES: none
HANDOFF_TO_REVIEWER: yes — wave-1 deliverable ready for review.
NEXT: Reviewer picks up from docs/AI_HANDOFF/INDEX.md pending_review row.
```
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code (differs — isolation OK)
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/provider.test.ts && npx tsc --noEmit
  result: 15 pass / 0 fail; tsc exit 0 (no errors)
TEST_PLAN_COVERAGE: all-followed — 13/13 spec cases implemented (+2 builder regression tests); RED_OUTPUT contains real failing-run summary (15 failed), GREEN re-verified fresh by reviewer
FINDINGS:
  critical:
    - none
  important:
    - none
  minor:
    - src/ai/provider.ts:186-191 — dead ternary: both non-string branches of `text` return `""`, so `message?.content == null ? "" : ""` is weightless; collapse to `typeof message?.content === "string" ? message.content : ""`.
    - src/ai/__tests__/provider.test.ts:258-263 — test #8's abort listener throws inside `addEventListener` (swallowed, never reaches the promise) and `aborter` is never wired to the client's controller; the timeout path is actually exercised only by the immediate AbortError throw below it. Delete the listener block + misleading "end-to-end" comment — the throw alone is the deterministic test.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Spec-exact exports, apiKey only in Authorization header + scrub (never in thrown messages), real AbortController with signal asserted in #1, no vscode/src-ai/console usage (grep-verified), responses↔chat mapping provider-only, deterministic tests (no real timers/network). Spec asked "trailing-slash baseUrl" only — buildUrl skips whitespace trim by design (settings.normalizeBaseUrl owns that upstream), fine per frozen contract.
