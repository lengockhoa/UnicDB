// src/ui/__tests__/aiChatPanelAgentEngines.test.ts — TASK-011 R4.5 auto-fix
//
// Pinned regression: the Stop button previously cancelled only the
// `ompChatEngine` session. For Claude Code / Codex engines, Stop was a
// no-op for the active subprocess turn. This file pins that fix:
//   - With an active Claude Code turn, a Stop click triggers
//     `ClaudeCodeChatEngine.cancel()` and reaches the process handle.
//   - Same for Codex.
//
// Uses fake engines with a `send()` that NEVER resolves on its own — only
// resolves once the matching `cancel()` runs (mirroring how a real child
// keeps generating until SIGTERM lands). The fake records every cancel()
// invocation so the assertion is exact, not "eventually".
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import * as vscode from "vscode";
import type { AdapterFactory } from "../../ai/tools/types";
import type { AgentDeps } from "../../ai/agent";
import {
  createClaudeCodeChatEngine,
  type ClaudeCodeChatEngine,
  type ClaudeCodeChatEvents,
} from "../../ai/claudeCode/claudeCodeChatEngine";
import {
  createCodexChatEngine,
  type CodexChatEngine,
  type CodexChatEvents,
} from "../../ai/codex/codexChatEngine";
import type { ClaudeCodeProcessHandle } from "../../ai/claudeCode/claudeCodeProcess";
import type { CodexProcessHandle } from "../../ai/codex/codexProcess";
import type { HostMcp } from "../../ai/omp/ompChatEngine";

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

const state = vi.hoisted(() => ({
  panels: [] as MockPanel[],
}));

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
    showInformationMessage: vi.fn(async () => undefined),
  },
  workspace: {
    getConfiguration: vi.fn((_section: string) => ({
      get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
      update: vi.fn(async () => undefined),
    })),
  },
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: vi.fn((u: unknown, ...p: string[]) => ({
      toString: () => `${String(u)}/${p.join("/")}`,
    })),
  },
  ViewColumn: { Active: 1 },
  EventEmitter: vi.fn(),
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
}));

import { AiChatPanel } from "../aiChatPanel";

const extUri = vscode.Uri.file("/ext");

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until: condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function panelHarness(): {
  panel: MockPanel;
  handler: (msg: unknown) => void;
} {
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

function isInit(m: unknown): boolean {
  return !!m && typeof m === "object" && (m as { type?: string }).type === "init";
}

function makeDeps(): AgentDeps {
  return {
    loadConfig: vi.fn(async () => null),
    complete: vi.fn(),
  };
}

/**
 * Build a fake ClaudeCodeChatEngine whose `send()` stays pending until
 * `cancel()` is called. Records every `cancel()` invocation so the test
 * can assert Stop reached the subprocess path.
 */
function makeFakeClaudeCodeChatEngine(): {
  engine: ClaudeCodeChatEngine;
  cancelCalls: { count: number };
} {
  const cancelCalls = { count: 0 };
  const send: Mock = vi.fn(
    async (
      _text: string,
      _events: ClaudeCodeChatEvents,
      _attachments?: ReadonlyArray<{ mime: string; base64: string }>,
    ): Promise<void> => {
      // Pending forever — mimics a Claude Code child that keeps
      // streaming. The test cancels via the Stop click.
      await new Promise<void>(() => {
        /* never resolves */
      });
    },
  );
  const engine = {
    send,
    resume: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    cancel: vi.fn(() => {
      cancelCalls.count += 1;
    }),
  } as unknown as ClaudeCodeChatEngine;
  return { engine, cancelCalls };
}

/**
 * Build a fake CodexChatEngine with the same shape — send() is pending
 * until cancel() fires.
 */
function makeFakeCodexChatEngine(): {
  engine: CodexChatEngine;
  cancelCalls: { count: number };
} {
  const cancelCalls = { count: 0 };
  const send: Mock = vi.fn(
    async (
      _text: string,
      _events: CodexChatEvents,
      _attachments?: ReadonlyArray<{ mime: string; base64: string }>,
    ): Promise<void> => {
      await new Promise<void>(() => {
        /* never resolves */
      });
    },
  );
  const engine = {
    send,
    resume: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    cancel: vi.fn(() => {
      cancelCalls.count += 1;
    }),
  } as unknown as CodexChatEngine;
  return { engine, cancelCalls };
}

/**
 * Fake ClaudeCodeProcessHandle for the "subprocess reachable" test
 * (TASK-011 R4.5 round-3 fix). The panel Stop → engine.cancel() → proc.cancel()
 * dispatch is only useful if it actually reaches the subprocess handle. This
 * fake exposes two public observable properties the assertion pins on:
 *
 *   - `wasCancelled: boolean` — flipped to `true` inside `cancel()`.
 *   - `exitCode: number | null` — flipped to a non-null value inside `cancel()`,
 *     modelling the real handle's child-exit callback.
 *
 * `send()` stays pending until `cancel()` fires — mirroring a real child that
 * keeps generating until SIGTERM lands. A `vi.fn()` wraps `cancel()` so the
 * test can also assert the cancel-spy call count.
 */
interface FakeClaudeCodeProcessHandle extends ClaudeCodeProcessHandle {
  readonly wasCancelled: boolean;
  readonly exitCode: number | null;
  readonly started: boolean;
  cancel: ReturnType<typeof vi.fn>;
}

function makeFakeClaudeCodeProcessHandle(): FakeClaudeCodeProcessHandle {
  let _wasCancelled = false;
  let _exitCode: number | null = null;
  let _started = false;
  let resolveSend: (() => void) | null = null;
  const cancel = vi.fn(() => {
    if (_wasCancelled) return;
    _wasCancelled = true;
    // 128 + 15 (SIGTERM) — mirrors what a real child receives on cancel.
    _exitCode = 143;
    if (resolveSend) {
      const r = resolveSend;
      resolveSend = null;
      r();
    }
  });
  return {
    get wasCancelled() { return _wasCancelled; },
    get exitCode() { return _exitCode; },
    get started() { return _started; },
    state: () => "ready",
    send: async () => {
      _started = true;
      await new Promise<void>((resolve) => { resolveSend = resolve; });
    },
    cancel,
    dispose: async () => undefined,
    getStderrTail: () => "",
  };
}

/** Stub HostMcp so the real engine factory can run without wiring the
 *  in-process MCP server. The Cancel/Stop path never reaches `start`/`stop`
 *  synchronously, but `send()` does call `await hostMcp.start()` first. */
function makeStubHostMcp(): HostMcp {
  return {
    port: 0,
    url: "",
    sessionId: "",
    start: async () => undefined,
    stop: async () => undefined,
    call: async () => ({ result: "", isError: false }),
  };
}

/**
 * Fake CodexProcessHandle for the "subprocess reachable" test
 * (TASK-011 R4.5 round-3 fix). The Codex engine captures the per-turn handle
 * into `inFlightHandle` so `engine.cancel()` can reach it — the assertion
 * is on the captured handle's `wasCancelled` getter, NOT on a mock engine
 * wrapper. `send()` stays pending until `cancel()` fires.
 */
interface FakeCodexProcessHandle extends CodexProcessHandle {
  readonly wasCancelled: boolean;
  readonly started: boolean;
  cancel: ReturnType<typeof vi.fn>;
}

function makeFakeCodexProcessHandle(): FakeCodexProcessHandle {
  let _wasCancelled = false;
  let _started = false;
  let resolveSend: (() => void) | null = null;
  const cancel = vi.fn(() => {
    if (_wasCancelled) return;
    _wasCancelled = true;
    if (resolveSend) {
      const r = resolveSend;
      resolveSend = null;
      r();
    }
  });
  return {
    get wasCancelled() { return _wasCancelled; },
    get started() { return _started; },
    sessionId: "fake-codex-session",
    version: "fake-0.0.0",
    state: () => "ready",
    send: async () => {
      _started = true;
      await new Promise<void>((resolve) => { resolveSend = resolve; });
    },
    cancel,
    dispose: async () => undefined,
    getStderrTail: () => "",
  };
}

beforeEach(() => {
  state.panels.length = 0;
});

// ============================================================================
// Claude Code — Stop cancels the in-flight turn and reaches the subprocess
// ============================================================================
describe("AiChatPanel — TASK-011 R4.5 Stop dispatch (Claude Code)", () => {
  it("Stop click during an active Claude Code turn reaches the subprocess (wasCancelled + exitCode non-null)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    // Use the REAL engine factory wrapping a fake process handle, so the
    // assertion is on the subprocess seam (proc.cancel() + child exit), not
    // on a mock engine wrapper. The R4.5-round-2 review flagged the old
    // assertion as panel-dispatch-only — it never proved the subprocess
    // actually stopped.
    const fakeProc = makeFakeClaudeCodeProcessHandle();
    const hostMcp = makeStubHostMcp();
    const engine = createClaudeCodeChatEngine({ process: fakeProc, hostMcp });

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      engine: "claude-code",
      claudeCodeChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // Kick off the turn — fake proc.send() never resolves on its own.
    handler({ type: "send", text: "long-running claude turn" });
    await until(() => fakeProc.started);
    // The subprocess MUST NOT have been cancelled yet — only Stop cancels.
    expect(fakeProc.wasCancelled).toBe(false);
    expect(fakeProc.cancel).not.toHaveBeenCalled();
    expect(fakeProc.exitCode).toBeNull();

    // The Stop click — panel dispatches Stop → engine.cancel() →
    // proc.cancel() synchronously (the engine's cancel() calls
    // `proc.cancel()` inside the same microtask).
    handler({ type: "stop" });
    // Tight timeout — the cancel must reach the subprocess promptly.
    await until(() => fakeProc.wasCancelled, 200);
    expect(fakeProc.cancel).toHaveBeenCalledTimes(1);

    // The underlying child's exitCode must become non-null within a tight
    // window — that is the actual evidence the subprocess terminated.
    await until(() => fakeProc.exitCode !== null, 200);
    expect(fakeProc.exitCode).not.toBeNull();
  });

  it("Stop is a no-op for cancel() when no turn is in flight (idempotent on idle engine)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const { engine, cancelCalls } = makeFakeClaudeCodeChatEngine();

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      engine: "claude-code",
      claudeCodeChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // No send has been issued — Stop still routes through handleStop(),
    // and the engine.cancel() is invoked (it's a defensive best-effort).
    // Pin that the cancel() dispatch fires without crashing on an idle
    // engine (the engine itself owns idempotency on no-op handle).
    handler({ type: "stop" });
    await new Promise((r) => setTimeout(r, 20));

    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(cancelCalls.count).toBe(1);
    expect(engine.send).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Codex — Stop cancels the in-flight turn and reaches the subprocess
// ============================================================================
describe("AiChatPanel — TASK-011 R4.5 Stop dispatch (Codex)", () => {
  it("Stop click during an active Codex turn reaches the in-flight subprocess handle (wasCancelled)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    // Use the REAL engine factory wrapping a fake process handle. The Codex
    // engine captures the per-turn handle into `inFlightHandle` inside send()
    // and forwards cancel() to it — the assertion is on that captured
    // handle's wasCancelled getter, not on a mock wrapper.
    const fakeProc = makeFakeCodexProcessHandle();
    const engine = createCodexChatEngine({
      createProcess: async () => fakeProc,
      hostMcp: { start: async () => undefined, stop: async () => undefined },
    });

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      engine: "codex",
      codexChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // Kick off the turn — fake proc.send() never resolves on its own.
    handler({ type: "send", text: "long-running codex turn" });
    await until(() => fakeProc.started);
    // The in-flight handle MUST NOT have been cancelled yet — only Stop cancels.
    expect(fakeProc.wasCancelled).toBe(false);
    expect(fakeProc.cancel).not.toHaveBeenCalled();

    // The Stop click — panel dispatches Stop → engine.cancel() →
    // inFlightHandle.cancel() synchronously (the engine guards on
    // `inFlightHandle === undefined`, so the live handle is signalled).
    handler({ type: "stop" });
    await until(() => fakeProc.wasCancelled, 200);
    expect(fakeProc.cancel).toHaveBeenCalledTimes(1);
  });

  it("Codex cancel() before any send() is dispatched safely (no live handle ⇒ best-effort)", async () => {
    const factory: AdapterFactory = vi.fn(async () => null);
    const { engine, cancelCalls } = makeFakeCodexChatEngine();

    const panel = new AiChatPanel({
      extensionUri: extUri,
      deps: makeDeps(),
      adapterFactory: factory,
      engine: "codex",
      codexChatEngine: engine,
    });
    panel.show();
    const { panel: p, handler } = panelHarness();
    handler({ type: "ready" });
    await until(() => postedMessages(p).some(isInit));

    // No turn in flight — Stop still dispatches to engine.cancel(); the
    // engine guard (`inFlightHandle === undefined`) is the source of
    // truth, so the fake just records the call without throwing.
    handler({ type: "stop" });
    await new Promise((r) => setTimeout(r, 20));

    expect(engine.cancel).toHaveBeenCalledTimes(1);
    expect(cancelCalls.count).toBe(1);
    expect(engine.send).not.toHaveBeenCalled();
  });
});
