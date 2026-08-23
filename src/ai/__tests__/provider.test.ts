// src/ai/__tests__/provider.test.ts
// Tests for TASK-002: OpenAI-compatible provider client (pure, injected fetch).
// Spec: docs/AI_HANDOFF/tasks/TASK-002.md §Spec + §Test Cases.
import { describe, it, expect, vi } from "vitest";
import {
  createProviderClient,
  buildChatCompletionsBody,
  parseChatCompletionsResponse,
  buildResponsesBody,
  parseResponsesResponse,
  ProviderError,
  type FetchLike,
  type ProviderRequest,
} from "../provider";

// ---- helpers ---------------------------------------------------------------
interface CapturedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal };
}

function makeFetch(capture: CapturedCall, responder: (url: string, init: CapturedCall["init"]) => Promise<Response>): FetchLike {
  return vi.fn(async (url: string, init: CapturedCall["init"]) => {
    capture.url = url;
    capture.init = init;
    return responder(url, init);
  });
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200, statusText = "OK"): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "Content-Type": "text/plain" },
  });
}

const baseReq = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  modelId: "gpt-test",
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      name: "get_schema",
      description: "Get schema",
      parameters: { type: "object", properties: {} },
    },
  ],
  maxOutputTokens: 256,
  temperature: 0.5,
  ...overrides,
});

// ---- tests -----------------------------------------------------------------
describe("provider — chat/completions request shape (#1)", () => {
  it("builds correct URL, headers, and body; parses usage", async () => {
    const captured: CapturedCall = { url: "", init: { method: "", headers: {}, body: "", signal: undefined as unknown as AbortSignal } };
    const fetch = makeFetch(captured, async () =>
      jsonResponse({
        id: "x",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const result = await client.complete(baseReq());
    expect(captured.url).toBe("https://x/v1/chat/completions");
    expect(captured.init.method).toBe("POST");
    expect(captured.init.headers["Content-Type"]).toBe("application/json");
    expect(captured.init.headers["Authorization"]).toBe("Bearer sk-1");
    expect(captured.init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe("gpt-test");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("hi");
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.5);
    expect(body.tools).toBeDefined();
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("provider — responses request shape (#2)", () => {
  it("uses /responses path, instructions from system messages, input items in responses shape", async () => {
    const captured: CapturedCall = { url: "", init: { method: "", headers: {}, body: "", signal: undefined as unknown as AbortSignal } };
    const fetch = makeFetch(captured, async () =>
      jsonResponse({ output_text: "ok", status: "completed" }),
    );
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-2",
      method: "responses",
      fetch,
    });
    const req: ProviderRequest = {
      modelId: "gpt-test",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello there" },
      ],
      maxOutputTokens: 128,
      temperature: 0.2,
    };
    await client.complete(req);
    expect(captured.url).toBe("https://x/v1/responses");
    const body = JSON.parse(captured.init.body);
    expect(body.model).toBe("gpt-test");
    expect(body.instructions).toBe("Be concise.");
    expect(Array.isArray(body.input)).toBe(true);
    const userItem = body.input.find((it: { role?: string }) => it.role === "user");
    expect(userItem).toBeTruthy();
    const textPart = userItem.content.find((p: { type: string }) => p.type === "input_text");
    expect(textPart.text).toBe("Hello there");
    expect(body.max_output_tokens).toBe(128);
    expect(body.temperature).toBe(0.2);
  });
});

describe("provider — chat parse text + finishReason (#3)", () => {
  it("parses text, no tool_calls, usage present → stop", () => {
    const out = parseChatCompletionsResponse({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Hello" },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(out).toEqual({
      text: "Hello",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });
});

describe("provider — chat parse tool_calls (#4)", () => {
  it("parses tool_calls and finishReason tool_calls", () => {
    const out = parseChatCompletionsResponse({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "get_schema", arguments: '{"q":1}' },
              },
            ],
          },
        },
      ],
    });
    expect(out.toolCalls).toEqual([{ id: "c1", name: "get_schema", argumentsJson: '{"q":1}' }]);
    expect(out.finishReason).toBe("tool_calls");
    expect(out.text).toBe("");
  });
});

describe("provider — responses parse output_text (#5)", () => {
  it("reads output_text shortcut → text, toolCalls [], finishReason stop, usage present", () => {
    const out = parseResponsesResponse({
      output_text: "Hi",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(out).toEqual({
      text: "Hi",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });
});

describe("provider — responses parse function_call item (#6)", () => {
  it("extracts toolCalls from function_call items, finishReason tool_calls, text empty", () => {
    const out = parseResponsesResponse({
      output: [
        { type: "function_call", call_id: "c9", name: "run_sql", arguments: "{}" },
      ],
      status: "completed",
    });
    expect(out.toolCalls).toEqual([{ id: "c9", name: "run_sql", argumentsJson: "{}" }]);
    expect(out.finishReason).toBe("tool_calls");
    expect(out.text).toBe("");
  });
});

describe("provider — vision content parts both methods (#7)", () => {
  it("maps image_url parts to image_url in chat and input_image in responses", async () => {
    const captured: CapturedCall = { url: "", init: { method: "", headers: {}, body: "", signal: undefined as unknown as AbortSignal } };
    const fetch = makeFetch(captured, async () => jsonResponse({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }] }));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const req: ProviderRequest = {
      modelId: "gpt-vision",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "gì đây" },
            { type: "image_url", imageUrl: "data:image/png;base64,AAA" },
          ],
        },
      ],
    };
    await client.complete(req);
    const chatBody = JSON.parse(captured.init.body);
    const parts = chatBody.messages[0].content;
    const imagePart = parts.find((p: { type: string }) => p.type === "image_url");
    expect(imagePart.image_url.url).toBe("data:image/png;base64,AAA");

    // Now switch to responses method
    const captured2: CapturedCall = { url: "", init: { method: "", headers: {}, body: "", signal: undefined as unknown as AbortSignal } };
    const fetch2 = makeFetch(captured2, async () => jsonResponse({ output_text: "ok", status: "completed" }));
    const client2 = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "responses",
      fetch: fetch2,
    });
    await client2.complete(req);
    const respBody = JSON.parse(captured2.init.body);
    const userItem = respBody.input.find((it: { role?: string }) => it.role === "user");
    const img = userItem.content.find((p: { type: string }) => p.type === "input_image");
    expect(img.image_url).toBe("data:image/png;base64,AAA");
  });
});

describe("provider — timeout abort (#8)", () => {
  it("maps AbortError to ProviderError timeout:true with timed-out message", async () => {
    const aborter = new AbortController();
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      // Wire real signal so the test exercises AbortController behavior end-to-end
      init.signal.addEventListener("abort", () => {
        const err: Error & { name: string } = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });
      // Force immediate reject with AbortError — no real timers needed
      aborter.abort();
      const err: Error & { name: string } = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      timeoutMs: 100,
      fetch,
    });
    try {
      await client.complete(baseReq());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.timeout).toBe(true);
      expect(pe.message).toContain("timed out after 100ms");
      expect(pe.endpoint).toBe("https://x/v1/chat/completions");
    }
  });
});

describe("provider — 200 non-JSON (#9)", () => {
  it("maps JSON.parse failure on 2xx to ProviderError invalid JSON, status undefined", async () => {
    const fetch: FetchLike = vi.fn(async () => textResponse("not json{"));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    try {
      await client.complete(baseReq());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.message).toContain("invalid JSON in response");
      expect(pe.status).toBeUndefined();
    }
  });
});

describe("provider — apiKey scrubbed from error snippet (#10)", () => {
  it("replaces every occurrence of apiKey in 401 body with ***", async () => {
    const fetch: FetchLike = vi.fn(async () =>
      textResponse("Unauthorized for key sk-secret-123", 401, "Unauthorized"),
    );
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-secret-123",
      method: "chat/completions",
      fetch,
    });
    try {
      await client.complete(baseReq());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.bodySnippet).toBe("Unauthorized for key ***");
      expect(pe.status).toBe(401);
      // apiKey must not appear in any field
      expect(pe.message).not.toContain("sk-secret-123");
      expect(pe.bodySnippet).not.toContain("sk-secret-123");
    }
  });
});

describe("provider — trailing-slash baseUrl (#11)", () => {
  it("produces single slash between baseUrl and path segment", async () => {
    const captured: CapturedCall = { url: "", init: { method: "", headers: {}, body: "", signal: undefined as unknown as AbortSignal } };
    const fetch = makeFetch(captured, async () =>
      jsonResponse({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }] }),
    );
    const client = createProviderClient({
      baseUrl: "https://x/v1/",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    await client.complete(baseReq());
    expect(captured.url).toBe("https://x/v1/chat/completions");
  });
});

describe("provider — empty/absent optionals (#12)", () => {
  it("returns usage {0,0}, text '', toolCalls [], finishReason 'other' for unknown finish_reason", () => {
    const out = parseChatCompletionsResponse({
      choices: [
        { index: 0, finish_reason: "content_filter", message: { role: "assistant", content: null }, tool_calls: [] },
      ],
      // no usage
    });
    expect(out).toEqual({
      text: "",
      toolCalls: [],
      finishReason: "other",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

describe("provider — connection refused (#13)", () => {
  it("maps TypeError fetch failed → ProviderError timeout:false, network error message", async () => {
    const fetch: FetchLike = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    try {
      await client.complete(baseReq());
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.timeout).toBe(false);
      expect(pe.message).toContain("network error: fetch failed");
    }
  });
});

// ---- bonus: builder unit tests (cheap, ensure no regression) -------------
describe("buildChatCompletionsBody — tool/assistant mapping", () => {
  it("maps assistant with toolCalls and tool result messages", () => {
    const body = buildChatCompletionsBody({
      modelId: "m",
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", argumentsJson: "{}" }] },
        { role: "tool", content: '{"ok":true}', toolCallId: "c1" },
      ],
    });
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
    ]);
  });
});

describe("buildResponsesBody — system messages concatenated", () => {
  it("joins multiple system messages into instructions", () => {
    const body = buildResponsesBody({
      modelId: "m",
      messages: [
        { role: "system", content: "S1" },
        { role: "system", content: "S2" },
        { role: "user", content: "Q" },
      ],
    });
    expect(body.instructions).toBe("S1\nS2");
    expect(Array.isArray(body.input)).toBe(true);
  });
});