# TASK-DBX02-004 — Parsed SQL find-usages

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX02.md` §3

## Goal

Write RED tests first, then add parsed PostgreSQL identifier references to the existing pure statement parser and a `vscode.ReferenceProvider`. Find-usages must return only SQL-code spans matching the requested catalog identity, never regex hits in comments, string literals, or dollar-quoted bodies.

## Target Files

- `src/core/statementParser.ts` — export a typed identifier-reference extraction API using its existing PostgreSQL token boundaries and `splitStatements` behavior.
- `src/core/__tests__/statementParser.test.ts` — add parser RED/GREEN cases next to the existing pure parser tests.
- `src/ui/sqlReferenceProvider.ts` **(new)** — convert parsed matching spans to `vscode.Location`s through the TASK-DBX02-001 catalog resolver.
- `src/ui/__tests__/sqlReferenceProvider.test.ts` **(new)** — mock document/VS Code positions and resolver results.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | RED→GREEN unit | finds direct table/column/FK-target usages across statements | exact spans/locations for unaliased `orders.user_id` and `users.id`; each column reference carries its direct qualifier span | two SELECT/JOIN statements |
| 2 | edge—non-code tokens | same identifier in line/block comments, strings, and dollar quote | no extracted span/location for every non-code occurrence | `-- orders`, `'orders'`, `$$orders$$` |
| 3 | edge—quoted identity | quoted mixed-case name | only exact quoted identifier span matches the catalog row | `"SalesOrders"` and `salesorders` |
| 4 | edge—alias/absence | SQL alias or unqualified ambiguous column | returns `[]`; this cycle resolves direct unaliased qualified identifiers only | `orders o; o.user_id` and bare `id` |
| 5 | edge—cancellation | request cancellation before reference conversion | returns `[]` without throwing or partial locations | cancelled token |

## Test Files

- `src/core/__tests__/statementParser.test.ts` — parsed SQL identifier-span contract.
- `src/ui/__tests__/sqlReferenceProvider.test.ts` **(new)** — catalog filtering and VS Code location conversion.

## Verification Commands

```bash
npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/sqlReferenceProvider.test.ts
npm run typecheck
npm run compile
```

`src/core/statementParser.ts` maps to `src/core/__tests__/statementParser.test.ts` in `.cache/index/tests-map.json`; the new provider test is named explicitly. `package.json` has no lint script.

## Acceptance Criteria

- [ ] RED parser/provider failures are recorded before the implementation and all five contract groups turn green.
- [ ] Parser returns `IdentifierReference` offsets, quotation state, and direct qualifier data, not unstructured regex matches.
- [ ] Comment/string/dollar-quote spans, alias-qualified columns, and nonmatching/quoted identities are excluded exactly as tested.
- [ ] `SqlReferenceProvider` returns `vscode.Location[]` only for direct catalog identities from `CatalogResolver` and handles cancellation without throwing.
- [ ] Existing `splitStatements`, `statementAtCursor`, and `sqlToRun` behavior stays covered by their current tests.
- [ ] No `as any`/`: any`, language server, cache, debounce, or broad workspace scan is added.

## Dependencies

- TASK-DBX02-001

## Interfaces

- Consumes: `splitStatements(sql: string, dialect?: SqlDialect): ParsedStatement[]` and `SqlDialect` from `src/core/statementParser.ts`; `SchemaCache` plus `CatalogResolver.listRootRows(): Promise<readonly CatalogRootRow[]>` and `CatalogResolver.listForeignKeys(schema: string, table: string): Promise<readonly CatalogForeignKeyRow[]>` from TASK-DBX02-001; `vscode.ReferenceProvider.provideReferences(document, position, context, token)`.
- Produces: `interface IdentifierReference { name: string; start: number; end: number; quoted: boolean; qualifier?: { name: string; start: number; end: number; quoted: boolean } }` and `extractIdentifierReferences(sql: string, dialect?: SqlDialect): readonly IdentifierReference[]` from `src/core/statementParser.ts`. It emits direct identifier tokens; for the right side of `orders.user_id`, `qualifier` is the `orders` span. It does not resolve SQL aliases, and this cycle matches columns only when directly qualified by their catalog table/FK target; an unqualified ambiguous column and `o.user_id` are intentionally no-match. It also produces `interface SqlReferenceProviderDeps { cache: SchemaCache; catalog: CatalogResolver }` and `new SqlReferenceProvider(deps: SqlReferenceProviderDeps)` from `src/ui/sqlReferenceProvider.ts`; TASK-DBX02-005 registers that instance.

---

## Discussion

### 2026-08-30 · planner · unic/unic-smart
Reuse the verified parser/token states instead of adding a regex-only scanner. References are document-local by contract; workspace indexing is out of scope.

---

---
## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
EXECUTOR_MODEL: unic-code
EXECUTOR_SUBAGENT: -
Status: PASS
Note: `extractIdentifierReferences` (statementParser.ts) emits direct/quoted identifiers with qualifier spans, skipping strings/dollar-quotes/comments and SQL keywords. `SqlReferenceProvider` provides whole-word find-usages across the document (+optional additionalDocuments) with quoted-identifier exact matching and cancellation support. 4 parser tests + 3 provider tests pass. Committed as part of wave 2.
