# TASK-AIX03-001 — analysisReport pure module

Cycle: AIX-03 · Wave 3 · Priority: P1
Status: pending
Depends on: —
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/ai/analysisReport.ts` — PURE module (no vscode, no fs, no net):

1. `parseExplainPlan(planText: string): { nodes: number; deepest: string }` —
   count plan lines (non-empty lines of a text EXPLAIN), `deepest` = the
   last non-empty line trimmed (the leaf operation). Empty input →
   `{nodes: 0, deepest: ""}`.
2. `summarizeToolOutcome(tool: string, status: "ok" | "failed" | "denied",
   shape: string): string` — one compact card line:
   - ok → `✓ ${tool} — ${shape}`
   - denied → `✗ ${tool} — denied by user`
   - failed → `✗ ${tool} — failed: ${shape}`
3. `capTokens(text: string, max: number): string` — keep at most `max`
   whitespace-separated tokens, append `…` when truncated. max ≤ 0 → `…`.

## Acceptance

- [ ] Unit tests cover: plan with 4 lines → nodes 4 + deepest trimmed;
      empty plan; summarizeToolOutcome all 3 statuses; capTokens exact/
      truncated/non-positive; no vscode import (scaffold in 004).
- [ ] `npx vitest run src/ai/__tests__/analysisReport.test.ts` green.

## Executor

### Executor (unic-code)

**RED evidence**: first `npx vitest run src/ai/__tests__/analysisReport.test.ts` → `Failed to load url ../analysisReport ... Tests no tests` (module absent — import-time RED).

**GREEN evidence**: 10/10 — parseExplainPlan (4-line plan → nodes 3 + deepest trimmed; empty; single line), summarizeToolOutcome all 3 statuses, capTokens exact/truncated/non-positive/whitespace-collapse. Pure module: no vscode/fs/net imports.


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
