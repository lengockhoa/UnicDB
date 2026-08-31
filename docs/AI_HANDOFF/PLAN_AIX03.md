# PLAN_AIX03 — Database Analysis Copilot

Cycle: AIX-03 (wave 3) · Base: main @ 97cf058 (v1.21.0) · Release target: v1.22.0
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

## Roadmap row

> **AIX-03 Database Analysis Copilot** — Explain schema, query plans, errors,
> and sampled query results using DB-aware tools with visible tool calls and
> permission decisions.
> Approach: evolve `dbAwareTools`, `sqlTool`, schema tools, panel messages;
> depends AIX-01 and DBX-02. **No automatic data-changing SQL.**
> Edge cases: read-only parser bypass attempts, permission deny, row/token
> caps, connection loss.

## Current state (evidence)

- `src/ai/tools/dbAwareTools.ts` — 5 read-only DB-aware tools
  (list_table_data_sample, count_rows, run_readonly_query, explain_query,
  get_table_relationships), all fronted by `DbToolPermissionGate`
  (default-deny card). `guardSql` blocks EXPLAIN ANALYZE + non-SELECT
  (parseReadonly, strict over-reject by design).
- `src/ui/aiChatPanel.ts` — agent loop posts `step` lines (`→ tool_name`)
  via `onToolCall` BEFORE execute; NO result/status is ever surfaced. A
  denied/failed tool call is invisible in the thread (only the model sees
  the envelope).
- Privacy contract: row bytes only in tool results; `summarizeForLog`
  shape-only.

## Goal

The user can SEE what the copilot did: each DB-aware tool call renders a
visible card — tool name, permission decision (granted/denied/timeout),
status (ok/failed/denied), and a SHAPE-ONLY result summary (cols × rows,
row cap hit, plan node count) — plus one composite analysis entry point.

## Non-goals

- No data-changing SQL anywhere (parser stays stricter-than-needed).
- No new permission UI (reuse the existing card).
- No row bytes outside tool results (cards carry shape only).

## Tasks (TDD, each RED→GREEN)

### TASK-AIX03-001 — `analysisReport` pure module
`src/ai/analysisReport.ts` (PURE, no vscode): parse an EXPLAIN text plan
into `{nodes, deepest}`, `summarizeToolOutcome(tool, status, shape)` →
one-line card text; `capTokens(text, max)` word-boundary cap. RED:
module absent.

### TASK-AIX03-002 — composite analysis tools (DB-aware)
`src/ai/tools/analysisTools.ts`:
- `createAnalyzeTableTool(f)`: one call → schema (via listTableDetail) +
  row count + capped sample + FK summary. All four pieces degrade
  independently; JSON out with per-part ok/error.
- `createDiagnoseQueryTool(f)`: runs the failing read-only SELECT through
  guardSql first, classifies the adapter error (syntax / permission /
  connection / unknown) from its message, returns a JSON diagnosis.
Row caps reuse SAMPLE_MAX_LIMIT / QUERY_MAX_ROWS; connection loss →
NO_CONNECTION envelope. RED: module absent.

### TASK-AIX03-003 — visible tool-call cards
- `agent.ts`: add optional `callbacks.onToolResult?(call, status)` where
  status ∈ {ok, failed, denied} (denied = rejected envelope string).
- `aiChatPanel.ts`: runBuiltinTurn posts `tool_result` host messages
  {tool, status, summary} (summary via `summarizeToolOutcome`, SHAPE ONLY —
  never row bytes). Wire onToolResult in builtin AND omp mirror; post a
  denied card when the gate rejects.
- `aiChatPanelMessages.ts`: `AiChatPanelToolResult` message type.
- `webview/aiChatPanelMain.ts`: render card DOM-only (textContent), one
  compact line per call: `✓ run_readonly_query — 3 cols × 20 rows (capped)`
  / `✗ denied by user`.
RED: webview asserts no tool_result branch exists yet / agent callback
absent.

### TASK-AIX03-004 — scaffold + docs
- `aix03Scaffold.test.ts`: analysisReport/analysisTools pure (no vscode),
  no fs/child_process/shell, exports present; aiChatPanelMessages has
  tool_result kind.
- CHANGELOG 1.22.0 + compare link; README bullet.

## Verification per task

`npx vitest run <target test>`; cycle: `npm test` (full), `npm run
typecheck`, `npm run compile`.

## Risk / review focus

- Privacy: cards MUST NOT carry row bytes (reviewer should grep summarize
  paths).
- Parser bypass: guardSql unchanged; diagnose tool must re-guard.
- Connection loss mid-analysis: per-part degradation in analyze_table.
