# TASK-005 — Cmd+Enter cursor-mode: lock hành vi + gap-rule fix

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 D5, §4 T5

## Goal

User report: Cmd+Enter trong file SQL phải chạy CẢ statement/block chứa con trỏ (đến hết statement đó), không chạy statement lạ. Orchestrator probe `src/core/statementParser.ts` 17 case — không reproduce; deviation candidate theo code-read: gap-fallback của `statementAtCursor` trả statement CUỐI khi cursor nằm giữa 2 statement. Task: lock cursor-mode bằng regression tests, audit handler + CodeLens path, fix deviation.

## Target Files

- `src/core/__tests__/statementParser.test.ts` — append describe "cursor-mode regression lock (cycle R)".
- `src/core/statementParser.ts` — fix `statementAtCursor` gap-fallback (CHỈ khi test #2 RED xác nhận deviation).
- `src/extension.test.ts` — append describe "runQueryFromEditor cursor mode" (#9).
- `src/ui/__tests__/codeLensProvider.test.ts` — append 1 test khóa lens range (#8).

## Spec — audit checklist (executor đi từng mục, ghi kết quả vào Executor Report)

Parser invariants cần lock (`sqlToRun(sql, undefined, offset)`):
1. Cursor giữa statement → CHÍNH statement đó (full text từ đầu statement đến `;`, KHÔNG cắt từ offset).
2. Gap giữa stmt1/stmt2 (offset trong whitespace) → **gap rule mới**: statement gần nhất TRƯỚC cursor. Code hiện tại (statementParser.ts:482-500): vòng for không match gap offset → fallback `stmts[stmts.length-1]` = stmt cuối file — sai user intent.
3. EOF không `;` → statement cuối, full.
4. BEGIN…END block → cả block.
5. Offset trước stmt đầu (leading comment/whitespace) → stmt ĐẦU (rule mới; cũ = stmt cuối).
6. Comment-only gap (`-- note` giữa 2 stmt) → statement trước.
7. Double `;;` → statement trước `;;` (empty stmt bị bỏ).
8. CRLF: offset sau `\r\n` giữa 2 stmt → statement trước; ranges không lệch.

Handler audit (src/extension.ts:405-441 `runQueryFromEditor`):
- `selection.isEmpty` → `sel = undefined` → cursor mode (xác nhận đúng).
- `document.offsetAt(selection.active)` — offset tuyệt đối multi-line OK.
- `runStatements` chỉ chạy statements từ sqlToRun (đọc body confirm không accidentally cả file).

CodeLens path: `vsdb.runStatement` (extension.ts:129-134) nhận stmt từ lens argument — confirm không path nào cắt theo cursor.

```ts
// src/core/statementParser.ts — fix (chỉ khi #2 RED):
export function statementAtCursor(sql: string, offset: number): ParsedStatement | null {
  const stmts = splitStatements(sql);
  if (stmts.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, sql.length));
  for (const s of stmts) {
    if (clamped >= s.start && clamped < s.end) return s;
  }
  // Gap: statement gần nhất TRƯỚC cursor (user intent "chạy statement
  // chứa con trỏ"); trước stmt đầu → stmt đầu. Rule cũ trả stmt cuối —
  // sai khi cursor giữa 2 statement.
  let best: ParsedStatement | null = null;
  for (const s of stmts) {
    if (s.end <= clamped) best = s;
    else break;
  }
  return best ?? stmts[0];
}
```

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | regression-lock | cursor giữa stmt multi-line → nguyên stmt | statements.length===1; text chứa từ `SELECT` đến `;` của stmt 1 (không bắt đầu ở offset) | sql 2 stmts, cursor giữa dòng 2 của stmt 1 |
| 2 | regression | gap giữa 2 stmt → stmt TRƯỚC (deviation candidate) | RED trên code hiện tại (trả stmt cuối); GREEN: statements[0].text === stmt1 full text | `SELECT 1;\n\nSELECT 2;`, offset trong `\n\n` |
| 3 | regression-lock | EOF không `;` → stmt cuối full | statements[0].text khớp stmt cuối, không cắt | `SELECT 1;\nSELECT 2`, cursor cuối |
| 4 | regression-lock | BEGIN…END cursor giữa → cả block | statements[0].text chứa `BEGIN`…`END;` | block + stmt sau |
| 5 | edge | offset < stmt đầu (leading comment) | stmt ĐẦU (behavior change có chủ đích — ghi rõ trong test name) | `-- header\nSELECT 1;`, cursor trên comment |
| 6 | regression | selection mode KHÔNG đổi | các test selection hiện có vẫn pass (append guard test: `sqlToRun(sql,{start,end},0)` trả statements trong vùng) | chọn vùng stmt 2 |
| 7 | edge | CRLF document | cursor sau `\r\n` gap → stmt trước; range khớp text | sql với `\r\n` |
| 8 | regression-lock | CodeLens range = statement bounds | mỗi lens range start/end === positionAt(stmt.start/end) | codeLensProvider pattern hiện có |
| 9 | regression | handler chạy đúng statement cursor | `vsdb.runQuery` với fake activeTextEditor cursor giữa stmt 1 của 2 → runner.runQuery gọi 1 lần với SQL stmt 1 | vi.mock pattern src/extension.test.ts |

## Test Files

- `src/core/__tests__/statementParser.test.ts` — #1-#7 (append).
- `src/ui/__tests__/codeLensProvider.test.ts` — #8 (append).
- `src/extension.test.ts` — #9 (append).

## Verification Commands

```bash
npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts
npx tsc --noEmit
```

## Acceptance Criteria

- [ ] Mọi test §Test Cases PASS; #2 RED trên code hiện tại → GREEN sau fix (hoặc Executor Report chứng minh deviation không tái hiện với evidence từng mục audit).
- [ ] Audit checklist từng mục có kết luận trong Executor Report.
- [ ] Hành vi cursor-mode khóa: gap→stmt trước, EOF→stmt cuối, block→cả block, trước stmt đầu→stmt đầu.
- [ ] Selection mode + toàn bộ test cũ statementParser không vỡ.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: `sqlToRun(sql: string, selection: {start:number;end:number}|undefined, cursorOffset: number): { statements: ParsedStatement[]; mode: "selection"|"cursor" }`; `statementAtCursor(sql: string, offset: number): ParsedStatement | null`; `splitStatements(sql: string): ParsedStatement[]` — signatures KHÔNG đổi.
- Produces: gap-rule contract mới của `statementAtCursor` (statement gần nhất TRƯỚC cursor trong gap; stmt đầu khi trước stmt đầu) — locked bởi #2/#5/#7. Caller duy nhất (extension.ts:435) hưởng behavior đúng, không signature change.

---

## Discussion

### 2026-08-24 · planner · unic/unic-smart
→ @executor: nếu mọi source đúng sau audit (không RED), kết luận "deviation không reproduce ở HEAD; khả năng build 1.6.1 cũ" trong Executor Report + vẫn giữ các lock tests. #5 là behavior change có chủ đích — nếu reviewer thấy break use case thật, đổi expected + ghi lý do ở đây.

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report. -->
## Executor Report

STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: Exec-T5
SUMMARY: Locked cursor-mode invariants qua 7 tests mới (statementParser #1-#7), 1 test CodeLens lock (#8), 1 test handler cursor-mode (#9). TDD RED→GREEN: deviation #2 (gap fallback trả stmt cuối) confirmed RED trên code cũ — sau đó thay gap-fallback của `statementAtCursor` bằng rule "stmt gần nhất TRƯỚC cursor, fallback stmts[0] khi trước stmt đầu" → all 104 tests pass.

### Audit checklist (theo spec)

Parser invariants (sqlToRun cursor-mode):
1. Cursor giữa stmt → stmt chứa nó. PASS: `for` loop match `clamped >= s.start && clamped < s.end` trả về stmt nguyên (test #1: `SELECT 1,\n       2;` cursor 12 → stmt đầy đủ từ offset 0 đến `;`).
2. Gap giữa 2 stmt → stmt TRƯỚC. **DEVIATION CONFIRMED RED → FIXED** (test #2). Code cũ `stmts[stmts.length-1]` sai khi cursor giữa 2 stmt. Code mới loop `s.end <= clamped` → last stmt trước cursor; fallback `stmts[0]` khi trước stmt đầu.
3. EOF không `;` → stmt cuối full. PASS (test #3: `SELECT 2` đầy đủ).
4. BEGIN…END cursor giữa → cả block. PASS (test #4: block `[0,33)` cursor 10 trả về nguyên block).
5. Offset trước stmt đầu → stmt ĐẦU. **DEVIATION-CONFIRMED RED → FIXED** (test #5: `"\n  SELECT 1;\nSELECT 2;"` offset 0 → stmt đầu). Code cũ fallback `stmts[last]` = "SELECT 2". Code mới `stmts[0]`.
6. Comment-only gap. PASS (impl: nhảy qua gap bằng cùng loop "stmt trước cursor"; test #6 đảm bảo selection mode vẫn hoạt động độc lập).
7. Double `;;` → stmt trước. PASS: `splitStatements` filter empty stmt (line 354 `candidateEnd > candidateStart`), double `;;` rỗng bị bỏ; gap ở `;;` được xử lý qua Trường hợp 2.
8. CRLF. PASS (test #7: `"SELECT 1;\r\n\r\nSELECT 2;"` offset 10 trong gap `\r\n\r\n` → `SELECT 1`; range không lệch).

Handler audit (`src/extension.ts` `runQueryFromEditor` lines 405-441):
- `selection.isEmpty` true → `sel = undefined` → cursor mode (line 429-434). CONFIRMED.
- `document.offsetAt(selection.active)` cho multi-line offset tuyệt đối (line 428). CONFIRMED.
- `runStatements` chỉ chạy statements từ sqlToRun (line 440). CONFIRMED — `runner.run(rewritten, ...)` lấy chính xác `statements` từ `sqlToRun(sql, sel, cursorOffset)`.

CodeLens path (`vsdb.runStatement`, `extension.ts:129-134`):
- Nhận `stmt: ParsedStatement` từ lens argument (closure gọi `runStatement(mgr, runner, panel, stmt)`).
- CodeLensProvider (`codeLensProvider.ts:67-77`) build range = `document.positionAt(stmt.start/end)` → không cắt theo cursor; test #8 của cycle R lock invariant range.start/end === positionAt(stmt.start/end).
- `runStatement` (line 444-455) gọi `runStatements(..., [stmt])` — chỉ 1 stmt, không chạy cả file.

### Test Plan Followed

task §4 (Test Plan table #1-#9) — từng mục implemented theo fixture spec. RED confirmed cho #2/#5/#7 (gap deviation trên cả LF và CRLF) trước fix; GREEN sau fix `statementAtCursor`. #1/#3/#4/#6 pass trên code cũ (chỉ lock invariant). #8/#9 pass sau impl.

### Files Changed

- `src/core/statementParser.ts`: thay đoạn `statementAtCursor` (lines 477-509 sau sửa) — thêm Trường hợp 2 (gap fallback) thay cho `return stmts[stmts.length - 1]`; docblock cập nhật mô tả rule mới + nguồn TASK-005.
- `src/core/__tests__/statementParser.test.ts`: append describe `"statementParser — cursor-mode regression lock (cycle R)"` với 7 test (test #1-#7).
- `src/ui/__tests__/codeLensProvider.test.ts`: append test #8 lock invariant `range === positionAt(stmt.start/end)`.
- `src/extension.test.ts`: append describe `"TASK-005 — runQueryFromEditor cursor mode"` với test #9 — fake active editor với 2 stmt + cursor offset 3 (giữa stmt 1) → verify `runner.run` được gọi với đúng `statements = [SELECT 1]`.

### Tests Added

- `src/core/__tests__/statementParser.test.ts` describe "cursor-mode regression lock (cycle R)": `#1 cursor giữa multi-line stmt`; `#2 gap giữa 2 stmt → stmt TRƯỚC`; `#3 EOF không ; → stmt cuối full`; `#4 cursor giữa BEGIN...END → cả block`; `#5 offset trước stmt đầu → stmt ĐẦU`; `#6 selection mode KHÔNG đổi`; `#7 CRLF gap → stmt trước`.
- `src/ui/__tests__/codeLensProvider.test.ts`: `#8 lens range = positionAt(stmt.start/end); không lệch ký tự`.
- `src/extension.test.ts`: describe `TASK-005 — runQueryFromEditor cursor mode`: `#9 cursor giữa stmt 1 của 2 statement → runner.runQuery chạy đúng 1 stmt đầu`.

### Verification

- command: `npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts`
  result: 3 files passed, 104/104 tests passed (46 + 9 + 49)
  output_excerpt:
    ```
    ✓ src/core/__tests__/statementParser.test.ts  (46 tests) 6ms
    ✓ src/ui/__tests__/codeLensProvider.test.ts  (9 tests) 4ms
    ✓ src/extension.test.ts  (49 tests) 169ms
    Test Files  3 passed (3)
         Tests  104 passed (104)
    ```
- command: `npx tsc --noEmit` (in worktree `.worktrees/task-005`)
  result: exit 0, no output (clean).

### Issues

1. Test #2 RED confirmation trên code cũ (`expected 'SELECT 2' to be 'SELECT 1'`) — deviation gốc của task description confirmed. Sau fix (gap-fallback rule mới) GREEN.
2. Test #5 cùng nguyên nhân với #2 nhưng scenario khác (offset 0 trước stmt đầu trong leading whitespace) — RED → confirmed rule mới "stmt ĐẦU khi trước stmt đầu".
3. Worktree không có sẵn `dist/schemaForm.js` (build artifact); test "npm run compile emits dist/schemaForm.js" trong `extension.test.ts > TASK-003 — vsdb.createSchema extension wiring` ban đầu fail trong worktree mới. Build lại bằng `npm run compile` → pass. Đây là setup môi trường, không liên quan TASK-005.

### Handoff to Reviewer

yes — Tất cả tests xanh, tsc clean, deviation confirmed + fixed, audit checklist đầy đủ. Reviewer verify ngược: chạy lại `npx vitest run <3 files>` + `npx tsc --noEmit` trong worktree (sau khi build dist nếu cần bundle test).

### Next

ready for review.

## Reviewer Verdict

VERDICT: APPROVED
REVIEWER_MODEL: unic/unic-smart
EXECUTOR_MODEL: unic/unic-code
VERIFICATION_RERUN:
  command: npx vitest run src/core/__tests__/statementParser.test.ts src/ui/__tests__/codeLensProvider.test.ts src/extension.test.ts
  result: 108 pass / 0 fail (3 files)
TEST_PLAN_COVERAGE: all-followed — all 9 test cases #1-#9 implemented per spec; RED confirmed for #2/#5/#7 before fix
FINDINGS:
  critical: none
  important: none
  minor: none
NEXT_STATUS_FOR_INDEX: approved
NOTES: Deviation #2 (gap-fallback returning last statement) confirmed and correctly fixed. Fix is minimal (6-line loop replacing 1-line return), deterministic, and locked by 7 regression tests. Handler + CodeLens audit paths confirmed clean. All verification fresh-pass.
