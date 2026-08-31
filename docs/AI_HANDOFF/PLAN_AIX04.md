# PLAN_AIX04 — Database Change Workflow

Cycle: AIX-04 (wave 4) · Base: main @ 75c6fa8 (v1.23.0) · Release target: v1.24.0
Reviewer: unic-smart (cycle reviewer) — MUST differ from executor (unic-code)

## Roadmap row

> **AIX-04 Database Change Workflow** — Turn an AI suggestion into a
> reviewed migration/change plan that opens the existing DB
> preview/confirmation path.
> Approach: compose AI tools with DBX-03 compare plans and DBX-06 refactor
> safeguards; ALL proposed SQL funnels through the existing
> `dangerousStatement` / `confirmDangerousStatements` consent path.
> Depends AIX-02, AIX-03, DBX-03, DBX-06.
> **No direct agent execution of destructive SQL.**
> Edge: dangerous DDL/DML, stale plan/schema drift, user rejection,
> transaction/partial-apply reporting.

## Current state (evidence)

- `src/core/dangerousStatement.ts` — pure classifier: `analyzeStatement`
  (mask literals/comments → depth-0 keyword → kind delete/truncate/drop/
  update/grant/revoke/kill/terminate/other + hasWhere) + `guardTier`
  (red/amber/none/admin-red). `confirmDangerousStatements` lives in
  `src/extension.ts:1303` — modal consent, red beats amber, admin DCL has
  its own gate. Reuse verbatim; the change-plan tool must NOT reimplement it.
- `src/ai/tools/analysisTools.ts` — `createAnalyzeTableTool` +
  `createDiagnoseQueryTool` + `createAnalysisTools(f)`; same contracts as
  dbAwareTools: no vscode, adapter injected via `AdapterFactory`
  (`() => Promise<DbAdapter | null>`), never throws, identifier guard
  `badIdentifier` + `containsForbidden`.
- `src/ai/agent.ts` — `AgentTool {name, description, parameters, execute}`,
  `ToolOutcome` + `onToolResult` callback; panel posts `tool_result` cards
  (shape-only) via `AiChatPanelToolResult`.
- `src/core/ddl/renameAnalysis.ts` (DBX-06) — `validateNewName` +
  `analyzeUsage` pure guards.
- DBX-03 compare plans: `src/core/ddl/alterTable.ts` `diffTable` +
  `AlterPlan {statements, errors}` (pure ALTER diff engine; NewTableForm
  modify-mode renders + previews).

## Goal

A new DB-aware agent tool `plan_change` (read-only; never executes) that
turns an AI suggestion into a **reviewed change plan**:

1. **Input**: natural-language `intent` + optional explicit `statements`
   (SQL the model already wrote) + optional `target` table.
2. **Plan construction**: the tool accepts candidate SQL statements,
   classifies each via `analyzeStatement`/`guardTier` (danger tiers ride
   the plan), and validates identifiers via the DBX-06 guards. A plan is
   `{statements: [{sql, tier, hasWhere, dangerNote}], errors[], drift[]}`.
3. **Schema-drift guard**: when a `target` table is given, the host
   re-introspects its fingerprint (columns) at plan time; if the plan's
   claimed columns no longer match (stale plan), `drift[]` lists the
   mismatch and the plan is marked `drifted` (Apply blocked until
   re-analysis).
4. **Consent path**: the plan itself never runs SQL. The panel renders
   the plan card; **Approve** on the host routes EVERY statement through
   `confirmDangerousStatements` (existing modal) then applies sequentially
   with per-statement progress; user rejection → "rejected by user" card,
   nothing runs. Transaction/partial-apply: failure reports applied/
   failedAt/error like the DBX-06 runner.

## Non-goals

- No new DML/DDL execution path outside the panel consent flow.
- No automatic transaction wrapping beyond what the user already has
  (the panel applies sequentially; per-statement failure reports partial
  state — mirrors DBX-06 runner semantics).
- No plan persistence/scheduling.

## Tasks (TDD, each RED→GREEN)

### TASK-AIX04-001 — `changePlan` pure module
`src/ai/changePlan.ts` (PURE, no vscode):
- `classifyStatements(sql: string[]): PlanStatement[]` — for each:
  `{sql, kind, hasWhere, tier, dangerNote}` via analyzeStatement/guardTier;
  dangerNote set for red/admin-red tiers.
- `validatePlanStatements(sql: string[])` — non-empty strings, no
  `shell:true`/exec nonsense, each parses as ≥1 statement via
  splitStatements; returns errors.
- `detectDrift(fingerprint: {columns: string[]}, claimed: string[]):
  string[]` — symmetric set difference (stale plan guard).

### TASK-AIX04-002 — `plan_change` agent tool
`src/ai/tools/changePlanTool.ts`:
- `createPlanChangeTool(f: AdapterFactory, fingerprint: (schema, table) =>
  Promise<string[]>)` — tool `plan_change`:
  - args: `intent` (required string), `statements` (optional string[]),
    `targetSchema`/`targetTable` (optional).
  - Never executes: returns `{"ok": true, "plan": {...}}` envelope with
    per-statement tiers + drift + errors. Statements missing → error
    envelope `{"ok": false, "error": "..."}`.
  - Identifier guard on targetSchema/targetTable (badIdentifier parity).
- `createChangePlanTools(f)` factory — registers plan_change.

### TASK-AIX04-003 — panel consent + apply
`src/ui/aiChatPanel.ts` + `webview/aiChatPanelMain.ts` + messages:
- New host message kind `change_plan` → webview renders a plan card
  (statement list with tier badges + drift lines; textContent-only).
- Webview → host `plan_approve {statements}`; host runs
  `confirmDangerousStatements(parsed, driver)`; on reject posts
  `tool_result {tool:"plan_change", status:"denied", summary:"rejected by
  user"}`; on approve applies sequentially (reuse runRenameStatements
  runner or an equivalent loop) with `progress` posts; failure →
  partial-apply report card.
- Drifted plan → Apply disabled on the webview; host re-checks drift at
  approve time too (defense in depth).

### TASK-AIX04-004 — scaffold + CHANGELOG/README
`aix04Scaffold.test.ts`: pure modules vscode-free, plan_change registered
in the tool registry (assert via createChangePlanTools), scaffold hygiene
(no shell/execSync), exports present. CHANGELOG 1.24.0 + link; README
bullet after the 1.23.0 line.

## Verification per task

`npx vitest run <target test>`; cycle: `npm test`, `npm run typecheck`,
`npm run compile`.

## Risk / review focus

- The tool MUST be read-only — plan_change never calls runQuery with DML.
- Consent: every applied statement goes through confirmDangerousStatements
  (no bypass when confirmDestructive=false? admin tiers still gate —
  parity with extension.ts).
- Drift guard correctness (stale plan vs current schema).
- Partial-apply reporting parity with DBX-06 runner.
