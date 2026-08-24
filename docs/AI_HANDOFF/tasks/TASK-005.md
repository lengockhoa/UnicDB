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
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
