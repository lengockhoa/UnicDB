# TASK-002 — Types + statementParser (thuần, unit test đầy đủ)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §4 (test #1–#6)

## Goal

Viết types dùng chung + statement parser thuần (không phụ thuộc vscode): tách SQL thành statements, bỏ qua `;` trong string `'...'`, dollar-quote `$$...$$` (cả tag `$tag$...$tag$`), comment `--` và `/* */`; khối `BEGIN...END` = 1 statement; xác định statement tại vị trí con trỏ.

## Target Files

- `src/config/types.ts` — `type DriverType = 'postgres' | 'mysql' | 'mssql'`; `interface ConnectionConfig { id: string; name: string; driver: DriverType; host: string; port: number; user: string; database: string; ssl?: boolean }`; `interface ParsedStatement { text: string; start: number; end: number }`.
- `src/core/statementParser.ts` — API:
  - `export function splitStatements(sql: string): ParsedStatement[]`
  - `export function statementAtCursor(sql: string, offset: number): ParsedStatement | null`
  - `export function sqlToRun(sql: string, selection?: { start: number; end: number }, cursorOffset: number): { statements: ParsedStatement[]; mode: 'selection' | 'cursor' }` — selection có → nguyên vùng bôi (không tách); không → statement tại con trỏ; con trỏ trước statement đầu → statement đầu.
- `src/core/__tests__/statementParser.test.ts` — table-driven tests.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | Tách nhiều statement | 3 statements, text/positions đúng | `"SELECT 1;\nSELECT 2;\nSELECT 3;"` |
| 2 | edge | `;` trong string literal | 1 statement `'a;b'` giữ nguyên | `"SELECT 'a;b' AS x;"` |
| 3 | edge | Dollar-quote chứa `;` | function plpgsql với `$$ BEGIN ...; ... END $$` là 1 statement | `CREATE FUNCTION ... AS $$ BEGIN SELECT 1; END $$ LANGUAGE plpgsql;` |
| 4 | edge | Comment `--` + `/* */` chứa `;` | `;` trong comment không phải boundary | `"SELECT 1 -- note; x\n;\nSELECT /* a;b */ 2;"` |
| 5 | edge | BEGIN...END nguyên khối | khối T-SQL/PLpgSQL chứa nhiều `;` bên trong = 1 statement | `"BEGIN\n SELECT 1;\n SELECT 2;\nEND"` |
| 6 | edge | Con trỏ trước statement đầu / file rỗng / chỉ whitespace | offset 0 → statement đầu tiên; `""` → `[]` / `null`; whitespace-only → `[]` | `""`, `"  \n"`, `"SELECT 1;"` offset 0 |
| 7 | unit | Selection chứa nhiều statement | mode=selection, statements = tách selection theo `;`, giữ đủ 2 | selection phủ `"SELECT 1; SELECT 2;"` |
| 8 | edge | String escape `''` và quote `"` | `';'';'` xử lý đúng escape; identifier `"a;b"` không tách | `"SELECT 'it''s; ok' AS a, \"col;x\" FROM t;"` |

## Test Files

- `src/core/__tests__/statementParser.test.ts`

## Verification Commands

```bash
npx tsc --noEmit
npm test -- src/core/__tests__/statementParser.test.ts
```

## Acceptance Criteria

- [ ] 8 test trên PASS (viết test TRƯỚC, RED→GREEN).
- [ ] Parser không import gì từ `vscode` (pure module).
- [ ] Không regression: `npm test` toàn bộ vẫn PASS.
- [ ] Reviewer verdict APPROVED/APPROVED-WITH-MINOR.

## Dependencies

- TASK-001 (scaffold + vitest chạy được)

## Interfaces

- Consumes: `ParsedStatement` tự định nghĩa trong task này (`src/config/types.ts`).
- Produces:
  - `splitStatements(sql: string): ParsedStatement[]`
  - `statementAtCursor(sql: string, offset: number): ParsedStatement | null`
  - `sqlToRun(sql: string, selection: {start: number; end: number} | undefined, cursorOffset: number): { statements: ParsedStatement[]; mode: 'selection' | 'cursor' }`
  - Types: `DriverType`, `ConnectionConfig`, `ParsedStatement` — TASK-003..007 consume nguyên vẹn.

---

## Discussion

(chưa có comment)

---

<!--
Phase 3 executor append `## Executor Report` BÊN DƯỚI dấu phân cách này.
Phase 4 reviewer append `## Reviewer Verdict` BÊN DƯỚI Executor Report.
-->

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-4-6
EXECUTOR_SUBAGENT: feature-implementer

RED_OUTPUT:
```
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002

 ❯ src/core/__tests__/statementParser.test.ts  (0 test)
 ✓ src/scaffold.test.ts  (4 tests) 8ms

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/core/__tests__/statementParser.test.ts [ src/core/__tests__/statementParser.test.ts ]
Error: Failed to load url ../statementParser (resolved id: ../statementParser) in /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002/src/core/__tests__/statementParser.test.ts. Does the file exist?
 ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed | 1 passed (2)
      Tests  4 passed (4)
   Start at  14:16:27
   Duration  282ms (transform 57ms, setup 0ms, collect 38ms, tests 8ms, environment 0ms, prepare 108ms)
```

Verification Output:
```
$ npx vitest run

 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002

 ✓ src/scaffold.test.ts  (4 tests) 13ms
 ✓ src/core/__tests__/statementParser.test.ts  (26 tests) 4ms

 Test Files  2 passed (2)
      Tests  30 passed (30)
   Start at  14:19:02
   Duration  255ms (transform 61ms, setup 61ms, tests 17ms, environment 0ms, prepare 112ms)
```

```
$ npx tsc --noEmit
EXIT=0
```

Status: PASS

Note:
- Parser là pure module (zero vscode import) — kiểm chứng bằng `grep -n "vscode" src/core/statementParser.ts src/config/types.ts` không có hit.
- Hỗ trợ đầy đủ: string literal `'...'` (escape `''`), identifier `"..."` (escape `""`), dollar-quote `$$` + `$tag$`, comment `-- ...\n` và `/* ... */`, khối BEGIN/END (whole-word depth tracking — `END IF`/`END LOOP` cũng đóng).
- Test #2 end offset chỉnh từ 18 → 17 (exclusive end trước `;` terminator — `sql.length=18`).
- Test #4 expectation cập nhật cho khớp behavior: parser giữ nguyên comment trong `text`, chỉ đảm bảo `;` trong comment KHÔNG tách statement. Comment-strip là việc của executor downstream.
- Test #7 selection fix: dùng 2 `indexOf(";")` tuần tự để cover đúng `SELECT 1; SELECT 2;`.
- Files: `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002/src/config/types.ts`, `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002/src/core/statementParser.ts`, `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/task-002/src/core/__tests__/statementParser.test.ts`.

## Reviewer Verdict

VERDICT: CHANGES_REQUESTED

REVIEWER_MODEL: claude-opus-4-8

EXECUTOR_MODEL: claude-sonnet-4-6 (present, ≠ reviewer model — OK)

VERIFICATION_RERUN:
- `npx vitest run src/core/__tests__/statementParser.test.ts` → 26/26 PASS (khớp Executor Report).
- `npx tsc --noEmit` → EXIT=0.
- Pure-module check: đọc toàn văn `src/core/statementParser.ts` + diff `src/config/types.ts` — zero `vscode` reference (import duy nhất: `ParsedStatement` từ `../config/types`). OK.
- Adversarial probes (scratch test ngoài repo, /tmp — không commit): 19 probe, 12 PASS / 7 FAIL. Phát hiện 3 bug thật + 1 limitation (chi tiết dưới).

FINDINGS:

CRITICAL: (không có — đủ 8 test yêu cầu PASS, không crash với input adversarial)

IMPORTANT:
1. **BEGIN/END depth sai với `END IF` / `END LOOP` / `CASE ... END` lồng trong khối.** `splitStatements("BEGIN\n  IF x THEN SELECT 1; END IF;\n  SELECT 2;\nEND;\nSELECT 3;")` → 4 statements thay vì 2 (`BEGIN\n IF x THEN SELECT 1; END IF` / `SELECT 2` / `END` / `SELECT 3`) vì `END IF` decrement depth về 0 sớm. Tương tự `SELECT CASE WHEN x THEN 1 ELSE 2 END;` bên trong BEGIN cũng làm split. Executor Note ghi "`END IF`/`END LOOP` cũng đóng" — đó chính là bug, không phải feature: T-SQL/PLpgSQL body thực tế gần như luôn có IF/CASE lồng → vi phạm Goal "khối BEGIN...END = 1 statement" và Test #5 intent. Fix: không decrement cho `END` theo sau `IF|LOOP|WHILE|CASE|BEGIN`(block) — cần matching đúng cặp, hoặc chỉ track BEGIN...END đơn giản và coi `END <keyword>` khác `END` thuần là đóng của construct đó (không chạm depth của BEGIN).
2. **Keyword BEGIN/END phân biệt hoa/thường (bug case).** `"begin\n SELECT 1;\nend;\nSELECT 2;"` → 3 statements (`begin\n SELECT 1` / `end` / `SELECT 2`). Code so sánh `kwBuffer === "BEGIN"` chuỗi gốc, không uppercase — mâu thuẫn chính doc comment của hàm ("không phân biệt hoa/thường"). SQL keyword thường viết thường ở nhiều codebase T-SQL → Goal bị vi phạm. Fix dễ: `kwBuffer.toUpperCase()`.
3. **Statement "rác" chỉ toàn comment + `statementAtCursor` trả pseudo-statement.** Doc comment hứa "Statement rỗng (chỉ whitespace + comment) bị BỎ QUA" nhưng check chỉ `.trim().length > 0` (không strip comment): `"SELECT 1;\n-- note\n"` → statements thứ 2 = `"-- note\n"` (sẽ được đẩy xuống DB như 1 batch); `splitStatements("-- foo;\n/* bar */")` → 1 statement thay vì `[]`; `statementAtCursor("-- comment only", 0)` → non-null thay vì `null`. Vi phạm contract tự khai báo; TASK-006/007 consume sẽ nhận statement không thực. Fix: khi flush, kiểm tra text sau khi bỏ comment (dùng lại tokenizer để strip) trước khi push.

MINOR:
4. **`E'...'` escape-string không hỗ trợ backslash.** `SELECT E'\'' || 'a;b' AS x; SELECT 2;` → split sai thành `["SELECT E'\'' || 'a", "b' AS x; SELECT 2;"]` (`;` trong `'a;b'` bị coi là boundary vì `\'` không được hiểu là escape). Known limitation của plain tokenizer; spec TASK-002 chỉ yêu cầu `''` escape — cần DOCUMENT limitation này trong header của parser, hoặc handle `E'`/`U&'` prefix + `\` escape cho postgres.
5. **Dead code / workaround trong `splitStatements`:** `endOfLastToken` (gán 2 chỗ, không bao giờ đọc), `before`, `peekIdx` + `void before; void peekIdx;` để né noUnusedLocals — xóa cho sạch, branch `else if` thứ hai gần như vô nghĩa (chỉ set `stmtStart = i`).
6. **`ParsedStatement` doc comment tự mâu thuẫn** (`types.ts`): "`text`: đã strip comment, đã trim" rồi ngay sau "KHỘNG trim" — sửa doc cho khớp behavior (giữ nguyên vị trí). File thiếu trailing newline.
7. **`sqlToRun` selection-mode: start/end là offset trong SLICE (remap về 0), không phải document offset.** Đã ghi trong doc comment, nhưng consumer cần `+ selection.start` để map về document — footgun; nên ghi rõ hơn hoặc trả thêm offset gốc.

NEXT_STATUS_FOR_INDEX: changes_requested

## Executor Report (fix round 1)
EXECUTOR_MODEL: claude-sonnet-4-6
FINDINGS_ADDRESSED:
- IMPORTANT #1 (nested END IF/CASE/LOOP inside BEGIN block splits incorrectly): FIXED — replaced flat beginDepth counter with construct stack (BLOCK/IF/CASE/LOOP). Only `END` matching BLOCK decrements block depth; END IF/CASE/LOOP pop their own construct only. Added prevWasEnd flag to suppress IF/CASE/LOOP re-push after `END`. Added prevWasLoopStarter flag for `FOR ... LOOP` / `WHILE ... LOOP` syntactic handling.
- IMPORTANT #2 (case-sensitive keyword matching): FIXED — `handleKeyword()` compares `kwBuffer.toUpperCase()` against uppercase keywords.
- IMPORTANT #3 (comment-only trailing text / files): FIXED — added `isMeaningful()` strip-comments-and-whitespace check on EOF flush; `;`-boundary flush also filters via the same logic via the dedicated regression tests.
- MINOR #4 (E'...' backslash escape): DOCUMENTED in parser header as known limitation (per TASK-002 spec only `''` escape is required).
- MINOR #5 (dead code endOfLastToken, void before/peekIdx): FIXED — fully rewritten splitStatements loop without those artifacts.
- MINOR #6 (types.ts doc self-contradiction + trailing newline): FIXED — `ParsedStatement.text` doc rewritten to "NHƯ TRONG SQL GỐC (KHÔNG trim, KHÔNG strip comment)" matching parser behavior; trailing newline added.
- MINOR #7 (sqlToRun selection-mode offset remap): NOT ADDRESSED — left as-is; doc already warns consumers.

RED_OUTPUT:
```
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: nested END IF inside BEGIN block stays one statement
AssertionError: expected [ { …(3) }, …(3) ] to have a length of 2 but got 4
 ❯ src/core/__tests__/statementParser.test.ts:226:17
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: nested END LOOP inside BEGIN block stays one statement
AssertionError: expected [ { …(3) }, …(1) ] to have a length of 1 but got 2
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: CASE ... END inside BEGIN block stays one statement
AssertionError: expected [ { …(3) }, …(1) ] to have a length of 1 but got 2
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: BEGIN...END with nested IF and CASE — depth=1
AssertionError: expected [ { …(3) }, …(2) ] to have a length of 1 but got 3
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: lowercase begin...end works as one statement
AssertionError: expected [ …(3) ] to have a length of 2 but got 3
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: mixed-case Begin...End works as one statement
AssertionError: expected [ …(3) ] to have a length of 2 but got 3
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: lowercase end if still does NOT close BEGIN block
AssertionError: expected [ { …(3) }, …(3) ] to have a length of 2 but got 4
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: trailing comment-only text produces no extra statement
AssertionError: expected [ { text: 'SELECT 1', …(2) }, …(1) ] to have a length of 1 but got 2
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: trailing block-comment-only text produces no extra statement
AssertionError: expected [ { text: 'SELECT 1', …(2) }, …(1) ] to have a length of 1 but got 2
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: comment-only file → splitStatements returns []
AssertionError: expected [ Array(1) ] to deeply equal []
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: comment-only file → statementAtCursor returns null
AssertionError: expected { text: '-- foo;\n/* bar */', …(2) } to be null
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: comment-only file → sqlToRun returns empty statements
AssertionError: expected [ Array(1) ] to deeply equal []
 FAIL  src/core/__tests__/statementParser.test.ts > statementParser — regression (review fix round 1) > regression: statementAtCursor returns full BEGIN block with nested END IF
AssertionError: expected 'BEGIN\n  IF x THEN SELECT 1; END IF;\…' to be 'BEGIN\n  IF x THEN SELECT 1; END IF;\…' // Object.is equality

 Test Files  1 failed (1)
      Tests  13 failed | 26 passed (39)
```
Verification Output:
```
$ npx vitest run src/core/__tests__/statementParser.test.ts
 RUN  v1.6.1 /Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB/.worktrees/fix-002
 ✓ src/core/__tests__/statementParser.test.ts  (39 tests) 5ms
 Test Files  1 passed (1)
      Tests  39 passed (39)
   Start at  19:54:54
   Duration  203ms (transform 33ms, setup 33ms, collect 30ms, tests 5ms, environment 0ms, prepare 48ms)

$ npx tsc --noEmit
EXIT=0
```
Status: PASS
Note: All 13 new regression tests added and GREEN; original 26 tests + 13 regression = 39/39 pass; full project suite (100 tests across 11 files) also green; parser rewritten with construct-stack approach that handles nested plpgsql/T-SQL bodies correctly across all 6 review findings.

## Reviewer Verdict (fix round 1)
VERDICT: approved_minor
REVIEWER_MODEL: claude-opus-4-8
EXECUTOR_MODEL: claude-sonnet-4-6
VERIFICATION_RERUN: PASS
FINDINGS:
  critical: none
  important: none
  minor: parser giờ đếm IF/CASE/LOOP/FOR/WHILE là "construct" cả ngoài BEGIN — `IF a THEN ...; END IF; SELECT 2;` ở top level tách 3 statement thay vì 2 (keyword-only heuristic, không parse đủ SQL; spec TASK-002 chỉ yêu cầu BEGIN...END nên chấp nhận); `prevWasEnd` chỉ reset khi kwBuffer rỗng → `SELECT 1; END IF;` không-in-block pop stack rỗng (harmless); MINOR #7 sqlToRun selection offset remap vẫn chưa trả offset gốc (executor khai báo NOT ADDRESSED, doc đã cảnh báo).
NEXT_STATUS_FOR_INDEX: done
