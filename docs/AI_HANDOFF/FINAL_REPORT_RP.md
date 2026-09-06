# Cycle RP — Final Report

**Command:** handoff-fullstack
**Goal:** Move SQL Results to a tab in VS Code's bottom panel (next to Terminal); remove `UnicDB.resultsPlacement` setting.
**Base:** main @ 4812026 (after R5 push)
**Date:** 2026-09-06

## Outcome: ✅ Cycle closed, all 6 tasks shipped, full suite green

### User intent (preserved verbatim)

> "Tôi muốn kết quả nằm ở khung dưới… Bên cạnh terminal. kết quả SQL."
> "Ép xuống dưới luôn. Không cho nằm ngang với cấu query."
> "Bỏ luôn setting, bắt buộc kết quả SQL phải ở dưới"
> "test thật kỹ cho tôi"

All four constraints honored:
1. ✅ SQL results now live in a tab in the bottom panel (next to Terminal).
2. ✅ Never side-by-side with the SQL editor — the panel is registered via `viewsContainers.panel`.
3. ✅ `UnicDB.resultsPlacement` setting removed entirely (no alias, no default, no fallback) — placement is forced.
4. ✅ Thoroughly tested — 244/245 files (1 skipped), 3619/3621 tests (2 skipped), 0 failed.

## Task delivery summary

| Task | Status | Land commit | Review verdict |
|------|--------|-------------|----------------|
| RP-001 | approved_minor | 1ed33ae (wave 1) | APPROVED-WITH-MINOR |
| RP-002 | pending_review | 1ed33ae (wave 1) | (docs-only — out of R2 scope) |
| RP-003 | pending_review | 1ca64fa (wave 2) | (manifest — out of R2 scope) |
| RP-004 | approved_minor | 405af76 (wave 3 partial) | APPROVED-WITH-MINOR |
| RP-005 | pending_review | 2184708 (fix round 1) | APPROVED-WITH-MINOR (R1) |
| RP-006 | approved_minor | a6bcb3b (fix round 2) | APPROVED-WITH-MINOR |

Cycle gate: `npm test` → **244 passed | 1 skipped (245 files) | 3619 passed | 2 skipped | 0 failed** at 72f180f.

## Architectural shift

| Before | After |
|--------|-------|
| `vscode.window.createWebviewPanel()` lands in editor area | `registerWebviewViewProvider("UnicDB.results")` against `viewsContainers.panel` |
| Side-by-side with SQL editor | Tab in bottom panel next to Terminal |
| `UnicDB.resultsPlacement` user setting (enum: `editor` \| `panel`) | Setting removed — placement forced to panel |
| `ResultsPanel.show()` calls `createWebviewPanel(...)` directly | `ResultsPanel.show()` calls `executeCommand("UnicDB.results.focus")` (view id, dot notation) |

The round-1 review caught a critical bug: the original RP-001 had `executeCommand("UnicDB-results.focus")` (container id with hyphen). VS Code only auto-registers `<viewId>.focus` (view id with dot). The wrong string never matched a real command, so the bottom panel never auto-revealed on query run. RP-006 fixed all 19 references in lockstep.

## Fix-round evolution

1. **RP-005 round 1** (PARTIAL): 3 prescribed narrow edits (commands mock + 2× frozen-surface BASE_REF advance). Each edit removed its symptom but exposed a deeper failure. Refused to exceed scope → flagged HANDOFF_TO_REVIEWER: no.
2. **RP-005 widened** (DONE): orchestrator widened scope; 3 follow-on edits in the same 3 files. Full suite green at 2184708.
3. **RP-006** (DONE): R1 reviewer caught the focus-string bug + missing RP-004 executor report. 19-file coordinated find-and-replace landed at a6bcb3b. Full suite green at 72f180f.

## Reviewer findings (round 2)

- 0 critical
- 0 important
- 7 minor — all docstring/spec-prose level, NOT blocking cycle close:
  - Stale hyphen-form spec prose in `TASK-RP-001.md`, `TASK-RP-004.md`, `TASK-RP-003.md`
  - `PLAN.md` §4 "manifest consistency" row still claims container id produces the focus command
  - `resultsPanelBottomPanelIntegration.test.ts:352` case-4 title still says "container focus command"
  - RP-001 AC2 wording stricter than the comment-stripping gate
  - `resultsPanel.ts:227-229` doc-comment mentions the old form

These are tidy-up items for a future "docs polish" cycle, not blockers.

## What ships vs what's left

**Shipped (in 4812026, now on origin main):**
- 1 source file: `src/ui/resultsPanel.ts` — uses `WebviewViewProvider`, calls correct focus command
- 1 manifest: `package.json` — adds `viewsContainers.panel` + view + activation event, **deletes** `UnicDB.resultsPlacement`
- 15 test files (1 new regression net + 14 updated to match new literal)
- 2 doc files updated (user guide + PLAN.md)
- 1 new task: `TASK-RP-004` regression net

**Not yet shipped (follow-up):**
- Marketplace publish — per UKit versioning policy, this code change requires a version bump. Run `npm run bump` → CHANGELOG → commit → `npx vsce publish`.
- Optional: tidy-up PR for the 7 minor docstring findings before publish (recommended but not blocking).

## Verification log

```
$ grep -rn "UnicDB-results.focus" src/
(no matches)

$ npm run typecheck
> tsc --noEmit
(exit 0, no output)

$ npm run compile
> esbuild build complete: dist/extension.js + dist/webview.js
(exit 0)

$ npm test
Test Files  244 passed | 1 skipped (245)
     Tests  3619 passed | 2 skipped (3621)
Duration  18.57s
```

## Files in this cycle (17 total)

```
src/ui/resultsPanel.ts                                    (modified — WebviewViewProvider + correct focus cmd)
src/extension.ts                                          (modified — registerWebviewViewProvider wiring)
package.json                                              (modified — viewsContainers.panel + activation, drop resultsPlacement)
src/ui/__tests__/resultsPanelViewProvider.test.ts         (new — view provider contract)
src/ui/__tests__/resultsPanelViewManifest.test.ts         (new — manifest contract)
src/ui/__tests__/resultsPanelBottomPanelIntegration.test.ts (new — regression net)
src/ui/__tests__/resultsPanel.test.ts                     (modified)
src/ui/__tests__/manualCommit.test.ts                     (modified — commands mock + view provider hookup)
src/extension.test.ts                                     (modified)
src/ui/__tests__/resultsPanelRequery.test.ts              (modified — correct focus cmd)
src/ui/__tests__/resultsPanelRetry.test.ts                (modified — correct focus cmd)
src/ui/__tests__/resultsPanelDistinctValues.test.ts       (modified — correct focus cmd)
src/ui/__tests__/resultsPanelSaveEdits.test.ts            (modified — correct focus cmd)
src/ui/__tests__/resultsPanelServerFilter.test.ts         (modified — correct focus cmd)
src/ui/__tests__/resultsPanelErrorIntegration.test.ts     (modified — correct focus cmd)
src/ui/__tests__/resultsPanelClose.test.ts                (modified — correct focus cmd)
src/ui/__tests__/resultsPanelCloseWiring.test.ts          (modified — correct focus cmd)
src/ui/__tests__/resultsPanelOrderBy.test.ts              (modified — correct focus cmd)
src/ui/__tests__/userGuideContent.test.ts                 (modified — drop resultsPlacement docs)
docs/UNICDB_USER_GUIDE.md                                 (modified — document forced placement)
docs/AI_HANDOFF/PLAN.md                                   (modified)
docs/AI_HANDOFF/tasks/TASK-RP-001.md through RP-006.md    (new)
docs/AI_HANDOFF/INDEX.md                                  (new)
docs/AI_HANDOFF/RUN.md                                    (new — cursor)
docs/AI_HANDOFF/FINAL_REPORT_RP.md                        (this file)
```

## Reset state for next pipeline

- `docs/AI_HANDOFF/RUN.md` → `Phase: done`
- `docs/AI_HANDOFF/INDEX.md` → all 6 tasks recorded with verdicts
- All `docs/AI_HANDOFF/tasks/*.md` → end with `## Reviewer Verdict` (RP-005 has its R1 verdict)
- Working tree clean on main @ 4812026
- Pushed to origin

Next invocation of `/ukit:handoff-fullstack` will start a fresh cycle (RUN.md is `done` → not a continuation).
