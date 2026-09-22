# TASK-001 — Schema-tree table-node context menu: New Table #1, Modify Table #2

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2-§4
- Spec references: `docs/AI_HANDOFF/SPEC.md` §5 FR-001…FR-005, §12

## Goal

Make the schema-tree table-node right-click menu render `New Table…` as item #1 and
`Modify Table…` as item #2 ("Đưa cả hai lên đầu"), leaving every other `UnicDB`-group item in
its current alphabetical relative order. Mechanism: two `order` keys in package.json menu
contributions, plus the one-word guard-whitelist extension that keeps the BQ04 surface guard
green, plus tests pinning the ordering contract.

**Recovery note:** this task is recovered verbatim from
`docs/AI_HANDOFF/archive/stale-tasks/TASK-MENU-001.md`. The implementation it describes was
already committed as `1e96f89` (ancestor of HEAD) — see Discussion. Executor verifies the
landed contract is intact and green; only re-edit if drift is found.

## Target Files

- `package.json` — in `contributes.menus["view/item/context"]`: `"order": "1"` on the
  `UnicDB.newTable` entry and `"order": "2"` on the `UnicDB.modifyTable` entry (lines
  586-596; unique anchors below in Discussion). Nothing else in the file changes.
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — `contributesKeyPattern`
  (line 86) must whitelist `order`:
  `/^[+-]\s+"(command|title|category|icon|when|group|order|key|keybinding|keybindings|mac|win|linux|light|dark)":/`
  so guard test 3 keeps filtering contributes lines with `order` keys present. This file
  is NOT frozen — only `bigqueryTypes.ts` / `bigqueryAdc.ts` / `src/adapters/types.ts` /
  the dependency manifest are.
- `src/extension.test.ts` — `describe("MENU — table-node context menu: New Table #1, Modify Table #2")`
  block pinning the ordering contract (test cases below), landed at ~lines 6007-6108.
  Uses the module-level `pkgJson` (defined at line 634).
- `CHANGELOG.md` — menu-promotion bullet, landed under `[1.51.2] — 2026-09-04` (~line 674).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `MENU: UnicDB.newTable có order "1" + when đúng; UnicDB.modifyTable có order "2" + when đúng` | `newTable` entry: `order === "1"`, `when === "view == UnicDB.schemaTree && (viewItem == schema \|\| viewItem == category \|\| viewItem == table)"`, `group === "UnicDB"`; `modifyTable` entry: `order === "2"`, `when === "view == UnicDB.schemaTree && viewItem == table"`, `group === "UnicDB"` | `pkgJson` (module-level, `src/extension.test.ts` line 634); RED before the package.json edit (both entries lack `order` → `entry!.order` is `undefined`) |
| 2 | edge (structural) | `MENU: chỉ đúng 2 entry UnicDB-group có order — 13 entry còn lại KHÔNG có order (alphabet fallback giữ nguyên)` | `Set(ctxMenus.filter(m => m.order !== undefined).map(m => m.command))` deep-equals exactly `["UnicDB.newTable", "UnicDB.modifyTable"]`; e.g. `UnicDB.analyzeTable` and `UnicDB.copyCreateDdl` entries both have `order === undefined` | same `pkgJson`; RED before (set is empty), GREEN after |
| 3 | edge (behavioral) | `MENU: sort mô phỏng VS Code trên table-node UnicDB group → New Table… #1, Modify Table… #2, phần còn lại giữ relative alphabet` | With comparator `(a, b) => (a.order ?? "zzzz") localeCompare on order, then localeCompare on title`: filtered to entries whose `when` includes `viewItem == table`, result titles are `["New Table…", "Modify Table…", "Analyze Table", "Copy Create Query", "Insert Sample Data…", "Rename Column…", "Rename Table…", "UnicDB: Export Structure", "UnicDB: Postman Payload", "Vacuum Table"]` — items 3..10 in current alphabetical order; note `UnicDB: Refresh Schema` and other schema/connection-only entries are correctly excluded by the table filter | same `pkgJson`; RED before (title[0] === "Analyze Table"), GREEN after |
| 4 | regression (guard) | existing `bq04SurfaceGuard` suite still passes with `order` keys in the working tree | All 4 tests of `src/adapters/__tests__/bq04SurfaceGuard.test.ts` pass — test 3 (`package.json dependency manifest unchanged`) still drops contributes lines (incl. the `order` lines) and the sanity block still proves the wiring is live | Working tree with the package.json change applied; RED before the guard regex edit (guard test 3 fails on `+ "order": "1",` lines) |

Test-case #4 is verified by running the guard file (see Verification), not by a new test
function in this task's describe block. Test-case #3 comparator note: use the string
`"zzzz"` (or `order === undefined ? "zzzz" : order`) as the missing-order sentinel so the
comparator mirrors VS Code's "ordered first, unordered alphabetical after" without Number
coercion.

## Test Files

- `src/extension.test.ts` — `describe("MENU — ...")` block containing test cases 1-3
  (landed at ~lines 6007-6108).
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts` — existing suite, whitelist regex
  includes `order` (test case 4).

## Verification Commands

```bash
# targeted — MENU tests (GREEN; RED/GREEN was demonstrated in commit 1e96f89)
npx vitest run src/extension.test.ts -t "MENU"
# regression — guard suite
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
# full suite — green, 3 MENU tests included
npm test
# typecheck (mandatory; project has NO lint script) + compile
npm run typecheck
npm run compile
```

## Acceptance Criteria

- [ ] `package.json` `view/item/context` shows exactly two `order` keys: `"order": "1"` on
      the `UnicDB.newTable` entry (L586-590), `"order": "2"` on the `UnicDB.modifyTable`
      entry (L591-596); both `when` strings and both `group` values byte-unchanged; no
      other line changed. (Landed in `1e96f89`; verify current file matches.)
- [ ] All 3 MENU tests pass; RED/GREEN was demonstrated in `1e96f89` — executor confirms
      current GREEN and re-verifies RED only if drift requires re-editing.
- [ ] `bq04SurfaceGuard.test.ts` passes (4/4) with the `order`-extended whitelist.
- [ ] `npm test` green with the 3 MENU tests included; skipped count unchanged.
- [ ] `npm run typecheck` 0 errors; `npm run compile` clean.
- [ ] `CHANGELOG.md` carries the menu-promotion bullet (landed under `[1.51.2] — 2026-09-04`).
- [ ] No file outside {package.json, the 2 test files, CHANGELOG.md} modified.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)` — declarative manifest change only; no runtime symbol used.
- Produces: `package.json contributes.menus["view/item/context"]` entries
  `{ command: "UnicDB.newTable", when: "view == UnicDB.schemaTree && (viewItem == schema || viewItem == category || viewItem == table)", group: "UnicDB", order: "1" }`
  and `{ command: "UnicDB.modifyTable", when: "view == UnicDB.schemaTree && viewItem == table", group: "UnicDB", order: "2" }`
  (exact current `when` strings, verified from package.json lines 586-596). No later task
  consumes this; it is the user-facing deliverable.

---

## Discussion

### 2026-09-04 · planner · unic-smart

Verified before writing (do not re-derive):

- Zero `order` keys exist anywhere in package.json today; all 15 `view/item/context`
  `group: "UnicDB"` entries sort alphabetically. Raw anchors (package.json lines 467-476):
  the `newTable` menu entry ends `"group": "UnicDB"` on line 470 and the `modifyTable` entry
  ends `"group": "UnicDB"` on line 475 — each with the `when` strings quoted in §Interfaces.
  Suggested edit shape (unique because the full `when` strings are unique):
  `"when": "view == UnicDB.schemaTree && (viewItem == schema || viewItem == category || viewItem == table)",\n          "group": "UnicDB"` → append `,\n          "order": "1"` — and analogously `"when": "view == UnicDB.schemaTree && viewItem == table",\n          "group": "UnicDB"` → append `,\n          "order": "2"`.
- `package.json` scripts: `test`=`vitest run`, `typecheck`=`tsc --noEmit`,
  `compile`=`node esbuild.js`, `verify:release`=`npm test && npm run typecheck && npm run compile`.
  **There is no `lint` script** — do not invent one.
- The guard coupling is real and verified: `contributesKeyPattern` whitelists contributes
  keys only, so `+        "order": "1",` survives the filter and guard test 3 fails unless
  `order` is whitelisted. Extending the whitelist with `order` is the same move as the
  v1.51.0 "filter tightened" change.
- Idiomatic test location chosen: `src/extension.test.ts` (module-level `pkgJson`;
  precedent menu tests use the same fixture). tsconfig excludes `**/*.test.ts` from
  typecheck include, so typecheck is unaffected by the new tests either way.
- Choice recorded per plan §3: string `"1"`/`"2"` order values (VS Code lexicographic
  convention), no new group, no declaration reorder.
- CHANGELOG bullet goes under the pending release entry; no version bump,
  no commit/push in this cycle (maintainer-owned; package-lock.json is hook-write-protected).

### 2026-09-22 · planner · unic-smart (recovery into cycle MENU-2026-09-22)

Recovered from `archive/stale-tasks/TASK-MENU-001.md` as this cycle's TASK-001.
**The implementation already landed** in commit `1e96f89` ("handoff: MENU — schema-tree
table-node context menu order", ancestor of `main` HEAD): both `order` keys, the guard
whitelist extension, the 3 MENU tests, and the CHANGELOG bullet are all present in the
working tree. This task is therefore verify-and-close: run the Verification Commands,
confirm every Acceptance Criterion against current files, fix drift only if found.

Anchor corrections for drift since 2026-09-04 (verified against current files):

- package.json `view/item/context` block moved L467-476 → L544-657; the two entries now
  sit at L586-596 with `order` already present.
- `contributesKeyPattern` moved L74 → L86 and already includes `order` (plus `key`,
  `keybindings`, `light`, `dark` added by later cycles).
- `pkgJson` moved L552 → L634; MENU describe block exists at ~L6007-6108.
- Test-case #3 expected title list corrected: `Generate Sample Data…` → `Insert Sample
  Data…` (actual command title), and `UnicDB: Export Structure`/`UnicDB: Postman Payload`
  sort before `Vacuum Table` under localeCompare — matches the landed test.
- CHANGELOG heading `[1.51.1] — pending` no longer exists; the bullet shipped under
  `[1.51.2] — 2026-09-04` (~L674).
- Stale baseline "3417 passed" dropped — suite has grown; criterion is now "green with
  the 3 MENU tests included".

### 2026-09-22 · planner · unic-smart — task-budget validator dismissal

`task-budget-validator.mjs` verdict: `needs_breakdown` (4 target files > maxTargetFiles=3).
Dismissed: the 4 files are one atomic unit — the manifest edit is meaningless without its
test pin, the guard whitelist is required by the manifest edit, and the CHANGELOG bullet
is the same user-facing change. Splitting would serialize one logical change across waves
for zero review value; the work is also already landed (1e96f89), so the task is
verify-and-close, not fresh implementation.


(no comments yet)

## Executor Report

- Date: 2026-09-22 · Executor: ExecT1 (omp)
- EXECUTOR_TOOL: other (omp harness)
- EXECUTOR_MODEL: devin/swe-2
- EXECUTOR_SUBAGENT: ExecT1
- Status: PASS

### RED_OUTPUT

Feature pre-landed in `1e96f89` (confirmed ancestor of HEAD); tests verified GREEN — no
RED phase applicable. `npx vitest run src/extension.test.ts -t "MENU"`: 3 passed, 189
skipped (192 collected).

### Verification Output

- `npx vitest run src/extension.test.ts -t "MENU"` → 3 passed / 0 failed.
- `npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts` → 8 passed / 0 failed
  (suite has grown from 4 to 8 tests since the task was written; all green).
- `npm test` → 4822 passed, 5 skipped, 0 failed (322 files; 320 passed, 2 skipped).
- `npm run typecheck` → `tsc --noEmit` clean, 0 errors.
- `npm run compile` → esbuild clean: dist/extension.js 6.7mb, dist/webview.js 2.3mb.

### Acceptance criteria check

- `package.json` L586-596: `"order": "1"` on `UnicDB.newTable` (L589), `"order": "2"` on
  `UnicDB.modifyTable` (L595); `when`/`group` strings byte-unchanged. ✓
- `contributesKeyPattern` (guard test L86) whitelists `order`. ✓
- CHANGELOG bullet present: "Schema-tree table-node context menu now leads with New
  Table…, then Modify Table…" under `[1.51.2]`. ✓
- No source file modified by this executor; only this task file updated.

### Note

First `npm test` run showed 7 failed files / 2 failed tests — all environmental: the
worktree had no installed `node_modules` (only a `.vite` cache dir), so tests shelling
out to `node_modules/.bin/esbuild` (5 webview suites) and `node_modules/.bin/vsce`
(`vsixSecretsExclusion`) failed ENOENT. Fixed by symlinking the main checkout's
`node_modules` into the worktree (`ln -s ../../node_modules`); re-run is fully green.
No spec drift found; no code change needed.

## Reviewer Verdict

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: devin/swe-2
EXECUTOR_MODEL: devin/swe-2 (self-reported, ExecT1)
VERIFICATION_RERUN:
  command: npx vitest run src/extension.test.ts -t "MENU"
  result: 3 pass / 0 fail (189 skipped)
  command: npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
  result: 8 pass / 0 fail
  command: npm run typecheck
  result: 0 errors
TEST_PLAN_COVERAGE: all-followed — 3 MENU tests present at src/extension.test.ts:6015-6108 with real assertions (order values, when/group byte-equality, exact ordered-set, full sorted title list); guard suite covers test-case 4. RED_OUTPUT honestly reports no RED phase (feature pre-landed in 1e96f89; commit message documents original RED/GREEN) — acceptable for verify-and-close.
FINDINGS:
  critical: none
  important: none
  minor:
    - process: reviewer model == executor model (devin/swe-2). Per R2 isolation table this would normally be CHANGES-REQUESTED; per cycle instruction this verify-and-close task (zero new code, docs-only cycle diff) proceeds with the caveat recorded — human should note reduced independence of this review.
    - src/extension.test.ts:6009 — stale comment "pkgJson (line ~552)"; actual definition is ~L634. Cosmetic only.
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Feature diff verified independently: package.json L586-596 carries exactly two order keys on the correct entries with when/group byte-unchanged; guard whitelist includes order; CHANGELOG bullet present at L674 under [1.51.2]. Cycle diff (54faa18..HEAD) touches only docs/AI_HANDOFF — no code drift.

## Model-Tier Guard Override

OVERRIDE_APPROVED_BY: human
REASON: This omp gateway resolves every model tier (@smol/@default/@slow) to the single available model devin/swe-2 — no distinct opus/unic-smart identity exists to author planning or review. Planner, executor, and reviewer were still run as three separate subagent invocations with fresh contexts, preserving review independence. Verify-and-close task: zero new code; reviewer re-ran verification independently (MENU 3/3, guard 8/8, typecheck clean).
