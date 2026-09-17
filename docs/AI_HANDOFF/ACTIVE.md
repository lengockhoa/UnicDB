Cycle: STOPERR   Date: 2026-09-18   Base: main
Goal: Stop multi-query run at first error + mark the failing statement (editor decoration + Problems diagnostic + explicit "stopped at statement N of M" notification); fix selection-run error propagation (silent no-op paths + split inconsistency).
Mode: Planning complete; executors pick `ready` tasks from INDEX.md in dependency order.
Plan: docs/AI_HANDOFF/PLAN.md
Queue: 3 ready tasks in docs/AI_HANDOFF/tasks/TASK-STOPERR-001.md through TASK-STOPERR-003.md
Status: planning_done
Next: wave 1 — TASK-STOPERR-001 + TASK-STOPERR-002 in parallel; then wave 2 — TASK-STOPERR-003.
Hard constraints: TypeScript/esbuild/vitest; ParsedStatement.start/end must become document-space for editor runs (splitStatements `baseOffset`); no version bump/package/publish; reviewer model ≠ executor model.
