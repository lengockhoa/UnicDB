// src/ai/tools/registry.ts — TASK-001
// DbToolRegistry: minimal ordered registry implementing the ToolRegistry contract
// from src/ai/agent.ts (frozen). register/list/get, no deduplication.
// createDbTools wires the two introspection tools only — run_sql is TASK-002's
// responsibility, added by its caller via a separate register() call.
// NO vscode import.

import type { AgentTool, ToolRegistry } from "../agent";
import type { AdapterFactory } from "./types";
import { createListTablesTool, createDescribeTableTool } from "./schemaTools";

export class DbToolRegistry implements ToolRegistry {
  private readonly tools: AgentTool[] = [];

  register(tool: AgentTool): void {
    this.tools.push(tool);
  }

  list(): AgentTool[] {
    return [...this.tools];
  }

  get(name: string): AgentTool | undefined {
    return this.tools.find((t) => t.name === name);
  }
}

/**
 * Build a DbToolRegistry pre-loaded with the two introspection tools.
 * Caller extends by calling `register(newRunSqlTool(...))` (TASK-002's job).
 * Returns the registry so callers can keep the reference and add more tools.
 */
export function createDbTools(adapterFactory: AdapterFactory): DbToolRegistry {
  const reg = new DbToolRegistry();
  reg.register(createListTablesTool(adapterFactory));
  reg.register(createDescribeTableTool(adapterFactory));
  return reg;
}
