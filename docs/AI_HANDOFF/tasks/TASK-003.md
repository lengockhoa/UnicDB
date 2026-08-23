# TASK-003 — Agent loop: config-driven routing + tool registry + step budget (src/ai/agent.ts)
- Status: `ready` · Owner: `-` · Reviewer: `-` · Parent: `docs/AI_HANDOFF/PLAN.md` §2,§3,§7

## Goal
Pure multi-turn agent loop over the provider: fresh config snapshot per run
(`deps.loadConfig()`), role→modelId routing, tool-calling loop against an injected registry
(empty seam this cycle — DB tools are cycle K+), max-steps budget cap, vision guard. NO
vscode import; all I/O injected → deterministic unit tests.

## Target Files
- `src/ai/agent.ts` (new) · `src/ai/__tests__/agent.test.ts` (new)

## Spec — contract (normative, frozen)
```ts
// src/ai/agent.ts
import type { AiConfig, AiModelRole } from "./settings";
import type { ChatMessage, ProviderRequest, ProviderResult } from "./provider";

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema cho parameters object — passthrough to provider ToolDef.parameters. */
  parameters: Record<string, unknown>;
  /** Pure-ish async execute — registry owns error policy below. */
  execute(args: Record<string, unknown>): Promise<string>;
}
export interface ToolRegistry {
  list(): AgentTool[];
  get(name: string): AgentTool | undefined;
}
export const EMPTY_TOOL_REGISTRY: ToolRegistry;  // { list: () => [], get: () => undefined }

export interface AgentInput {
  /** Initial messages (system + user). Images go here as image_url content parts. */
  messages: ChatMessage[];
  /** Model role for this run (default "work" when omitted). */
  role?: AiModelRole;
  tools?: ToolRegistry;
  /** Overrides cfg.maxSteps when provided (still clamped ≥1). */
  maxSteps?: number;
}
export interface AgentDeps {
  loadConfig(): Promise<AiConfig | null>;
  complete(cfg: AiConfig, role: AiModelRole, req: ProviderRequest): Promise<ProviderResult>;
}
export interface AgentStep {
  /** Messages appended this step: assistant reply, then tool results (if any). */
  messages: ChatMessage[];
  result: ProviderResult;
}
export interface AgentRunResult {
  steps: AgentStep[];
  /** Message list AFTER the run — replayable as next run's input. */
  history: ChatMessage[];
  finalText: string;          // text of the LAST assistant message with no tool calls ("" if budget-capped with none)
  stoppedOnBudget: boolean;   // true iff hit maxSteps before a no-tool-call reply
}
export async function runAgent(
  input: AgentInput,
  deps: AgentDeps,
  callbacks?: {
    onStep?(step: AgentStep): void;
    onError?(error: Error): void;
  },
): Promise<AgentRunResult>;
```
Loop semantics (normative):
1. `cfg = await deps.loadConfig()` — called EXACTLY once per run, first statement after arg
   normalization. `null` ⇒ `throw new Error("AI is not configured")` (loadApiKey/UI hint is
   caller's business).
2. Vision guard BEFORE any provider call: input contains an image part AND
   `cfg.models[role].vision !== true` ⇒ `throw new Error("Role \"<role>\" does not support vision")`.
3. Step loop, at most `input.maxSteps ?? cfg.maxSteps` iterations:
   a. `req = { modelId: cfg.models[role].modelId, messages: [...history], tools:
      registryDefs, temperature }` — routing = the modelId lookup; `deps.complete(cfg, role, req)`.
   b. Append assistant message to history (`toolCalls` when present, text content otherwise);
      record `AgentStep { messages: [assistant], result }`.
   c. No tool calls → push nothing more; return `{steps, history, finalText: result.text,
      stoppedOnBudget: false}`.
   d. Tool calls → for EACH in order: `tool = registry.get(name)`; missing ⇒ tool message
      `{role:"tool", toolCallId: id, content: JSON.stringify({error: "Unknown tool: " + name})}`;
      present ⇒ `execute(JSON.parse(argumentsJson))` — parse failure ⇒
      `{error:"Invalid tool arguments"}` result; execute throw ⇒
      `{error: "Tool failed: " + e.message}` result. Tool messages appended to history AND
      included in the SAME step's `messages` array (assistant + tool results = one step).
      Then continue loop. Errors NEVER abort the run (model sees the error and recovers).
   e. Budget exhausted with pending tool results ⇒ return with `stoppedOnBudget: true`,
      `finalText` = text of last no-tool-call assistant message or `""`.
4. `onStep` fires after each provider result (post tool-execution, so step.messages is
   complete); `onError` fires for swallowed tool errors (returns void; must not throw).
   Callbacks are optional and never affect control flow.
5. No config/registry/model caching between runs — deps is the single source of truth.

## Test Cases (REQUIRED — TDD)
| # | Loại | Tên test | Expected |
|---|------|----------|----------|
| 1 | unit | single-turn direct answer | complete → no toolCalls: 1 step, `finalText` = text, `stoppedOnBudget:false`, history = `[...input, assistant]`, complete called with `req.modelId` = cfg.models.work.modelId |
| 2 | unit | tool loop happy | 1st complete returns toolCall `get_time({})`, 2nd returns text: 2 steps; step2 req.messages deep-equal `[system, user, assistant(toolCalls), tool("…")]`; tool result content = execute()'s return |
| 3 | unit | role routing smart | `input.role:"smart"` → `req.modelId === cfg.models.smart.modelId`, deps.complete receives role "smart" |
| 4 | unit | config snapshot per run | two sequential runAgent calls; between them deps returns a DIFFERENT config (model id "m1"→"m2"): run2 complete receives "m2" and loadConfig called exactly 2× total |
| 5 | edge (budget) | always-tool-calling model, maxSteps 3 | exactly 3 complete calls, `stoppedOnBudget === true`, steps.length 3, finalText "" |
| 6 | edge (capability) | images + non-vision role | input has image part, `cfg.models.work.vision:false`, role "work" (default) → rejects `"Role \"work\" does not support vision"`, complete NEVER called |
| 7 | edge (state) | unconfigured | loadConfig → null → rejects `"AI is not configured"` |
| 8 | edge (malformed) | unknown tool name | complete returns toolCall `nope`; registry empty (or get→undefined) → history contains tool msg content `JSON.stringify({error:"Unknown tool: nope"})`; run CONTINUES to a 2nd complete call (model recovery), completes with stoppedOnBudget:false |
| 9 | edge (malformed) | invalid argumentsJson + throwing tool | toolCall args `"{bad"` → tool msg `{error:"Invalid tool arguments"}`; execute throws `Error("boom")` → `{error:"Tool failed: boom"}` — both in same step's messages, loop continues |
| 10 | unit | onStep/onError callbacks | tool run: onStep called once per step with complete step.messages (assistant+tool); onError called for the swallowed error, returns normally; run result unchanged |
| 11 | unit | multi tool calls one step | complete returns TWO toolCalls → both results appended in order in ONE tool-result batch before next complete |
| 12 | unit | EMPTY_TOOL_REGISTRY | `list() []`, `get("x") undefined`; runAgent with it sends `tools: []` in req |

## Test Files
- `src/ai/__tests__/agent.test.ts`

## Verification Commands
```bash
npx vitest run src/ai/__tests__/agent.test.ts && npx tsc --noEmit
```
(New file → own test file is the selection. No lint script in this repo; typecheck is `npx tsc --noEmit`.)

## Acceptance Criteria
- [ ] All 12 §Test Cases PASS (RED→GREEN, real output pasted).
- [ ] `src/ai/agent.ts` imports ONLY types from `./settings` + `./provider`; zero vscode import, zero fetch call, zero registry implementation beyond the seam.
- [ ] No `console.*`; tool/agent errors surfaced via results/callbacks, not logs.
- [ ] Exports match §Spec contract exactly. Reviewer APPROVED/APPROVED-WITH-MINOR.

## Dependencies
- TASK-001 (types `AiConfig`/`AiModelRole` from `src/ai/settings.ts`), TASK-002 (types `ChatMessage`/`ProviderRequest`/`ProviderResult` from `src/ai/provider.ts`)

## Interfaces
- Consumes: `AiConfig`, `AiModelRole` from `src/ai/settings.ts`; `ChatMessage`, `ProviderRequest`, `ProviderResult` from `src/ai/provider.ts` (type-only imports).
- Produces (frozen — cycle K+ DB tools + future chat UI import exactly these): `AgentTool`, `ToolRegistry`, `EMPTY_TOOL_REGISTRY`, `AgentInput`, `AgentDeps`, `AgentStep`, `AgentRunResult`, `runAgent(input: AgentInput, deps: AgentDeps, callbacks?: { onStep?(step: AgentStep): void; onError?(error: Error): void }): Promise<AgentRunResult>` — all from `src/ai/agent.ts`.

---

## Discussion
### 2026-08-23 · planner · unic/unic-smart
"Agent gọi liên tục tới cả 2 models" is satisfied at cycle J by the per-call `complete(cfg, role, req)` seam: one role per run, fresh config per run; mid-run role switching lands with DB tools (cycle K+) without an interface change. @executor: no fake timers needed — deps.complete is an async mock you control; make loadConfig a plain `vi.fn()` so test #4 can assert call count.

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
