# TASK-002 — Webview grid: stale values after commit, Add Row, marker collision, Refresh, copy

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.1 / §3.2 / §3.3 — §7 Global Constraints applies by reference

## Goal

Make the grid tell the truth and make Add Row actually insert. Fixes A5 (grid shows stale values
after a successful commit), A6 (Add Row sends `values` as a `Record`, so the INSERT is always
skipped — same bug in the redo path), A7 (insert/delete markers stored at `colIndex 0` are
destroyed by typing in column 0), A11-producer (blank cells sent as `""`), A12-producer (the
`serverIndexByRowId` map exists but is never sent) and A13 (Refresh silently discards unsaved
edits and never messages the host), A16 (Ctrl+C leaks hidden columns, ignores a focused range,
and fires twice).

## Target Files

- `webview/main.ts`
- `src/ui/messages.ts`
- `src/ui/__tests__/webviewSaveEdits.test.ts`
- `src/ui/__tests__/webviewEdit.test.ts`
- `src/ui/__tests__/webviewCommitRefresh.test.ts` (new)

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | commit → fresh values | same statement + same row count + changed values ⇒ `setGridOption("rowData", …)` called with the refreshed rows |
| Happy | Add Row → commit payload | `edits[0].value.values` is an `unknown[]` of `columns.length` |
| Edge (collision) | Add Row then type in column 0 | `editState.snapshot()` contains the insert marker **and** the cell edit (2 entries) |
| Edge (idempotent) | commit with unchanged values | exactly one render, no duplicate `applyTransaction`, `dirtyCount === 0` after ack |
| Edge (permission/confirm) | Refresh with `dirtyCount > 0` | confirm shown; decline ⇒ `dirtyCount` unchanged and no host message; accept ⇒ one `requery`-style message posted |
| Edge (double-fire) | one Ctrl+C keypress | exactly **1** `copy` message posted |
| Edge (hidden column) | copy with `spec.hidden` column | hidden column absent from the copied TSV |
| Edge (duplicate names) | `SELECT a.id, b.id` with the 2nd column hidden, then copy/export | specs are `id` / `id__2` (TASK-003) but `hiddenColumns` is `["id"]` — derived from `headerName`, matching the raw `result.columns` the serializer compares against; the hidden column is still excluded from both the TSV and the export |
| Edge (duplicate names, values) | `SELECT a.id, b.id` with **distinct** values, Add Row then Ctrl+C | the copied row carries **both** values in column order (`r["id"]`, `r["id__2"]`) — i.e. `:1855`/`:2199` stayed keyed on `field`; keying them on `headerName` collapses both columns onto one value and this case catches it |
| Edge (focus vs selection) | Ctrl+C with a focused cell and no checkbox selection | copies the focused cell/range, not `""` |
| R (A5) | same statement, same row count, new values | today the grid renders stale cells |
| R (A6) | Add Row payload shape | today `values` is a `Record`; builder warns `values length (?)` and skips |
| R (A7) | marker + column-0 edit | today `markDirty` coalesces and the insert marker is lost |
| R (A12) | saveEdits message | today has no `serverIndexByRowId`; after fix it carries the map for every rendered row |
| R (A13) | Refresh click | today posts nothing to the host |

## Test Files

- `src/ui/__tests__/webviewSaveEdits.test.ts` (extend — A6/A7/A12 payload)
- `src/ui/__tests__/webviewEdit.test.ts` (extend — marker/cell coexistence)
- `src/ui/__tests__/webviewCommitRefresh.test.ts` (new — A5 re-render branch, A13 confirm, A16 copy)

## Verification Commands

```bash
npm run typecheck
npm run compile
npm test -- src/ui/__tests__/webviewSaveEdits.test.ts
npm test -- src/ui/__tests__/webviewEdit.test.ts
npm test -- src/ui/__tests__/webviewCommitRefresh.test.ts
npm test -- src/ui/__tests__/webviewExport.test.ts
npm test -- tests/webviewUndoRedo.test.ts
npm test -- src/ui/__tests__/webviewBundle.test.ts
```

## Acceptance Criteria

- [ ] All 15 cases pass; every regression case confirmed failing on `main` first, output pasted
      into the task report.
- [ ] **`hiddenColumns` is derived from `spec.headerName`, not `spec.field`** — exactly one site:
      `webview/main.ts:2111-2113`. That list is the only spec-derived value that crosses into the
      serializers, which match it against the **raw** `result.columns`
      (`resultsGridModel.ts:470,610`). TASK-003 lands in this same wave and makes `field` unique
      (`id` → `id__2`), so left on `field` a duplicate-named hidden column silently stops being
      excluded from export and copy.
- [ ] **The new Ctrl+C hidden-column filter (A16) filters on the boolean `spec.hidden` and still
      indexes rows by `spec.field`** (`r[s.field]`, `webview/main.ts:2199`). It needs no name
      matching at all, so it must not be "converted" to `headerName`.
- [ ] **`webview/main.ts:1855` and `:2199` MUST STAY on `field`** (narrowed in review round 2 —
      the round-1 wording wrongly told you to audit them toward `headerName`). Both are
      **object-key** uses, not database-name uses: `:1855` builds the blank Add-Row object
      (`blank[col.field] = ""`) and `:2199` reads it back (`r[s.field]`), and those keys are
      produced by `rowsToObjects` at `:397` from `s.field`. Moving either to `headerName` breaks
      Ctrl+C and Add Row for duplicate-named columns the moment TASK-003 lands. If you touch
      either line, you have made the bug worse — leave them.
- [ ] `renderGrid` gains a third branch (same statement, same row count, values differ) that
      swaps `rowData`; the reset and append-delta branches are unchanged.
- [ ] Add Row and its redo path both emit `values: unknown[]` of exactly `columns.length`, using
      `{__vsdb_default__: true}` for untouched cells — never `""`.
- [ ] Markers use named constants `MARKER_COL_INSERT = -1` / `MARKER_COL_DELETE = -2`, **declared
      locally in `webview/main.ts`** (see Interfaces — do not import them from
      `src/core/saveStatements.ts` this wave), never literal `0`.
- [ ] `saveEdits` carries `serverIndexByRowId` built from the existing module-level
      `serverIndexByRowId` map (`webview/main.ts:221`).
- [ ] Refresh posts to the host and confirms before discarding dirty edits.
- [ ] Ctrl+C is bound in exactly one place (the duplicate at `webview/main.ts:720` **or**
      `onCellKeyDown:1537` is removed, not both left in) and filters `spec.hidden` the same way
      the export path does.
- [ ] `npm run compile` succeeds; `npm run typecheck` clean.

## Dependencies

none

## Interfaces

**Consumes** — a **wire contract only**, fixed in PLAN §3.2 / §3.3. TASK-001 defines the
authoritative host-side types *in the same wave*, so importing them here would break
`npm run typecheck` depending on landing order. Declare these locally in `webview/main.ts` and
pin the values with a test; TASK-001 pins the identical values on the host side:

```ts
// local to webview/main.ts — MUST match src/core/saveStatements.ts (TASK-001)
const MARKER_COL_INSERT = -1;
const MARKER_COL_DELETE = -2;
// emitted for untouched new-row cells; plain literal, survives structured cloning
const DEFAULT_CELL = { __vsdb_default__: true } as const;
```

**Produces** (`src/ui/messages.ts`):

```ts
export interface SaveEditsMessage {
  type: "saveEdits";
  index: number;
  edits: Array<{ rowId: number; colIndex: number; value: unknown }>;
  tableName: string | null;
  pkColumns: string[];
  /** NEW (cycle T, A12): __rowId → index into the host's result.rows.
   *  Keys are stringified numbers (JSON). Absent ⇒ host falls back to rowId. */
  serverIndexByRowId?: Record<string, number>;
}
```

Existing, unchanged: `postToHost(msg: WebviewMsg): void` (`webview/main.ts:144`),
`rowsToObjects(rows, specs, startIndex?, sourceIndexStart?)` (`webview/main.ts:373`).

---

## Discussion

- **Why this task owns `src/ui/messages.ts`:** `postToHost` is typed as `WebviewMsg`, so the new
  field must exist in the type for the webview to compile. TASK-009 (host) only *reads* it and
  runs in a later wave, so there is no same-wave collision.
- **A5 detection:** compare the incoming `r.result.rows` against `statementRows.get(activeTab)`
  (already maintained) rather than adding state. Do not route this through
  `resultsGridModel.shouldResetGrid` — that file belongs to TASK-003 this wave.
- **A16 double-binding:** confirm which of the two handlers actually reaches the AG Grid focused
  range before deleting one; the capture-phase binding at `:720` is the likelier keeper because
  `onCellKeyDown` only fires when a cell has focus.
- **`headerName` coupling (moved here in review round 1, narrowed in round 2):** TASK-003 makes
  `ColumnSpec.field` unique but must not edit `webview/main.ts`, which this task owns in the same
  wave — so the consumer-side fix lives here. It does **not** depend on TASK-003 landing first:
  with distinct column names `field === headerName`, so the change is a no-op until TASK-003 lands.
  The discriminator is **what the value is used as**, and it is a one-site change:
  - `field` = **object key** into a row produced by `rowsToObjects` (`:397`). Keep: `:1855`,
    `:2199`, and the A16 copy filter's row indexing.
  - `headerName` = **database column name** crossing a module boundary. Change: `hiddenColumns`
    (`:2111-2113`) only, because the serializers compare it to raw `result.columns`.
  Round 1 wrongly lumped `:1855`/`:2199` into the second group; they are firmly in the first.
- Blank-cell sentinel is a plain object literal — it survives `postMessage` structured cloning.
  Do not use `undefined` (arrays serialize it to `null`) or a magic string.

---
