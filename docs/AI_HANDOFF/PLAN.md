# PLAN — Cycle MENU: schema-tree table-node context menu order

Prior cycle OC4O closed (feature commit `a05fa7d`, close-out `0fc7106`, clean tree). This is a
fresh cycle on `main @ 0fc7106`.

## §1 Intent

The right-click context menu on a schema-tree **table** node currently renders every
`vsdb`-group entry alphabetically by title, because no entry carries an `order` key:

> Analyze Table, Copy Create Query, Generate Sample Data…, Modify Table…, New Table…,
> Rename Column…, Rename Table…, Vacuum Table, VSDB: Export Structure,
> VSDB: Postman Payload, VSDB: Refresh Schema

Human request (Vietnamese): "Tôi muốn sắp xếp lại chỗ này: 1. New Table, 2. Modify Table".
**Confirmed decision, verbatim: "Đưa cả hai lên đầu"** — `New Table…` becomes item #1 of the
menu, `Modify Table…` item #2; all remaining items keep their current (relative alphabetical)
order below.

Success = the rendered table-node context menu starts with New Table…, then Modify Table…,
with the rest unchanged; the ordering contract is pinned by tests; the full suite (3417
baseline), typecheck, and compile stay green.

## §2 Scope

**In-scope**
- `package.json` → `contributes.menus["view/item/context"]`: add `"order": "1"` to the
  `vsdb.newTable` entry and `"order": "2"` to the `vsdb.modifyTable` entry. No other attribute
  of either entry changes; no other entry changes.
- `src/adapters/__tests__/bq04SurfaceGuard.test.ts`: extend the `contributesKeyPattern`
  whitelist with `order` (one word) so guard test 3 keeps filtering contributes changes.
- `src/extension.test.ts`: new describe block pinning the ordering contract (happy + edges).
- `CHANGELOG.md`: one "Changed" bullet under the existing `[1.51.1] — pending` entry
  (user-facing menu change; repo convention: docs updated when user-facing behavior changes).

**Out-of-scope**
- Any reordering, grouping, or renaming of the other 13 `vsdb`-group entries.
- Runtime code (`src/extension.ts`, `src/ui/*`) — ordering is purely declarative; no source
  `.ts` under `src/` (outside tests) is touched.
- Sub-menus, separators, new groups, keybindings, other menus (`view/title`, editor menus).
- Version bump / release / tag / push (maintainer-owned, as in OC4O close-out).

**Wave constraint:** tasks in the same wave must not modify the same file. This cycle has
exactly one task (single small concern), so the constraint is trivially satisfied.

Scope complexity: LOW — one subsystem (VS Code menu contribution manifest), one task.

## §3 Approach

VS Code sorts same-group items in `view/item/context` as: entries **with** `order`, ascending
lexicographic by the `order` string, first; then entries **without** `order`, alphabetically by
title. Today all 15 `vsdb`-group `view/item/context` entries lack `order`, hence the
alphabetical render. Adding `"order": "1"` / `"order": "2"` (string form is the conventional
shape in package.json menu contributions) moves exactly the two requested commands to the top;
everything else keeps its alphabetical fallback.

- **String, not number:** VS Code compares `order` lexicographically; single digits "1"/"2"
  sort correctly. Numbers 1/2 would also work, but strings are the documented convention.
- **Lexicographic caveat:** a hypothetical future `order: "10"` would sort before "2"; the new
  structural test pins the exact key set `{vsdb.newTable, vsdb.modifyTable}`, keeping the
  surface at two single digits. Not a problem for this cycle.
- **Discovered coupling (must-fix, verified):** `src/adapters/__tests__/bq04SurfaceGuard.test.ts`
  test 3 (`package.json dependency manifest unchanged`) strips contributes lines via
  `contributesKeyPattern` =
  `^[+-]\s+"(command|title|category|icon|when|group|keybinding|mac|win|linux)":/` (line 74).
  An added `+        "order": "1",` line does **not** match that whitelist and would survive the
  filter, failing the guard. Fix = one-word whitelist extension:
  `(command|title|category|icon|when|group|order|keybinding|mac|win|linux)`. Same spirit as the
  v1.51.0 filter tightening (CHANGELOG "Changed"): the guard catches dependency drift; `order`
  is a contributes key exactly like `when`/`group`.
- **Alternatives rejected:**
  - *Reorder declarations in package.json* — no effect: VS Code ignores declaration order and
    sorts alphabetically within a group; this is the root cause being fixed.
  - *New group (e.g. `group: "vsdb_top"`)* — renders a separator line and reshapes the visual
    grouping of the whole menu; heavier than "Đưa cả hai lên đầu" asked for.
  - *Runtime reorder in extension code* — menu contributions are declarative; there is no
    supported runtime reorder API.

## §4 Test Plan

| Type | Test Name | Expected |
|------|-----------|----------|
| happy | `package.json view/item/context: vsdb.newTable có order "1" + when đúng; vsdb.modifyTable có order "2" + when đúng` | `newTable` entry: `order === "1"`, `when === "view == vsdb.schemaTree && (viewItem == schema \|\| viewItem == category \|\| viewItem == table)"`, `group === "vsdb"`; `modifyTable` entry: `order === "2"`, `when === "view == vsdb.schemaTree && viewItem == table"`, `group === "vsdb"` |
| edge (structural) | `chỉ đúng 2 entry vsdb-group có order — 13 entry còn lại KHÔNG có order (fallback alphabet giữ nguyên)` | Set of `view/item/context` commands having an `order` key equals exactly `{ "vsdb.newTable", "vsdb.modifyTable" }`; every other vsdb-group entry has `order === undefined` (e.g. `vsdb.analyzeTable` has no order so it still renders above `vsdb.copyCreateDdl`) |
| edge (behavioral) | `mô phỏng sort của VS Code trên group vsdb → New Table… #1, Modify Table… #2, phần còn lại giữ relative alphabet` | Applying the VS Code comparator (ordered entries ascending by `order`, then unordered alphabetically by title) to the table-node vsdb subset yields titles[0] === "New Table…" and titles[1] === "Modify Table…", and the tail keeps current alphabetical relative order (Analyze Table → Copy Create Query → Generate Sample Data… → …) |
| regression (guard) | `bq04SurfaceGuard test 3 vẫn xanh với order keys (whitelist đã mở rộng)` | `npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts` — all 4 tests pass; the filter still drops contributes lines and still reports real dependency drift (sanity test intact) |

Edge kinds are genuinely different: structural (key-set exhaustiveness), behavioral (sort
simulation), regression (guard filter). The happy + behavioral tests are RED against current
HEAD (no `order` keys today → New Table… is not first) and GREEN after the 2-key change — a
real TDD cycle.

## §5 Verification

```bash
# targeted (TDD loop — behavioral + happy + structural tests; RED before, GREEN after)
npx vitest run src/extension.test.ts -t "MENU"
# guard regression
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
# full suite (baseline 3417 passed / 2 skipped)
npm test
# typecheck + compile (project has NO lint script — typecheck is the static gate)
npm run typecheck
npm run compile
```

`npm run typecheck` exists and is mandatory; there is genuinely **no `lint` script** in
package.json (`scripts`: compile, watch, test, test:integration, typecheck, package,
verify:fast, verify:release, profile:fast, profile:release, vscode:prepublish).

## §6 Acceptance

- [ ] `package.json` diff contains exactly two added lines: `"order": "1"` on the
      `vsdb.newTable` `view/item/context` entry, `"order": "2"` on `vsdb.modifyTable`;
      `when` and `group` of both entries byte-unchanged; no other entry touched.
- [ ] New MENU tests in `src/extension.test.ts` all pass (happy + 2 edge kinds).
- [ ] `bq04SurfaceGuard.test.ts` passes (whitelist covers `order`; dependency guard still live).
- [ ] `npm test` green at 3417 baseline + new tests; `npm run typecheck` 0 errors;
      `npm run compile` clean.
- [ ] `CHANGELOG.md` has one "Changed" bullet under `[1.51.1] — pending`.
- [ ] No file outside {package.json, 2 test files, CHANGELOG.md} modified.

## §7 Global Constraints

- No version bump, no git commit/push/tag in this cycle (maintainer-owned; package-lock.json is
  hook-write-protected).
- Frozen surfaces untouched: BQ-00 (`bigqueryTypes.ts`, `bigqueryAdc.ts`), BQ-01
  (`src/adapters/types.ts`), dependency manifest (no new/removed/upgraded deps).
- `order` values must be the strings `"1"` and `"2"` only; no other vsdb-group entry gains an
  `order` key.
- Both `when` strings must remain byte-identical (they gate which tree node shows the item).
- Full-suite floor: all pre-existing 3417 tests stay green; 2 skipped stays 2 skipped.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: promoted the bq04 guard whitelist extension from an implicit assumption to
an explicit Target File + regression test after verifying `contributesKeyPattern` (line 74)
does not match `"order"` — without it the suite goes red. Moved the contract test home from a
guessed new file to `src/extension.test.ts` after reading where package.json menu tests
actually live (module-level `pkgJson` at line 552; OC4O precedent describe at ~4605). Added
CHANGELOG.md to targets per the repo "docs updated when user-facing" convention.
Known gaps: the behavioral test simulates VS Code's documented same-group ordering (ordered
ascending by `order`, then unordered alphabetical by title) rather than driving a real VS Code
window — vitest cannot render VS Code menus; the simulation + structural tests pin the contract
that produces the requested render.
