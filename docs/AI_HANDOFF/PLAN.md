# PLAN — Cycle BQ-00: BigQuery provider feasibility + adapter contract spike

Source spec: `docs/plans/2026-09-01-bigquery-provider-roadmap.md` §4 "BQ-00 — Provider feasibility and contract spike" (P0, mandatory measurement cycle — not a feature release). Commissioned per roadmap §9.2: a NEW handoff cycle, no prior `docs/AI_HANDOFF` artifact overwritten, paths re-validated at current HEAD `main @ 35f7aff` (post-ARP-09, v1.45.0).

## §1 Intent

Goal (user, verbatim): "Ship BQ-00: provider feasibility + adapter contract spike for Google BigQuery. No real ADC. Prove `@google-cloud/bigquery` integrates with the existing VSDB adapter boundary without modifying existing drivers."

P0 user decision (2026-09-02): **BQ-00 first**; the four STATUS.md follow-ups are deferred to a later cycle.

Success = the four roadmap acceptance checks, each verifiable at cycle end (see §6):

1. Package/version/bundle behavior is proved in CI-compatible build conditions.
2. The adapter contract explicitly says who owns job IDs/page tokens and how nested and precision-sensitive values display.
3. Missing ADC, bad billing project, denied API, and wrong location are distinguishable without secrets.
4. No existing driver type or UI is changed unless a test demonstrates the need (BQ-00 changes none — §3 proves it).

DEFERRED (out of scope this cycle): roadmap sub-cycles BQ-01..BQ-07 and the 4 STATUS.md follow-ups: (1) browseCommands unguarded `finally`, (2) MSSQL `[insert]` bracket false positive, (3) ARP-07 form-view/AI plan-apply invalidation gap, (4) ARP-08 snapshot name-field uncapped.

## §2 Scope

**IN:**

| Task | Roadmap | Owns (no other task in its wave touches these) |
|---|---|---|
| TASK-BQ00-001 (w1) | BQ-00.1 package + bundle proof | `package.json` (deps only), `package-lock.json`, `src/adapters/__tests__/bigqueryPackage.test.ts` (new), `docs/decisions/_bq00-evidence.md` (new, scratch evidence) |
| TASK-BQ00-002 (w2) | BQ-00.2 pure job/page contract | `src/adapters/bigqueryTypes.ts` (new), `src/adapters/__tests__/bigqueryTypes.test.ts` (new) |
| TASK-BQ00-003 (w2) | BQ-00.3 ADC diagnostic seam | `src/adapters/bigqueryAdc.ts` (new), `src/adapters/__tests__/bigqueryAdc.test.ts` (new) |
| TASK-BQ00-004 (w3) | BQ-00.4 ADR/contract | `docs/decisions/0004-bq-00-feasibility-contract.md` (new), `docs/decisions/README.md` |

**OUT:** BQ-01..BQ-07; the 4 deferred follow-ups; any edit to `src/adapters/{factory,mssql,mysql,postgres,types}.ts`, `src/core/queryRunner.ts`, `src/ui/resultsPanel.ts`, `src/extension.ts`, `esbuild.js` (all read-only — the bundle probe calls esbuild's JS API from inside the test, so the bundler config is unchanged); any real-GCP automated test; `vitest.integration.config.ts`; no new commands/settings/UI.

## §3 Approach

**Grounding corrections to the roadmap** (recorded so executors do not rediscover them):

- `docs/decisions/` already exists (ADR 0001-0003 + README index table; convention: `NNNN-slug.md`, `Status: Accepted (gating ...)` header, README row). The roadmap's "0001 genesis" fallback is stale — the BQ-00 ADR is **`0004-bq-00-feasibility-contract.md`**.
- Candidate version verified live from npm registry (2026-09-02): **`@google-cloud/bigquery@9.0.3`** (latest stable; `engines.node >= 22`; dev box Node v22.22.1 OK; dep tree includes `big.js` ^7, which supports the precision contract). **Runtime caveat to measure, not assume:** 9.x requires Node >= 22 while the extension host for `engines.vscode ^1.75.0` runs older Node; because esbuild bundles the client into `dist/extension.js` (only `vscode` external), the binding constraint is what the bundle actually needs, which the probe measures. BQ-00.1 pins `^9.0.3`, records the probe result, and if it fails falls back to `^8.3.1` (`engines.node >= 18`, verified live) — recording the choice and reason for the ADR. Never silently ship a broken floor.
- Bundle reality: BQ-00 wires nothing into `src/extension.ts`, so `npm run compile` never sees the library — a `grep bigquery dist/extension.js` smoke is unfalsifiable. The "load the client from a test seam" requirement is satisfied by a **bundle probe test**: esbuild programmatic API (`build({ stdin, bundle: true, platform: "node", format: "cjs", target: "node18", external: ["vscode"] })`) over a virtual entry importing the client, asserting the build succeeds under the extension's exact build options. CI-compatible, no dead code shipped, `esbuild.js` untouched.
- **`src/adapters/types.ts` needs no change — proven, not assumed:** `DbAdapter` already carries optional seams (`cancelActiveQuery?`, `beginTransaction?`, `RunResult.batched?`, `capabilities?: AdapterCapabilities` + fail-closed `hasAdapterCapability`). BQ-00's job/page contract is standalone pure types; whether a provider capability must be ADDED is an ADR recommendation for a later cycle (BQ-01), not a code change here. If an executor proves a gap, that is a stop-and-revise event (roadmap §9.6) surfaced via task Discussion for a P0 micro-decision — not a silent edit.
- **Wave plan vs commissioning brief (deliberate, recorded):** BQ-00.3 consumes no BQ-00.2 symbol — the classifier pattern-matches synthetic error inputs and its client seam is its own structural interface. Its only real dependency is the installed package (001). So 002 ∥ 003 run in parallel in wave 2 on disjoint files; 002 depends on 001 because its executor must validate response field names against the installed client's `.d.ts` (roadmap §2 mandate: method names "validated against the package version selected in BQ-00"). 004 depends on all three (ADR cites their recorded evidence).
- Rejected alternatives: **Storage Read API** (separate measured decision — roadmap BQ-07e), **browser OAuth flow** (user chose ADC-first; larger secret surface), **service-account JSON import** (explicitly out of scope, phase one), **wiring the client into `dist/extension.js` now** (BQ-01 territory; would ship unused code and force factory/manager questions before the contract is settled).

Per task:

- **BQ-00.1** — `npm install @google-cloud/bigquery@^9.0.3` (lockfile pins exact). New `bigqueryPackage.test.ts`: (a) module loads in Node 22 without credentials (import ≠ client construction — no ADC env required); (b) bundle probe under extension build options (esbuild buildMode; reports output byte size; asserts no `vscode` inlining); (c) credential-safety byte-scan on probe output (`application_default_credentials`, `private_key`, `BEGIN RSA PRIVATE KEY` absent); (d) pin consistency (single lockfile resolution matching `^9.0.3`); (e) **roadmap line-67 evidence**: a test parses `node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts` (+ `build/src/job.d.ts`) and asserts the pagination/cancellation method names exist as declarations — `getQueryResults`, `query`, `createQueryJob` on the client and `cancel` on the Job class — and the executor records each name + signature + return shape (incl. `job.cancel()`'s return) with file+line refs into `docs/decisions/_bq00-evidence.md`, the on-disk evidence file ADR 0004 cites by path (Discussions are not stable citations). Package smoke = `npm run compile` regenerates `dist/extension.js` (byte-unchanged content expectation: nothing imports the client yet).
- **BQ-00.2** — new pure `bigqueryTypes.ts`, no import from `@google-cloud/bigquery` (boundary stays pure): `BigQueryJobRef {projectId, location, jobId}`, `BigQuerySchemaField` (recursive `fields` for RECORD), `BigQueryPage {jobRef, schema, rows, totalBytesProcessed?, totalBytesBilled?, pageToken: string | null}`, `BigQueryPageRequest`, `BigQueryValue` (INT64/NUMERIC/BIGNUMERIC contractually canonical strings — never JS `number`), `hasNextPage(page): boolean`, **and one named mapper export `toBigQueryPage(raw: BigQueryRawQueryResponse): BigQueryPage`** — a pure function from the client's raw response shape (as validated against the installed `.d.ts`) to the contract type. The §4 happy-path test's subject is `toBigQueryPage`: the fixture goes IN, a `BigQueryPage` with verbatim `jobRef` comes OUT — the test cannot pass with types alone. Executor validates field names against the installed `.d.ts` and records evidence in Discussion for the ADR; the pagination/cancel method names live in `_bq00-evidence.md` (owned by 001).
- **BQ-00.3** — new `bigqueryAdc.ts`: `AdcDiagnosticCategory = "missing_adc" | "bad_billing_project" | "api_denied" | "location_mismatch" | "unknown"`; `AdcDiagnostic {category, remediation}`; pure `classifyAdcDiagnostic(err: unknown): AdcDiagnostic` — emits only category + fixed copy-safe remediation text (redaction by construction: never echoes `err.message`); `BigQueryClientLike` + `createBigQueryClient(projectId?)` as the test seam (thin wrapper over the real constructor, injectable); `runAdcSmoke(client): Promise<"ok" | AdcDiagnostic>` listing one allowed resource through the injected client. CI uses fake clients + synthetic errors only; the real-ADC manual recipe (disposable project; never record env values/tokens) is an ADR appendix written in 004.
- **BQ-00.4** — ADR 0004 deciding: client method/version (validated evidence from 001's `docs/decisions/_bq00-evidence.md`, cited by path, incl. the 9.x-vs-8.x engine-floor outcome), continuation ownership (VSDB owns `BigQueryJobRef` + opaque page token; client stateless per page), cancellation mapping (owned active job ID only; cancel-after-terminal harmless; **`job.cancel()` return shape as recorded in `_bq00-evidence.md`** — the roadmap line-67 mandate's cancellation owner), safe scalar conversion table (§5 of roadmap), selected config fields (billing project, location, `maximumBytesBilled`), least-privilege IAM set, Storage Read API deferral, manual ADC smoke recipe appendix — plus two reviewer-mandated sections: **"Pagination + cancellation method names"** (the enumerated signatures from `_bq00-evidence.md`: `getQueryResults`, `query`, `createQueryJob`, `job.cancel` with return shapes) and a **"Grid continuation mapping"** paragraph mapping `BigQueryPage.pageToken` onto the existing read-only grid contract (`RunResult.batched` at `src/adapters/types.ts:78` + `resultsPanel.ts` `loadMore` → `runner.loadMore(index)`) as a paper deliverable only. README table row appended.

## §4 Test Plan

**TASK-BQ00-001 — package + bundle proof**

| Type | Test | Expected |
|---|---|---|
| happy | `client module loads under Node without credentials` | dynamic `import("@google-cloud/bigquery")` resolves; default export exposes a `BigQuery` constructor; no ADC env needed for module load |
| happy | `bundle probe succeeds under extension build options` | esbuild-API build (bundle, node/cjs, target node18, external vscode) exits 0; output contains a known client marker; byte size reported in log |
| edge (credential safety) | `probe output contains no credential artifacts` | output lacks `application_default_credentials`, `private_key`, `BEGIN RSA PRIVATE KEY` |
| edge (pin boundary) | `lockfile resolves exactly one version in range` | single lockfile entry for `@google-cloud/bigquery`, version satisfying `^9.0.3` (or recorded `^8.3.1` fallback) |
| edge (bundle boundary) | `vscode stays external in probe` | probe output does not inline a resolved `require("vscode")` — external honored, same as the real build |

**TASK-BQ00-002 — pure job/page contract**

| Type | Test | Expected |
|---|---|---|
| happy | `toBigQueryPage maps fixture to BigQueryPage preserving jobRef identity` | calling exported `toBigQueryPage(rawFixture)` returns a `BigQueryPage`; `jobRef` `{projectId, location, jobId}` verbatim; deep-equals the expected mapped object |
| edge (empty) | `empty final page has no next` | `rows: []`, `pageToken: null` → `hasNextPage === false` |
| edge (empty-vs-token) | `empty page can still continue` | `rows: []` + non-null token → `hasNextPage === true` (token, not row count, owns continuation) |
| edge (continuation/ownership) | `page token round-trips opaquely` | token passes into `BigQueryPageRequest` unmodified — no parse/trim/truncate |
| edge (structural) | `nested RECORD + REPEATED preserved` | 2-level nested schema with REPEATED mode; arrays and `fields` recursion intact |
| edge (precision/boundary) | `NUMERIC/BIGNUMERIC canonical strings` | `"12345678901234567890.123456789"` and `"9007199254740993"` (> MAX_SAFE_INTEGER) stay `typeof "string"` with exact digit equality — fails under any `Number` coercion |

**TASK-BQ00-003 — ADC classifier + client seam**

| Type | Test | Expected |
|---|---|---|
| happy | `fake client smoke resolves ok` | injected fake listing one dataset → `runAdcSmoke` resolves `"ok"`; client constructed once — observed via `createBigQueryClient`'s injectable `impl` parameter counted with a Vitest `vi.fn()` (`expect(implSpy).toHaveBeenCalledTimes(1)`); projectId propagated |
| edge (missing credential) | `missing ADC classified with gcloud remediation` | synthetic `"Could not load the default credentials"` → `missing_adc`; remediation names `gcloud auth application-default login` |
| edge (two distinct permission classes) | `denied API vs bad billing project distinguishable` | synthetic 403 project access denied → `api_denied`; synthetic 404 project-not-found → `bad_billing_project` (different categories) |
| edge (semantic) | `wrong location classified; unknown falls back` | location-mismatch text → `location_mismatch`; unrecognized error → `unknown` + generic remediation |
| edge (security/redaction) | `classifier never echoes raw error text` | synthetic message containing `"Bearer abc123"` yields diagnostic where neither `category` nor `remediation` contains the token or the raw message |

**TASK-BQ00-004 — ADR 0004** (docs-only; command-verified content checks — no source behavior to test, justified per RULES N/A rule)

| Type | Check | Expected |
|---|---|---|
| happy | ADR exists with all required decision sections | file contains headings: version/method, continuation ownership, cancellation, scalar conversion, config fields, IAM, Storage Read deferral, ADC recipe |
| happy (method-name evidence) | "Pagination + cancellation method names" section present and cites the evidence file | ADR names `getQueryResults`, `query`, `createQueryJob`, `job.cancel` and cites `docs/decisions/_bq00-evidence.md` by path |
| edge (paper mapping) | "Grid continuation mapping" paragraph present | ADR maps `BigQueryPage.pageToken` onto the read-only grid continuation contract (`RunResult.batched` / `resultsPanel.ts` `loadMore`) WITHOUT any edit to those files |
| edge (consistency) | recorded version matches lockfile pin | ADR states the exact installed version |
| edge (index completeness) | README table updated | `docs/decisions/README.md` gains a `0004` row |

Regression net: full `npm test` at every wave boundary; suite floor 3189 passed | 2 skipped must not drop; BQ-00 adds tests on top.

## §5 Verification

```bash
# Focused (per task — exact paths)
npx vitest run src/adapters/__tests__/bigqueryPackage.test.ts
npx vitest run src/adapters/__tests__/bigqueryTypes.test.ts
npx vitest run src/adapters/__tests__/bigqueryAdc.test.ts

# Static gate — every task (NO lint script exists in this repo; none invented — roadmap §7 concurs)
npm run typecheck

# Bundle gate — every task (cheap, catches bundle breakage from the new dep)
npm run compile

# Package smoke (mandatory in TASK-BQ00-001)
npm run compile && test -f dist/extension.js

# Wave/cycle boundary regression net
npm test
```

Notes: focused paths are direct file paths — the new test files are not yet in `.cache/index/tests-map.json` (stale, 3 entries; no `src/adapters/types.ts` entry); the roadmap orders an index refresh at next commissioning. RULES' fallback floor names `yarn test:release-core` (a ukit-repo script that does not exist here); this npm repo's non-empty floor is `npm test`. New files are named `*.test.ts` (NOT `*.integration.test.ts`, which `vitest.config.ts` excludes from `npm test`).

## §6 Acceptance

Roadmap bullets 1:1:

- [ ] Package/version/bundle behavior proved in CI-compatible build conditions → TASK-BQ00-001.
- [ ] Adapter contract states who owns job IDs/page tokens and how nested/precision-sensitive values display → TASK-BQ00-002 types+tests; decision recorded in TASK-BQ00-004.
- [ ] Missing ADC / bad billing project / denied API / wrong location distinguishable without secrets → TASK-BQ00-003 classifier + redaction test; recipe in TASK-BQ00-004.
- [ ] No existing driver type or UI changed unless a test demonstrates the need → all tasks; `git diff --stat` on the §2 read-only list must be empty at cycle end; `src/extension.ts` untouched.

Per-task done criteria in each `tasks/TASK-BQ00-00x.md`; every task additionally requires fresh RED→GREEN evidence in its Executor Report, `npm run typecheck` + `npm run compile` green, reviewer model ≠ executor model, full `npm test` green at wave boundaries (floor 3189|2 preserved).

## §7 Global Constraints

- `@google-cloud/bigquery` pinned `^9.0.3` (fallback `^8.3.1` only via the documented engine-floor outcome); lockfile pins one exact version; no other dependency changes; no new devDependencies (esbuild already present).
- Node >= 22 on the dev/test box (client 9.x floor; repo runs v22.22.1). esbuild target stays `node18` — do not raise or lower it.
- npm only (no yarn/pnpm). VS Code engine `^1.75.0` and all existing scripts unchanged.
- No automated test constructs a real GCP client or requires ADC; no test file named `*.integration.test.ts`.
- No secrets, env values, tokens, credential paths, or raw error text in any test, fixture, log, or ADR. Classifier output is fixed-copy remediation only (redaction by construction).
- Read-only this cycle: `src/adapters/{factory,mssql,mysql,postgres,types}.ts`, `src/core/queryRunner.ts`, `src/ui/resultsPanel.ts`, `src/extension.ts`, `esbuild.js`, `vitest.config.ts`, `vitest.integration.config.ts`.

## Planner Report
PLANNER_MODEL: unic-smart
PLAN_REVIEW: Approved by unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: (1) corrected the roadmap's stale ADR numbering — `docs/decisions/` exists (0001-0003 + README), so BQ-00's ADR is `0004`, not "0001 genesis"; (2) replaced the naive "grep bigquery markers in dist/extension.js" package smoke with an esbuild-API bundle probe after verifying nothing imports the client yet (dist could never contain it — unfalsifiable test); (3) caught the 9.x `engines.node >= 22` floor vs `engines.vscode ^1.75.0` extension-host question via live npm registry checks (8.3.1 = node>=18 fallback documented, 7.9.4 = node>=14 verified too) and made the engine-floor outcome a measured deliverable of 001/004 instead of an assumption; (4) wave 2 widened to run 002 ∥ 003 after proving 003 consumes no 002 symbol (deviation from the commissioning brief's serial order recorded in §3).
Known gaps: the real-ADC manual recipe is authored in BQ-00.4 but NOT executed this cycle (no disposable test project provisioned) — first live run belongs to BQ-01's environment; the grid continuation mapping is a paper deliverable only (grid files are read-only this cycle); BQ-00.4 is docs-only with command-verified content checks instead of vitest tests (justified in §4). Round 2 note: `.d.ts` method-name evidence is no longer Discussion-only — it is a vitest-parsed proof test + on-disk `_bq00-evidence.md` owned by 001.

## Plan Review Log

### Round 1 — 2026-09-02 · unic-smart
REVIEWER_MODEL: unic-smart
Status: Issues Found
VERDICT: Issues Found

FINDINGS:
  - docs/AI_HANDOFF/PLAN.md §3 (BQ-00.2) — no mapper function is named; §4's happy-path test "fixture maps to BigQueryPage preserving jobRef identity" has no defined subject. A literal executor may create types only and test the fixture against itself. Fix: name the export (e.g. `toBigQueryPage(raw: RawQueryResponse): BigQueryPage`) in §3 BQ-00.2 so the test, the ADR grid-mapping claim, and the reviewer's coverage check anchor to one function.
  - docs/AI_HANDOFF/PLAN.md §3 (BQ-00.2/BQ-00.4) — roadmap line-67 mandate is only partially assigned: the `.d.ts` evidence step covers "response field names" only. Job cancellation return shape (`Job.cancel()` / `jobs.cancel` return) has NO owner in any task, and pagination method names (createQueryJob / getQueryResults / autoPaginate) are not enumerated. BQ-00.4's ADR "cites recorded evidence" but nothing records this evidence. Fix: extend BQ-00.2's Discussion-evidence step to enumerate the pagination/job/cancel method signatures from the installed .d.ts, and add cancellation-return-shape to BQ-00.4's required ADR sections.
  - docs/AI_HANDOFF/PLAN.md §4 (BQ-00.3 happy test) — "client constructed once; projectId propagated" states no observation mechanism. Minor: one sentence on how the seam exposes constructor calls (injectable constructor spy) removes executor guesswork.
  - docs/AI_HANDOFF/PLAN.md §3 (BQ-00.4) — continuation ownership is stated, but the roadmap's "exact VSDB grid continuation mapping" deserves one explicit ADR paragraph mapping BigQueryPage/pageToken onto the existing grid continuation contract (RunResult.batched / browse load-more), since the grid code is read-only this cycle and the paper mapping is the deliverable.

COMPLETENESS: none — all sections §1-§7 + Planner Report + Self-Audit present; per-task fields (Target Files §2, Dependencies §3, Test Cases §4, Verification §5, Acceptance §6) present; PLANNER_MODEL footer intact.
CONSISTENCY: none — wave plan matches the dependency graph (002←001, 003←001, 004←all); wave-2 files disjoint; §7 read-only list matches §2 OUT; the wave-2 parallelism deviation from the roadmap's serial order is recorded with rationale in §3.
SCOPE: none — BQ-01..07 + the 4 follow-ups deferred; no real ADC in CI (fake clients + synthetic errors only); manual recipe authored-not-executed honestly disclosed in Known gaps; read-only list enforced via `git diff --stat` in §6.
YAGNI: none — bundle probe is load-bearing (naive dist grep unfalsifiable since nothing imports the client yet); version pin + measured 8.3.1/7.9.4 fallbacks justified; no duplication of existing tests.

NOTES: Verified live before verdict: `npm test` = 3189 passed | 2 skipped (floor claim exact); docs/decisions/ has 0001-0003 + README (ADR 0004 numbering correct); no lint script in package.json (§5's omission is correct); esbuild target node18 at esbuild.js:20; DbAdapter seams exist at src/adapters/types.ts:122-183; vitest.config.ts excludes *.integration.test.ts; Node v22.22.1. Both important findings are one-line plan edits — incorporate and re-review, or proceed with them as executor instructions.

### Round 2 — findings applied
PLANNER_MODEL: unic-smart (re-applied)
APPLIED:
  - Important 1: named `toBigQueryPage` export in §3 BQ-00.2 + TASK-BQ00-002.md Target Files + Test Cases.
  - Important 2: BQ-00.1 now records .d.ts method names into `docs/decisions/_bq00-evidence.md`; BQ-00.4 ADR cites that file and gains a "Pagination + cancellation method names" section.
  - Minor 1: BQ-00.3 happy test now asserts constructed-once.
  - Minor 2: BQ-00.4 ADR gains a "Grid continuation mapping" paragraph.
DETAIL:
  - Important 1 — `toBigQueryPage(raw: BigQueryRawQueryResponse): BigQueryPage` added as a named pure export in §3 BQ-00.2; §4 row 002's happy test re-titled "toBigQueryPage maps fixture to BigQueryPage preserving jobRef identity" so the subject is the real function (types-only implementation cannot pass); TASK-BQ00-002 Target Files, test #1, Acceptance #1, and the Interfaces type block updated; Round-2 Discussion note records the 001/002 evidence split (field names in 002, method names in 001).
  - Important 2 — §3 BQ-00.1 gains item (e): vitest test #7 parses `node_modules/@google-cloud/bigquery/build/src/bigquery.d.ts` + `build/src/job.d.ts` asserting `getQueryResults`, `query`, `createQueryJob`, `job.cancel` declarations; executor writes `docs/decisions/_bq00-evidence.md` (NEW Target File of TASK-BQ00-001, signature + return shape + file:line refs, explicitly covering the previously owner-less `job.cancel()` return shape). TASK-BQ00-004 gains Test #4 (ADR cites the file by path + enumerates the four names) and the "Pagination + cancellation method names" ADR section in its required-headings list; §2 ownership table and TASK-BQ00-001 Target/Test Files/Acceptance/Interfaces updated to match.
  - Minor 1 — §4 row 003's happy test and TASK-BQ00-003 test #1 now name the observation mechanism: the seam's existing injectable `impl` parameter wrapped in `vi.fn()`, asserted `expect(implSpy).toHaveBeenCalledTimes(1)` with `projectId` checked inside the captured options — no new mocking surface.
  - Minor 2 — §4 row 004 gains a "paper mapping" check row; TASK-BQ00-004 gains Test #5 + an explicit Acceptance bullet: a 3-5 sentence "Grid continuation mapping" ADR paragraph mapping `BigQueryPage.pageToken` onto the read-only grid contract (`RunResult.batched` at src/adapters/types.ts:78; resultsPanel.ts `loadMore` → `runner.loadMore(index)`), verified by grep, with the read-only list untouched. Grounded before writing: both paths confirmed to exist at current HEAD.
UNCHANGED (per revision constraints): wave structure (1: 001 → 2: 002∥003 → 3: 004), §2 read-only list, §7 Global Constraints, PLANNER_MODEL footer, DEFERRED status of the four STATUS follow-ups, task count (4).

### Round 3 — 2026-09-02 · Approved
REVIEWER_MODEL: unic-smart
FINDINGS:
  - none
VERDICT: Approved
