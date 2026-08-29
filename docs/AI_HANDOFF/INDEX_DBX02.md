# INDEX_DBX02

Cycle DBX-02 — **SQL INTELLIGENCE NAVIGATION**: PostgreSQL catalog completion, hover/definition, and parsed find-usages. Plan: `PLAN_DBX02.md`.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-DBX02-001 | Cached catalog rows and vscode-free resolver | ready | none | independent unic-smart reviewer |
| TASK-DBX02-002 | Catalog and FK completion | ready | TASK-DBX02-001 | independent unic-smart reviewer |
| TASK-DBX02-003 | Catalog hover and virtual definition | ready | TASK-DBX02-001 | independent unic-smart reviewer |
| TASK-DBX02-004 | Parsed SQL find-usages | ready | TASK-DBX02-001 | independent unic-smart reviewer |
| TASK-DBX02-005 | Activation provider wiring and scaffold test | ready | TASK-DBX02-002, TASK-DBX02-003, TASK-DBX02-004 | independent unic-smart reviewer |

## Graph

`TASK-DBX02-001 → TASK-DBX02-002 → TASK-DBX02-005`  
`TASK-DBX02-001 → TASK-DBX02-003 → TASK-DBX02-005`  
`TASK-DBX02-001 → TASK-DBX02-004 → TASK-DBX02-005`

## Waves

- **Wave 1:** TASK-DBX02-001.
- **Wave 2:** TASK-DBX02-002, TASK-DBX02-003, TASK-DBX02-004 in parallel; their target files are disjoint.
- **Wave 3:** TASK-DBX02-005 after all three providers expose their constructors/interfaces.


## File Locks

- **TASK-DBX02-001:** `src/ui/schemaCache.ts`, `src/ui/sqlCatalog.ts` (new), `src/ui/__tests__/schemaCache.test.ts`, `src/ui/__tests__/sqlCatalog.test.ts` (new).
- **TASK-DBX02-002:** `src/ui/sqlCompletionProvider.ts`, `src/ui/__tests__/sqlCompletionProvider.test.ts`.
- **TASK-DBX02-003:** `src/ui/sqlNavigationProvider.ts` (new), `src/ui/sqlCatalogDocumentProvider.ts` (new), `src/ui/__tests__/sqlNavigationProvider.test.ts` (new).
- **TASK-DBX02-004:** `src/core/statementParser.ts`, `src/core/__tests__/statementParser.test.ts`, `src/ui/sqlReferenceProvider.ts` (new), `src/ui/__tests__/sqlReferenceProvider.test.ts` (new).
- **TASK-DBX02-005:** `src/extension.ts`, `src/extension.test.ts`.

No task in the same wave shares a lock. `src/extension.ts` remains untouched until Wave 3; `SchemaCache` remains untouched after Wave 1.
