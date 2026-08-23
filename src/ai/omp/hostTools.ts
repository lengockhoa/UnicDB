// src/ai/omp/hostTools.ts — TASK-002
// Bridge: DbToolRegistry (cycle K) → omp host-tool wire format.
//
//   - hostToolDefsFromRegistry: produce the `tools` payload array for omp's
//     `set_host_tools` RPC. We pass through exactly {name, description,
//     parameters} from each AgentTool — the shape omp consumes.
//
//   - createHostToolExecutor: turn a registry into a (name, args) → Promise<string>
//     executor that omp's `host_tool_call` handler can invoke. Mirrors the
//     agent loop's error policy in src/ai/agent.ts (unknown tool, invalid args,
//     thrown execute) so the user-visible error strings are lockstep. The
//     executor never throws — it always resolves with a string.
//
// Bridge does NOT touch the tool implementations, so the read-only guard
// inside run_sql remains the only chokepoint preventing DML/DDL on the host.
// NO vscode import.

import type { ToolRegistry } from "../agent";

/** Wire-format tool definition for omp's `set_host_tools` RPC. */
export function hostToolDefsFromRegistry(
  registry: ToolRegistry,
): Record<string, unknown>[] {
  return registry.list().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Resolve whether `value` is a plain record-shaped object suitable as tool args.
 * Accepts objects and arrays; rejects primitives, null, and undefined so the
 * bridge surfaces "Invalid tool arguments" instead of silently dropping input.
 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build a host-tool executor bound to `registry`. Returns a function that
 * omp's `host_tool_call` handler invokes with `(name, args)` from the
 * incoming JSONL frame. Always resolves with a string — never throws.
 *
 *   unknown tool        → "Unknown tool: <name>"
 *   args not object     → "Invalid tool arguments"
 *   tool throws         → "Tool failed: <msg>"
 *   tool returns string → returned as-is
 */
export function createHostToolExecutor(
  registry: ToolRegistry,
): (name: string, args: unknown) => Promise<string> {
  return async (name: string, args: unknown): Promise<string> => {
    const tool = registry.get(name);
    if (!tool) return `Unknown tool: ${name}`;

    if (!isRecordLike(args)) return "Invalid tool arguments";

    try {
      return await tool.execute(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Tool failed: ${msg}`;
    }
  };
}