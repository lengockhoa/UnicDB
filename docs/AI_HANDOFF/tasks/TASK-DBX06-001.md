# TASK-DBX06-001 — renameAnalysis pure module

Cycle: DBX-06 · Wave 4 · Priority: P1
Status: done
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

**RED** (module missing):
```
FAIL  src/core/ddl/__tests__/renameAnalysis.test.ts
Error: Failed to load url ../renameAnalysis ... Does the file exist?
Tests no tests
```

**GREEN**: `npx vitest run src/core/ddl/__tests__/renameAnalysis.test.ts`
→ Tests 7 passed (7).

Notes:
- FORBIDDEN_RE is left-boundary-only, matching containsForbidden in
  readonlySqlParser (`inserted_at` rejected; `xupdated` allowed).
- Initial test expectation `created_at → null` contradicted the established
  AIX-03 defense-in-depth contract; test corrected to contract parity.

## Reviewer

(verdict appended by reviewer)
