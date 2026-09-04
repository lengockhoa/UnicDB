# TASK-UX1-002 — SQL Generator on View / Routine nodes (R3+R4)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (wave 2), §3 (UX1-002)

## Goal

DataGrip-parity "SQL Generator": right-click a View or a Routine node → fetch the object's
DDL (`pg_get_viewdef` / `pg_get_functiondef`) → open the VSDB Console seeded with that DDL
in a fresh tab, ready to run or save as .sql. The SQL plumbing already exists
(`CatalogApi.objectDdl`); this task wires two commands + menu entries + a handler that
seeds the console.

## Target Files

- `package.json` — two commands (`vsdb.generateViewDdl`, `vsdb.generateFunctionDdl`,
  icons `$(eye)` / `$(symbol-function)`); two `view/item/context` entries with
  `when: view == vsdb.schemaTree && viewItem == view` and
  `when: view == vsdb.schemaTree && viewItem == routine` (**`routine`, not `function`** —
  the tree's contextValue is `"routine"`, schemaTree.ts:565; group `vsdb`); matching
  `onCommand:` activationEvents lines (guard filter already extended by UX1-006).
- `src/extension.ts` — handler `commandGenerateObjectDdl(kind: "view" | "routine", arg)`:
  resolve node meta (`{ meta: { connection, schema, objectName } }` — schemaTree.ts:541,
  565) → driver gate (postgres + `hasAdapterCapability(adapter, "objectDdl")`) →
  `adapter.catalog.objectDdl(kind, name, schema)` → open console via the existing
  `commandOpenConsole(...)` singleton call + `consolePanel.seedTab("DDL <qualified>",
  ddl.endsWith(";") ? ddl : ddl + ";")` + `consolePanel.show()` (OC4O
  `commandOpenConsoleForObject` pattern, extension.ts:1942). Register both commands.
- `src/extension.test.ts` — new describe block (structural package.json assertions +
  handler behaviour with a stubbed manager/adapter/panel).

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | view node → seeded console tab with view DDL | stubbed `objectDdl("view","v","public")` returns `"CREATE VIEW public.v AS SELECT 1"` → `seedTab` called with name `DDL public.v` and buffer ending in `;`; `consolePanel.show()` called | activate extension with stubbed vscode + manager whose adapter exposes `catalog.objectDdl` + `capabilities.objectDdl: true` |
| 2 | happy | routine node → pg_get_functiondef DDL seeded | same with `kind: "routine"` and a `CREATE FUNCTION` body → seeded verbatim (existing trailing `;` NOT doubled) | same fixture |
| 3 | edge A — none/missing object | objectDdl resolves empty → objectNotFoundError propagates as toast | `objectDdl` rejects (`object not found`) → error toast with the adapter message; no seedTab call | stub throwing `Error('view "x" not found')` |
| 4 | edge B — boundary driver/capability | non-postgres node or `capabilities.objectDdl !== true` | info toast (pg-only wording, mirror `ADMIN_UNSUPPORTED_MESSAGE` style); ZERO adapter calls | adapter with `capabilities.objectDdl: false`; mysql fixture |
| 5 | edge B — malformed arg | command invoked with no node arg (palette) | info toast "right-click a view or routine…"; no adapter call | arg = undefined |
| 6 | edge C — trailing semicolon idempotence | DDL already ending with `;` not double-terminated | input `"CREATE VIEW v AS SELECT 1;"` → buffer `"CREATE VIEW v AS SELECT 1;"` (one `;`) | pure helper `ensureTrailingSemicolon` (extract + unit test) |
| 7 | regression | menu wiring correct | package.json asserts: both commands declared with icons; `view/item/context` entries exist with the exact `when` clauses (`viewItem == view`, `viewItem == routine`); `onCommand:` activations present | module-level `pkgJson` pattern in extension.test.ts |
| 8 | regression | existing table/view console path untouched | `vsdb.openConsoleForObject` tests still green; its `when` clause unchanged | existing suite |

## Test Files

- `src/extension.test.ts` — all cases (new describe; structural + behavioural, following
  the TASK-303 describe pattern at ~line 564).

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npm run typecheck && npm run compile
```

## Acceptance Criteria

- [ ] Cases 1–8 pass; case 7 pins `viewItem == routine` (a `function` clause here is a
      review-blocking bug — dead menu entries).
- [ ] bq04SurfaceGuard 4/4 green (depends on UX1-006's filter extension).
- [ ] No auto-execution: seeded buffer is never run (no `runner.run` in the handler path).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-UX1-006 (guard filter must accept `onCommand:` lines before package.json edits).

## Interfaces

- Consumes: `CatalogApi.objectDdl(kind: "view" | "routine" | "trigger", name: string,
  schema?: string): Promise<string>` (src/adapters/types.ts; impl postgres.ts:975 over
  `objectDdlSql` pgCatalog.ts:258 — `pg_get_viewdef(oid, true)` /
  `pg_get_functiondef(oid)`); `hasAdapterCapability(adapter, "objectDdl")`
  (adapters/types.ts); `commandOpenConsole` + `ConsolePanel.seedTab(name, buffer)`
  (consolePanel.ts:299); `ViewColumn`-independence from UX1-001 (console visible without
  an editor).
- Produces: `ensureTrailingSemicolon(ddl: string): string` pure helper (extract where
  console-related string helpers live, export for tests); the two new command ids —
  UX1-004's guide must document them.

---

## Discussion

### 2026-09-04 · planner · unic-smart
The brief suggested `when: viewItem == function`; the tree emits `contextValue: "routine"`
for functions AND procedures (schemaTree.ts:565) — entries keyed on `function` would never
render. Routines carry `meta: { connection, schema, objectName }` like views, so one
resolver serves both commands. DDL fetch is read-only (`pg_get_*def`), no destructive
gate needed. Saving as .sql is the console's existing save flow — nothing new. If the
executor finds `seedTab` requires the panel to exist first, follow the OC4O sequence
(commandOpenConsole → guard consolePanel non-null → seedTab → show), extension.ts:1955.

## Executor Report
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: (reported confirmed in worktree — npx vitest run src/extension.test.ts -t 'UX1-002' showed 7 failing tests for the new command wiring)
Verification Output: 139/139 in extension.test.ts after rebuild; full suite 3484|2 (baseline 3469|2, +7 net from UX1-002 — agent's spec verification command `src/adapters/__tests__/postgresAdapter.test.ts` doesn't exist; equivalent `src/adapters/__tests__/postgres.test.ts` 24/24 passed; typecheck + compile clean)
Status: PASS
Note: spec verification command path `postgresAdapter.test.ts` does not exist in repo; closest equivalent `src/adapters/__tests__/postgres.test.ts` (24 tests) passed clean. No regressions vs baseline.
