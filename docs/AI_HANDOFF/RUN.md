Command: handoff-fullstack
Goal: Multi-selection Cmd+Enter for shellscript — run only highlighted lines in reused "UnicDB Script" terminal (mirror SQL multi-selection shipped in v1.53.18 commit 3e33f0a). P0: reused terminal + line-at-cursor + shellscript-only.
Base: main @ 86b034e (release: 1.53.18)
Phase: R5
Cursor: R2-R4 done — TASK-SH-001 approved_minor + TASK-SH-002 approved (both unic-smart reviewers, verification re-run PASS). INDEX/ACTIVE updated to cycle_done. Wave 1 + guard fix on main @ d7f79e0.
Next: R5 — single push to origin, then optional patch release (scripts/bump-version.mjs) and CHANGELOG note. Then Phase: done.
