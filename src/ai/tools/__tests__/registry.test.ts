// src/ai/tools/__tests__/registry.test.ts — TASK-001 TDD tests (RED → GREEN)
// Spec: docs/AI_HANDOFF/tasks/TASK-001.md §Test Cases (frozen). NO vscode import.

import { describe, it, expect, vi, type Mock } from "vitest";
import { DbToolRegistry, createDbTools } from "../registry";
import { runAgent } from "../../agent";
import type { AgentTool, AgentInput, AgentDeps } from "../../agent";
import type { AiConfig, AiModelRole } from "../../settings";
import type { ChatMessage, ProviderRequest, ProviderResult, ToolCall } from "../../provider";
import type { DbAdapter, TableInfo, TableDetail } from "../../../adapters/types";
import type { AdapterFactory } from "../types";

// ---- helpers (test seams, match existing agent.test.ts pattern) -------------

function makeConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  const base: AiConfig = {
    baseUrl: "https://api.example.com/v1/",
    method: "chat/completions",
    timeoutMs: 60_000,
    maxSteps: 10,
    apiKey: "sk-test",
    models: {
      work: { modelId: "work-model-v1", vision: false },
      smart: { modelId: "smart-model-v1", vision: true },
    },
  };
  return { ...base, ...overrides, models: { ...base.models, ...(overrides.models ?? {}) } };
}

function resultOk(text: string, toolCalls: ToolCall[] = []): ProviderResult {
  return {
    text,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function textMsg(role: "system" | "user", content: string): ChatMessage {
  return { role, content };
}

function toolResultMessage(id: string, content: string): ChatMessage {
  return { role: "tool", toolCallId: id, content };
}

interface TestDeps extends AgentDeps {
  complete: Mock<[AiConfig, AiModelRole, ProviderRequest], Promise<ProviderResult>>;
  loadConfig: Mock<[], Promise<AiConfig | null>>;
}

function makeDeps(
  results: ProviderResult[],
  cfg: AiConfig = makeConfig(),
): TestDeps {
  const queue = [...results];
  return {
    loadConfig: vi.fn(async () => cfg),
    complete: vi.fn(async (_c, _r, _req) => {
      const next = queue.shift();
      if (!next) throw new Error("no more scripted results");
      return next;
    }),
  };
}

function fakeAdapter(impl: Partial<DbAdapter>): DbAdapter {
  return impl as DbAdapter;
}

function tablesFixture(): TableInfo[] {
  return [{ schema: "public", name: "users" }];
}

function detailFixture(): TableDetail {
  return {
    columns: [
      { column_name: "id", format_type: "uuid", is_nullable: "NO", column_default: null },
    ],
    constraints: [],
  };
}

// ---- test #6: DbToolRegistry unit ------------------------------------------

describe("DbToolRegistry — frozen contract", () => {
  it("test #6 register/list/get: list() preserves order, get(unknown) → undefined", () => {
    const reg = new DbToolRegistry();
    const a: AgentTool = {
      name: "alpha",
      description: "a",
      parameters: { type: "object", properties: {} },
      execute: async () => "A",
    };
    const b: AgentTool = {
      name: "bravo",
      description: "b",
      parameters: { type: "object", properties: {} },
      execute: async () => "B",
    };
    const c: AgentTool = {
      name: "charlie",
      description: "c",
      parameters: { type: "object", properties: {} },
      execute: async () => "C",
    };

    reg.register(b);
    reg.register(a);
    reg.register(c);

    expect(reg.list().map((t) => t.name)).toEqual(["bravo", "alpha", "charlie"]);
    expect(reg.get("alpha")?.name).toBe("alpha");
    expect(reg.get("bravo")?.name).toBe("bravo");
    expect(reg.get("nope")).toBeUndefined();
  });
});

// ---- test #7: regression — createDbTools + runAgent 2-step tool loop -------

describe("createDbTools + runAgent regression — frozen contract", () => {
  it("test #7 createDbTools registers list_tables + describe_table, runAgent 2-step loop", async () => {
    const adapter = fakeAdapter({
      listTables: vi.fn(async () => tablesFixture()),
      listTableDetail: vi.fn(async () => detailFixture()),
    });
    const f: AdapterFactory = async () => adapter;

    const reg = createDbTools(f);
    expect(reg.list().map((t) => t.name).sort()).toEqual(["describe_table", "list_tables"]);

    const deps = makeDeps([
      resultOk("", [
        { id: "c1", name: "list_tables", argumentsJson: '{"schema":"public"}' },
        { id: "c2", name: "describe_table", argumentsJson: '{"schema":"public","table":"users"}' },
      ]),
      resultOk("all done"),
    ]);

    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "describe users")],
      tools: reg,
    };

    const out = await runAgent(input, deps);

    expect(out.steps).toHaveLength(2);
    expect(out.finalText).toBe("all done");
    expect(out.stoppedOnBudget).toBe(false);

    const step2Req = (deps.complete.mock.calls[1] ?? [])[2] as ProviderRequest;
    const messages = step2Req.messages;
    expect(messages).toContainEqual(toolResultMessage("c1", expect.stringContaining("users")));
    expect(messages).toContainEqual(toolResultMessage("c2", expect.stringContaining("id")));

    expect(adapter.listTables).toHaveBeenCalledWith("public");
    expect(adapter.listTableDetail).toHaveBeenCalledWith("public", "users");
  });
});
