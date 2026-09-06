# Handoff INDEX

Cycle RP — SQL Results in bottom panel (prior cycle BQ-FOLLOWUP archived in HISTORY.md).

| Task | Title | Status | Owner | Files |
|------|-------|--------|-------|-------|
| TASK-RP-001 | Convert ResultsPanel to bottom-panel WebviewViewProvider (+ extension registration) | pending_review | shipped wave 1 @ 1ed33ae (unic-code) | src/ui/resultsPanel.ts, src/extension.ts, src/ui/__tests__/resultsPanel.test.ts, src/extension.test.ts, src/ui/__tests__/resultsPanelViewProvider.test.ts (new), 9 sibling resultsPanel* test files (auto-adapted) |
| TASK-RP-002 | User guide: remove resultsPlacement docs, document forced bottom-panel placement | pending_review | shipped wave 1 @ 1ed33ae (unic-code) | docs/UNICDB_USER_GUIDE.md, src/ui/__tests__/userGuideContent.test.ts |
| TASK-RP-003 | Manifest: viewsContainers.panel + webview view + activation; DELETE resultsPlacement property | pending_review | shipped wave 2 @ 1ca64fa (unic-code) | package.json, src/ui/__tests__/resultsPanelViewManifest.test.ts (new) |
| TASK-RP-004 | Bottom-panel regression net (integration + source/manifest scan) | pending_review | shipped wave 3 partial @ 405af76 (unic-code, 6/6 cases pass) | src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts (new) |
| TASK-RP-005 | Fix wave 1+2 regressions blocking the cycle gate | pending_review | shipped fix round @ 2184708 (unic-code) | src/ui/__tests__/manualCommit.test.ts, src/adapters/__tests__/bq04SurfaceGuard.test.ts, src/adapters/__tests__/bqFollowupSurfaceGuard.test.ts |
| TASK-RP-006 | Fix critical focus-command bug (container→view id) + append missing RP-004 executor report | pending_review | shipped fix round 2 @ a6bcb3b (unic-code) | src/ui/resultsPanel.ts, src/ui/__tests__/resultsPanelViewProvider.test.ts, src/ui/__tests__/resultsPanelViewManifest.test.ts, src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts, src/ui/__tests__/resultsPanel.test.ts, src/ui/__tests__/manualCommit.test.ts, 9 sibling resultsPanel* mock-handler test files, docs/AI_HANDOFF/PLAN.md, docs/AI_HANDOFF/tasks/TASK-RP-003.md, docs/AI_HANDOFF/tasks/TASK-RP-004.md, docs/AI_HANDOFF/tasks/TASK-RP-006.md |

Cycle gate status: full `npm test` green — 244 files passed | 3619 tests passed | 2 skipped | 0 failed (last verified at a6bcb3b).

Reviewer lane: spawning code-reviewer (unic-smart) for R2 round-2 review on RP-001 + RP-004 + RP-006 — must differ from executor unic-code.
