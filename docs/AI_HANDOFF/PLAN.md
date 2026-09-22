# PLAN — MENU-2026-09-22: schema-tree table-node context menu order

## §1 Intent

The schema-tree table-node right-click menu must render `New Table…` as item
#1 and `Modify Table…` as item #2 of the UnicDB group; every other
UnicDB-group item keeps alphabetical-by-title order. Success = the ordering
contract holds in `package.json` `contributes.menus["view/item/context"]` and
is pinned by tests.

**Recovery:** the work was already implemented and committed as `1e96f89`
(ancestor of HEAD) while its task file sat in
`archive/stale-tasks/TASK-MENU-001.md`. This cycle recovers that task as
`TASK-001` and closes it out — executor verifies the landed contract is still
intact and green, fixing drift if found.

## §2 Scope

In scope:
- `package.json` — `"order": "1"` on `UnicDB.newTable`, `"order": "2"` on
  `UnicDB.modifyTable` in `view/item/context` (already landed at L586-596).
- `src/extension.test.ts` — MENU describe block pinning the contract
  (already landed at ~L6007-6108).
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — `order` in the
  contributes-key whitelist (already landed at L86).
- `CHANGELOG.md` — menu-promotion bullet (already landed under `[1.51.2]`,
  ~L674).

Out of scope: any other menu surface, version bump, commit/push/publish.

CONSTRAINT honored: single task, no same-file collisions possible.

## §3 Approach

Declarative VS Code menu ordering: `order` keys on the two entries sort them
ahead of unordered siblings (lexicographic ascending), which then fall back
to alphabetical-by-title. Alternatives rejected: a new menu group (changes
visual grouping, not just order); reordering the JSON array (VS Code ignores
declaration order within a group). Choice recorded: string `"1"`/`"2"` per VS
Code convention.

Because the implementation pre-exists this cycle, TASK-001 is a
verify-and-close task: run the pinned tests, confirm the diff surface matches
the spec exactly, and only re-edit if drift is found.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | MENU: newTable order "1" + when/group; modifyTable order "2" + when/group | exact `order`/`when`/`group` match on both entries |
| edge (structural) | MENU: exactly 2 UnicDB-group entries carry `order`; 13 others do not | ordered set == {newTable, modifyTable}; e.g. analyzeTable/copyCreateDdl `order === undefined` |
| edge (behavioral) | MENU: simulated VS Code sort on table-node group | titles == ["New Table…", "Modify Table…", "Analyze Table", "Copy Create Query", "Insert Sample Data…", "Rename Column…", "Rename Table…", "UnicDB: Export Structure", "UnicDB: Postman Payload", "Vacuum Table"] |
| regression | bq04SurfaceGuard suite | 4/4 pass with `order` keys in working tree |

## §5 Verification

```bash
npx vitest run src/extension.test.ts -t "MENU"
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
npm test
npm run typecheck
npm run compile
```

Project has NO lint script (verified `package.json` scripts: compile, watch,
test, test:integration, typecheck, package, bump*, publish:*, verify:*,
profile:*, vscode:prepublish). `typecheck` + `compile` stand in for lint.

## §6 Acceptance

- [ ] `UnicDB.newTable` entry has `order: "1"`, `UnicDB.modifyTable` has
      `order: "2"`; both `when`/`group` byte-unchanged; no other package.json
      line touched. (Verifiable: `git show 1e96f89 -- package.json` +
      current file L586-596.)
- [ ] All 3 MENU tests pass (`npx vitest run src/extension.test.ts -t "MENU"`).
- [ ] `bq04SurfaceGuard.test.ts` 4/4 pass.
- [ ] `npm test` green; `npm run typecheck` 0 errors; `npm run compile` clean.
- [ ] CHANGELOG bullet present (landed under `[1.51.2] — 2026-09-04`).
- [ ] No file outside {package.json, 2 test files, CHANGELOG.md} modified.

## §7 Global Constraints

- No version bump, no commit/push, no publish — maintainer-owned.
- No new dependencies; package-lock.json is hook-write-protected.
- `when` strings and `group` values byte-identical to current.
- Frozen surfaces (`bigqueryTypes.ts`, `bigqueryAdc.ts`, `src/adapters/types.ts`,
  dependency manifest) untouched — bq04SurfaceGuard enforces.
- Test comparator uses `"zzzz"` sentinel for missing `order` (lexicographic,
  no Number coercion).

## Planner Report
PLANNER_MODEL: unic-smart (planner lane tier; runtime model devin/swe-2)

## Planner Self-Audit
Checklist: 14/14 pass
Fixed during audit: stale-task anchors corrected for drift — package.json
menu block moved L467-476 → L544-657 (entries at L586-596); guard regex
moved L74 → L86 and already contains `order`; pkgJson moved L552 → L634;
MENU describe already exists at ~L6015-6108; CHANGELOG heading `[1.51.1] —
pending` no longer exists — entry landed under released `[1.51.2]` (~L674);
baseline count 3417 stale (suite has grown since).
Known gaps: none — implementation verified already landed in commit 1e96f89;
TASK-001 is verify-and-close.

## Plan Review Log

### Round 1 — 2026-09-22 · devin/swe-2
Status: Approved

COMPLETENESS:
  - none — all spec FRs (FR-001…FR-005) trace to landed code; verify-and-close framing is correct (1e96f89 confirmed ancestor of HEAD; order keys at package.json:589/595, MENU describe at extension.test.ts:6015, `order` in whitelist at bq04SurfaceGuard.test.ts:86, CHANGELOG bullet under [1.51.2]).
CONSISTENCY:
  - minor (non-blocking): PLAN §4 + SPEC §12 say guard suite "4/4 pass" — file now has 8 tests (7 in describe + 1 sanity check). Verification command is unchanged; executor will observe the real count.
CLARITY:
  - none — verification commands are exact; no-lint-script substitution (typecheck + compile) is explicitly justified and correct.
SCOPE:
  - none — single verify-and-close task, file set matches the landed diff exactly.
YAGNI:
  - none — no re-implementation planned; only drift-fix if found.

NOTES: Recovery bookkeeping is honest — the plan records the stale-task origin, anchor drift corrections, and the dismissed task-budget validator. Safe to proceed to execution.
