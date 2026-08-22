# TASK-302 — schemaTree: row-count badges + filter engine

Cycle 2026-08-22-B · P0 · Size M · Deps: TASK-301
(Rev 2 — áp PlanReviewer Round 1: null→schema-fallback thống nhất, root luôn giữ, rowCountCache map riêng, locale 'en')

## Goal

Hai tính năng trong `src/ui/schemaTree.ts`:

1. **Row-count badges**: table nodes hiển thị description = row count thật (lazy async qua `adapter.estimateTableRows`), format compact deterministic. Fetch fire-and-forget sau khi category children render; badge update từng table khi xong; không block render.
2. **Filter engine**: `setFilter(text)` + lọc node theo label (case-insensitive substring); ancestors của match giữ + Expanded; empty match → node "No matches for '…'".

## Action

1. Row counts:
   - Table node khởi tạo giữ `description: t.schema` (fallback hiện tại).
   - Sau khi `getCategoryChildren` có `children` (tables): với mỗi table node, fire `estimateTableRows` (qua `getAdapterFor`), `.then(count => { if (count === null) return; node.description = formatRows(count); this._onDidChangeTreeData.fire(node); }).catch(() => {})`.
   - **Cache riêng** `private rowCountCache = new Map<string, CacheEntry<number>>()` (map `cache` hiện tại typed `CacheEntry<VsdbNode[]>` — không tái dùng). Key `rowcount|${conn.id}|${schema}|${table}`, TTL = CACHE_TTL_MS. Cache hit → set description sync trước khi return children.
   - In-flight guard `rowCountFetching: Set<string>` chống double-fetch khi node re-render.
   - `formatRows(n)`: `Intl.NumberFormat('en', {notation:'compact', maximumFractionDigits:1}).format(n)` — **pin 'en'** cho deterministic; export để test.
   - `null` (unknown/lỗi) → **giữ description = schema name** (fallback), KHÔNG hiển thị "…" — thống nhất với PLAN §3 rev 2.
   - `refresh()` xóa cả `cache` + `rowCountCache` + `rowCountFetching`.
2. Filter:
   - `private filterText = ''`; `setFilter(text)` → store + `_onDidChangeTreeData.fire(undefined)`; `getFilter(): string`.
   - Khi filter non-empty:
     - **Root: connections LUÔN giữ** (ancestor container — filter áp cho object names, không connection names).
     - Schema nodes: luôn giữ (children cần query mới biết match). Nếu schema name match → cũng giữ (hiển nhiên).
     - `getCategoryChildren`: query + cache như thường với list **UNFILTERED**; **lọc OUTPUT** theo label trước khi return. Badge `node.description = String(children.length)` tính từ list **unfiltered** (đưa unfiltered vào cache.set; chỉ filter array trả về) — tránh stale badge sau clear filter.
     - Table/view/routine/column: giữ nếu label match (case-insensitive substring).
     - Ancestors (connection/schema/category) của match → `CollapsibleState.Expanded` khi filter active.
     - Empty match ở category trở xuống → single node `{label: "No matches for '<q>'", contextValue: 'empty-add', collapsible: None}`.
   - Filter empty → hành vi y như hiện tại (không đổi gì).

## Interfaces

- Consumes: `DbAdapter.estimateTableRows` (TASK-301).
- Produces: `SchemaTreeProvider.setFilter(text: string): void`, `getFilter(): string`, `export function formatRows(n: number): string` — TASK-303 gọi.

## Test Cases

| Loại | Test | Expected |
|------|------|----------|
| happy | formatRows(176) | '176' |
| happy | formatRows(1234567) | '1.2M' (locale pinned) |
| happy | getCategoryChildren tables, mock estimateTableRows=176 → sau microtask table node description '176', label giữ nguyên | pass |
| happy | setFilter('po_log'), tables gồm api_po_log + users → chỉ api_po_log được trả về từ category (ancestors kept + expanded) | pass |
| edge | estimateTableRows resolves null → description giữ 'qas' (schema fallback), không crash | pass |
| edge | filter 'ZZZ' → "No matches for 'ZZZ'" node | pass |
| edge | setFilter('') xóa → full list trả về | pass |
| edge | filter 'PO_LOG' uppercase match api_po_log | pass |
| edge | root connections luôn giữ khi filter active (không bị drop theo tên) | pass |
| regression | category badge vẫn = tổng objects unfiltered khi filter active lọc bớt output | pass |

## Test Files

- `src/ui/__tests__/schemaTree.test.ts` (append; mock ConnectionManager/adapter theo pattern hiện tại)

## Verification Commands

```bash
npm run typecheck
npx vitest run src/ui/__tests__/schemaTree.test.ts
```

## Acceptance Criteria

- [ ] Table nodes hiện row-count badge compact (locale en), lazy, không block render
- [ ] reltuples null → schema description fallback, không crash
- [ ] Root luôn giữ khi filter; filter mọi cấp object, case-insensitive, ancestors expanded, no-match node
- [ ] Badge category tính từ unfiltered list
- [ ] RED→GREEN evidence

## Executor Report


EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: -
SUMMARY: Added row-count badges (lazy fetch via DbAdapter.estimateTableRows, formatRows locale 'en', separate rowCountCache map + in-flight guard) and filter engine (setFilter/getFilter, case-insensitive substring, root kept, schemas/categories Expanded when active, badge from unfiltered list, no-match node) to SchemaTreeProvider. 10 new tests added; all 33 schemaTree tests + 218 total project tests pass; typecheck clean.
TEST_PLAN_FOLLOWED: task §Test Cases (10 cases)
FILES_CHANGED:
  - src/ui/schemaTree.ts: rowCountCache Map<string, CacheEntry<number>> + rowCountFetching Set, filterText/setFilter/getFilter/matchesFilter, fetchRowCount fire-and-forget, formatRows export, getRoot keeps connections always, getSchemaNodesForConnection + getCategoriesForSchema Expanded when filter active, getCategoryChildren caches unfiltered + filters output + emits no-match node, getColumnChildren filters output, refresh/dispose clear rowCountCache + rowCountFetching
  - src/ui/__tests__/schemaTree.test.ts: import formatRows; makeFakeAdapter/estimateTableRows mock; 10 new tests in "SchemaTreeProvider — TASK-302 row-count badges + filter engine"
TESTS_ADDED:
  - src/ui/__tests__/schemaTree.test.ts: formatRows(176) === '176' (happy)
  - src/ui/__tests__/schemaTree.test.ts: formatRows(1234567) === '1.2M' locale pinned 'en' (happy)
  - src/ui/__tests__/schemaTree.test.ts: getCategoryChildren tables → sau microtask table node description = '176', label giữ nguyên (happy)
  - src/ui/__tests__/schemaTree.test.ts: setFilter('po_log') tables gồm api_po_log + users → chỉ api_po_log được trả về (happy, ancestors expanded)
  - src/ui/__tests__/schemaTree.test.ts: estimateTableRows resolves null → description giữ schema fallback 'qas' (edge)
  - src/ui/__tests__/schemaTree.test.ts: filter 'ZZZ' → 'No matches for "ZZZ"' node (edge)
  - src/ui/__tests__/schemaTree.test.ts: setFilter('') xóa filter → full list trả về (edge)
  - src/ui/__tests__/schemaTree.test.ts: filter 'PO_LOG' uppercase match api_po_log (edge, case-insensitive)
  - src/ui/__tests__/schemaTree.test.ts: root connections luôn giữ khi filter active (không bị drop theo tên) (edge)
  - src/ui/__tests__/schemaTree.test.ts: category badge vẫn = tổng objects unfiltered khi filter active lọc bớt output (regression)
VERIFICATION:
  command: npm run typecheck && npx vitest run src/ui/__tests__/schemaTree.test.ts && npx vitest run
  result: typecheck 0 errors / vitest schemaTree 33 pass / vitest full 218 pass
  output_excerpt: |
    > vsdb@1.3.0 typecheck
    > tsc --noEmit
    (no output)

     ✓ src/ui/__tests__/schemaTree.test.ts  (33 tests) 20ms
     Test Files  1 passed (1)
          Tests  33 passed (33)

     Test Files  19 passed (19)
          Tests  218 passed (218)

RED_OUTPUT (before implementation):
  ❯ src/ui/__tests__/schemaTree.test.ts  (33 tests | 9 failed) 17ms
    ❯ formatRows(176) === '176' (happy) → formatRows is not a function
    ❯ formatRows(1234567) === '1.2M' locale pinned 'en' (happy) → formatRows is not a function
    ❯ getCategoryChildren tables → sau microtask table node description = '176', label giữ nguyên (happy)
      → expected 'app' to be '176' // Object.is equality
    ❯ setFilter('po_log') tables gồm api_po_log + users → chỉ api_po_log được trả về (happy, ancestors expanded)
      → provider.setFilter is not a function
    ❯ filter 'ZZZ' → 'No matches for "ZZZ"' node (edge) → provider.setFilter is not a function
    ❯ setFilter('') xóa filter → full list trả về (edge) → provider.setFilter is not a function
    ❯ filter 'PO_LOG' uppercase match api_po_log (edge, case-insensitive) → provider.setFilter is not a function
    ❯ root connections luôn giữ khi filter active (không bị drop theo tên) (edge) → provider.setFilter is not a function
    ❯ category badge vẫn = tổng objects unfiltered khi filter active lọc bớt output (regression)
      → provider.setFilter is not a function
    Tests  9 failed | 24 passed (33)

ISSUES: Test 'estimateTableRows resolves null → description giữ schema fallback 'qas' (edge)' was technically green before implementation because table node description already initialized as t.schema fallback — but the spec requires the async fetch path to NOT overwrite description on null. Implementation now satisfies both: sync fallback + guard in fetchRowCount.considered.
HANDOFF_TO_REVIEWER: yes
NEXT: ready for review

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code (isolated — differs from reviewer, OK)
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ui/__tests__/schemaTree.test.ts && npx vitest run
  result: typecheck 0 errors / schemaTree 33 pass / full suite 19 files 221 pass (221 > 218 reported: sibling tasks landed concurrently)
TEST_PLAN_COVERAGE: partial — 10/10 cases implemented, but "ancestors Expanded" case only exercises the uncached (fresh-load) path; cached path untested and broken (see finding)
FINDINGS:
  critical: none
  important:
    - file: src/ui/schemaTree.ts:238-240 — getSchemaNodesForConnection returns `cached.data` directly, but schema nodes are cached with `collapsible` frozen at load time (:280-282). After setFilter() fires onDidChangeTreeData, VS Code re-queries and gets STALE Collapsed nodes for up to 60s TTL — violating spec "Ancestors ... Expanded khi filter active". Reproduced: load schemas with no filter (collapsible=1), setFilter('po_log'), re-query → collapsible still 1, expected 2. Most common real flow (browse tree, THEN type filter) hits this. Fix: on the cached-hit path, map nodes with collapsible recomputed from current filterText before returning (mirror :280-282); add a test that loads schemas before setFilter.
  minor:
    - file: src/ui/schemaTree.ts:350-354 — same staleness class in reverse: schemas cached as Expanded while filter active stay Expanded after filter cleared (cosmetic, disappears at TTL expiry).
    - file: src/ui/schemaTree.ts:397-401 — category children error path returns [errNode] unfiltered; error node ignores active filter. Arguably intentional (don't hide errors) — document or filter explicitly.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Implementation quality is otherwise solid: rowCountCache is a separate typed Map, in-flight guard is synchronous before first await so double getCategoryChildren cannot double-fetch estimateTableRows, badge computed from unfiltered list cached unfiltered, root connections never filtered, dispose()/refresh() clear all three stores, formatRows pins 'en'. One reproducible spec violation blocks approval.

## Executor Fix Report — Round 1

- EXECUTOR_TOOL: claude-code (omp session)
- EXECUTOR_MODEL: unic/unic-smart (orchestrator direct fix after reviewer findings)
- Fix: `src/ui/schemaTree.ts` cached schema nodes now remap Collapsed → Expanded when `filterText` active; cache stays canonical Collapsed, filter view is transient.
- Regression test added: `cached schema nodes become Expanded after setFilter (regression)`.
- Verification fresh:
  - `npm run typecheck` → exit 0
  - `npx vitest run src/ui/__tests__/schemaTree.test.ts` → 34 passed
  - `npx vitest run` → 19 files / 222 tests passed

## Reviewer Verdict — Round 2

VERDICT: APPROVED-WITH-MINOR
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code (original); fix round authored by orchestrator unic/unic-smart
VERIFICATION_RERUN:
  command: npm run typecheck && npx vitest run src/ui/__tests__/schemaTree.test.ts
  result: typecheck 0 errors / schemaTree 34 pass; full suite 19 files / 222 pass
TEST_PLAN_COVERAGE: all-followed — 10/10 cases + cached-path regression test added
FINDINGS:
  critical: none
  important: none — round-1 blocking finding fixed: src/ui/schemaTree.ts:243-249 remaps cached Collapsed→Expanded when filterText active (cache keeps canonical copy); regression test src/ui/__tests__/schemaTree.test.ts:997-1011 loads schemas pre-filter then asserts collapsible 2 on cached re-query — fails on old code (returned collapsible 1)
  minor:
    - src/ui/schemaTree.ts:290-292 — schemas first loaded while filter active are cached Expanded and stay Expanded after filter cleared until TTL (round-1 minor, unchanged; cosmetic)
    - src/ui/schemaTree.ts:373-383 — category error node returned unfiltered when filter active (round-1 minor, unchanged; arguably intentional)
NEXT_STATUS_FOR_INDEX: approved_minor
NOTES: Fix-round author (orchestrator direct fix) shares reviewer model — noted per harness contract that orchestrator fixes review findings; diff independently re-verified by fresh runs above.
