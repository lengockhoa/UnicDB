# PLAN — Cycle K: AI DB-assist

## §1 Intent

Bring the AI core (cycle J) down to earth: the agent can **read** the schema and run **read-only SQL** on the connected DB, and the user has a place to talk to the agent — a chat panel inside the extension. Binding decisions (autonomy — no re-asking):

- Absolute read-only at the tool layer: only SELECT/SHOW/EXPLAIN/WITH…SELECT; block multi-statement and `INTO`.
- Tools receive the adapter via an **injected factory** (function that picks the currently-selected adapter from ConnectionManager) — no global state.
- No streaming (render the markdown final text); Stop via AbortController.
- PG-only runtime; mysql/mssql missing the method → tool returns a clear error message, never crashes.
- Privacy unchanged: every request only goes to the user-configured baseUrl; the apiKey never leaves SecretStorage.

## §2 Scope

In: `src/ai/tools/` (registry + introspection tools + SQL tool + schema-context formatter), `src/ui/aiChatPanel*.ts` + `webview/aiChatPanelMain.ts` (house webview pattern like newTableForm), wiring `src/extension.ts` + `package.json` (command `vsdb.aiChat` + editor/title menu), README AI DB-assist + guardrails section, unit tests (fake adapter + fake provider) — no PG container needed (the real adapter already has its own integration test from cycle I).

Out: streaming UI, any form of DML/DDL, write tools, mysql/mssql introspection implementation, telemetry, Anthropic protocol, multi-connection chat sessions.

## §3 Approach — interface freeze (match src/ai/agent.ts + adapters/types.ts as they exist VERBATIM)

- `AgentTool` (frozen cycle J): `{ name: string; description: string; parameters: JSONSchema; execute(args): Promise<string> }` — new tools implement exactly this shape.
- `ToolRegistry` (frozen): `{ list(): AgentTool[]; get(name): AgentTool|undefined }`.
- `runAgent(input: AgentInput, deps: AgentDeps, callbacks?)` — used as-is; Cycle K just passes the real registry in place of `EMPTY_TOOL_REGISTRY`.

New (Cycle K owns):

```ts
export type AdapterFactory = () => Promise<DbAdapter | null>  // async: ConnectionManager.getAdapter() async-lazy (F2)
// src/ai/tools/registry.ts
export class DbToolRegistry implements ToolRegistry            // register(tool), list(), get(name)
export function createDbTools(adapterFactory: AdapterFactory): DbToolRegistry
// src/ai/tools/sqlTool.ts
export function createSqlTool(adapterFactory: AdapterFactory): AgentTool   // name: "run_sql" — consumes runQuery cursor (F1)
export function isReadOnlySql(sql: string): { ok: boolean; reason?: string }
// src/ai/tools/schemaTools.ts
export function createListTablesTool(adapterFactory): AgentTool            // "list_tables"
export function createDescribeTableTool(adapterFactory): AgentTool         // "describe_table"
// src/ai/tools/schemaContext.ts
export function formatSchemaContext(tables: TableInfo[], details: TableDetail[], budgetChars: number): string
// src/ui/aiChatPanel.ts
export interface ChatAbortToken { aborted: boolean }                       // F4: token, not AbortController
export class AiChatPanel { constructor(ctx, deps: AgentDeps, adapterFactory: AdapterFactory, style?); show(): void; dispose(): void }
```

Flow: user opens panel → types a question → host builds system prompt (schema context via formatter, budget ~8k chars) → `runAgent({messages, tools: createDbTools(adapterFactory)}, deps, callbacks)` (**tools on AgentInput** — agent.ts:100-103) → onStep pushes "thinking/tool" bubbles → finalText renders markdown (skip if token.aborted). Stop = ChatAbortToken. `run_sql` consumes `runQuery().cursor.fetchBatch(50)+close()` because PG single-SELECT returns results:[] (postgres.ts:156-169).
Each task has its own test table (see task file). Totals: happy path per tool; ≥2 edges of distinct classes (guard: DML/multi-statement/INTO; factory null; budget cut; bad args JSON; adapter throw → error string); regression (runAgent still works with a real registry of 2 tools + a fake provider looping tool-call for 2 steps then answering — the integration seam of cycle J+K combined).

## §5 Verification Commands

- TASK-001/002: `npx vitest run src/ai/tools/__tests__/<file>.test.ts && npx tsc --noEmit`
- TASK-003/004: `npm run compile && npx vitest run src/ui/__tests__/aiChatPanel*.test.ts <wiring tests> && npx tsc --noEmit`
- Wave boundary (orchestrator): full `npx vitest run` + `npm run compile`.

## §4 Test Plan (TDD)

Each task has its own test table (see task file). Totals: happy path per tool; ≥2 edges of distinct classes (guard: DML/multi-statement/INTO/writable-CTE; factory null; budget cut; adapter throw → error string); regression (runAgent works with a real registry of 2 tools + a fake provider tool-loop of 2 steps — the cycle J+K seam; run_sql DROP TABLE never reaches the adapter).

## §6 Acceptance

- Chat panel opens from the command palette; asks about schema → agent calls list_tables/describe_table, answers with real data from the fake adapter in the test.
- `run_sql` with INSERT/UPDATE/DELETE/DROP/; /INTO is blocked at the tool layer with a reason.
- No active connection → agent answers "no active connection", does not crash.
- Full suite green + tsc clean; README has the guardrails section; no telemetry; apiKey never appears in any new message/log.

## §7 Task split

Per the scaffolded INDEX.md: T1 registry+introspection tools (wave 1) · T2 sql tool + context formatter (wave 1) · T3 chat panel webview (wave 2) · T4 integration + guardrails + README (wave 3). Dependencies: T3 after T1+T2; T4 after T3.

## Planner Self-Audit

- Freeze list matches character-for-character with src/ai/agent.ts:16-62 and adapters/types.ts:89-114 — read straight from source, not from memory.
- The real registry is a consumer of the EMPTY_TOOL_REGISTRY seam — cycle J's empty-registry test still passes (no cycle J file gets edited).
- Read-only guard at the tool layer (not the adapter) because adapter.runQuery is the user-facing path; the AI path needs its own lock.
- Budget cap on the formatter prevents prompt blowup on large schemas.
- No re-asking the user — every decision lives in §1.

## Plan Review Log

### Round 1 — 2026-08-23 · unic/unic-smart (PlanRev-K, independent context)

Status: **Issues Found** — 2 Critical / 5 Important / 2 Minor. The frozen §3 declarations that mirror existing source (`AgentTool`/`ToolRegistry`/`AgentInput`/`AgentDeps`/`runAgent`, `DbAdapter.listTables/listTableDetail`, `TableInfo`/`TableDetail`) match `src/ai/agent.ts` and `src/adapters/types.ts` verbatim — no drift there. Findings below are where the plan diverges from real runtime behavior or hides cross-wave rework.

COMPLETENESS:
  - none (every task has Target Files / frozen Spec / happy + ≥2 distinct-class edges + regression / Test Files / Verification Commands incl. `npx tsc --noEmit` — project has no lint script, typecheck covers it — / Acceptance / Interfaces Consumes-Produces)
CONSISTENCY:
  - F2 (AbortController claim vs token design), F7 (runAgent call shape vs frozen signature)
CLARITY:
  - F3 (wiring symbols), F6 (INTO-scan scope)
SCOPE:
  - none (read-only tool-layer guard, PG-only, no streaming/DML/telemetry; no cycle J file appears in any Target Files)
YAGNI:
  - none

FINDINGS (numbered):

Critical:
1. **run_sql reads rows from `runQuery()` but PostgresAdapter routes single SELECT through a server cursor and returns `results: []` + `batched`** — src/adapters/postgres.ts:156-169: "Single statement, starting with SELECT, no `;` → DECLARE CURSOR, returns an empty QueryResult + BatchedQuery". TASK-002's flow (`adapter.runQuery(sql)` → slice 50 → `{columns, rows, rowCount, truncated}`) returns an empty payload for the cycle's PRIMARY path: every real PG SELECT. Tests won't catch it — fake adapters return inline rows. Fix: spec run_sql to consume `RunResult`: if `batched` present, `fetchBatch()` until ≥50 rows or EOF, then ALWAYS `close()`; else read `results[0]`. Add edge test "cursor-shaped RunResult → tool still returns columns/rows".
2. **`AdapterFactory = () => DbAdapter | null` (sync) is unwirable against the real ConnectionManager.** No `getActiveAdapter()` exists; the only accessors are `getActive(): ConnectionConfig | null` (connectionManager.ts:182) and async lazy `getAdapter(): Promise<DbAdapter>` (:274-309). The cached `currentAdapter` is private AND nulled by the 10-min idle timer while `currentActiveId` persists — a sync snapshot can hand the agent a closed adapter. TASK-004's "getActiveAdapter() if it exists" references a nonexistent method. Fix before wave 1: freeze `type AdapterFactory = () => Promise<DbAdapter | null>`; tools await it inside `execute`; no-connection = null (or getAdapter rejection) → "No active connection…" string.

Important:
3. TASK-004 wiring sketch uses nonexistent `loadAiConfig` and wrong shape `cfg.settings.method`/`cfg.settings.timeoutMs`. Real: `AiConfigStore.loadConfig(): Promise<AiConfig|null>` (src/ai/config.ts:61); `AiConfig extends AiSettings` flat — use `cfg.baseUrl/apiKey/method/timeoutMs`. As sketched, wiring throws at command time (`cfg.settings` undefined → TypeError).
4. Stop overpromised: PLAN §1/§3 say "Stop qua AbortController" but `runAgent` takes no signal (callbacks = onStep/onError only). TASK-003's token is the implementable design — align PLAN wording. Also T3 spec must gate the FINAL assistant post on `!token.aborted` (currently only subsequent onStep is skipped); otherwise a late resolve posts a stale answer after Stop.
5. `AdapterFactory` lives in T1's registry.ts while T2 (same wave) imports it — tolerable as a type-only import, but combined with F2's forced signature change it is a cross-wave coordination hazard. Fix: move the type to `src/ai/tools/types.ts` (add to T1 Target Files as owner) so the F2 async change lands in one frozen file both waves import.
6. Read-only guard has a writable-CTE hole: `WITH x AS (INSERT … RETURNING *) SELECT …` starts with `with`, passes the first-keyword check, and executes DML — breaking §1 "Absolute read-only". Fix: for `with`-led statements reject if the body contains word-boundary `insert|update|delete|merge` (same class of scan as the existing `into` check); add an edge test. Also state explicitly that the ` into ` scan applies to ALL branches — the spec's parenthetical reads as with-only while test #4 (`SELECT * INTO t2`) implies unconditional.
7. PLAN §3 flow line `runAgent(msgs, deps, { tools: createDbTools(adapterFactory) })` puts `tools` in the callbacks slot — the real signature is `runAgent(input: AgentInput, deps, callbacks?)` with `tools` on `input` (agent.ts:100-103). TASK-003 already has the correct form; fix the PLAN line so an executor reading §3 isn't misled.

Minor:
8. TASK-003 package.json note "activationEvents already enough (onCommand)" is garbled and contradicts house pattern (all 18 commands listed explicitly in activationEvents). Decide: add `"onCommand:vsdb.aiChat"` like its siblings.
9. PLAN §3 says budget "~8k chars" but TASK-003 never pins the constant the host passes to `formatSchemaContext` — pin `budgetChars = 8000` in the T3 spec so executors don't pick arbitrary values.

NOTES: Plan review only — no executor report, so no model-isolation check applies. F1/F2 are frozen-interface changes that must land in PLAN.md + TASK-001/002 before wave 1 starts; recommend one quick re-review after the planner applies them.

### Round 2 — disposition (planner, 2026-08-23)
- F1 (Critical) FIXED: TASK-002 spec now mandates the cursor flow (fetchBatch(50)+close in finally), fallback to run.results only when no cursor; test #1/#1b/#7 cover it.
- F2 (Critical) FIXED: AdapterFactory is async () => Promise<DbAdapter|null>, frozen in src/ai/tools/types.ts (already created — executors do not recreate it).
- F3 (Important) FIXED: TASK-004 wiring uses new AiConfigStore(ctx).loadConfig() + flat cfg.baseUrl/apiKey/method/timeoutMs (no loadAiConfig, no cfg.settings.*).
- F4 (Important) FIXED: Stop = ChatAbortToken (exported from aiChatPanel.ts), gate the assistant final post on !token.aborted; TASK-003 spec + test #4 updated.
- F5 (Important) FIXED: AdapterFactory lives in src/ai/tools/types.ts — T1 and T2 import it; nobody owns it cross-wave.
- F6 (Important) FIXED: isReadOnlySql blocks writable-CTE (with-body containing insert|update|delete|merge word-boundary) + INTO scan unconditional; test #4 adds the WITH…INSERT case.
- F7 (Important) FIXED: PLAN §3 spells out runAgent({messages, tools}, deps, callbacks) — tools on AgentInput (agent.ts:100-103).
- Minor (2): accepted — (a) TASK-001 comment "run_sql is registered by TASK-002 at caller" is now explicit; (b) budget ~8k chars kept as a heuristic.
