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
