# TASK-AIX03-004 — scaffold hygiene + CHANGELOG/README

Cycle: AIX-03 · Wave 3 · Priority: P2
Status: pending
Depends on: AIX03-003
Reviewer: unic-smart (cycle reviewer)

## Spec

1. `src/__tests__/aix03Scaffold.test.ts`:
   - analysisReport.ts + analysisTools.ts: NO vscode import (import-regex,
     not comment text), no fs/child_process, no `shell: true`, no execSync.
   - Exports present: parseExplainPlan, summarizeToolOutcome, capTokens;
     createAnalyzeTableTool, createDiagnoseQueryTool.
   - aiChatPanelMessages.ts contains the `tool_result` wire kind.
2. CHANGELOG.md: `## [1.22.0]` section (2026-08-31, Cycle AIX-03: visible
   tool-call cards with shape-only outcomes, analyze_table composite,
   diagnose_query classifier; unic-smart APPROVED) + compare link
   v1.21.0...v1.22.0.
3. README.md: feature bullet after the AIX-02 Safe File Operations bullet.

## Acceptance

- [ ] Scaffold tests green; full `npm test`; `npm run typecheck` 0;
      `npm run compile` clean.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
