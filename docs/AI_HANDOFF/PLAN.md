# PLAN — Cycle L: omp agent integration (RPC bridge)

## §1 Intent

Gắn oh-my-pi (omp) agent vào VSDB extension để nâng chất lượng AI assist: agent có tool surface đầy đủ (read/grep/edit/LSP…) + model routing của omp, trong khi DB tools (read-only) vẫn do VSDB kiểm soát qua host-tool bridge. Nâng cấp bằng 1 lệnh: extension kiểm tra `omp --version` khi chạy; thiếu/lỗi版本 → fallback về AI path hiện có (cycle J/K) + thông báo 1 lần với lệnh install `curl -fsSL https://omp.sh/install | sh` / update `omp update`. User chọn (P0): research + triển khai luôn trong một run.

## §2 Scope

In: `src/ai/omp/` (rpc.ts JSONL client, process.ts spawn/health/restart, hostTools.ts set_host_tools bridge, detect.ts version check + fallback decision), chat panel thêm engine switch (omp | builtin), README section (yêu cầu omp, install/update 1 lệnh, security note: omp mode cho agent workspace access), tests unit với fake child_process/stdio. Fallback path KHÔNG bị sửa hành vi (regression).

Out: ACP/approval UI (ghi follow-up), bundling omp vào .vsix, Bun runtime, sửa omp本身, session-history browsing UI, streaming text_delta vào builtin path (builtin vẫn final-text như cũ).

## §3 Approach — interface freeze

Từ research (docs/AI_HANDOFF/queue/OMP-INTEGRATION-research.md) + code hiện có:

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

Kiến trúc: panel hỏi `detectOmp()` → ok ⇒ `OmpProcess.start()` → rpc client + `set_host_tools` (defs từ DbToolRegistry + createSqlTool — read-only guard vẫn chạy trong VSDB) → `prompt` RpcCommand → stream AgentSessionEvent (message_update/text_delta) vào webview bubbles → host_tool_call → executor (guard + adapter) → host_tool_result. omp thiếu/cũ/crash ⇒ banner + builtin engine (hiện trạng).

## §4 Test Plan (TDD)

Mỗi task bảng test riêng. Tổng quan: happy (RPC roundtrip qua fake transport; host tool call→result; detect ok); edge khác loại (malformed JSONL line bỏ qua; RpcResponse error → reject; version cũ → ok=false; process exit → onExit + restart; host tool unknown/throw → error result string; registry trống); regression (builtin engine path vẫn chạy nguyên — test chat panel builtin hiện có không đổi; read-only guard vẫn chặn DROP TABLE khi gọi QUA host-tool bridge).

## §5 Verification Commands

- TASK-001/002: `npx vitest run src/ai/omp/__tests__/ && npx tsc --noEmit`
- TASK-003: `npx vitest run src/ai/omp/__tests__/detect.test.ts && npx tsc --noEmit`
- TASK-004: `npm run compile && npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatOmp.test.ts src/extension.test.ts && npx tsc --noEmit`
- Wave boundary: full `npx vitest run` + `npm run compile`.

## §6 Acceptance

- omp có mặt (máy này 18.0.1): panel chạy engine omp, tool DB gọi qua bridge với read-only guard còn nguyên (DROP TABLE qua host tool vẫn bị chặn — test chứng minh).
- omp vắng mặt/cũ: detect → fallback builtin, có notification 1 lần với lệnh install/update đúng từ research; builtin behavior không đổi (tests cũ xanh).
- Process crash giữa chừng: onExit → panel báo + nút restart (spawn lại với --continue nếu có session).
- README: section yêu cầu omp + install/update 1 lệnh + security note.
- Full suite + compile + tsc sạch; không telemetry; apiKey không xuất hiện trong omp path (omp tự đọc config riêng).

## §7 Task split

Theo INDEX: T1 rpc+process (wave 1) · T2 hostTools bridge (wave 1) · T3 detect+fallback (wave 2) · T4 panel engine switch + UX + README (wave 3).

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
  6. [MINOR] TASK-004 test #7 cites "19/19 cũ" — `src/ui/__tests__/aiChatPanel.test.ts` currently has 11 tests; stale count. Drop the number (keep "toàn bộ tests cycle K xanh").
  7. [MINOR] `--yolo` is an undocumented hidden flag in omp 18.0.1 (help lists `--approval-mode=yolo` / `--auto-approve`; bare `--yolo` still parses, verified exit 0). Pin the documented `--approval-mode=yolo` in T1 argv + test #8 to survive future flag removal.

VERIFIED-GOOD (no action): event names message_update / text_delta (nested in `assistantMessageEvent`) / agent_end are real; `omp --version` → `omp/18.0.1` (T1/T3 parse assumption correct); `--mode rpc --cwd --continue --no-session --no-lsp` all exist; interface freeze matches real code (AgentTool/ToolRegistry src/ai/agent.ts:9-21, AdapterFactory async src/ai/tools/types.ts, createDbTools+createSqlTool shapes, AiChatPanelOptions options-object src/ui/aiChatPanel.ts:48-60, extension wiring src/extension.ts:361); T2 defs `{name, description, parameters}` match RpcHostToolDefinition; verification commands all runnable (`npx vitest run`, `npx tsc --noEmit`, `npm run compile` scripts exist; no lint script); read-only guard via bridge is genuinely unbypassable (guard inside tool.execute before factory()).

REQUIRED REWORK: fold findings 1–4 into TASK-001/TASK-004 frozen specs (shapes now verified — cite them verbatim), optionally add a T4 acceptance smoke against real omp gated on availability (skipped when absent) so envelope drift can never again pass green.

### Round 2 — findings applied (planner, 2026-08-23, live-probe verified)
- F1 [C] FIXED: TASK-004 giờ dùng real frames `{type:"prompt",message}` / `{type:"set_host_tools",tools}` / `{type:"abort"}` — live-probed trên omp 18.0.1 (transcript của run này: ready frame, response envelope `{type:"response",command,success,...}`, agent_start/message_update/agent_end thật).
- F2 [C] FIXED: TASK-004 §REAL protocol facts normative — response envelope KHÔNG có id; correlation qua command + 1-in-flight serialization (bắt buộc, có test #4).
- F3 [I] FIXED: host_tool_call dùng `toolName`; TASK-001 spec viết đúng host_tool_result shape `{content:[{type:"text",text}],isError}`.
- F4 [I] FIXED: TASK-004 gate turn-completion trên `agent_end` (isTerminal !== false), không dựa response success; edge test thêm.
- F5 [M] FIXED: TASK-002 test #6 ghi rõ guard resolve reason string (không throw).
- F6 [M] FIXED: TASK-004 regression #7 bỏ "19/19" stale — dùng "mọi test cycle K".
- F7 [M] FIXED: TASK-001 argv dùng `--approval-mode yolo` documented thay `--yolo` hidden.
