# PLAN — Cycle BQ-04: wire `formatBigQueryCell` into the Results grid

Source spec: `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §5 follow-up (BQ-04). BQ-00 / BQ-01 / `BatchedQuery` surfaces stay frozen. BQ-03 shipped the pure formatter `formatBigQueryCell(value, field?)` (tested, exported, **deliverable-but-unwired**).
Base: `main @ 358b183` (HEAD, post v1.50.0). Guard-test base for frozen surfaces: `75cdb08` (the v1.50.0 release snapshot where BQ-00/BQ-01 files are byte-pinned; HEAD after it contains no BQ-00/BQ-01/`package.json` edits, verified by an empty `git diff 75cdb08 -- <paths>`).

## §1 Intent

BQ-03 shipped the *formatter* but never wired it: a BigQuery result still renders every cell through the generic `formatCell` (BigInt→string, Date→ISO, object→JSON). For BigQuery values the generic formatter renders **INT64/NUMERIC/BIGNUMERIC/BYTES/JSON/temporal** as plain strings (acceptable but not canonical), and — the real bug — **RECORD `{ f: [...] }` and REPEATED `[ { v } ]`** objects surface as their raw JSON via `formatCell`'s `JSON.stringify(v)` path, which is non-deterministic in field order in some node versions and not the compact single-line display the BQ formatter was designed for.

**Success definition:** when a `StatementResult` originates from a BigQuery connection, every grid cell (and the value-viewer overlay) renders via `formatBigQueryCell(value, field?)` instead of `formatCell(value)`; non-BigQuery dialects (postgres/mysql/mssql) render exactly as today. Concretely:

1. A BigQuery `StatementResult` carries an additive `dialect: "bigquery"` marker that survives run, append, loadMore, requery and refresh.
2. The webview cell renderer picks `formatBigQueryCell(v, f)` when `dialect === "bigquery"`, else `formatCell(v)` — a pure, unit-testable helper.
3. RECORD/REPEATED BigQuery cells render deterministically (`{a,b,c}` / `[x,y,z]`), not as raw JSON.
4. Non-BigQuery runs keep byte-identical rendering (no regression).
5. BQ-00 (`bigqueryTypes.ts`, `bigqueryAdc.ts`), BQ-01 (`BigQueryClientLike`, `BatchedQuery`), and `package.json` (no new deps) are byte-untouched at cycle end.

The upstream `field` argument to `formatBigQueryCell` is currently **behaviorally unused** (signed `_field` in the source) — this cycle threads it as a value but adds no new formatting behavior; temporal locale formatting is explicitly out of scope.

## §2 Scope

### In scope
- **BQ-04.1** — additive `dialect?: "bigquery" | SqlDialect` field on `StatementResult`: (a) canonical interface in `src/core/queryRunner.ts:49`, (b) local mirror in `src/ui/resultsGridModel.ts:54-61` (the `StatementResult` interface declaration; mirroring is the established additive pattern — BQ-03's `pending?: boolean` is handled the same way). `runStatements`' BigQuery branch in `src/extension.ts` sets `dialect: "bigquery"` on each emitted `StatementResult`; non-BQ branches leave it `undefined`. Owning: `src/extension.ts`, `src/core/queryRunner.ts`, `src/ui/resultsGridModel.ts` (type-mirror edit only), `src/core/__tests__/queryRunner.test.ts`.
- **BQ-04.2** — webview cell-renderer helper: a pure function in the `src/ui/resultsGridModel.ts` module (NOT in the webview bundle) that picks `formatBigQueryCell(v, f)` when `dialect === "bigquery"`, else `formatCell(v)`; wire it into `webview/main.ts` value-viewer (line 2523) and data-cell renderer (line 2596). Field metadata rides additively through the existing `state` payload so no frozen BQ type is touched. Owning: `src/ui/resultsGridModel.ts` (helper add), `webview/main.ts`, `src/ui/__tests__/resultsGridModel.test.ts`.
- **BQ-04.3** — frozen-surface guard: a standalone Vitest test that runs `git diff 75cdb08 -- <frozen paths>` and asserts empty output (BQ-00 pure types, BQ-01 adapter-seam types, `package.json`). Owning: NEW `src/adapters/__tests__/bq04SurfaceGuard.test.ts` (no source edits — guard-only). The non-BQ render regression lives in BQ-04.2's test rows (003.d equivalent), because it tests the helper BQ-04.2 owns.

### Out of scope (this cycle)
- Locale-aware temporal formatting (e.g. `TIMESTAMP` → user locale): `formatBigQueryCell`'s `field` param supports this but the branch is not implemented; BQ-04 threads the field but does not implement new formatting.
- Changing `formatBigQueryCell` itself — it is frozen-tested (12 tests) and unchanged; imported and reused as-is.
- Deleting/replacing `webview/grid.ts` (TASK-203's separate concern) or any `formatCell` refactor — `formatCell` stays verbatim.
- Changing the `BatchedQuery` interface or `BigQueryClientLike` (both frozen).
- Any new npm dependency or `@google-cloud/bigquery` version change.
- UI polish beyond the formatter switch (cell styling, width heuristics, column-type badges).

### File ownership (same-wave disjointness)
| Task | Owns | Notes |
|------|------|-------|
| BQ04-001 | `src/extension.ts`, `src/core/queryRunner.ts`, `src/ui/resultsGridModel.ts` (type-mirror only), `src/core/__tests__/queryRunner.test.ts` | Interface + setter |
| BQ04-002 | `src/ui/resultsGridModel.ts` (helper add), `webview/main.ts`, `src/ui/__tests__/resultsGridModel.test.ts` | Renderer seam |
| BQ04-003 | NEW `src/adapters/__tests__/bq04SurfaceGuard.test.ts` only | Frozen guard |

**Constraint:** BQ04-001 and BQ04-002 both touch `src/ui/resultsGridModel.ts` (type-mirror vs helper). Same file → **different waves** (001 in wave 1, 002 in wave 2 with `Dependencies: TASK-BQ04-001`). BQ04-003 writes zero source files → independent, wave 1. No same-wave file collision.

## §3 Approach

**Wiring seam (chosen): additive `dialect?` marker + renderer-side formatter switch.**

1. **Additive `dialect?: "bigquery" | SqlDialect` on `StatementResult`** in both the canonical `src/core/queryRunner.ts:49` interface and its local mirror in `src/ui/resultsGridModel.ts:54-61`.
   - *Why mirror:* `resultsGridModel.ts` compiles standalone (tsconfig `include` is `src/**`; the module deliberately does not import the extension/main-thread surface). The BQ-03 `pending?: boolean` field already follows this exact two-site pattern (`queryRunner.ts:86` + mirror); any other route creates a third divergence.
   - *Why additive/optional:* every constructor site (`run()`'s `nextResults` map at `queryRunner.ts:266`, `loadMoreImpl`, `handleRequery` at `resultsPanel.ts:692-699`) spreads `...rest`/builds fresh objects, so an optional field (a) breaks no existing call site and (b) **survives** loadMore/requery/refresh reconstructions automatically — verified: `const { resultLimited, cursorClosed, ...rest } = r` at resultsPanel.ts:692 keeps `dialect` inside `rest`.
   - *Why the union `"bigquery" | SqlDialect`* (not just a `"bigquery"` literal-or-undefined): the runner can record a real dialect later without another interface edit. BQ-04 sets it **only** for BigQuery; non-BQ stays `undefined` (byte-identical rendering). `SqlDialect` is `export type SqlDialect = "postgres" | "mysql" | "mssql"` at `src/core/statementParser.ts:21` (verified — it does NOT include bigquery, hence the extended union).

2. **Setter: `runStatements` BigQuery branch (`src/extension.ts`, ~2082+).** `active.driver` is already computed there (it drives `buildRunHeader`). After `await runner.run(...)` settles, stamp `dialect: "bigquery"` on each of this run's statements (`results.slice(appendBase)` per the BQ-03-005 precedent) before the final `panel.render(results, finalHeader, ...)`. Post-settle single-write is sufficient: grid rows harden after settle; the streaming `onUpdate` renders only running/pending states.
   - *Why here and not `queryRunner.ts`:* `DbAdapter` has **no `driver` field** (verified in `src/adapters/types.ts`) — the runner literally cannot derive the dialect without widening `DbAdapter` (4 implementers). `extension.ts` owns `mgr.getActive()?.driver` — it is the single reliable source.
   - *Why not `resultsPanel.ts`:* the panel is constructed per-panel and does not reliably know the live driver for a shared runner (`resultsPanel.ts:1486` comment: "the panel only holds AdapterFactory (no driver field)"); the host closure already derives dialect from the active connection.

3. **Renderer: pure helper in `resultsGridModel.ts` + wiring in `webview/main.ts`.**
   ```
   export function formatDataCellForDialect(
     value: unknown,
     field?: { name?: string; type?: string; mode?: string },
     dialect?: string,
   ): string {
     if (dialect === "bigquery") return formatBigQueryCell(value as BigQueryValue, field as BigQuerySchemaField | undefined);
     return formatCell(value);
   }
   ```
   - `webview/main.ts` already imports `formatCell` from `../src/ui/resultsGridModel` (line 49) — the helper rides the same import; wire it at line 2523 (value-viewer `formatCell(value)`) and line 2596 (`formatDataCell`'s `return formatCell(v)`).
   - **Purity note:** `resultsGridModel.ts` must NOT import the frozen `src/adapters/bigqueryTypes.ts` (the byte-untouched rule governs *editing*; importing is legal but the module's purity contract is "no vscode / no I/O", and a pure type+function import from `./bigqueryPages` is legal since `bigqueryPages.ts` itself imports only `./bigqueryTypes` — verified). Decision: import `formatBigQueryCell` from `../adapters/bigqueryPages` and type `field` as a **local structural alias** (not `BigQuerySchemaField`) so the ui module keeps zero frozen-file imports. `extension.ts` passes the real schema field; it structurally satisfies the alias.
   - *Rejected: helper lives in `webview/main.ts`* — then it is only testable via jsdom bundle tests, not the pure-model unit lane the project uses for grid formatting.

4. **Field metadata channel — additive `schemaFields?` on `StatementResult` (same two mirror sites).** `BigQueryPage.columns: BigQuerySchemaField[]` (in frozen `bigqueryTypes.ts`, import-only) already carries per-column type info. Thread it additively:
   - `StatementResult.schemaFields?: ReadonlyArray<{ name?: string; type?: string; mode?: string }>` (structural, mirror in both sites) — stamped in the same `extension.ts` post-settle block, read off `stmt.batched`/page (`columns` is on the `BatchedQuery`-conforming handle's page source; if the live handle does not expose it at that seam, read it from `stmt.result.columns` names + the page schema captured at run time — executor picks whichever the seam actually exposes, both are additive).
   - Rides the existing `state` payload (`postMessage({type:"state", header, results, busy})` at resultsPanel.ts:410) — **zero message-protocol change**; the `...rest` spreads preserve it everywhere.
   - *Rejected: a separate `bqColumns` message* — new message type + new webview handler + new panel side-map for the same result; strictly more surface.
   - *Rejected: widening `BatchedQuery` with `schemaFields`* — that interface is BQ-01 frozen.

5. **Guard test (BQ04-003)** — standalone Vitest test shelling `git diff 75cdb08 -- <frozen paths>` and asserting empty stdout. Base pinned to `75cdb08`, NOT the working HEAD: HEAD drifts as this cycle's edits land; the guard proves the *cycle* left the frozen paths untouched relative to the v1.50.0 release point. Verified today: `git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts package.json src/adapters/types.ts` is already empty. Frozen paths: `src/adapters/bigqueryTypes.ts`, `src/adapters/bigqueryAdc.ts`, `src/adapters/types.ts` (protects `BigQueryClientLike` + `BatchedQuery`), `package.json`.

### Alternatives rejected
- **Separate `bqColumns` message channel** — extra message type + webview handler + panel side-map; the additive `schemaFields?` field delivers the same result free through the existing `state` payload.
- **Refactor `resultsGridModel.ts` to import the canonical `queryRunner` type** — breaks the standalone-compile invariant; the mirror exists precisely because the module cannot reach the main thread.
- **Stamp `dialect` in `queryRunner.ts.run()`** — runner has no `driver` (only `adapterProvider(): DbAdapter`, and `DbAdapter` has no driver field); would require widening `DbAdapter` (4 implementers).
- **Set `dialect` in `resultsPanel.ts`** — panel does not reliably know the live driver for a shared runner (`resultsPanel.ts:1486`).
- **Temporal locale formatting now** — means editing frozen-tested `formatBigQueryCell`; deferred.
- **Editing `formatBigQueryCell` to make `_field` used** — reuse-only constraint; the field is threaded but behavior stays exactly as its 12 tests pin.

## §4 Test Plan

| # | Type | Test name | Expected |
|---|------|-----------|----------|
| 001.a | happy (setter) | BQ run stamps `dialect: "bigquery"` on each settled statement | After the `runStatements` BQ branch settles, every statement in `results.slice(appendBase)` has `dialect === "bigquery"` (unit-test the stamping against a fake `ConnectionManager.getActive()` returning `driver: "bigquery"` + a stub `runner.run` resolving fixed statements) |
| 001.b | edge (non-BQ regression) | non-BQ run leaves `dialect` `undefined` | Same unit with `active.driver === "postgres"` (and `"mysql"`, `"mssql"`): settled statements have `dialect === undefined` — non-BQ rendering path unchanged |
| 001.c | edge (mirror/type) | both `StatementResult` sites declare the field; `dialect` survives the loadMore/requery spread | A type-level assertion (compile-time) + a runtime test constructing `{...stmt, result: fresh}` (the resultsPanel.ts:692 pattern) and asserting `dialect` survives the rest-spread |
| 002.a | happy (helper) | BQ cell routes to `formatBigQueryCell` | `formatDataCellForDialect([{v:1},{v:2}], field, "bigquery")` returns `"[1,2]"` (REPEATED compact) and `formatDataCellForDialect({f:[1,"a"]}, field, "bigquery")` returns `"{1,a}"` (RECORD compact) — NOT `JSON.stringify` output |
| 002.b | edge (non-BQ fall-through) | postgres/mysql/mssql fall through to `formatCell` | `formatDataCellForDialect(new Date(0), undefined, "postgres")` returns `"1970-01-01T00:00:00.000Z"` (formatCell's ISO) and `formatDataCellForDialect(10n, undefined, "mysql")` returns `"10"` |
| 002.c | edge (absent optional input) | BQ with `field` undefined still renders | `formatDataCellForDialect("12345", undefined, "bigquery")` returns `"12345"` (INT64 stays string — no `Number()` coercion), non-throwing |
| 002.d | edge (null/empty) | null/undefined keeps each formatter's own empty semantics | `formatDataCellForDialect(null, f, "bigquery")` → `""`; `formatDataCellForDialect(undefined, undefined, "mssql")` → `""` |
| 002.e | edge (BQ type variety, wiring-level) | INT64/NUMERIC/BYTES/JSON/temporal through the switch | one table-driven case per BQ family asserting the exact BQ string (`NUMERIC "1.5"` → `"1.5"`, `BYTES "aGVsbG8="` → `"aGVsbG8="` base64 verbatim, `TIMESTAMP "2026-01-01 00:00:00 UTC"` → verbatim) — proves the wiring does not mangle canonical strings |
| 003.a | regression (frozen guard) | BQ-00 surface byte-untouched | `git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts` prints empty |
| 003.b | regression (frozen guard) | `BigQueryClientLike` + `BatchedQuery` unchanged | `git diff 75cdb08 -- src/adapters/types.ts` prints empty |
| 003.c | regression (frozen guard) | `package.json` deps unchanged | `git diff 75cdb08 -- package.json` prints empty |

**Edge kinds covered (≥2 different kinds, non-negotiable):** functional-branch (001.b/002.b non-BQ fall-through), type-variety (002.a/002.e REPEATED/RECORD + BQ family table), absent-optional-input (002.c `field` undefined), null/empty (002.d), data-survival/spread (001.c), frozen-byte-regression (003.a-c). Six distinct kinds; the non-BQ fall-through regression appears at three layers (runner 001.b, helper 002.b, formatCell parity 002 row 3).

## §5 Verification

Real scripts from `package.json` (verified): `test` = `vitest run`, `typecheck` = `tsc --noEmit`, `compile` = `node esbuild.js`. There is **no `lint` script** in this repo (verified) — `typecheck` is the mandatory static gate in every task. Run from repo root.

```bash
# Wave 1 — TASK-BQ04-001 (runner + interface + setter)
npx vitest run src/core/__tests__/queryRunner.test.ts
npm run typecheck

# Wave 1 — TASK-BQ04-003 (frozen guard; independent, zero source edits)
npx vitest run src/adapters/__tests__/bq04SurfaceGuard.test.ts
npm run typecheck

# Wave 2 — TASK-BQ04-002 (webview helper + wiring)
npx vitest run src/ui/__tests__/resultsGridModel.test.ts src/ui/__tests__/webviewBundle.test.ts
npm run typecheck

# Cycle-end full gate (all waves, before reporting done)
npm test
npm run typecheck
npm run compile
```

**Frozen-surface reconfirm (run last):**
```bash
git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json
# MUST print nothing (empty = frozen surfaces byte-untouched)
git status --porcelain
# MUST list ONLY BQ-04-owned files: src/extension.ts, src/core/queryRunner.ts,
# src/ui/resultsGridModel.ts, webview/main.ts + the test files below
```

## §6 Acceptance

- [ ] All §4 tests pass; `npm test` green at cycle end. [001,002,003]
- [ ] `git diff 75cdb08 -- src/adapters/bigqueryTypes.ts src/adapters/bigqueryAdc.ts src/adapters/types.ts package.json` is EMPTY. [TASK-BQ04-003]
- [ ] `src/extension.ts` BQ `runStatements` branch stamps `dialect: "bigquery"` (+ `schemaFields`) post-settle; non-BQ leaves both `undefined`. [TASK-BQ04-001]
- [ ] Additive `dialect?` declared on BOTH `StatementResult` sites (`src/core/queryRunner.ts:49`, `src/ui/resultsGridModel.ts:54-61`); `npm run typecheck` passes. [TASK-BQ04-001]
- [ ] `src/ui/resultsGridModel.ts` exports pure `formatDataCellForDialect` picking `formatBigQueryCell` iff `dialect === "bigquery"`. [TASK-BQ04-002]
- [ ] `webview/main.ts` value-viewer (line 2523) and data-cell renderer (line 2596) route through the helper; `formatCell` itself unchanged. [TASK-BQ04-002]
- [ ] `formatBigQueryCell` NOT modified — no diff on `src/adapters/bigqueryPages.ts`. [TASK-BQ04-002]
- [ ] No existing test in `queryRunner.test.ts` / `resultsGridModel*.test.ts` / BQ adapter suites regresses. [all]
- [ ] `npm run compile` (esbuild bundle) succeeds. [all]

## §7 Global Constraints

- **Version floor:** `@google-cloud/bigquery@9.0.3` unchanged; `package.json` read-only this cycle (no new deps, no version bumps).
- **Frozen files:** `src/adapters/bigqueryTypes.ts`, `src/adapters/bigqueryAdc.ts`, `src/adapters/types.ts` (`BigQueryClientLike` + `BatchedQuery`) — byte-untouched, import-only. `src/adapters/bigqueryPages.ts` reuse-only (no edits to `formatBigQueryCell`).
- **Mirror discipline:** `StatementResult` additive fields MUST be declared in BOTH `src/core/queryRunner.ts` and `src/ui/resultsGridModel.ts`; one site without the other is a defect.
- **Naming/copy:** `dialect` field value is the literal `"bigquery"` (lowercase). Renderer helper named `formatDataCellForDialect`. No new webview message type (ride the existing `state` payload's `results`).
- **No credentials / full SQL / full error bodies** in any error/log/UI surface — the helper is display-only.
- **Pure module boundary:** `src/ui/resultsGridModel.ts` must NOT import `vscode` or the frozen `src/adapters/bigqueryTypes.ts`; the BQ field descriptor is a local structural alias.
- **Platform:** Node v22.22.1, macOS, repo root `/Volumes/KHOA_EXTENAL/DOCKER_CREATE/VSDB`, npm.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart (separate-agent code-reviewer, Spec/Plan Review lens; 0 critical / 0 important / 3 minor applied — minor 1: TASK-BQ04-003 header cite 003.a-d → 003.a-c; minor 2: §3.3 Purity note self-questioning prose removed; minor 3: resultsGridModel.ts mirror pin 44-61 → 54-61 in §2 / §3.1 / §6 + TASK-BQ04-001 line 15)

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit:
  1. TASK-BQ04-003 originally bundled the non-BQ render regression and imported `formatDataCellForDialect` (a symbol TASK-BQ04-002 creates in wave 2) while declaring `Dependencies: none` — audit item 8 (dependency on a symbol no earlier wave task creates). Rewrote 003 as a pure frozen-guard task (3 rows, no cross-task imports); the non-BQ render regression moved to TASK-BQ04-002's test row 3, owned by the task that owns the helper. §2/§4/§6 updated to match.
Known gaps:
  - `schemaFields` stamping: the exact runtime source (live `batched` handle vs `stmt.result.columns`) is not pinned — the page schema lives behind the `BatchedQuery` seam and whether `BigQueryPagedQuery` exposes `columns` at the settle point was not verifiable without implementing. TASK-BQ04-001's Interfaces explicitly authorizes the executor to pick whichever the seam exposes, with the structural shape as the contract. Cost if wrong: one read, not one round.
  - `runStatements` stamping is tested via either an extracted pure helper OR a fake-`ConnectionManager` harness — executor's choice (VS Code module surface makes a full end-to-end `runStatements` unit test heavy); both routes are specified in TASK-BQ04-001 Test Files.
  - TASK-BQ04-003 has no feature "happy path" row by design: it is a guard-only task whose three rows pin three distinct frozen surfaces (BQ-00 types / BQ-01 seam types / dependency manifest). Justification recorded in the task file; cycle-level happy-path coverage is carried by 001/002.
  - Guard tests depend on git history being present in the execution environment (true locally and in any checkout-based runner); documented in TASK-BQ04-003.
  - ACTIVE.md "Base: main @ 75cdb08" kept verbatim per cycle instruction, but planning-time HEAD is `358b183` (docs-only close-out commits after it); the guard test pins `75cdb08` as the stable release snapshot — rationale in TASK-BQ04-003 Discussion.

## Plan Review Log

### Round 1 — 2026-09-03 (separate-agent code-reviewer, unic-smart)

VERDICT: Approved.
LENS_RESULTS: completeness OK / consistency OK / clarity OK / scope OK / yagni OK / frozen-discipline OK / test-plan OK / verification OK / acceptance OK / risks-gaps OK.
FINDINGS:
  critical: none
  important: none
  minor:
    1. TASK-BQ04-003.md header cited "§4 rows 003.a-d" but §4 only has 003.a-c after the self-audit move → fixed: header now reads "003.a-c".
    2. PLAN.md §3.3 Purity note had self-questioning prose ("transitively? NO —") → fixed: rewritten as a plain statement of the import decision.
    3. PLAN.md §2 / §3.1 / §6 pinned the mirror interface at resultsGridModel.ts:44-61, but the actual `export interface StatementResult` declaration is at line 54 → fixed: pin tightened to 54-61 in all three sites, plus TASK-BQ04-001 line 15 mirror-edit line range.
WHAT_TO_PRESERVE: (1) exact file:line seam pins — every one the reviewer checked was accurate; (2) guard base pinned to release snapshot 75cdb08 with rationale recorded in TASK-BQ04-003 Discussion; (3) the self-audit trail: dependency-cycle fix (003 → guard-only) plus 5 named gaps with bounded executor fallbacks.

