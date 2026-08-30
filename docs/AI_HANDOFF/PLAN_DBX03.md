# PLAN_DBX03 — Schema & Data Compare

Cycle: DBX-03   Date: 2026-08-30   Base: main @ f0581fe (v1.16.0)

## §1 Intent

User instruction (2026-08-30, verbatim intent): "push release lên trước rồi chạy cycle tiếp theo" — v1.16.0 is published; the next cycle per user's earlier choice is DBX-03 Schema & Data Compare. Compare PostgreSQL schemas/tables and same-shape table data; inspect a generated, directional sync plan before any execution.

## §2 Scope

**In:**
- Schema diff between two schema-qualified tables on the SAME active PostgreSQL connection (source vs target): columns added/dropped/changed (type, nullability, default), PK changes.
- Data diff for same-shape tables when a usable key exists (PK or unique NOT NULL column set): rows only-in-source / only-in-target / changed, deterministic ordering.
- Directional sync plan: generated SQL (ALTER TABLE ADD/DROP/ALTER COLUMN, INSERT/UPDATE/DELETE for data) — preview-only; execution is the user copying statements into the Console (existing dangerous-confirm gate applies there).
- Compare panel webview (CSP-clean) with schema-diff section + data-diff section + sync-plan section.

**Out:**
- No automatic sync execution from the panel.
- No cross-connection compare (same connection only).
- No heterogeneous dialect compare (PostgreSQL only; other drivers → graceful refusal message).
- No view/routine/trigger/index diff (tables only this cycle).

## §3 Approach

Pure modules in `src/core/compare/` (no vscode import):
1. `schemaDiff.ts` — `diffSchema(source, target): SchemaDiffResult` over `TableShape {columns: ColumnInfo[], primaryKeys: string[]}`. Deterministic output ordering (column order of source, then alphabetical for appended). Classifies: identical / columns added / dropped / type-changed / nullability-changed / default-changed / pk-changed; `compatible` flag = same column set with identical types (data diff precondition).
2. `dataDiff.ts` — `diffData(keys, sourceRows, targetRows, columns): DataDiffResult` — key-tuple maps, rows-only-in-A / only-in-B / changed (per-column cell diffs). Requires `keys` non-empty; empty keys → `DataDiffResult {skipped: "no-key"}`. Rows arrive as ordered arrays from keyset queries; the HOST fetches rows (pure module never queries).
3. `syncPlan.ts` — `buildSyncPlan(shapeDiff, dataDiff, opts): SyncPlan` — ordered, grouped statements: schema DDL first (add columns → alter type/nullability/default → drop columns), then data (INSERT missing-in-target → UPDATE changed → DELETE extra-in-target), each with a human `summary` line. `direction`: "source→target" only. `executable` flag false when shape incompatible or no key (plan carries reason, statements empty for that group).
4. `compareService.ts` (host, src/ui/) — fetches shapes via `adapter.listTableDetail`, rows via keyset-ordered SELECTs (`ORDER BY key`; row cap constant `COMPARE_ROW_LIMIT=10000`), calls pure modules, hands `CompareResult` to panel.
5. `comparePanel.ts` (host) + `webview/comparePanelMain.ts` — CSP-clean rendering (textContent only, no innerHTML/eval/inline script; `acquireVsCodeApi().postMessage` single channel `vsdb-compare`).

**Auto-mapping note (from DBX-01):** mapping list is authoritative; same principle here — source shape is authoritative for ordering; target-only columns surface as "dropped in target direction".

**No second cache/debounce:** compare is one-shot per invocation, reuses the adapter in hand; no SchemaCache involvement, no timers (scaffold-guarded like DBX-01).

## §4 Test Plan (TDD — RED→GREEN per task)

Principles: parameterized SQL everywhere ($N or pg-pool bound params via listTableDetail); no literal interpolation of user data; never truncate silently (report counts + capped row fetch with explicit `truncated` flag).

| # | Layer | Test | Expected |
|---|-------|------|----------|
| T1 | schemaDiff | identical shapes → `identical: true`, zero entries | input == input |
| T2 | schemaDiff | column added in source → entry kind `added` | deterministic order |
| T3 | schemaDiff | type change int→text → `changed` entry | per-column |
| T4 | schemaDiff | nullability/default/pk changes classified separately | one entry per kind |
| T5 | schemaDiff (edge) | dropped column in target → `dropped` | direction named |
| T6 | schemaDiff (edge) | empty columns (both) → identical, no throw | `[]` |
| T7 | dataDiff | only-in-source rows → `addedRows` ordered by key | key order |
| T8 | dataDiff | changed row → per-cell diffs listed | column-named |
| T9 | dataDiff (edge) | no key → `skipped: "no-key"`, no diff computed | guard |
| T10 | dataDiff (edge) | identical datasets → all groups empty | `[]` |
| T11 | syncPlan | incompatible shape → data group empty + `executable: false` + reason | safety |
| T12 | syncPlan | full happy path → ordered DDL then INSERT/UPDATE/DELETE groups with summaries | group order |
| T13 | syncPlan (edge) | only-data diff → zero DDL statements | filter |
| T14 | syncPlan (safety) | generated SQL carries $N placeholders, zero literal values from rows | regex scan |
| T15 | compareService | non-postgres driver → refusal result, zero adapter calls beyond driver check | guard |
| T16 | compareService | missing table on target → actionable error result | `table not found` |
| T17 | compareService | > COMPARE_ROW_LIMIT rows → `truncated: true`, diff computed on fetched prefix | boundary |
| T18 | panel wiring | `vsdb.compareTables` registered; activation partial-mock safe | smoke |
| T19 | scaffold | manifest + no-second-cache/no-timer grep guard on compare modules | grep |

## §5 Verification Commands

```bash
npm run typecheck
npx vitest run src/core/compare src/ui/__tests__/comparePanel.test.ts src/__tests__/dbx03Scaffold.test.ts
npx vitest run   # wave boundary net
npm run compile
```

## §6 Acceptance Criteria

- [ ] All 4 tasks GREEN with fresh PASS evidence in task files.
- [ ] Full suite ≥ 2301 passing (v1.16.0 baseline) + new tests, 0 failures.
- [ ] typecheck + esbuild clean.
- [ ] No automatic execution path from the compare panel (preview only).
- [ ] PostgreSQL-only gate with graceful refusal text for other drivers.

## §7 Task Split

| Task | Slice | Depends |
|------|-------|---------|
| TASK-DBX03-001 | schemaDiff pure module + tests | — |
| TASK-DBX03-002 | dataDiff pure module + tests | — |
| TASK-DBX03-003 | syncPlan pure module + tests | 001, 002 |
| TASK-DBX03-004 | compareService + comparePanel + webview main + extension wiring + scaffold tests | 003 |

## Planner Self-Audit

- Interfaces below (per task file) are real signatures consumed by later tasks — no placeholders.
- Deterministic ordering asserted in tests (T2/T7) per roadmap risk "deterministic ordering".
- Absent-PK risk → T9 (`skipped: "no-key"`); incompatible-shape risk → T11 (`executable: false`); plan-preview safety → T14 (no literal row values in SQL) + §2 Out (no auto-exec).
- ≥2 edge kinds per slice (empty/boundary, guard, safety) present in the tables.
