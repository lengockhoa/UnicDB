# PLAN_AIX08 — Extensible MCP Tool Contracts

Cycle: AIX-08 · Base: main @ 47f9940a943dbf5dd109ec6571140743d67000c7 · Release baseline: v1.29.0
Reviewer: `unic-smart` — MUST differ from executor `unic-code`

## §1 Intent

Add a host-side contract for **curated** MCP extension tools. A contribution must declare a supported contract version, a restricted valid object-input schema, bounded execution time, required least-privilege capabilities, and an async handler. The host must refuse an invalid contribution before it can be listed or invoked; refuse capability escalation before its handler runs; expose only capability-scoped read functions rather than adapters or arbitrary filesystem/database handles; and contain a timeout or handler crash as an MCP error result.

Success means a future UnicDB-owned extension can be deliberately admitted to the existing in-process host MCP surface without weakening AIX-04 consent, AIX-05 host-MCP protocol behavior, AIX-07 default-deny policy, or DBX-08 adapter-capability gates. Existing standard tool registration remains unchanged and regression-green.

## §2 Scope

### In scope

- A VS Code-free curated-extension registry at `src/ai/omp/mcpExtensionRegistry.ts` (new). It validates and transforms declarations into host-compatible tools, admits capabilities only when `EffectivePolicy` allows the corresponding context/tool class, and checks DBX-08 declared adapter capabilities before supplying a read-only database function to a handler.
- A deliberately small extension input-schema subset: object root, named scalar properties, optional `required`, and boolean `additionalProperties`. Unsupported schema forms and contract versions are refused with deterministic errors rather than partially interpreted.
- Two least-privilege capabilities: `db-read` (with declared `AdapterCapability` requirements) and `workspace-read`. Extension handlers receive only `runReadOnlyQuery(sql)` and/or `readWorkspaceFile(path)` for capabilities that were both declared and admitted; they never receive `DbAdapter`, connection configuration, credentials, Node filesystem APIs, or arbitrary remote MCP descriptors.
- Host-MCP integration in `src/ai/omp/hostMcp.ts`: accept policy-admitted curated tools alongside the existing `HostMcpTool[]`, preserve its existing error framing for standard tools, and recognize curated validation/capability errors, bounded timeout, and handler crash as `tools/call` `isError: true` outcomes.
- Focused registry and host-MCP tests for valid admission, schema/version rejection, policy/capability denial, least-privilege context, timeout, crash containment, and existing host-tool permission/list/call behavior.

### Out of scope for this cycle

- Arbitrary remote MCP servers, dynamic package/download discovery, user-supplied JavaScript, external extension loading, or any network transport other than the existing loopback host MCP transport.
- Any automatic database/file permission implied by merely declaring a tool. The existing `DbToolPermissionGate`, AIX-04 change-plan consent/fingerprint behavior, and standard `registerStandardToolset(...)` are not reworked.
- New database capabilities or adapter implementations. `db-read` uses the existing `createSqlTool(factory).execute({ sql })` read-only guard and checks DBX-08 `hasAdapterCapability`; it does not expose `DbAdapter.runQuery`, mutations, transactions, or raw adapter objects.
- New workspace-root discovery, path allowlisting, package contributions, commands, configuration, dependencies, release-version changes, or `package.json` changes.

### Same-wave file exclusion

Wave 1 contains only TASK-AIX08-001. Wave 2 contains only TASK-AIX08-002, which depends on the registry interface produced by TASK-AIX08-001. The waves have no overlapping target files; no same-wave tasks modify the same file.

## §3 Approach

1. **Validate a closed version-1 declaration grammar before registration.** Export `MCP_EXTENSION_CONTRACT_VERSION = 1`, `MCP_EXTENSION_TIMEOUT_MIN_MS = 100`, and `MCP_EXTENSION_TIMEOUT_MAX_MS = 60_000` from `src/ai/omp/mcpExtensionRegistry.ts`. A contribution has only `name`, `description`, `contractVersion`, `inputSchema`, `capabilities`, `timeoutMs`, and `handler`; unknown contribution keys are rejected, and `handler` must be a function conforming to the exported async handler signature. `name` must match `/^[a-z][a-z0-9-]{0,63}$/` and be unique in a registry; `description` must be a non-empty trimmed string; `contractVersion` must be numeric integer `1`; `timeoutMs` must be finite integer in inclusive `100..60_000`.

   `inputSchema` has only `type`, `properties`, optional `required`, and `additionalProperties`; `type` is exactly `"object"`; `properties` is a non-empty record whose keys match `/^[a-z][a-zA-Z0-9_]{0,63}$/`; and `additionalProperties` is exactly `false`, so undeclared input arguments fail closed. Every property descriptor has exactly one key, `type`, with closed literal union `"string" | "number" | "boolean"`; descriptors cannot carry `description`, `enum`, `format`, `default`, nested schema, or any other key. `required`, when supplied, is an array of unique property names all present in `properties`; omitted or `[]` means every descriptor is optional. Argument values must respectively be a string, a finite number, or a boolean; missing required keys, unexpected keys, and scalar mismatches are rejected before the handler.

   `capabilities` is a non-empty array with no duplicate capability `kind`. Its only exact union members are `{ kind: "db-read", requiredCapabilities: readonly AdapterCapability[] }` and `{ kind: "workspace-read" }`; no additional capability keys are accepted. `db-read.requiredCapabilities` is a non-empty, duplicate-free array of the closed DBX-08 literals `"catalog" | "objectDdl" | "tableDdl" | "admin"`. This is intentionally not a general JSON-Schema implementation: any unsupported form is deterministically rejected rather than partially interpreted, and no rejected contribution becomes listable.

2. **Turn declarations into least-privilege tools, with a per-call adapter identity boundary.** The registry consumes the real `EffectivePolicy`, `AdapterFactory`, optional curated workspace read callback, and `hasAdapterCapability(adapter, capability)`. `db-read` is admitted only when `policy.tools.database` and `policy.context.rows` are true. On every invocation it resolves **one** adapter, checks every declared DBX-08 capability on that exact instance, then delegates through `createSqlTool(async () => checkedAdapter).execute({ sql })`; it must not pass the original changing factory to `createSqlTool`. Thus the read-only SQL guard in `src/ai/tools/sqlTool.ts` remains authoritative and a factory changing between capability check and query cannot invoke `runQuery` on an unchecked adapter. `workspace-read` requires both `policy.tools.workspace` and `policy.context.workspace`; it receives only the supplied curated callback. Missing/denied capabilities return a deterministic `MCP extension capability denied: ...` error, call neither the handler nor an underlying read operation, and are marked as an MCP error by the host.

3. **Make argument validation and failure classification explicit.** The transformed tool validates arguments before entering the handler with these exact literals: missing required property: `MCP extension invalid arguments: missing required property "<name>"`; unexpected property: `MCP extension invalid arguments: unexpected property "<name>"`; scalar mismatch: `MCP extension invalid arguments: property "<name>" must be string`, `MCP extension invalid arguments: property "<name>" must be number`, or `MCP extension invalid arguments: property "<name>" must be boolean`. It carries explicit `timeoutMs`, `isErrorResult(text)`, and `formatError(error)` metadata to the host rather than making `hostMcp.ts` depend on string-prefix guesses. This preserves existing standard-tool behavior (`Tool failed: <message>`) while giving curated outcomes stable, testable semantics.

4. **Contain host execution without changing existing permission behavior.** Extend `HostMcpTool` with optional failure-classification/timeout hooks. For a curated tool, `tools/call` races its handler against its validated timeout, clears its timer, returns `MCP extension tool timed out after <ms>ms` with `isError: true`, and leaves a late settled handler observed rather than unhandled. A thrown handler becomes `MCP extension tool failed: <message>` with `isError: true`. The underlying handler has only read-scoped functions, so a timeout/crash cannot gain a mutation-capable adapter or implicit file/database access. Existing tools retain their current permission card, deny text, and generic crash result unchanged.

### §3a v1 declaration grammar + rejection contract

`contractVersion` is the declaration's version field; there is no separate `version` key. Every failed declaration is refused before `list()` or handler execution. The following fixture-specific strings are the complete v1 rejection contract; tests assert the literal exactly, including quotes, rather than only the prefix. `description` is required by §3 and has the explicit boundary below.

| ID | Rejected declaration boundary / fixture | Exact rejection literal |
|---|---|---|
| V1 | missing, non-integer, or any value other than `1` for `contractVersion` | `MCP extension contract rejected: contractVersion must be the integer 1` |
| N1 | missing or empty `name` | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N2 | uppercase name fixture `Catalog-probe` | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N3 | 65-character lowercase name fixture | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N4 | second admitted declaration named `catalog-probe` | `MCP extension contract rejected: duplicate tool name "catalog-probe"` |
| D1 | missing, empty, or whitespace-only `description` | `MCP extension contract rejected: description must be a non-empty trimmed string` |
| T1 | missing, non-integer, or out-of-range `timeoutMs` | `MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000` |
| H1 | missing or non-function `handler` | `MCP extension contract rejected: handler must be a function` |
| K1 | unknown top-level declaration key fixture `extra` | `MCP extension contract rejected: unknown declaration key "extra"` |
| S1 | missing, `null`, array, or primitive `inputSchema` | `MCP extension contract rejected: inputSchema must be an object` |
| K2 | unknown `inputSchema` key fixture `title` | `MCP extension contract rejected: unknown inputSchema key "title"` |
| S2 | non-`"object"` `inputSchema.type`, including fixture `"array"` | `MCP extension contract rejected: inputSchema.type must be object` |
| P1 | missing, empty, non-record, or array `inputSchema.properties` | `MCP extension contract rejected: inputSchema.properties must be a non-empty object` |
| P2 | invalid property-name fixture `Bad` | `MCP extension contract rejected: property name "Bad" must match /^[a-z][a-zA-Z0-9_]{0,63}$/` |
| PD1 | unknown property-descriptor key fixture `description` for property `schema` | `MCP extension contract rejected: unknown property descriptor key "description" for property "schema"` |
| PD2 | missing `type` or a descriptor with no sole `type` key for property `schema` | `MCP extension contract rejected: property descriptor "schema" must have exactly one "type" key` |
| PD3 | unsupported scalar type fixture `"integer"` for property `schema` | `MCP extension contract rejected: property "schema" type must be one of string, number, boolean` |
| AP1 | missing or non-`false` `additionalProperties` | `MCP extension contract rejected: inputSchema.additionalProperties must be false` |
| R1 | non-array `required` | `MCP extension contract rejected: inputSchema.required must be an array` |
| R2 | `required` member fixture `missing` absent from `properties` | `MCP extension contract rejected: inputSchema.required contains unknown property "missing"` |
| R3 | duplicate `required` fixture `["schema", "schema"]` | `MCP extension contract rejected: inputSchema.required contains duplicate property "schema"` |
| C1 | missing, empty, or non-array `capabilities` | `MCP extension contract rejected: capabilities must be a non-empty array` |
| C2 | unknown capability discriminant fixture `"network"` | `MCP extension contract rejected: unknown capability kind "network"` |
| C3 | unknown capability key fixture `extra` on `{ kind: "workspace-read", extra: true }` | `MCP extension contract rejected: unknown capability key "extra" for kind "workspace-read"` |
| C4 | duplicate capability kind fixture two `workspace-read` entries | `MCP extension contract rejected: duplicate capability kind "workspace-read"` |
| C5 | missing, empty, or non-array `db-read.requiredCapabilities` | `MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array` |
| C6 | duplicate DBX-08 member fixture `["catalog", "catalog"]` | `MCP extension contract rejected: db-read.requiredCapabilities contains duplicate capability "catalog"` |
| C7 | unsupported DBX-08 member fixture `"write"` | `MCP extension contract rejected: db-read.requiredCapabilities contains unsupported capability "write"` |

### Trade-offs and rejected alternatives

- Rejected a full JSON-Schema dependency or permissive validator: no dependency is permitted, and a small explicitly supported subset is more auditable for a host authorization boundary.
- Rejected handing a `DbAdapter`, `ConnectionConfig`, workspace root, `fs`, or `vscode` object to a handler: those surfaces permit mutation, credential exposure, or path expansion that policy cannot meaningfully constrain.
- Rejected registering denied tools and hoping handlers self-police: policy/capability checks must happen before handler invocation and denied tools must not be discoverable through `tools/list`.
- Rejected changing `registerStandardToolset(...)` or moving standard tools into the extension registry: that risks AIX-04/AIX-05/AIX-07 regressions and is not necessary to add the new curated contract.
- Rejected force-cancelling arbitrary handler promises on timeout: JavaScript promises cannot safely be preempted. Instead, the handler API is structurally read-only, the host returns promptly, clears its timer, and observes late settlement; no write authority exists to continue after timeout.

## §4 Test Plan

| Type | Test Name | Expected |
|---|---|---|
| happy | `valid db-read curated contribution receives only read-only database context` | A declaration with a grammar-valid version-1 name, non-empty description, object schema, `additionalProperties: false`, and `{ kind: "db-read", requiredCapabilities: ["catalog"] }` becomes listable; its handler receives `runReadOnlyQuery` but no adapter/workspace member, and `SELECT 1` follows `createSqlTool(async () => checkedAdapter).execute({ sql })` to a JSON result. |
| edge — declaration grammar boundaries | `closed version-1 schema, name, and capability grammar accepts only documented values` | Valid names at 1 and 64 characters, optional descriptors, required string/number/boolean descriptors, and each permitted DBX-08 capability are admitted. Every rejection fixture and its exact `MCP extension contract rejected:` result are enumerated and asserted individually in the declaration-rejection table below; each rejected declaration is unlisted and never calls its handler. |
| edge — invalid schema/version | `invalid contract is refused before tools/list or handler invocation` | A version `2` fixture returns exactly `MCP extension contract rejected: contractVersion must be the integer 1`; an `inputSchema.type: "array"` fixture returns exactly `MCP extension contract rejected: inputSchema.type must be object`; neither contribution is listable and its handler call count remains zero. |
| edge — invalid arguments | `missing, unexpected, and each scalar mismatch fail closed before handler` | With required `schema: string`, optional `limit: number`, optional `verbose: boolean`, and `additionalProperties: false`, `{}` returns exactly `MCP extension invalid arguments: missing required property "schema"`; `{ schema: "public", extra: true }` returns exactly `MCP extension invalid arguments: unexpected property "extra"`; string/number/boolean mismatches return respectively exactly `MCP extension invalid arguments: property "schema" must be string`, `MCP extension invalid arguments: property "limit" must be number`, and `MCP extension invalid arguments: property "verbose" must be boolean`; handler count remains zero, while valid arguments invoke it once. |
| edge — authorization/capability escalation | `policy denial and missing DBX-08 capability deny before handler or database read` | A database-denied effective policy excludes `db-read`; a resolved adapter lacking declared `catalog` makes an attempted call return exactly `MCP extension capability denied: adapter lacks catalog.` with zero handler and `runQuery` calls. |
| edge — adapter factory race | `capability check and read-only query bind the same adapter instance` | A two-result factory returns a capable adapter first and a non-capable adapter second; the tool checks the first and runs `SELECT 1` only through that same first adapter, so the second adapter's `runQuery` spy stays at zero. |
| edge — least privilege | `workspace-only declaration cannot access database context` | An admitted `workspace-read` handler receives only `readWorkspaceFile`, no database member, and its callback is called only for its requested path. |
| happy | `host lists and invokes an admitted curated tool with ordinary MCP envelopes` | `createHostMcp({ gatePost, tools, extensions })` returns the curated name/input schema from `tools/list`; a valid `tools/call` returns text content and `isError` is absent. |
| edge — timeout | `curated timeout returns a bounded isError response without a leaked timer` | A never-resolving curated handler with `timeoutMs: 100` returns exactly `MCP extension tool timed out after 100ms` and `isError: true`; host remains able to answer a later known-tool request and stop cleanly. |
| edge — crash | `curated handler crash is contained while standard host errors remain unchanged` | A curated throw produces exactly `MCP extension tool failed: extension boom` and `isError: true`; a non-curated throwing `HostMcpTool` still produces `Tool failed: standard boom`. |
| regression | `existing host MCP permission, loopback, list, call, and restart cases remain green` | The current `hostMcp.test.ts` suite retains existing permission-gate, loopback-only, wire, lifecycle, and `call()` assertions. |

### Declaration-rejection assertions (registry test)

The registry test executes one isolated fixture per row and asserts exact string equality, absence from `list()`, and zero handler calls. The table is deliberately duplicated from §3a as the executable boundary checklist.

| ID | Fixture | Exact expected literal |
|---|---|---|
| V1 | missing/non-integer/non-`1` `contractVersion` | `MCP extension contract rejected: contractVersion must be the integer 1` |
| N1/N2/N3 | missing/empty, uppercase `Catalog-probe`, or 65-character `name` | `MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/` |
| N4 | second `catalog-probe` registration | `MCP extension contract rejected: duplicate tool name "catalog-probe"` |
| D1 | missing/empty/whitespace `description` | `MCP extension contract rejected: description must be a non-empty trimmed string` |
| T1 | missing/non-integer/out-of-range `timeoutMs` | `MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000` |
| H1 | missing/non-function `handler` | `MCP extension contract rejected: handler must be a function` |
| K1 | top-level key `extra` | `MCP extension contract rejected: unknown declaration key "extra"` |
| S1/K2/S2 | non-object schema, key `title`, or `type: "array"` | respectively `MCP extension contract rejected: inputSchema must be an object`; `MCP extension contract rejected: unknown inputSchema key "title"`; `MCP extension contract rejected: inputSchema.type must be object` |
| P1/P2 | invalid `properties` or property name `Bad` | respectively `MCP extension contract rejected: inputSchema.properties must be a non-empty object`; `MCP extension contract rejected: property name "Bad" must match /^[a-z][a-zA-Z0-9_]{0,63}$/` |
| PD1/PD2/PD3 | descriptor `description`, `{}`, or `type: "integer"` for `schema` | respectively `MCP extension contract rejected: unknown property descriptor key "description" for property "schema"`; `MCP extension contract rejected: property descriptor "schema" must have exactly one "type" key`; `MCP extension contract rejected: property "schema" type must be one of string, number, boolean` |
| AP1/R1/R2/R3 | invalid `additionalProperties`; non-array/unknown/duplicate `required` | respectively `MCP extension contract rejected: inputSchema.additionalProperties must be false`; `MCP extension contract rejected: inputSchema.required must be an array`; `MCP extension contract rejected: inputSchema.required contains unknown property "missing"`; `MCP extension contract rejected: inputSchema.required contains duplicate property "schema"` |
| C1/C2/C3/C4 | invalid array; `network`; extra workspace key; duplicate workspace capability | respectively `MCP extension contract rejected: capabilities must be a non-empty array`; `MCP extension contract rejected: unknown capability kind "network"`; `MCP extension contract rejected: unknown capability key "extra" for kind "workspace-read"`; `MCP extension contract rejected: duplicate capability kind "workspace-read"` |
| C5/C6/C7 | invalid, duplicate, or unsupported db-read member | respectively `MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array`; `MCP extension contract rejected: db-read.requiredCapabilities contains duplicate capability "catalog"`; `MCP extension contract rejected: db-read.requiredCapabilities contains unsupported capability "write"` |

TDD rule for every task: add the focused test first, record the expected RED failure in the Executor Report, then implement the smallest behavior to make it GREEN.

## §5 Verification

No `lint` script exists in `package.json`; it must not be invented. The defined scripts are `test`, `typecheck`, and `compile`.

```bash
# TASK-AIX08-001 focused contract tests
npm test -- src/ai/omp/__tests__/mcpExtensionRegistry.test.ts
npm run typecheck
npm run compile

# TASK-AIX08-002 focused host integration and regression tests
npm test -- src/ai/omp/__tests__/hostMcp.test.ts src/ai/omp/__tests__/mcpExtensionRegistry.test.ts
npm run typecheck
npm run compile

# Mandatory cycle regression net after Wave 2 and at release review
npm test
npm run typecheck
npm run compile
```

`src/ai/omp/mcpExtensionRegistry.ts` is new, so it has no entry in `.cache/index/tests-map.json`; its adjacent test follows the verified `src/ai/omp/__tests__/*.test.ts` convention. The focused `npm test -- <test paths>` form is a real Vitest command in this npm repository; no `yarn test:release-core` command is defined here.

## §6 Acceptance

- [ ] TASK-AIX08-001: Version-1 curated declarations enforce the closed name, schema, scalar-descriptor, `required`/`additionalProperties`, and capability grammar in §3; invalid name/schema/version/duplicate/empty/unknown declarations are refused before listing or invocation with deterministic `MCP extension contract rejected:` errors.
- [ ] TASK-AIX08-001: A contribution receives only policy-admitted declared context functions. No handler receives `DbAdapter`, credentials, connection configuration, Node/VS Code filesystem access, or any implicit remote-tool authority.
- [ ] TASK-AIX08-001: `db-read` preserves the existing `createSqlTool(async () => checkedAdapter).execute({ sql })` read-only guard, checks every declared DBX-08 capability on that exact per-call adapter before handler/database read, and cannot query a later factory result that bypasses the check. `workspace-read` requires both AIX-07 workspace decisions.
- [ ] TASK-AIX08-002: The host exposes admitted curated tools in existing MCP list/call envelopes and marks the exact §3 invalid-argument literals, capability denial, timeout, and handler crash as `isError: true`.
- [ ] TASK-AIX08-002: A timeout or crash does not crash the host, leave a blocking timer, mutate the DB, or permit implicit file/database access; later calls and stop/restart remain usable.
- [ ] TASK-AIX08-002: Existing standard `HostMcpTool` permission/deny/error behavior and `registerStandardToolset(...)` behavior remain unchanged and tested.
- [ ] TASK-AIX08-001 and TASK-AIX08-002: Focused test commands plus `npm test`, `npm run typecheck`, and `npm run compile` pass under `unic-smart` review.

## §7 Global Constraints

- Preserve package version `1.29.0` and `engines.vscode: ^1.75.0`; add no dependencies.
- Do not invent a lint script; use only the verified npm scripts and focused Vitest selections in §5.
- Do not modify `docs/AI_HANDOFF/RUN.md`, `docs/STATUS.md`, `docs/WORKLOG.md`, `CHANGELOG.md`, generated `dist/`, or package contributions; `package.json` changes are out of scope.
- Do not modify `registerStandardToolset(...)`, standard tool factory semantics, AIX-04 consent/fingerprint behavior, AIX-05 loopback transport, or AIX-07 default-deny policy semantics except to consume its existing `EffectivePolicy` decision.
- Curated means compile-time host-supplied declarations only: no remote endpoint, dynamic loader, user-provided handler, shell execution, raw filesystem handle, raw `DbAdapter`, connection string, credential, or implicit database/file access.
- All capability checks fail closed: missing/malformed policy, missing handler context, missing adapter, missing DBX-08 declaration, invalid input, expired timeout, or a handler throw must not invoke a privileged operation.
- Retain concise English MCP error wording exactly where pinned by §4; do not expose secrets in tool descriptors, errors, traces, logs, or test fixtures.
- Do not run git add, commit, tag, package, or push.

## Planner Report
PLANNER_MODEL: unic-smart

## Planner Self-Audit
Checklist: 12/12 pass
Fixed during audit: separated the pure declaration/context boundary from host transport integration; pinned the closed version-1 declaration grammar and exact invalid-argument literals; bound each DBX-08 capability check and read-only SQL execution to the same per-call adapter instance; retained standard-tool error behavior as an explicit regression.
Known gaps: no product-owned curated extension is registered in this cycle because the roadmap forbids arbitrary/dynamic tools and no existing UnicDB feature requires a new extension contribution. The exported host contract is the safe enablement seam for a later curated feature.


## Plan Review Log

### Round 1 — Issues Found
REVIEWER_MODEL: unic-smart

FINDINGS:
- docs/AI_HANDOFF/PLAN_AIX08.md:16,34 and docs/AI_HANDOFF/tasks/TASK-AIX08-001.md:46,60 — The public declaration contract is not defined: “scalar” has no allowed `type` literals, property descriptors have no allowed/forbidden fields, capability discriminants/required-capability field shapes are unspecified, and name validation has no grammar. Since the listed exported types are new, executors can admit incompatible schemas and capability declarations while satisfying every stated test.
- docs/AI_HANDOFF/PLAN_AIX08.md:38 and docs/AI_HANDOFF/tasks/TASK-AIX08-001.md:24 — Invalid-argument errors are only `MCP extension invalid arguments: <reason>` “as defined by the new exported validator”; the validator does not exist yet and the missing-required, unexpected-property, and wrong-scalar reasons are not pinned. The host test pins only one missing-property literal, so incompatible error contracts can pass.
- docs/AI_HANDOFF/PLAN_AIX08.md:36 and docs/AI_HANDOFF/tasks/TASK-AIX08-001.md:47 — The plan says capability admission checks the adapter then delegates `runReadOnlyQuery` through `createSqlTool(adapterFactory)`, but `createSqlTool` resolves the factory again. A changing factory can return a capability-approved adapter for the check and an adapter lacking the declared capability for the query, permitting `runQuery` after the required DBX-08 capability check should have failed.

REQUIRED CHANGES:
- Specify the complete version-1 TypeScript/declarative grammar: permitted scalar type literals and descriptor keys, `required`/`additionalProperties` rules, capability union fields and duplicate/empty rules, and an exact name grammar; add a test for each accepted/rejected boundary.
- Pin exact invalid-argument literals for missing required properties, unexpected properties, and each unsupported scalar/value mismatch in both task test plans and §4.
- Require `runReadOnlyQuery` to execute against the same adapter instance whose capabilities were checked (or recheck inside the factory used by `createSqlTool` before every query), and add a two-result factory test proving a capability change cannot reach `runQuery`.

### Round 1 — revision applied (planner)

- Specified the closed version-1 declaration grammar: exact tool-name regex and uniqueness, contribution/schema/property keys, `"string" | "number" | "boolean"` scalar descriptors, fail-closed `additionalProperties: false`, `required` validity, exact `db-read`/`workspace-read` capability union, and duplicate/empty constraints; added accepted and rejected boundary tests.
- Pinned missing-required, unexpected-property, and string/number/boolean scalar-mismatch `MCP extension invalid arguments:` literals in §3/§4 and TASK-AIX08-001, with exact assertions before handler invocation.
- Required each `db-read` call to capability-check one resolved adapter then pass `async () => checkedAdapter` to `createSqlTool`; added the two-result-factory test proving the later non-capable adapter cannot reach `runQuery`.


### Round 2 — Issues Found
REVIEWER_MODEL: unic-smart

FINDINGS:
- docs/AI_HANDOFF/PLAN_AIX08.md:36,38,59 and docs/AI_HANDOFF/tasks/TASK-AIX08-001.md:22 — The revision closes the declaration grammar but does not define exact `MCP extension contract rejected: ...` literals for its declared boundaries (for example uppercase/overlength/duplicate names, unknown schema/property/capability keys, and duplicate/empty arrays). The plan and task instead require each case to return “exactly its documented” literal while documenting only the version/type examples, so implementations can produce incompatible error contracts while passing the specified tests. Enumerate the exact rejection text for every rejection rule and assert each boundary against it.

NOTES: Round-1 invalid-argument literals and the same-adapter factory race are now concretely specified and tested; the revision log accurately describes those changes.

### Round 2 — findings applied without re-review
REVIEWER_MODEL: unic-smart (loop cap reached: round 1 revision + round 2 finding)
- Round-2 finding applied directly: added the complete fixture-specific v1 declaration-rejection literal contract to §3a and §4, mirrored every exact assertion in TASK-AIX08-001, and explicitly defined the required description boundary.
