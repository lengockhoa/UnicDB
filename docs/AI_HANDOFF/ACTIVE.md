Cycle: AGT-CLEANUP-2   Date: 2026-09-08   Base: main @ 1be70f7
Goal: Apply 12 queued minor cleanups from cycles AGT + AGT-UI (stale comments, dead exports, smoke-helper dead-code, renderMarkdown dedup).
Tasks: 7 total (TASK-CLEAN2-001..007)
Status: planning_done — ready for executor
  - Wave 1 (7 parallel, all deps=none): 001 policy.ts · 002 engineChoice.ts · 003 claudeCodeChatEngine comments · 004 claudeCodeLiveSmoke · 005 codexLiveSmoke · 006 manifest ids + TASK-004 doc · 007 markdownSafe dedup
  - Scope note: item #1 (policy header comment) already landed in 93746a4 — re-verified by grep in TASK-CLEAN2-001, not re-edited
  - No patch release — ship rides the next major cycle; no version bump
