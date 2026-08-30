# TASK-DBX01-001 — Importer pure modules: CSV + JSON parser

- Status: `ready`
- Owner: `-`
- Reviewer: `independent unic-smart reviewer`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX01.md` §4 (Test Plan), §2 Scope

## Goal

Write RED tests first, then implement two pure, vscode-free parsers under `src/core/importer/`: a CSV parser (RFC-4180 subset: quoted fields, escaped quotes, BOM, mixed line endings) and a JSON parser (array-of-objects or NDJSON with loud rejection of ambiguous shapes). Each returns a uniform `ImportParseResult` (headers + rows + per-row errors) that later tasks consume. No DB, no `vscode`.

## Target Files

- `src/core/importer/importCsv.ts` **(new)** — `parseCsv(text, opts?)` pure function.
- `src/core/importer/importJson.ts` **(new)** — `parseJson(text, opts?)` pure function.
- `src/core/importer/importTypes.ts` **(new)** — shared `ImportParseResult`, `ImportRowError` types.
- `src/core/importer/__tests__/importCsv.test.ts` **(new)** — CSV parser contract.
- `src/core/importer/__tests__/importJson.test.ts` **(new)** — JSON parser contract.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | parses simple comma CSV | headers `["id","name"]`, 2 rows | `"id,name\n1,Ann\n2,Bob"` |
| 2 | unit | quoted fields with embedded comma | cell value contains `,` | `"id,name\n1,\"Doe, Jane\""` |
| 3 | unit | escaped quotes inside quotes | cell value contains literal `"` | `"name\n\"He said \"\"hi\"\"\""` → `He said "hi"` |
| 4 | unit | embedded newline inside quotes | row count stays 1 | `"name\n\"line1\nline2\""` |
| 5 | edge | UTF-8 BOM stripped from first header | header is `id` not `\uFEFFid` | BOM + `"id,name"` |
| 6 | edge | CRLF and LF mixed line endings | same 2-row result | `"a,b\r\n1,2\n3,4"` |
| 7 | edge | empty file → error, not empty success | `errors[0]` mentions "empty" | `""` |
| 8 | edge | single-column CSV | headers `["x"]`, N rows | `"x\n1\n2"` |
| 9 | edge | trailing newline does not create empty row | rows length exact | `"a\n1\n"` |
| 10 | edge | ragged row → row error with line number | `errors[0].line = 3`, row excluded | `"a,b\n1,2\n3"` |
| 11 | unit | JSON array-of-objects parses | headers from first object keys, rows aligned | `[{"id":1},{"id":2}]` |
| 12 | unit | NDJSON parses | one object per line | `{"id":1}\n{"id":2}` |
| 13 | edge | primitive root rejected loudly | `errors[0]` mentions root shape | `"42"` / `"[1,2]"` |
| 14 | edge | top-level null or empty array → error | error, zero rows | `"null"`, `"[]"` |
| 15 | edge | deeply-nested object value rejected (plan §2) | row error names the column | `[{"a":{"b":{"c":1}}}]` |
| 16 | edge | NDJSON mixed with array wrapper rejected | error mentions ambiguity | `[{...}]\n[{...}]` |

## Test Files

- `src/core/importer/__tests__/importCsv.test.ts` — cases 1–10.
- `src/core/importer/__tests__/importJson.test.ts` — cases 11–16.

## Verification Commands

```bash
npx vitest run src/core/importer/__tests__/importCsv.test.ts src/core/importer/__tests__/importJson.test.ts
npm run typecheck
```

## Acceptance Criteria

- [ ] RED output recorded before implementation; both files green after.
- [ ] No `vscode` import, no `as any`/`: any`, no second CSV/JSON dependency added to package.json.
- [ ] `parseCsv`/`parseJson` are pure (no I/O, no Date.now/random).
- [ ] Errors carry 1-based line numbers usable by the wizard UI.

## Dependencies

- (none)

## Interfaces

- Consumes: (none)
- Produces (for DBX01-002/003/004):
  - `interface ImportRowError { line: number; column?: string; message: string }`
  - `interface ImportParseResult { headers: string[]; rows: string[][]; errors: ImportRowError[] }` (JSON path: values stringified per mapping rules — primitives via `String(v)`, null stays `null`)
  - `function parseCsv(text: string, opts?: { maxRows?: number }): ImportParseResult`
  - `function parseJson(text: string, opts?: { maxRows?: number }): ImportParseResult`

---
## Discussion

(no comments yet)

---
---
## Executor Report
EXECUTOR_TOOL: omp-direct (unic-code)
Status: PASS
Note: importTypes.ts (ImportParseResult/ImportRowError), importCsv.ts (RFC-4180 subset: quoted/escaped/embedded-newline/BOM/CRLF/ragged-row errors with 1-based lines), importJson.ts (array-of-objects + NDJSON; loud rejection of primitive roots, empty array, deeply-nested objects with column names, ambiguous array+NDJSON mixes). 10+7=17/17 tests. Commit: 2414698.
