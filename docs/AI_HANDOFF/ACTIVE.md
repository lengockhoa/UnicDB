Cycle: CHATFIX   Date: 2026-09-16   Base: main
Goal: Fix the V2 AI Chat user-reported defects — giant/crushed composer (explicit grid placement), dead transcript scroll/auto-scroll, missing thinking indication (tool timeline + live indicator), and dead message action icons.
Mode: Planning complete; executors pick `ready` tasks from INDEX.md in dependency order.
Plan: docs/AI_HANDOFF/PLAN.md
Queue: 4 ready tasks in docs/AI_HANDOFF/tasks/TASK-CHATFIX-001.md through TASK-CHATFIX-004.md
Next: executor begins TASK-CHATFIX-001 (wave 1), then 002+003 in parallel (wave 2), then 004 (wave 3).
Hard constraints: native DOM TypeScript only, no framework/dependency/CDN/browser storage, CSS scoped under .UnicDB-ai-chat-v2, esbuild bundle, no version bump/package/publish.
