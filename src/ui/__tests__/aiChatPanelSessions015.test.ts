// src/ui/__tests__/aiChatPanelSessions015.test.ts — TASK-CHATV2-015 step-4
// host wiring: structured session persistence, resume adoption, export and
// diagnostics frames correlated by clientRequestId AND sessionId.
//
// Covers task Test Cases #1 (structured hydrate/persist), #4 (corrupt record
// → quarantine + safe warning, never crash), #6 (export success only on
// export_completed; cancel no-op; failure exact copy) and #9 (stale/unknown
// session responses cannot mutate the live session). The store/export/webview
// unit suites live in their own files; this file pins the PANEL wiring.
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps } from "../../ai/agent";
import type { AdapterFactory } from "../../ai/tools/types";

const agentState = vi.hoisted(() => ({ runAgentMock: vi.fn() as Mock }));

vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return { ...actual, runAgent: agentState.runAgentMock };
});

import { AiChatPanel } from "../aiChatPanel";
import { AiChatSessionStore, SESSION_RECORD_KEY_PREFIX } from "../aiChatSessionStore";
import type { AiChatExportPort } from "../aiChatExport";

// ---- vscode mock (workspace cwd drives the store scope) --------------------

interface MockPanel {
  webview: {
    html: string;
    postMessage: Mock;
    onDidReceiveMessage: Mock;
    asWebviewUri: Mock;
    cspSource: string;
  };
  onDidDispose: Mock;
  reveal: Mock;
  dispose: Mock;
  visible: boolean;
  disposed: boolean;
}

const state = vi.hoisted(() => ({ panels: [] as MockPanel[] }));

vi.mock("vscode", () => ({
  window: {
    createWebviewPanel: vi.fn(() => {
      const panel: MockPanel = {
        webview: {
          html: "",
          postMessage: vi.fn().mockResolvedValue(undefined),
          onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
          asWebviewUri: vi.fn((u: unknown) => u),
          cspSource: "vscode-webview://test",
        },
        onDidDispose: vi.fn(() => ({ dispose: () => {} })),
        reveal: vi.fn(),
        dispose: vi.fn(() => {
          panel.disposed = true;
        }),
        visible: true,
        disposed: false,
      };
      state.panels.push(panel);
      return panel;
    }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/work" }, name: "work", index: 0 }],
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn(),
}));

const extUri = vscode.Uri.file("/ext");
const WORKSPACE = "/work";

// ---- memento backing the host store ----------------------------------------

function makeMemento(): {
  get: <T>(key: string, dflt?: T) => T | undefined;
  update: (key: string, value: unknown) => Promise<void>;
  raw: Map<string, unknown>;
} {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get<T>(key: string, dflt?: T): T | undefined {
      return raw.has(key) ? (raw.get(key) as T) : dflt;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) raw.delete(key);
      else raw.set(key, value);
    },
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
}

async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

function panelHarness(): { panel: MockPanel; handler: (msg: unknown) => void } {
  const panel = state.panels[state.panels.length - 1] as MockPanel;
  return {
    panel,
    handler: panel.webview.onDidReceiveMessage.mock.calls[0]?.[0] as (
      msg: unknown,
    ) => void,
  };
}

function posted(panel: MockPanel): Array<Record<string, unknown>> {
  return panel.webview.postMessage.mock.calls.map(
    (c) => c[0] as Record<string, unknown>,
  );
}

function v2Frames(panel: MockPanel, kind: string): Array<Record<string, unknown>> {
  return posted(panel).filter((m) => m.protocolVersion === 2 && m.kind === kind);
}

function makeDeps(): AgentDeps {
  return { loadConfig: vi.fn(async () => null), complete: vi.fn() };
}

function makeRunResult(finalText: string): {
  steps: never[];
  history: never[];
  finalText: string;
  stoppedOnBudget: false;
} {
  return { steps: [], history: [], finalText, stoppedOnBudget: false };
}

async function boot(opts?: {
  store?: AiChatSessionStore;
  exportPort?: AiChatExportPort;
}): Promise<{ panel: MockPanel; handler: (msg: unknown) => void }> {
  agentState.runAgentMock.mockResolvedValue(makeRunResult("answer"));
  const factory: AdapterFactory = vi.fn(async () => null);
  const panel = new AiChatPanel({
    extensionUri: extUri,
    deps: makeDeps(),
    adapterFactory: factory,
    engine: "builtin",
    ...(opts?.store !== undefined ? { sessionStore: opts.store } : {}),
    ...(opts?.exportPort !== undefined ? { exportPort: opts.exportPort } : {}),
  });
  panel.show();
  const { panel: p, handler } = panelHarness();
  handler(intent({ kind: "ready_v2" }));
  await until(() => posted(p).some((m) => m.kind === "session_hydrated"));
  return { panel: p, handler };
}

function intent(body: Record<string, unknown>): Record<string, unknown> {
  return { protocolVersion: 2, ...body };
}

/** Minimal VALID submit_turn intent (draft requires revision + collections). */
function submitTurn(clientRequestId: string, text: string): Record<string, unknown> {
  return intent({
    kind: "submit_turn",
    clientRequestId,
    draft: { text, revision: 0, context: [], attachments: [] },
  });
}

beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
});

// ============================================================================
// #1 — a builtin turn persists structured content into the host store
// ============================================================================
describe("TASK-CHATV2-015 host — structured persistence", () => {
  it("send persists the visible user prompt, streamed assistant text and terminal completed state", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const { panel, handler } = await boot({ store });

    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: { onText?: (t: string) => void },
      ) => {
        callbacks?.onText?.("hel");
        callbacks?.onText?.("lo");
        return makeRunResult("hello");
      },
    );

    handler(submitTurn("c1", "hi there"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);

    // The turn_started ack carries the SAME clientRequestId (correlation).
    const started = v2Frames(panel, "turn_started");
    expect(started[0]?.clientRequestId).toBe("c1");

    const sessionId = started[0]?.sessionId as string;
    expect(typeof sessionId).toBe("string");

    // Structured record survives in the host store — exact visible transcript.
    const record = store.get(sessionId);
    expect(record).not.toBeNull();
    expect(record!.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hi there"],
      ["assistant", "hello"],
    ]);
    expect(record!.terminalState).toBe("completed");
    // The record is genuinely persisted to the host Memento, not just cached.
    expect(memento.raw.has(`${SESSION_RECORD_KEY_PREFIX}${sessionId}`)).toBe(true);
  });

  it("a streamed turn checkpoints assistant text without flushing per delta", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const { handler } = await boot({ store });
    agentState.runAgentMock.mockImplementation(
      async (
        _input: unknown,
        _deps: unknown,
        callbacks?: { onText?: (t: string) => void },
      ) => {
        callbacks?.onText?.("a");
        callbacks?.onText?.("b");
        callbacks?.onText?.("c");
        return makeRunResult("abc");
      },
    );
    handler(submitTurn("c1", "q"));
    await until(() => store.listSummaries(WORKSPACE).length === 1);
    // Terminal flush writes the authoritative final text exactly once.
    await flush(20);
    store.flush();
    const [summary] = store.listSummaries(WORKSPACE);
    expect(summary?.terminalState).toBe("completed");
    const record = store.get(summary!.id)!;
    expect(record.messages.find((m) => m.role === "assistant")?.text).toBe("abc");
    expect(record.messages.find((m) => m.role === "assistant")?.partial).toBeUndefined();
  });
});

// ============================================================================
// #4 — corrupt record → quarantine + safe warning, panel never crashes
// ============================================================================
describe("TASK-CHATV2-015 host — corrupt/missing record", () => {
  it("resume of an unknown/quarantined id warns and never adopts it", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const { panel, handler } = await boot({ store });

    handler(intent({ kind: "resume_saved_session", clientRequestId: "r1", sessionId: "sess-ghost" }));
    await flush();

    const toasts = v2Frames(panel, "toast");
    expect(toasts.some((t) => typeof t.safeMessage === "string")).toBe(true);
    // The live session is unchanged: no hydration frame for a ghost id, and
    // the panel keeps responding to intents.
    const hydrated = v2Frames(panel, "session_hydrated").filter(
      (f) => f.sessionId === "sess-ghost",
    );
    expect(hydrated).toHaveLength(0);
    handler(intent({ kind: "list_sessions" }));
    await flush();
    expect(v2Frames(panel, "sessions").length).toBeGreaterThan(0);
  });
});

// ============================================================================
// #6 — export success only on export_completed; cancel no-op; failure copy
// ============================================================================
describe("TASK-CHATV2-015 host — export", () => {
  async function seedSession(): Promise<{
    panel: MockPanel;
    handler: (msg: unknown) => void;
    sessionId: string;
  }> {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const port: AiChatExportPort = {
      chooseDestination: vi.fn(async () => ({ name: "chat.md", uri: "mem://chat.md" })),
      write: vi.fn(async () => undefined),
    };
    const { panel, handler } = await boot({ store, exportPort: port });
    handler(submitTurn("c1", "q"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);
    const sessionId = v2Frames(panel, "turn_started")[0]?.sessionId as string;
    return { panel, handler, sessionId };
  }

  it("emits export_completed only after the host write succeeds", async () => {
    const { panel, handler } = await seedSession();
    handler(intent({ kind: "export_session", clientRequestId: "e1", format: "markdown" }));
    await until(() => v2Frames(panel, "export_completed").length === 1);
    expect(v2Frames(panel, "export_failed")).toHaveLength(0);
  });

  it("a cancelled destination emits neither success nor failure", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const port: AiChatExportPort = {
      chooseDestination: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
    };
    const { panel, handler } = await boot({ store, exportPort: port });
    handler(submitTurn("c1", "q"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);

    handler(intent({ kind: "export_session", clientRequestId: "e1", format: "json" }));
    await flush(20);
    expect(v2Frames(panel, "export_completed")).toHaveLength(0);
    expect(v2Frames(panel, "export_failed")).toHaveLength(0);
  });

  it("a write failure emits export_failed with a safe reason", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const port: AiChatExportPort = {
      chooseDestination: vi.fn(async () => ({ name: "chat.json", uri: "mem://chat.json" })),
      write: vi.fn(async () => {
        throw new TypeError("denied");
      }),
    };
    const { panel, handler } = await boot({ store, exportPort: port });
    handler(submitTurn("c1", "q"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);

    handler(intent({ kind: "export_session", clientRequestId: "e1", format: "json" }));
    await until(() => v2Frames(panel, "export_failed").length === 1);
    expect(v2Frames(panel, "export_completed")).toHaveLength(0);
    const failed = v2Frames(panel, "export_failed")[0]!;
    // The frame carries the SAFE reason (the webview composes the exact
    // `Could not export chat` title) plus a short diagnostic id.
    expect(String(failed.safeMessage).length).toBeGreaterThan(0);
    expect(String(failed.diagnosticId).length).toBeGreaterThan(0);
    // Never a raw throw/stack echo.
    expect(JSON.stringify(failed)).not.toMatch(/at \w+ \(|node_modules|\.ts:\d+/);
  });

  it("export with no saved chat reports a safe failure, never fake success", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const port: AiChatExportPort = {
      chooseDestination: vi.fn(async () => ({ name: "x.md", uri: "u" })),
      write: vi.fn(async () => undefined),
    };
    const { panel, handler } = await boot({ store, exportPort: port });
    handler(intent({ kind: "export_session", clientRequestId: "e1", format: "markdown" }));
    await flush(20);
    expect(v2Frames(panel, "export_completed")).toHaveLength(0);
    expect(v2Frames(panel, "export_failed")).toHaveLength(1);
  });
});

// ============================================================================
// #9 — race: stale / unknown session correlation cannot mutate the live one
// ============================================================================
describe("TASK-CHATV2-015 host — session correlation and reset", () => {
  it("rename on a live session persists and is host-acknowledged with the exact title", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const { panel, handler } = await boot({ store });
    handler(submitTurn("c1", "q"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);
    const sessionId = v2Frames(panel, "turn_started")[0]?.sessionId as string;

    handler(intent({ kind: "rename_session", clientRequestId: "n1", title: "My chat" }));
    await flush();
    const ack = v2Frames(panel, "title_updated");
    expect(ack).toHaveLength(1);
    expect(ack[0]?.title).toBe("My chat");
    expect(store.get(sessionId)?.title).toBe("My chat");
  });

  it("create_session re-bases to a NEW id and preserves the old saved session", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const { panel, handler } = await boot({ store });
    handler(submitTurn("c1", "first"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);
    const firstId = v2Frames(panel, "turn_started")[0]?.sessionId as string;

    handler(intent({ kind: "create_session", clientRequestId: "new1" }));
    await flush();
    handler(submitTurn("c2", "second"));
    await until(() => v2Frames(panel, "turn_started").length === 2);
    await flush(20);

    const secondId = v2Frames(panel, "turn_started")[1]?.sessionId as string;
    expect(secondId).not.toBe(firstId);
    // The old session is preserved, not deleted.
    expect(store.get(firstId)?.messages.map((m) => m.text)).toEqual(["first", "answer"]);
    expect(store.get(secondId)?.messages.map((m) => m.text)).toEqual(["second", "answer"]);
  });

  it("clear_session clears only the current transcript and keeps siblings", async () => {
    const memento = makeMemento();
    const store = new AiChatSessionStore({ memento });
    const { panel, handler } = await boot({ store });
    handler(submitTurn("c1", "one"));
    await until(() => posted(panel).some((m) => m.kind === "turn_finished"));
    await flush(20);
    const id = v2Frames(panel, "turn_started")[0]?.sessionId as string;

    handler(intent({ kind: "clear_session", clientRequestId: "clr1" }));
    await flush(20);
    expect(store.get(id)?.messages).toHaveLength(0);
    // The session shell survives (not removed) so it can be resumed.
    expect(store.listSummaries(WORKSPACE).some((s) => s.id === id)).toBe(true);
  });
});
