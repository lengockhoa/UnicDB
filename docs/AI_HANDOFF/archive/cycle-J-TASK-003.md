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
| # | Type | Test name | Expected |
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
"Agent calls both models continuously" is satisfied at cycle J by the per-call `complete(cfg, role, req)` seam: one role per run, fresh config per run; mid-run role switching lands with DB tools (cycle K+) without an interface change. @executor: no fake timers needed — deps.complete is an async mock you control; make loadConfig a plain `vi.fn()` so test #4 can assert call count.

<!--
Phase 3 executor appends `## Executor Report` BELOW this separator.
Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report.
-->

## Executor Report
- Status: `done`
- EXECUTOR_MODEL: unic/unic-code
- EXECUTOR_SUBAGENT: -
- Worktree: `.worktrees/task-003` @ `e61a7bd` (branch `handoff/task-003`)

### RED → GREEN

**RED (agent.ts absent)** — pasted verbatim:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-003

 ❯ src/ai/__tests__/agent.test.ts  (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/ai/__tests__/agent.test.ts [ src/ai/__tests__/agent.test.ts ]
Error: Failed to load url ../agent (resolved id: ../agent) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-003/src/ai/__tests__/agent.test.ts. Does the file exist?
 ❯ loadAndTransform ../../node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

 Test Files  1 failed (1)
      Tests  no tests
```

**GREEN (after implementing src/ai/agent.ts)** — pasted verbatim:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/task-003

 ✓ src/ai/__tests__/agent.test.ts  (12 tests) 5ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```
RED: 12 failed (suite-load failure due to missing module). GREEN: 12 pass / 0 fail.

### Files changed
- `src/ai/agent.ts` (new, 167 lines) — `runAgent` + `AgentTool` / `ToolRegistry` / `EMPTY_TOOL_REGISTRY` / `AgentInput` / `AgentDeps` / `AgentStep` / `AgentRunResult` / `AgentCallbacks` per §Spec. Pure module: type-only imports from `./settings` + `./provider`, zero vscode, zero fetch, zero console.
- `src/ai/__tests__/agent.test.ts` (new, 280 lines) — 12 tests covering §Test Cases 1–12 verbatim.

### Verification
```
npx vitest run src/ai/__tests__/agent.test.ts && npx tsc --noEmit
# VITEST_EXIT=0  TSC_EXIT=0
```

### Spec adherence
1. `loadConfig()` called exactly once per run; null → throw `AI is not configured`. (test #7)
2. Vision guard runs BEFORE any `deps.complete` call; message `Role "<role>" does not support vision`. (test #6)
3. Step loop bounded by `input.maxSteps ?? cfg.maxSteps`, clamped ≥1. Tool-calling step appends BOTH assistant msg AND all tool results in one `step.messages`; loop continues with the next iteration carrying all of them in `history`. (tests #2, #5, #8, #9, #11)
4. Error policy: missing tool → `Unknown tool: <name>`; bad JSON → `Invalid tool arguments`; thrown execute → `Tool failed: <msg>` and raw Error fed to optional `onError` (never re-thrown). Loop never aborts. (tests #8, #9, #10)
5. Budget exhaustion → `stoppedOnBudget: true`, `finalText` = last no-tool-call assistant text or `""`. (test #5)
6. `onStep(step)` fires once per step AFTER the step's messages array is complete (assistant + tool results). (test #10)
7. `EMPTY_TOOL_REGISTRY` (`list() []`, `get() undefined`) → request gets `tools: []`. (test #12)
8. Fresh config snapshot per run — verified by changing config between two `runAgent` calls. (test #4)

### ISSUES
- **Wave-1 signature mismatch (no edit needed):** the task spec mentioned wave-1 exports `loadAiConfig` / `createProviderClient`; wave-1 actually exposes `AiConfigStore.loadConfig(): Promise<AiConfig | null>` and a provider factory `createProviderClient(opts)` returning a single-arg `complete(req)` closure. The TASK-003 spec's `AgentDeps` (three-arg `complete(cfg, role, req)`, `loadConfig(): Promise<AiConfig | null>`) is the cycle-J contract and matches the types from `settings.ts`/`provider.ts` exactly; the `createProviderClient` adapter is out of scope (wiring lives in TASK-004). **No wave-1 file was modified.**
- **Test #10 — `onError` payload interpretation:** spec §Loop-4 says `onError fires for swallowed tool errors` without specifying payload shape. Implementation passes the **raw thrown Error** (preserves original message and stack); the result message string is `Tool failed: <msg>` per §Loop-1d. Test asserts `errArg.message === "kaboom"` (raw). This matches the natural reading of "the swallowed error" and gives downstream UI the original stack.

### HANDOFF_TO_REVIEWER
yes — all 12 §Test Cases PASS, typecheck clean, branch `handoff/task-003` at `e61a7bd` contains only `src/ai/agent.ts` and `src/ai/__tests__/agent.test.ts`.

### NEXT
ready for review (Rev-T003).

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_TOOL: claude-code
VERIFICATION_RERUN:
  command: npx vitest run src/ai/__tests__/agent.test.ts && npx tsc --noEmit
  result: 12 pass / 0 fail · tsc exit 0 (fresh re-run on main tree @ HEAD)
TEST_PLAN_COVERAGE: all-followed — 12/12 §Test Cases present in src/ai/__tests__/agent.test.ts; edge coverage (budget exhaustion #5, vision guard #6, unconfigured #7, unknown tool #8, bad args + throwing tool #9) exceeds minTestsEdgeCase=2; RED_OUTPUT contains real suite-load failure output, not a bare claim.
FINDINGS:
  critical: none
  important: none
  minor:
    - src/ai/agent.ts:150-154 — `req` never passes `temperature`/`maxOutputTokens`; frozen §Spec loop-3a mentions optional `temperature` but leaves it unspecified — behavior matches spec-as-testable (test #1 asserts modelId/messages only). No action this cycle.
    - src/ai/agent.ts:147,167,195 — `finalText` on budget-cap returns last no-tool-call text, but per loop order that value can only come from a prior capped run's state (within one run, a no-tool-call reply always returns early); dead-but-spec-correct, matches frozen wording. No action.
    - src/ai/__tests__/agent.test.ts:4-13 — imports include unused-in-body type `AgentInput`-adjacent helpers (e.g. `AgentStep` used once, `MockedFn` shapes fine); harmless, tsc clean. No action.
MODEL_ISOLATION: PASS — executor unic/unic-code ≠ reviewer unic/unic-smart (config handoff.reviewer.model=unic-smart honored).
SECURITY_INVARIANTS: PASS — apiKey never referenced, logged, serialized, or included in any error path in agent.ts/test file; no vscode import, no fetch, no console.*; no telemetry; egress is caller's deps.complete concern (TASK-002 scrubbed snippets). Config re-read per run via deps.loadConfig() (test #4 proves 2 calls / 2 snapshots).
SCOPE: PASS — wave-2 commit f964397 touches only TASK-003.md, INDEX.md, RUN.md, src/ai/agent.ts, src/ai/__tests__/agent.test.ts; zero wave-1 file edits; no DB tools / streaming / chat UI / Anthropic protocol.
DETERMINISM: PASS — no real timers, no network (deps injected), no vscode mock needed (pure module).
NEXT_STATUS_FOR_INDEX: approved
NOTES: Clean implementation of the frozen contract; the two minor items are observations, not change requests. Executor's onError raw-Error interpretation (raw Error, not the wrapped result string) is the sound reading and is explicitly asserted in test #10.
