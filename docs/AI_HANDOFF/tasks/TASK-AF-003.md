# TASK-AF-003 — SQL formatter pure module

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_AF.md` §7 (Approach §3)

## Goal

Add `formatSql(sql, opts)` — a pure, dependency-free SQL formatter: keyword casing, clause line breaks (SELECT/FROM/WHERE/GROUP BY/ORDER BY/HAVING/LIMIT), JOIN … ON indentation, subquery indentation, statement-preserving formatting of multi-statement input. Foundation for the Console v2 Format button (TASK-AF-004).

## Target Files

- `src/core/sqlFormat.ts` — NEW pure module (zero imports beyond stdlib).
- `src/core/__tests__/sqlFormat.test.ts` — NEW.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | simple SELECT: keywords cased, clauses on own lines | `select a,b from t where x=1` → `SELECT a, b\nFROM t\nWHERE x = 1` | single line input |
| 2 | unit | JOIN … ON indented under FROM | `...from t1 join t2 on t1.id=t2.id` → JOIN line indented, `ON` with condition | 2-table query |
| 3 | unit | subquery indented inside FROM | nested SELECT gets +1 indent level per depth | `SELECT * FROM (SELECT …) s` |
| 4 | unit | INSERT/UPDATE/DELETE shaped per clause | SET/WHERE on own lines; VALUES tuple on own line | 3 statement kinds |
| 5 | edge | empty / whitespace-only input → empty string | `formatSql("") === ""` and `formatSql("  \n ") === ""` | empty inputs |
| 6 | edge | unbalanced parens → no throw, best-effort output | returns a string; internal depth clamps at 0 | `")select 1("` |
| 7 | edge | strings and comments are never reformatted | content inside `'…'`, `"…"`, `--` line comments and `/* */` preserved byte-for-byte | input with literal containing `SELECT` |
| 8 | regression | idempotent: `format(format(x)) === format(x)` | holds for fixtures 1–4 | formatted outputs |
| 9 | unit | options honored | `{keywordCase:"upper"\|"lower", indent:"  "\|"    ", maxLineLength?}` respected | same input, both cases |
| 10 | unit | multi-statement input → each statement formatted, separators preserved | `;` boundaries respected (reuse-free, pure) | 2 statements |

## Test Files

- `src/core/__tests__/sqlFormat.test.ts` — tests 1–10.

## Verification Commands

```bash
npx vitest run src/core/__tests__/sqlFormat.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED first, GREEN after).
- [ ] Zero imports (pure stdlib module); usable from both host and webview bundles.
- [ ] Idempotence holds on all fixtures.
- [ ] No identifier re-quoting or dialect-specific rewriting (out of scope by design).
- [ ] `npm run typecheck` exit 0.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces (consumed by TASK-AF-004 and later cycles):
  - `export type FormatOptions = { keywordCase?: "upper" | "lower"; indent?: string; }`
  - `export function formatSql(sql: string, opts?: FormatOptions): string`

---

## Discussion

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
