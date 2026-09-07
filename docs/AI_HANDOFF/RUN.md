Command: handoff-fullstack
Goal: Multi-selection Cmd+Enter for shellscript — run only highlighted lines in reused "UnicDB Script" terminal (mirror SQL multi-selection shipped in v1.53.18 commit 3e33f0a). P0: reused terminal + line-at-cursor + shellscript-only.
Base: main @ 86b034e (release: 1.53.18)
Phase: I3
Cursor: TASK-SH-001 done (PASS, model=claude-sonnet-4-5). Copied back to main; worktree + branch deleted. Main has package.json + scaffold.test.ts updates + new activation event + 11/11 scaffold tests green. TASK-SH-002 still in flight (src/extension.ts + src/extension.test.ts).
Next: TASK-SH-002 finishes → 3c copy-back → 3d wave checkpoint commit + context collapse → I4 INDEX update.
