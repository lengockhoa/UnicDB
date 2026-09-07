# Handoff INDEX

Cycle SH — Multi-selection Cmd+Enter for shellscript (run highlighted lines in the reused
"UnicDB Script" terminal; mirrors SQL multi-selection shipped v1.53.18, commit 3e33f0a).

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-SH-001 | Manifest: `UnicDB.runShellSelection` command + Cmd/Ctrl+Enter shellscript keybindings | done (approved_minor) | none | package.json, src/scaffold.test.ts | unic-smart |
| TASK-SH-002 | `commandRunShellSelection`: multi-selection → reused "UnicDB Script" terminal | done (approved) | none | src/extension.ts, src/extension.test.ts | unic-smart |
Waves (inferred from Deps): wave 1 = SH-001 + SH-002 (2 parallel — no shared files).
Wave-boundary gate: full `npm test` + `npm run typecheck` after both pass.

Cycle gate status: cycle_done — R5 ready. Wave 1 PASS (250 files / 3743 tests / 0 failed / 2 skipped); wave checkpoint + guard fix on main @ d7f79e0; both rows reviewed (unic-smart) and now `done`. R5 next: single push to origin, then optional patch release.
Base main @ 86b034e (release 1.53.18). Note: stale TASK-GC-* files remain in tasks/ from the never-started GC cycle — already-executed rows for this cycle are SH-001 + SH-002 only.
Phase 4 (2026-09-07): TASK-SH-001 reviewed by unic-smart → approved_minor (verification re-run PASS: typecheck 0, scaffold 11/11, full suite 3743 pass / 0 failed). TASK-SH-002 reviewed by unic-smart → approved (verification re-run PASS: typecheck 0, extension.test.ts 171/171).
