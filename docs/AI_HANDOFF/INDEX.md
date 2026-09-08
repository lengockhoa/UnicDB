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

---

## Cycle AGT — Claude Code + Codex first-class agents, AIChat universal interface, image+text for all engines

Base: main @ d60b743 (release 1.53.23). Plan approved by unic-smart (P2.5 Round 2 APPROVED, 3/3 Round 1 fixes verified).

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-001 | Engine vocabulary: extend `AiEngine` to 4 values; validator + persistence migration | done (approved_minor) | none | src/ai/settings.ts, src/ai/config.ts, src/ai/policy.ts | unic-smart |
| TASK-002 | Claude Code binary detection (`src/ai/claudeCode/detect.ts`) | done (approved_minor) | none | src/ai/claudeCode/detect.ts, src/ai/claudeCode/__tests__/detect.test.ts | unic-smart |
| TASK-003 | Codex binary detection (`src/ai/codex/detect.ts`) | done | none | src/ai/codex/detect.ts, src/ai/codex/__tests__/detect.test.ts | unic-smart |
| TASK-004 | omp UKit audit (read-only review, write findings into task file; zero code change) | approved_minor | none | src/ai/omp/** (review only), docs/AI_HANDOFF/tasks/TASK-004.md (report) | unic-smart |
| TASK-013 | Manifest: extend `UnicDB.ai.engine` enum + add `UnicDB.ai.useWithClaudeCode` / `UnicDB.ai.useWithCodex` commands + activationEvents | done (approved_minor) | none | package.json, src/ui/__tests__/commitGenManifest.test.ts | unic-smart |
| TASK-005 | Claude Code process/session adapter (mirror AcpProcess; stream-json + MCP config) | approved_minor | TASK-001 | src/ai/claudeCode/claudeCodeProcess.ts, src/ai/claudeCode/__tests__/claudeCodeProcess.test.ts | unic-smart |
| TASK-006 | Codex process/session adapter (mirror AcpProcess; UNVERIFIED locally — cite Codex CLI docs in task file) | approved_minor | TASK-001 | src/ai/codex/codexProcess.ts, src/ai/codex/__tests__/codexProcess.test.ts | unic-smart |
| TASK-007 | Engine resolution policy: `resolveEngine` settings-driven (P0.3); backward-compat legacy mode | approved_minor | TASK-001 | src/ai/engineChoice.ts, src/ai/__tests__/engineChoice.test.ts | unic-smart (reviewer: unic-smart) |
| TASK-008 | Settings form UI: 4-option engine dropdown + webview validator | approved | TASK-001 | webview/aiSettingsFormMain.ts, webview/__tests__/aiSettingsFormMain.test.ts | unic-smart |
| TASK-009 | Claude Code chat engine (mirror OmpChatEngine; image-capable path) | approved_minor | TASK-005, TASK-007 | src/ai/claudeCode/claudeCodeChatEngine.ts, src/ai/claudeCode/__tests__/claudeCodeChatEngine.test.ts | unic-smart |
| TASK-010 | Codex chat engine (mirror OmpChatEngine; image-capable path) | approved_minor | TASK-006, TASK-007 | src/ai/codex/codexChatEngine.ts, src/ai/codex/__tests__/codexChatEngine.test.ts | unic-smart |
| TASK-011 | Panel dispatch + image pipeline: per-engine `runXEngineTurn`; un-block image-capable engines | approved_minor | TASK-002, TASK-003, TASK-007, TASK-009, TASK-010 | src/ui/aiChatPanel.ts, src/ui/__tests__/aiChatPanelAgentEngines.test.ts | unic-smart |
| TASK-012 | Extension wiring + chat webview switcher: `buildClaudeCodeChatEngine` / `buildCodexChatEngine` factories; migrate legacy call sites | approved_minor | TASK-011 | src/extension.ts, src/extension.test.ts, webview/aiChatPanelMain.ts | unic-smart |
| TASK-014 | Integration + env-gated live smokes (UnicDB_CLAUDE_CODE_SMOKE=1 / UnicDB_CODEX_SMOKE=1) | approved_minor | TASK-012 | src/ai/**/__tests__/*LiveSmoke.test.ts, src/ui/__tests__/aiChatPanelEngine.test.ts | unic-smart |

Wave plan (inferred from `Dependencies`):
- Wave 1 (5 tasks, batched 2 at a time = 3 batches): TASK-001, TASK-002, TASK-003, TASK-004, TASK-013 — disjoint: settings/config/policy vs claude detect vs codex detect vs omp audit vs manifest
- Wave 2 (4 tasks, 2 batches): TASK-005, TASK-006, TASK-007, TASK-008 — disjoint: claudeCode process vs codex process vs engineChoice vs webview form
- Wave 3 (2 tasks, 1 batch): TASK-009, TASK-010 — disjoint: claudeCodeChatEngine vs codexChatEngine
- Wave 4 (1 task): TASK-011 — single owner of aiChatPanel.ts
- Wave 5 (1 task): TASK-012 — consumes TASK-011's new option fields
- Wave 6 (1 task): TASK-014 — final integration smoke

Wave-boundary gate: after every wave, full `npm test` + `npm run typecheck` + `npm run compile`.

Cycle AGT status: shipped — 14/14 reviewed (1 approved · 13 approved_minor · 0 critical), released as v1.53.24 on 2026-09-08. HEAD: 10a26d1 release: 1.53.24 (pushed). GitHub Release: https://github.com/lengockhoa/UnicDB/releases/tag/v1.53.24 (.vsix attached). Marketplace: lengockhoa.UnicDB v1.53.24 published. omp code path unchanged (TASK-004 zero-diff audit held). Mid-cycle reopens (~6 non-blocking minors + cycle AGT-UI clone request) recorded in ACTIVE.md.

Mid-cycle user request (queued as NEXT cycle, NOT in current AGT scope): clone Claude Code VS Code extension UI/UX — references `anthropic.claude-code` (marketplace) + https://code.claude.com/docs/en/vs-code. Plan as separate cycle AGT-UI now that AGT has shipped. AGT stayed scoped to backend agent wiring + image+text pipeline; TASK-011/012 panel work stayed at backend-dispatch level only (no UI redesign), so AGT-UI can land cleanly on top without re-doing AGT's engine routing.

**AGT-UI user clarifications (2026-09-07, mid-cycle):**
- **Color**: BLUE replaces Claude's orange — same accent placement, just blue palette.
- **Brand mark**: big letter "U" (UnicDB), blue, treated as the panel icon. Must be large + easy to see.
- **Everything else**: position, layout, behavior, control placement, animations, dark theme — clone Claude Code extension as faithfully as possible.
- Source design references: Claude Code VS Code extension marketplace page + https://code.claude.com/docs/en/vs-code + the screenshot the user pasted (red square stop button + input area with "+" / "/N" / model chip / bypass-permissions toggle / mic).
