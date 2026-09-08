Cycle: AGT    Date: 2026-09-08    Base: main @ d60b743 (release 1.53.23)
Goal: Add Claude Code + Codex as first-class ACP-based agents, parallel omp UKit audit, AIChat panel image+text support across all engines.
Tasks: 14 total (TASK-001..TASK-014) across 6 waves
Status: shipped — released as v1.53.24 on 2026-09-08
  - HEAD: 10a26d1 release: 1.53.24 (pushed to origin/main)
  - GitHub Release: https://github.com/lengockhoa/UnicDB/releases/tag/v1.53.24 (.vsix attached)
  - Marketplace: lengockhoa.UnicDB v1.53.24 published via vsce publish (PAT from macOS Keychain)
  - Review: 14/14 (1 approved: TASK-008 settings form UI · 13 approved_minor · 0 critical)
  - omp code path unchanged (TASK-004 zero-diff audit held)
  - Minors queued (~6 non-blocking): stale comments / dead export alias / smoke helper minors / mcpBridge.ts:298 unref race comment wrong / hostMcp.ts standard-tool timeout — feed to next planner
Reopen queue (mid-cycle user request, NOT in AGT scope):
  - Cycle AGT-UI: clone Claude Code VS Code extension UI/UX — BLUE accent replacing orange + big letter "U" brand mark (UnicDB, large). Layout/behavior/control placement/animations/dark-theme faithful to anthropic.claude-code. Plan as separate cycle after AGT ships (already shipped).
