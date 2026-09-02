# TASK-BQ01-003 — Factory + ConnectionManager admission for bigquery

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3 (Admission)

## Goal

Admit `driver:"bigquery"` through `createAdapter` (exhaustive switch, no password path)
and through `ConnectionManager` without ever round-tripping SecretStorage for a BigQuery
fake password, with dispose blocking later adapter use.

## Target Files

- `src/adapters/factory.ts` — add `case "bigquery"` returning `new BigQueryAdapter(cfg)`
  (password argument ignored for this driver); keep the `never` exhaustiveness arm.
- `src/core/connectionManager.ts` — bigquery guard: skip `vsdb.pass.<id>`
  store/get/delete on add/edit/connect paths; dispose sets a closed flag so post-dispose
  adapter construction fails fast (explicit error, no client built); double-dispose no-op.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | unit | factory returns BigQueryAdapter for bigquery cfg | `createAdapter(bqCfg, "")` instanceof `BigQueryAdapter`; duck-type has `connect/close/runQuery/testConnection/listSchemas` | bqCfg per TASK-BQ01-001 fixture |
| 2 | edge-exhaustive | switch stays exhaustive | typecheck passes with `_exhaustive: never` arm intact (negative: removing a case must fail compile — verified by reviewer reading the file, not by a test) | source inspection + typecheck |
| 3 | edge-admission | manager addConnection(bigqueryCfg) never touches SecretStorage | with spied fake SecretStorage: `get`/`store` never called with key `vsdb.pass.<id>`; metadata persisted; probe via injected factory fake resolves | `connectionManager.test.ts` fake vscode harness + injected factory |
| 4 | edge-concurrent | dispose-during / after dispose | `dispose(); dispose()` idempotent; after dispose, adapter request for the bigquery connection rejects with explicit closed-error and the client factory was NOT invoked again | manager with injected factory spy |
| 5 | edge-state | edit + connect paths skip password demand | `editConnection(bigqueryId, cfg)` (no password arg) does not throw "password not found"; `getAdapter()` for active bigquery connection does not call `ctx.secrets.get` | fake harness, spy on secrets |
| 6 | regression | existing pg flow unchanged | pre-existing `connectionManager.test.ts` + `factory.test.ts` suites pass unmodified (SecretStorage flow for postgres identical) | current suites |

## Test Files

- `src/adapters/__tests__/factory.test.ts` (modify — add bigquery case group; existing
  tests untouched)
- `src/core/__tests__/connectionManager.test.ts` (modify — add bigquery admission group;
  existing tests untouched)
- Reuses TASK-BQ01-002's `src/adapters/__tests__/bigquery.test.ts` fakes by importing
  the adapter through the factory (no new adapter file).

## Verification Commands

```bash
# 1. Focused proof
npx vitest run src/adapters/__tests__/factory.test.ts src/core/__tests__/connectionManager.test.ts

# 2. Static gate (no lint script exists)
npm run typecheck
```

## Acceptance Criteria

- [ ] Every test in §Test Cases passes (RED output pasted in Executor Report first).
- [ ] `createAdapter` switch: `case "bigquery"` present; `never` arm intact; no
      host/port/password usage on the bigquery path.
- [ ] Zero SecretStorage calls for bigquery connections (spy-proven at add, edit,
      active-connect).
- [ ] `dispose()` idempotent; post-dispose bigquery adapter use fails fast with explicit
      error (not a client construction).
- [ ] Existing postgres/mysql/mssql rows of both suites untouched and green.
- [ ] Reviewer verdict APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- TASK-BQ01-001 (config shape), TASK-BQ01-002 (`BigQueryAdapter` symbol).

## Interfaces

- Consumes:

```ts
import { BigQueryAdapter } from "../adapters/bigquery";        // TASK-BQ01-002
import { validateBigQueryConnection } from "../config/types";  // TASK-BQ01-001 (manager guard)
export type AdapterFactory = (cfg: ConnectionConfig, password: string) => DbAdapter; // unchanged signature
```

- Produces: `createAdapter` now returns `DbAdapter` for all four `DriverType` members;
  `ConnectionManager` treats bigquery as password-less (callers can pass `""`).

---

## Discussion

### 2026-09-02 · planner · unic-smart
This task deliberately owns BOTH `factory.ts` and `connectionManager.ts` in one task —
they are one admission surface and splitting them would serialize two waves for one
behavior. Roadmap lists them as one wave-2 row for the same reason.

### 2026-09-02 · planner · unic-smart
`AdapterFactory`'s signature `(cfg, password)` is NOT changed — the manager and form keep
passing `""` for bigquery. Changing the public signature would ripple into
`connectionForm.ts` (owned by TASK-BQ01-004 in the same wave) for no behavioral gain.

### 2026-09-02 · planner · unic-smart
Roadmap BQ-01 edge "user changes active connection during test": recorded assumption —
existing lifecycle-generation guards in `connectionManager.ts` already cover this (test
runs against the adapter captured at connect-time; switching active connection creates a
new generation). Round 2 does not add a pinning test; if the executor finds the guard
absent while implementing test #4/#5, escalate in the Executor Report rather than
silently widening scope.

---

<!-- Phase 3 executor appends `## Executor Report` BELOW this separator. -->
<!-- Phase 4 reviewer appends `## Reviewer Verdict` BELOW the Executor Report. -->
