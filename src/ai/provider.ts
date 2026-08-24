// src/ai/provider.ts — OpenAI-compatible provider client (TASK-002).
// Pure thin fetch client. No vscode import. No src/ai/* import.
// Spec: docs/AI_HANDOFF/tasks/TASK-002.md §Spec (frozen contract).

// ---- types -----------------------------------------------------------------
export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

export interface ChatContentPart {
  type: "text" | "image_url";
  text?: string;
  imageUrl?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  modelId: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ProviderResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "other";
  usage: { inputTokens: number; outputTokens: number };
}

export class ProviderError extends Error {
  status?: number;
  timeout: boolean;
  endpoint: string;
  bodySnippet: string;
  constructor(
    message: string,
    init: {
      status?: number;
      timeout: boolean;
      endpoint: string;
      bodySnippet: string;
    },
  ) {
    super(message);
    this.name = "ProviderError";
    this.status = init.status;
    this.timeout = init.timeout;
    this.endpoint = init.endpoint;
    this.bodySnippet = init.bodySnippet;
  }
}

export interface ProviderOptions {
  baseUrl: string;
  apiKey: string;
  method: "responses" | "chat/completions";
  timeoutMs?: number;
  fetch?: FetchLike;
}

// ---- TASK-001: streaming types -------------------------------------------
export interface StreamTextEvent {
  text: string;
}

export interface StreamRequestOptions {
  onText(ev: StreamTextEvent): void;
  signal?: AbortSignal;
}
// ---- helpers ---------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 60_000;
const SNIPPET_MAX = 300;

function scrubApiKey(s: string, apiKey: string): string {
  if (!apiKey) return s.slice(0, SNIPPET_MAX);
  // Replace all occurrences; if apiKey contains regex specials, escape them.
  const escaped = apiKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const masked = s.replace(new RegExp(escaped, "g"), "***");
  return masked.slice(0, SNIPPET_MAX);
}

function buildUrl(baseUrl: string, method: "responses" | "chat/completions"): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const path = method === "responses" ? "responses" : "chat/completions";
  return `${trimmed}/${path}`;
}

async function readSnippet(resp: Response, apiKey: string): Promise<string> {
  try {
    const text = await resp.text();
    return scrubApiKey(text, apiKey);
  } catch {
    return "";
  }
}

// ---- chat/completions body builder ----------------------------------------
function mapChatContent(part: ChatContentPart): Record<string, unknown> {
  if (part.type === "text") {
    return { type: "text", text: part.text ?? "" };
  }
  return { type: "image_url", image_url: { url: part.imageUrl ?? "" } };
}

function mapChatMessageForBody(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId ?? "",
      content: typeof m.content === "string" ? m.content : "",
    };
  }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    const content = typeof m.content === "string" ? m.content : "";
    return {
      role: "assistant",
      content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.argumentsJson },
      })),
    };
  }
  if (Array.isArray(m.content)) {
    return { role: m.role, content: m.content.map(mapChatContent) };
  }
  return { role: m.role, content: m.content };
}

export function buildChatCompletionsBody(req: ProviderRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.modelId,
    messages: req.messages.map(mapChatMessageForBody),
  };
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.maxOutputTokens !== undefined) body.max_tokens = req.maxOutputTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

// ---- chat/completions parser ----------------------------------------------
function mapFinishReason(reason: unknown): "stop" | "tool_calls" | "length" | "other" {
  if (reason === "stop" || reason === "tool_calls" || reason === "length") return reason;
  return "other";
}

export function parseChatCompletionsResponse(json: unknown): ProviderResult {
  const j = json as {
    choices?: Array<{
      finish_reason?: unknown;
      message?: {
        content?: unknown;
        tool_calls?: Array<{
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = j.choices?.[0];
  const message = choice?.message;
  const text =
    typeof message?.content === "string"
      ? message.content
      : message?.content == null
        ? ""
        : "";
  const toolCalls: ToolCall[] = Array.isArray(message?.tool_calls)
    ? (message!.tool_calls!.map((tc) => ({
        id: typeof tc.id === "string" ? tc.id : "",
        name: typeof tc.function?.name === "string" ? tc.function.name : "",
        argumentsJson: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
      })) as ToolCall[])
    : [];
  const finishReason = mapFinishReason(choice?.finish_reason);
  const usage = {
    inputTokens: typeof j.usage?.prompt_tokens === "number" ? (j.usage!.prompt_tokens as number) : 0,
    outputTokens:
      typeof j.usage?.completion_tokens === "number" ? (j.usage!.completion_tokens as number) : 0,
  };
  return { text, toolCalls, finishReason, usage };
}

// ---- responses body builder -----------------------------------------------
function mapResponsesInputItem(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    const content = typeof m.content === "string" ? m.content : "";
    return { type: "function_call_output", call_id: m.toolCallId ?? "", output: content };
  }
  if (m.role === "assistant") {
    const text = typeof m.content === "string" ? m.content : "";
    const contentParts: Array<Record<string, unknown>> = [];
    if (text.length > 0) {
      contentParts.push({ type: "output_text", text });
    }
    return { role: "assistant", content: contentParts };
  }
  // user
  if (Array.isArray(m.content)) {
    const parts: Array<Record<string, unknown>> = m.content.map((p) => {
      if (p.type === "text") return { type: "input_text", text: p.text ?? "" };
      return { type: "input_image", image_url: p.imageUrl ?? "" };
    });
    return { role: "user", content: parts };
  }
  return {
    role: "user",
    content: [{ type: "input_text", text: typeof m.content === "string" ? m.content : "" }],
  };
}

export function buildResponsesBody(req: ProviderRequest): Record<string, unknown> {
  const systemMessages = req.messages.filter((m) => m.role === "system");
  const instructions = systemMessages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter((s) => s.length > 0)
    .join("\n");
  const input = req.messages.filter((m) => m.role !== "system").map(mapResponsesInputItem);

  const body: Record<string, unknown> = { model: req.modelId, input };
  if (instructions.length > 0) body.instructions = instructions;
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      strict: false,
      parameters: t.parameters,
    }));
  }
  if (req.maxOutputTokens !== undefined) body.max_output_tokens = req.maxOutputTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

// ---- responses parser -----------------------------------------------------
export function parseResponsesResponse(json: unknown): ProviderResult {
  const j = json as {
    output_text?: unknown;
    output?: Array<{
      type?: unknown;
      call_id?: unknown;
      name?: unknown;
      arguments?: unknown;
      content?: Array<{ type?: unknown; text?: unknown }>;
    }>;
    status?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };

  let text = "";
  if (typeof j.output_text === "string") {
    text = j.output_text;
  } else if (Array.isArray(j.output)) {
    for (const item of j.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && c.type === "output_text" && typeof c.text === "string") {
            text += c.text;
          }
        }
      }
    }
  }

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(j.output)) {
    for (const item of j.output) {
      if (item && item.type === "function_call") {
        toolCalls.push({
          id: typeof item.call_id === "string" ? item.call_id : "",
          name: typeof item.name === "string" ? item.name : "",
          argumentsJson: typeof item.arguments === "string" ? item.arguments : "",
        });
      }
    }
  }

  let finishReason: "stop" | "tool_calls" | "length" | "other";
  if (j.status === "completed") {
    finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  } else if (j.status === "incomplete") {
    finishReason = "length";
  } else {
    finishReason = "other";
  }

  const usage = {
    inputTokens: typeof j.usage?.input_tokens === "number" ? (j.usage!.input_tokens as number) : 0,
    outputTokens:
      typeof j.usage?.output_tokens === "number" ? (j.usage!.output_tokens as number) : 0,
  };

  return { text, toolCalls, finishReason, usage };
}

// ---- factory --------------------------------------------------------------
export function createProviderClient(opts: ProviderOptions): {
  complete(req: ProviderRequest): Promise<ProviderResult>;
  streamComplete(req: ProviderRequest, opts: StreamRequestOptions): Promise<ProviderResult>;
} {
  const baseUrl = opts.baseUrl;
  const apiKey = opts.apiKey;
  const method = opts.method;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl: FetchLike = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);

  return {
    async complete(req: ProviderRequest): Promise<ProviderResult> {
      const url = buildUrl(baseUrl, method);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let body: Record<string, unknown>;
      try {
        body =
          method === "responses" ? buildResponsesBody(req) : buildChatCompletionsBody(req);
      } catch (e) {
        clearTimeout(timer);
        throw new ProviderError(`invalid request: ${(e as Error).message}`, {
          timeout: false,
          endpoint: url,
          bodySnippet: "",
        });
      }

      let resp: Response;
      try {
        resp = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const err = e as Error & { name?: string };
        if (err.name === "AbortError") {
          throw new ProviderError(`request timed out after ${timeoutMs}ms`, {
            timeout: true,
            endpoint: url,
            bodySnippet: "",
          });
        }
        throw new ProviderError(`network error: ${err.message}`, {
          timeout: false,
          endpoint: url,
          bodySnippet: "",
        });
      }
      clearTimeout(timer);

      if (!resp.ok) {
        const snippet = await readSnippet(resp, apiKey);
        throw new ProviderError(
          `${resp.status} ${resp.statusText} — ${snippet}`,
          { status: resp.status, timeout: false, endpoint: url, bodySnippet: snippet },
        );
      }

      const raw = await resp.text();
      const snippet = scrubApiKey(raw, apiKey);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new ProviderError("invalid JSON in response", {
          timeout: false,
          endpoint: url,
          bodySnippet: snippet,
        });
      }

      try {
        return method === "responses"
          ? parseResponsesResponse(parsed)
          : parseChatCompletionsResponse(parsed);
      } catch (e) {
        throw new ProviderError(`invalid response shape: ${(e as Error).message}`, {
          timeout: false,
          endpoint: url,
          bodySnippet: snippet,
        });
      }
    },

    async streamComplete(
      req: ProviderRequest,
      streamOpts: StreamRequestOptions,
    ): Promise<ProviderResult> {
      if (method === "responses") {
        throw new Error("streaming not supported for method responses");
      }
      const url = buildUrl(baseUrl, method);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // If caller supplied a signal, forward aborts.
      if (streamOpts.signal) {
        if (streamOpts.signal.aborted) {
          controller.abort();
        } else {
          streamOpts.signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        }
      }
      let body: Record<string, unknown>;
      try {
        body = buildChatCompletionsBody(req);
      } catch (e) {
        clearTimeout(timer);
        throw new ProviderError(`invalid request: ${(e as Error).message}`, {
          timeout: false,
          endpoint: url,
          bodySnippet: "",
        });
      }
      // stream:true; no stream_options, no include_usage.
      const wireBody = { ...body, stream: true };

      let resp: Response;
      try {
        resp = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(wireBody),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        const err = e as Error & { name?: string };
        if (err.name === "AbortError") {
          // Distinguish caller-level abort from our internal timeout.
          // Frozen contract: caller abort must surface bare (name "AbortError", NOT ProviderError).
          if (streamOpts.signal?.aborted) {
            // Surface the original error so its name stays "AbortError" and it
            // is NOT an instance of ProviderError. If `e` is not an Error, wrap minimally.
            if (e instanceof Error) throw e;
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          throw new ProviderError(`request timed out after ${timeoutMs}ms`, {
            timeout: true,
            endpoint: url,
            bodySnippet: "",
          });
        }
        throw new ProviderError(`network error: ${err.message}`, {
          timeout: false,
          endpoint: url,
          bodySnippet: "",
        });
      }
      clearTimeout(timer);

      if (!resp.ok) {
        const snippet = await readSnippet(resp, apiKey);
        throw new ProviderError(
          `${resp.status} ${resp.statusText} — ${snippet}`,
          { status: resp.status, timeout: false, endpoint: url, bodySnippet: snippet },
        );
      }

      // Must be text/event-stream.
      const ctype = resp.headers.get("content-type") ?? "";
      if (!ctype.toLowerCase().includes("text/event-stream")) {
        // Read a snippet to put in error and surface API key scrubbing.
        const snippet = await readSnippet(resp, apiKey);
        throw new ProviderError("invalid SSE/stream shape: unexpected content-type", {
          timeout: false,
          endpoint: url,
          bodySnippet: snippet,
        });
      }

      // Stream + parse SSE. Hand-written, dependency-free, incremental.
      const reader = resp.body?.getReader();
      if (!reader) {
        throw new ProviderError("invalid SSE/stream shape: empty body", {
          timeout: false,
          endpoint: url,
          bodySnippet: "",
        });
      }
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let buffer = "";
      let accText = "";
      let finishReason: "stop" | "tool_calls" | "length" | "other" = "other";
      let inputTokens = 0;
      let outputTokens = 0;
      let sawAnyEvent = false;

      while (true) {
        let read: { done: boolean; value?: Uint8Array };
        try {
          read = await reader.read();
        } catch (e) {
          // Distinguish caller-level abort from our internal timeout (same rule as fetch-phase catch).
          const err = e as Error & { name?: string };
          if (err.name === "AbortError") {
            if (streamOpts.signal?.aborted) {
              if (e instanceof Error) throw e;
              throw Object.assign(new Error("aborted"), { name: "AbortError" });
            }
            throw new ProviderError(`request timed out after ${timeoutMs}ms`, {
              timeout: true,
              endpoint: url,
              bodySnippet: "",
            });
          }
          throw new ProviderError(`stream read error: ${err.message}`, {
            timeout: false,
            endpoint: url,
            bodySnippet: "",
          });
        }
        if (read.done) break;
        if (read.value) {
          buffer += decoder.decode(read.value, { stream: true });
        }
        // Split on event boundaries. SSE spec: "line terminators" can be CR, LF, or CRLF,
        // so servers are free to use \n\n or \r\n\r\n (and even mixed). Find the earliest
        // of either delimiter and slice by the matched length.
        const idx = (): { i: number; len: number } => {
          const a = buffer.indexOf("\r\n\r\n");
          const b = buffer.indexOf("\n\n");
          if (a === -1 && b === -1) return { i: -1, len: 0 };
          if (a === -1) return { i: b, len: 2 };
          if (b === -1) return { i: a, len: 4 };
          return a < b ? { i: a, len: 4 } : { i: b, len: 2 };
        };
        let found = idx();
        while (found.i !== -1) {
          const rawEvent = buffer.slice(0, found.i);
          buffer = buffer.slice(found.i + found.len);
          // Trim trailing \r from each line (some servers use CRLF line endings).
          const lines = rawEvent.split(/\r?\n/);
          const dataLines: string[] = [];
          for (const ln of lines) {
            if (ln.startsWith("data:")) {
              // After "data:" may be a single leading space.
              dataLines.push(ln.slice(5).replace(/^ /, ""));
            }
          }
          if (dataLines.length === 0) {
            found = idx();
            continue;
          }
          const payload = dataLines.join("\n");
          if (payload === "[DONE]") {
            found = idx();
            continue;
          }
          sawAnyEvent = true;
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload);
          } catch {
            // skip malformed event
            found = idx();
            continue;
          }
          const j = parsed as {
            choices?: Array<{
              finish_reason?: unknown;
              delta?: { content?: unknown };
            }>;
            usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
          };
          if (Array.isArray(j.choices) && j.choices.length > 0) {
            for (const choice of j.choices) {
              const content = choice.delta?.content;
              if (typeof content === "string" && content.length > 0) {
                accText += content;
                streamOpts.onText({ text: content });
              }
              if (typeof choice.finish_reason === "string") {
                finishReason = mapFinishReason(choice.finish_reason);
              }
            }
          }
          if (j.usage) {
            if (typeof j.usage.prompt_tokens === "number") inputTokens = j.usage.prompt_tokens;
            if (typeof j.usage.completion_tokens === "number")
              outputTokens = j.usage.completion_tokens;
          }
          found = idx();
        }
      }
      // Flush decoder for any trailing bytes.
      buffer += decoder.decode();
      // If the server sent a final event without \n\n terminator (rare), still try.
      if (buffer.trim().length > 0) {
        const lines = buffer.split(/\r?\n/);
        const dataLines: string[] = [];
        for (const ln of lines) {
          if (ln.startsWith("data:")) {
            dataLines.push(ln.slice(5).replace(/^ /, ""));
          }
        }
        if (dataLines.length > 0) {
          const payload = dataLines.join("\n");
          if (payload !== "[DONE]") {
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{
                  finish_reason?: unknown;
                  delta?: { content?: unknown };
                }>;
                usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
              };
              sawAnyEvent = true;
              if (Array.isArray(parsed.choices)) {
                for (const choice of parsed.choices) {
                  const content = choice.delta?.content;
                  if (typeof content === "string" && content.length > 0) {
                    accText += content;
                    streamOpts.onText({ text: content });
                  }
                  if (typeof choice.finish_reason === "string") {
                    finishReason = mapFinishReason(choice.finish_reason);
                  }
                }
              }
              if (parsed.usage) {
                if (typeof parsed.usage.prompt_tokens === "number")
                  inputTokens = parsed.usage.prompt_tokens;
                if (typeof parsed.usage.completion_tokens === "number")
                  outputTokens = parsed.usage.completion_tokens;
              }
            } catch {
              // ignore trailing garbage
            }
          }
        }
      }

      if (!sawAnyEvent && accText.length === 0) {
        throw new ProviderError("invalid SSE/stream shape: no events parsed", {
          timeout: false,
          endpoint: url,
          bodySnippet: "",
        });
      }
      if (finishReason === "other") {
        // Default to "stop" if we got text but no explicit finish reason.
        finishReason = "stop";
      }
      return {
        text: accText,
        toolCalls: [],
        finishReason,
        usage: { inputTokens, outputTokens },
      };
    },
  };
}