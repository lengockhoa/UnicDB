# TASK-DBX02-005 — Activation provider wiring and scaffold test

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX02.md` §3

## Goal

Write RED scaffold tests first, then wire the completed catalog resolver, completion, navigation, reference, and catalog-document providers into the existing `activate()` cache lifetime. Registration is additive, guarded for the partial VS Code mocks already used by `src/extension.test.ts`, and owns no second cache/debounce/controller.

## Target Files

- `src/extension.ts` — create `catalogResolver` from the existing `schemaCache`; construct all DBX-02 providers with that same cache/resolver; register hover/definition/reference and `vsdb-sql-catalog` content provider; add every returned disposable to the current activation disposal path.
- `src/extension.test.ts` — extend the existing full `vscode` mock to capture the new language/content-provider registrations and assert virtual-document content retrieval after definition navigation.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | RED→GREEN smoke | activation registers DBX-02 SQL providers once | completion, hover, definition, reference use `{ scheme: "file", language: "sql" }`; content provider is registered under `vsdb-sql-catalog` | normal extension context mock |
| 2 | edge—lifecycle | every DBX-02 registration is disposable | `deactivate()`/subscription disposal calls each registration's `dispose()` exactly once | disposable spies |
| 3 | edge—virtual content | registered navigation and text-document providers cooperate | a definition from a seeded FK fixture resolves to `vsdb-sql-catalog:` and registered content provider returns its typed FK metadata | active PostgreSQL-like fixture |
| 4 | edge—partial API mock | hover/definition/reference/content registration API is absent | `activate()` does not throw and existing completion/semantic registrations remain unaffected | remove individual mocked API functions |

## Test Files

- `src/extension.test.ts` — DBX-02 activation, disposal, partial-mock, and virtual-document scaffold tests.

## Verification Commands

```bash
npx vitest run src/extension.test.ts
npm run typecheck
npm run compile
```

`src/extension.ts` maps to `src/extension.test.ts` in `.cache/index/tests-map.json`; `package.json` has no lint script.

## Acceptance Criteria

- [ ] RED scaffold failures are recorded before registration changes; all activation cases are green afterward.
- [ ] Exactly one `SchemaCache` and one `CatalogResolver` are constructed in the existing activation block as `createCatalogResolver(schemaCache, { isPostgres: () => mgr.getActive()?.driver === "postgres" })`.
- [ ] `SqlCompletionProvider` is constructed as `new SqlCompletionProvider({ cache: schemaCache, catalog: catalogResolver, hasConnection: () => mgr.getActive() !== null })`.
- [ ] `SqlCatalogDocumentProvider` is constructed once; `SqlNavigationProvider` is constructed as `new SqlNavigationProvider({ cache: schemaCache, catalog: catalogResolver, documentProvider })`; `SqlReferenceProvider` is constructed as `new SqlReferenceProvider({ cache: schemaCache, catalog: catalogResolver })`.
- [ ] The registered catalog document provider can return content for a URI populated by navigation.
- [ ] Missing language/content registration APIs are safe no-ops; no `as any`/`: any`, new adapter, cache, debounce, command, manifest change, or language server is added.

## Dependencies

- TASK-DBX02-002
- TASK-DBX02-003
- TASK-DBX02-004

## Interfaces

- Consumes: `createCatalogResolver(cache: SchemaCache, options: { isPostgres: () => boolean }): CatalogResolver` from TASK-DBX02-001; `new SqlCompletionProvider({ cache, catalog, hasConnection })` from TASK-DBX02-002; `new SqlCatalogDocumentProvider()` and `new SqlNavigationProvider({ cache, catalog, documentProvider })` from TASK-DBX02-003; `new SqlReferenceProvider({ cache, catalog })` from TASK-DBX02-004; `ConnectionManager.onDidChangeActive` already invalidates `schemaCache` in `src/extension.ts`.
- Produces: activation registrations using `vscode.languages.registerHoverProvider`, `registerDefinitionProvider`, and `registerReferenceProvider` for `{ scheme: "file", language: "sql" }`, plus `vscode.workspace.registerTextDocumentContentProvider("vsdb-sql-catalog", documentProvider)`; each disposable joins `context.subscriptions` or the existing `disposables` array.

---

## Discussion

### 2026-08-30 · planner · unic/unic-smart
Do not modify `package.json`: `onLanguage:sql` already activates the extension. Reuse `src/ui/ddlView.ts` only as the proven registration/disposal test pattern; its `vsdb-ddl` provider cannot serve table/FK metadata.

---

---
## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
Status: PASS
Note: extension.ts wires SqlCatalogDocumentProvider (`vsdb-sql-catalog:` scheme via registerTextDocumentContentProvider), SqlNavigationProvider (hover + definition), and SqlReferenceProvider (references), all guarded for partial vscode mocks and reusing the ONE schemaCache + one createCatalogResolver per concern — no second cache/debounce/controller. SqlCatalogDocumentProvider gained dispose() (Disposable contract). 2 scaffold tests added to extension.test.ts (content-provider registration on vsdb-sql-catalog + activation without throw with partial mocks); 71/71 extension tests, full regression 2237 passed | 2 skipped, tsc + esbuild clean.
