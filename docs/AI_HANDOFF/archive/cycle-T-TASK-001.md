# TASK-001 — Save builder: schema qualification, PG quoting, DEFAULT inserts, row addressing

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 / §3.2 — §7 Global Constraints applies by reference

## Goal

Make `buildSaveStatements` address the right table, the right identifiers and the right row.
Fixes A8 (schema dropped → `search_path` roulette), A9 (PG identifiers emitted bare → wrong or
missing table), A10-remainder (MySQL/MSSQL no-PK DELETE is a silent no-op), A11 (blank cells sent
as `''` instead of letting the column DEFAULT apply), A12 (host type for the row-index remap) and
A20 (`parseFromClause` is O(n²)).

Concretely:

1. `buildSaveStatements` takes the parsed **schema** and emits `"schema"."table"` when present.
2. `quoteIdent(name, "postgres")` double-quotes and escapes (`"` → `""`) instead of returning the
   raw name; the `isSafeIdent` gate at `saveStatements.ts:286` relaxes accordingly so mixed-case,
   spaced and non-ASCII identifiers are quoted rather than refused.
3. Non-postgres no-PK DELETE pushes an explicit warning instead of `continue`.
4. `DefaultValueMarker` — INSERT omits untouched columns; all-untouched ⇒ `DEFAULT VALUES`.
5. `SaveStatementsOptions.serverIndexByRowId` remaps `rowId` → index into `serverRows` for both
   the UPDATE and the DELETE branch; `ctidByRowId` is documented as keyed by **rowId**.
6. `parseFromClause` scans skipped regions once (single forward pass) instead of calling
   `inSkippedRegion` per character.
7. Negative marker `colIndex` (-1 insert, -2 delete) must never reach `columns[e.colIndex]`.
8. **A19-skip (§3.4a)** — `SaveStatementsOk` gains `skippedRows?: ReadonlyArray<{rowId, reason}>`.
   Today a skipped row vanishes into a prose `warnings` string (or into nothing at all) and the
   webview clears the user's edit as if it had been saved. `warnings` keeps its current copy
   (back-compat); `skippedRows` is the machine-readable twin TASK-009 forwards.

   **Apply the structural rule from §3.4a, not a line-number checklist:** *every `continue` or
   `break` in the three build loops that leaves a row's edits unemitted records an entry.* Derive
   the set by reading the loops — the list below is illustrative and was already found incomplete
   once (review round 2). Confirmed sites at HEAD:

   | Site | Warns today? |
   |------|--------------|
   | `:334-338` insert `values` length ≠ column count | yes |
   | `:350`+`:367` non-postgres no-PK DELETE | **no** — item 3 adds the warning; add the entry too |
   | `:354-357` delete, postgres no-PK + missing ctid | yes |
   | `:371-373` delete, no server row | yes |
   | `:379-384` delete, PK column not in result (**`break`** ⇒ no emit at `:390`) | yes |
   | `:443-448` update, unknown col index (**cell-level** — the row may still emit) | yes |
   | `:453` `cols.length === 0` | **NO** — a `warnings.push` grep will not find this one |
   | `:465-467` only PK columns edited | yes |
   | `:471-474` update, no server row | yes |
   | `:478-485` + `:491` update, PK column missing (`break` then `continue`) | yes |
   | `:497-502` update, postgres no-PK + missing ctid | yes — **the live path**: A3 makes ctid resolution fail for every row today, so this is the one users actually hit |

   **Must NOT be recorded:** `:436` (`insertRowIds.has(rowId)`) — that row is covered by its own
   INSERT, and an entry there would show the user a false "edit lost" banner. `:432` (`!rowEdits`)
   is defensive and unreachable.

## Target Files

- `src/core/saveStatements.ts`
- `src/adapters/__tests__/saveStatements.test.ts`
- `src/adapters/__tests__/saveStatementsParser.test.ts`
- `src/adapters/__tests__/saveStatementsQualify.test.ts` (new)

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | qualified UPDATE | `buildSaveStatements("postgres", "orders", …, {schema:"analytics"})` → `UPDATE "analytics"."orders" SET …` |
| Happy | unqualified UPDATE unchanged | no schema ⇒ `UPDATE "orders" SET …` (no leading dot) |
| Edge (quoting) | mixed case | `quoteIdent('createdAt','postgres')` → `"createdAt"`; `quoteIdent('a"b','postgres')` → `"a""b"` |
| Edge (boundary) | all-DEFAULT insert | every value `{__UnicDB_default__:true}` ⇒ exactly `INSERT INTO "public"."t" DEFAULT VALUES` |
| Edge (boundary) | partial-DEFAULT insert | 3 cols, col 2 default ⇒ column list has 2 entries, col 2 absent |
| Edge (ordering) | remapped row | `serverIndexByRowId = Map([[4,3]])` ⇒ WHERE built from `serverRows[3]` |
| Edge (malformed) | negative colIndex | marker at `colIndex:-1` never produces `skipped unknown col index`; no `columns[-1]` read |
| Edge (permission-ish) | MySQL no-PK delete | `warnings` contains `no primary key`; `statements` empty; `skippedRows` contains `{rowId: <that row>, reason: /no primary key/}` |
| Edge (partial skip) | 3 dirty rows, row 2 has no server row | `ok:true`, `statements.length === 2`, `skippedRows` is exactly `[{rowId:2, …}]` — the two good rows still emit |
| Edge (nothing skipped) | all rows emit | `skippedRows` is `undefined` or `[]` (never a phantom entry) |
| Edge (no-warning drop) | row whose only edits hit unknown col indexes ⇒ `cols.length === 0` at `:453` | `skippedRows` contains that `rowId`; `warnings` may stay silent, so this case must assert on `skippedRows`, not on warning text |
| Edge (false positive guard) | row with **both** an insert marker and cell edits | one INSERT emitted, `skippedRows` does **not** contain that rowId (the `:436` skip is correct behavior, not data loss) |
| R (A8) | `analytics.orders` today | today emits `UPDATE orders`; after fix `UPDATE "analytics"."orders"` |
| R (A9) | table `Users` | today emits `UPDATE Users`; after fix `UPDATE "Users"` |
| R (A11) | blank new-row cell | today `INSERT … VALUES ('')` for a numeric column; after fix column omitted |
| R (A12) | rowId 4 / serverIndex 3 | today WHERE from `serverRows[4]` (wrong record); after fix `serverRows[3]` |
| R (A20) | 200 KB SQL through `parseFromClause` | completes < 50 ms; today quadratic |
| R (A19-skip) | edit row 2 (no server row) + row 1 (valid), postgres | today: `ok:true`, one statement, row 2's edit reported nowhere machine-readable ⇒ webview discards it; after fix `skippedRows` names rowId 2 |
| R (A19-skip, live path) | postgres table with **no PK**, `ctidByRowId` empty (what A3 produces today), one cell edit | today `ok:true` with **zero** statements and only a prose warning ⇒ the webview clears the edit as saved; after fix `skippedRows` is `[{rowId, reason:/no-PK \+ missing ctid/}]` (path `:497-502`) |

## Test Files

- `src/adapters/__tests__/saveStatements.test.ts` (extend)
- `src/adapters/__tests__/saveStatementsParser.test.ts` (extend — A20 perf + skipped regions)
- `src/adapters/__tests__/saveStatementsQualify.test.ts` (new — A8/A9/A11/A12)

## Verification Commands

```bash
npm run typecheck
npm test -- src/adapters/__tests__/saveStatements.test.ts
npm test -- src/adapters/__tests__/saveStatementsParser.test.ts
npm test -- src/adapters/__tests__/saveStatementsQualify.test.ts
npm test -- src/adapters/__tests__/saveStatementsInline.test.ts
```

## Acceptance Criteria

- [ ] All 19 test cases above pass; each regression case was confirmed **failing on `main`
      first** and the failing output is pasted into this task's report.
- [ ] `UPDATE`, `DELETE` and `INSERT` all emit `"schema"."table"` when a schema is parsed.
- [ ] No PG identifier is ever emitted unquoted; `isSafeIdent` no longer refuses identifiers the
      browse path already handles.
- [ ] `serverIndexByRowId` applies to **both** the UPDATE and the DELETE branch; absent option ⇒
      byte-identical output to today (back-compat test).
- [ ] `ctidByRowId` doc comment states it is keyed by `rowId` (not server index).
- [ ] `inSkippedRegion` is no longer called per character.
- [ ] **Every non-emitting `continue`/`break` in the three build loops records a `skippedRows`
      entry** carrying that row's `rowId`. Enumerate by reading the loops, **not** by grepping
      `warnings.push` — `:453` drops a whole row with no warning at all, so a grep-based audit
      misses it. List every site you found in the report, and state explicitly that `:436`
      (insert-covered row) is excluded on purpose.
- [ ] The postgres no-PK UPDATE path (`:497-502`) records an entry. This is the most reachable
      case in the file — with A3 unfixed, ctid resolution fails for every row — so a
      `skippedRows` implementation that misses it fixes nothing users would notice.
- [ ] `npm run typecheck` clean; no change to any file outside Target Files.

## Dependencies

none

## Interfaces

**Consumes** (existing, unchanged):

```ts
export interface EditEntry { rowId: number; colIndex: number; value: unknown; }
export interface NewRowMarker { __UnicDB_new_row__: true; __rowId: number; values: unknown[]; }
export interface DeleteRowMarker { __UnicDB_deleted__: true; __rowId: number; }
export interface ParsedFrom { schema?: string; table: string; }
```

**Produces**:

```ts
// signature gains `schema` — pass through from ParsedFrom
export function buildSaveStatements(
  dialect: Dialect,
  tableName: string,
  pkColumns: string[],
  columns: string[],
  edits: EditEntry[],
  serverRows: unknown[][],
  options?: SaveStatementsOptions,
): SaveStatementsResult;

export interface SaveStatementsOptions {
  /** rowId → ctid. KEYED BY rowId (not server index). */
  ctidByRowId?: ReadonlyMap<number, string>;
  /** NEW (A12): rowId → index into `serverRows`. Absent ⇒ identity. */
  serverIndexByRowId?: ReadonlyMap<number, number>;
  /** NEW (A8): schema from ParsedFrom; absent ⇒ unqualified emit. */
  schema?: string;
}

export interface SaveStatementsOk {
  ok: true;
  statements: string[];
  warnings: string[];
  /** NEW (A19-skip, §3.4a): rows whose edits produced NO statement, so the host can
   *  keep them dirty instead of the webview clearing them as saved. */
  skippedRows?: ReadonlyArray<{ rowId: number; reason: string }>;
}

export interface DefaultValueMarker { __UnicDB_default__: true }
export function isDefaultValueMarker(v: unknown): v is DefaultValueMarker;
export function quoteIdent(name: string, dialect: Dialect): string; // pg now quotes

/** Reserved marker slots. TASK-002 declares the same two values locally in
 *  webview/main.ts (same wave — it must not import from here). Values must match. */
export const MARKER_COL_INSERT = -1;
export const MARKER_COL_DELETE = -2;
```

---

## Discussion

- **Signature choice:** `schema` goes into `options` rather than a 8th positional parameter so
  every existing call site and test keeps compiling; `resultsPanel.ts` (TASK-009) then passes
  `{ schema: parsed.schema }`.
- `MARKER_COL_INSERT/DELETE` are exported here (host-side module, importable by both webview and
  host) so TASK-002 does not hardcode `-1`/`-2`.
- Back-compat is load-bearing: TASK-002 and TASK-009 land in different waves, so every new option
  must be optional and absent ⇒ today's behavior.
- `quoteIdent` is already exported and reused by `resultsPanel.fetchPostgresCtids`; quoting PG
  identifiers there is a *fix* (that path builds `WHERE "col" IS NOT DISTINCT FROM …` on
  user-named columns), but verify no test asserts the bare-name output.

### Executor judgment calls (recorded per Handoff-mode ambiguity protocol)

- **`:443` (cell-level unknown col index) records a `skippedRows` entry even though the row may
  still emit a statement.** Both this task's own site table and PLAN.md §3.4a instruct recording
  it. Consequence accepted: if *every* cell edit on a row hits an unknown col index, that row can
  get two entries (one per dropped cell at `:443`, one for the whole-row drop at `:453`/
  `cols.length === 0`). No test forbids duplicate entries for that edge case, so this was left
  as-is rather than de-duplicated.
- **`sortedRowIds.length > 0` narrows the mysql/mssql no-PK hard-refusal.** The unconditional
  `!hasPk && dialect !== "postgres" ⇒ {ok:false, reason:"no_pk"}` guard made Test Case row 75
  (MySQL no-PK delete-only batch expecting `ok:true` + `skippedRows`) impossible to satisfy,
  since `SaveStatementsRefused` has no `skippedRows` field. Narrowed the guard to only hard-refuse
  when there is at least one *cell edit* (UPDATE) needing a PK-based WHERE; delete-only/insert-only
  batches on no-PK non-postgres tables now proceed to `ok:true` with a per-row soft-skip (warning +
  `skippedRows` entry) instead of a blanket refusal. A dedicated test locks in that the old
  hard-refusal behavior is unchanged for actual cell edits on a no-PK mysql/mssql table.
- **`src/adapters/__tests__/saveStatementsInline.test.ts` was edited even though it is not in
  Target Files**, because it *is* in this task's own Verification Commands and its three bare
  postgres-identifier assertions (`WHERE id=7`, `name=NULL`, `DELETE FROM t WHERE id=42`) are
  made false by the required A9 quoting fix. Verification Commands cannot all pass without either
  editing this file or leaving A9 unimplemented, so the file was treated as implicitly in-scope.
  Only the assertions broken by quoting were touched — no test cases added or removed.
- **`src/ui/__tests__/resultsPanelSaveEdits.test.ts` (3 tests) was deliberately left unedited**
  and is a known, accepted regression outside this task's scope. `resultsPanel.ts` (which this
  file tests) calls the same exported `quoteIdent`, and 3 of its assertions hard-code the old
  bare-identifier / `id=1`-style output. That file and its test are owned by TASK-009 per this
  task's own Discussion note above ("`resultsPanel.ts` (TASK-009) then passes `{ schema:
  parsed.schema }`"), and neither is in Target Files, Test Files, or Verification Commands here.
  Fixing them would mean editing a file outside Target Files without the context TASK-009 owns
  (e.g. whether/how it plans to pass `schema`). Flagged prominently for TASK-009 pickup — see
  Executor Report below for the exact 3 failing assertions and line numbers.

---

## Executor Report

```
STATUS: DONE
EXECUTOR_TOOL: claude-code
EXECUTOR_MODEL: claude-sonnet-5
EXECUTOR_SUBAGENT: -
SUMMARY: Rewrote buildSaveStatements per the structural skippedRows rule (§3.4a),
  added schema qualification (A8), PG identifier quoting via quoteIdent (A9),
  non-postgres no-PK DELETE now warns instead of silent no-op (A10-remainder),
  DefaultValueMarker sentinel for blank INSERT cells (A11), serverIndexByRowId
  remap for UPDATE + DELETE (A12), single-pass O(n) parseFromClause (A20), and a
  belt-and-suspenders guard against negative marker colIndex reaching columns[].
TEST_PLAN_FOLLOWED: task §Test Cases (19 cases) — all implemented in the 3 Target
  test files, RED-confirmed against the unmodified saveStatements.ts (via git
  stash of only that file), then made GREEN.
FILES_CHANGED:
  - src/core/saveStatements.ts: DefaultValueMarker/isDefaultValueMarker,
    MARKER_COL_INSERT/DELETE exports, SaveStatementsOptions gains
    serverIndexByRowId + schema, SaveStatementsOk gains skippedRows, quoteIdent
    postgres branch now double-quotes + escapes, isSafeIdent relaxed to
    length>0 + no control chars, parseFromClause rewritten as a single forward
    pass (inSkippedRegion helper removed), buildSaveStatements body rewritten:
    schema-qualified qTable, DEFAULT VALUES / partial-DEFAULT INSERT, non-pg
    no-PK DELETE now warns + records skippedRows, serverIndexByRowId applied to
    both UPDATE and DELETE PK branches, mysql/mssql no-PK hard-refusal narrowed
    to only fire when there is an actual cell edit (sortedRowIds.length > 0),
    every non-emitting continue/break across all 3 loops now pushes a
    {rowId, reason} into skippedRows (see full site list below), :436
    (insert-covered row) and :432 (defensive !rowEdits) deliberately excluded,
    negative e.colIndex guarded before indexing columns[].
  - src/adapters/__tests__/saveStatementsQualify.test.ts (new): A8/A9/A11/A12 +
    negative-colIndex tests (16 tests).
  - src/adapters/__tests__/saveStatements.test.ts: updated ~10 bare-postgres-
    identifier assertions to quoted form; rewrote the mysql-no-PK-delete test to
    expect ok:true + skippedRows (behavior change, see Discussion); added a
    dedicated test locking in the old hard-refusal for actual cell edits on a
    no-PK mysql table; added a new "skippedRows (A19-skip, §3.4a)" describe
    block (6 tests: nothing-skipped, partial-skip, no-warning-drop,
    false-positive-guard, live-path postgres-no-PK-UPDATE, non-postgres-no-PK-
    DELETE-now-warns).
  - src/adapters/__tests__/saveStatementsParser.test.ts: quoteIdent postgres
    test updated to assert quoting; added A20 perf test (200 KB SQL through
    parseFromClause, must complete <50ms).
  - src/adapters/__tests__/saveStatementsInline.test.ts: 3 bare-postgres-
    identifier assertions updated to quoted form (WHERE "id"=7, "name"=NULL,
    DELETE FROM "t" WHERE "id"=42) — required by this task's own Verification
    Commands even though not listed in Target Files; see Discussion.
TESTS_ADDED:
  - saveStatementsQualify.test.ts: all 16 tests (new file) — schema
    qualification (A8, 3 tests), quoteIdent postgres (A9, 4 tests),
    DEFAULT-value INSERT (A11, 4 tests), serverIndexByRowId remap (A12, 4
    tests), negative marker colIndex (1 test).
  - saveStatements.test.ts: "skippedRows (A19-skip, §3.4a)" describe block (6
    tests) + "mysql no-PK + CELL EDIT ... still hard refuses" (1 test) + rewrite
    of the mysql-no-PK-delete test (1 test, behavior change).
  - saveStatementsParser.test.ts: "parseFromClause — perf (A20...)" (1 test).

Sites where a non-emitting continue/break now records skippedRows (structural
rule applied by reading the 3 loops, not by grepping warnings.push):
  1. insert: values.length !== columns.length
  2. delete, no PK, postgres, missing ctid
  3. delete, no PK, non-postgres (mysql/mssql) — NEW: was a silent `continue`
     with no warning at all before this task; now warns AND records.
  4. delete, PK present, no server row for the row's resolved server index
  5. delete, PK present, pk column not found in result columns (break)
  6. update, unknown col index (cell-level; row may still emit if other cells
     in the same row DO resolve)
  7. update, cols.length === 0 (whole row dropped; NO warnings.push here,
     confirmed absent in original code — skippedRows is the only signal)
  8. update, only PK columns were edited (setParts.length === 0)
  9. update, PK present, no server row for the row's resolved server index
  10. update, PK present, pk column missing from result columns (break)
  11. update, no PK, postgres, missing ctid — the live path per A3 (unfixed
      elsewhere): with ctidByRowId empty, every no-PK postgres UPDATE hits this.
Excluded on purpose (verified NOT present in skippedRows via dedicated tests):
  - insertRowIds.has(rowId) in loop 3 — row IS addressed, by its own INSERT.
  - !rowEdits in loop 3 — defensive, unreachable (rowId always sourced from
    editsByRow.keys()).

RED_OUTPUT (captured by `git stash push -m task-001-red-evidence -- src/core/saveStatements.ts`,
running the affected suites against the unmodified file, then `git stash pop` to restore the fix):

  npx vitest run src/adapters/__tests__/saveStatementsQualify.test.ts
    Test Files  1 failed (1)
    Tests  14 failed | 2 passed (16)
    (failures: TypeError: isDefaultValueMarker is not a function; bare "UPDATE t"
     / "UPDATE orders" instead of quoted+qualified; WHERE id=14/id=999 instead of
     the A12-remapped id=13/id=3; INSERT ... VALUES ('[object Object]') instead
     of DEFAULT VALUES — full per-test output on disk in the run log, not
     reproduced here as instructed.)

  npx vitest run src/adapters/__tests__/saveStatements.test.ts
    Test Files  1 failed (1)
    Tests  13 failed | 10 passed (23)
    (failures: bare-identifier assertions; skippedRows undefined where a
     [{rowId:2,...}] / [{rowId:3,reason:/no-PK \+ missing ctid/}] was expected;
     mysql-no-PK-delete returned ok:false instead of ok:true+skippedRows;
     mssql-no-PK-delete `r.ok` was false instead of true.)

  npx vitest run src/adapters/__tests__/saveStatementsParser.test.ts -t "quoteIdent"
    Tests  1 failed | 2 passed | 11 skipped (14)
    AssertionError: expected 'users' to be '"users"'

  A20 perf test: running the 200 KB case directly against the unfixed
  inSkippedRegion-based parseFromClause is impractically slow (observed one
  run spin at ~99% CPU for 39+s before being killed) — genuinely O(n²), not a
  timeout artifact. RED evidence captured instead via an isolated Node repro of
  the exact old algorithm at smaller scale, showing clear quadratic scaling:
    5 KB: 25.2 ms
    10 KB: 67.9 ms
    20 KB: 262.5 ms
  (~2.7x time for 2x input twice in a row ⇒ quadratic; 200 KB — the test's
  actual scale — would be on the order of tens of seconds, consistent with the
  observed hang.) Post-fix, the real 200 KB test via the single-pass
  parseFromClause completes in the sub-10ms range as part of the full 61-test
  GREEN run below.

VERIFICATION:
  command: npm run typecheck
  result: exit 0, no output (clean)

  command: npm test -- src/adapters/__tests__/saveStatements.test.ts
  result: 23 passed
  output_excerpt: |
    ✓ src/adapters/__tests__/saveStatements.test.ts  (23 tests) 5ms
    Test Files  1 passed (1)
         Tests  23 passed (23)

  command: npm test -- src/adapters/__tests__/saveStatementsParser.test.ts
  result: 14 passed
  output_excerpt: |
    ✓ src/adapters/__tests__/saveStatementsParser.test.ts  (14 tests) 5ms
    Test Files  1 passed (1)
         Tests  14 passed (14)

  command: npm test -- src/adapters/__tests__/saveStatementsQualify.test.ts
  result: 16 passed
  output_excerpt: |
    ✓ src/adapters/__tests__/saveStatementsQualify.test.ts  (16 tests) 3ms
    Test Files  1 passed (1)
         Tests  16 passed (16)

  command: npm test -- src/adapters/__tests__/saveStatementsInline.test.ts
  result: 8 passed
  output_excerpt: |
    ✓ src/adapters/__tests__/saveStatementsInline.test.ts  (8 tests) 2ms
    Test Files  1 passed (1)
         Tests  8 passed (8)

  command: npm test  (full suite, project baseline check; `dist/` had to be
    built once via `npm run compile` — it was entirely absent in this fresh
    worktree, unrelated to this task's source changes; without it many bundle
    tests report as skipped/fail on a missing artifact rather than exercising
    real behavior)
  result: 1065 passed / 2 skipped / 3 failed (81 files passed, 1 file failed,
    1 file skipped, 83 files total) — vs. stated baseline of 1044 passed / 2
    skipped / 81 files all green on main. Net +21 passing beyond baseline (61
    new tests added across the 3 Target test files, minus the 3 documented
    cross-task failures below). ALL 3 failures are outside this task's scope
    — see ISSUES.
  output_excerpt: |
     Test Files  1 failed | 81 passed | 1 skipped (83)
          Tests  3 failed | 1065 passed | 2 skipped (1070)
       Start at  10:10:11
       Duration  7.26s

ISSUES: 3 pre-existing tests in src/ui/__tests__/resultsPanelSaveEdits.test.ts
  now fail — NOT in this task's Target Files, Test Files, or Verification
  Commands, and NOT fixed here on purpose (see Discussion → "Executor judgment
  calls"). Root cause: resultsPanel.ts's fetchPostgresCtids() reuses the same
  exported quoteIdent(..., "postgres") this task fixed (A9); its own SQL joins
  schema+table with a bare `.` (e.g. today `public.t` unquoted → now
  `"public"."t"`), which 3 hard-coded test assertions don't yet expect:
    - resultsPanelSaveEdits.test.ts:497  (FROM public.t / "public.t" regex)
    - resultsPanelSaveEdits.test.ts:725  (same FROM-clause issue, ctid lookup)
    - resultsPanelSaveEdits.test.ts:1064 (WHERE id=1 → now WHERE "id"=1)
  resultsPanel.ts and this test file are owned by TASK-009 per this task's own
  pre-existing Discussion note. Flagging for TASK-009 to pick up alongside its
  own `{ schema: parsed.schema }` wiring work.
HANDOFF_TO_REVIEWER: yes — handoff.reviewer.enabled per config; set task to
  pending_review in docs/AI_HANDOFF/INDEX.md is the orchestrator's/next step's
  responsibility per the wave procedure.
NEXT: TASK-009 must account for the 3 resultsPanelSaveEdits.test.ts assertions
  above when it lands (same quoteIdent-driven output-shape change). No other
  follow-up identified.
```

---
