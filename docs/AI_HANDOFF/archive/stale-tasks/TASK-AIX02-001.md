# TASK-AIX02-001 — fileDiff pure unified-diff module

**Status:** implemented — awaiting reviewer (unic-smart)
**Owner:** executor (TDD)
**Reviewer:** unic-smart (cycle reviewer)

## Goal

NEW pure module `src/ai/fileDiff.ts`: LCS-based unified diff over two strings (old, new).
NO vscode import. Exports:

- `buildUnifiedDiff(oldText: string, newText: string, opts?: { maxLines?: number }): string` —
  classic `@@ -a,b +c,d @@` hunks with 3 lines of context; default cap 200 rendered lines
  (tail truncated with `… (N more lines)`); `\ No newline at end of file` sentinel when either
  side lacks the trailing newline.
- `diffStats(oldText: string, newText: string): { added: number; removed: number }` — line counts.
- Both functions deterministic and pure (same input → same output).

## Test Cases (REQUIRED — TDD)

| # | Type | Expected |
|---|------|----------|
| 1 | unit | identical texts → empty string |
| 2 | unit | single-line change produces correct @@ header + context |
| 3 | unit | pure addition / pure deletion |
| 4 | unit | missing trailing newline emits sentinel |
| 5 | unit | maxLines cap truncates with marker |
| 6 | unit | diffStats counts |
| 7 | property-ish | newline-joined removals + additions reconstruct both inputs |

## Verification

```bash
npx vitest run src/ai/__tests__/fileDiff.test.ts
npm run typecheck
```

## Executor Report

### Executor (unic-code)

**RED evidence**: first `npx vitest run src/ai/__tests__/fileDiff.test.ts` → `Tests no tests` (file failed to load: `src/ai/fileDiff.ts` did not exist — module-not-found RED).

**GREEN evidence**: 7/7 after implementing `buildUnifiedDiff` (LCS table, hunk grouping with 3-line context, 200-line cap with `… (N more lines)`, `\ No newline at end of file` sentinel) + `diffStats`. One test expectation corrected during GREEN: the hunk header spans the full context window (`@@ -1,5 +1,5 @@`), matching git semantics, not the bare changed line.

## Reviewer Verdict (unic-smart, cycle reviewer Aix02Reviewer)

**Round history** (executor commits vs review rounds):
- Initial implementation (e028910): CHANGES-REQUESTED — empty production allowlist; no pre-approval diff on the permission card; generic non-JSON denial; malformed no-newline sentinel placement; hunk truncation that hid the preview.
- Fix round 1 (dac484e): CHANGES-REQUESTED — missing workspace-trust enforcement; stale-preview overwrite protection; preservation of non-file/remote URI identity; normal multi-hunk truncation; old-side context newline handling.
- Fix round 2 (efc86df): CHANGES-REQUESTED — stale snapshot keyed only by path instead of per approval request; host write needed the expected-snapshot (CAS) contract; both-side no-final-newline needed two sentinels.
- Fix round 3 (f3be6e3): CHANGES-REQUESTED — overflowed hunks dropped newline sentinels.
- Fix round 4 (0b5d6b8): **VERDICT: APPROVED** — shared sentinel renderer covers full and truncated hunks (one- and two-sided missing-final-newline).

**Verified final behavior** (reviewer): workspace writes gated by grounding + workspace trust + exact URI-string allowlist membership + explicit permission + pre-approval capped unified diff + request-scoped expected-content binding + host-side conflict detection before atomic temp+rename; identical gated config on builtin and OMP/MCP paths; pure modules free of vscode/fs/child_process/shell; targeted suite 40/40.

**Residual notes**: none blocking. Full-suite/typecheck/compile re-run reported by executor (2539 passed | 2 skipped; 0 TS errors; esbuild clean) under the reviewer's scoped-validation constraint.

**Final: VERDICT: APPROVED** (all tasks TASK-AIX02-001..004 APPROVED, round 5 of review).
