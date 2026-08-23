// src/ai/agent.ts — TASK-003
// Pure multi-turn agent loop over the provider. NO vscode import, NO fetch, NO registry
// implementation. All I/O is injected via AgentDeps + ToolRegistry so unit tests are
// deterministic. Spec: docs/AI_HANDOFF/tasks/TASK-003.md §Spec (frozen).

import type { AiConfig, AiModelRole } from "./settings";
import type { ChatMessage, ChatContentPart, ProviderRequest, ProviderResult, ToolCall, ToolDef } from "./provider";

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
}

// ---- internal helpers -------------------------------------------------------

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
): Promise<ChatMessage> {
  const tool = registry?.get(call.name);
  if (!tool) {
    return toolErrorMessage(call.id, `Unknown tool: ${call.name}`);
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.argumentsJson) as Record<string, unknown>;
  } catch {
    return toolErrorMessage(call.id, "Invalid tool arguments");
  }

  try {
    const out = await tool.execute(args);
    return { role: "tool", toolCallId: call.id, content: out };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (onError) {
      try {
        onError(err);
      } catch {
        // onError must never throw — swallow.
      }
    }
    return toolErrorMessage(call.id, `Tool failed: ${err.message}`);
  }
}

export async function runAgent(
  input: AgentInput,
  deps: AgentDeps,
  callbacks?: AgentCallbacks,
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
    const result = await deps.complete(cfg, role, req);

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
      const toolMsg = await executeToolCall(call, input.tools, callbacks?.onError);
      history.push(toolMsg);
      stepMessages.push(toolMsg);
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
