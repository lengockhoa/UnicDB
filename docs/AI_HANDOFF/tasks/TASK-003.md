# TASK-003 — Let declared server types override sampled grid inference

- Status: `pending_review`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §2 item 5, §3.3

## Goal

Fix P2-4 at the pure grid-model boundary: `inferColumns` must accept optional declared column
types and use them before sampled values. A varchar that happens to contain numeric strings must
stay string; an all-NULL declared numeric column must still be numeric/right-aligned. The protocol
and webview call-site wiring are deliberately owned by dependent TASK-007.

## Target Files

- `src/ui/resultsGridModel.ts` — extend `inferColumns(columns, rows)` with an optional declared
  type map and deterministic declared-type classification; preserve no-map behavior.
- `src/ui/__tests__/resultsGridModel.test.ts` — declared-type override, all-NULL, unknown-type,
  and no-map regression assertions.

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | Declared varchar defeats numeric-looking sample | `inferColumns(["code"], [["123"],["456"]], {code:"varchar"})` yields `{field:"code", headerName:"code", kind:"string"}` with no `alignRight`. | Pure function; every sampled row would classify as numeric today. |
| 2 | edge — empty | Declared integer classifies all-NULL data | `inferColumns(["count"], [[null],[undefined]], {count:"integer"})` yields `kind:"number", alignRight:true`. | No non-null sample values. |
| 3 | edge — boundary | Declared boolean wins conflicting samples | `inferColumns(["enabled"], [["true"],["false"]], {enabled:"boolean"})` yields `kind:"boolean"`, not string. | String samples that inference cannot prove boolean today. |
| 4 | regression | Omitted map is byte-identical | Existing numeric, boolean, duplicate-name (`id`, `id` → `id`, `id__2`) expectations pass with no third argument. | Existing fixture blocks preserved unchanged. |
| 5 | edge — unknown declaration | Unknown type falls back to sampling | `geometry` with numeric samples still yields `kind:"number", alignRight:true`; unknown metadata does not force string. | Nonempty numeric sample. |

## Test Files

- `src/ui/__tests__/resultsGridModel.test.ts`

## Verification Commands

```bash
npx vitest run src/ui/__tests__/resultsGridModel.test.ts
npm run typecheck
```

This pure model task does not read a built webview bundle, so no compile command is needed for
this targeted test. `package.json` has no lint script. Global constraints: PLAN.md §7.

## Acceptance Criteria

- [ ] `inferColumns` accepts an optional `Record<string, string>` of declared types without
      breaking its two-argument callers.
- [ ] Recognized declared string, numeric, and boolean types override samples deterministically.
- [ ] Null-only declared numeric columns right-align as numbers.
- [ ] Unknown or absent declarations preserve existing sampling behavior and duplicate field
      de-duplication.
- [ ] No production webview/protocol file is edited by this task; TASK-007 owns that wiring.
- [ ] All listed verification commands exit 0.

## Dependencies

- none

## Interfaces

- Consumes: `inferColumns(columns: string[], rows: unknown[][]): ColumnSpec[]` from
  `src/ui/resultsGridModel.ts:76`; `ColumnSpec { field, headerName, kind, alignRight?, hidden? }`.
- Produces: backward-compatible
  `inferColumns(columns, rows, columnTypes?: Record<string, string>): ColumnSpec[]`, consumed by
  TASK-007's webview wiring.

---

## Discussion

1. **Do not edit `webview/main.ts`.** It is a wave-2 TASK-007 target. The optional parameter is
   intentionally inert until that task supplies declared types.
2. **Classification must be grounded.** Before writing the classifier, inspect the existing type
   predicates around `queryComposer.ts:160` and reuse the project vocabulary rather than
   inventing database-type regular expressions. If it is not exportable without creating a
   file collision, duplicate only its verified classification list with a comment citing it.
3. **TDD order.** Cases 1 and 2 are RED against today's two-argument implementation; preserve
   the existing no-map cases as regression proof, rather than replacing them.

---

## Executor Report

EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: bao-sonnet
EXECUTOR_SUBAGENT: feature-implementer
RED_OUTPUT: |
  npx vitest run src/ui/__tests__/resultsGridModel.test.ts (pre-implementation):
   ❯ src/ui/__tests__/resultsGridModel.test.ts  (40 tests | 3 failed) 12ms
     ❯ ... > Happy: declared varchar defeats numeric-looking sample
       → expected [ { field: 'code', …(3) } ] to deeply equal [ { field: 'code', …(2) } ]
     ❯ ... > Edge (empty): declared integer classifies all-NULL data
       → expected [ { field: 'count', …(2) } ] to deeply equal [ { field: 'count', …(3) } ]
     ❯ ... > Edge (boundary): declared boolean wins conflicting string samples
       → expected [ { field: 'enabled', …(2) } ] to deeply equal [ { field: 'enabled', …(2) } ]
   Test Files  1 failed (1)
        Tests  3 failed | 37 passed (40)
  First failure detail (sampling ignored the declared varchar):
    Array [
  +   "alignRight": true,
      "field": "code",
      "headerName": "code",
  -   "kind": "string",
  +   "kind": "number",
    ]
Verification Output: |
  Command 1 — npx vitest run src/ui/__tests__/resultsGridModel.test.ts:
   ✓ src/ui/__tests__/resultsGridModel.test.ts  (40 tests) 7ms
   Test Files  1 passed (1)
        Tests  40 passed (40)
     Start at 23:41:01 / Duration 207ms
   EXIT_VITEST=0

  Command 2 — npm run typecheck:
   > vsdb@1.6.7 typecheck
   > tsc --noEmit
   EXIT_TYPECHECK=0

  Extra (insurance, not a task command): full-suite `npx vitest run` = 1350 pass /
  2 fail / 180 skipped; both failures are pre-existing environmental issues in this
  fresh worktree (esbuild binary ENOENT in aiChatPanelWebview.test.ts, missing
  dist/webview.css in agGridSmoke.test.ts) unrelated to this task's pure-model change.
Status: PASS
Note: none — inferColumns(columns, rows, columnTypes?: Record<string, string>) added;
  declared type decides kind via classifyDeclaredColumnType (string family duplicated
  verbatim from queryComposer.isStringColumnType with citation, numeric/boolean families
  from core/ddl/sampleData.ts groups); declared numeric sets alignRight even for null-only
  data; unknown types and omitted maps fall back to unchanged sampling. No webview/main.ts,
  messages.ts, or queryComposer.ts edits.
