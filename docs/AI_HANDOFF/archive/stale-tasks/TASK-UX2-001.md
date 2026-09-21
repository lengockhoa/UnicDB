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

---

## Executor Report

- **EXECUTOR_MODEL**: `unic-code` (claude-sonnet)
- **Worktree**: `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/UX2-001`
- **Files changed** (absolute paths):
  - `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/UX2-001/src/ui/ddlStatusCard.ts`
  - `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/UnicDB/.worktrees/UX2-001/src/ui/__tests__/ddlStatusCard.test.ts`

### RED phase — 3 of 7 new tests failed as expected

Command: `npm test -- src/ui/__tests__/ddlStatusCard.test.ts`

```
 ❯ src/ui/__tests__/ddlStatusCard.test.ts  (17 tests | 3 failed) 6ms
   ❯ classifyPanelKind — UX2-001 case 1 (SELECT+error returns 'card') > routes a legacy SELECT with status:'error' to the error card
     → expected 'grid' to be 'card' // Object.is equality
   ❯ classifyPanelKind — UX2-001 case 3 (no-kind+error returns 'card') > routes a connection-error row (no kind field) to the card
     → expected 'grid' to be 'card' // Object.is equality
   ❯ buildDdlCardText — UX2-001 case 7 (connection-error card) > renders kind:'connection-error' with title 'Connection failed' and meta '<durationMs>ms'
     → expected 'other' to be 'connection-error' // Object.is equality

 Test Files  1 failed (1)
      Tests  3 failed | 14 passed (17)
```

Cases 2, 4, 5, 6 already passed in the RED phase because the current code
already handled them (SELECT+error with `variant:"error"`, empty error,
healthy SELECT, `extractHint` multi-marker).

### GREEN phase — 17/17 pass

Command: `npm test -- src/ui/__tests__/ddlStatusCard.test.ts`

```
 ✓ src/ui/__tests__/ddlStatusCard.test.ts  (17 tests) 3ms

 Test Files  1 passed (1)
      Tests  17 passed (17)
```

(10 pre-existing UX1-010 cases + 7 new UX2-001 cases, all green.)

### typecheck

Command: `npm run typecheck`

Exit code 0, no output. Clean.

### Full suite — baseline check

Command: `npm test` (worktree)

```
 Test Files  8 failed | 196 passed | 29 skipped (233)
      Tests  20 failed | 3198 passed | 243 skipped (3461)
```

The 20 failures are all pre-existing environmental issues in this worktree
(ENOENT for `node_modules/.bin/esbuild` and `dist/consolePanel.js missing`).
They are unrelated to TASK-UX2-001 and reproduce on a clean `main` checkout
in the same worktree (no worktree, no dist). The plan's expected baseline
`3530|2` matches the main-repo `npm test` run verbatim (3530 passed, 2
skipped, 0 failed in 233 files).

The worktree's `ddlStatusCard.test.ts` itself passes 17/17 in the full run:

```
 ✓ src/ui/__tests__/ddlStatusCard.test.ts  (17 tests) 20ms
```

### Code changes summary

`src/ui/ddlStatusCard.ts`:
- `classifyPanelKind`: added `if (r.status === "error") return "card";` as
  the first check so any error — including `select+error` and no-kind
  connection-failure rows — routes to the error card. The BQ-pending
  no-kind-running path still returns "grid" because the error check
  short-circuits before it.
- `BuildCardOutput["kind"]` extended with `"connection-error"`.
- `buildDdlCardText`: added an early return for the synthetic
  `kind === undefined && sql === "(connection)"` connection-failure row,
  producing `kind: "connection-error"`, `title: "Connection failed"`,
  `meta: "<durationMs>ms"`, with `extractHint` for the hint. The happy
  path (DDL/DML/other with `kind` set) is byte-identical to the previous
  implementation.

### Status

DONE. Ready for review. Worktree left dirty per instructions.

---

## Reviewer Verdict

VERDICT: approved
REVIEWER_MODEL: unic-smart (claude-opus)
EXECUTOR_MODEL: unic-code (claude-sonnet) — differs, isolation OK
VERIFICATION_RERUN:
  command: npm run typecheck && npm run compile && npm test src/ui/__tests__/ddlStatusCard.test.ts
  result: typecheck exit 0; compile exit 0; 17 pass / 0 fail (10 UX1-010 + 7 UX2-001);
  full suite regression net: 3555 pass / 0 fail / 2 skipped (235 files)
TEST_PLAN_COVERAGE: all-followed — 7/7 spec cases present (test file lines 241-357);
  RED_OUTPUT in the executor report is real failing vitest output (3 targeted failures on
  classify/connection-error paths); each new test maps 1:1 to spec cases 1-7
FINDINGS:
  critical:
    - (none)
  important:
    - (none)
  minor:
    - src/ui/ddlStatusCard.ts:158-162 — a SELECT+error card falls through kindLabel to
      "Other" → title "Other statement" (or "<commandTag> (Other)"). Spec case 2 does not
      require a SELECT-specific label, but the title is mildly misleading for a failed
      SELECT; consider a "SELECT statement" label in a follow-up.
    - src/ui/__tests__/ddlStatusCard.test.ts:272 — hint assertion is conditional
      (`if (card.hint !== undefined)`): if extractHint ever regressed, case 2 would
      silently skip the LINE-2 expectation instead of failing. An unconditional
      `expect(card.hint).toContain("LINE 2")` is stricter; spec wording permits either.
    - src/ui/ddlStatusCard.ts:143 — sentinel `sql === "(connection)"` duplicates the
      producer literal at src/core/queryRunner.ts:811 as a stringly-typed contract; a
      shared exported constant would prevent silent drift. Non-blocking.
NEXT_STATUS_FOR_INDEX: approved
NOTES: Independently re-verified (replaced a prior uncommitted draft verdict block).
  classifyPanelKind's error short-circuit preserves no-kind+non-error → "grid" (BQ-pending)
  and select+done → "grid"; the connection-error sentinel matches runFailed's production
  row exactly; webview/main.ts consumes card fields by name (no exhaustive switch on
  `kind`), so the union extension breaks no consumer.
