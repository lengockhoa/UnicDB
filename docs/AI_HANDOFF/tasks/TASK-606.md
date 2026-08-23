# TASK-606 — Confirm guard cho DELETE/TRUNCATE/DROP/UPDATE nguy hiểm

- Status: `ready`  <!-- ready | in_progress | pending_review | changes_requested | critical_block | approved | approved_minor | blocked | done -->
- Owner: `-`       <!-- tool đang giữ task -->
- Reviewer: `-`    <!-- model name reviewer dùng, set ở Phase 4 -->
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 (mid-cycle scope addition)

## Goal

Trước khi submit bất kỳ statement nào xuống DB, VSDB phải hỏi lại user: DELETE có
WHERE → modal confirm thường (amber); DELETE KHÔNG WHERE / TRUNCATE / DROP /
UPDATE KHÔNG WHERE → modal đỏ "CỰC KỲ NGUY HIỂM" hiện FULL statement, user phải
bấm nút "Vẫn chạy (nguy hiểm)". Cancel → huỷ TOÀN BỘ lần chạy đó (không statement
nào được submit). Có setting tắt guard: `vsdb.confirmDestructive` (default TRUE).

## Target Files

- `src/core/dangerousStatement.ts` (new) — pure detector, KHÔNG import vscode.
- `src/core/__tests__/dangerousStatement.test.ts` (new) — unit test detector.
- `src/extension.ts` — thêm guard `confirmDangerousStatements()` + gọi ở ĐẦU
  `runStatements()` (hiện tại `src/extension.ts:306`) — trước `panel.setBusy(true)`.
  Đây là funnel duy nhất: cả `runQueryFromEditor` (Cmd+Enter / title button) và
  `runStatement` (CodeLens) đều đi qua `runStatements`.
- `src/extension.test.ts` — describe TASK-606: guard qua command `vsdb.runQuery`
  (pattern TASK-505: `vi.resetModules()` + `activateFresh`).
- `package.json` — thêm `vsdb.confirmDestructive` vào
  `contributes.configuration.properties` (sau `vsdb.batchSize`).

## Test Cases (REQUIRED — TDD)

**A. Detector thuần** (`src/core/__tests__/dangerousStatement.test.ts`):

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | DELETE có WHERE | `analyzeStatement("DELETE FROM logs WHERE id = 1")` → `{ kind: 'delete', hasWhere: true }`; `guardTier(...)` → `'amber'` | input như tên |
| 2 | unit | TRUNCATE mọi form đều red | `"TRUNCATE TABLE users"` và `"TRUNCATE users"` → `{ kind: 'truncate', hasWhere: false }`, tier `'red'` | 2 input riêng biệt |
| 3 | unit | DROP TABLE red | `"DROP TABLE old_t"` → `{ kind: 'drop', hasWhere: false }`, tier `'red'` | input như tên |
| 4 | unit | UPDATE: không WHERE red, có WHERE bỏ qua | `"UPDATE t SET a = 1"` → tier `'red'`; `"UPDATE t SET a = 1 WHERE id = 2"` → tier `'none'` (không modal) | 2 input |
| 5 | edge (literal masking) | keyword trong string/comment không tính | `analyzeStatement("SELECT 'DELETE FROM t' AS x")` → `kind: 'other'`; `analyzeStatement("DELETE FROM t -- WHERE id = 1")` → `hasWhere: false` → tier `'red'` | string `'...'` và comment `--` |
| 6 | edge (CTE + paren depth) | WITH ... DELETE nhận đúng kind | `"WITH c AS (SELECT 1) DELETE FROM tgt"` → `{ kind: 'delete', hasWhere: false }` → `'red'` (SELECT nằm trong parens depth > 0 bị bỏ qua khi xác định first DML keyword) | input như tên |
| 7 | edge (case + leading comment) | case-insensitive, comment đầu statement | `"-- cleanup\ndelete from T"` → `{ kind: 'delete', hasWhere: false }` | input như tên |
| 8 | edge (dollar-quote body) | DELETE trong body function không flag | `"CREATE FUNCTION f() RETURNS void AS $$ DELETE FROM t $$ LANGUAGE sql"` → `kind: 'other'` (đã dollar-quote-masked — xem Discussion: accepted gap cho DO block tương tự) | input như tên |

**B. Guard trong extension** (`src/extension.test.ts`, RED trước khi implement):

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 9 | unit | DELETE có WHERE + bấm "Run" → chạy | `showWarningMessage` called 1 lần với `{ modal: true }`, items chứa `"Run"`, `detail` chứa text statement; `QueryRunner.prototype.run` spy ĐƯỢC gọi với statements | activeEditor sql = `"DELETE FROM t WHERE id = 1;"`, config `confirmDestructive` = undefined (→ default true), mock resolve `"Run"` |
| 10 | unit | TRUNCATE red + cancel → KHÔNG chạy | message match `/NGUY HIỂM/`, items chứa `"Vẫn chạy (nguy hiểm)"`, `{ modal: true }`, `detail` chứa FULL text `"TRUNCATE TABLE t"`; mock resolve `undefined` (Esc/Cancel) → `run` spy KHÔNG được gọi, KHÔNG `setBusy` | activeEditor = `"TRUNCATE TABLE t;"` |
| 11 | unit | DELETE không WHERE + bấm confirm đỏ → chạy | message match `/NGUY HIỂM/`; mock resolve `"Vẫn chạy (nguy hiểm)"` → `run` spy được gọi | activeEditor = `"DELETE FROM t;"` |
| 12 | edge (setting off) | `confirmDestructive: false` → bỏ qua guard | `showWarningMessage` KHÔNG được gọi; `run` spy được gọi ngay | config mock trả `false` cho key `confirmDestructive`, activeEditor = `"DELETE FROM t;"` |
| 13 | edge (mixed batch, cancel huỷ cả lô) | SELECT + TRUNCATE trong selection, cancel → không statement nào chạy | đúng 1 modal red; mock resolve `undefined` → `run` spy KHÔNG được gọi | editor selection (isEmpty false) phủ `"SELECT 1; TRUNCATE t;"`, `offsetAt` stub trả offset đúng |
| 14 | regression | SELECT thường không bị hỏi | `showWarningMessage` KHÔNG gọi; `run` spy được gọi | activeEditor = `"SELECT 1;"`, confirmDestructive = true |
| 15 | regression (RED today) | manifest khai báo setting | `pkgJson.contributes.configuration.properties["vsdb.confirmDestructive"]` = `{ type: 'boolean', default: true }` — FAIL với package.json hiện tại (chưa có key) | đọc package.json như describe TASK-303 |

Ghi chú fixture B: seed active connection QUA MEMENTO để khỏi đi qua
SecretStorage — `state.workspaceFolders = undefined` ⇒ ConnectionManager dùng
`globalState`; override `globalState.get`: `"vsdb.connections"` →
`[{ id: 'c1', name: 'c', driver: 'postgres', host: 'h', port: 5432, user: 'u', database: 'd' }]`,
`"vsdb.activeConnection"` → `"c1"`. Spy runner:
`vi.spyOn(QueryRunner.prototype, "run").mockResolvedValue([])` (import từ
`./core/queryRunner` — precedent: `vi.spyOn(SchemaTreeProvider.prototype, ...)`
trong describe TASK-303). Mở rộng vscode-mock `getConfiguration` thêm
`if (key === "confirmDestructive") return state.confirmDestructive as T;`
(mặc định `undefined` — guard coi `undefined` là `true`).

## Test Files

- `src/core/__tests__/dangerousStatement.test.ts` (new) — chứa A1–A8.
- `src/extension.test.ts` — describe `TASK-606 — destructive confirm guard`
  chứa B9–B15 (giữ nguyên mọi describe hiện có).

## Verification Commands

```bash
npx vitest run src/core/__tests__/dangerousStatement.test.ts src/extension.test.ts && npm run typecheck
```

(Không cần `npm run compile` — 2 test file này không eval `dist/`. Repo KHÔNG có
lint script — xem PLAN §5.)

## Acceptance Criteria

- [ ] A1–A8 + B9–B15 PASS; không regression ở `src/extension.test.ts` các describe cũ.
- [ ] `analyzeStatement` + `guardTier` export đúng chữ ký §Interfaces, không import vscode trong `dangerousStatement.ts`.
- [ ] Guard gọi ở `runStatements` TRƯỚC `panel.setBusy(true)`; cancel → return sớm, không `runner.run`, không busy state.
- [ ] `package.json` có `vsdb.confirmDestructive` default `true`.
- [ ] Reviewer verdict APPROVED hoặc APPROVED-WITH-MINOR.

## Dependencies

- (none — TASK-605 đã done trên main (extension.ts changes đã có); files disjoint
  với TASK-602/603 (webview/). Chạy song song TASK-603 ở Wave 3.)

## Interfaces

- Consumes: `ParsedStatement { text: string; start: number; end: number }` từ
  `src/config/types` (có sẵn); `QueryRunner.prototype.run(statements, onUpdate)` (chỉ spy, không đổi).
- Produces (TASK-604 sẽ consume setting này; detector không task nào khác dùng):
  ```ts
  // src/core/dangerousStatement.ts
  export type DangerousKind = "delete" | "truncate" | "drop" | "update" | "other";
  export interface StatementAnalysis { kind: DangerousKind; hasWhere: boolean; }
  export type GuardTier = "red" | "amber" | "none";
  export function analyzeStatement(sql: string): StatementAnalysis;
  export function guardTier(a: StatementAnalysis): GuardTier;
  ```
  Setting: `vsdb.confirmDestructive` (boolean, default `true`) —
  `contributes.configuration.properties`, đọc bằng
  `vscode.workspace.getConfiguration("vsdb").get<boolean>("confirmDestructive") ?? true`.
  Guard contract (module-private trong `src/extension.ts`):
  `confirmDangerousStatements(statements: ParsedStatement[]): Promise<boolean>` —
  `true` = proceed, `false` = user cancel (huỷ cả lô). Modal red:
  `showWarningMessage("VSDB: CỰC KỲ NGUY HIỂM — câu lệnh sẽ XÓA SẠCH DỮ LIỆU (DELETE không WHERE / TRUNCATE / DROP). Kiểm tra lại query!", { modal: true, detail: <full statement text, mỗi statement cách 1 dòng trống, cap 2000 ký tự> }, "Vẫn chạy (nguy hiểm)")`.
  Modal amber: `showWarningMessage("VSDB: DELETE có điều kiện — chạy câu lệnh này?", { modal: true, detail: <statement text truncate ~500 ký tự> }, "Run")`.
  Tier rules: delete+where → amber; delete không where / truncate (mọi form) /
  drop (mọi form) / update không where → red; còn lại → none.

---

## Discussion

### 2026-08-23 · planner · unic/unic-smart
Quyết định thiết kế (planner, theo đề bài user):
1. **UPDATE không WHERE xếp red-tier** — user chỉ nêu DELETE/TRUNCATE nhưng
   UPDATE không WHERE cùng lớp mất dữ liệu (overwrite toàn bảng); đánh red an
   toàn hơn. UPDATE CÓ where → không modal (không trong yêu cầu).
2. **Mọi DROP đều red** (không chỉ DROP TABLE) — mọi DROP đều phá hoại schema,
   phân loại con chỉ tăng complexity không tăng safety.
3. **Cancel = huỷ cả lô** — đúng intent "check lại câu query"; KHÔNG chạy statement
   lành tính xung quanh (test #13 pin hành vi này).
4. **Detector algorithm**: mask literal (`'...'`, `"..."`, `$$...$$`) + comment
   (`--`, `/* */`) thành space (cùng token rules như statementParser, tự viết
   scanner gọn trong module mới — KHÔNG sửa statementParser.ts); sau đó scan
   keyword ở paren-depth 0: bỏ qua `with` + phần CTE trong parens, keyword DML
   depth-0 ĐẦU TIÊN quyết định kind; `hasWhere` = `\bwhere\b` xuất hiện trong
   masked text.
5. **Accepted gap**: DELETE trong body function/DO-block dollar-quoted → `other`
   (A8) — chạy CREATE FUNCTION không bị hỏi. Đây là hành vi đúng lớp (statement
   là CREATE, không phải DELETE); guard mức statement-text là đủ cho use case
   user chạy SQL ad-hoc.
6. `hasWhere` scan cả WHERE của subquery (vd `DELETE ... RETURNING (SELECT ...
   WHERE ...)`) → có thể lên amber khi thực tế không có WHERE ngoài — hướng
   under-escalate (vẫn confirm, chỉ không đỏ), chấp nhận được.

### 2026-08-23 · planner · unic/unic-smart
Wave note: TASK-606 chạy Wave 3 song song TASK-603 (files disjoint). TASK-604
(Wave 4) cũng sửa `package.json` (version bump) — 606 PHẢI land trước 604.
→ @maintainer: khi 604 start, thêm TASK-606 vào Dependencies của TASK-604
(không sửa file 604 ở phase này để tránh đụng task đã planned).

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->
## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: unic/unic-code
EXECUTOR_SUBAGENT: feature-implementer (Exec606)
SUMMARY: Thêm detector thuần `dangerousStatement.ts` (mask literal/comment/dollar-quote,
  scan keyword depth-0 với CTE prelude rule) + guard `confirmDangerousStatements()` gọi ở
  đầu `runStatements()` trước `panel.setBusy(true)`, cùng setting `vsdb.confirmDestructive`
  (default true). Cancel huỷ cả lô; red tier thắng amber.
TEST_PLAN_FOLLOWED: task §Test Cases A1–A8 + B9–B15 (đủ, không cắt case)
FILES_CHANGED:
  - src/core/dangerousStatement.ts: NEW — analyzeStatement/guardTier + masker.
  - src/core/__tests__/dangerousStatement.test.ts: NEW — A1–A8.
  - src/extension.ts: import detector; guard call ở đầu runStatements (trước setBusy);
    confirmDangerousStatements() + capDetail() + RED/AMBER_DETAIL_CAP.
  - src/extension.test.ts: state.confirmDestructive + config mock key; describe
    "TASK-606 — destructive confirm guard" (B9–B15).
  - package.json: contributes.configuration.properties["vsdb.confirmDestructive"]
    = { type: boolean, default: true } (sau vsdb.batchSize).
TESTS_ADDED:
  - src/core/__tests__/dangerousStatement.test.ts: A1 delete+where amber, A2 truncate
    (2 form) red, A3 drop red, A4 update no-where red / where none, A5 literal+comment
    masking, A6 CTE delete, A7 case + leading comment, A8 dollar-quote body → other.
  - src/extension.test.ts: B9 amber Run→run, B10 truncate cancel→no run/no busy,
    B11 red confirm→run, B12 setting false→no modal, B13 mixed batch cancel huỷ cả lô,
    B14 SELECT không hỏi, B15 manifest setting.
VERIFICATION:
  command: npx vitest run src/core/__tests__/dangerousStatement.test.ts src/extension.test.ts && npm run typecheck
  result: 33 pass / 0 fail; tsc --noEmit exit 0
  output_excerpt: |
    ✓ src/core/__tests__/dangerousStatement.test.ts  (8 tests) 2ms
    ✓ src/extension.test.ts  (25 tests) 56ms
     Test Files  2 passed (2)
          Tests  33 passed (33)
    > vsdb@1.4.1 typecheck
    > tsc --noEmit
  command: npm test (full suite)
  result: 37 files / 432 tests pass, 0 fail
  output_excerpt: |
     Test Files  37 passed (37)
          Tests  432 passed (432)
RED_EVIDENCE: trước implement — dangerousStatement.test.ts FAIL collect (module chưa tồn tại,
  loadAndTransform error); extension.test.ts 5 failed (B9/B10/B11/B13 "expected spy to be
  called 1 times, but got 0 times" vì chưa có modal; B15 "expected undefined not to be
  undefined" vì package.json chưa có key). Sau implement: 33/33 pass.
ISSUES: `npm test` toàn cục cần `npm run compile` trước — describe webview asset đọc
  dist/webview.css (pre-existing, không liên quan TASK-606; chạy compile rồi suite full xanh).
HANDOFF_TO_REVIEWER: yes — code change có guard destructive, cần review verdict.
NEXT: ready for review
```

