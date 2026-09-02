# PLAN — Cycle BQ-01: BigQuery connection foundation

Source: `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §4 "BQ-01 — ADC connection and BigQuery adapter foundation" (lines 143-177). Dep: BQ-00 (shipped v1.46.0, GIVEN — `bigqueryTypes.ts` + `bigqueryAdc.ts` reused, not modified). Base: `main @ 9bfd07d` (v1.46.0). Baseline: BQ-00 close-out suite green at HEAD.

## §1 Intent

Let a user add, select, test and safely remove a BigQuery connection using Application
Default Credentials (ADC), an explicit billing project and a location preference.

Success looks like:

1. A connection created through the UI uses ADC externally and persists ONLY safe
   metadata (no credential path, token, or password for BigQuery — ADC is external).
2. Connection test names the failing class + fixed remediation (including
   `gcloud auth application-default login` only for the missing-ADC class).
3. Existing PostgreSQL/MySQL/MSSQL behavior — form, SecretStorage flow, factory — is
   behavior-unchanged (regression net = full suite at wave/cycle boundaries).

## §2 Scope

**In scope (4 tasks):**
- `src/config/types.ts` — extend `DriverType` + BigQuery-safe connection config shape
  with a pure validator (see §3).
- `src/adapters/bigquery.ts` (new) — `BigQueryAdapter implements DbAdapter`, calls into
  BQ-00's `createBigQueryClient` seam; idempotent close; safe page/scalar normalization.
- `src/adapters/factory.ts` — new `case "bigquery"` in the exhaustiveness switch,
  password-invariant for BigQuery.
- `src/core/connectionManager.ts` — BigQuery admission path: NO SecretStorage
  fake-password round-trip; dispose guard for the BigQuery path.
- `src/ui/connectionForm.ts`, `src/ui/connectionFormMessages.ts`,
  `webview/connectionFormMain.ts` — BigQuery-only fields (billing project, location,
  maxBytesBilled) render ONLY when `driver === "bigquery"`; copy-safe ADC remediation;
  submit gating.

**Out of scope this cycle (queued for later cycles, see roadmap §4):** BQ-02
explorer/preview and beyond; `package.json` driver settings/commands (none required so
far); any change to `bigqueryTypes.ts` / `bigqueryAdc.ts` (BQ-00 given surface); new ADR;
cross-platform manual smoke matrix (documented follow-up for the human).

**CONSTRAINT — same-wave file disjointness + wave plan (1+2+1):**
- Wave 1 (1 task): BQ01-001 owns `src/config/types.ts`.
- Wave 2 (2 tasks, parallel — disjoint files): BQ01-002 owns `src/adapters/bigquery.ts`;
  BQ01-004 owns the three form files. Disjoint ✓ — both consume only 001.
- Wave 3 (1 task): BQ01-003 owns `src/adapters/factory.ts` +
  `src/core/connectionManager.ts` together (no sibling shares them). Disjoint ✓.
- Dep-chain rationale: 002 imports 001's exported symbols (`validateBigQueryConnection`,
  `BigQueryConnectionFields`); 003 imports 002's `BigQueryAdapter` — same-wave parallel
  would break compile on not-yet-existing symbols, so 1+2+1 is the smallest correct wave
  plan (matches INDEX.md and Self-Audit item 7). 003 has no same-wave sibling.

## §3 Approach

- **Config model (BQ01-001):** `DriverType` gains `"bigquery"`. `ConnectionConfig` keeps
  `host/port/user/database` REQUIRED at the type level for the three SQL drivers
  (making them optional would ripple through 3 adapters + their tests for zero BQ-01
  value — alternative rejected), and gains an optional `bigquery` sub-object:
  `{ billingProject: string; location?: string; maxBytesBilled?: string; datasetProject?: string }`.
  A pure exported validator `validateBigQueryConnection(cfg): { ok: true } | { ok: false; reason: string }`
  (no vscode import, in `config/types.ts`) enforces: non-empty `billingProject`;
  `location`, when present, a non-empty string; `maxBytesBilled`, when present, a digit
  string > 0 (fail closed: `0`, negatives, non-numeric all rejected); for bigquery,
  `host === ""` and `port === 0` (host/port semantics rejected); redaction proven by test
  — `JSON.stringify(cfg)` of a valid bigquery config contains none of
  `credentials` / `keyFilename` / `token` / `password`.
- **Adapter (BQ01-002):** `BigQueryAdapter implements DbAdapter`. The adapter owns a
  private `BigQueryClientFactory` type whose options include `{projectId, location}` —
  location is part of the adapter's OWN factory surface, not BQ-00's: BQ-00's
  `createBigQueryClient(projectId?, impl?)` forwards only `{projectId}` to
  `new BigQuery(opts)` (bigqueryAdc.ts:172-178, frozen). The default
  `BigQueryClientFactory` wraps `createBigQueryClient` and forwards both fields to the
  underlying `new BigQuery(opts)` call. Tests inject a richer fake — BQ-00's
  `BigQueryClientLike` only has `listDatasets`, too narrow for adapter tests covering
  connect/close/runQuery normalization. The frozen BQ-00 seam is reused for
  `runAdcSmoke`; the adapter factory is a separate, broader type.
  `connect()` = build client with `billingProject` (+ location when configured) +
  `runAdcSmoke` → on diagnostic throw typed `BigQueryConnectError` carrying the
  `AdcDiagnostic` (category + fixed remediation, never raw err text). `close()`
  idempotent (second call resolves, no client rebuild). `runQuery`/pagination normalize
  through BQ-00's `toBigQueryPage`; INT64/NUMERIC/BIGNUMERIC cells stay branded strings
  (no numeric coercion). `testConnection()` = connect + smoke, mapping diagnostics to
  typed failure.
- **Admission (BQ01-003):** factory gains `case "bigquery": return new
  BigQueryAdapter(cfg)` inside `createAdapter(cfg, password)` — the incoming `password`
  argument is passed through by the signature (unchanged `(cfg, password)`) and
  deliberately ignored for bigquery (no password consumed; `never` exhaustiveness arm
  preserved). `ConnectionManager`:
  for `driver === "bigquery"` the password paths are skipped — `addConnection` must not
  `store`/`get` `vsdb.pass.<id>` (spy-proven), edit/connect never demand a missing
  password; `dispose()` sets a closed flag so post-dispose adapter construction for a
  bigquery connection fails fast with an explicit error instead of building a client;
  double-dispose stays a no-op.
- **Form (BQ01-004):** `ConnectionFormSubmit`/`ConnectionFormTest` gain
  `billingProject`, `bqLocation`, `bqMaxBytesBilled` (strings on the wire; "" = unset).
  Webview: for `driver === "bigquery"` render the BQ field group and hide
  host/port/user/password/SSL; reverse for the three SQL drivers. ADC remediation from a
  host `testResult` renders verbatim — never concatenated with user input (copy-safe).
  Submit gating: empty `billingProject` (or invalid maxBytesBilled) blocks save with an
  inline status — no `postMessage({type:"submit"})`.
- **Test seams:** no test performs a real GCP call. The adapter owns a
  `BigQueryClientFactory` type (broader than BQ-00's `BigQueryClientLike`); tests inject
  a fake factory that returns a fake client with the full method set the adapter needs
  (`query`, `getQueryResults`, `createQueryJob`, `cancel`, `listDatasets`, `getDataset`,
  `getTable`). `runAdcSmoke` is reused verbatim from BQ-00 — its `BigQueryClientLike` is
  sufficient there because `listDatasets` is the only call inside the smoke harness.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| unit (001) | valid bigquery config with billing project + location | `validateBigQueryConnection` returns `{ok:true}` |
| edge-empty (001) | empty/whitespace `billingProject` | `{ok:false}`, reason names billing project |
| edge-type (001) | `maxBytesBilled:"abc"` / `"-5"` / `"0"` | all `{ok:false}` (non-numeric / negative / zero) |
| edge-security (001) | `JSON.stringify(validBqConfig)` scanned | contains none of `credentials`, `keyFilename`, `token`, `password` |
| edge-compat (001) | legacy pg fixture (no `driver` extras) | validator `{ok:true}`; existing shape untouched |
| unit (002) | connect with injected fake client | resolves; impl called once with `{projectId: billingProject}` |
| edge-diag (002) | fake smoke throws "Could not load the default credentials" | rejects `BigQueryConnectError` with `category:"missing_adc"` + remediation matching `gcloud auth application-default login` |
| edge-lifecycle (002) | `close(); close()` | both resolve; factory not re-invoked; no throw |
| edge-propagation (002) | location `"EU"` configured | impl observed opts carry location |
| edge-normalization (002) | page with `"9007199254740993"` int cell | normalized output keeps string (branded), not number |
| unit (003) | `createAdapter(bigqueryCfg)` | returns `BigQueryAdapter` with DbAdapter duck-type methods |
| edge-admission (003) | manager `addConnection(bigqueryCfg, "")` | SecretStorage get/store never called with `vsdb.pass.<id>`; metadata persisted |
| edge-concurrent (003) | `dispose(); dispose(); getAdapterFor(bigqueryId)` | dispose idempotent; post-dispose use rejects explicit closed-error, no client constructed |
| regression (003) | existing pg add/connect suite | `connectionManager.test.ts` stays green (SecretStorage flow unchanged) |
| unit (004) | driver=bigquery form | `billingProject` input present; host/port/password/SSL inputs absent |
| edge-state (004) | bigquery + empty billingProject + Save | submit blocked; status message set; no `submit` postMessage |
| edge-copy (004) | `testResult` carries fixed ADC remediation | rendered verbatim; no user-input concatenation into remediation node |
| regression (004) | driver=postgres form | host/port/password/SSL present; BQ fields absent; existing assertions green |

Edge-kind coverage: 001 = empty + wrong-type/negative + security-redaction +
backward-compat (4 kinds); 002 = diagnostic-mapping + lifecycle-concurrency +
propagation + normalization (4 kinds); 003 = admission/security + double-dispose
concurrency + regression (3 kinds); 004 = render-state + submit-gating + copy-safety +
regression (4 kinds).

## §5 Verification

Per-task: focused vitest file + `npm run typecheck` (see each TASK file). The repo has
**no lint script** — `npm run typecheck` is the static gate (BQ-00 precedent). Webview
bundle tests (004) require `npm run compile` first (dist/connectionForm.js).
Wave/cycle boundary regression net: full `npm test`; BQ-00 suites
(`bigqueryTypes.test.ts`, `bigqueryAdc.test.ts`, `bigqueryPackage.test.ts`) must remain
untouched-green.

```bash
npm run typecheck
npm run compile
npm test
```

## §6 Acceptance

- [ ] `driver:"bigquery"` config: billing project required, location/cost optional but
      validated, serialization redaction proven (TASK-BQ01-001).
- [ ] `BigQueryAdapter` connects via BQ-00 seam; no-ADC → `missing_adc` + gcloud
      remediation; close idempotent; branded strings preserved (TASK-BQ01-002).
- [ ] Factory exhaustive incl. bigquery; active BigQuery connection never asks
      SecretStorage for a fake password; dispose blocks later adapter use (TASK-BQ01-003).
- [ ] BQ fields render only for bigquery; invalid state cannot silently submit; ADC copy
      verbatim; 3-driver form behavior unchanged (TASK-BQ01-004).
- [ ] Full `npm test` green at cycle end; `npm run typecheck` clean.
- [ ] Zero credential/token/service-account-JSON imports or stores in the diff
      (executor runs the grep audit and records output).
- [ ] No real GCP network call in any test.

## §7 Global Constraints

- Reuse `src/adapters/bigqueryTypes.ts` + `src/adapters/bigqueryAdc.ts` as-is — no
  duplicate/rename/re-export; BQ-01 code imports their public symbols.
- ADC stays EXTERNAL: no credential/OAuth/service-account-JSON import, store, or mock
  fixture anywhere in this cycle.
- TDD: RED first with pasted failing output, then GREEN; no silent instant-pass.
- No real GCP call in tests — inject the adapter-owned `BigQueryClientFactory` (whose
  default impl wraps BQ-00's `createBigQueryClient`); `runAdcSmoke` keeps consuming the
  BQ-00 `BigQueryClientLike` shape verbatim.
- Branded `BigQueryInt64String` / `BigQueryNumericString` / `BigQueryBigNumericString`
  discipline preserved at every new boundary.
- `factory.ts` switch keeps the `never` exhaustiveness arm; bigquery has no
  host/port/password path.
- Tests must not depend on network, ADC environment, or `gcloud` presence.
- No lint script exists — `npm run typecheck` is the static gate in every task.

## Plan Review Log


## Planner Self-Audit

Checklist: 12/12 pass
1. §6 criteria → tasks: criterion 1→001, 2→002, 3→003, 4→004, 5→all (wave-boundary net),
   6→all (grep audit in executor reports), 7→002/003/004 (fake-only harnesses). Named.
2. Every task traces to roadmap §4 BQ-01 row 1-4 respectively; no invented task.
3. Success definition fully covered: add (004→003→001), select (003 setActive), test
   (002 diagnostics + 004 gating), remove (003 dispose) — no partial delivery.
4. Unhappy paths planned: no-ADC (002 #2), bad billing project/API denied classes via
   BQ-00 classifier reuse (002/004), invalid form state (004 #2), post-dispose use
   (003 #4), legacy config compat (001 #5).
5. Target Files verified: `config/types.ts`, `factory.ts`, `connectionManager.ts`,
   `connectionForm.ts`, `connectionFormMessages.ts`, `webview/connectionFormMain.ts`
   exist at HEAD (git ls-files); `bigquery.ts` marked (new); test files: 4 new + 2
   modified, all parent dirs exist.
6. Verification commands real: `npx vitest run <file>`, `npm run typecheck`,
   `npm run compile`, `npm test` — all defined in package.json scripts (no lint script;
   stated explicitly).
7. Same-wave file sharing: wave 1 = 001 (config/types.ts) ∥ nothing; wave 2 = 002
   (bigquery.ts) ∥ 004 (form files) — disjoint; 003 alone in wave 3 with both its files.
8. No dangling dependency: 003 consumes `BigQueryAdapter` (002) + validator (001); 004
   consumes field names (001). All created by earlier waves.
9. Edge kinds: ≥2 genuinely different kinds per task (001: empty/type-negative/security/
   compat; 002: diag-mapping/lifecycle/propagation/normalization; 003: admission/
   concurrency/regression; 004: render-state/copy/wire/regression).
10. Every Expected is concrete (`{ok:false}` + reason content, spy count 0, exact copy
    match, typeof checks) — none are "works correctly".
11. Not a bugfix cycle — regression rows (003 #6, 004 #4) pin existing suites instead.
12. Not all tests pass on empty impl: each happy case requires new exported symbols
    (validator, adapter class, factory case, DOM fields) — an empty implementation fails
    compile/instanceof/DOM assertions.

Fixed during audit: INDEX wave bullets initially wrote a contradictory "wave 1 (2)"
header while 001→002 is a real dependency — corrected to 1+2+1 waves.
Known gaps: real-ADC cross-platform manual smoke (roadmap acceptance #4) is a human
follow-up, not an AI task; introspection SQL surfaces (listColumns etc.) are scoped to
BQ-02 with NotImplementedError allowed this cycle (recorded in TASK-BQ01-002 Discussion).
Location propagation mechanism now pinned (round 2): adapter-owned `BigQueryClientFactory`
opts `{projectId, location}`, default impl wraps BQ-00's `createBigQueryClient` — no
executor-side seam decision remains open.

## Planner Report
PLANNER_MODEL: unic-smart

### Round 1 — 2026-09-02 — Issues Found
Reviewer model: unic-smart

critical: none
important: docs/AI_HANDOFF/PLAN.md:40-45 — §2 wave constraint block contradicts the plan's own Planner Self-Audit item 7 and INDEX.md:14-16: it schedules 001+002 in "Wave 1" and 003+004 in "Wave 2", but 002 imports 001's exported symbols (`validateBigQueryConnection`) and 003 imports 002's `BigQueryAdapter` — same-wave parallel execution would fail compile on not-yet-existing symbols. Fix: rewrite the §2 block to the 1+2+1 layout (W1=001; W2=002∥004; W3=003) already used in the self-audit and INDEX.
important: docs/AI_HANDOFF/PLAN.md:64-65,86 — §3 claims location is "propagated via the factory's opts surface" and that test fakes "implement `BigQueryClientLike`", but the frozen BQ-00 seam (src/adapters/bigqueryAdc.ts:172-178) forwards only `{projectId}` and `BigQueryClientLike` (bigqueryAdc.ts:51-53) has only `listDatasets` — no location channel and no query surface for `runQuery`. TASK-BQ01-002's Discussion already resolves this (adapter-owned wider factory type; never edit bigqueryAdc.ts); §3 must be corrected to match, otherwise an executor following the plan verbatim either edits frozen BQ-00 files (violating §7) or fails typecheck.
minor: docs/AI_HANDOFF/PLAN.md:88-115 — roadmap BQ-01 edge case "user changes active connection during test" has no pinning test or Discussion note in TASK-BQ01-003/004; existing lifecycle-generation guards likely cover it — record that assumption in a Discussion entry or add one edge test.
minor: docs/AI_HANDOFF/PLAN.md:71 — factory sketch `return new BigQueryAdapter(cfg)` omits the (deliberately ignored) password parameter of `createAdapter(cfg, password)`; task file is authoritative — align wording.

NOTES: Structure, test plan, scope, and YAGNI discipline are solid: §1-§7 plus Planner Report present, validator rules and every §4 Expected are concrete, edge-kind counts meet minTestsEdgeCase per task, BQ-00 surface is explicitly frozen and reused rather than duplicated, out-of-scope (Storage Read API, write workflows, token storage, package.json) is clean, and the "no lint script / typecheck is the static gate" claim matches package.json. Both important findings are documentation-level but execution-breaking if followed as written, and both already have correct resolutions elsewhere (Self-Audit/INDEX for waves, TASK-BQ01-002 Discussion for the seam) — round 2 should only need §2 and §3 wording fixes. Transparency note: planner self-reports unic-smart and reviewer runs unic-smart; the spec/plan review contract has no executor-isolation gate, so this is recorded, not blocking.

### Round 2 — 2026-09-02 — Resolved
Reviewer model: unic-smart
Applied: §2 wave block rewritten to 1+2+1 (001 → {002 ∥ 004} → 003) with dep-chain rationale; §3 BQ01-002 location propagation rewritten to "adapter-owned `BigQueryClientFactory` wraps BQ-00 seam" matching TASK-BQ01-002 Discussion; §3 test-seam paragraph corrected (fakes implement the adapter's own factory type, not BQ-00's `BigQueryClientLike`; `runAdcSmoke` reuses BQ-00's narrower interface as-is).
NOTES: TASK-BQ01-002 Discussion already documented the correct mechanism; PLAN.md §3 caught up. No new tests, no scope change. Extra touchups in the same round: TASK-BQ01-002 Interfaces block replaced the contradictory `clientFactory?: typeof createBigQueryClient` sketch with the adapter-owned `BigQueryClientFactory` + broader `BigQueryClient` type (sync Discussion entry added); §7 global constraint reworded to the same wrapped-factory injection; §3 admission sketch now notes `createAdapter(cfg, password)` passes and ignores the password arg (Round 1 minor); TASK-BQ01-003 Discussion records the active-connection-during-test lifecycle-guard assumption (Round 1 minor); Self-Audit Known gaps updated — location mechanism is pinned, no longer executor-open.

### Round 2 verification — 2026-09-02 — Approved
Reviewer model: unic-smart
Independently verified both Round-1 important findings are resolved (source-checked):
  - Wave block (PLAN.md §2 CONSTRAINT) now reads 1+2+1 (W1=001; W2=002∥004 disjoint;
    W3=003) with the dep-chain rationale "002 imports 001's symbols, 003 imports 002's
    adapter" — consistent with INDEX.md wave bullets and Self-Audit item 7. Resolved.
  - §3 BQ01-002 now pins the adapter-owned `BigQueryClientFactory` with `{projectId,
    location}` opts wrapping BQ-00's `createBigQueryClient`; verified in source that
    bigqueryAdc.ts:172-178 forwards only `{projectId}` — no location-through-BQ-00-seam
    claim remains anywhere in the plan. Resolved.
  - §3 test-seam paragraph: fakes implement the adapter's broader factory type;
    `runAdcSmoke` reuses BQ-00's `BigQueryClientLike` (bigqueryAdc.ts:51-53,
    listDatasets-only — confirmed) verbatim. Accurate. Resolved.
  - TASK-BQ01-002 Interfaces block lists the adapter-owned `BigQueryClientFactory` +
    broader `BigQueryClient`; Discussion entry 2 explicitly retracts the stale
    `clientFactory?: typeof createBigQueryClient` sketch. In sync.
COMPLETENESS: none
CONSISTENCY: none
CLARITY: none
SCOPE: none
YAGNI: none
NOTES: Approved. One non-blocking nit, recorded not blocking: TASK-BQ01-002 test-row #1
fixture column still hints "fake BigQueryClientLike (mirror bigqueryAdc.test.ts #1)"
while the normative Interfaces block (same file) requires the broader `BigQueryClient`;
typecheck at the injection site forces the correct shape, so no plan change needed.
Round-1 minors also confirmed fixed: §3 admission sketch notes `createAdapter(cfg,
password)` ignores password for bigquery; TASK-BQ01-003 Discussion records the
active-connection-during-test lifecycle-guard assumption.

PLAN_REVIEW: Approved by unic-smart (Round 2)
