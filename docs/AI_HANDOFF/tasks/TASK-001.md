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
| Edge (boundary) | all-DEFAULT insert | every value `{__vsdb_default__:true}` ⇒ exactly `INSERT INTO "public"."t" DEFAULT VALUES` |
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
export interface NewRowMarker { __vsdb_new_row__: true; __rowId: number; values: unknown[]; }
export interface DeleteRowMarker { __vsdb_deleted__: true; __rowId: number; }
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

export interface DefaultValueMarker { __vsdb_default__: true }
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

---
