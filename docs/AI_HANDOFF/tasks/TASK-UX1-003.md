# TASK-UX1-003 — Sample Data: console INSERT templates instead of broken auto-run (R1)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 3), §3 (UX1-003)

## Goal

The "Generate Sample Data…" menu is broken end-to-end for the user ("làm theo và không
thấy động tĩnh gì" — it depends on AI config, a row-count prompt, and an AI round-trip
before anything visible happens). Replace the DEFAULT path: right-click a table → the
VSDB Console opens pre-filled with typed INSERT template statements the user reviews and
runs manually ("tạo trên console cho tôi 1 bộ query để tôi tự chạy"). Keep the command id
`vsdb.generateSampleData`; retitle to "Insert Sample Data…".

## Target Files

- `package.json` — retitle `vsdb.generateSampleData` to `Insert Sample Data…` (icon
  stays `$(file-text)`); activationEvents line already exists.
- `src/ui/tableCommands.ts` — rewire the `vsdb.generateSampleData` handler (:355): node
  resolve → `guardPostgres` → `introspectTable` (already imported there) → build template
  SQL via a new pure `buildInsertTemplate(columns, { schema, table, rows? })` → open the
  console seeded with the template. Remove the `showInputBox` row-count prompt and the AI
  config gate from the default path. Keep the AI-driven flow (`aiGenerateSampleData` +
  `sampleDataAi.ts` module) intact and reachable via its existing tests — only the menu
  default changes.
- `src/extension.ts` — expose the console-seeding seam to tableCommands: export a small
  helper `openConsoleWithTemplate(name: string, buffer: string): void` that calls the
  existing `commandOpenConsole` + `consolePanel.seedTab(name, buffer)` + `show()`
  (extension.ts is otherwise unowned in wave 3).
- `src/ui/__tests__/tableCommands.test.ts` — new tests (template builder + handler
  behaviour + structural retitle assertion).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | table with typed columns → console seeded with INSERT templates | introspected columns `[("id","integer",NO), ("name","text",YES), ("active","boolean",NO), ("created_at","timestamp",YES)]` → console seeded with tab `Sample public.users` and ≥5 `INSERT INTO "public"."users" (...) VALUES (...);` statements where integers are bare, text quoted, booleans true/false, timestamps `NOW()`; ZERO `runner.run` / AI provider calls | stubbed introspectTable + command recorder |
| 2 | happy | menu retitle | package.json `vsdb.generateSampleData` title is `Insert Sample Data…`; command id unchanged (activationEvents + menu entries untouched) | module-level `pkgJson` assertion |
| 3 | edge A — no insertable columns | identity/generated-only table → header-comment template | columns `[(id, integer, NO, default: identity)]` (all non-insertable after existing `pickInsertableColumns` logic) → seeded buffer starts with a `--` comment explaining no insertable columns and contains ZERO `INSERT` statements; no throw | introspectTable fixture returning generated column |
| 4 | edge B — boundary row count | template row count bounded | default 5 rows; explicit `rows: 12` → 12 INSERT statements; `rows: 0` → header-only buffer (same as case 3 shape); `rows: 1000` → capped at 20 | pure `buildInsertTemplate` calls |
| 5 | edge B — malformed types | exotic/unknown column types never produce broken SQL | types `["bytea", "jsonb", "numeric(10,2)", "_int4", "USER-DEFINED"]` → each renders a syntactically safe placeholder (`/* bytea */ NULL`, `'{}'::jsonb`, `0`, `/* array */ NULL`, `/* USER-DEFINED */ NULL`); every generated statement parses as one statement per `splitStatements` | pure builder calls + statementParser round-trip |
| 6 | edge C — nullable vs NOT NULL | NOT NULL text columns get real placeholder text, nullable may use NULL | `("name","text",NO)` → `'Sample name'`-style literal (never NULL); `("bio","text",YES)` → `NULL` or literal, both acceptable — pin the NOT NULL case exactly | pure builder calls |
| 7 | edge C — no connection / not postgres | guardPostgres fails → existing toast path, console not opened, no throw | driver `mysql` node → existing guard message; `openConsoleWithTemplate` not called | guard fixture |
| 8 | regression | AI path survives | `sampleDataAi` module tests stay green; the AI branch remains importable (only menu wiring changed) | existing suite |

## Test Files

- `src/ui/__tests__/tableCommands.test.ts` — all cases (file EXISTS; append new describe
  blocks following its existing stub style).
- (existing) `src/ui/__tests__/` AI sample-data tests — must stay green (case 8).

## Verification Commands

```bash
npx vitest run src/ui/__tests__/tableCommands.test.ts src/ui/__tests__/sampleDataAi.test.ts
npm run typecheck && npm run compile
```

(Verified: `src/ui/__tests__/sampleDataAi.test.ts` and
`src/ui/__tests__/tableCommands.test.ts` both exist — no resolution needed.)

## Acceptance Criteria

- [ ] Cases 1–8 pass; case 1 proves zero AI/runner dependency on the default path.
- [ ] The AI-driven flow code is not deleted (case 8); menu default is templates.
- [ ] Templates are never auto-executed (assert no runner invocation in the handler path).
- [ ] bq04SurfaceGuard 4/4 green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-UX1-006 (package.json edits follow the guard-filter extension; also keeps
  `package.json` exclusive per wave — UX1-002/007 hold it in wave 2, this task in wave 3).

## Interfaces

- Consumes: `introspectTable(mgr, conn, schema, table)` (used in tableCommands.ts:394
  region) returning `TableDetail` columns (`column_name`, `format_type`, `is_nullable`,
  `column_default`); `pickInsertableColumns`/`SampleColumn` (sampleDataAi.ts:36);
  `commandOpenConsole` + `ConsolePanel.seedTab(name, buffer)` (extension.ts + consolePanel.ts:299);
  UX1-001's guarantee that `show()` is editor-independent; `splitStatements`
  (statementParser) for the case-5 round-trip.
- Produces: `buildInsertTemplate(columns: SampleColumn[], opts: { schema: string;
  table: string; rows?: number }): string` pure export in tableCommands.ts +
  `openConsoleWithTemplate(name: string, buffer: string): void` in extension.ts —
  UX1-004's guide documents the Insert Sample Data flow.

---

## Discussion

### 2026-09-04 · planner · unic-smart
Root cause of "không thấy động tĩnh gì": the current handler requires AI config
(silent-return + settings redirect when missing, tableCommands.ts:390 region), prompts for
a row count, then round-trips an AI provider before any UI feedback — with no AI
configured the user sees exactly one info toast at best. The decision (confirmed in P0) is
console templates with manual execution. Command id stays `vsdb.generateSampleData` to
avoid activationEvents/docs churn; the title changes to match the new behaviour. Type→
placeholder mapping is deliberately conservative (unknown types become commented NULL
placeholders so the statement still parses); the user edits values before running — that
is the requested workflow. If `openConsoleWithTemplate` in extension.ts proves
unnecessary because tableCommands can reach the panel through an existing export, prefer
the existing path and note it here.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (reported confirmed in worktree — 8 failing tests in tableCommands.test.ts for buildInsertTemplate not exported + openConsoleWithTemplate seam not invoked)
Verification Output: 199/199 in scope (extension.test.ts 145 + tableCommands.test.ts 54) after rebuild; full suite 3495|2 (baseline 3484|2, +5 net from UX1-003; +6 from UX1-007); typecheck + compile clean
Status: PASS
Note: single out-of-Target-File edit on src/extension.test.ts line ~4885 to update the menu-order array assertion for the 'Generate Sample Data…' → 'Insert Sample Data…' retitle (minimal two-line change).
