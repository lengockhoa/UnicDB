# PLAN — Cycle L: omp agent integration (RPC bridge)

## §1 Intent

Hook the oh-my-pi (omp) agent into the VSDB extension to raise the quality of AI assist: the agent has the full tool surface (read/grep/edit/LSP…) plus omp's model routing, while DB tools (read-only) remain controlled by VSDB via a host-tool bridge. Upgrade with one command: the extension checks `omp --version` at runtime; missing/wrong version → fallback to the existing AI path (cycle J/K) + a one-time notification with the install command `curl -fsSL https://omp.sh/install | sh` / update `omp update`. User chooses (P0): research + implement in one run.

## §2 Scope

In: `src/ai/omp/` (rpc.ts JSONL client, process.ts spawn/health/restart, hostTools.ts set_host_tools bridge, detect.ts version check + fallback decision), chat panel adds an engine switch (omp | builtin), README section (omp requirement, install/update one-liner, security note: omp mode grants the agent workspace access), unit tests with fake child_process/stdio. Fallback path behavior MUST NOT change (regression).

Out: ACP/approval UI (deferred to follow-up), bundling omp into .vsix, Bun runtime, modifying omp itself, session-history browsing UI, streaming text_delta into the builtin path (builtin keeps final-text as today).

## §3 Approach — interface freeze

From research (docs/AI_HANDOFF/queue/OMP-INTEGRATION-research.md) + existing code:

```ts
// src/ai/omp/rpc.ts (T1) — pure JSONL framing over injected stdio pair
export interface RpcTransport { write(line: string): void; onLine(cb: (line: string) => void): void; close(): void }
export class OmpRpcClient {
  constructor(transport: RpcTransport)
  request(cmd: Record<string, unknown>): Promise<Record<string, unknown>>   // id-correlated RpcResponse
  onEvent(cb: (ev: Record<string, unknown>) => void): void                 // AgentSessionEvent stream
  handleHostToolCall(handler: (call: { id: string; name: string; arguments: unknown }) => Promise<unknown>): void
  dispose(): void
}
// src/ai/omp/process.ts (T1)
export interface OmpProcessOptions { ompPath?: string; cwd: string; extraArgs?: string[] }
export class OmpProcess {
  constructor(opts: OmpProcessOptions, spawnFn?: typeof import("child_process").spawn)  // spawn injectable for tests
  start(): Promise<{ rpc: OmpRpcClient; version: string }>
  onExit(cb: (code: number | null) => void): void
  kill(): void
}
// src/ai/omp/hostTools.ts (T2)
export function hostToolDefsFromRegistry(registry: ToolRegistry): Record<string, unknown>[] // set_host_tools payload
export function createHostToolExecutor(registry: ToolRegistry): (name: string, args: unknown) => Promise<string>
// src/ai/omp/detect.ts (T3)
export const MIN_OMP_VERSION = "17.0.0"
export function compareVersions(a: string, b: string): number
export async function detectOmp(execFn?: (cmd: string) => Promise<string>): Promise<{ available: boolean; path?: string; version?: string; ok: boolean; reason?: string }>
// src/ui/aiChatPanel.ts (T4) — engine switch; builtin path untouched behaviorally
```

Architecture: panel calls `detectOmp()` → ok ⇒ `OmpProcess.start()` → rpc client + `set_host_tools` (defs from DbToolRegistry + createSqlTool — read-only guard still runs inside VSDB) → `prompt` RpcCommand → stream AgentSessionEvent (message_update/text_delta) into webview bubbles → host_tool_call → executor (guard + adapter) → host_tool_result. omp missing/old/crashed ⇒ banner + builtin engine (current behavior).

## §4 Test Plan (TDD)

Each task has its own test table. Overview: happy (RPC roundtrip via fake transport; host tool call→result; detect ok); distinct-class edges (malformed JSONL line skipped; RpcResponse error → reject; outdated version → ok=false; process exit → onExit + restart; host tool unknown/throw → error result string; empty registry); regression (builtin engine path still works as-is — existing chat panel builtin tests unchanged; read-only guard still blocks DROP TABLE when called THROUGH the host-tool bridge).

## §5 Verification Commands

- TASK-001/002: `npx vitest run src/ai/omp/__tests__/ && npx tsc --noEmit`
- TASK-003: `npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit`
- TASK-004: `npm run compile && npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatOmp.test.ts src/extension.test.ts && npx tsc --noEmit`
- Wave boundary: full `npx vitest run` + `npm run compile`.

## §6 Acceptance

- omp present (this machine has 18.0.1): panel runs the omp engine, DB tools called via bridge with the read-only guard still intact (DROP TABLE through the host tool is still blocked — test proves it).
- omp missing/outdated: detect → fallback builtin, one-time notification with the correct install/update commands from research; builtin behavior unchanged (existing tests stay green).
- Process crash mid-turn: onExit → panel warns + offers a restart button (respawn with --continue if a session exists).
- README: section for the omp requirement + install/update one-liner + security note.
- Full suite + compile + tsc clean; no telemetry; apiKey never appears in the omp path (omp reads its own config).

## §7 Task split

Per INDEX: T1 rpc+process (wave 1) · T2 hostTools bridge (wave 1) · T3 detect+fallback (wave 2) · T4 panel engine switch + UX + README (wave 3).

## Planner Report
PLANNER_MODEL: unic-smart (orchestrator session; planner subagent died mid-run earlier this cycle — plan authored directly, P2.5 independent review is the gate)

## Plan Review Log

### Round 1 — 2026-08-23 · unic-smart (PlanRev-L, independent P2.5)
Status: Issues Found — verdict CHANGES-REQUESTED (plan-level; do not start executors until findings 1–4 folded into task specs)

COMPLETENESS:
  - none (all tasks have Goal/Target/Test Cases/Verification/Acceptance/Interfaces; ≥2 distinct edge cases per task; all files < 80 lines)
CONSISTENCY:
  - 1–3 below: frozen RPC shapes contradict the real omp 18.0.1 wire protocol (verified live: `omp://rpc.md` + binary probes on this machine, omp/18.0.1)
CLARITY:
  - 5–6 below (test expectations ambiguous/stale)
SCOPE:
  - none (wave file ownership non-overlapping: T1 rpc.ts/process.ts, T2 hostTools.ts, T3 detect.ts, T4 consumers; builtin path protected)
YAGNI:
  - none (omp optional, fallback keeps cycle J/K intact)

VERDICT: CHANGES-REQUESTED
FINDINGS (numbered, severity in brackets):
  1. [CRITICAL] TASK-004 frozen command frames use wrong discriminator + fields: spec sends `{command:"prompt", prompt: text}`, `{command:"set_host_tools", tools}`, `{command:"abort"}`. Real RpcCommand is `{type:"prompt", message: string}`, `{type:"set_host_tools", tools: RpcHostToolDefinition[]}`, `{type:"abort"}` — discriminator key is `type`, prompt payload field is `message`. Implemented-to-spec, every omp turn fails at dispatch. T1's `request(cmd: Record<string, unknown>)` passthrough is fine; T4 §Spec must be rewritten to the real shapes.
  2. [CRITICAL] TASK-001 frozen `RpcResponse {id: number; success; error?: {message, code?}; result?}` mismatches the real outbound frame `{type: "response", id?: string, command: string, success: boolean, data?: ..., error?: string, code?: string}`. Response detection must be `type === "response"` (not "has id"); payload is `data` not `result`; error is a plain string; unknown commands respond with `id: undefined`. Unit tests over fake frames will go GREEN while the client cannot interop — fix the frozen interface + test #1/#3 frame fixtures to wire shapes (also: use string ids).
  3. [IMPORTANT] Host-tool callback/result frames: real outbound `{type:"host_tool_call", id, toolCallId, toolName, arguments}` — field is `toolName`, not `name`; real completion frame `{type:"host_tool_result", id, result: {content:[{type:"text",text:"…"}]}, isError?: true}`. T1/T4 spec `{id, result|error}` omits the `type` field, the content-block wrapper, and the `isError` error channel; T2's plain-string executor return must be wrapped by the bridge. Map `toolName`→`name` when invoking T2's executor.
  4. [IMPORTANT] Turn-completion semantics: T4 treats any `agent_end` as done and prompt-response success as sufficient. Real spec: `prompt` success ≠ completion (`data.agentInvoked`); non-terminal `agent_end` with `isTerminal: false` exists — completion is `agent_end` with `isTerminal !== false` (or `prompt_result`/`agentInvoked:false` for local-only prompts). Fold into T4 §Spec + add an edge test (agent_end isTerminal:false must not post done).
  5. [MINOR] TASK-002 test #6 expected column "reject reason string" is ambiguous: `run_sql` guard RESOLVES with the reason string (never rejects; guard runs before `factory()`, so adapter.runQuery is indeed never called). Rephrase: "resolves to read-only rejection reason string; fake adapter.runQuery not called" so the executor doesn't write `expects.rejects`.
  6. [MINOR] TASK-004 test #7 cites a stale count — `src/ui/__tests__/aiChatPanel.test.ts` currently has 11 tests; stale count. Drop the number (keep "every cycle K test green").
  7. [MINOR] `--yolo` is an undocumented hidden flag in omp 18.0.1 (help lists `--approval-mode=yolo` / `--auto-approve`; bare `--yolo` still parses, verified exit 0). Pin the documented `--approval-mode=yolo` in T1 argv + test #8 to survive future flag removal.

VERIFIED-GOOD (no action): event names message_update / text_delta (nested in `assistantMessageEvent`) / agent_end are real; `omp --version` → `omp/18.0.1` (T1/T3 parse assumption correct); `--mode rpc --cwd --continue --no-session --no-lsp` all exist; interface freeze matches real code (AgentTool/ToolRegistry src/ai/agent.ts:9-21, AdapterFactory async src/ai/tools/types.ts, createDbTools+createSqlTool shapes, AiChatPanelOptions options-object src/ui/aiChatPanel.ts:48-60, extension wiring src/extension.ts:361); T2 defs `{name, description, parameters}` match RpcHostToolDefinition; verification commands all runnable (`npx vitest run`, `npx tsc --noEmit`, `npm run compile` scripts exist; no lint script); read-only guard via bridge is genuinely unbypassable (guard inside tool.execute before factory()).

REQUIRED REWORK: fold findings 1–4 into TASK-001/TASK-004 frozen specs (shapes now verified — cite them verbatim), optionally add a T4 acceptance smoke against real omp gated on availability (skipped when absent) so envelope drift can never again pass green.

### Round 2 — findings applied (planner, 2026-08-23, live-probe verified)
- F1 [C] FIXED: TASK-004 now uses the real frames `{type:"prompt",message}` / `{type:"set_host_tools",tools}` / `{type:"abort"}` — live-probed on omp 18.0.1 (transcript from this run: ready frame, response envelope `{type:"response",command,success,...}`, real agent_start/message_update/agent_end).
- F2 [C] FIXED: TASK-004 §REAL protocol facts normative — the response envelope has NO id; correlation via command + 1-in-flight serialization (mandatory, with test #4).
- F3 [I] FIXED: host_tool_call uses `toolName`; TASK-001 spec writes the correct host_tool_result shape `{content:[{type:"text",text}],isError}`.
- F4 [I] FIXED: TASK-004 gates turn-completion on `agent_end` (isTerminal !== false), not on response success; edge test added.
- F5 [M] FIXED: TASK-002 test #6 spells out that the guard resolves the reason string (does not throw).
- F6 [M] FIXED: TASK-004 regression #7 drops the stale "19/19" — uses "every cycle K test".
- F7 [M] FIXED: TASK-001 argv uses the documented `--approval-mode yolo` instead of the hidden `--yolo`.
