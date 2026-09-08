Command: handoff-fullstack
Goal: Apply 12 queued minor cleanups from cycles AGT + AGT-UI (stale comments, dead exports, smoke-helper dead-code, renderMarkdown/escapeHtml dedup between main.ts and thread.ts). No patch release — gộp vào cycle lớn tiếp theo.
Base: main @ 64350cb (post-AGT-CLEANUP-2 plan commit)
Phase: I3
Cursor: I3 batch 1 in progress — 2 implementer agents spawned (TASK-CLEAN2-001 in .worktrees/clean2-001, TASK-CLEAN2-002 in .worktrees/clean2-002). Wave 1 = 7 tasks split into 4 batches: (001+002), (003+004), (005+006), (007).
Next: wait for both batch-1 agents to complete; copy changes back + delete worktrees + checkpoint commit; then spawn batch 2 (TASK-CLEAN2-003 + 004); then batch 3 (005+006); then batch 4 (007) standalone; then R1-R5 review per task
