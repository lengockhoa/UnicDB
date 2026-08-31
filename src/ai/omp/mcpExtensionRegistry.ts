// src/ai/omp/mcpExtensionRegistry.ts — TASK-AIX08-001
// Curated MCP extension registry (PURE host-side module).
//
// Validates version-1 curated extension declarations against the closed
// grammar in docs/AI_HANDOFF/PLAN_AIX08.md §3/§3a BEFORE admission, and
// turns admitted declarations into least-privilege tools whose handlers
// receive only the policy-admitted, capability-scoped read functions they
// declared. This module creates no remote transport, registers no product
// extension, and imports no `vscode`, Node fs/net/child_process, or dynamic
// loader — it is webview/test-importable like src/ai/policy.ts.
//
// Authorization model (fail closed everywhere):
//  - Registration: a declaration is admitted only when it obeys the closed
//    grammar AND every declared capability is permitted by the effective
//    policy (`db-read` needs policy.tools.database && policy.context.rows;
//    `workspace-read` needs policy.tools.workspace && policy.context.workspace).
//    Rejected declarations are never returned by `list()`.
//  - Invocation: every `db-read` call resolves ONE adapter, checks every
//    declared DBX-08 capability on that exact instance, then hands the
//    handler a `runReadOnlyQuery` bound to `createSqlTool(async () =>
//    checkedAdapter).execute({ sql })` — the original (changing) factory is
//    never re-resolved, so a later factory result cannot reach `runQuery`
//    without passing the capability gate. Denials return before the handler
//    runs; handlers never see `DbAdapter`, connection configuration,
//    credentials, filesystem handles, or remote tool authority.

import type { EffectivePolicy } from "../policy";
import type { AdapterFactory } from "../tools/types";
import type { AgentTool } from "../agent";
import { createSqlTool } from "../tools/sqlTool";
import {
  hasAdapterCapability,
  type AdapterCapability,
  type DbAdapter,
} from "../../adapters/types";

// ---------------------------------------------------------------------------
// Version-1 contract constants.
// ---------------------------------------------------------------------------

export const MCP_EXTENSION_CONTRACT_VERSION = 1;
export const MCP_EXTENSION_TIMEOUT_MIN_MS = 100;
export const MCP_EXTENSION_TIMEOUT_MAX_MS = 60_000;

// ---------------------------------------------------------------------------
// Closed version-1 declaration grammar (static types; runtime validation
// below rejects unknown keys despite these types).
// ---------------------------------------------------------------------------

export type McpExtensionScalarType = "string" | "number" | "boolean";

export interface McpExtensionPropertyDescriptor {
  type: McpExtensionScalarType;
}

export interface McpExtensionInputSchema {
  type: "object";
  properties: Record<string, McpExtensionPropertyDescriptor>;
  /** Unique declared property names; omitted or [] means all optional. */
  required?: readonly string[];
  additionalProperties: false;
}

export type McpExtensionCapability =
  | { kind: "db-read"; requiredCapabilities: readonly AdapterCapability[] }
  | { kind: "workspace-read" };

export interface McpExtensionHandlerContext {
  /** Present only for an admitted `db-read` contribution. Read-only,
   * same-adapter-guarded SQL (SELECT/SHOW/EXPLAIN/WITH…SELECT, ≤50 rows). */
  readonly runReadOnlyQuery?: (sql: string) => Promise<string>;
  /** Present only for an admitted `workspace-read` contribution. Host-
   * supplied curated read callback — never raw Node fs access. */
  readonly readWorkspaceFile?: (path: string) => Promise<string>;
}

export interface McpExtensionContribution {
  /** `/^[a-z][a-z0-9-]{0,63}$/`, unique in the registry. */
  name: string;
  /** Non-empty trimmed string. */
  description: string;
  /** Exactly `MCP_EXTENSION_CONTRACT_VERSION` (1). */
  contractVersion: 1;
  inputSchema: McpExtensionInputSchema;
  /** Non-empty, duplicate-kind capability union. */
  capabilities: readonly McpExtensionCapability[];
  /** Finite integer in [MCP_EXTENSION_TIMEOUT_MIN_MS,
   *  MCP_EXTENSION_TIMEOUT_MAX_MS]. */
  timeoutMs: number;
  handler: (
    context: McpExtensionHandlerContext,
    args: Record<string, unknown>,
  ) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Produced tool shape (TASK-AIX08-002 consumes these fields verbatim).
// ---------------------------------------------------------------------------

/** Structurally compatible with `HostMcpTool` fields
 * `{ name, description, parameters, execute }` plus the explicit failure
 * classification / timeout metadata the host needs so it never has to
 * string-prefix-guess curated outcomes. */
export interface CuratedMcpTool extends AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
  /** Validated execution budget for this tool. */
  readonly timeoutMs: number;
  /** Exact timed-out outcome text: `MCP extension tool timed out after <ms>ms`. */
  timeoutError(timeoutMs: number): string;
  /** Exact crash outcome text: `MCP extension tool failed: <message>`. */
  formatError(error: unknown): string;
  /** True only for the curated error outcomes this registry produces
   * (contract rejection, invalid arguments, capability denial, timeout,
   * handler crash) — never for ordinary handler text. */
  isErrorResult(text: string): boolean;
}

export interface CreateMcpExtensionRegistryOptions {
  /** Effective, resolved AI governance posture (src/ai/policy.ts). */
  policy: EffectivePolicy;
  /** Resolves the active adapter per call. null = no active connection. */
  adapterFactory: AdapterFactory;
  /** Curated workspace read callback for `workspace-read` contributions. */
  readWorkspaceFile?: (path: string) => Promise<string>;
}

export interface McpExtensionRegistry {
  /** Validate + admit a declaration. Never throws — returns the exact
   * `MCP extension contract rejected: ...` literal on any boundary. */
  register(
    declaration: McpExtensionContribution,
  ): { ok: true } | { ok: false; error: string };
  /** Admitted curated tools only — rejected declarations are unlisted. */
  list(): CuratedMcpTool[];
}

// ---------------------------------------------------------------------------
// Rejection literals (PLAN_AIX08 §3a — exact, quoted, deterministic).
// ---------------------------------------------------------------------------

const VERSION_LITERAL =
  "MCP extension contract rejected: contractVersion must be the integer 1";
const NAME_LITERAL =
  "MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/";
const DUPLICATE_LITERAL_PREFIX = 'MCP extension contract rejected: duplicate tool name "';
const DESCRIPTION_LITERAL =
  "MCP extension contract rejected: description must be a non-empty trimmed string";
const TIMEOUT_LITERAL =
  "MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000";
const HANDLER_LITERAL = "MCP extension contract rejected: handler must be a function";
const SCHEMA_LITERAL = "MCP extension contract rejected: inputSchema must be an object";
const CAPABILITIES_LITERAL =
  "MCP extension contract rejected: capabilities must be a non-empty array";
const DB_READ_DENIED_LITERAL =
  "MCP extension contract rejected: capability db-read is not permitted by effective policy";
const WORKSPACE_READ_DENIED_LITERAL =
  "MCP extension contract rejected: capability workspace-read is not permitted by effective policy";

const DBX08_CAPABILITIES: readonly AdapterCapability[] = [
  "catalog",
  "objectDdl",
  "tableDdl",
  "admin",
];

const SCALAR_TYPES: readonly McpExtensionScalarType[] = [
  "string",
  "number",
  "boolean",
];

const DECLARATION_KEYS: readonly string[] = [
  "name",
  "description",
  "contractVersion",
  "inputSchema",
  "capabilities",
  "timeoutMs",
  "handler",
];
const INPUT_SCHEMA_KEYS: readonly string[] = [
  "type",
  "properties",
  "required",
  "additionalProperties",
];
const WORKSPACE_READ_KEYS: readonly string[] = ["kind"];
const DB_READ_KEYS: readonly string[] = ["kind", "requiredCapabilities"];

// ---------------------------------------------------------------------------
// Argument-validation literals (PLAN_AIX08 §3.3 — exact, before handler).
// ---------------------------------------------------------------------------

function missingArgumentLiteral(name: string): string {
  return `MCP extension invalid arguments: missing required property "${name}"`;
}
function unexpectedArgumentLiteral(name: string): string {
  return `MCP extension invalid arguments: unexpected property "${name}"`;
}
function scalarMismatchLiteral(name: string, type: McpExtensionScalarType): string {
  return `MCP extension invalid arguments: property "${name}" must be ${type}`;
}

// ---------------------------------------------------------------------------
// Capability-denial literals (PLAN_AIX08 §3.2 — before handler/read).
// ---------------------------------------------------------------------------

function adapterLacksCapabilityLiteral(capability: AdapterCapability): string {
  return `MCP extension capability denied: adapter lacks ${capability}.`;
}
const NO_ADAPTER_LITERAL =
  "MCP extension capability denied: no active database adapter.";

// ---------------------------------------------------------------------------
// Curated outcome classification (explicit metadata for the host).
// ---------------------------------------------------------------------------

const CURATED_ERROR_PREFIXES: readonly string[] = [
  "MCP extension contract rejected: ",
  "MCP extension invalid arguments: ",
  "MCP extension capability denied: ",
  "MCP extension tool timed out after ",
  "MCP extension tool failed: ",
];

function isErrorResult(text: string): boolean {
  return CURATED_ERROR_PREFIXES.some((p) => text.startsWith(p));
}

// ---------------------------------------------------------------------------
// Validation helpers.
// ---------------------------------------------------------------------------

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstUnknownKey(
  record: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function validateDescriptor(
  propertyName: string,
  descriptor: unknown,
): string | null {
  if (!isPlainObject(descriptor)) {
    return `MCP extension contract rejected: property descriptor "${propertyName}" must have exactly one "type" key`;
  }
  const unknownKey = firstUnknownKey(descriptor, ["type"]);
  if (unknownKey !== null) {
    return `MCP extension contract rejected: unknown property descriptor key "${unknownKey}" for property "${propertyName}"`;
  }
  if (Object.keys(descriptor).length !== 1 || typeof descriptor["type"] !== "string") {
    return `MCP extension contract rejected: property descriptor "${propertyName}" must have exactly one "type" key`;
  }
  if (!SCALAR_TYPES.includes(descriptor["type"] as McpExtensionScalarType)) {
    return `MCP extension contract rejected: property "${propertyName}" type must be one of string, number, boolean`;
  }
  return null;
}

function validateInputSchema(schema: unknown): string | null {
  if (!isRecordLike(schema)) return SCHEMA_LITERAL;
  const unknownKey = firstUnknownKey(schema, INPUT_SCHEMA_KEYS);
  if (unknownKey !== null) {
    return `MCP extension contract rejected: unknown inputSchema key "${unknownKey}"`;
  }
  if (schema["type"] !== "object") {
    return "MCP extension contract rejected: inputSchema.type must be object";
  }
  const properties = schema["properties"];
  if (!isRecordLike(properties) || Object.keys(properties).length === 0) {
    return "MCP extension contract rejected: inputSchema.properties must be a non-empty object";
  }
  for (const [propertyName, descriptor] of Object.entries(properties)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(propertyName)) {
      return `MCP extension contract rejected: property name "${propertyName}" must match /^[a-z][a-zA-Z0-9_]{0,63}$/`;
    }
    const descriptorError = validateDescriptor(propertyName, descriptor);
    if (descriptorError !== null) return descriptorError;
  }
  if (schema["additionalProperties"] !== false) {
    return "MCP extension contract rejected: inputSchema.additionalProperties must be false";
  }
  if (schema["required"] !== undefined) {
    const required = schema["required"];
    if (!Array.isArray(required)) {
      return "MCP extension contract rejected: inputSchema.required must be an array";
    }
    const seen = new Set<string>();
    for (const member of required) {
      if (typeof member !== "string" || !(member in properties)) {
        return `MCP extension contract rejected: inputSchema.required contains unknown property "${String(member)}"`;
      }
      if (seen.has(member)) {
        return `MCP extension contract rejected: inputSchema.required contains duplicate property "${member}"`;
      }
      seen.add(member);
    }
  }
  return null;
}

function validateCapability(capability: unknown): string | null {
  if (!isRecordLike(capability) || typeof capability["kind"] !== "string") {
    return `MCP extension contract rejected: unknown capability kind "${String(
      isRecordLike(capability) ? capability["kind"] : capability,
    )}"`;
  }
  const kind = capability["kind"];
  if (kind === "workspace-read") {
    const unknownKey = firstUnknownKey(capability, WORKSPACE_READ_KEYS);
    if (unknownKey !== null) {
      return `MCP extension contract rejected: unknown capability key "${unknownKey}" for kind "workspace-read"`;
    }
    return null;
  }
  if (kind === "db-read") {
    const unknownKey = firstUnknownKey(capability, DB_READ_KEYS);
    if (unknownKey !== null) {
      return `MCP extension contract rejected: unknown capability key "${unknownKey}" for kind "db-read"`;
    }
    const required = capability["requiredCapabilities"];
    if (!Array.isArray(required) || required.length === 0) {
      return "MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array";
    }
    const seen = new Set<string>();
    for (const member of required) {
      if (
        typeof member !== "string" ||
        !DBX08_CAPABILITIES.includes(member as AdapterCapability)
      ) {
        return `MCP extension contract rejected: db-read.requiredCapabilities contains unsupported capability "${String(member)}"`;
      }
      if (seen.has(member)) {
        return `MCP extension contract rejected: db-read.requiredCapabilities contains duplicate capability "${member}"`;
      }
      seen.add(member);
    }
    return null;
  }
  return `MCP extension contract rejected: unknown capability kind "${kind}"`;
}

function validateDeclaration(
  declaration: unknown,
): { declaration: McpExtensionContribution } | { error: string } {
  if (!isRecordLike(declaration)) {
    return { error: "MCP extension contract rejected: handler must be a function" };
  }
  const unknownKey = firstUnknownKey(declaration, DECLARATION_KEYS);
  if (unknownKey !== null) {
    return {
      error: `MCP extension contract rejected: unknown declaration key "${unknownKey}"`,
    };
  }
  const version = declaration["contractVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version !== 1) {
    return { error: VERSION_LITERAL };
  }
  const name = declaration["name"];
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
    return { error: NAME_LITERAL };
  }
  const description = declaration["description"];
  if (
    typeof description !== "string" ||
    description.length === 0 ||
    description !== description.trim()
  ) {
    return { error: DESCRIPTION_LITERAL };
  }
  const timeoutMs = declaration["timeoutMs"];
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MCP_EXTENSION_TIMEOUT_MIN_MS ||
    timeoutMs > MCP_EXTENSION_TIMEOUT_MAX_MS
  ) {
    return { error: TIMEOUT_LITERAL };
  }
  if (typeof declaration["handler"] !== "function") {
    return { error: HANDLER_LITERAL };
  }
  const schemaError = validateInputSchema(declaration["inputSchema"]);
  if (schemaError !== null) return { error: schemaError };
  const capabilities = declaration["capabilities"];
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return { error: CAPABILITIES_LITERAL };
  }
  const seenKinds = new Set<string>();
  for (const capability of capabilities) {
    const capabilityError = validateCapability(capability);
    if (capabilityError !== null) return { error: capabilityError };
    const kind = (capability as { kind: string }).kind;
    if (seenKinds.has(kind)) {
      return {
        error: `MCP extension contract rejected: duplicate capability kind "${kind}"`,
      };
    }
    seenKinds.add(kind);
  }
  return { declaration: declaration as unknown as McpExtensionContribution };
}

function validateArguments(
  schema: McpExtensionInputSchema,
  args: Record<string, unknown>,
): string | null {
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) {
      return unexpectedArgumentLiteral(key);
    }
  }
  for (const required of schema.required ?? []) {
    if (!(required in args)) {
      return missingArgumentLiteral(required);
    }
  }
  for (const [propertyName, descriptor] of Object.entries(schema.properties)) {
    if (!(propertyName in args)) continue;
    const value = args[propertyName];
    const type = descriptor.type;
    if (type === "string") {
      if (typeof value !== "string") return scalarMismatchLiteral(propertyName, type);
    } else if (type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return scalarMismatchLiteral(propertyName, type);
      }
    } else if (typeof value !== "boolean") {
      return scalarMismatchLiteral(propertyName, type);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry factory.
// ---------------------------------------------------------------------------

export function createMcpExtensionRegistry(
  options: CreateMcpExtensionRegistryOptions,
): McpExtensionRegistry {
  const tools: CuratedMcpTool[] = [];
  const names = new Set<string>();
  const { policy, adapterFactory, readWorkspaceFile } = options;

  // Fail-closed policy admission (review round 1): a missing or malformed
  // EffectivePolicy must deny the relevant capability instead of throwing
  // out of register() — the registry's contract is a never-throw result.
  function dbReadAdmitted(): boolean {
    return (
      policy?.tools?.database === true &&
      policy?.context?.rows === true
    );
  }
  function workspaceReadAdmitted(): boolean {
    return (
      policy?.tools?.workspace === true &&
      policy?.context?.workspace === true
    );
  }

  return {
    register(declaration) {
      const outcome = validateDeclaration(declaration);
      if ("error" in outcome) return { ok: false, error: outcome.error };

      const candidate = outcome.declaration;
      if (names.has(candidate.name)) {
        return { ok: false, error: `${DUPLICATE_LITERAL_PREFIX}${candidate.name}"` };
      }

      for (const capability of candidate.capabilities) {
        if (capability.kind === "db-read" && !dbReadAdmitted()) {
          return { ok: false, error: DB_READ_DENIED_LITERAL };
        }
        if (capability.kind === "workspace-read" && !workspaceReadAdmitted()) {
          return { ok: false, error: WORKSPACE_READ_DENIED_LITERAL };
        }
      }

      const dbRead = candidate.capabilities.find((c) => c.kind === "db-read");
      const dbReadDeclared = dbRead !== undefined && dbRead.kind === "db-read"
        ? dbRead
        : undefined;
      const workspaceReadDeclared = candidate.capabilities.some(
        (c) => c.kind === "workspace-read",
      );

      const tool: CuratedMcpTool = {
        name: candidate.name,
        description: candidate.description,
        parameters: candidate.inputSchema as unknown as Record<string, unknown>,
        timeoutMs: candidate.timeoutMs,
        timeoutError(ms: number) {
          return `MCP extension tool timed out after ${ms}ms`;
        },
        formatError(error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return `MCP extension tool failed: ${message}`;
        },
        isErrorResult,

        async execute(args: Record<string, unknown>): Promise<string> {
          // 1. Arguments fail closed before anything privileged.
          const argumentError = validateArguments(candidate.inputSchema, args);
          if (argumentError !== null) return argumentError;

          // 2. Per-call DBX-08 capability gate on ONE resolved adapter —
          //    before the handler runs and before any database read.
          let checkedAdapter: DbAdapter | undefined;
          if (dbReadDeclared !== undefined) {
            const adapter = await adapterFactory();
            if (!adapter) return NO_ADAPTER_LITERAL;
            for (const required of dbReadDeclared.requiredCapabilities) {
              if (!hasAdapterCapability(adapter, required)) {
                return adapterLacksCapabilityLiteral(required);
              }
            }
            checkedAdapter = adapter;
          }

          // 3. Least-privilege context: only the declared+admitted read
          //    functions — never the adapter, connection, credentials, or fs.
          const context: {
            runReadOnlyQuery?: (sql: string) => Promise<string>;
            readWorkspaceFile?: (path: string) => Promise<string>;
          } = {};
          if (checkedAdapter !== undefined && dbReadDeclared !== undefined) {
            const required = dbReadDeclared.requiredCapabilities;
            const adapter = checkedAdapter;
            context.runReadOnlyQuery = async (sql: string): Promise<string> => {
              // The SAME checked instance is closed over: createSqlTool
              // re-resolves `async () => checkedAdapter`, never the original
              // factory, so a later factory result cannot bypass the gate.
              const sqlTool = createSqlTool(async () => adapter);
              void required;
              return sqlTool.execute({ sql });
            };
          }
          if (workspaceReadDeclared && readWorkspaceFile !== undefined) {
            context.readWorkspaceFile = readWorkspaceFile;
          }

          // 4. Handler invocation. Timeout/crash containment is applied by
          //    the host (TASK-AIX08-002) using the metadata above.
          return candidate.handler(context, args);
        },
      };

      tools.push(tool);
      names.add(candidate.name);
      return { ok: true };
    },

    list() {
      return [...tools];
    },
  };
}
