Command: handoff-fullstack
Goal: Apply 12 queued minor cleanups from cycles AGT + AGT-UI (stale comments, dead exports, smoke-helper dead-code, renderMarkdown/escapeHtml dedup between main.ts and thread.ts). No patch release — gộp vào cycle lớn tiếp theo.
Base: main @ 1be70f7 (post-AGT-UI 1.53.25 + cleanup pass cbf277a)
Phase: P2.5
Cursor: Round 1 review found 4 issues; planner revised PLAN.md + TASK-CLEAN2-001/002/005/006. Verified consumer-check evidence encoded (finding 3+4: repo grep + package.json exports/types fields). P2.5 round-2 review agent spawned to verify revisions + scan for new issues.
Next: wait for round-2 verdict. If Approved → P3 commit plan. If Issues Found → planner applies directly without re-review (loop cap exhausted after round 2).
