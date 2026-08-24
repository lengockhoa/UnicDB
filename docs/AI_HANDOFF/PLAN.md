# PLAN — Cycle R: AI overhaul + Table-grid Excel hóa (table + AI round)

Scope complexity: MEDIUM-HIGH
Detected systems: (1) AI stack audit/fix + full-DB context, (2) results-grid Excel editing overhaul (bug ctid + editing/undo + visual alignment)
Decision: giữ MỘT cycle (user: "Round này tập trung vào table... Kết hợp fix bug AI") — 9 tasks / 2 waves. Grid bug ctid (TASK-006) wave 1 vì user bị block save. Grid spec nguồn: `docs/AI_HANDOFF/queue/GRID-EXCEL-OVERHAUL-spec.md` (verbatim quotes ở §1).

## §1 Intent

User (verbatim): "kiểm tra kỹ cho tôi tính năng AI. tính năng này hiện tại tôi thấy chưa hoạt động tốt, review cho kỹ. chat vô phải thấy kết quả. phải có đầy đủ context của cả DB và có tính năng Export Structure để tham khảo toàn bộ context để tư vấn cho user" + "Sau khi bấm clear tôi không thể bắt đầu chat được" + "Round này tập trung vào table, tối ưu chỗ table cho giống Excel nhất có thể, save DB là xong. Kết hợp fix bug AI tận dụng sức mạnh omp hỗ trợ tối đa user" + Cmd+Enter cursor-mode defect (orchestrator probe: parser 17 case không reproduce — deviation candidate: gap-fallback về statement cuối).

Success = 5 outcomes:
1. **Chat luôn ra kết quả** — builtin engine end-to-end: config lỗi → actionable error bubble; mọi turn kết thúc bằng `assistant` hoặc `error` + `done`; Clear không kill panel; Cmd+Enter cursor-mode chạy statement chứa con trỏ.
2. **Full-DB context** — system prompt chứa TẤT CẢ user schemas/tables/views của connection (không chỉ 30 bảng `public` đầu), render qua Export-Structure DDL, budget char + footer chỉ đường `export_structure`.
3. **Export Structure → AI context** — tool `export_structure` cho model tự lấy full DDL blob; command `vsdb.exportAllStructures` copy toàn-DB DDL cho user.
4. **Grid như Excel** — fix bug no-PK ctid save (hidden-ctid-column approach), edit highlight, add/delete row, commit Cmd+Enter 1 transaction, undo/redo unified stack.
5. **Grid alignment** — requery bar 1 baseline thẳng hàng; set-filter popup items align trái đều nhau.

## §2 Scope

**In-scope** (9 tasks — 5 AI + 4 grid):
- TASK-001: `buildDatabaseStructure` builder + `export_structure` agent tool (src/ui/exportStructure.ts, src/ai/tools/schemaTools.ts + tests).
- TASK-002: Full-DB context injection vào `buildMessages` (src/ui/aiChatPanel.ts + tests).
- TASK-003: Chat reliability — Clear dead-state + not-configured error surface (src/ui/aiChatPanel.ts, webview/aiChatPanelMain.ts + tests).
- TASK-004: `vsdb.exportAllStructures` command copy toàn-DB DDL (src/ui/tableCommands.ts, package.json, src/extension.test.ts + tests).
- TASK-005: Cmd+Enter cursor-mode lock + gap-rule fix (src/core/statementParser.ts, src/core/__tests__/statementParser.test.ts, src/extension.test.ts, src/ui/__tests__/codeLensProvider.test.ts).
- TASK-006 (grid A, P0): Fix no-PK ctid save — hidden ctid column (src/ui/resultsPanel.ts, src/ui/resultsGridModel.ts + tests).
- TASK-007 (grid B): Excel editing — dirty highlight + add-row/delete-row commit INSERT/DELETE (webview/main.ts, webview/styles.css, src/core/saveStatements.ts + tests).
- TASK-008 (grid C): Unified undo/redo stack (cell edits + row add/delete) (webview/main.ts, webview/styles.css + tests).
- TASK-009 (grid D+E): Requery bar alignment + set-filter popup alignment (webview/styles.css, webview/main.ts + tests).

**Out-of-scope:** ACP/omp engine internals (builtin fallback là đường chính), provider SSE parser, MySQL/MSSQL DDL generation, view CREATE definition (ColumnInfo không có viewdef), AI Settings form, sampleDataAi, resume picker, undo-sau-commit (spec C: document, don't implement).

**Waves & dependency graph**:
- Graph: T1→{T2,T4}; T2→T3; T6→T7; T7→{T8,T9}; T5, T6-root độc lập.
- Wave 1 (3, song song — files disjoint): TASK-001, TASK-005, TASK-006
- Wave 2 (2 batch tuần tự trong wave): batch A = TASK-002, TASK-004, TASK-007 (files disjoint trong batch; T7 dep T6 vì rowErrors host-side emit đụng resultsPanel.ts mà T6 cũng sửa); batch B = TASK-003 (dep T2, file aiChatPanel.ts), TASK-008 (dep T7), TASK-009 (dep T7) — trong batch B, T8/T9 cùng đụng webview/main.ts + styles.css nên executor queue 2 task này tuần tự (T8 trước T9).

Rationale (Round-1 review finding #1): T7 không còn ở wave 1 — vừa đụng webview files (sẽ đụng T8/T9) vừa đụng resultsPanel.ts qua rowErrors (T6 owns). Dời T7 về wave 2 batch A (sau T6) khiến wave 1 chỉ còn 3 task sạch; mọi same-file pair giờ đều liên thông qua dependency hoặc batch tuần tự.

## §3 Approach — AI stack (TASK-001..005)


**D1 — AI không có DB context đầy đủ.** `buildMessages` (aiChatPanel.ts:112-142) chỉ lấy `adapter.listTables()` — PostgresAdapter mặc định `schema="public"` (postgres.ts:206) → schemas khác invisible; giới hạn 30 tables; không views. **Fix:** context từ `listSchemas(false)` + per-schema `listTables/listViews` + `listColumns` (map ExportColumn), render bằng `buildDatabaseStructure` (T1). **Budget rule (định nghĩa đầy đủ theo review #2/#4):** hằng số sản xuất `SCHEMA_CONTEXT_BUDGET = 12_000` chars, ĐỊNH NGHĨA MỘT NƠI (const trong aiChatPanel.ts). Tests override budget qua tham số injectable `buildMessages(factory, history, userMsg, opts?: {contextBudgetChars?: number; contextTableLimit?: number})` — KHÔNG hardcode 2 nơi, KHÔNG test ap-tension với hằng số production. Cắt theo BLOCK boundary (block = 1 object DDL, tables VÀ views chia CHUNG một budget theo thứ tự render: schema → tables rồi views của schema đó, block nào không vừa còn nguyên bị drop + đếm). **Oversize single block:** block ĐẦU TIÊN vượt budget (DB 1 table khổng lồ) → giữ nguyên block đầu bất kể vượt (context không bao giờ rỗng khi DB có object) + footer `(+N more objects omitted — call export_structure for full context)`; footer không vừa budget → bỏ footer (giữ blocks). Empty DB (0 objects) → context rỗng → prompt cũ.

**D2 — Clear dead-state (user report).** `handleClear` (aiChatPanel.ts:738-741) reset `history` + post `init` nhưng KHÔNG reset `token`/`currentAbort`/`turnDonePosted`; webview busy chỉ un-disable qua `done` — Clear giữa turn stream → input chết. **Fix:** host clear = full turn reset (token/currentAbort/turnDonePosted + cancelAllPending) + post `done`; webview nhận `init{hasHistory:false}` → force `setBusy(false)` + deStream.

**D3 — "AI is not configured" không hiện rõ.** `commandOpenAiChat` (extension.ts:382-404) gate ở command level; panel đã mở từ trước + settings bị clear giữa session → `runAgent` throw → error bubble message gốc nhưng thiếu hướng dẫn. **Fix (T3):** enrich catch trong `runBuiltinTurn`: message chuẩn `"AI is not configured — open VSDB: Open AI Settings to configure baseUrl/model/API key"` (giữ prefix nguyên bản để bất kỳ test hiện có nào match vẫn pass). (Câu engine-banner hint đã bỏ khỏi scope — không task cover, khỏi §3.)

**D5 — Cmd+Enter cursor-mode (orchestrator probe không reproduce ở parser 17 case).** Deviation candidate mạnh nhất theo code-read: `statementAtCursor` fallback (statementParser.ts:497-500) trả `stmts[stmts.length-1]` khi offset nằm trong GAP giữa 2 statement — user đứng giữa stmt1/stmt2 sẽ chạy stmt CUỐI FILE thay vì stmt trước con trỏ. **Fix:** gap → statement gần nhất TRƯỚC cursor (user intent "chạy statement chứa con trỏ"); trước stmt đầu → stmt đầu. Lock toàn bộ cursor-mode bằng regression tests (TASK-005) + audit handler `runQueryFromEditor` + CodeLens path.

**Alternatives rejected (AI):** (a) dump toàn bộ DDL không budget — context blow-up với DB lớn; (b) tool trả từng table DDL — model tốn steps gọi N lần; (c) prompt riêng cho mysql/mssql — ColumnInfo-based DDL là PG-first, driver khác đã có guard pattern.

## §3.1 Approach — Grid Excel overhaul (TASK-006..009, spec: queue/GRID-EXCEL-OVERHAUL-spec.md)

**G1 — No-PK ctid save bug (P0, user bị block).** `fetchPostgresCtids()` (resultsPanel.ts:699-748) match rows bằng VALUE comparison (`WHERE col IS NOT DISTINCT FROM <literal>` mọi cột, yêu cầu đúng 1 match) — round-trip literal (timestamp/numeric/boolean qua `sqlLiteral`) lệch ⇒ 0 match ⇒ banner "all_failed". **Fix (spec khuyến nghị):** với PG no-PK table, host thêm `ctid` vào SELECT ban đầu như hidden column (requery/original path trong resultsPanel.ts) → địa chỉ row chính xác tuyệt đối, không value-match. Giữ value-match chỉ là fallback khi cột ctid vắng (hand-written query). Webview ẩn cột ctid (AG Grid `hide`), host đọc ctid từ row data khi build save payload.

**G2 — Excel editing (spec B).** Đã có: cell edit (TASK-501 EditState), Add Row/Delete Row markers (webview/main.ts:1716-1734), commit Btn + Cmd+Enter, buildSaveStatements đã hiểu NewRowMarker/DeleteRowMarker → INSERT/DELETE. Thiếu: **dirty highlight** (cellStyle/CSS class vs original), **new-row highlight**, **deleted-row strikethrough**, per-row error report, refresh + clear highlights sau commit (new baseline). **Fix:** CSS class `vsdb-cell-dirty`/`vsdb-row-new`/`vsdb-row-deleted` (styles.css) + AG Grid `cellClassRules`/`getRowClass` đọc editState; commit flow re-sync grid với DB truth.

**G3 — Undo/redo unified (spec C).** AG Grid undo chỉ cover cell edits; add/delete row cần custom. **Fix:** MỘT unified stack (pure module `src/ui/undoStack.ts` — new file, no vscode) ghi mọi action (cell-edit, add-row, delete-row) theo thứ tự; Ctrl/Cmd+Z + Shift+Z (và toolbar icons) drive stack; redo stack clear trên action mới. Undo-sau-commit out-of-scope (document trong task).

**G4 — Alignment (spec D+E).** Requery bar: flexbox `align-items:center`, input/button cùng height 26px (makeIconButton đã 26px — webview/main.ts:393), gaps đều — thêm rules `.vsdb-requery-bar/.vsdb-requery-label/.vsdb-requery-input/.vsdb-requery-run/.vsdb-requery-clear` vào styles.css (hiện KHÔNG có rule nào — grep 0 match, bar chưa được style). Set-filter popup: AG Grid themeQuartz params (webview/main.ts:1371 themeQuartz.withParams) — điều chỉnh via CSS override `.ag-set-filter-item` alignment hoặc theme param; left-align "Select All" + items cùng indent.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | T1#1 full-DB DDL builder: 2 schemas × tables+views | `buildDatabaseStructure` emit `-- Database structure (2 schemas, 3 tables, 1 views)` header + `CREATE TABLE s.t (...)` per table, view block từ buildViewStructure |
| happy | T1#2 export_structure tool execute | JSON `{ddl, schemas, tables, views, truncated}` với ddl chứa header + DDL |
| happy | T2#1 buildMessages full-DB context PG | system prompt chứa `Database structure` + DDL của tables ở NHIỀU schema (public + custom), views render |
| happy | T2#2 context qua agent turn (E2E) | fake fetch nhận system message chứa DDL; model trả lời cuối `assistant` posted |
| edge | T1#3 empty DB (0 schemas/tables) | header `0 schemas` + không crash, ddl string rỗng ngoài header |
| edge | T1#4 PG-only guard mysql/mssql | tool trả `"export_structure is only supported for PostgreSQL connections."` (NotImplementedError path) |
| edge | T2#3 budget cut at block boundary | override `contextBudgetChars: 2000` qua opts (giá trị test; production const 12_000 không đụng); DB nhiều tables → context giữ blocks nguyên vẹn, footer `(+N more objects omitted — call export_structure for full context)`, KHÔNG block cắt dở |
| edge | T2#3b single oversize block | 1 table DDL > budget → block đầu giữ nguyên (vượt budget), footer omitted-count đúng, context không rỗng |
| edge | T2#4 no active connection | factory null → system prompt không có `Database structure:` section, chat vẫn chạy |
| edge | T2#5 introspection throw mid-schema | 1 schema listTables throw → schema skip + tiếp tục render schema khác |
| edge | T3#2 Clear khi idle | history=[] + init posted; turn sau bình thường |
| edge | T3#3 not-configured error surface | loadConfig null → error bubble `"AI is not configured"` trong thread, done posted, không unhandled rejection |
| edge | T3#4 webview init re-enable | `init{hasHistory:false}` sau busy → setBusy(false) called, prompt enabled |
| happy | T4#1 vsdb.exportAllStructures copies DDL | clipboard text = buildDatabaseStructure output (header + tables), statusbar message posted |
| edge | T4#4 no active connection (palette invoke, không arg) | mgr.getActive() null → info message hướng dẫn kết nối trước, KHÔNG crash, clipboard không ghi |
| happy | T5#1 cursor giữa stmt → nguyên stmt | sqlToRun trả 1 statement full text từ đầu SELECT đến `;`, không cắt từ offset |
| regression | T5#2 gap giữa 2 stmt → stmt TRƯỚC | RED hiện tại (trả stmt cuối); GREEN: statements[0] === stmt1 |
| edge | T5#3 offset trước stmt đầu (leading comment) | trả stmt ĐẦU (behavior change có chủ đích) |
| edge | T5#4 CRLF + EOF-no-semicolon + BEGIN...END + double `;;` | mỗi case lock đúng statement chứa cursor |
| regression | T6#2 no-PK edit→commit save thành công qua ctid | KHÔNG banner "Cannot save... all_failed"; UPDATE ... WHERE ctid='(0,1)' đúng row (RED hiện tại với literal round-trip data) |
| edge | T6#3 hand-written query không ctid column → fallback value-match cũ | hành vi cũ giữ nguyên (fallback path) |
| edge | T6#4 row ctid null/missing → skip per-row warning | save còn lại rows, warning đúng row |
| happy | T7#1 dirty cell highlight | editState.markDirty → cell có class `vsdb-cell-dirty`; revert/commit → mất class |
| happy | T7#2 add row + delete row → INSERT/DELETE trên commit | new-row có class `vsdb-row-new`; deleted `vsdb-row-deleted`; buildSaveStatements emit INSERT/DELETE (đã có — lock bằng E2E message flow) |
| edge | T7#3 commit khi 0 dirty → no-op (không post saveEdits) | không message, không banner |
| edge | T7#4 commit 1 row lỗi → per-row error report + giữ dirty còn lại | banner liệt kê row lỗi; rows OK saved |
| happy | T8#1 undo bước qua cell-edit → add-row → delete-row (reverse order) | Ctrl+Z 3 lần trả grid về state đầu; Shift+Z redo lại |
| edge | T8#2 redo stack clear khi action mới sau undo | undo → action mới → redo = no-op |
| edge | T8#3 undo khi stack rỗng → no-op không throw | grid state không đổi |
| happy | T9#1 requery bar 1 baseline | mọi label/input/button offsetTop bằng nhau (jsdom computed style align-items:center + height 26px) |
| edge | T9#2 set-filter items cùng indent | `.ag-set-filter-item` padding-left nhất quán (CSS rule tồn tại + selector match) |

Regression net: các test hiện có của aiChatPanel/exportStructure/schemaTools/tableCommands/statementParser/saveStatements/resultsPanel/resultsGridModel/webview KHÔNG được đỏ sau wave.


## §5 Verification Commands

Project stack: npm + vitest + tsc (package.json: `test`, `typecheck`). Không có lint script — N/A, ghi rõ thay vì bỏ im lặng.

```bash
# TASK-001
npx vitest run src/ui/__tests__/exportStructure.test.ts src/ai/tools/__tests__/schemaTools.test.ts src/ai/__tests__/agent.test.ts
# TASK-002
npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatE2e.test.ts
# TASK-003
npx vitest run src/ui/__tests__/aiChatPanel.test.ts src/ui/__tests__/aiChatPanelWebview.test.ts src/ui/__tests__/aiChatPanelMessages.test.ts
# TASK-004
npx vitest run src/ui/__tests__/tableCommands.test.ts src/extension.test.ts
# TASK-005
npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts
# TASK-006
npx vitest run src/ui/__tests__/resultsPanel.test.ts src/ui/__tests__/resultsPanelSaveEdits.test.ts src/ui/__tests__/resultsGridModel.test.ts
# TASK-007
npx vitest run src/core/__tests__/queryRunner.test.ts src/adapters/__tests__/saveStatements.test.ts src/adapters/__tests__/saveStatementsInline.test.ts src/adapters/__tests__/saveStatementsParser.test.ts src/ui/__tests__/resultsGridModelEdit.test.ts
# TASK-008
npx vitest run src/ui/__tests__/resultsGridModelEdit.test.ts src/ui/undoStack.test.ts
# TASK-009
npx vitest run tests/webviewRequeryAlignment.test.ts src/ui/__tests__/resultsGridModelSetFilter.test.ts
# Typecheck (mọi task)
npx tsc --noEmit
```

Wave boundary (orchestrator): `npx vitest run` full suite.

## §6 Acceptance Criteria

- [ ] Chat builtin end-to-end luôn kết thúc có kết quả: assistant bubble hoặc error bubble + done — T2#2, T3#3 prove.
- [ ] Sau Clear, chat bắt đầu được ngay (T3#1 regression pass RED→GREEN).
- [ ] System prompt chứa full-DB DDL context (multi-schema, tables+views) — T2#1 prove.
- [ ] Cmd+Enter chạy statement chứa con trỏ; gap → stmt trước (T5#2).
- [ ] No-PK PG table edit→commit save thành công qua hidden ctid, không còn banner all_failed (T6#2).
- [ ] Grid Excel: dirty/new/deleted highlight; add/delete row commit INSERT/DELETE; per-row errors (T7).
- [ ] Undo/redo unified: bước qua edit/add/delete (T8#1).
- [ ] Requery bar 1 baseline thẳng; set-filter items align trái (T9#1/2).
- [ ] `npx tsc --noEmit` PASS; không regression suite liên quan.

## §7 Global Constraints (mọi TASK继承 by reference)

- TypeScript strict; KHÔNG import vscode trong `src/ai/**` và `src/ui/exportStructure.ts` (pure, webview-importable pattern).
- npm/vitest/tsc là verification stack; tests dùng fake adapters + vi.mock('vscode') theo pattern src/ui/__tests__/aiChatE2e.test.ts.
- Không real-DB integration (VSDB_IT=1 pattern tồn tại nhưng không cần — unit tests với fake adapter đủ).
- Error strings lockstep với pattern hiện có: `"No active connection..."` / `"Tool failed: <msg>"` / PG-only msg dạng describe_table.
- apiKey không bao giờ qua webview wire.
- Version: không thêm dependency mới.

## Planner Report
PLANNER_MODEL: unic/unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (a) T2/T3 shared src/ui/aiChatPanel.ts → T3 dep T2; (b) grid scope added mid-plan → re-waved (T7→T8/T9 same-file serialization; T6 wave 1 for user-blocking save bug); (c) T9 verification path `tests/webviewRequeryAlignment.test.ts` is a NEW test file (documented in TASK-009 as new) — all other paths verified against tests-map.json / existing files; (d) src/ui/undoStack.test.ts is NEW (TASK-008 creates module + test). `typecheck` script verified in package.json (`tsc --noEmit`).
Known gaps: (1) View CREATE definition không emit được — ColumnInfo lacks pg_get_viewdef (T1 contract: column list only). (2) ACP/omp engine path không audit sâu — builtin fallback là đường chính; nếu omp engine là nguồn "không ra kết quả" thật thì cần cycle sau. (3) T6 hidden-ctid integration trên PG thật (docker) không cover bằng unit test — unit dùng fake adapter với ctid column; spec ghi "Integration (docker PG)" là optional (VSDB_IT=1 pattern) — executor nên thêm nếu nhanh, không block. (4) T9 visual alignment: jsdom không render thật — acceptance cần human check/screenshot (đã ghi trong task). (5) Undo-sau-commit out-of-scope (spec C).

## Plan Review Log

### Round 1 — 2026-08-24 · unic/unic-smart (PlanReview-R, REVIEW_TARGET_TYPE=plan)

Status: Issues Found

COMPLETENESS:
  - none — no TODO/TBD placeholders; intent, scope, approach, tests, verification commands, acceptance criteria, constraints all present; gaps (view DDL, undo-after-commit, docker integration) explicitly declared rather than hidden.

CONSISTENCY:
  - critical: PLAN.md:33-38 (Waves) vs PLAN.md:27 — Wave 1 (T1, T5, T6, T7) and Wave 2 (T4, T8, T9) both contain tasks touching `webview/main.ts` + `webview/styles.css` and `src/extension.test.ts`; the plan's own rule "same-wave no shared Target Files" is enforced only for T7→T8/T9, not across waves. Same-file conflicts are the exact failure mode the rule exists to prevent; a wave-boundary merge of Wave 1 and Wave 2 will collide in webview/main.ts and extension.test.ts. Fix: move T7 to Wave 2 (making Wave 1 = T1, T5, T6; Wave 2 = T2, T4, T7, T8, T9) or add an explicit cross-wave merge/anchor protocol per shared file.
  - critical: PLAN.md:74 (T2#3) vs PLAN.md:42 (D1) — test T2#3 uses "8000-char budget" while D1 specifies "Budget 12_000 chars". The executor will implement one and the test will assert the other → guaranteed red or a silently weakened test. Fix: pick one number (12_000) and make the test override it explicitly (e.g. via injected budget option), not via a contradictory constant.
  - important: PLAN.md:27 vs PLAN.md:121 — TASK-007 lists `src/core/saveStatements.ts` as a Target File, but the verification commands at line 121 run `src/adapters/__tests__/saveStatements*.test.ts` (adapters, not core). Either the target file path (`src/core/` vs `src/adapters/`) or the command list is stale; same drift appears at line 100 (regression net lists "saveStatements" without path). Fix: align the module path with the adapter test paths.

CLARITY:
  - important: PLAN.md:25-26 (D1) — "Budget 12_000 chars, cut at table boundary (giữ logic formatSchemaContext)" does not specify what happens when a single table's DDL exceeds the budget (keep it whole and exceed, or skip and count in `+N omitted`?), nor whether `views` count against the same budget or a separate one. T2#3 only tests "not cut mid-table". An executor can satisfy the letter of T2#3 while producing inconsistent behavior for oversized single tables. Fix: add one sentence defining oversized-table handling and whether views share the char budget.
  - minor: PLAN.md:81 (T4#1) — happy-path only, no edge case for T4 (e.g. no active connection → command shows the standard "No active connection..." message instead of copying). All other tasks have ≥1 edge test; T4 has none, which also undercuts the ≥2-edge-cases expectation the handoff gate applies at task level.

SCOPE:
  - none — 9 tasks / 2 waves with explicit dependencies is coherent for a MEDIUM-HIGH cycle; out-of-scope list correctly fences ACP/omp internals, other DDL dialects, undo-after-commit.

YAGNI:
  - minor: PLAN.md:44 (D3) — "engine banner không hint khi builtin vì omp fail" is diagnosed but the fix (T3) only covers pre-flight `loadConfig()` and Clear dead-state; the banner-hint sub-problem is neither in T3's scope nor listed as rejected. Either drop the diagnosis sentence or assign it — leaving it half-addressed invites scope creep during execution.

NOTES: The plan is otherwise strong (real RED expectations on T3#1/T5#2/T6#2, honest known-gaps). The two critical findings are mechanical (wave file-overlap, 8000 vs 12000) and cheap to fix before task-file generation.

### Round 2 — revision — 2026-08-25 · unic/unic-smart (Plan-R)

Đã xử lý 6/6 findings Round 1:

1. **Waves restructured (critical #1)**: Wave 1 = T1, T5, T6 (3 task, files disjoint). Wave 2 chia 2 batch tuần tự: batch A = T2, T4, T7 (disjoint files trong batch); batch B = T3, T8, T9 (T8/T9 tuần tự in-batch vì cùng webview/main.ts + styles.css). T7 dep T6 (rowErrors host-side emit đụng resultsPanel.ts — file T6 owns). Cập nhật TASK-007 Dependencies, INDEX.md waves, ACTIVE.md Status.
2. **Budget unified (critical #2)**: D1 định nghĩa `SCHEMA_CONTEXT_BUDGET = 12_000` const một nguồn; `buildMessages` nhận `opts?: {contextBudgetChars?, contextTableLimit?}` injectable — test T2#3 override budget 2000, không còn mâu thuẫn 8000/12000.
3. **T7 target/test alignment (important #3)**: bỏ `src/core/saveStatements.ts` khỏi TASK-007 Target Files (task không sửa module đó); giữ adapter tests làm regression net + ghi chú mapping (module ở `src/core/`, tests ở `src/adapters/__tests__/` — xác nhận qua tests-map.json).
4. **Oversize block rule (important #4)**: D1 + TASK-002 Spec định nghĩa: block = 1 object DDL; tables VÀ views CHUNG budget pool theo thứ tự render; block đầu vượt budget một mình → giữ nguyên (context không rỗng khi DB có object), các block sau drop vào omitted count; footer chỉ khi vừa budget. Edge test T2#7 (PLAN §4 row `T2#3b` + TASK-002 #7) lock hành vi này.
5. **T4 edge (minor #5)**: TASK-004 test #6 — no active connection (mgr.getActive() null / factory throw) → error message `Export All Structures failed: <reason>`, không crash, clipboard không ghi. PLAN §4 thêm row `T4#4`.
6. **D3 banner clause (minor #6)**: bỏ câu "engine banner không hint khi builtin vì omp fail" khỏi D3 — không task cover, khỏi §3 (không đưa vào rejected vì đó là quan sát chưa verified, không phải design decision).

### Round 2 — 2026-08-25 · unic/unic-smart (PlanReview-R2, REVIEW_TARGET_TYPE=plan)

Status: Approved

ROUND-1 FINDINGS VERIFICATION (6/6):
  - (a) Wave overlap T7 vs T8/T9 — RESOLVED: Wave 1 = {T1,T5,T6} (files disjoint); Wave 2 batch A = {T2,T4,T7} (disjoint in-batch; T7 dep T6, cross-wave), batch B = {T3,T8,T9} with T8→T9 serialized in-batch on webview/main.ts + styles.css. Every same-file pair is now ordered by wave/batch/serial (T6→T7, T7→T8/T9, T8→T9, T2→T3, T1→{T2,T4}); dependency graph matches the batch layout.
  - (b) Budget unified — RESOLVED: single production const `SCHEMA_CONTEXT_BUDGET = 12_000` in aiChatPanel.ts; `buildMessages(factory, history, userMsg, opts?: {contextBudgetChars?; contextTableLimit?})` injectable; T2#3 overrides `contextBudgetChars: 2000` via opts. No 8000 remnant outside the historical Round-1 log itself.
  - (c) T7 saveStatements path — RESOLVED in TASK file + revision note #3; RESIDUE in PLAN §2:27 still lists `src/core/saveStatements.ts` in TASK-007's parenthetical, contradicting G2 ("đã có") and note #3. Non-blocking: TASK file governs execution.
  - (d) Oversize-block + shared pool — RESOLVED: D1 defines block = 1 object DDL; tables AND views share one budget pool in render order; first block alone exceeding budget is kept (context never empty when DB has objects); later blocks dropped whole + counted; footer dropped when it doesn't fit; empty DB → old prompt. Locked by T2#3 + T2#3b.
  - (e) T4 no-connection edge — RESOLVED: §4 row T4#4 added (mgr.getActive() null → info message, no crash, clipboard not written).
  - (f) D3 banner clause — RESOLVED: sentence removed from the diagnosis; only the removal note remains.

COMPLETENESS:
  - none — no TODO/TBD; declared gaps (view DDL, ACP/omp depth, docker integration, jsdom visual check) remain explicit.
CONSISTENCY:
  - minor: PLAN.md:27 vs PLAN.md:192 — stale `src/core/saveStatements.ts` in §2 TASK-007 summary; one-token delete, TASK file already correct.
  - minor: PLAN.md:81 (T4#4 "info message hướng dẫn kết nối trước") vs PLAN.md:194 (note #5: `Export All Structures failed: <reason>`) — align on one expected string; executor follows TASK-004.
CLARITY:
  - minor: PLAN.md:134 (§6) cites "T3#1 RED→GREEN" but §4 table starts at T3#2 — test lives in TASK-003; pre-existing, harmless.
SCOPE:
  - none — 9 tasks / 2 waves / 2 batches coherent; revision introduced no creep.
YAGNI:
  - none — injectable opts is the minimal test seam; no new machinery added.

NOTES: Both Round-1 criticals are mechanically resolved and the wave/batch topology is now conflict-free; the three minors are one-line doc cleanups that cannot affect task-file execution. Approved — proceed. (Numbering: the planner's revision entry above is also labeled "Round 2 — revision"; this entry is the Round-2 review per the orchestrator's 2-round cap.)

PLAN_REVIEW: Approved by unic/unic-smart (PlanReview-R2, Round 2)
