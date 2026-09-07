# Handoff INDEX

Cycle SH — Multi-selection Cmd+Enter for shellscript (run highlighted lines in the reused
"UnicDB Script" terminal; mirrors SQL multi-selection shipped v1.53.18, commit 3e33f0a).

| Task | Title | Status | Deps | Files |
|------|-------|--------|------|-------|
| TASK-SH-001 | Manifest: `UnicDB.runShellSelection` command + Cmd/Ctrl+Enter shellscript keybindings | ready | none | package.json, src/scaffold.test.ts |
| TASK-SH-002 | `commandRunShellSelection`: multi-selection → reused "UnicDB Script" terminal | ready | none | src/extension.ts, src/extension.test.ts |

Waves (inferred from Deps): wave 1 = SH-001 + SH-002 (2 parallel — no shared files).
Wave-boundary gate: full `npm test` + `npm run typecheck` after both pass.

Cycle gate status: planning_done — plan review Round 1 APPROVED (unic-smart, 2026-09-07); awaiting P3 commit plan / executor. Base main @ 86b034e (release 1.53.18),
working tree clean. Note: stale TASK-GC-* files remain in tasks/ from the never-started GC
cycle — execute only the SH rows above.
