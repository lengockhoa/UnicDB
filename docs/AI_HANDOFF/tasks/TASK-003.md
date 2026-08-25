# TASK-003 — Webview: server-side sort on header click + distinct-value set filter

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.4 / §3.5

## Goal

Make the grid's own UI drive server-side queries: an AG Grid column-header sort posts a
`requery` carrying the grid's column state as an `orderBy` string (composing with the active
filter), and `SetFilterComponent` populates its checkbox list from host-supplied DISTINCT
values (with their real types) instead of only the loaded rows.

**This task is the sole owner of `webview/main.ts` for the whole cycle.**

## Target Files

- `webview/main.ts` — (a) `orderByFromColumnState()` helper (**including the colId-quoting rule
  below**) + `onSortChanged` on `createGrid` (`:1653`) + `suppressSortRequery` re-entrancy guard;
  (b) `distinctByColumn` cache +
  `requestDistinctValues` post + `distinctValues` branch in the `window.addEventListener("message")`
  handler (`:3028`); (c) `SetFilterComponent.recomputeEntries` (`:1261`) prefers cached distinct
  values; (d) `buildServerFilterModel` (`:1976`) resolves `typed[]` from the distinct cache
  before falling back to scanning loaded rows.
- `src/ui/__tests__/webviewServerSort.test.ts` **(new)** — sort cases.
- `src/ui/__tests__/webviewDistinctValues.test.ts` **(new)** — distinct-value cases.

### colId quoting rule (from `PLAN.md` §3.1 — REQUIRED, prevents a regression)

The host's `parseOrderBy` accepts a column only as a **bare** identifier
(`/^[A-Za-z_][A-Za-z0-9_$]*$/`) or an **already-quoted** one; anything else is rejected with an
error toast and no SQL. AG Grid's `colId` is the raw DB column name (`webview/main.ts:1533`,
`field: spec.field`), so a column named `First Name` or a non-ASCII name would be rejected —
a user-visible regression versus today's client-side sort. Therefore:

> In `orderByFromColumnState()`, a `colId` that matches the bare-identifier regex is emitted
> **as-is**; any other `colId` is emitted **quoted with the dialect's quote character**, with
> the embedded quote character doubled:
> postgres `"First ""Name"""` · mysql `` `First Name` `` (backtick doubled) · mssql
> `[First Name]` (`]` doubled).

**Dialect source:** the webview already receives it inside the `state` message `header`
(`webview/main.ts:3031` assigns `headerText = msg.header`), which the host builds as
``Run at <ISO> — <driver>@<host>/<db>`` (`src/extension.ts:623`). Parse the driver token out of
`headerText` (match `postgres` / `mysql` / `mssql`), and **fall back to postgres double-quoting**
when the header says `no connection`, is a `Browse …` header, or does not match — a
double-quoted identifier is also what the host's `null`-dialect path composes today. Do **not**
add a new message or a new `src/` import for this (see Acceptance: no third `../src/...` import).

## Test Cases (REQUIRED — TDD)

| # | Loại | Tên test | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | integration (happy) | header sort posts a server requery | a `requery` message with `orderBy: "name ASC"` and `index: 0` | grid rendered, column state `[{colId:"name",sort:"asc",sortIndex:0}]` |
| 2 | integration (happy) | descending sort | `orderBy: "name DESC"` | `sort:"desc"` |
| 3 | edge (ordering) | multi-column sort honours `sortIndex`, not colId order | `orderBy: "a ASC, b DESC"` | state `[{b,desc,sortIndex:1},{a,asc,sortIndex:0}]` |
| 4 | edge (idempotence) | clearing the sort | exactly one `requery` posted, with `orderBy: ""` | previously sorted, then all `sort: null` |
| 5 | edge (composition) | sort composes with an active filter | the posted message carries BOTH `orderBy: "name ASC"` and a non-undefined `filters` | set filter active on `name`, then sort |
| 6 | edge (re-entrancy) | host-driven column-state restore posts nothing | `postMessage` call count unchanged after a programmatic sort apply | `suppressSortRequery` path |
| 7 | integration (happy) | opening a filter requests distinct values | a `requestDistinctValues` message with `{ index: 0, column: "name" }` | filter popup opened for `name` |
| 8 | integration (happy) | distinct response drives the checkbox list | list shows an entry for a value that appears in NO loaded row | host replies `values: ["zzz"]`, loaded rows contain only `"a"` |
| 9 | edge (cache) | second open of the same column does not re-request | `requestDistinctValues` posted exactly once across two opens | same column reopened |
| 10 | edge (stale response) | a response for a different column is ignored | list unchanged; no crash | reply `column: "other"` |
| 11 | edge (fallback) | no response yet ⇒ loaded-row entries | list equals `buildSetFilterEntries` over loaded values | no `distinctValues` message dispatched |
| 12 | edge (typed beyond window) | `typed[]` resolves from the distinct cache | posted `filters.name.typed` equals `[42]` (number), not `["42"]` | distinct cache holds `42`; no loaded row has it |
| 13 | edge (null handling) | a `null` distinct value maps to the `(Blanks)` entry | exactly one `(Blanks)` entry, not a literal `"null"` entry | `values: [null, "a"]` |
| 14 | edge (all-or-nothing invariant) | `typed[]` length parity on a partial resolve | posted `filters.name.typed` is either `[42, 7]` (length **2**, both resolved) or `undefined` — **never** length 1. `buildFilterWhere` (`src/ui/queryComposer.ts:106`) gates on `typed.length === values.length`, so a length-1 array silently degrades BOTH values to string literals — exactly gap 3's MySQL failure mode | 2 values selected; distinct cache holds `42` only, `7` resolvable only from a loaded row (or not at all) |
| 15 | edge (identifier charset) | non-bare `colId` is quoted before sending | sorting a column named `First Name` posts `orderBy: '"First Name" ASC'` on postgres, `` '`First Name` ASC' `` on mysql, `"[First Name] ASC"` on mssql — never the raw `First Name ASC` | `headerText` carrying each driver; colId `First Name` |
| 16 | edge (boundary) | bare `colId` and unknown dialect | a bare colId `name` posts `orderBy: "name ASC"` **unquoted** (byte-identical to what cycle V's regex accepted); with `headerText` = `"Run at … — no connection"` a non-bare colId falls back to postgres double-quoting | colIds `name` and `First Name` |

## Test Files

- `src/ui/__tests__/webviewServerSort.test.ts` — cases 1-6, 15, 16.
- `src/ui/__tests__/webviewDistinctValues.test.ts` — cases 7-14.

Both are jsdom bundle tests. Copy the harness from
`src/ui/__tests__/webviewFilters.test.ts` (`// @vitest-environment jsdom`, `ResizeObserver` /
`matchMedia` stubs, `acquireVsCodeApi` stub, loads `dist/webview.js` and **skips** when it is
missing). `src/ui/__tests__/webviewServerFilter.test.ts` and `webviewSetFilter.test.ts` are the
closest prior art for asserting on posted messages and for driving `SetFilterComponent`.

## Verification Commands

```bash
npm run typecheck
npm run compile
npx vitest run src/ui/__tests__/webviewServerSort.test.ts src/ui/__tests__/webviewDistinctValues.test.ts
npx vitest run src/ui/__tests__/webviewServerFilter.test.ts src/ui/__tests__/webviewSetFilter.test.ts src/ui/__tests__/webviewFilters.test.ts src/ui/__tests__/webviewBundle.test.ts
npx tsc -p tsconfig.webview.json --noEmit 2>&1 | grep -oE "^[^ (]+\.ts" | sort | uniq -c
```

The last command's output must be **exactly**:

```
     14 webview/main.ts
     10 webview/connectionFormMain.ts
     10 webview/aiSettingsFormMain.ts
      5 webview/schemaFormMain.ts
      1 webview/newTableFormMain.ts
```

(order may vary; the per-file counts may not). See `PLAN.md` §5 for why this is a snapshot diff
and not a zero-error gate.

## Acceptance Criteria

- [ ] Every case in §Test Cases passes.
- [ ] `npm run typecheck` clean and `npm run compile` succeeds.
- [ ] `npm run compile` was run **before** the vitest commands (bundle tests self-skip
      otherwise — a skipped file is not a pass).
- [ ] The webview per-file tsc counts match the baseline above exactly.
- [ ] **No new `../src/...` import in `webview/main.ts`.** Mirror the host types structurally,
      the way `ServerFilterModel` (`:132`) already does.
- [ ] The `requery` payload keeps its existing shape; `filters` / `offset` / `limit` / `append`
      semantics are unchanged.
- [ ] Sorting a column while "Load More" paging is active does not double-post: exactly one
      `requery` per user gesture.
- [ ] A `colId` that is not a bare identifier is **quoted per dialect** before it enters the
      `orderBy` string; a bare `colId` is sent unquoted, unchanged from cycle V. (cases 15, 16)
- [ ] Posted `filters.<col>.typed` is either the same length as `values` or absent — never a
      partial array. (case 14)
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none) — the message contract below is frozen in `PLAN.md` §7 and implemented independently
  by TASK-004. This task must not import anything TASK-004 writes.

## Interfaces

- Consumes (host → webview; mirror these structurally inside `webview/main.ts`):

```ts
// host reply, additive: an older bundle ignores an unknown `type`
type DistinctValuesMsg = {
  type: "distinctValues";
  index: number;        // statement index the values belong to
  column: string;       // field name
  values: unknown[];    // raw DB values, may contain null
  truncated: boolean;   // true ⇒ more values exist than were returned
  error?: string;       // present ⇒ values is empty, keep the loaded-row fallback
};
```

- Produces (webview → host; TASK-004 implements the handler for this exact shape):

```ts
type RequestDistinctValuesMsg = {
  type: "requestDistinctValues";
  index: number;
  column: string;
};
```

- The existing `requery` message is reused unchanged for sort; only its `orderBy` string gains
  multi-term values like `"a ASC, b DESC"`. `orderBy: ""` means "no ORDER BY".

---

## Discussion

### 2026-08-26 · planner · bao-opus

→ @executor Five load-bearing details:

1. **The tsc snapshot is the trap.** `tsconfig.webview.json` has `rootDir: "webview"`, so
   `webview/main.ts` already carries two TS6059 errors for its `../src/ui/resultsGridModel` and
   `../src/ui/undoStack` imports. Adding a third `src/` import adds a third error and fails the
   gate. That is why the `DistinctValuesMsg` type above is written out for you to copy inline
   rather than imported from `src/ui/messages.ts`.
2. **Compile before test, always.** The webview tests read `dist/webview.js` and call
   `describe.skip`-style bail-outs when it is absent. Running vitest on a stale bundle tests the
   *previous* build and will happily go green on unchanged code.
3. **`onSortChanged` fires for programmatic changes too.** AG Grid emits it when you call
   `applyColumnState`, so without the `suppressSortRequery` guard a host-driven state restore
   posts a requery, which re-renders, which restores state, which posts again. Case 6 exists
   specifically to catch that loop. Set the flag, apply, clear it in a `finally`.
4. **`getColumnState()` is the source of truth, not the event payload.** Read
   `api.getColumnState()`, filter `sort !== null`, sort by `sortIndex ?? 0`, then map to
   `` `${quoteColIdIfNeeded(colId)} ${sort.toUpperCase()}` `` joined with `", "`. Do not try to
   reconstruct order from the event's `columns` array — it is the *changed* columns, not the full
   sort order. **`quoteColIdIfNeeded` is not optional** — see the colId-quoting rule in
   §Target Files. Emitting a raw `First Name` gets the whole requery rejected host-side, which is
   worse than today's client-side sort; cases 15/16 are the guard.
6. **The `typed[]` array is all-or-nothing** (round-1 review). `buildFilterWhere`
   (`src/ui/queryComposer.ts:106`) uses `typed.length === values.length` as its gate, so a
   partially-resolved array is not "half typed" — it is *fully untyped*, and every value degrades
   to a string literal, which is precisely the MySQL failure this cycle is closing. When you
   cannot resolve every selected value (distinct cache first, then loaded rows), **omit `typed`
   entirely** rather than posting a short array. Case 14 uses a 2-value selection because a
   1-value selection cannot expose this.
5. **The distinct cache key is `(index, column)` and must be cleared when the statement is
   replaced.** `render()` swaps `currentStatement`; a cached list from the previous statement at
   the same index is wrong data, not stale-but-harmless. Clear on every state message whose
   statement identity changed.

Unverified, left to you: whether `SetFilterComponent` sees the popup-open event directly. It has
`init` and `setModel` today (`webview/main.ts:1200`, `:1245`) and `afterGuiDetached` for close;
if AG Grid v36 gives no open hook, firing the request from `init` is acceptable — case 9 (cache)
already covers the resulting repeat calls.

(no other comments)

---

## Executor Report

- EXECUTOR_TOOL: claude-code
- EXECUTOR_MODEL: bao-sonnet
- EXECUTOR_SUBAGENT: feature-implementer
- RED_OUTPUT (bundle unmodified, after `npm run compile`):
  ```
   Test Files  2 failed (2)
        Tests  12 failed | 4 passed (16)
  ```
  All 8 sort cases + distinct cases 7/8/12/13 failed for the expected
  reasons (no `requery` on sort; no `requestDistinctValues`; cache/typed
  absent). Cases 9/10/11/14 passed pre-implementation (edge shapes whose
  pre-state is the fallback itself — 9: nothing requested twice, 10: stale
  reply trivially ignored, 11: loaded-row entries already correct, 14:
  `typed` undefined is an accepted outcome per the task's own wording).
- Verification Output:
  - `npm run typecheck` → clean (no output, exit 0)
  - `npm run compile` → `esbuild: build complete`
  - `npx vitest run webviewServerSort.test.ts webviewDistinctValues.test.ts`
    → `Tests 16 passed (16)`
  - `npx vitest run webviewServerFilter webviewSetFilter webviewFilters webviewBundle`
    → `Tests 31 passed (31)`
  - `npx tsc -p tsconfig.webview.json --noEmit | grep … | uniq -c` →
    `14 main.ts / 10 connectionFormMain / 10 aiSettingsFormMain / 5 schemaFormMain / 1 newTableFormMain` — byte-identical to baseline.
- Status: PASS
- Note: decisions recorded per handoff rules — (1) no popup-open hook
  exists in AG Grid v36 Community IFilterComp, so the DISTINCT request
  fires from `init` (first popup open / first setFilterModel) exactly as
  the planner allowed; cache suppression makes re-opens request-free
  (case 9 green). (2) `suppressSortRequery` is cleared on the next
  macrotask, not in `finally` — AG Grid dispatches `sortChanged`
  asynchronously, and a synchronous clear let the programmatic apply
  re-post (case 6 caught this mid-run). (3) The distinct cache key is
  `` `${index}::${column}` `` and the cache is cleared whenever a state
  message changes the active statement identity
  (`index|sql|durationMs`), with a generation token dropping stale
  in-flight replies. (4) `distinctValues` is handled via a structural
  type-guard branch — `HostMsg` union not widened, no new `../src`
  import (verified: still exactly the two pre-existing ones). Full
  `npm test` suite NOT run in the worktree — targeted + typecheck +
  tsc gate only; orchestrator runs the full suite at the wave boundary.

---
## Reviewer Verdict

VERDICT: CHANGES-REQUESTED
REVIEWER_MODEL: bao-opus (configured: unic-smart)
EXECUTOR_MODEL: bao-sonnet
VERIFICATION_RERUN:
  command: npm run typecheck; npx vitest run src/ui/__tests__/webviewServerSort.test.ts src/ui/__tests__/webviewDistinctValues.test.ts; npx tsc -p tsconfig.webview.json --noEmit 2>&1 | grep -oE '^[a-zA-Z0-9_./-]+\.ts' | sort | uniq -c | sort -rn
  result: typecheck PASS; 16 pass / 0 fail; tsc baseline 14/10/10/5/1
TEST_PLAN_COVERAGE: all-followed
FINDINGS:
  critical:
    - none
  important:
    - file: webview/main.ts:2158 — dialect detection searches the entire header instead of parsing the driver token; e.g. `mysql@postgres.internal/db` is misdetected as postgres, so a spaced colId is double-quoted and rejected by the MySQL host parser. Parse only the token after the em dash and before `@`.
    - file: webview/main.ts:2199 — filter/load-more requeries read the manual ORDER BY input rather than the active grid sort; a pending 150ms filter debounce can post after a header sort and become the newer unsorted requery, and later filter/paging actions also drop the header order. Preserve `orderByFromColumnState()` for filter-driven/paged requeries and cancel or merge a pending filter timer on sort.
    - file: webview/main.ts:3273 — statement replacement clears the distinct cache but leaves existing filter instances alive; because requests only fire from `SetFilterComponent.init()` at webview/main.ts:1248, reopening that filter after a sort/requery neither requests fresh DISTINCT values nor refreshes its stale list. Invalidation must trigger a fresh cached/pending request and recomputation without losing the active model.
  minor:
    - none
NEXT_STATUS_FOR_INDEX: changes_requested
NOTES: Model isolation passed; configured reviewer alias is unic-smart and the actual bound model is bao-opus. Fresh targeted verification passed, but the three runtime paths above are not covered by the submitted tests.
