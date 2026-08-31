# TASK-DBX06-001 — renameAnalysis pure module

Cycle: DBX-06 · Wave 4 · Priority: P1
Status: pending
Depends on: —
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/core/ddl/renameAnalysis.ts` — PURE (no vscode, no fs, no net):

1. `validateNewName(newName: unknown): string | null` — null when valid:
   - string, non-empty, matches `^[A-Za-z_][A-Za-z0-9_$]*$`
   - no forbidden SQL keyword substring (insert|update|delete|drop|alter|
     create|truncate|grant|revoke|copy|merge|call|exec|into, word boundary)
   Otherwise returns a human-readable error.
2. `RenameCatalogRows` interface: `{ dependentViews: Array<{name: string;
   kind: string}>; referencingFks: Array<{constraint: string; fromTable:
   string}>; routines: Array<{name: string}>; collisions: string[] }`.
3. `analyzeUsage(rows: RenameCatalogRows): RenameReport` — pure reducer:
   `{report: {views, fks, routines, collisions}, usageCount: number,
   safe: boolean}` where `safe = collisions.length === 0`. usageCount =
   views.length + fks.length + routines.length.

## Acceptance

- [ ] Tests: valid name → null; empty/non-string; `users; DROP` (regex);
      `inserted_at` (forbidden substring); analyzeUsage counts + safe flag
      both ways; empty catalog → zero usage, safe.
- [ ] `npx vitest run src/core/ddl/__tests__/renameAnalysis.test.ts` green.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
