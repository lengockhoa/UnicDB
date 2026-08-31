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

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
