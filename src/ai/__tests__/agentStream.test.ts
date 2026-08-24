// src/ai/__tests__/agentStream.test.ts — TASK-002 TDD tests
// Covers stream path in runAgent: opt-in via deps.streamComplete + cfg.method ===
// "chat/completions"; onText emitted per delta; onStreamFallback fires exactly
// once before deps.complete when stream rejects with ProviderError pre-emit;
// AbortError aborts propagate bare and never trigger fallback; mid-stream
// ProviderError surfaces and never triggers fallback. See
// docs/AI_HANDOFF/tasks/TASK-002.md §Test Cases for the frozen contract.
import { describe, it, expect, vi, type Mock } from "vitest";
import { runAgent, type AgentDeps, type AgentInput, type AgentTool, type ToolRegistry } from "../agent";
import type { AiConfig, AiModelRole } from "../settings";
import type { ChatMessage, ProviderRequest, ProviderResult, ToolCall } from "../provider";
import { ProviderError } from "../provider";

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

function makeProviderError(message: string): ProviderError {
  return new ProviderError(message, {
    timeout: false,
    endpoint: "https://api.example.com/v1/chat/completions",
    bodySnippet: "",
  });
}

type StreamCompleteFn = NonNullable<AgentDeps["streamComplete"]>;
type CompleteFn = AgentDeps["complete"];

interface StreamDeps extends AgentDeps {
  streamComplete: Mock<Parameters<StreamCompleteFn>, ReturnType<StreamCompleteFn>>;
  complete: Mock<Parameters<CompleteFn>, ReturnType<CompleteFn>>;
  loadConfig: Mock<[], Promise<AiConfig | null>>;
}

function makeStreamDeps(opts: {
  cfg?: AiConfig | null;
  streamCompleteImpl: StreamCompleteFn;
  completeImpl?: CompleteFn;
}): StreamDeps {
  const cfg = opts.cfg === undefined ? makeConfig() : opts.cfg;
  const loadConfig = vi.fn(async () => cfg);
  const completeImpl = opts.completeImpl ?? (async () => resultOk("fallback never"));
  const complete = vi.fn<Parameters<CompleteFn>, ReturnType<CompleteFn>>(completeImpl);
  const streamComplete = vi.fn<Parameters<StreamCompleteFn>, ReturnType<StreamCompleteFn>>(opts.streamCompleteImpl);
  return { loadConfig, complete, streamComplete };
}

// ---- tests ------------------------------------------------------------------

describe("runAgent — stream opt-in (TASK-002)", () => {
  it("case #1 happy single-step: stream emits 2 deltas then final", async () => {
    const onText = vi.fn();
    const streamImpl: StreamCompleteFn = async (_cfg, _role, _req, onTextFn, _signal) => {
      onTextFn({ text: "hi " });
      onTextFn({ text: "there" });
      return resultOk("there");
    };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl });
    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "hi")],
    };

    const out = await runAgent(input, deps, { onText });

    expect(onText.mock.calls.map((c) => c[0])).toEqual(["hi ", "there"]);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.result.text).toBe("there");
    expect(out.history).toEqual([
      textMsg("system", "s"),
      textMsg("user", "hi"),
      { role: "assistant", content: "there" },
    ]);
    // complete() was NOT used — stream path took over
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.streamComplete).toHaveBeenCalledTimes(1);
  });

  it("case #2 tool loop: tool step emits no text, text step does; argumentsJson merges from stream", async () => {
    const onText = vi.fn();
    let callIdx = 0;
    const streamImpl: StreamCompleteFn = async (_cfg, _role, _req, onTextFn, _signal) => {
      const i = callIdx++;
      if (i === 0) {
        // Tool step: emit no deltas. ProviderResult carries toolCalls; the
        // agent must NOT call onText for this step because tool calls own
        // the assistant message.
        return resultOk("", [{ id: "c1", name: "echo", argumentsJson: '{"v":1}' }]);
      }
      // Text step: emit 1 delta then resolve with text.
      onTextFn({ text: "done" });
      return resultOk("done");
    };
    const echoTool: AgentTool = {
      name: "echo",
      description: "echo args",
      parameters: { type: "object", properties: { v: { type: "number" } } },
      execute: vi.fn(async (args) => `echo:${JSON.stringify(args)}`),
    };
    const reg: ToolRegistry = { list: () => [echoTool], get: (n) => (n === "echo" ? echoTool : undefined) };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl });

    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "run")],
      tools: reg,
    };

    const out = await runAgent(input, deps, { onText });

    expect(deps.streamComplete).toHaveBeenCalledTimes(2);
    expect(deps.complete).not.toHaveBeenCalled();
    expect(out.steps).toHaveLength(2);
    expect(out.finalText).toBe("done");
    expect(out.stoppedOnBudget).toBe(false);

    // Tool step (step 1): no onText, assistant msg has toolCalls (text ""), tool
    // result appended.
    expect(out.steps[0]!.messages[0]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "echo", argumentsJson: '{"v":1}' }],
    });
    expect(out.steps[0]!.messages[1]).toEqual({
      role: "tool",
      toolCallId: "c1",
      content: "echo:{\"v\":1}",
    });

    // Text step (step 2): onText fired exactly once with "done".
    expect(onText.mock.calls.map((c) => c[0])).toEqual(["done"]);
    expect(out.steps[1]!.messages[0]).toEqual({ role: "assistant", content: "done" });
  });

  it("case #3 fallback: streamComplete rejects ProviderError pre-emit → onStreamFallback once + deps.complete", async () => {
    const onText = vi.fn();
    const onStreamFallback = vi.fn();
    const fallbackResult = resultOk("fallback ok");
    const streamImpl: StreamCompleteFn = async () => {
      throw makeProviderError("upstream down");
    };
    let capturedReq: ProviderRequest | undefined;
    const completeImpl: CompleteFn = async (_cfg, _role, req) => {
      capturedReq = req;
      return fallbackResult;
    };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl, completeImpl });

    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "hi")],
    };

    const out = await runAgent(input, deps, { onText, onStreamFallback });

    expect(onStreamFallback).toHaveBeenCalledTimes(1);
    // onStreamFallback fired BEFORE complete (single microtask flush — verify by call order).
    const fbOrder = onStreamFallback.mock.invocationCallOrder[0]!;
    const completeOrder = deps.complete.mock.invocationCallOrder[0]!;
    expect(fbOrder).toBeLessThan(completeOrder);

    expect(deps.complete).toHaveBeenCalledTimes(1);
    expect(capturedReq).toBeDefined();
    // Request passed to complete MUST be deep-equal to the one originally
    // constructed for the stream attempt. The agent builds one req per step and
    // passes the same instance through both paths.
    const [, , streamReq] = (deps.streamComplete.mock.calls[0] ?? []) as [AiConfig, AiModelRole, ProviderRequest];
    expect(capturedReq).toEqual(streamReq);

    expect(onText).not.toHaveBeenCalled();
    expect(out.finalText).toBe("fallback ok");
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.result.text).toBe("fallback ok");
  });

  it("case #4 mid-stream ProviderError after onText → rethrow, NO fallback", async () => {
    const onText = vi.fn();
    const onStreamFallback = vi.fn();
    const upstreamErr = makeProviderError("mid-stream boom");
    const streamImpl: StreamCompleteFn = async (_cfg, _role, _req, onTextFn, _signal) => {
      onTextFn({ text: "par" });
      throw upstreamErr;
    };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl });

    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "hi")],
    };

    await expect(runAgent(input, deps, { onText, onStreamFallback })).rejects.toBe(upstreamErr);

    expect(onText).toHaveBeenCalledTimes(1);
    expect(onStreamFallback).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("case #5a abort mid-stream (after 1 onText) → AbortError propagates bare, NO fallback", async () => {
    const onText = vi.fn();
    const onStreamFallback = vi.fn();
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const abortErr = Object.assign(new Error("stream aborted"), { name: "AbortError" as const });
    const streamImpl: StreamCompleteFn = async (_cfg, _role, _req, onTextFn, signal) => {
      capturedSignal = signal;
      onTextFn({ text: "par" });
      controller.abort();
      throw abortErr;
    };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl });

    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "hi")],
    };

    const runP = runAgent(input, deps, { onText, onStreamFallback }, controller.signal);
    await expect(runP).rejects.toMatchObject({ name: "AbortError" });
    // Verify it was the exact abortErr (name + message preserved).
    await expect(runP).rejects.toBe(abortErr);

    expect(capturedSignal).toBe(controller.signal);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onStreamFallback).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("case #5b abort pre-emit (tool step, emitted===0) → AbortError propagates, NO fallback", async () => {
    const onText = vi.fn();
    const onStreamFallback = vi.fn();
    const controller = new AbortController();
    const abortErr = Object.assign(new Error("stream aborted"), { name: "AbortError" as const });
    const streamImpl: StreamCompleteFn = async (_cfg, _role, _req, _onTextFn, signal) => {
      // Abort BEFORE any onText — this is the critical case: emitted === 0 yet
      // the abort rule MUST block fallback to non-stream.
      controller.abort();
      if (signal) {
        // sanity: signal is wired through.
        expect(typeof signal.aborted).toBe("boolean");
      }
      throw abortErr;
    };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl });

    const reg: ToolRegistry = { list: () => [], get: () => undefined };
    const input: AgentInput = {
      messages: [textMsg("system", "s"), textMsg("user", "run")],
      tools: reg,
    };

    await expect(runAgent(input, deps, { onText, onStreamFallback }, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });

    expect(onText).not.toHaveBeenCalled();
    expect(onStreamFallback).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("case #5c abort propagated even when err.name is NOT 'AbortError' but signal.aborted is true", async () => {
    // Edge of the spec: rule is `err.name === "AbortError" || signal?.aborted`
    // — either condition alone must trigger the no-fallback path. We exercise
    // the OR (signal.aborted === true, name !== "AbortError") arm.
    const onStreamFallback = vi.fn();
    const controller = new AbortController();
    const genericErr = new Error("cancelled by upstream");
    const streamImpl: StreamCompleteFn = async (_cfg, _role, _req, _onTextFn, _signal) => {
      controller.abort();
      throw genericErr;
    };
    const deps = makeStreamDeps({ streamCompleteImpl: streamImpl });

    const input: AgentInput = { messages: [textMsg("user", "hi")] };

    await expect(runAgent(input, deps, { onStreamFallback }, controller.signal)).rejects.toBe(genericErr);
    expect(onStreamFallback).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });
});