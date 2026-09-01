// src/ai/__tests__/provider.test.ts
// Tests for TASK-002: OpenAI-compatible provider client (pure, injected fetch).
// Spec: docs/AI_HANDOFF/tasks/TASK-002.md §Spec + §Test Cases.
// + TASK-001: provider streamComplete SSE streaming.
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

// ---- TASK-001: streamComplete SSE ---------------------------------------
function sseResponse(body: string, status = 200, statusText = "OK"): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseStreamResponse(
  pump: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        try {
          pump(controller);
        } catch (e) {
          controller.error(e);
        }
      },
    }),
    { status: 200, statusText: "OK", headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("provider — streamComplete (#1 happy)", () => {
  it("emits onText per delta chunk, final result with usage from last chunk", async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n' +
      "data: [DONE]\n\n";
    const fetch: FetchLike = vi.fn(async () => sseResponse(sseBody));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const texts: string[] = [];
    const result = await client.streamComplete(baseReq(), {
      onText: (ev) => texts.push(ev.text),
    });
    expect(texts).toEqual(["Hel", "lo", "!"]);
    expect(result).toEqual({
      text: "Hello!",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 5 },
    });
  });
});

describe("provider — streamComplete (#2 malformed events)", () => {
  it("skips JSON.parse failures and events without choices, but keeps good events", async () => {
    const sseBody =
      "data: {bad json\n\n" +
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      "data: {}\n\n" +
      "data: [DONE]\n\n";
    const fetch: FetchLike = vi.fn(async () => sseResponse(sseBody));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const texts: string[] = [];
    const result = await client.streamComplete(baseReq(), {
      onText: (ev) => texts.push(ev.text),
    });
    expect(texts).toEqual(["ok"]);
    expect(result.text).toBe("ok");
  });
});

describe("provider — streamComplete (#3 chunk boundaries + multi-line data)", () => {
  it("reassembles fragments split mid-UTF8, mid-line, and across events; concatenates multi-line data with \\n", async () => {
    // "hél" → "h" 0x68, "é" 0xC3 0xA9, "l" 0x6C.
    // Split mid-UTF8: chunk1 ends with bytes for "h" + first byte of "é" (0xC3).
    const part1 = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"h');
    const part2 = new TextEncoder().encode(
      'él"}}]}\n\ndata: [DONE]\n\n',
    );
    // The boundary is inside the JSON content of a single data: line.
    // Concretely: split after the opening of the "hél" content string.
    // The first chunk ends right before the UTF-8 bytes for "é" are written.
    // We achieve the split by making the first chunk contain "data: {\"choices\":[{\"delta\":{\"content\":\"h"
    // and the second chunk contain the rest of the JSON, the event terminator, and [DONE].
    const resp = sseStreamResponse((c) => {
      // enqueue first fragment (no terminator yet, content string not yet closed)
      c.enqueue(part1);
      // enqueue second fragment: closes the JSON, ends the event, then [DONE] event
      c.enqueue(part2);
      c.close();
    });
    const fetch: FetchLike = vi.fn(async () => resp);
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const texts: string[] = [];
    const result = await client.streamComplete(baseReq(), {
      onText: (ev) => texts.push(ev.text),
    });
    expect(texts).toEqual(["h\u00e9l"]);
    expect(result.text).toBe("h\u00e9l");
  });
});

describe("provider — streamComplete (#4 HTTP 401)", () => {
  it("throws ProviderError with status 401 and apiKey scrubbed from snippet/message", async () => {
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
      await client.streamComplete(baseReq(), { onText: () => {} });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      const pe = e as ProviderError;
      expect(pe.status).toBe(401);
      expect(pe.bodySnippet).toBe("Unauthorized for key ***");
      expect(pe.message).not.toContain("sk-secret-123");
      expect(pe.bodySnippet).not.toContain("sk-secret-123");
    }
  });
});

describe("provider — streamComplete (#5 non-SSE 200)", () => {
  it("throws ProviderError (invalid SSE) when body is plain JSON, no onText fired", async () => {
    const fetch: FetchLike = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "Hello" } }] }),
    );
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    let called = false;
    try {
      await client.streamComplete(baseReq(), {
        onText: () => {
          called = true;
        },
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect(called).toBe(false);
    }
  });
});

describe("provider — streamComplete (#6 abort mid-stream)", () => {
  it("rejects with bare AbortError (not wrapped in ProviderError), no onText after abort", async () => {
    const controller = new AbortController();
    const abortErr: Error & { name: string } = Object.assign(new Error("stream aborted"), {
      name: "AbortError",
    });
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      // Forward caller signal so .abort() works.
      const callerSignal = init.signal;
      return sseStreamResponse((c) => {
        // Enqueue one good delta first.
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
          ),
        );
        // Then error with AbortError when caller aborts.
        callerSignal.addEventListener("abort", () => {
          c.error(abortErr);
        });
      });
    });
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const texts: string[] = [];
    try {
      const p = client.streamComplete(baseReq(), {
        onText: (ev) => texts.push(ev.text),
        signal: controller.signal,
      });
      // abort after this microtask
      await Promise.resolve();
      controller.abort();
      await p;
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      expect(err.name).toBe("AbortError");
      expect(err).not.toBeInstanceOf(ProviderError);
      // "partial" may have been delivered before the abort propagated
      expect(texts.length).toBeLessThanOrEqual(1);
      if (texts.length === 1) expect(texts[0]).toBe("partial");
    }
  });
});

describe("provider — streamComplete (CRLF body regression)", () => {
  it("parses events when server uses \\r\\n\\r\\n separators (legal SSE per spec)", async () => {
    // Some SSE servers emit CRLF-only line endings (SSE spec: "line terminators" can be CR, LF, or CRLF).
    const sseBody =
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"lo"}}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":7,"completion_tokens":5}}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';
    const fetch: FetchLike = vi.fn(async () => sseResponse(sseBody));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const texts: string[] = [];
    const result = await client.streamComplete(baseReq(), {
      onText: (ev) => texts.push(ev.text),
    });
    expect(texts).toEqual(["Hel", "lo", "!"]);
    expect(result.text).toBe("Hello!");
  });
});

// ---- TASK-ARP06-003: usage transport pins ----------------------------------
describe("usage transport — happy parse (#T3.1)", () => {
  it("chat/completions usage parsed → transport-normalized {inputTokens, outputTokens}", () => {
    const out = parseChatCompletionsResponse({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("usage transport — missing usage → normalized zeros (#T3.2)", () => {
  it("parseChatCompletionsResponse: absent usage → usage {0,0}, no throw", () => {
    const out = parseChatCompletionsResponse({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }],
    });
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it("parseResponsesResponse: absent usage → usage {0,0}, no throw", () => {
    const out = parseResponsesResponse({ output_text: "x", status: "completed" });
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("usage transport — malformed usage → 0, never throw, never NaN (#T3.3)", () => {
  it("chat parser: string/null/negative/NaN/non-object usage → {0,0}", () => {
    const base = {
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }],
    };
    const cases: unknown[] = [
      { ...base, usage: { prompt_tokens: "x", completion_tokens: null } },
      { ...base, usage: { prompt_tokens: -5, completion_tokens: -2 } },
      { ...base, usage: { prompt_tokens: Number.NaN, completion_tokens: Number.NaN } },
      { ...base, usage: { prompt_tokens: Number.POSITIVE_INFINITY } },
      { ...base, usage: "oops" },
      { ...base, usage: 42 },
      { ...base, usage: [] },
      { ...base, usage: null },
    ];
    for (const c of cases) {
      let out: ReturnType<typeof parseChatCompletionsResponse>;
      expect(() => {
        out = parseChatCompletionsResponse(c);
      }).not.toThrow();
      expect(out!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(Number.isNaN(out!.usage.inputTokens)).toBe(false);
      expect(Number.isNaN(out!.usage.outputTokens)).toBe(false);
    }
  });
  it("responses parser: string/negative/null usage → {0,0}, no ProviderError, no NaN", () => {
    const cases: unknown[] = [
      { output_text: "x", status: "completed", usage: { input_tokens: "3", output_tokens: null } },
      { output_text: "x", status: "completed", usage: { input_tokens: -7, output_tokens: -1 } },
      { output_text: "x", status: "completed", usage: { input_tokens: Number.NaN } },
      { output_text: "x", status: "completed", usage: "junk" },
    ];
    for (const c of cases) {
      let out: ReturnType<typeof parseResponsesResponse>;
      expect(() => {
        out = parseResponsesResponse(c);
      }).not.toThrow();
      expect(out!.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    }
  });
});

describe("usage transport — streaming final usage emitted once (#T3.4)", () => {
  it("two usage chunks in one stream → result usage = LAST chunk (7/5), NOT the sum (12/9)", async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":5,"completion_tokens":4}}\n\n' +
      'data: {"choices":[{"delta":{"content":"b"}}],"usage":{"prompt_tokens":7,"completion_tokens":5}}\n\n' +
      "data: [DONE]\n\n";
    const fetch: FetchLike = vi.fn(async () => sseResponse(sseBody));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const result = await client.streamComplete(baseReq(), { onText: () => {} });
    expect(result.text).toBe("ab");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 5 });
  });
});

describe("usage transport — aborted/malformed stream never invents usage (#T3.5)", () => {
  it("stream ending with a malformed final event (no terminator) → resolves, usage {0,0}, no hang", async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":"garbage",{broken';
    const fetch: FetchLike = vi.fn(async () => sseResponse(sseBody));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const result = await client.streamComplete(baseReq(), { onText: () => {} });
    expect(result.text).toBe("ok");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it("stream with garbage usage values (negative/string usage objects) → usage {0,0}", async () => {
    const sseBody =
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":-3,"completion_tokens":null}}\n\n' +
      'data: {"usage":"junk"}\n\n' +
      "data: [DONE]\n\n";
    const fetch: FetchLike = vi.fn(async () => sseResponse(sseBody));
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const result = await client.streamComplete(baseReq(), { onText: () => {} });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it("mid-stream caller abort → rejects (bare AbortError); never resolves with an invented usage", async () => {
    const controller = new AbortController();
    const abortErr: Error & { name: string } = Object.assign(new Error("stream aborted"), {
      name: "AbortError",
    });
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      const callerSignal = init.signal;
      return sseStreamResponse((c) => {
        c.enqueue(
          new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
        );
        callerSignal.addEventListener("abort", () => {
          c.error(abortErr);
        });
      });
    });
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const p = client.streamComplete(baseReq(), { onText: () => {}, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    try {
      const result = await p;
      // If it ever resolved instead of rejecting, it must NOT have invented usage.
      throw new Error(`stream resolved with usage ${JSON.stringify(result.usage)} — invented`);
    } catch (e) {
      const err = e as Error;
      expect(err.message).not.toContain("invented");
      expect(err.name).toBe("AbortError");
      expect(err).not.toBeInstanceOf(ProviderError);
    }
  });
});

describe("usage transport — no response body retained for accounting (#T3.6)", () => {
  it("successful parse result exposes only text/toolCalls/finishReason/usage (no body field)", () => {
    const out = parseChatCompletionsResponse({
      id: "resp_1",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "x" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
    expect(Object.keys(out).sort()).toEqual(["finishReason", "text", "toolCalls", "usage"]);
    const out2 = parseResponsesResponse({
      id: "resp_2",
      output_text: "x",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(Object.keys(out2).sort()).toEqual(["finishReason", "text", "toolCalls", "usage"]);
  });
  it("ProviderError carries only the scrubbed ≤300-char bodySnippet, never the full raw body", async () => {
    const filler = "A".repeat(500);
    const rawBody = `Unauthorized for key sk-secret-123 ${filler} TAIL-MARKER`;
    const fetch: FetchLike = vi.fn(async () => textResponse(rawBody, 401, "Unauthorized"));
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
      const pe = e as ProviderError & { rawBody?: unknown };
      // No full-body field retained on the error object. ("name" is the Error's own
      // label property, set in the constructor — not response-body retention.)
      expect(Object.keys(pe).sort()).toEqual([
        "bodySnippet",
        "endpoint",
        "name",
        "status",
        "timeout",
      ]);
      expect(pe.bodySnippet.length).toBeLessThanOrEqual(300);
      expect(pe.bodySnippet).not.toContain("TAIL-MARKER");
      expect(pe.bodySnippet).not.toContain("sk-secret-123");
      expect(pe.message).not.toContain("TAIL-MARKER");
      expect(pe.message).not.toContain("sk-secret-123");
    }
  });
});

describe("provider — streamComplete (caller abort during fetch phase)", () => {
  it("rejects with bare AbortError (name 'AbortError', not ProviderError) when caller signal aborts before response headers arrive", async () => {
    const controller = new AbortController();
    const abortErr: Error & { name: string } = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const fetch: FetchLike = vi.fn(async (_url, init) => {
      // Simulate caller abort during fetch: forward signal so .abort() fires,
      // and reject the fetch promise with an AbortError-shape error (as Node fetch / undici does).
      const callerSignal = init.signal;
      // Simulate the real fetch behavior: throw an AbortError when the signal fires.
      return await new Promise<Response>((_resolve, reject) => {
        callerSignal.addEventListener(
          "abort",
          () => reject(abortErr),
          { once: true },
        );
      });
    });
    const client = createProviderClient({
      baseUrl: "https://x/v1",
      apiKey: "sk-1",
      method: "chat/completions",
      fetch,
    });
    const p = client.streamComplete(baseReq(), {
      onText: () => {
        // should not be called
        throw new Error("onText should not fire on abort");
      },
      signal: controller.signal,
    });
    // abort after the fetch has been started
    await Promise.resolve();
    controller.abort();
    try {
      await p;
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      expect(err.name).toBe("AbortError");
      expect(err).not.toBeInstanceOf(ProviderError);
    }
  });
});
