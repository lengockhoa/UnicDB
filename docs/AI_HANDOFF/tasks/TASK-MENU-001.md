# TASK-MENU-001 — Schema-tree table-node context menu: New Table #1, Modify Table #2

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2-§4

## Goal

Make the schema-tree table-node right-click menu render `New Table…` as item #1 and
`Modify Table…` as item #2 ("Đưa cả hai lên đầu"), leaving every other `vsdb`-group item in
its current alphabetical relative order. Mechanism: two `order` keys in package.json menu
contributions, plus the one-word guard-whitelist extension that keeps the BQ04 surface guard
green, plus tests pinning the ordering contract.

## Target Files

- `package.json` — in `contributes.menus["view/item/context"]`: add `"order": "1"` to the
  `vsdb.newTable` entry and `"order": "2"` to the `vsdb.modifyTable` entry (lines ~467-476;
  unique anchors below in Discussion). Nothing else in the file changes.
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — extend `contributesKeyPattern`
  (line 74) from
  `^[+-]\s+"(command|title|category|icon|when|group|keybinding|mac|win|linux)":/` to
  `^[+-]\s+"(command|title|category|icon|when|group|order|keybinding|mac|win|linux)":/`
  so guard test 3 keeps filtering contributes lines after `order` keys are added. This file
  is NOT frozen — only `bigqueryTypes.ts` / `bigqueryAdc.ts` / `src/adapters/types.ts` /
  the dependency manifest are.
- `src/extension.test.ts` — add one new describe block (`MENU`) at the end of the file
  pinning the ordering contract (test cases below). Precedent: the OC4O menu test at ~line
  4605 uses the same module-level `pkgJson` (defined at line 552).
- `CHANGELOG.md` — one "Changed" bullet under the existing `[1.51.1] — pending` heading.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `MENU: vsdb.newTable menu entry có order "1" + when/group đúng; vsdb.modifyTable có order "2" + when/group đúng` | `newTable` entry: `order === "1"`, `when === "view == vsdb.schemaTree && (viewItem == schema \|\| viewItem == category \|\| viewItem == table)"`, `group === "vsdb"`; `modifyTable` entry: `order === "2"`, `when === "view == vsdb.schemaTree && viewItem == table"`, `group === "vsdb"` | `pkgJson` (module-level, `src/extension.test.ts` line 552); RED before the package.json edit (both entries lack `order` → `entry!.order` is `undefined`) |
| 2 | edge (structural) | `MENU: chỉ đúng 2 entry vsdb-group có order — 13 entry còn lại KHÔNG có order (alphabet fallback giữ nguyên)` | `Set(ctxMenus.filter(m => m.order !== undefined).map(m => m.command))` deep-equals exactly `["vsdb.newTable", "vsdb.modifyTable"]`; e.g. `vsdb.analyzeTable` and `vsdb.copyCreateDdl` entries both have `order === undefined` | same `pkgJson`; RED before (set is empty), GREEN after |
| 3 | edge (behavioral) | `MENU: sort mô phỏng VS Code trên table-node vsdb group → New Table… #1, Modify Table… #2, phần còn lại giữ relative alphabet` | With comparator `(a, b) => (a.order ?? Infinity-ish "zzzz") localeCompare on order, then localeCompare on title`: filtered to entries whose `when` includes `viewItem == table`, result titles are `["New Table…", "Modify Table…", "Analyze Table", "Copy Create Query", "Generate Sample Data…", "Rename Column…", "Rename Table…", "Vacuum Table", "VSDB: Export Structure", "VSDB: Postman Payload"]` — items 3..10 in current alphabetical order; note `VSDB: Refresh Schema` and other schema/connection-only entries are correctly excluded by the table filter | same `pkgJson`; RED before (title[0] === "Analyze Table") |
| 4 | regression (guard) | existing `bq04SurfaceGuard` suite still passes with `order` keys in the working tree | All 4 tests of `src/adapters/__tests__/bq04SurfaceGuard.test.ts` pass — test 3 (`package.json dependency manifest unchanged`) still drops contributes lines (incl. the new `order` lines) and the sanity block still proves the wiring is live | Working tree with the package.json change applied; RED before the guard regex edit (guard test 3 fails on `+ "order": "1",` lines) |

Test-case #4 is verified by running the guard file (see Verification), not by a new test
function in this task's describe block. Test-case #3 comparator note: use the string
`"zzzz"` (or `order === undefined ? "zzzz" : order`) as the missing-order sentinel so the
comparator mirrors VS Code's "ordered first, unordered alphabetical after" without Number
coercion.

## Test Files

- `src/extension.test.ts` — new `describe("MENU — ...")` block containing test cases 1-3.
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — existing suite, modified regex
  (test case 4).

## Verification Commands

```bash
# targeted — new MENU tests (RED before package.json edit, GREEN after)
npx vitest run src/extension.test.ts -t "MENU"
# regression — guard suite (RED before regex edit, GREEN after)
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
# full suite — baseline 3417 passed / 2 skipped + 3 new tests
npm test
# typecheck (mandatory; project has NO lint script) + compile
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `git diff package.json` shows exactly two added lines: `"order": "1"` on the
      `vsdb.newTable` entry, `"order": "2"` on the `vsdb.modifyTable` entry; both `when`
      strings and both `group` values byte-unchanged; no other line changed.
- [ ] All 3 new MENU tests pass; both were demonstrated RED against unmodified package.json
      before the edit and GREEN after.
- [ ] `bq04SurfaceGuard.test.ts` passes (4/4) after the regex extension.
- [ ] `npm test` green: 3417 pre-existing + 3 new, 2 skipped stays 2 skipped.
- [ ] `npm run typecheck` 0 errors; `npm run compile` clean.
- [ ] `CHANGELOG.md` has one "Changed" bullet under `[1.51.1] — pending`.
- [ ] No file outside {package.json, the 2 test files, CHANGELOG.md} modified.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)` — declarative manifest change only; no runtime symbol used.
- Produces: `package.json contributes.menus["view/item/context"]` entries
  `{ command: "vsdb.newTable", when: "view == vsdb.schemaTree && (viewItem == schema || viewItem == category || viewItem == table)", group: "vsdb", order: "1" }`
  and `{ command: "vsdb.modifyTable", when: "view == vsdb.schemaTree && viewItem == table", group: "vsdb", order: "2" }`
  (exact current `when` strings, verified from package.json lines 467-476). No later task
  consumes this; it is the user-facing deliverable.

---

## Discussion

### 2026-09-04 · planner · unic-smart

Verified before writing (do not re-derive):

- Zero `order` keys exist anywhere in package.json today; all 15 `view/item/context`
  `group: "vsdb"` entries sort alphabetically. Raw anchors (package.json lines 467-476):
  the `newTable` menu entry ends `"group": "vsdb"` on line 470 and the `modifyTable` entry
  ends `"group": "vsdb"` on line 475 — each with the `when` strings quoted in §Interfaces.
  Suggested edit shape (unique because the full `when` strings are unique):
  `"when": "view == vsdb.schemaTree && (viewItem == schema || viewItem == category || viewItem == table)",\n          "group": "vsdb"` → append `\n          "order": "1"` — and analogously `"when": "view == vsdb.schemaTree && viewItem == table",\n          "group": "vsdb"` → append `\n          "order": "2"`.
- `package.json` scripts: `test`=`vitest run`, `typecheck`=`tsc --noEmit`,
  `compile`=`node esbuild.js`, `verify:release`=`npm test && npm run typecheck && npm run compile`.
  **There is no `lint` script** — do not invent one.
- The guard coupling is real and verified: `contributesKeyPattern` (line 74 of
  bq04SurfaceGuard.test.ts) whitelists `(command|title|category|icon|when|group|keybinding|mac|win|linux)`
  only, so `+        "order": "1",` survives the filter and guard test 3 fails. Extending the
  whitelist with `order` is the same move as the v1.51.0 "filter tightened" change.
- Idiomatic test location chosen: `src/extension.test.ts` (module-level `pkgJson` at line
  552; precedent menu tests at 580, 1767, 2085, 4605 — the OC4O cycle added its menu test
  there rather than a new file). tsconfig excludes `**/*.test.ts` from typecheck include, so
  typecheck is unaffected by the new tests either way.
- Choice recorded per plan §3: string `"1"`/`"2"` order values (VS Code lexicographic
  convention), no new group, no declaration reorder.
- CHANGELOG bullet goes under the already-pending `[1.51.1] — pending` entry; no version bump,
  no commit/push in this cycle (maintainer-owned; package-lock.json is hook-write-protected).

(no comments yet)
