// src/ai/tools/types.ts — TASK-001/TASK-002 shared frozen types.
// Single home for AdapterFactory so wave-1 executors (registry.ts / sqlTool.ts)
// never edit each other's files. NO vscode import.

import type { DbAdapter } from "../../adapters/types";

/**
 * Async on purpose: ConnectionManager.getAdapter() is async-lazy and the active
 * adapter can be closed/null between chat turns — tools resolve it per call,
 * never hold a reference. null = no active connection.
 */
export type AdapterFactory = () => Promise<DbAdapter | null>;
