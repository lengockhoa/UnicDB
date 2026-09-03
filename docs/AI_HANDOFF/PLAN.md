# VSDB Cycle — Open Console for Object (right-click schema tree)

> Bounded cycle. Resumes from working-tree state left by the previous session
> (main @ 4c71e40, v1.51.0 base; 6 files modified, all green on `npm test`
> 3407|2 + `npm run typecheck` 0). Goal: hand the diff to unic-smart for R2,
> absorb any `changes_requested`, then commit + push + tag as v1.52.0.

## 1. Intent

Ship a right-click **"VSDB: Open Console for Object"** entry on schema-tree
table/view nodes that opens the SQL Console with a fresh tab pre-filled with a
driver-aware SELECT * … LIMIT/TOP 100 snippet for the picked object. Success:

- User right-clicks a table or view → menu shows the new entry.
- Picking it opens (or reveals) the Console singleton + creates a fresh tab
  named `Query <schema>.<table>` whose buffer is the driver-aware snippet.
- Existing Console behaviour (selection run, format, EXPLAIN, save-to-.sql,
  ghost-text autocomplete, draft recovery, history) is unchanged.
- No drive-by changes: BQ frozen surfaces, BQ-00/BQ-01 narrow seam,
  `formatBigQueryCell`, `@google-cloud/bigquery@9.0.3` — all byte-untouched.

## 2. Scope

In scope (one task):

- Reuse existing `commandOpenConsole` seeder so the singleton + onRun +
  draft/autocomplete wiring stays exactly the same as `vsdb.openConsole`.
- Add a public method on `ConsolePanel` that creates a tab with an
  initial buffer and pushes one `state` postMessage to the webview
  (must NOT go through `setBuffer`, which is the silent webview→host
  echo path — see ARP-08 #30).
- Register `vsdb.openConsoleForObject` command + `view/item/context`
  menu entry (`group: inline`, `when: view == vsdb.schemaTree &&
  (viewItem == table || viewItem == view)`).
- Tests for the resolution path (qualified string + node meta shape +
  invalid arg fallback).
- Widen the BQ-04 frozen-surface `package.json` dep-manifest guard so a
  legitimate post-BQ-04 contributes change (new command + new menu entry)
  does not trip the dependency drift guard.

Out of scope:

- No webview rebuild required (the change is host-side only; webview
  already renders the `state` postMessage payload that the new code path
  produces).
- No new keybindings, no new top-level commands.
- No change to BQ frozen surfaces, `formatBigQueryCell`, or any
  `@google-cloud/bigquery` dependency.

## 3. Approach

### Working-tree state (resume point)

The previous session already produced this diff on top of v1.51.0 base
(main @ 4c71e40). Tests + typecheck are GREEN:

| File | +/− |
|---|---|
| `package.json` | +11 (1 command + 1 menu entry, group `inline`) |
| `src/extension.ts` | +105 (command + `commandOpenConsoleForObject` + `resolveQualifiedFromArg`) |
| `src/ui/consolePanel.ts` | +25 / −2 (new public `seedTab(name, buffer)`; `setBuffer` / `createTab` contracts preserved) |
| `src/extension.test.ts` | +116 (5 new tests, `activateFresh` pattern for module-singleton isolation) |
| `src/adapters/__tests__/bq04SurfaceGuard.test.ts` | +37 / −12 (filter broadened for contributes changes; dep manifest still strict) |

### Trade-offs

- **Reuse `commandOpenConsole`** for panel creation instead of writing a
  parallel seeder: keeps the singleton + onRun + draft/autocomplete wiring
  identical, so any future change to `commandOpenConsole` automatically
  benefits the new path. Cost: handler runs an extra `if (!consolePanel)
  … show()` pair, which is cheap.
- **New `seedTab()` instead of `createTab() + setBuffer()`**:
  `setBuffer` is intentionally silent (ARP-08 #30 — the webview→host
  echo path that must not loop). `seedTab` is the host-side companion
  that creates + sets + pushes `state`. Two methods with two distinct
  contracts are clearer than overloading one.
- **`bq04SurfaceGuard` filter widened** to drop +/- lines whose key is
  one of the standard contributes keys (`command`, `title`, `category`,
  `icon`, `when`, `group`, `keybinding`, `mac`, `win`, `linux`) plus
  the `{` / `}` block delimiters around them. The dependency manifest
  (`dependencies`, `devDependencies`, `peerDependencies`, `engines`) is
  never matched by this filter — adapter drift is still strictly
  guarded.

### Alternatives rejected

- **Auto-execute the snippet after seeding**: rejected — the user's
  standing preference is to inspect before running. Run is always
  explicit (Cmd/Ctrl+Enter).
- **Reuse `vsdb.generateSelect` to insert into the active console
  buffer instead of creating a new tab**: rejected — users may already
  have work in progress; a new tab is safer (and ARP-08 draft recovery
  persists it across reload).
- **Bump guard test to assert package.json file mtime instead of diff**:
  rejected — the guard's whole purpose is to flag drift in the dep
  manifest at the byte level; mtime doesn't catch a sneaky dep version
  bump that lands in the same release.

## 4. Test Plan

### Existing tests (already GREEN)

| Suite | Count | Notes |
|---|---|---|
| `src/extension.test.ts` | 122 | includes 5 new tests for `vsdb.openConsoleForObject` |
| `src/ui/__tests__/consoleTabs.test.ts` | 9 | ARP-08 #30 (silent `setBuffer`) still pinned |
| `src/adapters/__tests__/bq04SurfaceGuard.test.ts` | 4 | 3 frozen-surface rows + 1 sanity check |
| Full suite | 3407 passed \| 2 skipped | (+5 over v1.51.0 baseline 3402) |
| `npm run typecheck` | 0 errors | |

### New test cases (added in working-tree state)

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 1 | unit | `package.json contributes khai báo command mới + menu entry đúng when` | command id `vsdb.openConsoleForObject`, title `VSDB: Open Console for Object`, icon `$(window)`; menu entry `view == vsdb.schemaTree && (viewItem == table || viewItem == view)`, group `inline` |
| 2 | unit | `command vsdb.openConsoleForObject được register khi activate` | `state.registeredCommands.has("vsdb.openConsoleForObject") === true` |
| 3 | happy path | `handler với qualified string → tạo webview panel + pre-fill snippet` | Active tab name `Query public.users`, buffer `SELECT * FROM public.users LIMIT 100;` (postgres fallback) |
| 4 | edge | `argument shape `{ meta: { schema, objectName } }` resolves qualified name` | Active tab name `Query sales.orders`, buffer `SELECT * FROM sales.orders LIMIT 100;` |
| 5 | regression | `argument shape không hợp lệ → showInformationMessage, KHÔNG mở panel mới` | Invalid args (undefined / number / empty-meta) → `vscode.window.showInformationMessage` called, `state.createdWebviewPanels.length` unchanged |

## 5. Verification

```bash
# Full suite — must stay green.
npm test

# Typecheck — must be clean.
npm run typecheck

# Webview rebuild — NOT required (host-side only). Run only if review flags
# an unexpected webview change.
npm run build:webview

# Lint (project-wide style gate).
npm run lint

# Frozen-surface guard — must pass (this is the canary).
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts

# The new command surface — focused.
npx vitest run src/extension.test.ts -t "openConsoleForObject"

# ARP-08 #30 silent setBuffer invariant — must stay green.
npx vitest run src/ui/__tests__/consoleTabs.test.ts
```

## 6. Acceptance

- [ ] `npm test` → 3407 passed | 2 skipped (no change from current).
- [ ] `npm run typecheck` → exit 0.
- [ ] Reviewer verdict: APPROVED or APPROVED-WITH-MINOR.
- [ ] `package.json` diff vs `75cdb08` filtered by `packageJsonDepsDiff` is empty (proven by `bq04SurfaceGuard` row 3).
- [ ] `git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts src/adapters/bigqueryPages.ts` is empty (BQ frozen surfaces byte-identical).
- [ ] CHANGELOG.md updated under the next version (v1.52.0) with an Added entry describing the right-click command + menu entry.
- [ ] docs/STATUS.md and docs/AI_HANDOFF/INDEX.md updated when this cycle closes.
- [ ] Cycle R5: `git commit`, bump `package.json` to v1.52.0, `npm run package` (VSIX), `git tag v1.52.0`, `git push origin main`, push tag, create GitHub release.

## Planner Report

PLANNER_MODEL: claude-sonnet-4-6 (unic-code, picked because the plan is small + the working-tree diff is already produced; unic-smart is reserved for R2 review per §3-Tier Model Routing in CLAUDE.md)