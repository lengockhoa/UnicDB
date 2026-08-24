// src/ai/__tests__/agent.test.ts — TASK-003 TDD tests
import { describe, it, expect, vi, type Mock } from "vitest";
import {
  runAgent,
  EMPTY_TOOL_REGISTRY,
  type AgentDeps,
  type AgentInput,
  type AgentTool,
  type ToolRegistry,
  type AgentStep,
} from "../agent";
import type { AiConfig, AiModelRole } from "../settings";
import type { ChatMessage, ProviderRequest, ProviderResult, ToolCall } from "../provider";

// ---- types ------------------------------------------------------------------

/** A vi.fn() mock whose `mockResolvedValueOnce` returns a single value type. */
type MockedFn<T> = Mock<[], Promise<T>>;

// ---- helpers ----------------------------------------------------------------

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
  complete: MockedFn<ProviderResult>;
  loadConfig: MockedFn<AiConfig | null>;
}

function makeDeps(opts: { cfg?: AiConfig | null; results?: ProviderResult[] } = {}): TestDeps {
  const cfg = opts.cfg === undefined ? makeConfig() : opts.cfg;
  const results = opts.results ?? [resultOk("done")];
  const complete: MockedFn<ProviderResult> = vi.fn(async () => results.shift()!);
  const loadConfig: MockedFn<AiConfig | null> = vi.fn(async () => cfg);
  return { loadConfig, complete };
}

// ---- tests ------------------------------------------------------------------

describe("runAgent — frozen contract", () => {
  it("test #1 single-turn direct answer", async () => {
    const deps = makeDeps({ results: [resultOk("hello")] });
    const input: AgentInput = { messages: [textMsg("system", "s"), textMsg("user", "hi")] };
    const out = await runAgent(input, deps);

    expect(out.steps).toHaveLength(1);
    expect(out.finalText).toBe("hello");
    expect(out.stoppedOnBudget).toBe(false);
    expect(out.history).toEqual([
      textMsg("system", "s"),
      textMsg("user", "hi"),
      { role: "assistant", content: "hello" },
    ]);
    expect(deps.complete).toHaveBeenCalledTimes(1);
    const [cfgArg, roleArg, reqArg] = (deps.complete.mock.calls[0] ?? []) as [AiConfig, AiModelRole, ProviderRequest];
    expect(cfgArg.models.work.modelId).toBe("work-model-v1");
    expect(roleArg).toBe("work");
    expect(reqArg.modelId).toBe("work-model-v1");
    expect(reqArg.messages).toEqual([textMsg("system", "s"), textMsg("user", "hi")]);
  });

  it("test #2 tool loop happy", async () => {
    const deps = makeDeps({
      results: [
        resultOk("", [{ id: "c1", name: "get_time", argumentsJson: "{}" }]),
        resultOk("the time is now"),
      ],
    });
    const toolDef: AgentTool = {
      name: "get_time",
      description: "current time",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => "2026-08-23T10:00:00Z"),
    };
    const reg: ToolRegistry = {
      list: () => [toolDef],
      get: (n) => (n === "get_time" ? toolDef : undefined),
    };
    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "what time?")],
      tools: reg,
    };
    const out = await runAgent(input, deps);

    expect(out.steps).toHaveLength(2);
    expect(out.finalText).toBe("the time is now");
    expect(out.stoppedOnBudget).toBe(false);
    const step2Req = (deps.complete.mock.calls[1] ?? [])[2] as ProviderRequest;
    expect(step2Req.messages).toEqual([
      textMsg("system", "s"),
      textMsg("user", "what time?"),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "get_time", argumentsJson: "{}" }],
      },
      toolResultMessage("c1", "2026-08-23T10:00:00Z"),
    ]);
  });

  it("test #3 role routing smart", async () => {
    const deps = makeDeps({ results: [resultOk("ok")] });
    const input: AgentInput = { messages: [textMsg("user", "hi")], role: "smart" };
    await runAgent(input, deps);

    const [cfgArg, roleArg, reqArg] = (deps.complete.mock.calls[0] ?? []) as [AiConfig, AiModelRole, ProviderRequest];
    expect(roleArg).toBe("smart");
    expect(reqArg.modelId).toBe(cfgArg.models.smart.modelId);
    expect(reqArg.modelId).toBe("smart-model-v1");
  });

  it("test #4 config snapshot per run", async () => {
    const cfg1 = makeConfig({ models: { work: { modelId: "m1", vision: false }, smart: { modelId: "s1", vision: true } } });
    const cfg2 = makeConfig({ models: { work: { modelId: "m2", vision: false }, smart: { modelId: "s2", vision: true } } });

    const loadConfig = vi.fn<[], Promise<AiConfig | null>>();
    loadConfig.mockResolvedValueOnce(cfg1);
    loadConfig.mockResolvedValueOnce(cfg2);
    const complete = vi.fn<[AiConfig, AiModelRole, ProviderRequest], Promise<ProviderResult>>();
    complete.mockResolvedValueOnce(resultOk("first"));
    complete.mockResolvedValueOnce(resultOk("second"));
    const deps: AgentDeps = { loadConfig, complete };

    const out1 = await runAgent({ messages: [textMsg("user", "a")] }, deps);
    const out2 = await runAgent({ messages: [textMsg("user", "b")] }, deps);

    expect(out1.finalText).toBe("first");
    expect(out2.finalText).toBe("second");
    expect(loadConfig).toHaveBeenCalledTimes(2);

    const [, , req1] = ((complete.mock.calls[0] ?? []) as [AiConfig, AiModelRole, ProviderRequest]);
    const [, , req2] = ((complete.mock.calls[1] ?? []) as [AiConfig, AiModelRole, ProviderRequest]);
    expect(req1.modelId).toBe("m1");
    expect(req2.modelId).toBe("m2");
  });

  it("test #5 always-tool-calling model, maxSteps 3", async () => {
    const toolDef: AgentTool = {
      name: "tick",
      description: "tick",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => "ok"),
    };
    const reg: ToolRegistry = {
      list: () => [toolDef],
      get: () => toolDef,
    };
    const deps = makeDeps({
      results: [
        resultOk("", [{ id: "a", name: "tick", argumentsJson: "{}" }]),
        resultOk("", [{ id: "b", name: "tick", argumentsJson: "{}" }]),
        resultOk("", [{ id: "c", name: "tick", argumentsJson: "{}" }]),
      ],
    });
    const out = await runAgent({ messages: [textMsg("user", "loop")], tools: reg, maxSteps: 3 }, deps);

    expect(deps.complete).toHaveBeenCalledTimes(3);
    expect(out.steps).toHaveLength(3);
    expect(out.stoppedOnBudget).toBe(true);
    expect(out.finalText).toBe("");
  });

  it("test #6 images + non-vision role rejects without calling complete", async () => {
    const deps = makeDeps({
      cfg: makeConfig({ models: { work: { modelId: "no-vision", vision: false }, smart: { modelId: "smart", vision: true } } }),
    });
    const input: AgentInput = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", imageUrl: "data:image/png;base64,AAA" },
          ],
        },
      ],
    };
    await expect(runAgent(input, deps)).rejects.toThrow('Role "work" does not support vision');
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("test #7 unconfigured rejects with 'AI is not configured'", async () => {
    const deps: AgentDeps = {
      loadConfig: vi.fn(async () => null),
      complete: vi.fn(async () => resultOk("never")),
    };
    await expect(runAgent({ messages: [textMsg("user", "hi")] }, deps)).rejects.toThrow("AI is not configured");
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("test #8 unknown tool name — loop continues", async () => {
    const emptyReg: ToolRegistry = EMPTY_TOOL_REGISTRY;
    const deps = makeDeps({
      results: [
        resultOk("", [{ id: "t1", name: "nope", argumentsJson: "{}" }]),
        resultOk("recovered"),
      ],
    });
    const out = await runAgent({ messages: [textMsg("user", "u")], tools: emptyReg }, deps);

    expect(deps.complete).toHaveBeenCalledTimes(2);
    expect(out.stoppedOnBudget).toBe(false);
    expect(out.finalText).toBe("recovered");

    const errToolMsg = out.history.find((m) => m.role === "tool" && m.toolCallId === "t1");
    expect(errToolMsg).toBeDefined();
    expect(errToolMsg!.content).toBe(JSON.stringify({ error: "Unknown tool: nope" }));
  });

  it("test #9 invalid argumentsJson + throwing tool — both errors in same step, loop continues", async () => {
    const throwingTool: AgentTool = {
      name: "throwing",
      description: "throws",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const reg: ToolRegistry = {
      list: () => [throwingTool],
      get: () => throwingTool,
    };

    const deps = makeDeps({
      results: [
        resultOk("", [
          { id: "b1", name: "throwing", argumentsJson: "{bad" },
          { id: "b2", name: "throwing", argumentsJson: "{}" },
        ]),
        resultOk("ok"),
      ],
    });
    const out = await runAgent({ messages: [textMsg("user", "u")], tools: reg }, deps);

    expect(deps.complete).toHaveBeenCalledTimes(2);
    expect(out.stoppedOnBudget).toBe(false);
    expect(out.finalText).toBe("ok");

    const step1 = out.steps[0]!;
    expect(step1.messages).toHaveLength(3);
    expect(step1.messages[0]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "b1", name: "throwing", argumentsJson: "{bad" },
        { id: "b2", name: "throwing", argumentsJson: "{}" },
      ],
    });
    expect(step1.messages[1]).toEqual({
      role: "tool",
      toolCallId: "b1",
      content: JSON.stringify({ error: "Invalid tool arguments" }),
    });
    expect(step1.messages[2]).toEqual({
      role: "tool",
      toolCallId: "b2",
      content: JSON.stringify({ error: "Tool failed: boom" }),
    });
  });

  it("test #10 onStep/onError callbacks", async () => {
    const boomTool: AgentTool = {
      name: "boom",
      description: "boom",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    };
    const reg: ToolRegistry = {
      list: () => [boomTool],
      get: () => boomTool,
    };
    const deps = makeDeps({
      results: [
        resultOk("", [{ id: "x", name: "boom", argumentsJson: "{}" }]),
        resultOk("done"),
      ],
    });
    const onStep = vi.fn();
    const onError = vi.fn();

    const out = await runAgent({ messages: [textMsg("user", "u")], tools: reg }, deps, { onStep, onError });

    expect(onStep).toHaveBeenCalledTimes(2);
    const step1Arg = onStep.mock.calls[0]?.[0] as AgentStep | undefined;
    expect(step1Arg).toBeDefined();
    expect(step1Arg!.messages).toHaveLength(2);
    expect(step1Arg!.messages[0]!.role).toBe("assistant");
    expect(step1Arg!.messages[1]!.role).toBe("tool");

    expect(onError).toHaveBeenCalledTimes(1);
    const errArg = onError.mock.calls[0]?.[0] as Error | undefined;
    expect(errArg).toBeInstanceOf(Error);
    expect(errArg!.message).toBe("kaboom");

    expect(out.stoppedOnBudget).toBe(false);
    expect(out.finalText).toBe("done");
  });

  it("test #11 multi tool calls in one step — both results appended before next complete", async () => {
    const reg: ToolRegistry = { list: () => [], get: () => undefined };
    const deps = makeDeps({
      results: [
        resultOk("", [
          { id: "x1", name: "nope1", argumentsJson: "{}" },
          { id: "x2", name: "nope2", argumentsJson: "{}" },
        ]),
        resultOk("done"),
      ],
    });
    const out = await runAgent({ messages: [textMsg("user", "u")], tools: reg }, deps);

    expect(deps.complete).toHaveBeenCalledTimes(2);
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]!.messages).toHaveLength(3);
    expect(out.steps[0]!.messages[0]!.role).toBe("assistant");
    expect(out.steps[0]!.messages[1]).toEqual({
      role: "tool",
      toolCallId: "x1",
      content: JSON.stringify({ error: "Unknown tool: nope1" }),
    });
    expect(out.steps[0]!.messages[2]).toEqual({
      role: "tool",
      toolCallId: "x2",
      content: JSON.stringify({ error: "Unknown tool: nope2" }),
    });

    const req2 = (deps.complete.mock.calls[1] ?? [])[2] as ProviderRequest;
    const toolMsgs = req2.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]!.toolCallId).toBe("x1");
    expect(toolMsgs[1]!.toolCallId).toBe("x2");
  });

  it("test #12 EMPTY_TOOL_REGISTRY — list() [], get() undefined; runAgent sends tools: []", async () => {
    expect(EMPTY_TOOL_REGISTRY.list()).toEqual([]);
    expect(EMPTY_TOOL_REGISTRY.get("anything")).toBeUndefined();

    const deps = makeDeps({ results: [resultOk("ok")] });
    await runAgent({ messages: [textMsg("user", "hi")] }, deps);

    const req = (deps.complete.mock.calls[0] ?? [])[2] as ProviderRequest;
    expect(req.tools).toEqual([]);
  });
});

// ============================================================================
// TASK-002 — Cases 1-4: onToolCall callback contract (RED before impl).
//   #1 fires once per call, before execution, in order
//   #2 no tool calls → callback never fires
//   #3 empty tool name → callback still fires
//   #4 missing onToolCall stays backward-compatible
// ============================================================================
describe("runAgent — onToolCall callback (TASK-002)", () => {
  it("case #1 onToolCall fires once per call, before execution, in order", async () => {
    const execOrder: string[] = [];
    const toolA: AgentTool = {
      name: "a",
      description: "a",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        execOrder.push("execA");
        return "A-out";
      }),
    };
    const toolB: AgentTool = {
      name: "b",
      description: "b",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => {
        execOrder.push("execB");
        return "B-out";
      }),
    };
    const reg: ToolRegistry = {
      list: () => [toolA, toolB],
      get: (n) => (n === "a" ? toolA : n === "b" ? toolB : undefined),
    };
    const deps = makeDeps({
      results: [
        resultOk("", [
          { id: "c1", name: "a", argumentsJson: "{}" },
          { id: "c2", name: "b", argumentsJson: "{}" },
        ]),
        resultOk("done"),
      ],
    });
    const onToolCall = vi.fn((call: ToolCall) => {
      execOrder.push(`hook:${call.id}`);
    });

    await runAgent({ messages: [textMsg("user", "u")], tools: reg }, deps, { onToolCall });

    expect(onToolCall).toHaveBeenCalledTimes(2);
    expect(onToolCall.mock.calls.map((c) => c[0]?.id)).toEqual(["c1", "c2"]);
    // Hook fires BEFORE each tool's execute resolves.
    expect(execOrder).toEqual(["hook:c1", "execA", "hook:c2", "execB"]);
  });

  it("case #2 no tool calls → onToolCall never fires", async () => {
    const deps = makeDeps({ results: [resultOk("plain text")] });
    const onToolCall = vi.fn();
    const out = await runAgent(
      { messages: [textMsg("user", "u")] },
      deps,
      { onToolCall },
    );
    expect(onToolCall).not.toHaveBeenCalled();
    expect(out.finalText).toBe("plain text");
  });

  it("case #3 empty tool name → onToolCall still fires with that call", async () => {
    const emptyTool: AgentTool = {
      name: "nameless",
      description: "executes regardless of call.name",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => "ok"),
    };
    // Registry returns a tool only for the canonical name "" — but
    // executeToolCall looks up `call.name` against the registry, so the
    // "Unknown tool" path is fine here: we only verify the HOOK fired.
    const reg: ToolRegistry = { list: () => [emptyTool], get: () => emptyTool };
    const deps = makeDeps({
      results: [
        resultOk("", [{ id: "x", name: "", argumentsJson: "{}" }]),
        resultOk("done"),
      ],
    });
    const onToolCall = vi.fn();

    await runAgent({ messages: [textMsg("user", "u")], tools: reg }, deps, { onToolCall });

    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0]?.[0]).toEqual({ id: "x", name: "", argumentsJson: "{}" });
  });

  it("case #4 missing onToolCall stays backward-compatible", async () => {
    const toolDef: AgentTool = {
      name: "ok",
      description: "ok",
      parameters: { type: "object", properties: {} },
      execute: vi.fn(async () => "ok-out"),
    };
    const reg: ToolRegistry = { list: () => [toolDef], get: () => toolDef };
    const deps = makeDeps({
      results: [
        resultOk("", [{ id: "t", name: "ok", argumentsJson: "{}" }]),
        resultOk("done"),
      ],
    });
    // No callbacks object at all — backward-compat smoke.
    const out = await runAgent({ messages: [textMsg("user", "u")], tools: reg }, deps);
    expect(out.finalText).toBe("done");
    expect(out.stoppedOnBudget).toBe(false);

    // Callbacks object present but onToolCall omitted — also backward-compat.
    const out2 = await runAgent(
      { messages: [textMsg("user", "u")], tools: reg },
      makeDeps({
        results: [
          resultOk("", [{ id: "t", name: "ok", argumentsJson: "{}" }]),
          resultOk("done2"),
        ],
      }),
      {},
    );
    expect(out2.finalText).toBe("done2");
  });
});
