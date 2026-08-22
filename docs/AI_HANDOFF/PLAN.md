# PLAN — Schema Explorer: per-table row counts + tree filter box

Cycle: 2026-08-22-B · Base: main · Planner: Main (unic/unic-smart)

## §1 Intent

Reference UI (QAS tool, ảnh "HUNG PRPO TEST") có DB EXPLORER sidebar với: per-table row counts + tree filter "Filter schemas, tables, columns, routines…". VSDB hiện thiếu cả hai:

1. **Row counts**: `schemaTree.ts` hiển thị badge = *số lượng tables trong category* (`node.description = String(children.length)` — đếm node, không phải rows trong table). User muốn thấy "176 row(s)" kiểu QAS: mỗi table hiện tổng rows thật từ DB.
2. **Tree filter**: không có ô filter nào — user phải mở từng schema để tìm table. QAS có search box lọc toàn tree theo tên.

**Success definition:** mở rộng Tables category → mỗi table node hiện description = row count thật (lazy, async, không block tree render); filter box trên tree lọc schemas/tables/views/routines/columns theo substring case-insensitive; tree tự expand ancestors của match khi có filter; xóa filter → tree về trạng thái bình thường. Version 1.3.1.

## §2 Scope

**In scope:**
- `src/adapters/postgres.ts` + `src/adapters/factory.ts` (nếu cần): method `estimateTableRows(schema, table)` — dùng `pg_class.reltuples` (nhanh, không seq scan; estimate từ ANALYZE, đủ tốt cho badge; nếu reltuples < 0 (chưa analyze) → fallback `SELECT COUNT(*)` chỉ khi table nhỏ? **KHÔNG** — fallback là "…" placeholder, tránh count table hàng tỷ rows).
- `src/ui/schemaTree.ts`:
  - Row-count badge: sau khi load category children xong, fire-and-forget fetch row counts per table (Promise.all, có concurrency guard), update node.description + re-render. Cache theo table, TTL như CACHE_TTL_MS.
  - Filter: state `filterText` + method `setFilter(text)`. Khi có filter: getChildren trả node match (label chứa text, case-insensitive) + ancestor chain tự expand. Filter áp cho mọi cấp: connection/schema/category/table/view/routine/column.
- `src/extension.ts`: TreeView filter UI. VS Code tree view không có built-in filter box → dùng `vsdb.filterSchemaTree` command + inline input (QuickInput/`window.showInputBox`) HOẶC thanh toolbar view (menu icon trong `views/title` contributed menu, package.json). Chọn: **`views/title` menu button** mở `showInputBox`, button "clear filter" hiện khi active. (Tree filter được lưu provider state, không phải UI text box nằm trong tree — VS Code API không cho custom HTML trong TreeView.)
- `package.json`: contributes commands `vsdb.filterSchemaTree` (enablement khi tree focused), menu entries vào `view/title` của schema explorer view.
- README.md: feature bullets. package.json version 1.3.1.

**Out of scope:**
- Results panel AI tab (queued cycle C).
**File ownership (không task cùng wave share file):**
- W1: TASK-301 (`src/adapters/types.ts` DbAdapter interface, `src/adapters/postgres.ts`, `src/adapters/mysql.ts`, `src/adapters/mssql.ts`, `src/adapters/__tests__/postgres.test.ts` [file MỚI — mock-based, vi.mock('pg'); file hiện tại chỉ có integration test dùng DB thật]).
- W2: TASK-302 (`src/ui/schemaTree.ts`, `src/ui/__tests__/schemaTree.test.ts`). Deps: 301.
- W3: TASK-303 (`src/extension.ts`, `package.json` contributes, `src/extension.test.ts`). Deps: 302.
- W4: TASK-304 (`package.json` version, `README.md`). Deps: 301,302,303.

**Dependency:** 301 → 302 → 303 → 304 (chain thẳng, không wave nào chạy song song).

## §3 Approach

**Row counts — `pg_class.reltuples`, không COUNT(*):**
```sql
SELECT c.reltuples::bigint AS row_estimate
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')
```
- `reltuples < 0` (PG14+ chưa ANALYZE) → trả null → table node giữ description = schema name (fallback), KHÔNG fallback COUNT (table có thể hàng tỷ rows — anti-pattern).
- Badge format: `Intl.NumberFormat('en', {notation:'compact'})` — **pin locale 'en'** cho output deterministic ("1.2M"), description field TreeItem.
- Lazy + async: category children render ngay (tên tables), badges update từng table khi fetch xong (`_onDidChangeTreeData.fire(node)`). Không await toàn bộ trước render.
- Row-count cache là **map riêng** `rowCountCache: Map<string, CacheEntry<number>>` — map `cache` hiện tại typed `CacheEntry<VsdbNode[]>`, không nhét number vào. TTL = CACHE_TTL_MS. Refresh command xóa cả hai map.
- Lỗi fetch 1 table → giữ description fallback, không crash tree.
- **Filter × badge interaction:** category badge (`node.description = String(children.length)`) tính từ list **UNFILTERED** (badge luôn là tổng objects thật); filter chỉ áp lên array trả về cho VS Code, KHÔNG áp lên array đưa vào `cache.set` (tránh stale badge sau khi clear filter trong TTL).

**Tree filter — provider-side state:**
- `setFilter(text)`: lưu + fire. Khi filter active:
  - Root: connections **luôn giữ** (connection là ancestor container — filter theo object name, không theo connection name; drop connection = "No matches" phá use case).
  - Schema nodes: giữ nếu schema name match HOẶC (luôn giữ khi filter non-empty — tables bên trong cần query mới biết; category children sẽ lọc).
  - Category children: load như thường (query thật, cache thật) rồi **lọc output** theo label trước khi trả về.
  - Table/view/routine/column: giữ nếu label match.
  - Ancestors của match: `CollapsibleState.Expanded`.
  - Empty match ở cấp category trở xuống → node "No matches for '…'" (contextValue empty-add).
- Batch: fetch counts cho tables visible trong category vừa mở (không eager toàn schema).

**Tree filter — provider-side state:**
- `setFilter(text)`: lưu + `_onDidChangeTreeData.fire(undefined)`.
- Khi filter active, `getChildren(undefined)` → root connections; mỗi cấp getChildren filter con theo `label.toLowerCase().includes(q)`. Node khớp trực tiếp HOẶC có descendant khớp → giữ. Match ở table → ancestors (connection/schema/category) giữ + `CollapsibleState.Expanded`.
- Cần materialize tree khi filter: filter prefix làm cây sập về match-only. Column children chỉ load khi expand — với filter, tables match vẫn lazy (không eager-load columns của mọi table; filter chỉ so label các node đã load + khi user expand table bị filter thì columns cũng qua filter).
- Tối ưu eager-load khi filter: khi có filter text, category children load tables (đã lazy) rồi lọc. Schema-level filter không cần load tables nếu schema name khớp (hiển thị schema, con vẫn lazy). **Kompromiss**: filter chỉ áp trên node label đã load được không cần query thêm — schemas list đã có, tables cần listTables(schema) query. Khi filter active: iterate schemas, với mỗi schema load tables/views/routines (3 queries/schema — chấp nhận được cho filter on-demand), lọc, chỉ giữ schemas còn match.
- Empty match → single node "No matches for 'xyz'" (contextValue empty-add pattern).

**Filter UI:**
- package.json: `"commands": [{"command":"vsdb.filterSchemaTree","title":"Filter Schema Tree","icon":"$(filter)"}]`, `menus.view/title` cho explorer view: filter button (navigate) + khi `vsdb.schemaTreeFilterActive` context key true → thêm button "$(close)" clear.
- extension.ts: command handler → `window.showInputBox({prompt:'Filter schemas, tables, columns, routines…', value: current})` → `provider.setFilter(text)` + `commands.executeCommand('setContext','vsdb.schemaTreeFilterActive', !!text)`. Title bar của view hiển thị filter active qua `contextValue`/view badge? — đơn giản: title button icon đổi không được; dùng context key + 2 buttons (filter / clear) là đủ, plus view description không có API → skip.

## §4 Test Plan (TDD)

- **TASK-301 (adapter row counts)**: happy — `estimateTableRows('qas','api_po_log')` trả số ≥0 từ reltuples (mock pg client trả reltuples=176). Edge 1 — reltuples=-1 (chưa analyze) → trả `null` (caller hiển thị "…"). Edge 2 — table không tồn tại → null, không throw. Edge 3 — adapter disconnect/throw → null + không propagate error lên tree.
- **TASK-302 (tree badges + filter)**: happy — category children tables có description undefined ban đầu, sau fetch mock → description "176". Filter: setFilter('po') → getChildren chain chỉ giữ nodes có 'po' trong label hoặc descendant match; ancestors Expanded. Edge — filter không match → "No matches" node. Edge — filter rồi xóa → full tree trở lại. Edge — filter case-insensitive ('PO' == 'po'). Regression — badge không đè label table (label giữ nguyên tên).
- **TASK-303 (command + menu)**: extension.test.ts smoke — command registered; setFilter gọi qua command. Edge — empty input → clear filter.
- **TASK-304**: version assert qua existing pattern.

## §5 Verification Commands

- `npm run typecheck` (tsc)
- `npx vitest run src/adapters/__tests__/postgres.test.ts src/ui/__tests__/schemaTree.test.ts src/extension.test.ts` (per-task)
- Wave boundary: `npx vitest run` (full suite)
- Smoke: `bash scripts/build.sh` (W3)

## §6 Acceptance Criteria

- [ ] Mở Tables category → mỗi table hiện row-count badge (số compact), lazy async, không block tree
- [ ] reltuples âm/missing → "…", không COUNT(*) fallback
- [ ] Filter box (view/title button) → nhập text → tree chỉ hiện match + ancestors expanded
- [ ] Filter khớp case-insensitive mọi cấp node
- [ ] Clear filter → tree đầy đủ
- [ ] 202+ tests pass, typecheck pass, vsix build OK
- [ ] Version 1.3.1, README updated

## §7 Task Split

- TASK-301 (S): adapter `estimateTableRows` — reltuples query, null trên unknown/error. Files: postgres.ts, factory.ts (DbAdapter interface), postgres.test.ts.
- TASK-302 (M): schemaTree row-count badges + filter engine. Files: schemaTree.ts, schemaTree.test.ts. Deps: 301.
- TASK-303 (S): filter command + view/title menu + context key. Files: extension.ts, package.json (contributes), extension.test.ts. Deps: 302.
- TASK-304 (S): version 1.3.1 + README. Files: package.json, README.md. Deps: 301,302,303.

## Plan Review Log

### Round 1 — 2026-08-22 · unic/unic-smart (PlanRevB)

VERDICT: **Issues Found** — 6 important, 5 minor. Không approved vòng này; planner áp findings rồi re-review (max 2 vòng theo config).

COMPLETENESS:
- IMPORTANT — TASK-301/PLAN §2 trỏ sai file: `DbAdapter` interface nằm ở `src/adapters/types.ts:84-94`, KHÔNG phải `factory.ts` (factory chỉ có `createAdapter`). Executor phải sửa types.ts; file list W1 thiếu `src/adapters/types.ts`.
- IMPORTANT — Thêm method vào `DbAdapter` phá compile 2 adapter còn lại: `MySqlAdapter` (`src/adapters/mysql.ts:46`) và `MsSqlAdapter` (`src/adapters/mssql.ts:32`) đều `implements DbAdapter` → Verification `npm run typecheck` của chính TASK-301 sẽ FAIL. Plan im lặng về việc này. Fix: mở rộng TASK-301 thêm impl cho mysql/mssql (return null hoặc stats query) HOẶC khai báo optional member — chọn một, ghi rõ.
- IMPORTANT — TASK-301 nói "mock pg client (pattern hiện tại trong src/adapters/__tests__/postgres.test.ts)" nhưng file ĐÓ KHÔNG TỒN TẠI. Chỉ có `postgres.integration.test.ts` (real DB, skip nếu VSDB_IT≠1). Không có mock pattern nào cho `pg` trong repo. Task phải ghi rõ: tạo file unit test mới, `vi.mock("pg")` fake Pool với `query` trả rows.
- MINOR — TASK-303 không nêu view id (`vsdb.schemaTree`, package.json:183) và clause `when: "view == vsdb.schemaTree"` cho 2 menu entry mới (mọi entry view/title hiện tại đều có when — package.json:167-177). Executor tự grep được nhưng ghi thẳng bỏ một bước suy diễn.

CONSISTENCY:
- IMPORTANT — Biểu diễn null/unknown mâu thuẫn PLAN vs TASK-302: PLAN §3 + §6 acceptance nói reltuples null → "…", nhưng TASK-302 Action 1 (`if (count === null) return`) + edge test lại giữ description = schema ("qas"). Phải thống nhất một behavior (đề nghị: giữ schema fallback như TASK-302, sửa PLAN §3/§6 — hoặc ngược lại), kẻo executor/reviewer gate khác nhau.
- IMPORTANT — TASK-202 filter Action tự mâu thuẫn: bullet "Root: filter connections theo name match" trái với nguyên tắc ancestors-kept ở Goal và với bullet "connection node trả về với Expanded". Hiện thực theo bullet đó thì filter 'po_log' (không có trong tên connection) → connection bị drop → "No matches" — phá đúng use case chính. Sửa: connection LUÔN giữ khi filter active (như schema).
- IMPORTANT — Wave labeling §2: PLAN xếp cả TASK-301 và TASK-302 vào W1 dù có dep 301→302; orchestrator chạy wave song song (maxParallelAgents=12) sẽ chạy 302 trước khi `estimateTableRows` tồn tại → typecheck fail không phải TDD-RED. INDEX.md đã ghi "302 chờ 301" nhưng PLAN nên khớp: 301=W1, 302=W2, 303=W3, 304=W4.
- MINOR — PLAN §3 SQL thiếu `relkind IN ('r','p')` mà TASK-301 có (bản task tốt hơn). Divergence vô hại nhưng nên đồng bộ.

CLARITY:
- MINOR — Tương tác filter × category badge chưa spec: `getCategoryChildren` set `node.description = String(children.length)` (schemaTree.ts:405) trên children SAU lọc → badge hiện số filtered, và vì node object sống qua cache (schemaTree.ts:303-306), clear filter trong TTL vẫn hiện badge stale. Cần ghi: badge tính từ danh sách UNFILTERED, filter chỉ áp lên array trả về — không áp lên array đưa vào `cache.set`.
- MINOR — Cache field hiện là `Map<string, CacheEntry<VsdbNode[]>>` (schemaTree.ts:70) — không chứa được number; row-count cache phải là map riêng. Task ngầm nói "cache như CACHE_TTL_MS" dễ khiến executor cố nhét vào `this.cache`.

SCOPE:
- MINOR — `formatRows` dùng `Intl.NumberFormat(undefined, …)` → output theo locale runtime: đã verify node với locale 'de' trả "1,2 Mio." thay vì '1.2M'. Happy test `formatRows(1234567) → '1.2M'` sẽ flaky trên máy/CI khác locale. Fix: pin 'en' hoặc assert bằng regex /\d+[.,]?\d*M/.

YAGNI:
- none — reltuples-only + "…" no-COUNT fallback + provider-side filter đều đúng mức; không có tính năng thừa.

CORRECTNESS (cross-check code thật):
- reltuples approach đúng PG semantics: `-1` (PG14+ chưa VACUUM/ANALYZE) → null, không COUNT(*); `relkind IN ('r','p')` đúng; `$1/$2` khớp helper `query(sql, params)` (postgres.ts:310-319). Lưu ý nhỏ: PLAN ghi "PG13+" cho reltuples=-1 — marker này thực ra từ PG14; handling `< 0 → null` vẫn đúng nên không block.
- View id + view/title navigation group tồn tại (package.json:167-183); error-node/cache/lazy pattern trong schemaTree.ts khớp mô tả plan; extension.test.ts có pattern capture registerCommand (extension.test.ts:109-113); version hiện tại 1.3.0 → bump 1.3.1 hợp lệ; README có mục Features (README.md:56-77); 210 test hiện có → "202+" đúng.
- Test plan mỗi task đạt sàn happy + ≥2 edge khác loại (301: 6 case gồm null/0-row/reject/boundary 0-vs-null; 302: 9 case gồm no-match/clear/case-insensitive/regression; 303: Esc-undefined; 304: N/A có lý do). Typecheck có trong mọi Verification Commands (project không có lint script — thỏa requireLintOrTypecheckInVerification).

NOTES: Blocking nhất là 3 finding đầu (sai file interface, thiếu impl mysql/mssql, file test mock không tồn tại) — TASK-301 sẽ fail typecheck/RED ngay vòng đầu nếu không sửa. Planner chỉ cần sửa PLAN.md + TASK-301/302 cho khớp, không cần đụng code.

## Planner Revise Log

### Round 1 findings applied (2026-08-22 · planner = Main unic/unic-smart)
- [B1] Interface file: types.ts (không factory.ts) — PLAN §2 + TASK-301 fixed.
- [B2] mysql.ts + mssql.ts cùng implements DbAdapter → PLAN §2 W1 + TASK-301 thêm impl cho cả 3 adapter (mysql: information_schema.TABLES.TABLE_ROWS; mssql: sys.partitions sum).
- [B3] src/adapters/__tests__/postgres.test.ts KHÔNG tồn tại → TASK-301 ghi rõ file MỚI + vi.mock('pg') (pattern theo factory.test.ts).
- [B4] null/unknown behavior thống nhất: giữ description = schema name fallback (bỏ "…" — PLAN §3 rev2 + TASK-302 + test case khớp).
- [B5] Root connections LUÔN giữ khi filter active (ancestor container) — PLAN §3 + TASK-302 + test mới.
- [B6] Wave relabel: W1=301, W2=302, W3=303, W4=304 (chain tuần tự) — PLAN §2.
- [M1] Filter × category badge: badge tính từ unfiltered list, filter chỉ áp output array, cache.set nhận unfiltered — PLAN §3 + TASK-302 Action.
- [M2] rowCountCache là map riêng Map<string, CacheEntry<number>> — PLAN §3 + TASK-302.
- [M3] formatRows pin locale 'en' (deterministic test) — PLAN §3 + TASK-302.
- [M4] TASK-303 nêu view id vsdb.schemaTree + when clauses — fixed.
- [M5] SQL relkind IN ('r','p') đồng bộ PLAN §3 = TASK-301.
- (Minor note PG14 reltuples=-1 đã absorbed vào PLAN §3 wording.)
Findings applied without re-review (cap 2 rounds theo RULES.md autonomy table).
