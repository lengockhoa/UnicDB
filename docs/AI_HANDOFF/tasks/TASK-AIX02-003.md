# TASK-AIX02-003 — aiChatPanel registration + permission gate + card detail

**Status:** implemented — awaiting reviewer (unic-smart)
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

Register `workspace_write` in `runBuiltinTurn` (and the omp mirror at ~1918) ONLY when
`this.options.grounding` is on (allowlist = grounding filesToRead), wrapped with
`this.dbToolGate.wrap(...)` so every execution requires an explicit allow-once/allow-session
card answer. Extend the permission-card `detail` summarizer: for `workspace_write` show
`path` + `+N -M` (diffStats on args). No new UI components; existing card flow only.

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | unit | grounding off → registry list has no workspace_write |
| 2 | unit | grounding on → tool present AND wrapped (execute defers until gate allow) |
| 3 | unit | card detail for workspace_write includes path and +/- counts |
| 4 | regression | existing tools (list_tables, run_sql, workspace_search) unchanged |

## Verification

```bash
npx vitest run src/ui/__tests__/aix02Registration.test.ts src/ui/__tests__/aiChatPanelDbAware.test.ts
npm run typecheck
```

## Executor Report

### Executor (unic-code)

**RED evidence**: first run of `src/ui/__tests__/aix02Registration.test.ts` → `1 failed`: the gate-mirror test's writeFile stub threw "MUST NOT be called" even on the allowed path (test bug) — after fixing the stub to count writes, the deny→no-write and allow→one-write invariants both hold.

**GREEN evidence**: 6/6 (+17 existing aiChatPanelDbAware unchanged). Registration policy: `workspace_write` registers ONLY when `grounding.writeFile` is present (added to `GroundingDeps` as optional; `extension.ts` passes `writeWorkspaceFileAtomic` — temp sibling + rename with temp cleanup on rename failure). Both runBuiltinTurn and the omp/MCP mirror wrap the tool with `dbToolGate.wrap`. Permission-card `detail` branch: `path=… +N lines (proposed file, M chars)` — path + counts only, never raw content.

**Typecheck**: 0 errors. Existing suites (aiChatPanelDbAware etc.) green.

