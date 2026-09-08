# Handoff INDEX

## Cycle AGT-CLEANUP-2 — 12 queued minor cleanups from AGT + AGT-UI

Base: main @ 77481c1 (cycle AGT-CLEANUP-2 wave 1 batches 1-4 all checkpointed; 7/7 reviews complete; ready for R5 closeout).
Plan written by unic-smart (planner self-audit 12/12). Item #1 already landed in 93746a4 — kept
as grep re-verification inside TASK-CLEAN2-001.
R1-R5 results: 7/7 reviewed — 5 APPROVED (001/002/003/005/007), 2 APPROVED-MINOR (004 EOF nit, 006 preId loop var nit). No CHANGES-REQUESTED, no CRITICAL.

| Task | Title | Status | Deps | Files | Reviewer |
|------|-------|--------|------|-------|----------|
| TASK-CLEAN2-001 | Drop dead `isValidEngineChoice` alias; re-verify four-value policy header | done (PASS — batch 1 checkpoint 68225d5) | none | src/ai/policy.ts | unic-smart (APPROVED) |
| TASK-CLEAN2-002 | Delete dead `_LegacyDetectionTypes` type export | done (APPROVED) | none | src/ai/engineChoice.ts | unic-smart |
| TASK-CLEAN2-003 | Rewrite two stale comments in claudeCodeChatEngine.ts after R4.5 failTurn rework | done (PASS — batch 2 checkpoint 5208165) | none | src/ai/claudeCode/claudeCodeChatEngine.ts | approved | unic-smart |
| TASK-CLEAN2-004 | claudeCodeLiveSmoke: spawn-ENOENT fail-fast + comment drift + gate-name rename | approved_minor | none | src/ai/claudeCode/__tests__/claudeCodeLiveSmoke.test.ts | unic-smart |
| TASK-CLEAN2-005 | codexLiveSmoke: spawn-ENOENT fail-fast + argv/stdin preservation + gate-name hoist | approved | none | src/ai/codex/__tests__/codexLiveSmoke.test.ts | unic-smart |
| TASK-CLEAN2-006 | Rename PRE_EXISTING_COMMAND_IDS → LOCKED_COMMAND_IDS; dispose TASK-004 phantom-race bullet | done (PASS — batch 3 checkpoint f97c1d4) | none | src/ui/__tests__/commitGenManifest.test.ts, docs/AI_HANDOFF/tasks/TASK-004.md | approved_minor |
| TASK-CLEAN2-007 | Dedup renderMarkdown/escapeHtml: new webview/markdownSafe.ts + refactor 2 consumers + test | done (APPROVED — cross-check) | none | webview/markdownSafe.ts (new), webview/aiChatPanelMain.ts, webview/aiChatPanelThread.ts, webview/__tests__/aiChatPanelThread.test.ts, webview/__tests__/markdownSafe.test.ts (new) | orchestrator-cross-check (unic-smart 503) |

Waves (inferred from Deps): wave 1 = all 7 parallel (disjoint file sets).
Wave-boundary gate: full `npm test` (4039 pass / 4 skip / 0 fail on main @ 77481c1) + `npm run typecheck` (exit 0) + `npm run compile` (clean).
Constraints: cleanup-only; engine dispatch + element ids untouched; npm; no lint script (N/A); no version bump/release this cycle.

Prior AGT/AGT-UI index history archived at `docs/AI_HANDOFF/INDEX_AGTUI.md` to keep this active state file below the RULES.md 80-line cap.
