// src/ai/agent.ts — TASK-003
// Pure multi-turn agent loop over the provider. NO vscode import, NO fetch, NO registry
// implementation. All I/O is injected via AgentDeps + ToolRegistry so unit tests are
// deterministic. Spec: docs/AI_HANDOFF/tasks/TASK-003.md §Spec (frozen).

import type { AiConfig, AiModelRole } from "./settings";
import {
  ProviderError,
  type ChatMessage,
  type ChatContentPart,
  type ProviderRequest,
  type ProviderResult,
  type ToolCall,
  type ToolDef,
} from "./provider";
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for parameters object — passthrough to provider ToolDef.parameters. */
  parameters: Record<string, unknown>;
  /** Pure-ish async execute — registry owns error policy. */
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ToolRegistry {
  list(): AgentTool[];
  get(name: string): AgentTool | undefined;
}

export const EMPTY_TOOL_REGISTRY: ToolRegistry = {
  list: () => [],
  get: () => undefined,
};

export interface AgentInput {
  /** Initial messages (system + user). Images go here as image_url content parts. */
  messages: ChatMessage[];
  /** Model role for this run (default "work" when omitted). */
  role?: AiModelRole;
  tools?: ToolRegistry;
  /** Overrides cfg.maxSteps when provided (still clamped ≥1). */
  maxSteps?: number;
}

export interface AgentDeps {
  loadConfig(): Promise<AiConfig | null>;
  complete(cfg: AiConfig, role: AiModelRole, req: ProviderRequest): Promise<ProviderResult>;
  /**
   * Optional streaming path. When provided AND cfg.method === "chat/completions",
   * runAgent uses streamComplete per step instead of complete(), emitting
   * `callbacks.onText` per delta. See docs/AI_HANDOFF/tasks/TASK-002.md §Interfaces.
   */
  streamComplete?(
    cfg: AiConfig,
    role: AiModelRole,
    req: ProviderRequest,
    onText: (ev: { text: string }) => void,
    signal?: AbortSignal,
  ): Promise<ProviderResult>;
}

export interface AgentStep {
  /** Messages appended this step: assistant reply, then tool results (if any). */
  messages: ChatMessage[];
  result: ProviderResult;
}

export interface AgentRunResult {
  steps: AgentStep[];
  /** Message list AFTER the run — replayable as next run's input. */
  history: ChatMessage[];
  /** Text of the LAST assistant message with no tool calls ("" if budget-capped with none). */
  finalText: string;
  /** True iff hit maxSteps before a no-tool-call reply. */
  stoppedOnBudget: boolean;
}

export interface AgentCallbacks {
  onStep?(step: AgentStep): void;
  onError?(error: Error): void;
  /** Fires once per text-delta, only when streaming path is active and the
   * step's result has no tool_calls. Not invoked on the fallback non-stream
   * response. See TASK-002 §Interfaces. */
  onText?(text: string): void;
  /** Fires exactly once, immediately before deps.complete is invoked on the
   * fallback path (stream pre-emit failure). Skipped when the abort rule
   * rethrows first. */
  onStreamFallback?(): void;
  /** Fires exactly once per tool call, in call order, immediately before
   * executeToolCall. Invoked on steps that produced tool calls only.
   * Fires regardless of abort state — abort gating is the consumer's job
   * (e.g. panel token gate). See docs/AI_HANDOFF/tasks/TASK-002.md. */
  onToolCall?(call: ToolCall): void;
  /** AIX-03: fires once per executed tool call, in order, AFTER
   * executeToolCall resolves. status "ok" for any non-throwing execute,
   * "failed" when execute threw (resultText carries the error message). */
  onToolResult?(call: ToolCall, outcome: ToolOutcome): void;
}

/** AIX-03 — outcome of one executed tool call (shape-only for panels). */
export interface ToolOutcome {
  status: "ok" | "failed";
  resultText: string;
}

/** Build a tool error result message. Used in three error paths → lockstep shape. */
function toolErrorMessage(id: string, error: string): ChatMessage {
  return {
    role: "tool",
    toolCallId: id,
    content: JSON.stringify({ error }),
  };
}

/**
 * Execute a single tool call through the registry with the spec's error policy:
 * missing tool → "Unknown tool: …"; bad JSON → "Invalid tool arguments";
 * thrown execute → "Tool failed: <msg>" (onError fires for swallowed throws).
 */
async function executeToolCall(
  call: ToolCall,
  registry: ToolRegistry | undefined,
  onError?: (e: Error) => void,
): Promise<ChatMessage & { outcome: ToolOutcome }> {
  const tool = registry?.get(call.name);
  if (!tool) {
    const errorText = `Unknown tool: ${call.name}`;
    return {
      ...toolErrorMessage(call.id, errorText),
      outcome: { status: "failed", resultText: errorText },
    };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.argumentsJson) as Record<string, unknown>;
  } catch {
    return {
      ...toolErrorMessage(call.id, "Invalid tool arguments"),
      outcome: { status: "failed", resultText: "Invalid tool arguments" },
    };
  }

  try {
    const out = await tool.execute(args);
    return {
      role: "tool",
      toolCallId: call.id,
      content: out,
      outcome: { status: "ok", resultText: out },
    };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (onError) {
      try {
        onError(err);
      } catch {
        // onError must never throw — swallow.
      }
    }
    const failedText = `Tool failed: ${err.message}`;
    return {
      ...toolErrorMessage(call.id, failedText),
      outcome: { status: "failed", resultText: failedText },
    };
  }
}

/**
 * Execute one provider step with the stream path when available. Frozen rule:
 *   1. AbortError / signal.aborted → rethrow bare (no fallback, no
 *      onStreamFallback). User stop must NEVER trigger a re-request.
 *   2. ProviderError with emitted === 0 → onStreamFallback once, then fall
 *      back to deps.complete(req). Step is committed with the fallback
 *      result; no onText fired.
 *   3. Otherwise (emitted > 0, or non-ProviderError) → rethrow.
 */
async function runStep(
  req: ProviderRequest,
  deps: AgentDeps,
  callbacks: AgentCallbacks | undefined,
  signal: AbortSignal | undefined,
  cfg: AiConfig,
  role: AiModelRole,
): Promise<ProviderResult> {
  if (!deps.streamComplete || cfg.method !== "chat/completions") {
    return deps.complete(cfg, role, req);
  }

  // Stream path: wrap the user's onText to count deltas for the fallback rule.
  // The wrapped function preserves caller identity and never throws onward
  // (caller's onText may throw — we swallow per the provider's streamComplete
  // contract, where streamComplete itself owns error reporting).
  let emitted = 0;
  const userOnText = callbacks?.onText;
  const wrappedOnText = (ev: { text: string }): void => {
    emitted++;
    try {
      userOnText?.(ev.text);
    } catch {
      // user's onText must never break the stream path.
    }
  };

  try {
    return await deps.streamComplete(cfg, role, req, wrappedOnText, signal);
  } catch (err) {
    // Rule 1: abort — never fallback. Either name === "AbortError" OR the
    // caller's signal reports aborted (per frozen spec).
    const aborted = (err instanceof Error && err.name === "AbortError") || signal?.aborted === true;
    if (aborted) {
      throw err;
    }
    // Rule 2: ProviderError with zero text emitted → fallback to non-stream.
    if (err instanceof ProviderError && emitted === 0) {
      callbacks?.onStreamFallback?.();
      return deps.complete(cfg, role, req);
    }
    // Rule 3: mid-stream failure (emitted > 0) or non-ProviderError → rethrow.
    throw err;
  }
}

export async function runAgent(
  input: AgentInput,
  deps: AgentDeps,
  callbacks?: AgentCallbacks,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  const role: AiModelRole = input.role ?? "work";

  // 1. Fresh config snapshot per run — exactly one loadConfig call.
  const cfg = await deps.loadConfig();
  if (!cfg) {
    throw new Error("AI is not configured");
  }

  // 2. Vision guard BEFORE any provider call.
  const hasImage = input.messages.some((m) =>
    Array.isArray(m.content) && (m.content as ChatContentPart[]).some((p) => p.type === "image_url"),
  );
  if (hasImage && cfg.models[role].vision !== true) {
    throw new Error(`Role "${role}" does not support vision`);
  }

  // 3. Step loop budget.
  const maxSteps = Math.max(1, input.maxSteps ?? cfg.maxSteps);

  // 4. Initial history snapshot (mutable copy).
  const history: ChatMessage[] = input.messages.map((m) => ({ ...m }));
  const steps: AgentStep[] = [];

  const toolDefs: ToolDef[] = (input.tools?.list() ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  let lastAssistantNoToolText = "";

  for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    const req: ProviderRequest = {
      modelId: cfg.models[role].modelId,
      messages: history.map((m) => ({ ...m })),
      tools: toolDefs,
    };
    const result = await runStep(req, deps, callbacks, signal, cfg, role);
    const hasToolCalls = result.toolCalls.length > 0;
    const assistantMsg: ChatMessage = hasToolCalls
      ? { role: "assistant", content: "", toolCalls: result.toolCalls }
      : { role: "assistant", content: result.text };
    history.push(assistantMsg);

    const stepMessages: ChatMessage[] = [assistantMsg];

    if (!hasToolCalls) {
      steps.push({ messages: stepMessages, result });
      lastAssistantNoToolText = result.text;
      if (callbacks?.onStep) {
        callbacks.onStep({ messages: [...stepMessages], result });
      }
      return {
        steps,
        history,
        finalText: result.text,
        stoppedOnBudget: false,
      };
    }

    for (const call of result.toolCalls) {
      callbacks?.onToolCall?.(call);
      const toolMsg = await executeToolCall(call, input.tools, callbacks?.onError);
      const { outcome, ...chatMsg } = toolMsg;
      history.push(chatMsg);
      stepMessages.push(chatMsg);
      callbacks?.onToolResult?.(call, outcome);
    }

    steps.push({ messages: stepMessages, result });
    if (callbacks?.onStep) {
      callbacks.onStep({ messages: [...stepMessages], result });
    }
  }

  // Budget exhausted with pending tool results.
  return {
    steps,
    history,
    finalText: lastAssistantNoToolText,
    stoppedOnBudget: true,
  };
}
