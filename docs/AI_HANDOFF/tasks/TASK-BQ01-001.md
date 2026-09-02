# TASK-BQ01-001 — Safe BigQuery connection config (pure)

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Config model)

## Goal

Extend `ConnectionConfig` with a BigQuery-safe shape and a pure validator so a
`driver:"bigquery"` connection carries ONLY safe metadata (billing project, optional
location / cost controls) and provably no credential-ish field survives serialization.

## Target Files

- `src/config/types.ts` — add `"bigquery"` to `DriverType`; add optional
  `bigquery` sub-object to `ConnectionConfig`; add pure
  `validateBigQueryConnection(cfg)` (+ exported `BigQueryConnectionFields` type if
  needed). No other change.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | valid bigquery config with billingProject + location validates | returns `{ok:true}` | `{id,name,driver:"bigquery",host:"",port:0,user:"",database:"",bigquery:{billingProject:"proj-billing",location:"EU"}}` |
| 2 | edge-empty | empty / whitespace billingProject rejected | `{ok:false}`, reason mentions billing project; `""` and `"   "` both rejected | bigquery fixture with `billingProject:"  "` |
| 3 | edge-type | maxBytesBilled wrong-type / negative / zero rejected | `"abc"`, `"-5"`, `"0"` each `{ok:false}` with distinct-ish reasons; `"1000000"` passes | cost fixtures |
| 4 | edge-security | serialization redaction | `JSON.stringify(validBqConfig)` contains none of `credentials`, `keyFilename`, `token`, `password` (case-insensitive scan) | valid fixture from #1 |
| 5 | edge-compat | legacy 3-driver configs untouched | existing pg fixture `{driver:"postgres",host,port,user,database}` has `validateBigQueryConnection` `{ok:true}` and typechecks unchanged | pg fixture (mirror `factory.test.ts` `cfg()`) |
| 6 | edge-rule | bigquery with non-empty host or non-zero port rejected | `{ok:false}` reason mentions host/port | fixture with `host:"bigquery.googleapis.com",port:443` |

## Test Files

- `src/adapters/__tests__/bigqueryConfig.test.ts` (new) — contains tests #1-#6. Pure
  unit file; no vscode import, no network.

## Verification Commands

```bash
# 1. Focused proof
npx vitest run src/adapters/__tests__/bigqueryConfig.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED output pasted in Executor Report first).
- [ ] `DriverType` includes `"bigquery"`; `host/port/user/database` remain required
      fields (no signature ripple in postgres/mysql/mssql).
- [ ] Validator is pure (no vscode / no `@google-cloud/bigquery` import).
- [ ] `bigqueryTypes.test.ts` + `bigqueryAdc.test.ts` remain green (untouched).
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- (none)

## Interfaces

- Consumes: existing `ConnectionConfig` / `DriverType` (this file).
- Produces (consumed by TASK-BQ01-002/003/004):

```ts
export type DriverType = "postgres" | "mysql" | "mssql" | "bigquery";
export interface BigQueryConnectionFields {
  billingProject: string;
  location?: string;
  maxBytesBilled?: string; // canonical digit-string, > 0
  datasetProject?: string; // when it differs from billingProject
}
// inside ConnectionConfig:
bigquery?: BigQueryConnectionFields;
export type BigQueryValidation = { ok: true } | { ok: false; reason: string };
export function validateBigQueryConnection(cfg: ConnectionConfig): BigQueryValidation;
```

---

## Discussion

### 2026-09-02 · planner · unic-smart
`host/port/user/database` stay required at the type level so the 3 existing adapters and
their tests are untouched; BigQuery emptiness of those fields is enforced by the
validator instead (test #6 pins it). `maxBytesBilled` is a string on purpose: byte
counts can exceed `Number.MAX_SAFE_INTEGER` and this matches BQ-00's string-bytes
discipline (`totalBytesBilled: string` in `bigqueryTypes.ts`).

(no comments yet)

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->

## Executor Report

**STATUS: DONE**
**EXECUTOR_TOOL:** claude-code
**EXECUTOR_MODEL:** claude-sonnet-4-5
**EXECUTOR_SUBAGENT:** Claude:feature-implementer
**SUMMARY:** Extended `src/config/types.ts` with `"bigquery"` member on `DriverType`, optional `bigquery` sub-object on `ConnectionConfig`, exported `BigQueryConnectionFields` + `BigQueryValidation` types, and pure `validateBigQueryConnection(cfg)` enforcing R1-R4. Added new `src/adapters/__tests__/bigqueryConfig.test.ts` covering all 6 test cases (13 sub-tests total). Validator is pure (no vscode / @google-cloud/bigquery import).
**TEST_PLAN_FOLLOWED:** task §Test Cases (inlined as the 6 numbered cases; happy / edge-empty / edge-type / edge-security / edge-compat / edge-rule)
**FILES_CHANGED:**
  - src/config/types.ts: added 'bigquery' to DriverType; added optional bigquery?:BigQueryConnectionFields to ConnectionConfig; added BigQueryConnectionFields + BigQueryValidation types; added validateBigQueryConnection() enforcing R1 (sub-object present), R2 (billingProject non-empty/non-whitespace), R3 (maxBytesBilled is canonical digit-string > 0), R4 (host/port/user/database empty for BQ), C0 (non-BQ drivers pass through {ok:true}).
  - src/adapters/__tests__/bigqueryConfig.test.ts: NEW — 13 unit tests covering all 6 task §Test Cases. Fixture `bqCfg()` mirrors factory.test.ts pattern with minimum required fields.
  - src/adapters/factory.ts: added `case "bigquery": throw new NotImplementedError("bigquery")` to keep the `never` exhaustiveness arm valid (BQ01-003 will replace with real adapter case).
  - src/ui/browseCommands.ts: added `case "bigquery": throw new Error(...)` to `quoteForDriver()` switch — same exhaustiveness reason.
  - src/extension.ts: added private `toSqlDialect()` helper (DriverType | undefined → SqlDialect | undefined; returns undefined for bigquery) and wrapped 5 call sites (VsdbCodeLensProvider, sqlToRun x2, confirmDangerousStatements, invalidateAfterSchemaDdl). SqlDialect type stays narrow.
  - src/ui/resultsPanel.ts: added private `toDialect()` helper (DriverType | null → Dialect | null; returns null for bigquery) and wrapped 4 call sites (decorateStateMessage, distinct values, requery parsing, requery compose). Dialect type stays narrow.

**TESTS_ADDED:**
  - src/adapters/__tests__/bigqueryConfig.test.ts:
    - validateBigQueryConnection — happy path > valid bigquery config with billingProject + location validates (#1)
    - validateBigQueryConnection — empty/whitespace billingProject > rejects empty billingProject (#2a)
    - validateBigQueryConnection — empty/whitespace billingProject > rejects whitespace-only billingProject (#2b)
    - validateBigQueryConnection — maxBytesBilled shape > rejects non-digit maxBytesBilled 'abc' (#3a)
    - validateBigQueryConnection — maxBytesBilled shape > rejects negative maxBytesBilled '-5' (#3b)
    - validateBigQueryConnection — maxBytesBilled shape > rejects zero maxBytesBilled '0' (#3c)
    - validateBigQueryConnection — maxBytesBilled shape > accepts canonical positive maxBytesBilled '1000000' (#3d)
    - validateBigQueryConnection — serialization redaction > JSON.stringify output never contains credentials-shaped fields (#4a)
    - validateBigQueryConnection — serialization redaction > BigQueryConnectionFields type does not admit credential-shaped keys (#4b)
    - validateBigQueryConnection — legacy 3-driver configs untouched > postgres config passes validateBigQueryConnection (#5a)
    - validateBigQueryConnection — legacy 3-driver configs untouched > postgres config typechecks unchanged (#5b)
    - validateBigQueryConnection — empty host/port/user/database for bigquery > rejects non-empty host (#6a)
    - validateBigQueryConnection — empty host/port/user/database for bigquery > rejects non-zero port (#6b)

**VERIFICATION:**
  command: npx vitest run src/adapters/__tests__/bigqueryConfig.test.ts
  result: 13 pass / 0 fail / exit 0
  output_excerpt: |
    ✓ src/adapters/__tests__/bigqueryConfig.test.ts  (13 tests) 2ms
    Test Files  1 passed (1)
         Tests  13 passed (13)
  command: npm run typecheck
  result: clean / exit 0 (no errors)
  output_excerpt: |
    > vsdb@1.46.0 typecheck
    > tsc --noEmit
  command: npx vitest run src/adapters/__tests__/bigqueryConfig.test.ts src/adapters/__tests__/bigqueryTypes.test.ts src/adapters/__tests__/bigqueryAdc.test.ts src/adapters/__tests__/factory.test.ts
  result: 30 pass / 0 fail / exit 0 (BQ-00 surfaces + factory stay green)
  output_excerpt: |
    ✓ src/adapters/__tests__/bigqueryTypes.test.ts  (7 tests) 2ms
    ✓ src/adapters/__tests__/bigqueryConfig.test.ts  (13 tests) 2ms
    ✓ src/adapters/__tests__/bigqueryAdc.test.ts  (6 tests) 7ms
    ✓ src/adapters/__tests__/factory.test.ts  (4 tests) 2ms
    Test Files  4 passed (4)
         Tests  30 passed (30)

**RED output (pre-GREEN, captured before types.ts was extended):**
  command: npx vitest run src/adapters/__tests__/bigqueryConfig.test.ts
  result: 11 failed | 2 passed (13) — TypeError: validateBigQueryConnection is not a function
  output_excerpt: |
    ✗ validateBigQueryConnection — happy path > valid bigquery config with billingProject + location validates
      → validateBigQueryConnection is not a function
    ✗ validateBigQueryConnection — empty/whitespace billingProject > rejects empty billingProject
      → validateBigQueryConnection is not a function
    ✗ validateBigQueryConnection — maxBytesBilled shape > rejects non-digit maxBytesBilled ('abc')
      → validateBigQueryConnection is not a function
    ... [11 total failures, all TypeError: validateBigQueryConnection is not a function]
    Test Files  1 failed (1)
         Tests  11 failed | 2 passed (13)

**Note on the 2 tests that passed during RED:** `JSON.stringify output never contains credentials-shaped fields` (#4a) and `BigQueryConnectionFields type does not admit credential-shaped keys` (#4b) are pure shape/serialization invariants — they do not depend on the validator. They passed because they exercise a literal `{ billingProject, location, maxBytesBilled, datasetProject }` object whose JSON serialization contains none of the banned substrings. This is the correct test behavior: the invariant is structural (the type admits no credential-shaped keys), not behavioral (a function under test). These will continue to pass after GREEN and pin the redaction contract independently of the validator's runtime behavior. Not flagged as 'wrong tests' — they are intentional type-level redaction proofs.

**ISSUES:**
1. **Scope ripple beyond src/config/types.ts.** Adding `"bigquery"` to `DriverType` broke typecheck in 4 consumer files (factory.ts exhaustive `never`, browseCommands.ts exhaustive `never`, extension.ts 5 call sites passing DriverType where SqlDialect expected, resultsPanel.ts 4 call sites passing DriverType where Dialect expected). The task Target Files section says "No other change" but lists `npm run typecheck` as the static gate. I resolved this in the executor's favor (added the minimum-touch updates) for the following principled reasons:
   - factory.ts exhaustive case is allocated to BQ01-003 in PLAN.md §2 (will be replaced with the real adapter). Adding the case now as a throw keeps the `never` arm valid without stealing BQ01-003's work.
   - browseCommands.ts / extension.ts / resultsPanel.ts call-site ripples were NOT allocated to any BQ01 task in PLAN.md. They represent a planner oversight (no future wave was assigned). Narrowing at the call site via private `toSqlDialect` / `toDialect` helpers keeps the existing `SqlDialect` and `Dialect` types narrow (so statementParser / saveStatements don't gain unknown branches) and degrades gracefully (BQ connections without an adapter yet get `undefined` / `null` and fall through to the existing no-dialect rendering branch).
   - postgres.ts / mysql.ts / mssql.ts + their tests are NOT touched — the acceptance-criterion signature guarantee is preserved.
2. **Bundle test failures pre-existing.** `src/ui/__tests__/consolePanelBundle.test.ts` (18 failures) and `src/ui/__tests__/agGridSmoke.test.ts` (1) and `src/extension.test.ts` (1) fail with "dist/... missing — run npm run compile first". Confirmed pre-existing on clean main via `git stash` + re-run. Not caused by this task. Not in Verification Commands.
3. **validator.reason for empty billingProject was tightened** during GREEN iteration: original draft said `BigQuery `billingProject` is required and must be non-empty.` (failing the case-insensitive `billing project` substring check). Changed to `BigQuery billing project is required and must be non-empty.` to satisfy test #2.

**HANDOFF_TO_REVIEWER:** yes — task implementation complete; all 6 test cases pass; typecheck clean; BQ-00 surfaces + factory unchanged.

**NEXT:** Ready for review. BQ01-003 (factory + connectionManager) will replace factory.ts `case "bigquery"` with the real adapter case, and may want to revisit extension.ts / resultsPanel.ts narrowing helpers if BQ connections are expected to be active before BQ01-002 lands.
