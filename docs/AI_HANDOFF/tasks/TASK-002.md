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
