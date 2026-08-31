// src/ai/omp/__tests__/mcpExtensionRegistry.test.ts — TASK-AIX08-001 (TDD)
// Curated MCP extension registry contract:
//  - closed version-1 declaration grammar with exact `MCP extension contract
//    rejected: ...` literals for every boundary (PLAN_AIX08 §3a);
//  - exact `MCP extension invalid arguments: ...` literals for missing /
//    unexpected / scalar-mismatch arguments before any handler runs;
//  - policy + DBX-08 capability admission, least-privilege handler context,
//    and the same-adapter guarantee between capability check and the
//    read-only query (createSqlTool(async () => checkedAdapter)).
//
// Pure host-side module: no vscode import here, so no vscode mock is needed
// (the registry must not import hostMcp.ts, which pulls aiChatPanel/vscode).

import { describe, expect, it, vi } from "vitest";

import {
  createMcpExtensionRegistry,
  type CuratedMcpTool,
  type McpExtensionContribution,
  type McpExtensionHandlerContext,
} from "../mcpExtensionRegistry";
import type { EffectivePolicy } from "../../policy";
import type { AdapterFactory } from "../../tools/types";
import type { AdapterCapability, DbAdapter } from "../../../adapters/types";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function allowedPolicy(): EffectivePolicy {
  return {
    provider: "omp",
    context: { schema: true, workspace: true, rows: true },
    tools: { database: true, workspace: true },
    auditExportAllowed: true,
    notice: "",
  };
}

function dbDeniedPolicy(): EffectivePolicy {
  return {
    ...allowedPolicy(),
    context: { schema: true, workspace: true, rows: false },
    tools: { database: false, workspace: true },
  };
}

/** Fake adapter with a runQuery spy and an optional DBX-08 capabilities
 * declaration. Omitting `capabilities` models a legacy adapter. */
function fakeAdapter(opts: {
  capabilities?: Partial<Record<AdapterCapability, boolean>>;
} = {}): { adapter: DbAdapter; runQueryCalls: string[] } {
  const runQueryCalls: string[] = [];
  const capabilities = opts.capabilities
    ? {
        catalog: false,
        objectDdl: false,
        tableDdl: false,
        admin: false,
        ...opts.capabilities,
      }
    : undefined;
  const adapter = {
    ...(capabilities ? { capabilities } : {}),
    runQuery: async (sql: string) => {
      runQueryCalls.push(sql);
      return {
        results: [
          { columns: ["?column?"], rows: [[1]], rowCount: 1, durationMs: 1 },
        ],
      };
    },
  } as unknown as DbAdapter;
  return { adapter, runQueryCalls };
}

function handlerSpy() {
  const calls: Array<{
    ctx: McpExtensionHandlerContext;
    args: Record<string, unknown>;
  }> = [];
  const handler = async (
    ctx: McpExtensionHandlerContext,
    args: Record<string, unknown>,
  ): Promise<string> => {
    calls.push({ ctx, args });
    return "handler-ok";
  };
  return { handler, calls };
}

function baseDeclaration(
  handler: McpExtensionContribution["handler"],
): McpExtensionContribution {
  return {
    name: "catalog-probe",
    description: "Curated catalog probe",
    contractVersion: 1,
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string" },
        limit: { type: "number" },
        verbose: { type: "boolean" },
      },
      required: ["schema"],
      additionalProperties: false,
    },
    capabilities: [{ kind: "db-read", requiredCapabilities: ["catalog"] }],
    timeoutMs: 1000,
    handler,
  };
}

interface RegistryOverrides {
  policy?: EffectivePolicy;
  adapter?: DbAdapter;
  adapterFactory?: AdapterFactory;
  readWorkspaceFile?: (path: string) => Promise<string>;
}

function makeRegistry(overrides: RegistryOverrides = {}) {
  const adapter =
    overrides.adapter ?? fakeAdapter({ capabilities: { catalog: true } }).adapter;
  return createMcpExtensionRegistry({
    policy: overrides.policy ?? allowedPolicy(),
    adapterFactory:
      overrides.adapterFactory ?? (async () => adapter),
    ...(overrides.readWorkspaceFile
      ? { readWorkspaceFile: overrides.readWorkspaceFile }
      : {}),
  });
}

/** Cast helper for deliberately malformed fixtures. */
function malformed(value: unknown): McpExtensionContribution {
  return value as McpExtensionContribution;
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("TASK-AIX08-001 — curated MCP extension registry", () => {
  it("valid closed-grammar db-read contribution becomes a listable tool with only runReadOnlyQuery", async () => {
    const { handler, calls } = handlerSpy();
    const declaration = baseDeclaration(handler);
    const registry = makeRegistry();

    const result = registry.register(declaration);
    expect(result).toEqual({ ok: true });

    const listed = registry.list();
    expect(listed).toHaveLength(1);
    const tool: CuratedMcpTool = listed[0]!;
    expect(tool.name).toBe("catalog-probe");
    expect(tool.description).toBe("Curated catalog probe");
    expect(tool.parameters).toEqual(declaration.inputSchema);
    expect(tool.timeoutMs).toBe(1000);
    expect(typeof tool.timeoutError).toBe("function");
    expect(typeof tool.formatError).toBe("function");
    expect(typeof tool.isErrorResult).toBe("function");

    const out = await tool.execute({ schema: "public" });
    expect(out).toBe("handler-ok");
    expect(calls).toHaveLength(1);

    const ctx = calls[0]!.ctx;
    expect(typeof ctx.runReadOnlyQuery).toBe("function");
    expect(ctx.readWorkspaceFile).toBeUndefined();
    expect("adapter" in ctx).toBe(false);
    expect("credential" in ctx).toBe(false);
    expect("connection" in ctx).toBe(false);

    const json = await ctx.runReadOnlyQuery!("SELECT 1");
    expect(JSON.parse(json)).toEqual({
      columns: ["?column?"],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
    });
  });

  it("closed version-1 name, schema, descriptor, required, and capability grammar rejects every unsupported boundary", async () => {
    const { handler, calls } = handlerSpy();

    // --- accepted boundaries ---
    const accepted: Array<{ label: string; declaration: McpExtensionContribution }> = [
      {
        label: "1-character name",
        declaration: {
          ...baseDeclaration(handler),
          name: "a",
          inputSchema: {
            type: "object",
            properties: { p: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      {
        label: "64-character name",
        declaration: {
          ...baseDeclaration(handler),
          name: "a".repeat(64),
          inputSchema: {
            type: "object",
            properties: { p: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      {
        label: "string descriptor",
        declaration: {
          ...baseDeclaration(handler),
          name: "decl-string",
          inputSchema: {
            type: "object",
            properties: { p: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      {
        label: "number descriptor",
        declaration: {
          ...baseDeclaration(handler),
          name: "decl-number",
          inputSchema: {
            type: "object",
            properties: { p: { type: "number" } },
            additionalProperties: false,
          },
        },
      },
      {
        label: "boolean descriptor",
        declaration: {
          ...baseDeclaration(handler),
          name: "decl-boolean",
          inputSchema: {
            type: "object",
            properties: { p: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
      {
        label: "omitted required",
        declaration: {
          ...baseDeclaration(handler),
          name: "decl-omitted-required",
          inputSchema: {
            type: "object",
            properties: { p: { type: "string" } },
            additionalProperties: false,
          },
        },
      },
      {
        label: "empty required",
        declaration: {
          ...baseDeclaration(handler),
          name: "decl-empty-required",
          inputSchema: {
            type: "object",
            properties: { p: { type: "string" } },
            required: [],
            additionalProperties: false,
          },
        },
      },
      ...(["catalog", "objectDdl", "tableDdl", "admin"] as const).map(
        (capability) => ({
          label: `capability ${capability}`,
          declaration: {
            ...baseDeclaration(handler),
            // Name grammar is all-lowercase: transliterate the capability.
            name: `decl-${capability.toLowerCase()}`,
            capabilities: [
              { kind: "db-read" as const, requiredCapabilities: [capability] },
            ],
          },
        }),
      ),
    ];
    for (const { label, declaration } of accepted) {
      const registry = makeRegistry();
      expect(registry.register(declaration), label).toEqual({ ok: true });
      expect(
        registry.list().some((t) => t.name === declaration.name),
        label,
      ).toBe(true);
    }

    // --- rejected boundaries: one isolated fixture per row ---
    const base = baseDeclaration(handler);
    const NAME_LITERAL =
      'MCP extension contract rejected: name must match /^[a-z][a-z0-9-]{0,63}$/';

    function omit<K extends keyof McpExtensionContribution>(
      key: K,
    ): Omit<McpExtensionContribution, K> {
      const clone = { ...base };
      delete clone[key];
      return clone;
    }

    const rejections: Array<{
      id: string;
      declaration: unknown;
      literal: string;
    }> = [
      {
        id: "V1-missing",
        declaration: omit("contractVersion"),
        literal:
          "MCP extension contract rejected: contractVersion must be the integer 1",
      },
      {
        id: "V1-non-integer",
        declaration: malformed({ ...base, contractVersion: 1.5 }),
        literal:
          "MCP extension contract rejected: contractVersion must be the integer 1",
      },
      {
        id: "V1-not-1",
        declaration: malformed({ ...base, contractVersion: 2 }),
        literal:
          "MCP extension contract rejected: contractVersion must be the integer 1",
      },
      {
        id: "N1-missing",
        declaration: omit("name"),
        literal: NAME_LITERAL,
      },
      {
        id: "N1-empty",
        declaration: { ...base, name: "" },
        literal: NAME_LITERAL,
      },
      {
        id: "N2-uppercase",
        declaration: { ...base, name: "Catalog-probe" },
        literal: NAME_LITERAL,
      },
      {
        id: "N3-65-chars",
        declaration: { ...base, name: "a".repeat(65) },
        literal: NAME_LITERAL,
      },
      {
        id: "N4-duplicate",
        declaration: base,
        literal: 'MCP extension contract rejected: duplicate tool name "catalog-probe"',
      },
      {
        id: "D1-missing",
        declaration: omit("description"),
        literal:
          "MCP extension contract rejected: description must be a non-empty trimmed string",
      },
      {
        id: "D1-empty",
        declaration: { ...base, description: "" },
        literal:
          "MCP extension contract rejected: description must be a non-empty trimmed string",
      },
      {
        id: "D1-whitespace",
        declaration: { ...base, description: "   " },
        literal:
          "MCP extension contract rejected: description must be a non-empty trimmed string",
      },
      {
        id: "D1-padded",
        declaration: { ...base, description: " catalog probe " },
        literal:
          "MCP extension contract rejected: description must be a non-empty trimmed string",
      },
      {
        id: "T1-missing",
        declaration: omit("timeoutMs"),
        literal:
          "MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000",
      },
      {
        id: "T1-non-integer",
        declaration: { ...base, timeoutMs: 1500.5 },
        literal:
          "MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000",
      },
      {
        id: "T1-below",
        declaration: { ...base, timeoutMs: 99 },
        literal:
          "MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000",
      },
      {
        id: "T1-above",
        declaration: { ...base, timeoutMs: 60001 },
        literal:
          "MCP extension contract rejected: timeoutMs must be an integer from 100 to 60000",
      },
      {
        id: "H1-missing",
        declaration: omit("handler"),
        literal: "MCP extension contract rejected: handler must be a function",
      },
      {
        id: "H1-non-function",
        declaration: malformed({ ...base, handler: "nope" }),
        literal: "MCP extension contract rejected: handler must be a function",
      },
      {
        id: "K1-unknown-key",
        declaration: malformed({ ...base, extra: true }),
        literal: 'MCP extension contract rejected: unknown declaration key "extra"',
      },
      {
        id: "S1-missing",
        declaration: omit("inputSchema"),
        literal: "MCP extension contract rejected: inputSchema must be an object",
      },
      {
        id: "S1-null",
        declaration: malformed({ ...base, inputSchema: null }),
        literal: "MCP extension contract rejected: inputSchema must be an object",
      },
      {
        id: "S1-array",
        declaration: malformed({ ...base, inputSchema: [] }),
        literal: "MCP extension contract rejected: inputSchema must be an object",
      },
      {
        id: "S1-string",
        declaration: malformed({ ...base, inputSchema: "object" }),
        literal: "MCP extension contract rejected: inputSchema must be an object",
      },
      {
        id: "K2-unknown-schema-key",
        declaration: malformed({
          ...base,
          inputSchema: { ...base.inputSchema, title: "x" },
        }),
        literal: 'MCP extension contract rejected: unknown inputSchema key "title"',
      },
      {
        id: "S2-array-type",
        declaration: malformed({
          ...base,
          inputSchema: { ...base.inputSchema, type: "array" },
        }),
        literal: "MCP extension contract rejected: inputSchema.type must be object",
      },
      {
        id: "P1-missing",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            additionalProperties: false,
          },
        }),
        literal:
          "MCP extension contract rejected: inputSchema.properties must be a non-empty object",
      },
      {
        id: "P1-empty",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        }),
        literal:
          "MCP extension contract rejected: inputSchema.properties must be a non-empty object",
      },
      {
        id: "P1-array",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: [],
            additionalProperties: false,
          },
        }),
        literal:
          "MCP extension contract rejected: inputSchema.properties must be a non-empty object",
      },
      {
        id: "P2-bad-property-name",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: { Bad: { type: "string" } },
            additionalProperties: false,
          },
        }),
        literal:
          'MCP extension contract rejected: property name "Bad" must match /^[a-z][a-zA-Z0-9_]{0,63}$/',
      },
      {
        id: "PD1-unknown-descriptor-key",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: {
              schema: { type: "string", description: "x" },
            },
            additionalProperties: false,
          },
        }),
        literal:
          'MCP extension contract rejected: unknown property descriptor key "description" for property "schema"',
      },
      {
        id: "PD2-empty-descriptor",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: { schema: {} },
            additionalProperties: false,
          },
        }),
        literal:
          'MCP extension contract rejected: property descriptor "schema" must have exactly one "type" key',
      },
      {
        id: "PD3-unsupported-scalar",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: { schema: { type: "integer" } },
            additionalProperties: false,
          },
        }),
        literal:
          'MCP extension contract rejected: property "schema" type must be one of string, number, boolean',
      },
      {
        id: "AP1-missing",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: { schema: { type: "string" } },
          },
        }),
        literal:
          "MCP extension contract rejected: inputSchema.additionalProperties must be false",
      },
      {
        id: "AP1-true",
        declaration: malformed({
          ...base,
          inputSchema: {
            type: "object",
            properties: { schema: { type: "string" } },
            additionalProperties: true,
          },
        }),
        literal:
          "MCP extension contract rejected: inputSchema.additionalProperties must be false",
      },
      {
        id: "R1-non-array",
        declaration: malformed({
          ...base,
          inputSchema: {
            ...base.inputSchema,
            required: "schema",
          },
        }),
        literal: "MCP extension contract rejected: inputSchema.required must be an array",
      },
      {
        id: "R2-unknown-required",
        declaration: malformed({
          ...base,
          inputSchema: { ...base.inputSchema, required: ["missing"] },
        }),
        literal:
          'MCP extension contract rejected: inputSchema.required contains unknown property "missing"',
      },
      {
        id: "R3-duplicate-required",
        declaration: malformed({
          ...base,
          inputSchema: { ...base.inputSchema, required: ["schema", "schema"] },
        }),
        literal:
          'MCP extension contract rejected: inputSchema.required contains duplicate property "schema"',
      },
      {
        id: "C1-missing",
        declaration: omit("capabilities"),
        literal: "MCP extension contract rejected: capabilities must be a non-empty array",
      },
      {
        id: "C1-empty",
        declaration: { ...base, capabilities: [] },
        literal: "MCP extension contract rejected: capabilities must be a non-empty array",
      },
      {
        id: "C1-non-array",
        declaration: malformed({ ...base, capabilities: "db-read" }),
        literal: "MCP extension contract rejected: capabilities must be a non-empty array",
      },
      {
        id: "C2-unknown-kind",
        declaration: malformed({ ...base, capabilities: [{ kind: "network" }] }),
        literal: 'MCP extension contract rejected: unknown capability kind "network"',
      },
      {
        id: "C3-unknown-workspace-key",
        declaration: malformed({
          ...base,
          capabilities: [{ kind: "workspace-read", extra: true }],
        }),
        literal:
          'MCP extension contract rejected: unknown capability key "extra" for kind "workspace-read"',
      },
      {
        id: "C4-duplicate-kind",
        declaration: {
          ...base,
          capabilities: [{ kind: "workspace-read" }, { kind: "workspace-read" }],
        },
        literal:
          'MCP extension contract rejected: duplicate capability kind "workspace-read"',
      },
      {
        id: "C5-missing-requiredCapabilities",
        declaration: malformed({ ...base, capabilities: [{ kind: "db-read" }] }),
        literal:
          "MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array",
      },
      {
        id: "C5-empty-requiredCapabilities",
        declaration: {
          ...base,
          capabilities: [{ kind: "db-read", requiredCapabilities: [] }],
        },
        literal:
          "MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array",
      },
      {
        id: "C5-non-array-requiredCapabilities",
        declaration: malformed({
          ...base,
          capabilities: [{ kind: "db-read", requiredCapabilities: "catalog" }],
        }),
        literal:
          "MCP extension contract rejected: db-read.requiredCapabilities must be a non-empty array",
      },
      {
        id: "C6-duplicate-capability",
        declaration: {
          ...base,
          capabilities: [
            { kind: "db-read", requiredCapabilities: ["catalog", "catalog"] },
          ],
        },
        literal:
          'MCP extension contract rejected: db-read.requiredCapabilities contains duplicate capability "catalog"',
      },
      {
        id: "C7-unsupported-capability",
        declaration: {
          ...base,
          capabilities: [{ kind: "db-read", requiredCapabilities: ["write"] }],
        },
        literal:
          'MCP extension contract rejected: db-read.requiredCapabilities contains unsupported capability "write"',
      },
    ];

    for (const { id, declaration, literal } of rejections) {
      const registry = makeRegistry();
      if (id === "N4-duplicate") {
        // First registration admits the name; the second must be rejected.
        expect(registry.register(baseDeclaration(handler))).toEqual({ ok: true });
      }
      const result = registry.register(malformed(declaration));
      expect(result, id).toEqual({ ok: false, error: literal });
      if (id === "N4-duplicate") {
        // The first admitted registration stays listed exactly once; the
        // duplicate was refused, so no second entry exists.
        expect(
          registry.list().filter((t) => t.name === "catalog-probe"),
          id,
        ).toHaveLength(1);
      } else {
        expect(
          registry.list().some((t) => t.name === "catalog-probe"),
          id,
        ).toBe(false);
      }
    }
    expect(calls).toHaveLength(0);
  });

  it("invalid version and non-object schema are rejected before listing or invocation", async () => {
    const v2 = handlerSpy();
    const v2Registry = makeRegistry();
    const v2Result = v2Registry.register(
      malformed({ ...baseDeclaration(v2.handler), contractVersion: 2 }),
    );
    expect(v2Result).toEqual({
      ok: false,
      error: "MCP extension contract rejected: contractVersion must be the integer 1",
    });
    expect(v2Registry.list()).toHaveLength(0);
    expect(v2.calls).toHaveLength(0);

    const arraySchema = handlerSpy();
    const arrayRegistry = makeRegistry();
    const arrayResult = arrayRegistry.register(
      malformed({
        ...baseDeclaration(arraySchema.handler),
        inputSchema: { ...baseDeclaration(arraySchema.handler).inputSchema, type: "array" },
      }),
    );
    expect(arrayResult).toEqual({
      ok: false,
      error: "MCP extension contract rejected: inputSchema.type must be object",
    });
    expect(arrayRegistry.list()).toHaveLength(0);
    expect(arraySchema.calls).toHaveLength(0);
  });

  it("missing, unexpected, and each scalar mismatch use exact literals before handler", async () => {
    const { handler, calls } = handlerSpy();
    const registry = makeRegistry();
    expect(registry.register(baseDeclaration(handler))).toEqual({ ok: true });
    const tool = registry.list()[0]!;

    expect(await tool.execute({})).toBe(
      'MCP extension invalid arguments: missing required property "schema"',
    );
    expect(await tool.execute({ schema: "public", extra: true })).toBe(
      'MCP extension invalid arguments: unexpected property "extra"',
    );
    expect(await tool.execute({ schema: 1 })).toBe(
      'MCP extension invalid arguments: property "schema" must be string',
    );
    expect(await tool.execute({ schema: "public", limit: "1" })).toBe(
      'MCP extension invalid arguments: property "limit" must be number',
    );
    expect(await tool.execute({ schema: "public", verbose: "true" })).toBe(
      'MCP extension invalid arguments: property "verbose" must be boolean',
    );
    expect(calls).toHaveLength(0);

    expect(await tool.execute({ schema: "public", limit: 1, verbose: true })).toBe(
      "handler-ok",
    );
    expect(calls).toHaveLength(1);
  });

  it("denied policy and missing declared adapter capability block before handler or database read", async () => {
    const denied = handlerSpy();
    const deniedRegistry = makeRegistry({ policy: dbDeniedPolicy() });
    const deniedResult = deniedRegistry.register(baseDeclaration(denied.handler));
    expect(deniedResult).toEqual({
      ok: false,
      error:
        "MCP extension contract rejected: capability db-read is not permitted by effective policy",
    });
    expect(deniedRegistry.list()).toHaveLength(0);
    expect(denied.calls).toHaveLength(0);

    const legacy = fakeAdapter(); // legacy adapter: no `capabilities` at all
    const legacyCalls = handlerSpy();
    const legacyRegistry = makeRegistry({ adapter: legacy.adapter });
    expect(legacyRegistry.register(baseDeclaration(legacyCalls.handler))).toEqual({
      ok: true,
    });
    const tool = legacyRegistry.list()[0]!;
    const out = await tool.execute({ schema: "public" });
    expect(out).toBe("MCP extension capability denied: adapter lacks catalog.");
    expect(legacyCalls.calls).toHaveLength(0);
    expect(legacy.runQueryCalls).toHaveLength(0);
  });

  it("malformed or absent policy decisions default-deny without throwing (review round 1)", async () => {
    const calls = handlerSpy();
    const malformedPolicies: unknown[] = [
      undefined,
      null,
      {},
      { tools: null, context: null, provider: null, auditExportAllowed: false, notice: "" },
      { tools: { database: "yes", workspace: true }, context: { rows: 1, workspace: true } },
    ];
    const adapter = fakeAdapter({ capabilities: { catalog: true } }).adapter;
    for (const policy of malformedPolicies) {
      // Direct construction — makeRegistry's `??` would silently substitute
      // a valid policy for undefined/null fixtures.
      const registry = createMcpExtensionRegistry({
        policy: policy as EffectivePolicy,
        adapterFactory: async () => adapter,
      });
      const result = registry.register(baseDeclaration(calls.handler));
      expect(result).toEqual({
        ok: false,
        error:
          "MCP extension contract rejected: capability db-read is not permitted by effective policy",
      });
      expect(registry.list()).toHaveLength(0);
    }
    expect(calls.calls).toHaveLength(0);
  });

  it("capability check and read-only query use the same adapter instance", async () => {
    const good = fakeAdapter({ capabilities: { catalog: true } });
    const bad = fakeAdapter(); // no capabilities → not capable
    let factoryCalls = 0;
    const twoResultFactory: AdapterFactory = async () => {
      factoryCalls += 1;
      return factoryCalls === 1 ? good.adapter : bad.adapter;
    };

    const sqlOutputs: string[] = [];
    const calls: number[] = [];
    const queryingHandler = async (
      ctx: McpExtensionHandlerContext,
      args: Record<string, unknown>,
    ): Promise<string> => {
      calls.push(1);
      const out = await ctx.runReadOnlyQuery!("SELECT 1");
      sqlOutputs.push(out);
      void args;
      return "handler-ok";
    };

    const registry = makeRegistry({ adapterFactory: twoResultFactory });
    expect(
      registry.register(baseDeclaration(queryingHandler)),
    ).toEqual({ ok: true });
    const tool = registry.list()[0]!;

    const out = await tool.execute({ schema: "public" });
    expect(out).toBe("handler-ok");
    expect(sqlOutputs).toHaveLength(1);
    expect(JSON.parse(sqlOutputs[0]!)).toEqual({
      columns: ["?column?"],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
    });
    expect(good.runQueryCalls).toEqual(["SELECT 1"]);
    expect(bad.runQueryCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("workspace-only contribution receives only readWorkspaceFile", async () => {
    const readCalls: string[] = [];
    const readWorkspaceFile = vi.fn(async (path: string) => {
      readCalls.push(path);
      return `contents-of-${path}`;
    });

    const calls: Array<{
      ctx: McpExtensionHandlerContext;
      args: Record<string, unknown>;
    }> = [];
    const readingHandler = async (
      ctx: McpExtensionHandlerContext,
      args: Record<string, unknown>,
    ): Promise<string> => {
      calls.push({ ctx, args });
      return ctx.readWorkspaceFile!(String(args["path"]));
    };

    const registry = makeRegistry({ readWorkspaceFile });
    expect(
      registry.register({
        name: "read-notes",
        description: "Curated workspace notes reader",
        contractVersion: 1,
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        capabilities: [{ kind: "workspace-read" }],
        timeoutMs: 1000,
        handler: readingHandler,
      }),
    ).toEqual({ ok: true });

    const tool = registry.list()[0]!;
    const out = await tool.execute({ path: "README.md" });
    expect(out).toBe("contents-of-README.md");
    expect(readCalls).toEqual(["README.md"]);

    expect(calls).toHaveLength(1);
    const ctx = calls[0]!.ctx;
    expect(ctx.runReadOnlyQuery).toBeUndefined();
    expect(typeof ctx.readWorkspaceFile).toBe("function");
    expect("adapter" in ctx).toBe(false);
    expect("host" in ctx).toBe(false);
  });
});
