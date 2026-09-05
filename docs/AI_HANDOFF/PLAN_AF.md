# PLAN_AF — Cycle AF: DataGrip Parity Roadmap, Wave 1 (v1.12.0)

## §1 Intent

User (verbatim): "Nghiên cứu và lên kế hoạch cho tôi tiếp bộ này làm sao cho nó tốt nhất. Cứ lên những cycle và tự ra quyết định làm sao mà cho nó giống với bộ database là được. Cứ nghiên cứu thêm phần datagrip của JetBrain. Những tính năng hay của nó cứ lên kế hoạch hết. Cứ nghĩ ra cái gì thì cứ đưa hết vào cycle để cho thằng Oh My Pi nó tự làm."

Answers from the one asking window (treat as user's own words downstream):

1. AE handling: "Tạo ra Cycle mới, không liên quan tới mấy cycle đang chạy nữa. Cứ để tiếp từ từ thằng đệ nó hoàn thành sau" → Cycle AF is INDEPENDENT of in-flight cycle AE. AF must not modify any AE artifact (`PLAN_AE.md`, `src/ai/omp/*`) and must not regress AE's committed work (full suite green includes it).
2. Scope shape: "Roadmap nhiều cycle (Recommended)" → this cycle is wave 1 of a multi-cycle DataGrip-parity roadmap. The full map lives in `docs/AI_HANDOFF/ROADMAP.md` (durable; survives per-cycle plan archiving).
3. Priority: ALL four groups selected — Explorer+DDL+Admin, Query console, Data grid+Import/Export, Diff+Refactor+Diagram+SSH. Roadmap order respects dependencies, not preference order.
4. Drivers: "PostgreSQL-first (Recommended)" → new features land Postgres-first; MySQL/MSSQL parity is a dedicated late roadmap cycle (AK).

**Success definition**: a UnicDB user on PostgreSQL can (a) browse indexes/constraints/triggers/sequences per table + see row counts in the schema tree, (b) open REAL DDL for tables/views/routines/triggers in a read-only editor (no more placeholder view DDL), (c) work in a multi-tab SQL console with per-statement/selection run, query history recall, EXPLAIN plan pane, and one-click SQL formatting — all verified by TDD tests + full suite green + typecheck 0.

## §2 Scope

**In scope (4 tasks, PostgreSQL-first):**

1. **Catalog introspection expansion** — pure SQL/mapper module `pgCatalog.ts` + adapter capability: indexes, constraints (PK/FK/unique/check), triggers, sequences, row counts, real view/routine/trigger DDL (`pg_get_viewdef`, `pg_get_functiondef`, `pg_get_triggerdef`).
2. **Schema tree expansion + DDL viewer** — tree gets `indexes`/`constraints`/`triggers` categories under each table + `sequences` schema-level category + row counts in node descriptions; "Open DDL" context-menu action on table/view/routine/trigger nodes opening a read-only `UnicDB-ddl:` virtual document.
3. **SQL formatter (pure core)** — `formatSql(sql, opts)` with keyword case, clause line breaks, JOIN/ON and subquery indentation; idempotent; no identifier re-quoting (out of scope).
4. **SQL Console v2** — multiple named tabs, per-statement run (statementParser), selection-only run, query history (up-arrow recall + persisted list capped 200), EXPLAIN / EXPLAIN ANALYZE plan pane (ANALYZE behind the existing destructive-confirm gate), Format button consuming `formatSql`.

**Out of scope (mapped in ROADMAP.md):** import wizard, grid row add/delete, pagination UI, form/value editors, users/grants/sessions UI, schema/data diff, rename refactor, ER diagrams, SSH tunnel, query parameters, quick doc/go-to-def, MySQL/MSSQL parity, connection groups/colors/read-only flag, full-text data search, result-set compare, copy-across-connections.

**Constraint (hard):** same-wave tasks must not modify the same file. Two tasks needing the same file get a dependency edge instead. `extension.ts` is owned by AF-002 in wave 2 and AF-004 in wave 3 (different waves — legal).

## §3 Approach

- **Catalog as an optional adapter capability**, not a required interface change: `DbAdapter` gains an OPTIONAL `catalog?: CatalogApi` field. Postgres implements it; mysql/mssql stay `undefined` and the UI degrades gracefully (categories hidden, DDL viewer falls back to existing generation or a notice). Rationale: no breakage of the other two drivers, mirrors the existing `listTableDetail` gating pattern. Alternative rejected: mandatory methods with `NotImplementedError` throws — that is exactly the mssql wart we are avoiding. Canonical signature (full detail pinned in TASK-AF-001 §Interfaces):
  `CatalogApi = { listIndexes(schema, table): Promise<IndexInfo[]>; listConstraints(schema, table): Promise<TableConstraintInfo[]>; listTriggers(schema, table): Promise<TriggerInfo[]>; listSequences(schema): Promise<SequenceInfo[]>; rowCount(schema, table): Promise<number>; objectDdl(kind: "view"|"routine"|"trigger", name, schema?): Promise<string> }` — on a nonexistent object `objectDdl` rejects with a structured error (never an unhandled throw); `rowCount` rejects on missing table.
- **New pure module, not sprawl in pgIntrospect**: `src/core/ddl/pgCatalog.ts` holds SQL templates + row→info mappers following the existing `pgIntrospect.ts` convention (exported `*_SQL` template functions + typed rows). Keeps AF-001 file-disjoint from anything else and unit-testable without vscode.
- **DDL viewer as a `TextDocumentContentProvider`** on a `UnicDB-ddl:` URI scheme: native editor, SQL language id, read-only, refresh command invalidates the per-URI cache. Alternative rejected: another webview — duplicate styling/scroll/copy work for zero gain.
- **Console v2 extends the existing single ConsolePanel** host + webview pair rather than a new panel: tab state lives host-side (survives panel reload), webview renders tabs. Per-statement run reuses `splitStatements`; selection run is a webview message carrying the selection text. History persists in Memento (globalState) capped at 200 entries. EXPLAIN reuses the query runner; EXPLAIN ANALYZE routes through the existing destructive-statement confirm so ANALYZE can never silently execute.
- **Formatter is host-side**: the webview sends a `format` message; the host formats via `formatSql` and returns text. Avoids bundling-path risk in the webview build and keeps the pure module the single source of truth.
- **Versioning**: `v1.10.0 → v1.12.0` (v1.11.0 is reserved by deferred cycle AE; whichever cycle releases first takes the next free minor and the other rebases its version references).

## §4 Test Plan (TDD)

| Area | Happy path | Edge case 1 | Edge case 2 | Regression |
|---|---|---|---|---|
| pgCatalog mappers | index/constraint/trigger/sequence rows map to typed infos | empty result set → `[]`, no throw | malformed row (null fields) → row skipped, no crash | — |
| pgCatalog SQL | view/routine/trigger DDL SQL uses `pg_get_*` + quoted identifiers | schema/table containing `"` stays quoted (injection-safe) | empty/zero-length identifier → clean structured error at mapper/SQL-build level, never emitted raw into SQL | — |
| Postgres adapter catalog | `adapter.catalog.listIndexes(...)` runs catalog SQL via pool | adapter without catalog (mysql/mssql) → `catalog === undefined` | `objectDdl` on a nonexistent object → rejects with structured "not found" error (no unhandled throw, no empty-SQL round-trip) | — |
| sqlFormat | SELECT formatted: keywords cased, clauses on own lines, JOIN/ON indented | `""`/whitespace-only input → `""` | stray unbalanced paren → no throw, best-effort output | `format(format(x)) === format(x)` idempotence |
| Schema tree catalog nodes | table node children include indexes/constraints/triggers categories; description shows formatted row count | `catalog === undefined` → new categories absent (mysql) | empty schema (no sequences) → sequence category absent | existing tree behavior tests stay green |
| DDL viewer | `openDdl` on view/routine returns real `pg_get_*` text in provider buffer | unknown/failed object → error notice, no throw into caller | driver without catalog → fallback notice document | — |
| Console v2 | open 2nd/3rd tab, run per-statement, switch tabs preserves buffers | close last tab → fresh empty tab, no crash | history capped at 200 (201st evicts oldest) | EXPLAIN ANALYZE always requires confirm gate |

## §5 Verification

Per-task (executor runs inside each task file; targeted first):

```bash
npx vitest run src/core/ddl/__tests__/pgCatalog.test.ts src/adapters/__tests__/postgresCatalog.test.ts
npx vitest run src/core/__tests__/sqlFormat.test.ts
npx vitest run src/ui/__tests__/schemaTreeCatalog.test.ts src/ui/__tests__/ddlView.test.ts
npx vitest run src/ui/__tests__/consoleTabs.test.ts tests/consolePanelWebview.test.ts
npm run typecheck
```

Wave/cycle boundaries (mandatory full net):

```bash
npm test          # full suite — must be green at every wave boundary
npm run compile   # esbuild bundles build clean
```

Manual smoke (review phase): connect to Postgres → tree shows Indexes/Constraints/Triggers under a table + row counts → Open DDL on a view shows `CREATE VIEW ...` from `pg_get_viewdef` → console: 2 tabs, run one statement of 3, up-arrow recalls history, Explain shows a plan, Format reformats.

## §6 Acceptance

- [x] All 4 tasks `approved` or `approved_minor` with executor self-report (tool/model/subagent + RED output) per Quality Gate.
- [x] Full `npm test` green at every wave boundary; `npm run typecheck` exit 0; `npm run compile` clean.
- [x] Postgres-only capability: mysql/mssql suites untouched and green; new UI degrades with catalog absent (no thrown errors).
- [x] No AE regression: `src/ai/omp/*` files untouched by AF diffs; AE tests green in full suite.
- [x] Privacy invariant intact: DDL/catalog reads expose schema metadata only; no row data outside existing approved paths.
- [x] Cycle-AA tree/grid/console regression pins stay green.
- [x] User-facing: CHANGELOG updated; version bumped to the next free minor at release step (`1.12.0` unless deferred cycle AE released first and claimed it — then take the next free minor; only ONE cycle rebases, the releasing cycle wins).
- [x] ROADMAP.md exists and maps every DataGrip-parity gap to exactly one future cycle (no orphans).

## §7 Task split

| Task | Slice | Owns (files) | Wave | Depends on |
|---|---|---|---|---|
| TASK-AF-001 | pgCatalog module + adapter catalog capability | src/core/ddl/pgCatalog.ts, src/adapters/types.ts, src/adapters/postgres.ts + tests src/core/ddl/__tests__/pgCatalog.test.ts (NEW) + src/adapters/__tests__/postgresCatalog.test.ts (NEW) | 1 | none |
| TASK-AF-002 | Schema tree catalog nodes + DDL viewer | src/ui/schemaTree.ts, src/ui/ddlView.ts, src/extension.ts + tests src/ui/__tests__/schemaTreeCatalog.test.ts (NEW) + src/ui/__tests__/ddlView.test.ts (NEW) | 2 | AF-001 |
| TASK-AF-003 | SQL formatter pure module | src/core/sqlFormat.ts + 1 test file | 1 | none |
| TASK-AF-004 | Console v2 (tabs, per-statement, history, EXPLAIN, Format) | src/ui/consolePanel.ts, webview/consolePanelMain.ts, webview/styles.css, src/extension.ts + tests src/ui/__tests__/consoleTabs.test.ts (NEW) + tests/consolePanelWebview.test.ts (EXTEND) | 3 | AF-002 (frees extension.ts), AF-003 (consumes formatSql) |

Waves: W1 = AF-001 ∥ AF-003 (disjoint); W2 = AF-002; W3 = AF-004.

## Planner Report

PLANNER_MODEL: unic-smart

PLAN_REVIEW: Approved by unic-smart (Round 2, 2026-08-28; Round 1 Issues Found → revised once → Round 2 Approved)

DEVIATION NOTE: the contracted `handoff-planner` subagent was invoked twice (step-contract) and both invocations died on gateway errors (HTTP 200 empty body; socket closed) after 29 tool calls each with zero files written. Per tier contract the plan was then authored inline by the session's strong tier (unic-smart), which is the same model class the planner agent binds. Real export signatures for Interfaces were read from source (pgIntrospect.ts, statementParser.ts, schemaTree.ts, adapters/types.ts) before writing.

## Plan Review Log

### Round 1 — Issues Found (reviewer model: unic-smart)
- blocking: §4 Test Plan — two areas have only 1 edge case each (edge case 2 is "—"): the "pgCatalog SQL" row and the "Postgres adapter catalog" row. The gate requires happy + >=2 edge cases of different kinds per area. Fix by adding a second edge to each (e.g. pgCatalog SQL: empty/zero-length schema+table identifier still yields valid quoted SQL; adapter catalog: getDdl on a nonexistent object returns null/empty instead of throwing), and carry both into the derived task files.
- minor: §5 references `tests/consolePanelWebview.test.ts` but AF-004's owns-list in §7 says "+ 2 test files" unnamed — name both test files explicitly in §7 (`src/ui/__tests__/consoleTabs.test.ts` + `tests/consolePanelWebview.test.ts`) so Phase 2 cannot misplace them or invent a third path.
- minor: §3 never sketches the `PgCatalogApi` shape (method list is only implied by the §4 test rows). AF-002/AF-004 consume it; add the interface method list to §3 or mandate that TASK-AF-001's task file carries the real signature, per the Task Gate "Interfaces — real signatures, no placeholders" rule.
- minor: §3 versioning contingency ("whichever cycle releases first takes the next free minor and the other rebases") is in tension with §6's pinned "version 1.12.0 in package.json at release step" — state which number wins if AE releases first, or change the §6 item to "next free minor (1.12.0 unless AE already claimed it)".

### Round 2 — Approved (reviewer model: unic-smart)
- no blocking findings. Round-1 blocking fixed: §4 "pgCatalog SQL" and "Postgres adapter catalog" rows now carry ≥2 edge cases of different kinds each. Round-1 minors fixed: §7 names AF-001/AF-004 test-file paths; §3 carries the CatalogApi sketch incl. objectDdl/rowCount error behavior; §6 versioning contingency aligned with §3 (releasing cycle wins, next free minor).
- minor (non-blocking): §7 AF-002 row still says "+ 2 test files" unnamed — §5 pins them (`src/ui/__tests__/schemaTreeCatalog.test.ts`, `src/ui/__tests__/ddlView.test.ts`); name both in TASK-AF-002's Test Files when Phase 2 creates it.
