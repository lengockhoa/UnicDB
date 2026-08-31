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

