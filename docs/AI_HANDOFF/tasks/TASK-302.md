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

(executor điền)

## Reviewer Verdict

(reviewer điền)
