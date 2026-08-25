// src/ui/__tests__/aiChatPanelResume.test.ts — TASK-003 panel resume
// coordinator + replay-derived history.
//
// Cases 1..8 frozen in docs/AI_HANDOFF/tasks/TASK-003.md §Test Cases.
// Fake ACP-shaped deps follow the same pattern as aiChatPanelAcp.test.ts:
// start() returns an AcpProcessHandle backed by a real AcpClient whose
// transport is a FakeAcpTransport — so `session/list` and `session/load`
// frames go on the wire and we can drive them deterministically.
//
// Session creation is LAZY: the panel only calls acp.start() the first
// time it needs to write an ACP frame (resume_list / resume_pick / send).
// Tests therefore trigger the action FIRST, then `await lastFakeSession()`
// to obtain the FakeAcpSession.

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AgentDeps } from "../../ai/agent";
import {
  AcpClient,
  type AcpTransport,
  type AcpSessionListItem,
} from "../../ai/omp/acp";
import type { AcpProcessHandle } from "../../ai/omp/acpProcess";

const agentState = vi.hoisted(() => ({
  runAgentMock: vi.fn() as Mock,
}));

vi.mock("../../ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/agent")>();
  return { ...actual, runAgent: agentState.runAgentMock };
});

import { AiChatPanel } from "../aiChatPanel";

// ---- vscode mock (mirrors aiChatPanelAcp.test.ts shape) --------------------

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
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  // Workspace folder makes `workspaceFolders[0].uri.fsPath` resolve to the
  // shared `WORKSPACE` for resume-list filtering.
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/work" }, name: "work", index: 0 }],
  },
  EventEmitter: vi.fn(),
}));

const extUri = vscode.Uri.file("/ext");
const WORKSPACE = "/work";

// ---- Fake transport + helpers ---------------------------------------------

class FakeAcpTransport implements AcpTransport {
  written: string[] = [];
  private listeners: Array<(line: string) => void> = [];
  private closed = false;
  write(line: string): void {
    if (this.closed) return;
    this.written.push(line);
  }
  onLine(cb: (line: string) => void): void {
    this.listeners.push(cb);
  }
  close(): void {
    this.closed = true;
    this.listeners.length = 0;
  }
  feed(line: string): void {
    for (const cb of this.listeners.slice()) cb(line);
  }
  allWritten(): Array<Record<string, unknown>> {
    return this.written.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

interface FakeAcpSession {
  acp: AcpClient;
  transport: FakeAcpTransport;
}

// Module-level registry: every makeFakeAcpDeps() reset records sessions
// here so tests can introspect the latest FakeAcpSession after triggering
// the action that creates the panel's AcpSession (lazy).
let _fakeSessionsRegistry: FakeAcpSession[] = [];
function lastFakeSession(): FakeAcpSession | null {
  return _fakeSessionsRegistry[_fakeSessionsRegistry.length - 1] ?? null;
}
function resetFakeSessions(): void {
  _fakeSessionsRegistry = [];
}

function makeFakeAcpDeps(): {
  start: (ompPath: string, cwd: string) => Promise<AcpProcessHandle>;
} {
  return {
    start: async (_ompPath: string, _cwd: string): Promise<AcpProcessHandle> => {
      const transport = new FakeAcpTransport();
      const acp = new AcpClient(transport);
      const session: FakeAcpSession = { acp, transport };
      _fakeSessionsRegistry.push(session);
      return {
        acp,
        sessionId: "sess-active",
        version: "18.0.1",
        dispose: () => {
          transport.close();
          acp.dispose();
        },
      };
    },
  };
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

function postedMessages(panel: MockPanel): unknown[] {
  return panel.webview.postMessage.mock.calls.map((c) => c[0]);
}

// TASK-012 (B11): ensureAcpSession() now binds a real `node:http` listener
// (McpBridge) before calling `acp.start()`. `server.listen()`'s callback
// fires on I/O-completion, a macrotask — draining only the microtask queue
// (plain `await Promise.resolve()`) never observes it, so `until`/`flush`
// yield via `setImmediate` instead. setImmediate always drains any pending
// microtasks first, so every assertion that previously relied on pure
// microtask-tick counts still holds — this is a strict superset wait.
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await tick();
  }
}

async function flush(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

/** Drive the panel through `{type:"ready"}` so it posts engine + init. */
async function bootPanel(
  start: (ompPath: string, cwd: string) => Promise<AcpProcessHandle>,
): Promise<{ panel: MockPanel; handler: (msg: unknown) => void }> {
  const panel = new AiChatPanel({
    extensionUri: extUri,
    deps: makeDeps(),
    adapterFactory: vi.fn(async () => null),
    acp: { start },
  });
  panel.show();
  const { panel: p, handler } = panelHarness();
  handler({ type: "ready" });
  await until(() => postedMessages(p).some((m) => isInit(m)));
  return { panel: p, handler };
}

/** Wait until the FakeAcpSession appears (i.e. start() has been called). */
async function awaitFakeSession(): Promise<FakeAcpSession> {
  await until(() => lastFakeSession() !== null);
  const s = lastFakeSession();
  if (!s) throw new Error("expected FakeAcpSession to be created");
  return s;
}

// ---- Message narrowing helpers --------------------------------------------

function isResumeSessions(
  m: unknown,
): m is { type: "resume_sessions"; sessions: Array<{ sessionId: string; label: string; detail: string }> } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "resume_sessions";
}
function isHistory(
  m: unknown,
): m is {
  type: "history";
  items: Array<{ kind: "user" | "assistant" | "tool"; text: string }>;
  truncated: boolean;
  truncatedCount: number;
} {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "history";
}
function isDelta(m: unknown): m is { type: "delta"; text: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "delta";
}
function isError(m: unknown): m is { type: "error"; message: string } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "error";
}
function isInit(m: unknown): m is { type: "init"; hasHistory: boolean } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}
function isDone(m: unknown): m is { type: "done" } {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "done";
}
beforeEach(() => {
  state.panels.length = 0;
  (vscode.window.createWebviewPanel as unknown as Mock).mockClear();
  agentState.runAgentMock.mockReset();
  resetFakeSessions();
});

// ============================================================================
// #1 — resume_list filters by cwd, removes own sessionId, sorts updatedAt
// desc with raw-string fallback, caps at 20, applies title fallback.
// ============================================================================
describe("AiChatPanel — resume_list (TASK-003 #1)", () => {
  it("filters by cwd, drops own sessionId, sorts updatedAt desc, caps at 20, applies (untitled)", async () => {
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_list" });
    // Session is created lazily on first resume action — wait for it.
    const session = await awaitFakeSession();
    // Drain initialize + session/new handshake frames.
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/list",
      ),
    );


    // Fixture: 26 entries total — 1 own-id, 1 wrong-cwd, 23 m* matching-cwd
    // (3 of which carry non-ISO `updatedAt` to exercise F2 NaN-fallback),
    // 1 over-cap placeholder that drop-guard against the cap.
    //
    // IMPORTANT: input order is intentionally NOT pre-sorted by updatedAt.
    // Mutations that drop `.sort(compareUpdatedAtDesc)` (Mutation C) would
    // otherwise leave the test green — we shuffle here so removing sort
    // regresses the asserted [m01..m20] desc output. NaN entries are
    // interleaved (positions 3, 7, 11) so they would leak into the top-20
    // window if F2 fallback is broken.
    const now = Date.parse("2026-08-24T12:00:00Z");
    // Helper — non-ISO timestamp: Date.parse returns NaN; F2 fallback sorts
    // these last via raw-string compare. Keep them distinct.
    const nanTs = (raw: string): string => raw;
    const items = [
      // Position 0: own session — must be filtered out.
      { sessionId: "sess-active", cwd: WORKSPACE, title: "Active", updatedAt: new Date(now).toISOString(), _meta: { messageCount: 5, size: 100 } },
      // Position 1: wrong cwd — must be filtered out.
      { sessionId: "f1", cwd: "/elsewhere", title: "Wrong cwd", updatedAt: new Date(now).toISOString(), _meta: { messageCount: 1, size: 1 } },
      // Position 2: m20 (oldest of valid) — would surface first if sort removed.
      { sessionId: "m20", cwd: WORKSPACE, title: "Romeo", updatedAt: new Date(now - 20).toISOString(), _meta: { messageCount: 20, size: 20 } },
      // Position 3: NaN entry (would surface in top-20 if F2 broken).
      { sessionId: "nan-a", cwd: WORKSPACE, title: "NaN-A", updatedAt: nanTs("not-a-date"), _meta: { messageCount: 99, size: 99 } },
      // Position 4: m05.
      { sessionId: "m05", cwd: WORKSPACE, title: "Charlie", updatedAt: new Date(now - 5).toISOString(), _meta: { messageCount: 5, size: 5 } },
      // Position 5: m10.
      { sessionId: "m10", cwd: WORKSPACE, title: "Hotel", updatedAt: new Date(now - 10).toISOString(), _meta: { messageCount: 10, size: 10 } },
      // Position 6: m01 (newest of valid) — must appear first after sort.
      { sessionId: "m01", cwd: WORKSPACE, title: "Alpha", updatedAt: new Date(now - 1).toISOString(), _meta: { messageCount: 1, size: 1 } },
      // Position 7: NaN entry.
      { sessionId: "nan-b", cwd: WORKSPACE, title: "NaN-B", updatedAt: nanTs("foo-bar-baz"), _meta: { messageCount: 88, size: 88 } },
      // Position 8: m03 (null title).
      { sessionId: "m03", cwd: WORKSPACE, title: null, updatedAt: new Date(now - 3).toISOString(), _meta: { messageCount: 3, size: 3 } },
      // Position 9: m15.
      { sessionId: "m15", cwd: WORKSPACE, title: "Mike", updatedAt: new Date(now - 15).toISOString(), _meta: { messageCount: 15, size: 15 } },
      // Position 10: m08.
      { sessionId: "m08", cwd: WORKSPACE, title: "Foxtrot", updatedAt: new Date(now - 8).toISOString(), _meta: { messageCount: 8, size: 8 } },
      // Position 11: NaN entry.
      { sessionId: "nan-c", cwd: WORKSPACE, title: "NaN-C", updatedAt: nanTs("never-gonna-parse"), _meta: { messageCount: 77, size: 77 } },
      // Position 12: m12.
      { sessionId: "m12", cwd: WORKSPACE, title: "Juliet", updatedAt: new Date(now - 12).toISOString(), _meta: { messageCount: 12, size: 12 } },
      // Position 13: m02.
      { sessionId: "m02", cwd: WORKSPACE, title: "Bravo", updatedAt: new Date(now - 2).toISOString(), _meta: { messageCount: 2, size: 2 } },
      // Position 14: m18.
      { sessionId: "m18", cwd: WORKSPACE, title: "Papa", updatedAt: new Date(now - 18).toISOString(), _meta: { messageCount: 18, size: 18 } },
      // Position 15: m07.
      { sessionId: "m07", cwd: WORKSPACE, title: "Echo", updatedAt: new Date(now - 7).toISOString(), _meta: { messageCount: 7, size: 7 } },
      // Position 16: m11.
      { sessionId: "m11", cwd: WORKSPACE, title: "India", updatedAt: new Date(now - 11).toISOString(), _meta: { messageCount: 11, size: 11 } },
      // Position 17: m16.
      { sessionId: "m16", cwd: WORKSPACE, title: "November", updatedAt: new Date(now - 16).toISOString(), _meta: { messageCount: 16, size: 16 } },
      // Position 18: m04 — "<function>" sentinel.
      { sessionId: "m04", cwd: WORKSPACE, title: "<function>", updatedAt: new Date(now - 4).toISOString(), _meta: { messageCount: 4, size: 4 } },
      // Position 19: m09.
      { sessionId: "m09", cwd: WORKSPACE, title: "Golf", updatedAt: new Date(now - 9).toISOString(), _meta: { messageCount: 9, size: 9 } },
      // Position 20: m14.
      { sessionId: "m14", cwd: WORKSPACE, title: "Lima", updatedAt: new Date(now - 14).toISOString(), _meta: { messageCount: 14, size: 14 } },
      // Position 21: m19.
      { sessionId: "m19", cwd: WORKSPACE, title: "Quebec", updatedAt: new Date(now - 19).toISOString(), _meta: { messageCount: 19, size: 19 } },
      // Position 22: m06.
      { sessionId: "m06", cwd: WORKSPACE, title: "Delta", updatedAt: new Date(now - 6).toISOString(), _meta: { messageCount: 6, size: 6 } },
      // Position 23: m13.
      { sessionId: "m13", cwd: WORKSPACE, title: "Kilo", updatedAt: new Date(now - 13).toISOString(), _meta: { messageCount: 13, size: 13 } },
      // Position 24: m17.
      { sessionId: "m17", cwd: WORKSPACE, title: "Oscar", updatedAt: new Date(now - 17).toISOString(), _meta: { messageCount: 17, size: 17 } },
    ];
    const req = session.transport.allWritten().find((f) => f["method"] === "session/list");
    expect(req).toBeDefined();
    const id = req!["id"];
    session.transport.feed(
      JSON.stringify({ jsonrpc: "2.0", id, result: { sessions: items } }),
    );
    await until(() => postedMessages(p).some((m) => isResumeSessions(m)));

    const msg = postedMessages(p).find(isResumeSessions);
    expect(msg).toBeDefined();
    const sessions_out = msg!.sessions;

    // Cap 20 → 20 entries (own + wrong-cwd removed; NaN entries pushed
    // to the bottom by F2 fallback and capped off).
    expect(sessions_out).toHaveLength(20);


    // Own sessionId MUST NOT appear.
    expect(sessions_out.some((s) => s.sessionId === "sess-active")).toBe(false);
    // Wrong cwd MUST NOT appear.
    expect(sessions_out.some((s) => s.sessionId === "f1")).toBe(false);
    // NaN-fallback (F2) MUST push non-ISO updatedAt entries to the bottom

    // leaking into the top-20 window), this assertion fires.
    expect(sessions_out.some((s) => s.sessionId === "nan-a")).toBe(false);
    expect(sessions_out.some((s) => s.sessionId === "nan-b")).toBe(false);
    expect(sessions_out.some((s) => s.sessionId === "nan-c")).toBe(false);
    // Sort updatedAt desc (F1 / Mutation C pin): input was shuffled so
    // removing `.sort(compareUpdatedAtDesc)` would NOT place m01 first.
    expect(sessions_out[0]?.sessionId).toBe("m01");
    expect(sessions_out[19]?.sessionId).toBe("m20");
    // Title fallback: null → "(untitled)"; "<function>" → "(untitled)".
    const m03 = sessions_out.find((s) => s.sessionId === "m03");
    expect(m03?.label).toBe("(untitled)");
    const m04 = sessions_out.find((s) => s.sessionId === "m04");
    expect(m04?.label).toBe("(untitled)");
    // Real titles preserved verbatim.
    const m01 = sessions_out.find((s) => s.sessionId === "m01");
    expect(m01?.label).toBe("Alpha");
    // Detail carries messageCount.
    expect(m01?.detail).toBe("1 messages");
    expect(m03?.detail).toBe("3 messages");
  });

  it("#1b — compareUpdatedAtDesc F2 NaN-fallback: NaN entries sort last, raw-string compare sorts NaN < NaN", async () => {
    // Direct unit test for the private static comparator (TASK-003 F2 pin).
    const cmp = (
      AiChatPanel as unknown as {
        compareUpdatedAtDesc: (a: { updatedAt: string }, b: { updatedAt: string }) => number;
      }
    ).compareUpdatedAtDesc;
    const iso = (offset: number) => new Date(Date.parse("2026-08-24T12:00:00Z") - offset).toISOString();
    const a = { updatedAt: iso(5) };
    const b = { updatedAt: iso(10) };
    // ISO desc: a (newer) before b (older) → negative.
    expect(cmp(a, b)).toBeLessThan(0);
    expect(cmp(b, a)).toBeGreaterThan(0);
    // NaN entries sort last (NaN < NaN raw-string fallback).
    const nan1 = { updatedAt: "not-a-date" };
    const nan2 = { updatedAt: "foo-bar-baz" };
    expect(cmp(nan1, a)).toBeGreaterThan(0); // NaN last
    expect(cmp(a, nan1)).toBeLessThan(0);
    // Two NaN entries — raw-string compare: alphabetical desc.
    // "not-a-date" > "foo-bar-baz" alphabetically ("n" > "f"),
    // so in desc order nan1 sorts BEFORE nan2.
    expect(cmp(nan1, nan2)).toBeLessThan(0);
    expect(cmp(nan2, nan1)).toBeGreaterThan(0);

  });
});
// ============================================================================
// #2 — resume_pick loads the session, derives history, re-bases sessionId,
// the next session/prompt uses the NEW sessionId.
// ============================================================================
describe("AiChatPanel — resume_pick (TASK-003 #2)", () => {
  it("loads, posts history batch in replay order, re-bases sessionId, next prompt uses new id", async () => {
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_pick", sessionId: "picked-77" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/load",
      ),
    );
    const req = session.transport.allWritten().find((f) => f["method"] === "session/load");
    expect(req).toBeDefined();
    expect(req!["params"]).toMatchObject({ sessionId: "picked-77", cwd: WORKSPACE });
    const id = req!["id"];

    // Feed replay frames BEFORE the result so the window absorbs them.
    const replay: Array<{ method: string; params: unknown }> = [
      {
        method: "session/update",
        params: {
          sessionId: "picked-77",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "list tables" },
            messageId: "m1",
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "picked-77",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "picked-77",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "list_tables",
          },
        },
      },
    ];
    for (const n of replay) {
      session.transport.feed(JSON.stringify({ jsonrpc: "2.0", ...n }));
    }
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: [], modes: {} },
      }),
    );

    await until(() => postedMessages(p).some(isHistory));
    const hist = postedMessages(p).find(isHistory)!;
    expect(hist.truncated).toBe(false);
    expect(hist.truncatedCount).toBe(0);
    expect(hist.items).toEqual([
      { kind: "user", text: "list tables" },
      { kind: "assistant", text: "hello" },
      { kind: "tool", text: "list_tables" },
    ]);

    // Now send a new prompt — the panel's next session/prompt frame MUST
    // use the NEW sessionId "picked-77" (not the original "sess-active").
    handler({ type: "send", text: "next" });
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/prompt",
      ),
    );
    const promptFrame = session.transport.allWritten().find(
      (f) => f["method"] === "session/prompt",
    )!;
    const params = promptFrame["params"] as { sessionId: string; prompt: Array<{ type: string; text: string }> };
    expect(params.sessionId).toBe("picked-77");
    // TASK-007 B9: the ACP prompt text is now prefixed with the cached
    // system+schema context, so assert the user text is carried through
    // rather than an exact-equal (this test's focus is the re-based
    // sessionId, not the prompt-composition behavior covered elsewhere).
    expect(params.prompt).toHaveLength(1);
    expect(params.prompt[0].type).toBe("text");
    expect(params.prompt[0].text.endsWith("next")).toBe(true);
  });
});

// ============================================================================
// #3 — replay containing agent_thought_chunk must NOT produce any item
// with thought content; other items still render.
// ============================================================================
describe("AiChatPanel — deriveHistoryFromReplay skips agent_thought_chunk (TASK-003 #3)", () => {
  it("derives history skipping thought chunks, in original order", async () => {
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_pick", sessionId: "p1" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/load",
      ),
    );
    const req = session.transport.allWritten().find((f) => f["method"] === "session/load")!;
    const id = req["id"];
    const replay: Array<{ method: string; params: unknown }> = [
      {
        method: "session/update",
        params: {
          sessionId: "p1",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "hi" },
            messageId: "m1",
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p1",
          update: { sessionUpdate: "agent_thought_chunk", chunk: "secret reasoning that must NOT leak" },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p1",
          update: { sessionUpdate: "agent_thought_chunk", chunk: "more secret" },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p1",
          update: { sessionUpdate: "tool_call", toolCallId: "tc1", title: "search" },
        },
      },
    ];
    for (const n of replay) session.transport.feed(JSON.stringify({ jsonrpc: "2.0", ...n }));
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: [], modes: {} },
      }),
    );

    await until(() => postedMessages(p).some(isHistory));
    const hist = postedMessages(p).find(isHistory)!;
    expect(hist.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(hist.items.map((i) => i.text)).toEqual(["hi", "hello", "search"]);
    // Thought content MUST NOT appear anywhere in posted messages.
    const allPosted = JSON.stringify(postedMessages(p));
    expect(allPosted).not.toContain("secret reasoning");
    expect(allPosted).not.toContain("more secret");
  });
});

// ============================================================================
// #4 — replay > cap → only the last 50 items posted; truncated + count.
// ============================================================================
describe("AiChatPanel — history cap 50 (TASK-003 #4)", () => {
  it("derives only the last 50 items from a 60-item replay", async () => {
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_pick", sessionId: "p-cap" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/load",
      ),
    );
    const req = session.transport.allWritten().find((f) => f["method"] === "session/load")!;
    const id = req["id"];
    const replay: Array<{ method: string; params: unknown }> = [];
    for (let i = 0; i < 60; i++) {
      if (i % 2 === 0) {
        replay.push({
          method: "session/update",
          params: {
            sessionId: "p-cap",
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: `u${i}` },
              messageId: `m${i}`,
            },
          },
        });
      } else {
        replay.push({
          method: "session/update",
          params: {
            sessionId: "p-cap",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `a${i}` },
            },
          },
        });
      }
    }
    for (const n of replay) session.transport.feed(JSON.stringify({ jsonrpc: "2.0", ...n }));
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: [], modes: {} },
      }),
    );

    await until(() => postedMessages(p).some(isHistory));
    const hist = postedMessages(p).find(isHistory)!;
    expect(hist.items).toHaveLength(50);
    expect(hist.truncated).toBe(true);
    expect(hist.truncatedCount).toBe(10);
    // Last 50 indices = 10..59 (mixed user/agent). Verify first + last item.
    expect(hist.items[0]?.text).toBe("u10");
    expect(hist.items[49]?.text).toBe("a59");
  });
});

// ============================================================================
// #5 — malformed entries (missing content, empty tool_call, weird method)
// must not throw; invalid items skipped; valid items around still render.
// ============================================================================
describe("AiChatPanel — deriveHistoryFromReplay tolerates malformed entries (TASK-003 #5)", () => {
  it("skips malformed entries, falls back to 'tool' label, keeps valid items in order", async () => {
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_pick", sessionId: "p-mal" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/load",
      ),
    );
    const req = session.transport.allWritten().find((f) => f["method"] === "session/load")!;
    const id = req["id"];
    const replay: Array<{ method: string; params: unknown }> = [
      {
        method: "session/update",
        params: {
          sessionId: "p-mal",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "u-good-1" },
            messageId: "m1",
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p-mal",
          update: { sessionUpdate: "user_message_chunk", messageId: "m2" },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p-mal",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "a-good" },
          },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p-mal",
          update: { sessionUpdate: "tool_call" },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p-mal",
          update: { sessionUpdate: "session/whatever" as string },
        },
      },
      {
        method: "session/update",
        params: {
          sessionId: "p-mal",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "u-good-2" },
            messageId: "m99",
          },
        },
      },
    ];
    for (const n of replay) session.transport.feed(JSON.stringify({ jsonrpc: "2.0", ...n }));
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: [], modes: {} },
      }),
    );

    await until(() => postedMessages(p).some(isHistory));
    const hist = postedMessages(p).find(isHistory)!;
    expect(hist.items).toEqual([
      { kind: "user", text: "u-good-1" },
      { kind: "assistant", text: "a-good" },
      { kind: "tool", text: "tool" },
      { kind: "user", text: "u-good-2" },
    ]);
  });
});

// ============================================================================
// #6 — sessionLoad rejects (e.g. -32603 not found). Panel posts inline error
// and the panel stays alive (send still works, sessionId unchanged).
// ============================================================================
describe("AiChatPanel — resume_pick error path (TASK-003 #6)", () => {
  it("inline error; sessionId unchanged; panel can still send", async () => {
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_pick", sessionId: "missing-99" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/load",
      ),
    );
    const req = session.transport.allWritten().find((f) => f["method"] === "session/load")!;
    const id = req["id"];
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "ACP session not found: missing-99" },
      }),
    );

    await until(() => postedMessages(p).some(isError));
    const err = postedMessages(p).find(isError)!;
    expect(err.message).toMatch(/ACP session not found|missing-99/);

    // Panel stays alive: a fresh `send` should still drive a session/prompt.
    handler({ type: "send", text: "after-error" });
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/prompt",
      ),
    );
    const promptFrame = session.transport.allWritten().find(
      (f) => f["method"] === "session/prompt",
    )!;
    expect((promptFrame["params"] as { sessionId: string }).sessionId).toBe("sess-active");
  });
});

// ============================================================================
// #7 — resume_list disabled while streaming or when engine is builtin.
// ============================================================================
describe("AiChatPanel — resume_list guards (TASK-003 #7)", () => {
  it("#7a while a turn is streaming: no resume_sessions posted, no session/list frame written", async () => {
    agentState.runAgentMock.mockImplementation(
      () => new Promise(() => {}), // never resolves — keeps the streaming turn active
    );
    const { start } = makeFakeAcpDeps();
    // Use no-acp so the builtin path streams; then resume_list MUST post error.
    const factory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    // Trigger a streaming turn — agent never resolves, so the turn stays in flight.
    handler({ type: "send", text: "go" });
    await flush();
    const before = postedMessages(p).filter(isResumeSessions).length;
    handler({ type: "resume_list" });
    await flush(20);
    const after = postedMessages(p).filter(isResumeSessions).length;
    expect(after).toBe(before);
    // The no-acp panel never starts a session, so the registry stays empty.
    expect(_fakeSessionsRegistry).toHaveLength(0);
  });

  it("#7b builtin engine: resume_list posts error 'Resume requires the omp engine'", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const factory = vi.fn(async () => null);
    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));
    handler({ type: "resume_list" });
    await until(() => postedMessages(p).some(isError));
    const err = postedMessages(p).find(isError)!;
    expect(err.message).toMatch(/omp engine/i);
    expect(postedMessages(p).some(isResumeSessions)).toBe(false);
  });
});

// ============================================================================
// #R5b — resume_pick is dropped while a turn is streaming (R5 streaming
// guard). Mirrors the resume_list streaming guard. Without the guard,
// `resume_pick` re-bases sessionId mid-turn: the in-flight session/prompt
// RESPONSE (the real ACP terminal signal — TASK-007 B1) would settle
// against session state that's already been re-based to the NEW
// sessionId — the panel streams forever / attributes the response to the
// wrong session.
// ============================================================================
describe("AiChatPanel — resume_pick streaming guard (TASK-003 R5b)", () => {
  it("while a turn is streaming: resume_pick is dropped, no session/load frame written, sessionId unchanged", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    // Send a real prompt — this creates the AcpSession lazily, writes
    // session/prompt, and the turn stays in flight because we never feed
    // the session/prompt response. token is set so resume_pick must be
    // dropped.
    handler({ type: "send", text: "first-turn" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/prompt",
      ),
    );
    const promptFramesBefore = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/prompt").length;

    // Now attempt resume_pick while the turn is in flight.
    handler({ type: "resume_pick", sessionId: "would-mid-turn-rebase" });
    await flush(30);

    // session/load MUST NOT have been written — guard caught it.
    const loadFrames = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/load");
    expect(loadFrames).toHaveLength(0);

    // The handle's sessionId is unchanged (still sess-active, not
    // would-mid-turn-rebase). We assert it indirectly: settle the
    // in-flight turn by feeding the session/prompt RESPONSE (the real ACP
    // terminal signal — TASK-007 B1) for the original prompt id, then
    // verify the next prompt uses sess-active.
    const originalPrompt = session.transport
      .allWritten()
      .find((f) => f["method"] === "session/prompt")!;
    const originalPromptId = originalPrompt["id"];
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id: originalPromptId,
        result: { stopReason: "end_turn" },
      }),
    );
    await until(() => postedMessages(p).some(isDone));

    // Send another prompt — sessionId MUST still be the original.
    handler({ type: "send", text: "second-turn" });
    await until(() =>
      session.transport.allWritten().filter((f) => f["method"] === "session/prompt").length >= 2,
    );
    const prompts = session.transport
      .allWritten()
      .filter((f) => f["method"] === "session/prompt");
    const secondPrompt = prompts[prompts.length - 1]!;
    expect((secondPrompt["params"] as { sessionId: string }).sessionId).toBe("sess-active");
    expect((secondPrompt["params"] as { sessionId: string }).sessionId).not.toBe(
      "would-mid-turn-rebase",
    );
  });
});

// ============================================================================
// #8 — session/update frame for the loaded sessionId arriving between
// load-settle and the next session/prompt write MUST NOT post a delta
// (panel-side drop-guard, F1 belt).
// ============================================================================
describe("AiChatPanel — drop-guard during load window (TASK-003 #8)", () => {
  it("session/update AFTER replay window closes but BEFORE next session/prompt write does NOT post a delta; then prompt write clears guard and live deltas stream", async () => {
    agentState.runAgentMock.mockResolvedValue({ steps: [], history: [], finalText: "", stoppedOnBudget: false });
    const { start } = makeFakeAcpDeps();
    const { panel: p, handler } = await bootPanel(start);

    handler({ type: "resume_pick", sessionId: "guard-1" });
    const session = await awaitFakeSession();
    await until(() =>
      session.transport.written.some(
        (l) => JSON.parse(l)["method"] === "session/load",
      ),
    );
    const req = session.transport.allWritten().find((f) => f["method"] === "session/load")!;
    const id = req["id"];
    // Replay containing an agent_message_chunk — this arrives INSIDE the
    // replay window so it gets absorbed by AcpClient, NOT routed to handler.
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "guard-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "replayed" },
          },
        },
      }),
    );
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { configOptions: [], modes: {} },
      }),
    );

    // Wait until history batch is posted (replayed → history item, not delta).
    await until(() => postedMessages(p).some(isHistory));
    expect(postedMessages(p).filter(isDelta)).toHaveLength(0);

    // Pin the panel-side guard: close the AcpClient replay window by
    // issuing any outgoing request directly through the AcpClient. The
    // request's `closeReplayWindow()` runs BEFORE the frame is written
    // (see AcpClient.request), so replayState becomes null but the panel
    // dropReplayFrames flag stays armed (we did NOT go through runAcpTurn,
    // which is the only path that clears it).
    const closeReqId = (() => {
      // Find the latest request id that will be allocated by AcpClient.
      // We send `session/list` to ensure a deterministic request id — the
      // frame goes on the wire; we capture the id from the written frame.
      const pending = session.acp as unknown as {
        request: <T>(m: string, p: unknown) => Promise<T>;
      };
      const r = pending.request("session/list", {});
      // Locate the frame we just wrote to read its id.
      const frames = session.transport.allWritten();
      const last = frames[frames.length - 1];
      if (last === undefined || last["method"] !== "session/list") {
        throw new Error("expected session/list frame to be written");
      }
      const reqId = last["id"];
      // Resolve the request promise so we don't leak it.
      session.transport.feed(
        JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { sessions: [] } }),
      );
      return r;
    })();
    await closeReqId;

    // CASE 8 leak path: feed `session/update` for the LOADED sessionId NOW
    // — replay window is closed (transport-level defense is gone) but the
    // panel-side guard MUST still drop the frame. Without the guard (Mutation A),
    // this delta would render and `expect.toHaveLength(0)` would fail.
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "guard-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "leaked-should-not-render" },
          },
        },
      }),
    );
    await flush(20);
    expect(postedMessages(p).filter(isDelta)).toHaveLength(0);
    expect(
      postedMessages(p).filter(isDelta).some(
        (d) => (d as { text: string }).text === "leaked-should-not-render",
      ),
    ).toBe(false);

    // Now send a real prompt — runAcpTurn clears the drop-guard FIRST,
    // then writes session/prompt (which also closes the replay window
    // — already closed, so it's a no-op). Live agent_message_chunk frames
    // MUST now stream as deltas.
    handler({ type: "send", text: "real-prompt" });
    await until(() =>
      session.transport.written.filter(
        (l) => JSON.parse(l)["method"] === "session/prompt",
      ).length >= 1,
    );
    session.transport.feed(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "guard-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "live-stream" },
          },
        },
      }),
    );
    await until(() =>
      postedMessages(p).filter(isDelta).some(
        (d) => (d as { text: string }).text === "live-stream",
      ),
    );
    const deltas = postedMessages(p).filter(isDelta).map((d) => (d as { text: string }).text);
    expect(deltas).toContain("live-stream");
    expect(deltas).not.toContain("leaked-should-not-render");
  });
});
