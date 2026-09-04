# TASK-UX2-001 — Error card renders for SELECT-failure and connection-failure

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3

## Goal

Extend `ddlStatusCard.ts` so the error card surfaces for **all** failure paths, not
only `kind: "ddl" | "dml" | "other"`. Today `classifyPanelKind` returns `"grid"`
for `kind === "select"`, which means a failed SELECT (e.g. `SELECT * FROM
nonexistent`) gets an empty grid with no error message. Today connection-failure
rows have no `kind` at all and likewise fall through to the empty grid. Both
should render the error card.

## Target Files

- `src/ui/ddlStatusCard.ts` — extend `classifyPanelKind` so `kind === "select" &&
  status === "error"` and `kind === undefined && status === "error"` both return
  `"card"`. Add `"connection-error"` to `BuildCardOutput["kind"]`. No new hint
  regexes — `extractHint` already supports `LINE N:` and `character N`.
- `src/ui/__tests__/ddlStatusCard.test.ts` — extend with the 7 new test cases
  from PLAN §4.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | unit | `classifyPanelKind({kind:"select", status:"error"})` returns `"card"` | `"card"` | legacy SELECT with error |
| 2 | unit | `buildDdlCardText` for SELECT+error produces `variant:"error"`, `errorText` byte-identical, `hint` from `LINE N` regex (or undefined if no parseable hint) | match | pg syntax error text |
| 3 | edge | `classifyPanelKind({status:"error", error:"ECONNREFUSED"})` (no `kind`) returns `"card"` | `"card"` | synthetic connection-error row |
| 4 | edge | `buildDdlCardText` with empty `error` string produces `variant:"error"`, `errorText:""`, no `hint` | match | empty error string |
| 5 | edge | `extractHint("LINE 5: ... at character 12")` returns `"near LINE 5, position 12"` | match | multi-marker pg error |
| 6 | regression | `classifyPanelKind({kind:"select", status:"done"})` still returns `"grid"` (UX1-010 untouched) | `"grid"` | healthy SELECT |
| 7 | unit | `buildDdlCardText` for connection-error returns `kind:"connection-error"`, `variant:"error"`, `title:"Connection failed"`, `meta:"<durationMs>ms"` | match | synthetic row |

## Test Files

- `src/ui/__tests__/ddlStatusCard.test.ts` (extend).

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test src/ui/__tests__/ddlStatusCard.test.ts
```

Note: there is no `npm run lint` script in this repo (package.json has only
`compile`, `test`, `typecheck`, `verify:*`, `package`). `typecheck` is the
project's static gate; `compile` is the build.

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (7/7).
- [ ] `classifyPanelKind` semantics documented inline (decision: SELECT+error
      and no-kind+error now return `"card"`).
- [ ] `BuildCardOutput["kind"]` extended to include `"connection-error"`
      without breaking existing consumers.
- [ ] No regression in `ddlStatusCard.test.ts` (existing UX1-010 cases
      unchanged).
- [ ] Pure functions, no DOM, no new allocations in the hot loop.

## Dependencies

- (none)

## Interfaces

- Consumes: (none — pure extension of an existing module)
- Produces:
  - `classifyPanelKind(r: StatementResultLike): "grid" | "card"` — semantic
    change (now returns `"card"` for SELECT+error and no-kind+error).
  - `BuildCardOutput["kind"]` now includes `"connection-error"`.

---

## Discussion

(no comments yet)
