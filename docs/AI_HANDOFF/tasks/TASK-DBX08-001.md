# TASK-DBX08-001 — Declare and prove adapter capability matrix

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN_DBX08.md` §1–§3

## Goal

Add the fail-closed, explicit adapter capability declaration that distinguishes PostgreSQL’s proven advanced APIs from MySQL/MSSQL’s baseline-only support. Prove against actual adapter instances that no production adapter advertises a capability its implementation does not expose.

## Target Files

- `src/adapters/types.ts` — add `AdapterCapability`, `AdapterCapabilities`, optional `DbAdapter.capabilities`, and the pure capability predicate.
- `src/adapters/postgres.ts` — declare the immutable all-supported matrix that corresponds to its existing `readonly catalog: CatalogApi` and `readonly admin: AdminApi` members.
- `src/adapters/mysql.ts` — declare the immutable all-unsupported advanced matrix; do not add catalog/admin/DDL methods.
- `src/adapters/mssql.ts` — declare the immutable all-unsupported advanced matrix; do not add catalog/admin/DDL methods.
- `src/adapters/__tests__/capabilities.test.ts` (new) — instantiate the three real adapter classes without connecting and assert the contract matrix/API agreement.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|----------|----------|---------------------|
| 1 | happy | `production adapters declare the DBX-08 advanced capability matrix` | `PostgresAdapter` returns true for `catalog`, `objectDdl`, `tableDdl`, and `admin`; `MySqlAdapter` and `MsSqlAdapter` return false for each. PostgreSQL exposes its existing `catalog` and `admin` objects; the other two expose neither. | New unconnected instances using a valid minimal `ConnectionConfig`. |
| 2 | edge — absent/partial declaration | `hasAdapterCapability fails closed for legacy and partial adapters` | A `DbAdapter`-shaped fixture with no `capabilities`, an omitted capability key, or a false key returns false; the helper never grants a capability by checking `catalog`/`admin` structural presence. | Narrow fixtures cast only for the pure helper. |
| 3 | edge — mutation | `production declarations cannot be mutated into advertised support` | Attempting to overwrite a declared entry cannot turn a false MySQL/MSSQL capability into true (or mutation is rejected); a subsequent helper result remains false. | Real MySQL/MSSQL adapter instance and an attempted write through a test-only cast. |
| 4 | regression | `existing PostgreSQL catalog SQL contract remains green` | Existing `postgresCatalog.test.ts` assertions for parameterized catalog behavior and DDL mapping still pass. | Current PostgreSQL catalog test fixture. |

## Test Files

- `src/adapters/__tests__/capabilities.test.ts` (new) — matrix, fail-closed, and immutability tests above.
- `src/adapters/__tests__/postgresCatalog.test.ts` — PostgreSQL catalog regression coverage; no production behavior change expected.
- `src/adapters/__tests__/mysql.integration.test.ts` — existing MySQL adapter regression selection from the test map.
- `src/adapters/__tests__/mssql.parameterized.test.ts` — existing MSSQL adapter regression selection from the test map.

## Verification Commands

```bash
npm test -- src/adapters/__tests__/capabilities.test.ts src/adapters/__tests__/postgresCatalog.test.ts src/adapters/__tests__/mysql.integration.test.ts src/adapters/__tests__/mssql.parameterized.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] `DbAdapter.capabilities` is optional for fixture/backward compatibility and no missing/false/partial entry is treated as supported.
- [ ] `hasAdapterCapability(adapter, capability)` has a concrete boolean result and is independent of `driver`, `catalog`, and `admin` structural presence.
- [ ] PostgreSQL explicitly declares all four supported capabilities and still has its existing `CatalogApi`/`AdminApi`; MySQL/MSSQL explicitly declare all four false and still lack those APIs.
- [ ] The test cases and verification commands pass.
- [ ] Reviewer verdict is APPROVED or APPROVED-WITH-MINOR.

## Dependencies

- none

## Interfaces

- Consumes: existing `DbAdapter.catalog?: CatalogApi`, `DbAdapter.admin?: AdminApi`, `CatalogApi.objectDdl(kind: "view" | "routine" | "trigger", name: string, schema?: string): Promise<string>`, and `AdminApi` from `src/adapters/types.ts`; existing `PostgresAdapter.readonly catalog: CatalogApi` and `PostgresAdapter.readonly admin: AdminApi` from `src/adapters/postgres.ts`.
- Produces: `AdapterCapability`, `AdapterCapabilities`, `DbAdapter.capabilities?: AdapterCapabilities`, and `hasAdapterCapability(adapter: Pick<DbAdapter, "capabilities"> | null | undefined, capability: AdapterCapability): boolean`. TASK-DBX08-002 consumes `catalog`/`objectDdl`; TASK-DBX08-003 consumes `tableDdl`/`admin`.

---

## Discussion

### 2026-09-01 · planner · unic-smart
The contract must be declarative and fail closed. Do not infer truth from `adapter.catalog` or `adapter.admin`: consumer tasks use the helper as their admission source, while the actual optional APIs remain the execution seam. MySQL/MSSQL declarations are product truth for the checked-in implementations, not a request to add backend methods.

---
