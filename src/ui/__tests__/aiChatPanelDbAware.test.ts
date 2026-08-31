// src/ui/__tests__/aiChatPanelDbAware.test.ts — cycle AD TASK-001 TDD
// Host permission gate for the DB-aware tools (acceptance criteria 7 + 12)
// plus the cycle-AA DDL-only regression with the new tools in the registry.

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: (...parts: unknown[]) => ({
      toString: () => parts.map((p) => String(p)).join("/"),
    }),
  },
  window: { createWebviewPanel: vi.fn() },
  ViewColumn: { Active: 1 },
  workspace: { workspaceFolders: undefined },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
}));

import { describe, it, expect, vi } from "vitest";
import {
  DbToolPermissionGate,
  DB_TOOL_DENIED_MESSAGE,
  buildMessages,
  toolShapeSummary,
  summarizeToolOutcomeCard,
} from "../aiChatPanel";
import { createDbAwareTools } from "../../ai/tools/dbAwareTools";
import type { AgentTool } from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";
import type { DbAdapter } from "../../adapters/types";

function fakeTool(name = "run_readonly_query"): {
  tool: AgentTool;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    tool: {
      name,
      description: "d",
      parameters: { type: "object", properties: {} },
      execute: async (args: Record<string, unknown>) => {
        calls.push(args);
        return "TOOL-RAN";
      },
    },
  };
}

describe("DbToolPermissionGate", () => {
  it("posts a permission_request card on invocation", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe("permission_request");
    expect(posted[0].tool.name).toBe("run_readonly_query");
    expect(posted[0].options.map((o: any) => o.optionId)).toEqual([
      "allow-once",
      "allow-session",
      "deny",
    ]);
    gate.respond(posted[0].requestId, "deny");
    await p;
  });

  it("Allow once runs the tool and returns its result", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    expect(await p).toBe("TOOL-RAN");
    expect(calls).toHaveLength(1);
  });

  it("Allow once does NOT persist — the next call re-asks", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const wrapped = gate.wrap(tool);
    const p1 = wrapped.execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    await p1;
    const p2 = wrapped.execute({});
    await Promise.resolve();
    expect(posted).toHaveLength(2);
    gate.respond(posted[1].requestId, "deny");
    await p2;
  });

  it("Allow session skips the card for later calls of the same tool", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const wrapped = gate.wrap(tool);
    const p1 = wrapped.execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-session");
    await p1;
    expect(await wrapped.execute({})).toBe("TOOL-RAN");
    expect(posted).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("AIX-03: deny also posts a visible tool_result card", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    gate.respond(posted[0].requestId, "deny");
    const res = await p;
    expect(res).toBe(DB_TOOL_DENIED_MESSAGE);
    expect(calls).toHaveLength(0);
    const card = posted.find((m) => m.type === "tool_result");
    expect(card).toBeDefined();
    expect(card.tool).toBe("run_readonly_query");
    expect(card.status).toBe("denied");
    expect(card.summary).toContain("denied");
  });

  it("AIX-03: toolShapeSummary never leaks serialized sample row bytes", () => {
    const leaked = JSON.stringify({
      schema: { columns: [{ name: "email", type: "text" }] },
      count: 42,
      sample: "id | email\n---\n1 | secret@corp.example\n(1 of 3 rows)",
      relationships: [],
    });
    const card = toolShapeSummary(leaked);
    expect(card).not.toContain("secret@corp.example");
    expect(card).not.toContain("email");
    expect(card).toMatch(/JSON report/);
    // Table (multi-line) → line count only.
    expect(toolShapeSummary("id | email\n1 | a@b.c\n2 | d@e.f\n(2 of 9 rows)")).toBe(
      "4 lines (capped)",
    );
    // Opaque one-liner → token-capped.
    expect(toolShapeSummary("ok")).toBe("ok");
  });

  it("AIX-03: summarizeToolOutcomeCard formats tool + status + shape", () => {
    expect(summarizeToolOutcomeCard("count_rows", "ok", "JSON report: 4 fields")).toBe(
      "✓ count_rows — JSON report: 4 fields",
    );
    expect(summarizeToolOutcomeCard("run_readonly_query", "failed", "boom")).toBe(
      "✗ run_readonly_query — failed: boom",
    );
    expect(summarizeToolOutcomeCard("count_rows", "denied", "")).toBe(
      "✗ count_rows — denied by user",
    );
  });

  it("AIX-03: allow posts ok outcome after run via describe/onToolResult flow", async () => {
    // The gate itself doesn't post ok — the agent loop does. Here we just
    // verify allow-only flow posts NO tool_result (card comes from
    // onToolResult in the panel during a real turn).
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({ sql: "SELECT 1" });
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    await p;
    expect(posted.find((m) => m.type === "tool_result")).toBeUndefined();
  });

  it("Deny returns the denial message and never runs the tool", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "deny");
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it("default-denies an unknown optionId", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "hacked-option");
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it("default-denies a missing optionId", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, undefined);
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
  });

  it("default-denies on timeout", async () => {
    vi.useFakeTimers();
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m), { timeoutMs: 1000 });
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    vi.advanceTimersByTime(1001);
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
    vi.useRealTimers();
  });

  it("cancelAll default-denies every outstanding request", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.cancelAll();
    expect(await p).toBe(DB_TOOL_DENIED_MESSAGE);
  });

  it("ignores a duplicate/late response", async () => {
    const posted: any[] = [];
    const gate = new DbToolPermissionGate((m) => posted.push(m));
    const { tool, calls } = fakeTool();
    const p = gate.wrap(tool).execute({});
    await Promise.resolve();
    gate.respond(posted[0].requestId, "allow-once");
    gate.respond(posted[0].requestId, "deny");
    expect(await p).toBe("TOOL-RAN");
    expect(calls).toHaveLength(1);
  });

  it("wraps all five DB-aware tools without changing their names", () => {
    const factory: AdapterFactory = async () => null;
    const gate = new DbToolPermissionGate(() => {});
    const names = createDbAwareTools(factory).map((t) => gate.wrap(t).name);
    expect(names).toEqual([
      "list_table_data_sample",
      "count_rows",
      "run_readonly_query",
      "explain_query",
      "get_table_relationships",
    ]);
  });
});

describe("cycle-AA regression: buildMessages stays DDL-only with DB-aware tools registered", () => {
  it("never calls runQuery and never leaks row bytes", async () => {
    const SENTINEL = "SENTINEL-ROW-DATA-AD";
    const runQuery = vi.fn(async () => ({
      results: [
        { columns: ["c"], rows: [[SENTINEL]], rowCount: 1, durationMs: 1 },
      ],
    }));
    const adapter = {
      runQuery,
      listSchemas: vi.fn(async () => [{ name: "public" }]),
      listTables: vi.fn(async () => [{ schema: "public", name: "users" }]),
      listViews: vi.fn(async () => []),
      listColumns: vi.fn(async () => [
        { name: "id", dataType: "int", nullable: false, isPrimaryKey: true },
      ]),
    } as unknown as DbAdapter;
    const factory: AdapterFactory = async () => adapter;

    // Tools exist in the registry for this turn; context build must ignore them.
    const tools = createDbAwareTools(factory);
    expect(tools).toHaveLength(5);

    const msgs = await buildMessages(factory, [], {
      role: "user",
      content: "hi",
    });
    const blob = JSON.stringify(msgs);
    expect(runQuery).not.toHaveBeenCalled();
    expect(blob).not.toContain(SENTINEL);
    expect(blob).toContain("users");
  });
});
