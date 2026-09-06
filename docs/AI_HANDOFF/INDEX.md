# Handoff INDEX

Cycle GC — Generate Commit Message (SCM sparkle) + Lite Model in AI Settings.

| Task | Title | Status | Deps | Files |
|------|-------|--------|------|-------|
| TASK-GC-001 | AI settings data model: `lite` role + per-model engine + legacy migration | ready | none | src/ai/settings.ts, src/ai/config.ts, + 14 test files with `models:` literals (list in task) |
| TASK-GC-002 | Git diff source adapter (vscode.git extension API) | ready | none | src/adapters/gitDiff.ts (new), src/adapters/__tests__/gitDiff.test.ts (new) |
| TASK-GC-003 | Commit message core: prompt builder + sanitizer (pure) | ready | none | src/ai/commitMessage.ts (new), src/ai/__tests__/commitMessage.test.ts (new) |
| TASK-GC-004 | Manifest: sparkle command + scm/title menu contribution | ready | none | package.json, src/ui/__tests__/commitGenManifest.test.ts (new) |
| TASK-GC-005 | User guide: Generate Commit Message + Lite Model + Engine sections | ready | none | docs/UNICDB_USER_GUIDE.md, src/ui/__tests__/userGuideContent.test.ts |
| TASK-GC-006 | AI Settings webview: Engine dropdown (bug fix) + Lite model section | ready | TASK-GC-001 | webview/aiSettingsFormMain.ts, src/ui/__tests__/aiSettingsFormBundle.test.ts |
| TASK-GC-007 | `UnicDB.generateCommitMessage`: wiring + registration | ready | TASK-GC-001, TASK-GC-002, TASK-GC-003 | src/ai/commitGenCommand.ts (new), src/extension.ts, src/ai/__tests__/commitGenCommand.test.ts (new) |
| TASK-GC-008 | Integration / regression net (manifest ↔ command ↔ UX contract) | ready | TASK-GC-004, TASK-GC-007 | src/ui/__tests__/commitGenIntegration.test.ts (new) |

Waves (inferred from Deps): wave 1 = GC-001..005 (5 parallel) | wave 2 = GC-006, GC-007 | wave 3 = GC-008 + full `npm test` gate.

Cycle gate status: planning_done — awaiting executor. Baseline full suite was green at a6bcb3b
(244 files | 3619 tests | 2 skipped).

Note: schema-tree icon change (symbol-namespace → database) landed outside this cycle — do not
plan or review it here.
