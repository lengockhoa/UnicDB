# TASK-AIX02-003 — aiChatPanel registration + permission gate + card detail

**Status:** pending
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

(to be filled by executor with RED + GREEN evidence)
