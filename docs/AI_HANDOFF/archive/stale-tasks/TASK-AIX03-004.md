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

### Executor (unic-code)

**RED evidence**: scaffold module absent on first run (`no tests`); all structural checks passed immediately after creation since the modules were built to the conventions (import-regex vscode check, no fs/child_process/shell — applied from DBX-05/AIX-02 lessons).

**GREEN evidence**: 4/4 scaffold (purity x2, exports, tool_result wire kind). CHANGELOG 1.22.0 + compare link v1.21.0...v1.22.0; README bullet. Full `npm test` → 2567 passed | 2 skipped (193 files); typecheck 0; esbuild clean.


## Reviewer

(verdict appended by reviewer)

## Reviewer Verdict (unic-smart, cycle reviewer Aix03Reviewer)

**Round history**:
- Initial implementation (4234a3e) + round 1 (d79aaa8): CHANGES-REQUESTED — four blocking defects: SQL identifier injection in analyze_table; serialized sample row bytes leaking into tool-result cards; cards omitting the tool/status formatter; missing OMP analysis-tool/outcome-card parity.
- Round 2 (559a669): CHANGES-REQUESTED — top-level {error:…} / {ok:false} JSON envelopes were rendered with a success parts-ok claim.
- Final: **VERDICT: APPROVED** — top-level failure handling prevents false success claims; regression covers both envelopes. All prior findings addressed.

**Verified final behavior** (reviewer): analyze_table rejects non-plain/forbidden identifiers before any adapter call (no interpolated multi-statement SQL); tool-result cards carry tool name + status with shape-only summaries (serialized samples reduced to structural JSON counts, no row values); denial cards use the same formatter; builtin + OMP/ACP paths register the analysis tools through the DB permission gate and emit sanitized outcome cards; JSON failure envelopes display "JSON error" / "ok=false" instead of a positive claim. Executor-reported verification at HEAD 559a669: 2570 passed | 2 skipped; typecheck 0; esbuild clean.

**Residual notes**: none.

**Final: VERDICT: APPROVED** (all tasks TASK-AIX03-001..004 APPROVED).
