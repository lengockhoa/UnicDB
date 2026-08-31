# TASK-AIX08-001 — Curated MCP extension registry and least-privilege contract

- Status: `ready`
- Owner: `-`
- Reviewer: `unic-smart`
- Executor model: `unic-code`
- Parent plan: `docs/AI_HANDOFF/PLAN_AIX08.md` §3

## Goal

Create the pure host-side registry that validates curated MCP extension declarations before admission and gives an admitted handler only the policy-allowed, capability-scoped read functions it declared. This task creates no remote transport and registers no product extension.

## Target Files

- `src/ai/omp/mcpExtensionRegistry.ts` (new) — define the versioned declaration/schema/capability contract, validation results, policy/DBX-08 admission, argument validation, bounded handler metadata, and least-privilege handler context.
- `src/ai/omp/__tests__/mcpExtensionRegistry.test.ts` (new) — TDD coverage for registry validation, policy/capability admission, argument validation, and handler-context boundaries.

## Test Cases (REQUIRED — TDD)

| # | Type | Test name | Expected | Pre-state / Fixture |
|---|------|-----------|----------|---------------------|
| 1 | happy | `valid closed-grammar db-read contribution becomes a listable tool with only runReadOnlyQuery` | Registering `catalog-probe` with `contractVersion: 1`, a valid 64-or-fewer-character name, non-empty description, object schema, required `schema: string`, optional `limit: number`/`verbose: boolean`, `additionalProperties: false`, and `{ kind: "db-read", requiredCapabilities: ["catalog"] }` returns `{ ok: true }`; `list()` contains its name/input schema; its handler has callable `runReadOnlyQuery` but no `adapter`, `readWorkspaceFile`, credential, or connection member; `SELECT 1` returns the JSON result through `createSqlTool(async () => checkedAdapter).execute({ sql })`. | Fully allowed `EffectivePolicy` and adapter declaring `catalog: true`. |
| 2 | edge — declaration grammar boundaries | `closed version-1 name, schema, descriptor, required, and capability grammar rejects every unsupported boundary` | Valid 1- and 64-character names, each scalar descriptor type, omitted/empty `required`, and each allowed `AdapterCapability` are admitted. Every rejected fixture individually asserts the exact literal in the declaration-rejection table below; every rejected declaration remains unlisted and its handler is uncalled. | Independent declarations with handler spies; valid schema uses only the closed grammar. |
| 3 | edge — invalid contract | `invalid version and non-object schema are rejected before listing or invocation` | Version `2` returns exactly `MCP extension contract rejected: contractVersion must be the integer 1`; `inputSchema.type: "array"` returns exactly `MCP extension contract rejected: inputSchema.type must be object`; neither name appears in `list()` and neither handler is called. | Two distinct declarations with spies for handlers. |
| 4 | edge — input boundaries | `missing, unexpected, and each scalar mismatch use exact literals before handler` | `{}` returns exactly `MCP extension invalid arguments: missing required property "schema"`; `{ schema: "public", extra: true }` returns exactly `MCP extension invalid arguments: unexpected property "extra"`; `{ schema: 1 }`, `{ schema: "public", limit: "1" }`, and `{ schema: "public", verbose: "true" }` return respectively exactly `MCP extension invalid arguments: property "schema" must be string`, `MCP extension invalid arguments: property "limit" must be number`, and `MCP extension invalid arguments: property "verbose" must be boolean`; handler count remains zero, while `{ schema: "public", limit: 1, verbose: true }` invokes it once. | Required `schema: string`, optional `limit: number`/`verbose: boolean`, and `additionalProperties: false`. |
| 5 | edge — authorization/capability escalation | `denied policy and missing declared adapter capability block before handler or database read` | Database/rows policy denial returns exactly `MCP extension contract rejected: capability db-read is not permitted by effective policy` and creates no listable tool. With policy allowed but an adapter lacking `catalog`, calling the registered tool returns exactly `MCP extension capability denied: adapter lacks catalog.`; handler and `runQuery` spies remain uncalled. | First a policy with database/rows false; second a legacy adapter with no `capabilities`. |
| 6 | edge — adapter factory race | `capability check and read-only query use the same adapter instance` | A two-result factory returns a `catalog: true` adapter first and a `catalog: false` adapter second. A `SELECT 1` call succeeds through the checked first adapter; the second adapter's `runQuery` spy remains exactly zero, proving `createSqlTool` received `async () => checkedAdapter` rather than the changing factory. | Fully allowed policy, declared `db-read` catalog requirement, two adapter `runQuery` spies. |
| 7 | edge — least privilege | `workspace-only contribution receives only readWorkspaceFile` | The handler context has callable `readWorkspaceFile`, lacks `runReadOnlyQuery` and host/adapter fields, and returns the curated callback result for `README.md`. | Fully allowed workspace policy and injected `readWorkspaceFile(path): Promise<string>` spy. |

### Declaration-rejection assertions (part of Test Case #2)

Each row is an individual `expect(result).toEqual(...)` boundary assertion using the named fixture; all also assert absent `list()` entry and zero handler calls. `contractVersion` is the version field; no separate `version` key exists.

| ID | Rejected fixture | Exact expected literal |
|---|---|---|
| V1 | missing/non-integer/non-`1` `contractVersion` | `MCP extension contract rejected: contractVersion must be the integer 1` |
| N1 | missing/empty `name` | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N2 | uppercase `Catalog-probe` | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N3 | 65-character lowercase name | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N4 | second `catalog-probe` registration | `MCP extension contract rejected: duplicate tool name "catalog-probe"` |
| D1 | missing/empty/whitespace `description` | `MCP extension contract rejected: description must be a non-empty trimmed string` |
| T1 | missing/non-integer/out-of-range `timeoutMs` | `MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000` |
| H1 | missing/non-function `handler` | `MCP extension contract rejected: handler must be a function` |
| K1 | unknown top-level key `extra` | `MCP extension contract rejected: unknown declaration key "extra"` |
| S1 | non-object `inputSchema` | `MCP extension contract rejected: inputSchema must be an object` |
| K2 | unknown schema key `title` | `MCP extension contract rejected: unknown inputSchema key "title"` |
| S2 | `inputSchema.type: "array"` | `MCP extension contract rejected: inputSchema.type must be object` |
| P1 | missing/empty/non-record `properties` | `MCP extension contract rejected: inputSchema.properties must be a non-empty object` |
| P2 | invalid property name `Bad` | `MCP extension contract rejected: property name "Bad" must match /^[a-z][a-zA-Z0-9_]{0,63}$/` |
| PD1 | descriptor `schema: { type: "string", description: "x" }` | `MCP extension contract rejected: unknown property descriptor key "description" for property "schema"` |
| PD2 | descriptor `schema: {}` | `MCP extension contract rejected: property descriptor "schema" must have exactly one "type" key` |
| PD3 | descriptor `schema: { type: "integer" }` | `MCP extension contract rejected: property "schema" type must be one of string, number, boolean` |
| AP1 | missing/non-`false` `additionalProperties` | `MCP extension contract rejected: inputSchema.additionalProperties must be false` |
| R1 | non-array `required` | `MCP extension contract rejected: inputSchema.required must be an array` |
| R2 | `required: ["missing"]` | `MCP extension contract rejected: inputSchema.required contains unknown property "missing"` |
| R3 | `required: ["schema", "schema"]` | `MCP extension contract rejected: inputSchema.required contains duplicate property "schema"` |
| C1 | missing/empty/non-array `capabilities` | `MCP extension contract rejected: capabilities must be a non-empty array` |
| C2 | capability `kind: "network"` | `MCP extension contract rejected: unknown capability kind "network"` |
| C3 | workspace capability key `extra` | `MCP extension contract rejected: unknown capability key "extra" for kind "workspace-read"` |
| C4 | two `workspace-read` capabilities | `MCP extension contract rejected: duplicate capability kind "workspace-read"` |
| C5 | missing/empty/non-array `db-read.requiredCapabilities` | `MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array` |
| C6 | `requiredCapabilities: ["catalog", "catalog"]` | `MCP extension contract rejected: db-read.requiredCapabilities contains duplicate capability "catalog"` |
| C7 | `requiredCapabilities: ["write"]` | `MCP extension contract rejected: db-read.requiredCapabilities contains unsupported capability "write"` |

Write the tests first and record the actual failing RED command output in the Executor Report before implementation; then make the same tests GREEN.

## Test Files

- `src/ai/omp/__tests__/mcpExtensionRegistry.test.ts` (new) — contains every registry contract test above, following the verified adjacent MCP test layout.

## Verification Commands

```bash
npm test -- src/ai/omp/__tests__/mcpExtensionRegistry.test.ts
npm run typecheck
npm run compile
```

No `lint` script exists in `package.json`.

## Acceptance Criteria

- [ ] `src/ai/omp/mcpExtensionRegistry.ts` has no `vscode`, Node filesystem/network/child-process, remote-MCP, or dynamic-loader dependency.
- [ ] A declaration is admitted only when it obeys the closed version-1 grammar in `## Interfaces`: exact name/description/version/timeout, exact object-schema keys and scalar descriptors, fail-closed `additionalProperties: false`, valid optional `required`, and a non-empty duplicate-free capability union; rejected declarations are not returned by `list()`.
- [ ] `db-read` is admitted only when `EffectivePolicy.tools.database` and `EffectivePolicy.context.rows` are true; on every invocation it resolves one adapter, checks every declared DBX-08 capability on that instance, then calls the existing read-only `createSqlTool(async () => checkedAdapter).execute({ sql })` seam. A later adapter factory result never reaches `runQuery`.
- [ ] `workspace-read` is admitted only when both existing workspace policy decisions are true and exposes only the injected curated read callback.
- [ ] Invalid input and denied/missing capability execute neither handler nor privileged read; handlers cannot receive adapter, connection, credential, filesystem, shell, or remote-tool authority.
- [ ] Focused tests, `npm run typecheck`, and `npm run compile` pass.
- [ ] Executor report declares `EXECUTOR_MODEL: unic-code`; reviewer is `unic-smart`.

## Dependencies

- none

## Interfaces

- Consumes: `EffectivePolicy { provider: AiEngine | null; context: PolicyContextDecision; tools: PolicyToolDecision; auditExportAllowed: boolean; notice: string }` from `src/ai/policy.ts`; `AdapterFactory = () => Promise<DbAdapter | null>` from `src/ai/tools/types.ts`; `createSqlTool(factory: AdapterFactory): AgentTool` and `AgentTool.execute(args: Record<string, unknown>): Promise<string>` from `src/ai/tools/sqlTool.ts` / `src/ai/agent.ts`; `hasAdapterCapability(adapter: Pick<DbAdapter, "capabilities"> | null | undefined, capability: AdapterCapability): boolean` from `src/adapters/types.ts`.
- Produces: `MCP_EXTENSION_CONTRACT_VERSION = 1`; `McpExtensionScalarType = "string" | "number" | "boolean"`; `McpExtensionPropertyDescriptor = { type: McpExtensionScalarType }`; `McpExtensionInputSchema = { type: "object"; properties: Record<string, McpExtensionPropertyDescriptor>; required?: readonly string[]; additionalProperties: false }`; `McpExtensionCapability = { kind: "db-read"; requiredCapabilities: readonly AdapterCapability[] } | { kind: "workspace-read" }`; `McpExtensionContribution = { name: string; description: string; contractVersion: 1; inputSchema: McpExtensionInputSchema; capabilities: readonly McpExtensionCapability[]; timeoutMs: number; handler: (context: McpExtensionHandlerContext, args: Record<string, unknown>) => Promise<string> }`; `McpExtensionHandlerContext`; `CuratedMcpTool`; and `createMcpExtensionRegistry(options)`. Runtime validation rejects unknown keys despite these static types: names match `/^[a-z][a-z0-9-]{0,63}$/` and are registry-unique; schemas/properties/capability arrays obey the closed grammar in PLAN §3; `required` names are unique declared properties; and capability kinds plus DBX-08 literals are duplicate-free/non-empty where §3 requires. `CuratedMcpTool` is structurally compatible with current host tool fields `{ name: string; description: string; parameters: Record<string, unknown>; execute(args: Record<string, unknown>): Promise<string> }` and additionally supplies validated `timeoutMs: number`, `timeoutError(timeoutMs: number): string`, `formatError(error: unknown): string`, and `isErrorResult(text: string): boolean` for TASK-AIX08-002. Its `db-read` context resolves and checks one adapter per invocation, then calls `createSqlTool(async () => checkedAdapter).execute({ sql })` so the query and DBX-08 check share identity.

### Rejection-literal interface

The validator returns the following exact strings for the Test Case #2 fixtures (the Test Cases matrix supplies each concrete fixture and asserts each literal individually).

| Rules | Exact literal(s) |
|---|---|
| V1 | `MCP extension contract rejected: contractVersion must be the integer 1` |
| N1–N3 | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N4 | `MCP extension contract rejected: duplicate tool name "catalog-probe"` |
| D1 | `MCP extension contract rejected: description must be a non-empty trimmed string` |
| T1 / H1 | `MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000`; `MCP extension contract rejected: handler must be a function` |
| K1 / S1 / K2 / S2 | `MCP extension contract rejected: unknown declaration key "extra"`; `MCP extension contract rejected: inputSchema must be an object`; `MCP extension contract rejected: unknown inputSchema key "title"`; `MCP extension contract rejected: inputSchema.type must be object` |
| P1 / P2 | `MCP extension contract rejected: inputSchema.properties must be a non-empty object`; `MCP extension contract rejected: property name "Bad" must match /^[a-z][a-zA-Z0-9_]{0,63}$/` |
| PD1–PD3 | `MCP extension contract rejected: unknown property descriptor key "description" for property "schema"`; `MCP extension contract rejected: property descriptor "schema" must have exactly one "type" key`; `MCP extension contract rejected: property "schema" type must be one of string, number, boolean` |
| AP1 / R1–R3 | `MCP extension contract rejected: inputSchema.additionalProperties must be false`; `MCP extension contract rejected: inputSchema.required must be an array`; `MCP extension contract rejected: inputSchema.required contains unknown property "missing"`; `MCP extension contract rejected: inputSchema.required contains duplicate property "schema"` |
| C1–C4 | `MCP extension contract rejected: capabilities must be a non-empty array`; `MCP extension contract rejected: unknown capability kind "network"`; `MCP extension contract rejected: unknown capability key "extra" for kind "workspace-read"`; `MCP extension contract rejected: duplicate capability kind "workspace-read"` |
| C5–C7 | `MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array`; `MCP extension contract rejected: db-read.requiredCapabilities contains duplicate capability "catalog"`; `MCP extension contract rejected: db-read.requiredCapabilities contains unsupported capability "write"` |

---

## Discussion

### 2026-09-01 · planner · unic-smart

The new contract deliberately supports only a small object-schema subset. Do not accept arbitrary JSON Schema, remote descriptors, or a `DbAdapter` in handler context. A policy-denied declared capability is rejected at registration and therefore unlisted; an absent DBX-08 declaration is checked at invocation because the active adapter may change after registry construction.

---

## Executor Report

(not started)
