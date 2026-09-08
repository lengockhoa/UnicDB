# Handoff INDEX

## Cycle AGT-CLEANUP-2 — 12 queued minor cleanups from AGT + AGT-UI

Base: main @ 1be70f7. Plan written by unic-smart (planner self-audit 12/12). Item #1 already
landed in 93746a4 — kept as grep re-verification inside TASK-CLEAN2-001.

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-CLEAN2-001 | Drop dead `isValidEngineChoice` alias; re-verify four-value policy header | done (PASS — batch 1 checkpoint 68225d5) | none | src/ai/policy.ts | - |
| TASK-CLEAN2-002 | Delete dead `_LegacyDetectionTypes` type export | done (PASS — batch 1 checkpoint 68225d5) | none | src/ai/engineChoice.ts | - |
| TASK-CLEAN2-003 | Rewrite two stale comments in claudeCodeChatEngine.ts after R4.5 failTurn rework | done (PASS — batch 2 checkpoint 5208165) | none | src/ai/claudeCode/claudeCodeChatEngine.ts | - |
| TASK-CLEAN2-004 | claudeCodeLiveSmoke: spawn-ENOENT fail-fast + comment drift + gate-name rename | done (PASS — batch 2 checkpoint 5208165) | none | src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts | - |
| TASK-CLEAN2-005 | codexLiveSmoke: spawn-ENOENT fail-fast + argv/stdin preservation + gate-name hoist | done (PASS — awaiting batch-3 copy-back) | none | src/ai/codex/__tests__/codexLiveSmoke.test.ts | - |
| TASK-CLEAN2-006 | Rename PRE_EXISTING_COMMAND_IDS → LOCKED_COMMAND_IDS; dispose TASK-004 phantom-race bullet | in_progress (batch 3) | none | src/ui/__tests__/commitGenManifest.test.ts, docs/AI_HANDOFF/tasks/TASK-004.md | - |
| TASK-CLEAN2-003 | Finish two R4.5-stale engine comments (failTurn reject / single onError) | ready | none | src/ai/claudeCode/claudeCodeChatEngine.ts | - |
| TASK-CLEAN2-004 | Claude smoke: fail-fast spawn errors + comment/gate fixes | ready | none | src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts | - |
| TASK-CLEAN2-005 | Codex smoke: fail-fast spawn errors + gate fix | ready | none | src/ai/codex/__tests__/codexLiveSmoke.test.ts | - |
| TASK-CLEAN2-006 | Manifest LOCKED_COMMAND_IDS rename + TASK-004 unref finding disposition | ready | none | src/ui/__tests__/commitGenManifest.test.ts, docs/AI_HANDOFF/tasks/TASK-004.md | - |
| TASK-CLEAN2-007 | Dedup escapeHtml/renderMarkdown → webview/markdownSafe.ts | ready | none | webview/markdownSafe.ts (new), webview/aiChatPanelMain.ts, webview/aiChatPanelThread.ts, webview/__tests__/aiChatPanelThread.test.ts, webview/__tests__/markdownSafe.test.ts (new) | - |

Waves (inferred from Deps): wave 1 = all 7 parallel (disjoint file sets).
Wave-boundary gate: full `npm test` + `npm run typecheck` + `npm run compile`.
Constraints: cleanup-only; engine dispatch + element ids untouched; npm; no lint script (N/A); no version bump/release this cycle.

Prior AGT/AGT-UI index history archived at `docs/AI_HANDOFF/INDEX_AGTUI.md` to keep this active state file below the RULES.md 80-line cap.
