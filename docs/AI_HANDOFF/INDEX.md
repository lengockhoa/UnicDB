# INDEX

Cycle Y -- **FINISH QUEUED RESULTS/QUERY WORK**: C1 connection-form manual commit surface,
MySQL atomic batch policy, declared type inference primitive, keyset paging with safe missing-PK
projection (contract A — structural browse-shape gate), mysql/mssql NULLS emulation, scoped
DISTINCT dropdown with visible truncation/error, typed state dialect wiring, and the server-sort
bundle lifecycle fix. All 8 tasks `ready` — the three former `needs_breakdown` items were
resolved by the orchestrator with grounded repo evidence (parseFromClause provenance +
buildFilterWhere reuse). 8 tasks, planned 3 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Expose per-connection manual-commit mode | ready | none | - |
| TASK-002 | Make MySQL multi-statement batches atomic | ready | none | - |
| TASK-003 | Let declared server types override sampled grid inference | ready | none | - |
| TASK-004 | Keyset paging and safe missing-PK projection | ready | none | - |
| TASK-005 | Emulate NULLS FIRST/LAST on MySQL and MSSQL | ready | none | - |
| TASK-006 | Scope DISTINCT values and surface dropdown limits/errors | ready | TASK-004, TASK-007 | - |
| TASK-007 | Typed state dialect, declared-type wiring, and webview minors | ready | TASK-003, TASK-004 | - |
| TASK-008 | Stabilize the webview server-sort bundle lifecycle | pending_review | claude-code/bao-sonnet | - |

Graph: TASK-001 ∥ TASK-002 ∥ TASK-003 ∥ TASK-004 ∥ TASK-005 ∥ TASK-008; TASK-003 + TASK-004
→ TASK-007; TASK-004 + TASK-007 → TASK-006.

- **Wave 1 (6, parallel):** TASK-001, TASK-002, TASK-003, TASK-004,
  TASK-005, TASK-008. All six are file-disjoint.
- **Wave 2 (1):** TASK-007 after TASK-003 + TASK-004.
- **Wave 3 (1):** TASK-006 after TASK-004 + TASK-007.

Cycle Y ownership decisions:
- Wave-1 file-disjointness: TASK-001 owns connection-form paths plus `src/extension.ts`;
  TASK-002 owns `src/adapters/mysql.ts` + README; TASK-003 owns `resultsGridModel.ts`;
  TASK-004 owns `resultsPanel.ts` + new `keysetPaging.ts`; TASK-005 owns
  `queryComposer.ts`; TASK-008 owns only `webviewServerSort.test.ts`.
- Later same-file owners are serialized: TASK-007 follows TASK-004 for `resultsPanel.ts`; then
  TASK-006 follows TASK-004 + TASK-007 for `resultsPanel.ts`, `messages.ts`, and
  `webview/main.ts`.
- `resultsPanelOrderBy.test.ts` belongs only to TASK-005 even though TASK-004 also concerns
  paging; this prevents a test-file collision.

Cycle X -- **ADVERSARIAL QA + CORRECTNESS HARDENING**: two evidence-gated audits, root-cause
flake isolation, whitespace-aware `(Blanks)`, shared SQL terminator normalization, MySQL sort
adapter parity, explicit UTC adapter sessions, plus three audit-fix tasks materialized at the
reconciliation gate. 8 tasks, 3 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | Adversarial audit: host, adapters, save path | done | claude-code/bao-sonnet | - |
| TASK-002 | Adversarial audit: results grid, webview, query UI | done | claude-code/bao-sonnet | - |
| TASK-003 | Eliminate NULL/viewer aggregate flake at bundle lifecycle root | approved | claude-code/bao-sonnet | bao-opus |
| TASK-004 | Whitespace `(Blanks)` and shared SQL terminator normalizer (+P2-6 export quoting) | approved | claude-code/bao-sonnet | bao-opus |
| TASK-005 | MySQL sort twin and explicit UTC adapter sessions (+M1 checkout, +M3 stream end) | approved | claude-code/bao-sonnet | bao-opus |
| TASK-006 | ResultsPanel host hardening: cursor ordering, manual-window refresh, wire-safe `batched` | approved | claude-code/bao-sonnet | bao-opus |
| TASK-007 | Webview grid hardening: real sort column, warning surfacing, quick-search requery, safe refresh confirm | approved | claude-code/bao-sonnet | bao-opus |
| TASK-008 | Save/core hardening: NULL-PK rows skipped, batched first-fetch errors surfaced | approved | claude-code/bao-sonnet | bao-opus |

Graph: 001 and 002 are independent audit gates (both done); 002 --> 003, 002 --> 004,
002 --> 007, 001+002 --> 006 and --> 008; 001 + 004 --> 005; 004 --> 007 (file ownership of
`webview/main.ts`).

- **Wave 1 (2, parallel):** 001, 002 — done
- **Reconciliation gate:** done — 3 audit-fix tasks materialized (006, 007, 008); P2-6 folded
  into 004, M1/M3 folded into 005; 6 findings queued below; P3-1 whitespace chore handled
  directly by the orchestrator.
- **Wave 2 (4, parallel):** 003, 004, 006, 008
- **Wave 3 (2, parallel):** 005, 007

Cycle X file-collision decisions:
- Wave 2 is file-disjoint: 003 (`src/ui/__tests__` lifecycle harness), 004
  (`src/core/text.ts`, `src/ui/resultsGridModel.ts`, `src/ui/queryComposer.ts`,
  `src/ui/distinctValues.ts`, `webview/main.ts`), 006 (`src/ui/resultsPanel.ts`), 008
  (`src/core/saveStatements.ts`, `src/core/queryRunner.ts`).
- **Collision resolved:** TASK-007 was provisionally Wave 2, but TASK-004 already owns
  `webview/main.ts`. TASK-007 depends on TASK-004 and moved to Wave 3, where it is
  file-disjoint from TASK-005 (`src/adapters/mysql.ts`, `src/adapters/mssql.ts`,
  `src/ui/queryComposer.ts`).
- P2-2 (`src/core/queryRunner.ts`) was filed by the UI audit but assigned to TASK-008, the
  core owner, so it has exactly one owner.

Cycle W -- **SERVER-SIDE SORT + DISTINCT FILTER VALUES + DETERMINISTIC PAGING**: real ORDER BY
parser with per-dialect quoting and expression rejection, `(Blanks)` matching empty strings,
PK tiebreaker for gap-free OFFSET paging, server-side DISTINCT values for the set filter, and
AG Grid header-click sort wired to the server. 4 tasks, 2 waves.

| Task | Title | Status | Executor | Reviewer |
|------|-------|--------|----------|----------|
| TASK-001 | ORDER BY parser + dialect clause builder + paging tiebreaker + `(Blanks)` opt-in | approved | - | bao-opus |
| TASK-002 | `buildDistinctValuesQuery`: pure DISTINCT-values SQL builder | approved | - | bao-opus |
| TASK-003 | Webview: server-side sort on header click + distinct-value set filter | approved | claude-code/bao-sonnet | bao-opus |
| TASK-004 | Host wiring: distinct-values round trip + ORDER BY parser + paging tiebreaker | approved | claude-code/bao-sonnet | bao-opus |

Graph: 001 --> 004, 002 --> 004. 001, 002, 003 are independent.

- **Wave 1 (3, parallel):** 001, 002, 003
- **Wave 2 (1):** 004

File-collision decisions:
- No file is touched by two tasks in this cycle, so no same-wave collision is possible.
- `webview/main.ts` (the cycle-V hotspot) is owned **solely** by TASK-003 — sort wiring,
  set-filter distinct values and typed-value resolution are bundled into that one task
  rather than split across waves.
- `src/ui/queryComposer.ts` + its test belong solely to TASK-001. TASK-002's DISTINCT builder
  went into a NEW `src/ui/distinctValues.ts` specifically to avoid sharing that file, and to
  keep clear of the source-text assertions at `queryComposer.test.ts:161-182`.
- `src/ui/messages.ts` + `src/ui/resultsPanel.ts` + `src/extension.ts` belong solely to TASK-004
  (wave 2). The `src/extension.ts` edit is ~8 lines: implementing the new optional
  `SaveContext.listColumnTypes` beside the existing `listPkColumns`.
- TASK-004 also updates ONE existing test block
  (`resultsPanelServerFilter.test.ts` case 16) — the single intentional behaviour change of
  this cycle (ORDER BY pass-through becomes an explicit rejection).

## Previous cycles

Cycle V (6 tasks, all done) shipped at `68f602a` (v1.6.5). See `archive/cycle-V-*` for
completed task files and the cycle plan.
Cycle U (9 tasks, all done) shipped at `08c8de3` (v1.6.4). See `archive/cycle-U-*`.
Cycle T (12 tasks, all done) shipped at `4a35fec`. See `archive/cycle-T-*`.

## Next cycles (queued)

### Deferred at the Cycle X reconciliation gate

Findings confirmed by the two Wave-1 audits but deliberately **not** tasked this cycle. Evidence
lives in `docs/AI_HANDOFF/notes/cycle-x-audit-host.md` and
`docs/AI_HANDOFF/notes/cycle-x-audit-grid-ui.md`.

- **M2 — MySQL multi-statement partial commit.** A multi-statement batch that fails midway leaves
  earlier statements committed with no rollback boundary (mysql autocommit). Pre-existing since
  before v1.6.3, medium-sized (needs an explicit batch transaction policy plus a user-facing
  contract), so it is out of a hardening cycle's budget.
- **pg metadata vs manual-commit window — blocked on C1.** While a manual transaction is open on
  the single pooled pg client, metadata/aux queries issued outside that transaction can block or
  read outside the transaction's snapshot. Cannot be designed until C1 settles whether the manual
  window is reachable at all.
- **C1 — `manualCommit` is unreachable from the UI (product decision).** The host implements the
  full manual COMMIT/ROLLBACK path but no shipped UI surface enables the setting. Either expose it
  or delete the path; both are product calls, not defect fixes. TASK-006's P1-4 fix keeps the path
  correct either way.
- **P2-3 — DISTINCT dropdown gives no truncated/error note.** The set-filter dropdown silently
  shows a capped or empty list when the DISTINCT query is truncated or fails. Needs a message-shape
  addition, so it is deferred with the other protocol work. Pair it with the existing
  "Scope DISTINCT dropdown values to the active filter/WHERE" entry below — same surface, one task.
- **P2-4 — `inferColumns` declared-type override.** Column kind is inferred from sampled row values
  and never corrected by the server's declared type, so an all-NULL or all-integer-looking string
  column is misclassified for alignment and filtering. Needs declared types plumbed to the webview.
- **P3-2 — dead guard in `unquoteIdent`.** A branch that cannot be reached given the caller's
  precondition. Cosmetic; bundle it into the next file-owning task rather than spending a wave on it.
### Earlier backlog

- **Keyset (cursor) paging for deep offsets.** Cycle W makes OFFSET paging deterministic only
  when the full PK is projected, but not fast; `OFFSET 500000` still scans. Needs a stable unique
  sort key carried through the webview round trip and a different composition for page 0.
- **Safely project missing PK columns for deterministic OFFSET paging.** Cycle W appends the full
  declared PK only when every PK component is already in `StatementResult.result.columns`; if one
  is missing, no tiebreaker is added and no gap-free promise is made. A follow-up must project all
  PK columns through arbitrary wrapped SELECTs without changing visible result columns or
  breaking DISTINCT/aggregate queries; appending all projected columns is not a valid substitute.
- **Session-timezone-aware timestamp literals for MySQL/MSSQL — selected for Cycle X TASK-005.** `mysql.createPool` is built
  with no `timezone`/`dateStrings` and tedious's `new Connection` with no `useUTC`, so a
  server session not running in UTC shifts the UTC-naive `datetime` literals that
  `typedLiteral` emits. Needs a per-connection session-timezone probe.
- **Scope DISTINCT dropdown values to the active filter/WHERE.** Cycle W composes the DISTINCT
  list over the base statement with `where = ""` because the host retains no per-statement WHERE
  (verified: no `lastWhere` / `whereByStatement` in `src/ui/resultsPanel.ts`), so the dropdown can
  offer values the current filtered view cannot contain. Needs the host to retain the composed
  WHERE (bar AND filter) per statement first; `buildDistinctValuesQuery`'s `where` parameter is
  already in place for it.
- **`NULLS FIRST/LAST` on mysql/mssql.** Cycle W accepts the clause in the grammar, renders it
  natively on postgres and rejects it elsewhere rather than emulating it with a `CASE` /
  `IS NULL` sort key (no producer emits it today — requery-bar typing only).
- **Typed `dialect` field on `StateMessage`.** The webview currently infers the driver by parsing
  the `state` header string (`extension.ts:623`) in order to quote non-bare `colId`s, falling
  back to postgres quoting. A typed field would remove the string parsing.
- **Whitespace-only values in `(Blanks)` — selected for Cycle X TASK-004.** Cycle W folds `''` into `(Blanks)` for string
  columns but leaves `"  "` as its own entry; `TRIM(col) = ''` would match it at the cost of
  the index on all three dialects.
- **Shared `stripTrailingSemicolon` — selected for Cycle X TASK-004.** Grounding found three
  copies: `src/ui/queryComposer.ts`, `src/ui/distinctValues.ts`, and `src/ui/resultsGridModel.ts`;
  hoist all into `src/core/text.ts`.
- **MySQL `getTableSortQuery` adapter twin — selected for Cycle X TASK-005.** Postgres and MSSQL
  have one; MySQL's arm is currently composed inline in `composeSortQuery`.
