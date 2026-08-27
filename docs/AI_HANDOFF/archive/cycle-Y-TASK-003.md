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

| # | Type | Test name | Expected | Pre-state / Fixture |
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

---

## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: bao-opus (config handoff.reviewer.model = unic-smart)
EXECUTOR_MODEL: bao-sonnet (claude-code / feature-implementer) — differs, isolation OK
VERIFICATION_RERUN:
  command: npx vitest run src/ui/__tests__/resultsGridModel.test.ts
  result: 40 pass / 0 fail (exit 0)
  command: npm run typecheck
  result: exit 0
TEST_PLAN_COVERAGE: all-followed (5/5 cases; 3 edge cases ≥ minTestsEdgeCase=2; RED_OUTPUT carries real
  assertion diffs, not a bare claim)
FINDINGS:
  critical:
    - none
  important:
    - file: src/ui/resultsGridModel.ts:95-123 — numeric/boolean families use EXACT token match
      (`typeIs` = `names.includes(t)`, line 128-131) while the string family at :88 accepts a
      `(...)` modifier suffix. The live PostgreSQL producer emits typmod'd type strings:
      src/core/ddl/pgIntrospect.ts:42 `format_type(a.atttypid, a.atttypmod)` → `"numeric(10,2)"`,
      `"decimal(5,2)"`. Verified by probe: `inferColumns(["c"],[[null]],{c:"numeric(10,2)"})` →
      `kind:"string"`, no `alignRight`, whereas bare `"numeric"` → `number`+`alignRight`. That
      breaks Acceptance Criterion 3 ("Null-only declared numeric columns right-align as numbers")
      for the most common PG decimal/money declaration, and the path is live (TASK-007 wired it in
      abde88b via extension.ts:109 listColumnTypes → adapter.listColumns). Correct behavior: apply
      the same family-bounded suffix rule the string branch already uses (accept `name`, `name(...)`)
      to the numeric and boolean lists, and pin it with a `numeric(10,2)` all-NULL test.
    - file: src/ui/resultsGridModel.ts:99-123 — vocabulary is incomplete against the dialects that
      feed it. `double` (MySQL information_schema.data_type, and present in sampleData.ts:84-90's
      float group the comment cites), `tinyint`/`mediumint` (MySQL, src/adapters/mysql.ts:350), and
      `tinyint`/`smallmoney` plus boolean `bit` (MSSQL `ty.name`, src/adapters/mssql.ts:341) all
      return null → silent fallback to sampling. Failure mode is degradation, not corruption, but
      the declared-type override simply does not fire for those columns.
  minor:
    - file: src/ui/resultsGridModel.ts:128-131 — `typeIs` docstring says "membership over a lowercase
      Set" but the parameter is a `readonly string[]` used with `.includes`; it also reuses the name
      of sampleData.ts:39 `typeIs` while implementing DIFFERENT (exact-only) semantics, which is the
      drift trap that produced the finding above. Rename or restate the contract.
    - file: src/ui/__tests__/resultsGridModel.test.ts:178-227 — no case exercises a type string
      carrying a precision/typmod suffix, which is why the gap passed green.
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: String family IS a faithful verbatim copy of queryComposer.isStringColumnType (:104-110) with a
  greppable citation, name-keyed design is documented and correct for this layer, no production
  webview/protocol file was touched by this task, and the omitted-3rd-arg path is provably unchanged.
  The single blocking defect is the numeric/boolean matcher's exact-match asymmetry vs. PG typmod output.

## Fix Response (R4.5 round 1)

RESPONDER_MODEL: bao-sonnet
FIX_SUMMARY: Extended declared numeric and boolean classification to use a family-bounded optional parenthesized modifier match, added numeric tokens tinyint, mediumint, double, smallmoney and boolean token bit, and added typmod, vocabulary, regression, and lookalike/embedded-junk tests. No call sites or prohibited production files were changed.
RED_OUTPUT: |
  npx vitest run src/ui/__tests__/resultsGridModel.test.ts 2>&1
  ❯ src/ui/__tests__/resultsGridModel.test.ts  (45 tests | 3 failed) 14ms
   ❯ ... > Happy: declared numeric(10,2) classifies all-NULL data as number + alignRight
     → expected [ { field: 'price', …(2) } ] to deeply equal [ { field: 'price', …(3) } ]
   ❯ ... > Extended numeric tokens: tinyint/mediumint/double/smallmoney -> number + alignRight
     → expected [ { field: 'a', …(2) }, …(3) ] to deeply equal [ { field: 'a', …(3) }, …(3) ]
   ❯ ... > Extended boolean token: bit and bit(1) -> boolean
     → expected [ { field: 'f1', …(2) }, …(1) ] to deeply equal [ { field: 'f1', …(2) }, …(1) ]
  Test Files  1 failed (1)
       Tests 3 failed | 42 passed (45)
  First failure detail:
  - Expected: { alignRight: true, field: "price", headerName: "price", kind: "number" }
  + Received: { field: "price", headerName: "price", kind: "string" }
Verification Output: |
  npx vitest run src/ui/__tests__/resultsGridModel.test.ts
   ✓ src/ui/__tests__/resultsGridModel.test.ts  (45 tests) 7ms
    Test Files 1 passed (1)
         Tests 45 passed (45)
    EXIT_VITEST=0

  Required aggregate command:
  npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts src/ui/__tests__/keysetPaging.test.ts src/ui/__tests__/webviewServerSort.test.ts && npm run typecheck && npm run compile
   ✓ resultsGridModel.test.ts (45 tests)
   ✓ resultsGridModelRequery.test.ts (21 tests)
   ❯ keysetPaging.test.ts (40 tests | 4 failed)
   ✓ webviewServerSort.test.ts (14 tests)
    Test Files 1 failed | 3 passed (4)
         Tests 4 failed | 116 passed (120)
    EXIT_VITEST=1; npm run typecheck and npm run compile were not reached by the chain.

  npm run typecheck (run separately):
   > vsdb@1.6.7 typecheck
   > tsc --noEmit
  src/ui/keysetPaging.ts(578,3): error TS1128: Declaration or statement expected.
  src/ui/keysetPaging.ts(607,1): error TS1128: Declaration or statement expected.
  EXIT_TYPECHECK=2

  npm run compile (run separately):
   ✘ [ERROR] Unexpected ")"
    src/ui/keysetPaging.ts:578:2
  Error: Build failed with 1 error
  EXIT_COMPILE=1
Status: FAIL

Note: The requested aggregate verification is blocked by unrelated pre-existing modifications in prohibited src/ui/keysetPaging.ts (4 targeted test failures and syntax errors at lines 578/607). Focused resultsGridModel tests pass 45/45.

---


## Re-Review (R4.5 round 1)

VERDICT: APPROVED
REVIEWER_MODEL: bao-opus (configured reviewer alias: unic-smart)
EXECUTOR_MODEL: bao-sonnet
MODEL_ISOLATION: PASS — executor and reviewer models differ.
EVIDENCE:
- Fix Response R4.5 has real RED output (3 assertion failures) and its FAILED aggregate status was caused by the concurrent TASK-004 `keysetPaging.ts` edit; it does not affect the focused TASK-003 result.
- `src/ui/resultsGridModel.ts:88-134`: `numeric(10,2)`, `varchar(50)`, `bit(1)`, `double precision`, and `character varying(20)` classify in their intended families. `^... (\s*\(|$)` anchors prevent `numericonly`, `myint`, and `fbit` partial matches; numeric alternatives place the overlapping longer terms before `int`.
- Bare `bit`/`bit(1)` as boolean is defensible for the supported MySQL/MSSQL boolean-capable metadata convention. Unsupported `geometry`, `json`, `uuid`, and `char-bytea` do not match either changed numeric/boolean family and retain the null-to-sampling path.
- TASK-003-scoped commit paths are limited to `src/ui/resultsGridModel.ts`, `src/ui/__tests__/resultsGridModel.test.ts`, and this task file; other commit paths belong to concurrent TASK-004/TASK-007 work.
- Fresh verification: `npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/resultsGridModelRequery.test.ts && npm run typecheck` — 2 files / 66 tests passed; `tsc --noEmit` passed.
FINDINGS: none.
