# TASK-AF-002 — Schema tree catalog nodes + real DDL viewer

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AF.md` §7 (Approach §3)

## Goal

Extend the schema tree with per-table `indexes` / `constraints` / `triggers` categories plus schema-level `sequences` and row counts in table descriptions, and add "Open DDL" context-menu actions opening real DDL for table/view/routine/trigger in a read-only `vsdb-ddl:` virtual document (replacing the placeholder view-DDL header).

## Target Files

- `src/ui/schemaTree.ts` — new CategoryKinds (`indexes` | `constraints` | `triggers` | `sequences`), lazy children via `adapter.catalog` when present, row-count description on table nodes, filter compatibility, "Open DDL" context menu entries.
- `src/ui/ddlView.ts` — NEW: `TextDocumentContentProvider` on scheme `vsdb-ddl:` + per-URI content cache + `openDdl(node)` command body + refresh command.
- `src/extension.ts` — register `vsdb.openDdl` + `vsdb.refreshDdl` commands, wire provider registration (ONLY wave-2 owner of this file).
- `src/ui/__tests__/schemaTreeCatalog.test.ts` — NEW.
- `src/ui/__tests__/ddlView.test.ts` — NEW.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | table node gets indexes/constraints/triggers children when catalog present | children include 3 category nodes; expanding indexes yields IndexInfo names via injected fake catalog | fake adapter with `catalog` stub |
| 2 | unit | table node description shows row count | description contains formatted count (`formatRows` existing helper) | `rowCount → 1234` |
| 3 | edge | catalog undefined → new categories absent, no throw | mysql-style adapter renders exactly as today | adapter without catalog |
| 4 | edge | rowCount rejects → count omitted, tree still renders | description falls back to current text; error swallowed to console | catalog.rowCount rejects |
| 5 | edge | empty schema → sequences category absent | no empty category nodes | `listSequences → []` |
| 6 | unit | filter matches new node kinds | filter "idx_a" reveals index node; existing filter tests semantics preserved | tree with catalog nodes |
| 7 | unit | openDdl(view) buffer contains pg_get_viewdef text | `provideTextDocumentContent` returns DDL string from catalog.objectDdl | fake catalog returns `CREATE VIEW ...` |
| 8 | edge | openDdl on object whose catalog fails → error notice document, no throw | content contains friendly error; no exception escapes | catalog.objectDdl rejects |
| 9 | edge | driver without catalog → fallback document explaining Postgres-only | content names the limitation | adapter without catalog |
| 10 | regression | existing schemaTree suite stays green | current `src/ui/__tests__/schemaTree*.test.ts` pass untouched semantics | existing tests |

## Test Files

- `src/ui/__tests__/schemaTreeCatalog.test.ts` — tests 1–6, 10.
- `src/ui/__tests__/ddlView.test.ts` — tests 7–9.

## Verification Commands

```bash
npx vitest run src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/ddlView.test.ts
npm run typecheck
npm test
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first, GREEN after).
- [ ] mysql/mssql behavior unchanged when `catalog` absent (no new node kinds, no errors).
- [ ] "Open DDL" on a view shows real `CREATE VIEW` text from `pg_get_viewdef` (replaces placeholder header path).
- [ ] `vsdb-ddl:` documents are read-only (no edit affordance) and refreshable via `vsdb.refreshDdl`.
- [ ] Full `npm test` green; `npm run typecheck` exit 0; `npm run compile` clean.

## Dependencies

- TASK-AF-001 must complete first (needs `CatalogApi` + info types + postgres catalog implementation).

## Interfaces

- Consumes: `adapter.catalog` (`CatalogApi` exactly as produced by TASK-AF-001), existing `VsdbNode`/`CategoryKind` in `src/ui/schemaTree.ts`, `formatRows(n: number): string`.
- Produces: command IDs `vsdb.openDdl` (arg: `VsdbNode`) and `vsdb.refreshDdl` (no arg) — consumed by package.json contribution points if declared, and by later roadmap cycles (AI rename/diff open-DDL affordances).

---

## Discussion

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
