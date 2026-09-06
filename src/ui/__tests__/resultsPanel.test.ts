// src/ui/__tests__/resultsPanel.test.ts
// Unit tests for ResultsPanel — fix round 1 (IMPORTANT #5 BigInt serialization
// + postMessage rejection surfacing).
//
// TASK-RP-001 — the panel is now a `vscode.WebviewViewProvider`. Tests drive
// `render()` and message handler paths by calling `provider.resolveWebviewView`
// against a FakeWebviewView. The legacy `createWebviewPanel` mock and the
// placement settings describe-block are gone — see
// `resultsPanelViewProvider.test.ts` for the new shell's TDD coverage.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- vscode mock -----------------------------------------------------------

type MessageHandler = (msg: unknown) => void;
type DisposeHandler = () => void;

class FakeWebview {
  html = "";
  options: Record<string, unknown> = {};
  private csp = "vscode-resource:webview";
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  onDidReceiveMessage = (h: MessageHandler) => { this.handler = h; return { dispose: () => undefined }; };
  asWebviewUri = (u: unknown) => u;
  get cspSource() { return this.csp; }
  /** Dispatch a message from the webview into the panel handler (test-only). */
  dispatch(msg: unknown) { if (this.handler) this.handler(msg); }
  private handler: MessageHandler | null = null;
}

class FakeWebviewView {
  webview = new FakeWebview();
  visible = true;
  description: string | undefined;
  title: string | undefined;
  viewType = "UnicDB.results";
  /** True after dispose() fires once. The mock uses this to know when
   *  to re-resolve on the next focus call. */
  isDisposed = false;
  private didDisposeHandlers: DisposeHandler[] = [];
  onDidReceiveMessage(h: MessageHandler) { this.webview.onDidReceiveMessage(h); return { dispose: () => undefined }; }
  onDidDispose(h: DisposeHandler) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const h of this.didDisposeHandlers) h();
    if (lastView.current === this) lastView.current = null;
  }
}

const lastView: { current: FakeWebviewView | null } = { current: null };

/** Cached `resolveWebviewView` invocations — the mock implements a
 *  `WebviewViewProvider` whose resolveWebviewView captures the view. Tests
 *  pull `lastView.current` (set at resolve time) to drive messages. */
const registeredProviders: Array<{
  viewId: string;
  options?: unknown;
  provider: { resolveWebviewView: (view: FakeWebviewView) => unknown };
}> = [];

/** Drive the most-recently-registered provider to materialize a fresh
 *  `FakeWebviewView` whenever the live one is missing or has been disposed
 *  (mirrors VS Code's lazy resolve when the bottom panel reopens). The
 *  resulting view is recorded in `lastView.current` and receives a
 *  synchronous `ready` so any buffered `lastResults` flushes immediately. */
function ensureResolved(): FakeWebviewView {
  const entry = registeredProviders[registeredProviders.length - 1];
  if (!entry) {
    throw new Error("ensureResolved: no provider registered yet");
  }
  if (lastView.current && !lastView.current.isDisposed) {
    return lastView.current;
  }
  const v = new FakeWebviewView();
  entry.provider.resolveWebviewView(v);
  lastView.current = v;
  v.webview.dispatch({ type: "ready" });
  return v;
}

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => {
        const out: { fsPath: string; path: string; toString: () => string } = {
          fsPath: "",
          path: "",
          toString: () => "",
        };
        const parts2 = parts.map((p: unknown) => {
          if (typeof p === "string") return p;
          if (!p) return "";
          const obj = p as { fsPath?: string; path?: string };
          return obj.fsPath ?? obj.path ?? "";
        });
        const joined = parts2.join("/");
        out.fsPath = joined;
        out.path = joined;
        out.toString = () => joined;
        return out;
      },
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      registerWebviewViewProvider: (
        viewId: string,
        provider: { resolveWebviewView: (view: FakeWebviewView) => unknown },
        options?: unknown,
      ) => {
        registeredProviders.push({ viewId, options, provider });
        // NOTE: the mock does NOT auto-resolve at register time — VS Code
        // resolves the view lazily on first focus, so any `ready` handshake
        // POSTS the live `lastResults` (not an empty initial state). The
        // `UnicDB-results.focus` executeCommand path below drives that.
        return { dispose: () => undefined };
      },
      showErrorMessage: vi.fn(async () => undefined),
    },
    commands: {
      executeCommand: vi.fn(async (cmd: string, ..._rest: unknown[]) => {
        // The real `UnicDB-results.focus` triggers VS Code to resolve the
        // provider's view if it isn't materialized yet — simulate that.
        if (cmd === "UnicDB-results.focus") {
          ensureResolved();
        }
        return undefined;
      }),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({ get: (_key: string) => undefined })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
    CancellationToken: class {},
    EventEmitter: class { event = () => ({ dispose: () => undefined }); },
  };
});
import * as vscode from "vscode";
import { ResultsPanel, sanitizeStatementResult } from "../resultsPanel";
import type { QueryRunner, StatementResult } from "../../core/queryRunner";

function makeRunnerStub(): QueryRunner {
  return {
    loadMore: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
  } as unknown as QueryRunner;
}

/** Construct a panel AND register it as a `WebviewViewProvider` (the step
 *  `extension.ts` performs at activation). Mirrors the production wiring
 *  closely enough that subsequent `panel.render()` → focus → resolve
 *  chains Just Work via the auto-resolve in the mock. */
function makePanel(opts: { runner: QueryRunner; saveContext?: unknown; title?: string }): ResultsPanel {
  const panel = new ResultsPanel({
    runner: opts.runner,
    saveContext: opts.saveContext as never,
    title: opts.title,
  });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
  // Production step — extension.ts does this; tests inline it.
  vscode.window.registerWebviewViewProvider(
    ResultsPanel.viewId,
    panel as unknown as { resolveWebviewView: (view: FakeWebviewView) => unknown },
    { webviewOptions: { retainContextWhenHidden: true } },
  );
  return panel;
}

/** Construct a panel, render a result set, and resolve a fresh view — a
 *  one-liner for tests that need a fully wired panel with a view. */
function panelWith(
  runner: QueryRunner,
  results: StatementResult[],
  header = "hdr",
): { panel: ResultsPanel; fake: FakeWebviewView } {
  const panel = makePanel({ runner });
  panel.render(results, header);
  const fake = lastView.current!;
  return { panel, fake };
}

/** Resolve a fresh view NOW (re-creates if lastView was disposed). Used by
 *  session-epoch tests that simulate a dispose + recreate cycle. */
function resolveView(_panel?: ResultsPanel): FakeWebviewView {
  // Force a re-resolve by clearing the cached reference.
  lastView.current = null;
  return ensureResolved();
}

beforeEach(() => {
  lastView.current = null;
  registeredProviders.length = 0;
  vi.clearAllMocks();
});

describe("ResultsPanel — sanitizeStatementResult (IMPORTANT #5)", () => {
  it("BigInt trong safe range → number", () => {
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["x"],
        rows: [[BigInt(42)], [BigInt("9007199254740991")]],
        rowCount: 2,
        durationMs: 0,
      },
      durationMs: 0,
    });
    const rows = r.result!.rows;
    expect(typeof rows[0][0]).toBe("number");
    expect(rows[0][0]).toBe(42);
    expect(typeof rows[1][0]).toBe("number");
    expect(rows[1][0]).toBe(9007199254740991);
  });

  it("BigInt vượt MAX_SAFE_INTEGER → string", () => {
    const big = BigInt("9007199254740993"); // MAX_SAFE_INTEGER + 2
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["x"],
        rows: [[big]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    });
    expect(typeof r.result!.rows[0][0]).toBe("string");
    expect(r.result!.rows[0][0]).toBe("9007199254740993");
  });

  it("Date → ISO string", () => {
    const d = new Date("2024-05-06T07:08:09.123Z");
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["d"],
        rows: [[d]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    });
    expect(r.result!.rows[0][0]).toBe("2024-05-06T07:08:09.123Z");
  });

  it("null / undefined giữ nguyên", () => {
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["a", "b"],
        rows: [[null, undefined]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    });
    expect(r.result!.rows[0][0]).toBe(null);
    expect(r.result!.rows[0][1]).toBe(undefined);
  });

  it("BigInt trong nested object → recurse", () => {
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["o"],
        rows: [[{ x: BigInt(7), y: { z: BigInt("99999999999999999999") } }]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    });
    const obj = r.result!.rows[0][0] as unknown as Record<string, unknown>;
    expect(obj.x).toBe(7);
    expect(typeof obj.y.z).toBe("string");
    expect(obj.y.z).toBe("99999999999999999999");
  });

  it("BigInt in array cell", () => {
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["arr"],
        rows: [[[BigInt(1), BigInt(2)]]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    });
    expect(r.result!.rows[0][0]).toEqual([1, 2]);
  });

  it("Circular reference → '[Circular]' (không throw)", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    const r = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: {
        columns: ["o"],
        rows: [[a]],
        rowCount: 1,
        durationMs: 0,
      },
      durationMs: 0,
    });
    const obj = r.result!.rows[0][0] as unknown as Record<string, unknown>;
    expect(obj.x).toBe(1);
    expect(obj.self).toBe("[Circular]");
  });
});

describe("ResultsPanel — postMessage surface (IMPORTANT #5)", () => {
  it("postMessage được gọi với rows đã sanitize (không còn BigInt)", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: {
            columns: ["x"],
            rows: [[BigInt("9007199254740993")]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastView.current!;
    const callArg = fake.webview.postMessage.mock.calls[0][0];
    const rowVal = callArg.results[0].result.rows[0][0];
    expect(typeof rowVal).toBe("string");
    expect(rowVal).toBe("9007199254740993");
  });

  it("postMessage rejection được surface (không void)", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: {
            columns: ["x"],
            rows: [[1]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastView.current!;
    // Mô phỏng postMessage reject.
    fake.webview.postMessage.mockRejectedValueOnce(new Error("DataCloneError: BigInt"));
    // Re-render để trigger lại postMessage.
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 2",
          status: "done",
          result: {
            columns: ["x"],
            rows: [[2]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    // Wait microtask queue để .then reject handler chạy.
    await new Promise((r) => setTimeout(r, 10));
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    const showErr = vscode.window.showErrorMessage as unknown as { mock: { calls: unknown[][] } };
    const msg = String(showErr.mock.calls[0][0]);
    expect(msg).toMatch(/postMessage failed/);
  });

  it("postMessage sync throw cũng được surface", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: {
            columns: ["x"],
            rows: [[1]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastView.current!;
    fake.webview.postMessage.mockImplementationOnce(() => {
      throw new Error("Boom sync");
    });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 2",
          status: "done",
          result: {
            columns: ["x"],
            rows: [[2]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    const showErr = vscode.window.showErrorMessage as unknown as { mock: { calls: unknown[][] } };
    const msg = String(showErr.mock.calls[0][0]);
    expect(msg).toMatch(/postMessage failed/);
  });
});

describe("ResultsPanel — handleMessage loadMore (TASK-204)", () => {
  function newPanel() {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    return { panel, runner, fake: lastView.current! };
  }

  /** Wait until postMessage được gọi với type khớp predicate, hoặc fail. */
  async function waitForPostMessage(
    fake: FakeWebview,
    predicate: (m: { type?: string; busy?: boolean }) => boolean,
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const match = fake.webview.postMessage.mock.calls
        .map((c) => c[0] as { type?: string; busy?: boolean })
        .some(predicate);
      if (match) return;
      await Promise.resolve();
    }
    throw new Error("timeout waiting for postMessage predicate");
  }

  it("busy:true postMessage TRƯỚC khi loadMore resolve", async () => {
    const { runner, fake } = newPanel();
    fake.webview.postMessage.mockClear();
    const { promise, resolve } = Promise.withResolvers<StatementResult[]>();
    runner.loadMore = vi.fn(() => promise) as unknown as typeof runner.loadMore;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === true);
    resolve([]);
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === false);
    const calls = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string });
    expect(calls.some((m) => m.type === "state")).toBe(true);
  });

  it("state cuối chứa updated results từ loadMore (sanitize vẫn chạy)", async () => {
    const { runner, fake } = newPanel();
    fake.webview.postMessage.mockClear();
    const newResults: StatementResult[] = [
      {
        index: 0,
        sql: "SELECT 1",
        status: "done",
        result: {
          columns: ["y"],
          rows: [[BigInt("9007199254740993")]],
          rowCount: 1,
          durationMs: 0,
        },
        durationMs: 0,
      },
    ];
    runner.loadMore = vi.fn(
      async () => newResults,
    ) as unknown as typeof runner.loadMore;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === false);
    const stateMsg = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string })
      .filter((m) => m.type === "state")
      .pop();
    expect(stateMsg).toBeDefined();
    const rowVal = (stateMsg as { results: Array<{ result: { rows: unknown[][] } }> })
      .results[0].result.rows[0][0];
    expect(typeof rowVal).toBe("string");
    expect(rowVal).toBe("9007199254740993");
  });

  it("cancel-during-loadMore (cancelled message) KHÔNG toast — swallow error", async () => {
    const { runner, fake } = newPanel();
    fake.webview.postMessage.mockClear();
    const showErr = vscode.window.showErrorMessage as unknown as { mockClear: () => void };
    showErr.mockClear();
    runner.loadMore = vi.fn(async () => { throw new Error("Statement 0 cancelled"); }) as unknown as typeof runner.loadMore;
    (runner as unknown as { isCancelled?: () => boolean }).isCancelled = () => false;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === false);
    expect((vscode.window.showErrorMessage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    const calls = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string });
    expect(calls.some((m) => m.type === "state")).toBe(true);
  });

  it("cancel-during-loadMore (fetchBatch reject) detect qua isCancelled()", async () => {
    const { runner, fake } = newPanel();
    fake.webview.postMessage.mockClear();
    const showErr = vscode.window.showErrorMessage as unknown as { mockClear: () => void };
    showErr.mockClear();
    runner.loadMore = vi.fn(async () => { throw new Error("another query is in progress"); }) as unknown as typeof runner.loadMore;
    (runner as unknown as { isCancelled?: () => boolean }).isCancelled = () => true;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === false);
    expect((vscode.window.showErrorMessage as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    const calls = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string });
    expect(calls.some((m) => m.type === "state")).toBe(true);
  });

  it("lỗi thật VẪN toast 'Load more failed: ...'", async () => {
    const { runner, fake } = newPanel();
    fake.webview.postMessage.mockClear();
    const showErr = vscode.window.showErrorMessage as unknown as { mockClear: () => void };
    showErr.mockClear();
    runner.loadMore = vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof runner.loadMore;
    (runner as unknown as { isCancelled?: () => boolean }).isCancelled = () => false;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === false);
    const errMock = vscode.window.showErrorMessage as unknown as { mock: { calls: unknown[][] } };
    expect(errMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const lastMsg = String(errMock.mock.calls[errMock.mock.calls.length - 1][0]);
    expect(lastMsg).toBe("Load more failed: connection refused");
  });
  it("closed-cursor loadMore surfaces the run-alone message once and reposts state", async () => {
    const { runner, fake } = newPanel();
    const showErr = vscode.window.showErrorMessage as unknown as { mockClear: () => void; mock: { calls: unknown[][] } };
    showErr.mockClear();
    runner.loadMore = vi.fn(async () => {
      throw new Error("Statement 0 cursor closed after its run finished — run this statement alone");
    }) as unknown as typeof runner.loadMore;

    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessage(fake, (m) => m.type === "busy" && m.busy === false);

    expect(showErr.mock.calls).toHaveLength(1);
    expect(String(showErr.mock.calls[0]?.[0])).toMatch(/run this statement alone/);
    expect(fake.webview.postMessage.mock.calls.some((c) => (c[0] as { type?: string }).type === "state")).toBe(true);
  });
});

describe("ResultsPanel — append-aware render (TASK-AH-002)", () => {
  type Internals = {
    distinctCache: Map<string, unknown>;
    columnTypesByStatement: Map<number, unknown>;
    whereByStatement: Map<number, unknown>;
    tableByStatement: Map<number, unknown>;
    manualStatementIndex: number | null;
    statementGeneration: number;
  };

  function result(index: number, sql = `SELECT * FROM table_${index}`): StatementResult {
    return {
      index,
      sql,
      status: "done",
      result: { columns: ["id"], rows: [[index]], rowCount: 1, durationMs: 0 },
      durationMs: 0,
    };
  }

  it("preserves old-tab caches while invalidating only appended indexes", () => {
    const panel = new ResultsPanel({ runner: makeRunnerStub() });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    const internal = panel as unknown as Internals;
    internal.distinctCache.set("0::id", {});
    internal.distinctCache.set("1::id", {});
    internal.columnTypesByStatement.set(0, {});
    internal.columnTypesByStatement.set(1, {});
    internal.whereByStatement.set(0, {});
    internal.whereByStatement.set(1, {});
    const oldTable = { schema: "public", table: "cached_old" };
    internal.tableByStatement.set(0, oldTable);
    internal.tableByStatement.set(1, { schema: "public", table: "stale_new" });
    internal.manualStatementIndex = 1;
    const generation = internal.statementGeneration;

    panel.render([result(0), result(1)], "hdr", { appendBase: 1 });

    expect(internal.distinctCache.has("0::id")).toBe(true);
    expect(internal.distinctCache.has("1::id")).toBe(false);
    expect(internal.columnTypesByStatement.has(0)).toBe(true);
    expect(internal.columnTypesByStatement.has(1)).toBe(false);
    expect(internal.whereByStatement.has(0)).toBe(true);
    expect(internal.whereByStatement.has(1)).toBe(false);
    expect(internal.tableByStatement.get(0)).toBe(oldTable);
    expect(internal.tableByStatement.get(1)).toEqual({ table: "table_1" });
    expect(internal.manualStatementIndex).toBeNull();
    expect(internal.statementGeneration).toBe(generation + 1);
  });

  it("appendBase at or beyond the result edge preserves caches and generation", () => {
    const panel = new ResultsPanel({ runner: makeRunnerStub() });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    const internal = panel as unknown as Internals;
    internal.distinctCache.set("0::id", {});
    const generation = internal.statementGeneration;

    panel.render([result(0)], "hdr", { appendBase: 1 });
    panel.render([result(0)], "hdr", { appendBase: 2 });

    expect(internal.distinctCache.has("0::id")).toBe(true);
    expect(internal.statementGeneration).toBe(generation);
  });
});

// ---- TASK-006 (cycle X) — P3-3: sanitizeStatementResult must emit a
// boolean `batched` on the wire (the webview-facing type declares
// `batched?: boolean`); the live BatchedQuery handle (functions inside)
// must never reach postMessage's structured clone.
describe("ResultsPanel — sanitizeStatementResult batched wire shape (TASK-006 P3-3)", () => {
  function functionBearingBatched() {
    return {
      columns: ["id"],
      fetchBatch: async () => [[1]],
      cancel: async () => undefined,
      close: async () => undefined,
    };
  }

  it("state post carries boolean batched, never the live cursor handle", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT * FROM t",
          status: "done",
          result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 0 },
          batched: functionBearingBatched(),
          durationMs: 0,
        },
      ],
      "Run at T — postgres@h/db",
    );
    const fake = lastView.current!;
    const stateMsg = fake.webview.postMessage.mock.calls[0][0] as {
      results: Array<Record<string, unknown>>;
    };
    const posted = stateMsg.results[0];
    // RED today: the spread ships the whole handle object.
    expect(posted.batched).toBe(true);
    expect(typeof posted.batched).toBe("boolean");
    // No function-valued property survives anywhere on the statement entry.
    const hasFunction = (value: unknown, depth = 0): boolean => {
      if (depth > 4 || value === null || typeof value !== "object") return false;
      return Object.values(value).some(
        (v) => typeof v === "function" || hasFunction(v, depth + 1),
      );
    };
    expect(hasFunction(posted)).toBe(false);
  });

  it("result-less statement is still normalized (early-return branch)", () => {
    const withHandle = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: undefined,
      batched: functionBearingBatched(),
      durationMs: 0,
    });
    expect(withHandle.batched).toBe(true);
    expect(withHandle.result).toBeUndefined();

    const withoutBatched = sanitizeStatementResult({
      index: 0,
      sql: "SELECT 1",
      status: "done",
      result: undefined,
      durationMs: 0,
    });
    expect(withoutBatched.batched).toBe(false);
  });
});

// ---- TASK-007 (cycle Y) — typed StateMessage.dialect + positional columnTypes
describe("ResultsPanel — typed state dialect + declared columnTypes (TASK-007 cycle Y)", () => {
  function makePanelWithSaveContext(
    saveContext?: Record<string, unknown>,
    header = "Run at 2026-08-26T00:00:00.000Z — mysql@localhost/db",
  ) {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({
      runner,
      ...(saveContext ? { saveContext: saveContext as never } : {}),
    });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT * FROM users",
          status: "done",
          result: { columns: ["id"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      header,
    );
    return { panel, runner, fake: lastView.current! };
  }

  function stateMsgs(fake: FakeWebview) {
    return fake.webview.postMessage.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.type === "state");
  }

  it("T7.1 happy — every state post carries dialect from saveContext.getDriver()", async () => {
    const { fake } = makePanelWithSaveContext({
      getDriver: () => "mysql",
      listPkColumns: async () => [],
    });
    const initial = stateMsgs(fake);
    expect(initial.length).toBeGreaterThan(0);
    for (const m of initial) {
      expect(m.dialect).toBe("mysql");
    }

    // A later state post (loadMore path) carries it too.
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await waitForPostMessageType(fake, "state");
    const later = stateMsgs(fake);
    expect(later.length).toBeGreaterThan(0);
    for (const m of later) {
      expect(m.dialect).toBe("mysql");
    }
  });

  it("T7.6 edge — no active driver ⇒ dialect key is OMITTED, never invented", async () => {
    // saveContext present but driver null…
    {
      const { fake } = makePanelWithSaveContext({
        getDriver: () => null,
        listPkColumns: async () => [],
      });
      const msgs = stateMsgs(fake);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) {
        expect(m.dialect).toBeUndefined();
        expect("dialect" in m).toBe(false);
      }
    }
    // …and NO saveContext at all.
    {
      const { fake } = makePanelWithSaveContext(undefined);
      const msgs = stateMsgs(fake);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) {
        expect("dialect" in m).toBe(false);
      }
    }
  });

  it("T7.columnTypes happy — gated direct-table statement attaches a POSITIONAL map ordered by result columns", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({
      runner,
      saveContext: {
        getDriver: () => "postgres",
        listPkColumns: async () => [],
        listColumnTypes: async () => ({ id: "int4", name: "varchar" }),
      } as never,
    });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: 'SELECT id, name FROM "public"."users"',
          status: "done",
          result: {
            columns: ["name", "id"],
            rows: [["a", 1]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastView.current!;
    // listColumnTypes is ASYNC and render() is synchronous, so the typed
    // map lands on the panel's own upgrade re-post once metadata resolves.
    // Flush microtasks until it shows up (bounded).
    let typed: Record<string, string> | undefined;
    for (let i = 0; i < 200 && !typed; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      const m = stateMsgs(fake).find((s) => s.columnTypes !== undefined);
      typed = m?.columnTypes as Record<string, string> | undefined;
    }
    // Projection order is (name, id), so ordinals are 0→varchar, 1→int4 —
    // keyed by ordinal to avoid duplicate-name ambiguity.
    expect(typed).toEqual({ "0": "varchar", "1": "int4" });
  });

  it("T7.columnTypes edge — ungated SQL or missing metadata ⇒ no columnTypes key", async () => {
    // Non-browse SQL (aggregate): gate refuses ⇒ map omitted even though
    // listColumnTypes exists.
    {
      const runner = makeRunnerStub();
      const panel = new ResultsPanel({
        runner,
        saveContext: {
          getDriver: () => "postgres",
          listPkColumns: async () => [],
          listColumnTypes: async () => ({ id: "int4" }),
        } as never,
      });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
      panel.render(
        [
          {
            index: 0,
            sql: "SELECT count(*) FROM t",
            status: "done",
            result: { columns: ["count"], rows: [[3]], rowCount: 1, durationMs: 0 },
            durationMs: 0,
          },
        ],
        "hdr",
      );
      const fake = lastView.current!;
      for (const m of stateMsgs(fake)) {
        expect(m.columnTypes).toBeUndefined();
      }
    }
    // Browse-shaped SQL but no table metadata and no listColumnTypes:
    {
      const { fake } = makePanelWithSaveContext(undefined, "hdr");
      for (const m of stateMsgs(fake)) {
        expect(m.columnTypes).toBeUndefined();
      }
    }
  });
});

async function waitForPostMessageType(
  fake: FakeWebview,
  type: string,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const match = fake.webview.postMessage.mock.calls.some(
      (c) => (c[0] as { type?: string }).type === type,
    );
    if (match) return;
    await Promise.resolve();
  }
  throw new Error(`timeout waiting for ${type} postMessage`);
}

describe("ResultsPanel — header (A14)", () => {
  it('render(results, "Browse x at T") → the render post AND every later post (e.g. "ready") carry that header, not blank', async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "Browse x at T",
    );
    const fake = lastView.current!;
    const firstState = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; header?: string })
      .find((m) => m.type === "state");
    expect(firstState?.header).toBe("Browse x at T");

    // A14 regression: `this.header` was never assigned in render(), so a
    // LATER post (the "ready" handshake re-sends the last known state)
    // sent an empty string instead of the real header.
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({ type: "ready" });
    for (let i = 0; i < 200; i++) {
      if (fake.webview.postMessage.mock.calls.length > 0) break;
      await Promise.resolve();
    }
    const readyState = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; header?: string })
      .find((m) => m.type === "state");
    expect(readyState?.header).toBe("Browse x at T");
    expect(readyState?.header).not.toBe("");
  });
});


// =============================================================================
// TASK-RLX02-003 — runner-aware webview cancel path.
// =============================================================================
describe("ResultsPanel — TASK-RLX02-003 cancel path", () => {
  /** Local bounded wait (same shape as the loadMore helper above). */
  async function waitForBusyPost(
    fake: FakeWebviewView,
    busy: boolean,
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const match = fake.webview.postMessage.mock.calls.some(
        (c) =>
          (c[0] as { type?: string; busy?: boolean }).type === "busy" &&
          (c[0] as { type?: string; busy?: boolean }).busy === busy,
      );
      if (match) return;
      await Promise.resolve();
    }
    throw new Error(`timeout waiting for busy:${busy} postMessage`);
  }

  function busyPanel(): {
    panel: ResultsPanel;
    runner: QueryRunner;
    fake: FakeWebviewView;
  } {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "running",
          result: undefined,
          durationMs: 0,
        },
      ],
      "hdr",
    );
    // Simulate the host marking the panel busy before the cancel arrives —
    // mirrors runStatements()'s panel.setBusy(true) call.
    panel.setBusy(true);
    return { panel, runner, fake: lastView.current! };
  }

  it("Test #4 — deferred webview cancel keeps busy:true until runner.cancel() settles", async () => {
    const { panel, runner, fake } = busyPanel();
    fake.webview.postMessage.mockClear();
    // runner.cancel() is a DEFERRED promise — must NOT resolve until we let it.
    let resolveCancel: (() => void) | null = null;
    const cancelSpy = vi.fn(
      () => new Promise<void>((resolve) => { resolveCancel = resolve; }),
    );
    (runner as unknown as { cancel: () => Promise<void> }).cancel = cancelSpy;

    fake.webview.dispatch({ type: "cancel" });
    // Yield several microtasks — runner.cancel() must still be pending.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    const messages = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; busy?: boolean });
    // While the deferred seam is pending, no `busy:false` post is allowed —
    // and no `state` post is allowed either.
    expect(messages.some((m) => m.type === "busy" && m.busy === false)).toBe(false);

    // Now resolve the seam — the panel must clear busy exactly once.
    if (resolveCancel) resolveCancel();
    await waitForBusyPost(fake, false);
    const cleared = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; busy?: boolean })
      .filter((m) => m.type === "busy" && m.busy === false);
    expect(cleared).toHaveLength(1);
  });

  it("Test #2 — post-settlement cancel preserves done state and never toasts a cancellation error", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    // Render a settled 'done' result with no in-flight work.
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastView.current!;
    const showErr = vscode.window.showErrorMessage as unknown as {
      mockClear: () => void;
      mock: { calls: unknown[][] };
    };
    showErr.mockClear();
    fake.webview.postMessage.mockClear();
    // No seam is even registered — late cancel must NOT touch the adapter.
    (runner as unknown as { cancel: () => Promise<void> }).cancel = vi.fn(async () => undefined);

    fake.webview.dispatch({ type: "cancel" });
    await new Promise((r) => setTimeout(r, 20));

    const errors = showErr.mock.calls.map((c) => String(c[0]));
    const noise = errors.find((m) =>
      /UnicDB:|Load more failed:|UnicDB requery failed:/.test(m) &&
      /cancel/i.test(m),
    );
    expect(noise).toBeUndefined();
  });
});



// =============================================================================
// TASK-ARP02-002 — session-epoch guard: a deferred continuation whose panel
// was disposed (and optionally re-created by a later render()) must return
// silently — no postMessage, no busy write, no toast — into the NEW session.
// The epoch is bumped in dispose() AND onDidDispose; continuations capture it
// before their first await and re-check after every await.
// =============================================================================
describe("ResultsPanel — TASK-ARP02-002 session epoch (panel-close race)", () => {
  /** Bounded wait: flush microtasks/timers until a predicate over the given
   *  fake's postMessage calls holds, or fail. */
  async function until(
    fake: FakeWebview,
    predicate: (msgs: Array<Record<string, unknown>>) => boolean,
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const msgs = fake.webview.postMessage.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      if (predicate(msgs)) return;
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("timeout in session-epoch test helper");
  }

  /** Statement result with the OLD SQL — what a stale continuation would
   *  wrongly post into a recreated panel. */
  function oldSqlResult(sql: string): StatementResult {
    return {
      index: 0,
      sql,
      status: "done",
      result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
      durationMs: 0,
    };
  }

  const showErrMock = () =>
    vscode.window.showErrorMessage as unknown as {
      mockClear: () => void;
      mock: { calls: unknown[][] };
    };

  // ---- Case 1 — happy: close idle panel → exactly-once cleanup, no message.
  it("case 1: close idle panel — rollback no-ops (0 calls), no postMessage, no toast", async () => {
    const runner = makeRunnerStub();
    const { panel, fake } = panelWith(runner, [oldSqlResult("SELECT 1")]);
    fake.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Idle panel: no open transaction → dispose() must not attempt a rollback.
    panel.dispose();

    expect(fake.webview.postMessage).not.toHaveBeenCalled();
    expect(showErrMock().mock.calls).toHaveLength(0);
    // Panel is torn down. A subsequent render triggers focus + buffered
    // state, but no webview-side message reaches the disposed view until
    // VS Code re-resolves it — and then the new view gets the new render.
    panel.render([oldSqlResult("SELECT 2")], "hdr");
    const recreated = resolveView(panel);
    const recreatedStates = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; results?: Array<{ sql?: string }> })
      .filter((m) => m.type === "state")
      .filter((m) => (m.results ?? []).some((r) => r.sql === "SELECT 2"));
    expect(recreatedStates.length).toBeGreaterThan(0);
  });

  // ---- Case 2 — edge: dispose-during-run, deferred loadMore, recreate panel.
  // RED on base 367cb80: the stale resolution posts the OLD SQL `state` into
  // the NEW panel.
  it("case 2: deferred loadMore; dispose; recreate — stale resolution posts NOTHING to the new panel", async () => {
    const runner = makeRunnerStub();
    const deferred = Promise.withResolvers<StatementResult[]>();
    runner.loadMore = vi.fn(() => deferred.promise) as unknown as typeof runner.loadMore;
    const { panel, fake } = panelWith(runner, [oldSqlResult("SELECT old_sql FROM old_table")]);

    fake.webview.dispatch({ type: "loadMore", index: 0 });
    // loadMore is pending — flush a bit so setBusy(true) already fired.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Dispose during the deferred run, then recreate the panel session.
    panel.dispose();
    panel.render([oldSqlResult("SELECT new_sql FROM new_table")], "hdr");
    const recreated = resolveView(panel);
    expect(recreated).not.toBe(fake);
    recreated.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Stale continuation resolves NOW — after the recreate.
    deferred.resolve([oldSqlResult("SELECT old_sql FROM old_table")]);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    // The recreated panel must NOT receive the stale old-SQL state post.
    const staleState = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; results?: Array<{ sql?: string }> })
      .filter((m) => m.type === "state")
      .filter((m) => (m.results ?? []).some((r) => r.sql === "SELECT old_sql FROM old_table"));
    expect(staleState).toHaveLength(0);
    expect(showErrMock().mock.calls).toHaveLength(0);
  });

  // ---- Case 3 — edge: dispose-during-run, deferred handleRequery, recreate.
  // RED on base 367cb80 (same epoch gap): the stale requery resolution toasts
  // and/or posts into the recreated panel.
  it("case 3: deferred requery; dispose; recreate — stale resolution returns SILENTLY", async () => {
    const runner = makeRunnerStub();
    const deferredRun = Promise.withResolvers<import("../../core/queryRunner").RunResult>();
    // closeStatementCursor sees no batched cursor (status done, no batched) →
    // no-op; runSql is the deferred seam.
    (runner as unknown as { runSql: unknown }).runSql = vi.fn(() => deferredRun.promise);
    const results = [oldSqlResult("SELECT * FROM users")];
    const panel = new ResultsPanel({
      runner,
      saveContext: { getDriver: () => null, listPkColumns: async () => [] } as never,
    });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(results, "hdr");
    const fake = resolveView(panel);

    fake.webview.dispatch({ type: "requery", index: 0, where: "", orderBy: "" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    panel.dispose();
    panel.render([oldSqlResult("SELECT * FROM users_after")], "hdr");
    const recreated = resolveView(panel);
    recreated.webview.postMessage.mockClear();
    showErrMock().mockClear();

    deferredRun.resolve({
      results: [
        {
          columns: ["x"],
          rows: [[9]],
          rowCount: 1,
          durationMs: 0,
        },
      ],
    });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(showErrMock().mock.calls).toHaveLength(0);
    const staleState = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; results?: Array<{ sql?: string }> })
      .filter((m) => m.type === "state")
      .filter((m) => (m.results ?? []).some((r) => r.sql === "SELECT * FROM users"));
    expect(staleState).toHaveLength(0);
  });

  // ---- Case 4 — edge: rollback runs EXACTLY ONCE across dispose×2 + onDidDispose.
  it("case 4: dispose twice + onDidDispose — rollback executed exactly once", async () => {
    const runner = makeRunnerStub();
    const rollback = vi.fn(async () => undefined);
    const fakeTx = { runQuery: vi.fn(async () => ({ results: [] })), commit: vi.fn(async () => undefined), rollback } as unknown as import("../../adapters/types").DbTransaction;
    const { panel, fake } = panelWith(runner, [oldSqlResult("SELECT 1")]);
    (panel as unknown as { transaction: unknown }).transaction = fakeTx;

    // dispose() #1 → panel.dispose() → FakeWebviewView.dispose() fires
    // onDidDispose handlers → panel=null. dispose() #2 is a no-op teardown.
    panel.dispose();
    panel.dispose();
    // Direct onDidDispose firing again (belt-and-braces: both paths can run).
    fake.dispose();
    // Let the fire-and-forget rollback settle.
    await new Promise((r) => setTimeout(r, 10));

    expect(rollback).toHaveBeenCalledTimes(1);
  });

  // ---- Case 5 — edge: busy — dispose during run; new run setBusy(true);
  // stale finally must NOT clear the NEW session's busy state.
  // RED on base 367cb80: the stale continuation's finally posted busy:false
  // into the recreated panel.
  it("case 5: dispose mid-loadMore; recreate; setBusy(true) — stale finally never posts busy:false", async () => {
    const runner = makeRunnerStub();
    const deferred = Promise.withResolvers<StatementResult[]>();
    runner.loadMore = vi.fn(() => deferred.promise) as unknown as typeof runner.loadMore;
    const { panel, fake } = panelWith(runner, [oldSqlResult("SELECT 1")]);

    fake.webview.dispatch({ type: "loadMore", index: 0 });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    panel.dispose();
    panel.render([oldSqlResult("SELECT 1")], "hdr");
    const recreated = lastView.current!;
    recreated.webview.postMessage.mockClear();

    // The NEW session starts a run and marks itself busy.
    panel.setBusy(true);
    await until(recreated, (msgs) => msgs.some((m) => m.type === "busy" && m.busy === true));

    // Stale continuation settles NOW.
    deferred.resolve([oldSqlResult("SELECT 1")]);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    const busyFalse = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; busy?: boolean })
      .filter((m) => m.type === "busy" && m.busy === false);
    expect(busyFalse).toHaveLength(0);
  });

  // ---- Case 6 — regression: postMessage after dispose (panel null) is a
  // silent no-op; render() after dispose still creates a working panel.
  it("case 6: postMessage after dispose is a silent no-op; render() recreates a working panel", async () => {
    const runner = makeRunnerStub();
    const { panel, fake } = panelWith(runner, [oldSqlResult("SELECT 1")]);
    const postsBefore = fake.webview.postMessage.mock.calls.length;
    panel.dispose();
    expect(fake.webview.postMessage.mock.calls.length).toBe(postsBefore);

    // setBusy posts nothing while panel is null.
    panel.setBusy(true);
    panel.setBusy(false);
    expect(fake.webview.postMessage.mock.calls.length).toBe(postsBefore);

    // render() after dispose recreates a working panel.
    panel.render([oldSqlResult("SELECT 2")], "hdr");
    const recreated = lastView.current!;
    expect(recreated).not.toBe(fake);
    const stateMsg = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string })
      .find((m) => m.type === "state");
    expect(stateMsg).toBeDefined();
  });

  // ---- Case 7 — edge: dispose-during-save; recreate; stale save continuation
  // must NOT post a saveResult refusal ack into the recreated panel.
  // RED on base 0652c75: the epoch guards at resultsPanel.ts:973 and :978
  // read `isStaleSession(this.sessionEpoch)` — the CURRENT epoch — so they
  // can never detect staleness (Reviewer Round 1 finding 1). A dispose
  // during `await closeStatementCursor` / `await listPkColumns` leaves the
  // save flow running, and the no_pk refusal ack at :1076 lands in the
  // RE-CREATED panel.
  it("case 7: dispose-during-save; recreate; stale save refusal posts NOTHING to the new panel", async () => {
    const runner = makeRunnerStub();
    // mysql + no PK + a cell edit → buildSaveStatements hard-refuses no_pk,
    // so the post-listPkColumns continuation reaches the :1076 refusal ack
    // with NO further DB dependency (no fetchPostgresCtids on mysql).
    const listPk = Promise.withResolvers<string[]>();
    const saveCtx = {
      getDriver: () => "mysql" as const,
      listPkColumns: () => listPk.promise,
    } as never;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render([oldSqlResult("SELECT * FROM app.users")], "hdr");
    const fake = lastView.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 0, value: "x" }],
    });
    // Flush until the flow parks on the deferred listPk await.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Dispose mid-save, then recreate the panel session.
    panel.dispose();
    panel.render([oldSqlResult("SELECT * FROM app.orders")], "hdr");
    const recreated = lastView.current!;
    expect(recreated).not.toBe(fake);
    recreated.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Stale save continuation resumes NOW — after the recreate.
    listPk.resolve([]);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    const staleSaveResults = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; ok?: boolean })
      .filter((m) => m.type === "saveResult");
    expect(staleSaveResults).toHaveLength(0);
  });

  // ---- Case 8 — edge: dispose during a MANUAL-commit save; recreate; the
  // stale continuation must NOT post `saveResult ok:true` into the recreated
  // panel. RED on base 0652c75: the success ack at resultsPanel.ts:1251-1259
  // has NO epoch guard in manual-commit mode (the :1210 guard lives inside
  // the `if (!manualCommit)` auto-refresh branch and is never reached for
  // manual saves — Reviewer Round 1 finding 2).
  it("case 8: dispose mid manual-commit save; recreate; stale ok:true posts NOTHING to the new panel", async () => {
    const runner = makeRunnerStub();
    const runQueryDef = Promise.withResolvers<unknown>();
    const fakeTx = {
      runQuery: vi.fn(() => runQueryDef.promise),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    } as unknown as import("../../adapters/types").DbTransaction;
    runner.beginTransaction = vi.fn(
      async () => fakeTx,
    ) as unknown as typeof runner.beginTransaction;
    const saveCtx = {
      getDriver: () => "postgres" as const,
      getManualCommit: () => true,
      listPkColumns: async () => ["id"],
    } as never;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM public.users",
          status: "done",
          result: {
            columns: ["id", "name"],
            rows: [[1, "alice"]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const fake = lastView.current!;
    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "new-alice" }],
    });
    // Flush until the save parks inside the deferred tx.runQuery.
    for (let i = 0; i < 20 && (runner.beginTransaction as ReturnType<typeof vi.fn>).mock.calls.length === 0; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((runner.beginTransaction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);

    // Dispose mid-save, then recreate the panel session.
    panel.dispose();
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT id, name FROM public.orders",
          status: "done",
          result: {
            columns: ["id", "name"],
            rows: [[1, "order-1"]],
            rowCount: 1,
            durationMs: 0,
          },
          durationMs: 0,
        },
      ],
      "hdr",
    );
    const recreated = lastView.current!;
    expect(recreated).not.toBe(fake);
    recreated.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Stale save continuation resumes NOW — after the recreate.
    runQueryDef.resolve({ results: [] });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    const staleSaveResults = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; ok?: boolean })
      .filter((m) => m.type === "saveResult");
    expect(staleSaveResults).toHaveLength(0);
  });
});


// =============================================================================
// TASK-ARP03-003 — panel state: limited statements ride the wire without an
// error toast. Three panel-side behaviors:
//   #1 `resultLimited` is a top-level StatementResult field that MUST survive
//      sanitizeStatementResult (spread) so the webview can render distinct
//      limited copy (TASK-ARP03-004 owns the model sync).
//   #2 a loadMore rejection while the statement is `resultLimited` is
//      swallowed at the panel boundary (DEFENSIVE/UNIT-LEVEL: the real
//      runner's limited-entry guard makes loadMore a no-throw no-op; this
//      pins the panel's own suppression branch, mirroring the cancel branch).
//   #4 save/refresh of a limited statement strips `resultLimited`/`cursorClosed`
//      from the `{ ...r }` spread — copying them onto a fresh open cursor
//      gates loadMore forever (runner's limited-entry guard) and excludes the
//      fresh cursor from run()'s stale-cursor sweep (pins the pool client).
// =============================================================================
describe("ResultsPanel — TASK-ARP03-003 limited statements (wire + silent loadMore + save-refresh leak pin)", () => {
  /** Bounded wait until a predicate over ALL postMessage calls holds. */
  async function untilPost(
    fake: FakeWebview,
    predicate: (msgs: Array<Record<string, unknown>>) => boolean,
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const msgs = fake.webview.postMessage.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      if (predicate(msgs)) return;
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("timeout waiting for postMessage predicate (ARP03-003)");
  }

  function stateMsgsOf(fake: FakeWebview): Array<Record<string, unknown>> {
    return fake.webview.postMessage.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.type === "state");
  }

  const showErrMock = () =>
    vscode.window.showErrorMessage as unknown as {
      mockClear: () => void;
      mock: { calls: unknown[][] };
    };

  function limitedStatement(overrides?: Partial<StatementResult>): StatementResult {
    return {
      index: 0,
      sql: "SELECT * FROM app.users",
      status: "done",
      result: {
        columns: ["id", "name"],
        rows: [[1, "alice"]],
        rowCount: 1,
        durationMs: 0,
      },
      resultLimited: true,
      durationMs: 0,
      ...overrides,
    };
  }

  // ---- Case 1 — happy: the limited marker rides the wire --------------------
  it("ARP03-003 #1 — limited statement rides every state post (resultLimited survives sanitize), no render-time error", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    showErrMock().mockClear();
    panel.render([limitedStatement()], "hdr");
    const fake = lastView.current!;

    // The render post carries the marker.
    let states = stateMsgsOf(fake);
    expect(states.length).toBeGreaterThan(0);
    for (const m of states) {
      const posted = (m.results as Array<Record<string, unknown>>)[0];
      expect(posted.resultLimited).toBe(true);
    }
    expect(showErrMock().mock.calls).toHaveLength(0);

    // A LATER re-post (the "ready" handshake re-sends last state) carries it
    // too — "every state post" is the wire contract for 03.4.
    fake.webview.postMessage.mockClear();
    fake.webview.dispatch({ type: "ready" });
    await untilPost(fake, (msgs) => msgs.some((m) => m.type === "state"));
    states = stateMsgsOf(fake);
    for (const m of states) {
      const posted = (m.results as Array<Record<string, unknown>>)[0];
      expect(posted.resultLimited).toBe(true);
    }
    expect(showErrMock().mock.calls).toHaveLength(0);
  });

  // ---- Case 2 — edge (DEFENSIVE/UNIT-LEVEL): limited rejection is silent ----
  it("ARP03-003 #2 (DEFENSIVE/UNIT-LEVEL) — loadMore rejection on a limited statement is silent at the panel boundary, stale state reposted", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    // Pre-populate lastResults with a LIMITED statement via an initial render.
    panel.render([limitedStatement()], "hdr");
    const fake = lastView.current!;
    fake.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Synthetic rejecting stub at the panel boundary. The REAL runner's
    // limited-entry guard (queryRunner.ts:397-399) makes this a no-throw
    // no-op; this test pins the panel's OWN suppression branch — reachable
    // only through this stub.
    runner.loadMore = vi.fn(async () => {
      throw new Error(
        "Statement 0 cursor closed after its run finished — run this statement alone to page more rows",
      );
    }) as unknown as typeof runner.loadMore;
    (runner as unknown as { isCancelled?: () => boolean }).isCancelled = () => false;

    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await untilPost(
      fake,
      (msgs) =>
        msgs.some((m) => m.type === "busy" && (m as { busy?: boolean }).busy === false),
    );

    // NO "Load more failed" toast — the limited branch mirrors the cancel
    // branch's suppression.
    expect(showErrMock().mock.calls).toHaveLength(0);
    // The catch still re-posts the (stale) lastResults as state so the
    // webview clears its in-flight flag.
    const states = stateMsgsOf(fake);
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1];
    const posted = (last.results as Array<Record<string, unknown>>)[0];
    expect(posted.resultLimited).toBe(true);
  });

  // ---- Case 3 — regression pin: non-limited errors still toast --------------
  it("ARP03-003 #3 (regression pin) — genuine loadMore error on a NON-limited statement still toasts exactly once", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    // NO resultLimited on this statement.
    panel.render([limitedStatement({ resultLimited: undefined })], "hdr");
    const fake = lastView.current!;
    fake.webview.postMessage.mockClear();
    showErrMock().mockClear();

    runner.loadMore = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof runner.loadMore;
    (runner as unknown as { isCancelled?: () => boolean }).isCancelled = () => false;

    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await untilPost(
      fake,
      (msgs) =>
        msgs.some((m) => m.type === "busy" && (m as { busy?: boolean }).busy === false),
    );

    expect(showErrMock().mock.calls).toHaveLength(1);
    expect(String(showErrMock().mock.calls[0][0])).toBe(
      "Load more failed: connection refused",
    );
  });

  // ---- Case 4 — leak pin: save/refresh strips the markers -------------------
  it("ARP03-003 #4 (leak pin) — save/refresh of a limited statement strips resultLimited + cursorClosed from the fresh statement; a later loadMore reaches the runner", async () => {
    const runner = makeRunnerStub();
    // AUTO path (default, no getManualCommit): handleSaveEdits' auto-refresh
    // (:1234-1250) builds newStmt via `{ ...r, ... }` — the leak seam.
    // runSql is called twice (save bundle + refresh SELECT); one mock
    // resolving a FRESH non-limited result covers both.
    const freshRunResult = {
      results: [
        {
          columns: ["id", "name"],
          rows: [[42, "fresh-row"]],
          rowCount: 1,
          durationMs: 0,
        },
      ],
    };
    (runner as unknown as { runSql: unknown }).runSql = vi.fn(
      async () => freshRunResult,
    );
    const saveCtx = {
      getDriver: () => "mysql" as const,
      listPkColumns: async () => ["id"],
    } as never;
    const panel = new ResultsPanel({ runner, saveContext: saveCtx });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    // Limited statement: BOTH markers set (002 sets them together), plus a
    // (closed) cursor handle so closeStatementCursor has something to close.
    panel.render(
      [
        limitedStatement({
          cursorClosed: true,
          batched: {
            columns: ["id", "name"],
            fetchBatch: async () => null,
            close: async () => undefined,
            cancel: async () => undefined,
          } as never,
        }),
      ],
      "hdr",
    );
    const fake = lastView.current!;
    fake.webview.postMessage.mockClear();
    showErrMock().mockClear();

    fake.webview.dispatch({
      type: "saveEdits",
      index: 0,
      tableName: null,
      pkColumns: [],
      edits: [{ rowId: 0, colIndex: 1, value: "new-alice" }],
    });
    // Wait until the auto-refresh state post lands (fresh row visible).
    await untilPost(
      fake,
      (msgs) =>
        msgs.some(
          (m) =>
            m.type === "state" &&
            ((m as { results?: Array<{ result?: { rows?: unknown[][] } }> })
              .results?.[0]?.result?.rows?.[0]?.[0] === 42),
        ),
    );

    // The LAST state post's refreshed statement must have BOTH markers
    // stripped. RED on base: the `{ ...r }` spread copies resultLimited=true
    // and cursorClosed=true onto the fresh cursor.
    const states = stateMsgsOf(fake);
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1];
    const posted = (last.results as Array<Record<string, unknown>>)[0];
    expect(posted.resultLimited).toBeFalsy();
    expect("resultLimited" in posted).toBe(false);
    expect(posted.cursorClosed).toBeFalsy();
    expect("cursorClosed" in posted).toBe(false);
    expect(showErrMock().mock.calls).toHaveLength(0);

    // The fresh cursor is not gated: a following loadMore dispatch reaches
    // the runner stub.
    (runner.loadMore as ReturnType<typeof vi.fn>).mockClear();
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    await untilPost(
      fake,
      (msgs) =>
        msgs.some((m) => m.type === "busy" && (m as { busy?: boolean }).busy === false),
    );
    expect(runner.loadMore).toHaveBeenCalledWith(0);
  });
});


// =============================================================================
// TASK-BQ03-004 — BigQuery job states on the wire + token-gated Load More.
// Constraints (from the task file):
//  - `StatementResult.pending?: boolean` (added by 03.3) rides the wire via
//    `sanitizeStatementResult`'s `...r` spread without an explicit slot.
//  - `result.status` + `result.pending` + `resultLimited` + `cursorClosed` are
//    orthogonal axes; none of them is collapsed by the host.
//  - Load More fires only when the statement has a continuation capability
//    (`batched !== false && !cursorClosed`). Token-less / closed-cursor
//    statements are silent no-ops at the panel boundary: no runner call,
//    no busy flip, no error toast — state is re-posted unchanged so the
//    webview clears any in-flight flag.
//  - Epoch / generation guards (`sessionEpoch` / `requerySeq` /
//    `statementGeneration`) hold across BigQuery loadMore paths so a
//    disposed panel or a newer render/requery never receives or overwrites
//    state from a stale completion.
// =============================================================================
describe("ResultsPanel — BQ-03.4 BigQuery states", () => {
  /** Bounded wait for any postMessage call whose payload matches `pred`. */
  async function until(
    fake: FakeWebview,
    pred: (msgs: Array<Record<string, unknown>>) => boolean,
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const msgs = fake.webview.postMessage.mock.calls.map(
        (c) => c[0] as Record<string, unknown>,
      );
      if (pred(msgs)) return;
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }
    throw new Error("timeout waiting for postMessage predicate (BQ-03.4)");
  }

  function stateMsgs(fake: FakeWebview): Array<Record<string, unknown>> {
    return fake.webview.postMessage.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.type === "state");
  }

  const showErrMock = () =>
    vscode.window.showErrorMessage as unknown as {
      mockClear: () => void;
      mock: { calls: unknown[][] };
    };

  // ---- Test #1 — happy: pending/running states are distinct on the wire ----
  // "a BigQuery statement rendered with status: 'running' while its job is
  // pending shows the busy/spinner affordance; after settle with rows it
  // shows done — the two posted state messages differ in the statement's
  // status and the busy flag."
  it("#1 — pending(running) and done ride the wire as distinct state posts; the pending field flows through sanitize", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    // The runner flow calls setBusy(true) before posting the pending snapshot.
    panel.setBusy(true);
    const pendingStmt = {
      index: 0,
      sql: "SELECT * FROM bigquery.project.dataset.t",
      status: "running" as const,
      result: undefined,
      pending: true,
      durationMs: 0,
    };
    panel.render([pendingStmt as unknown as StatementResult], "bq-hdr");
    const fake = lastView.current!;
    fake.webview.postMessage.mockClear();

    // The render post for the pending snapshot: busy:true, status:'running',
    // pending:true on the result.
    panel.render([pendingStmt as unknown as StatementResult], "bq-hdr");
    const pendingPost = stateMsgs(fake).find(
      (m) =>
        Array.isArray(m.results) &&
        ((m.results as Array<Record<string, unknown>>)[0]?.status === "running"),
    );
    expect(pendingPost).toBeDefined();
    expect(pendingPost?.busy).toBe(true);
    const pendingResult = (pendingPost!.results as Array<Record<string, unknown>>)[0];
    expect(pendingResult.pending).toBe(true);
    expect(pendingResult.status).toBe("running");

    // Settle: setBusy(false) + status:'done'. Re-render.
    panel.setBusy(false);
    const doneStmt = {
      index: 0,
      sql: "SELECT * FROM bigquery.project.dataset.t",
      status: "done" as const,
      result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
      durationMs: 0,
    };
    panel.render([doneStmt as unknown as StatementResult], "bq-hdr");

    const allStates = stateMsgs(fake);
    const donePost = allStates
      .filter(
        (m) =>
          Array.isArray(m.results) &&
          ((m.results as Array<Record<string, unknown>>)[0]?.status === "done"),
      )
      .pop();
    expect(donePost).toBeDefined();
    expect(donePost?.busy).toBe(false);
    const doneResult = (donePost!.results as Array<Record<string, unknown>>)[0];
    expect(doneResult.status).toBe("done");
    expect(doneResult.pending).toBeFalsy();
    // No status collapse: the two snapshots had different statuses, and the
    // wire preserved each one in its own post.
    expect(pendingResult.status).not.toBe(doneResult.status);
    expect(pendingPost?.busy).not.toBe(donePost?.busy);
  });

  // ---- Test #2 — happy: cancelled / error / done are distinct on the wire ----
  it("#2 — cancelled, error, and done ride the wire as three distinct statuses with the error text preserved", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    const results: StatementResult[] = [
      // cancelled statement: no result, no error, no batched
      {
        index: 0,
        sql: "SELECT 1",
        status: "cancelled",
        durationMs: 0,
      },
      // error statement: error text set
      {
        index: 1,
        sql: "SELECT bad_col FROM missing",
        status: "error",
        error: "column \"bad_col\" does not exist",
        durationMs: 5,
      },
      // done statement
      {
        index: 2,
        sql: "SELECT 3",
        status: "done",
        result: { columns: ["x"], rows: [[3]], rowCount: 1, durationMs: 0 },
        durationMs: 1,
      },
    ];
    panel.render(results, "hdr");
    const fake = lastView.current!;
    const states = stateMsgs(fake);
    expect(states.length).toBeGreaterThan(0);
    const posted = (states[0].results as Array<Record<string, unknown>>);
    expect(posted[0].status).toBe("cancelled");
    expect(posted[1].status).toBe("error");
    expect(posted[1].error).toBe('column "bad_col" does not exist');
    expect(posted[2].status).toBe("done");
    // None collapsed into a different status.
    const statuses = posted.map((r) => r.status);
    expect(new Set(statuses).size).toBe(3);
  });

  // ---- Test #3 — limited + closed is distinct; loadMore is a silent no-op ----
  it("#3 — resultLimited + cursorClosed statement: loadMore is a silent panel-level no-op (no runner call, no busy flip, no toast)", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    const limitedStmt: StatementResult = {
      index: 0,
      sql: "SELECT * FROM bigquery.public.x",
      status: "done",
      result: { columns: ["a"], rows: [[1]], rowCount: 1, durationMs: 0 },
      resultLimited: true,
      cursorClosed: true,
      durationMs: 0,
    };
    panel.render([limitedStmt], "bq-hdr");
    const fake = lastView.current!;

    // The render post carries the limited + closed markers (sanitize preserves
    // them via the `...r` spread).
    let states = stateMsgs(fake);
    expect(states.length).toBeGreaterThan(0);
    for (const m of states) {
      const r = (m.results as Array<Record<string, unknown>>)[0];
      expect(r.resultLimited).toBe(true);
      expect(r.cursorClosed).toBe(true);
    }

    fake.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Spy on loadMore and dispatch the webview message.
    (runner.loadMore as ReturnType<typeof vi.fn>).mockClear();
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    // Flush microtasks: a real runner call + setBusy would be synchronous on
    // the dispatch path; give the gate a chance to either swallow or
    // re-post the state.
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    // No runner call.
    expect(runner.loadMore).not.toHaveBeenCalled();
    // No busy:true post.
    const busyTrue = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; busy?: boolean })
      .filter((m) => m.type === "busy" && m.busy === true);
    expect(busyTrue).toHaveLength(0);
    // No toast.
    expect(showErrMock().mock.calls).toHaveLength(0);
    // State re-posted with the same markers preserved.
    states = stateMsgs(fake);
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1];
    const posted = (last.results as Array<Record<string, unknown>>)[0];
    expect(posted.resultLimited).toBe(true);
    expect(posted.cursorClosed).toBe(true);
  });

  // ---- Test #4 — edge: token-less (batched: false) loadMore is a silent no-op ----
  it("#4 — token-less statement (batched: false): loadMore is a silent panel-level no-op; no runner call, no busy state, state re-posted unchanged", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    const tokenlessStmt: StatementResult = {
      index: 0,
      sql: "SELECT * FROM bigquery.public.x",
      status: "done",
      result: { columns: ["a"], rows: [[1]], rowCount: 1, durationMs: 0 },
      // token-less: handle is falsy (false), no continuation capability.
      batched: false,
      durationMs: 0,
    };
    panel.render([tokenlessStmt], "bq-hdr");
    const fake = lastView.current!;
    fake.webview.postMessage.mockClear();
    showErrMock().mockClear();

    (runner.loadMore as ReturnType<typeof vi.fn>).mockClear();
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(runner.loadMore).not.toHaveBeenCalled();
    const busyTrue = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; busy?: boolean })
      .filter((m) => m.type === "busy" && m.busy === true);
    expect(busyTrue).toHaveLength(0);
    expect(showErrMock().mock.calls).toHaveLength(0);
    // State re-posted with the SAME results (no new batch).
    const states = stateMsgs(fake);
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1];
    const posted = (last.results as Array<Record<string, unknown>>)[0];
    expect(posted.batched).toBe(false);
    expect(posted.result).toEqual({
      columns: ["a"],
      rows: [[1]],
      rowCount: 1,
      durationMs: 0,
    });
  });

  // ---- Test #5 — edge: stale session guard (panel dispose + recreate) ----
  it("#5 — disposed panel; recreated; stale BigQuery loadMore completion posts NOTHING to the new session (epoch guard)", async () => {
    const runner = makeRunnerStub();
    const deferred = Promise.withResolvers<StatementResult[]>();
    runner.loadMore = vi.fn(() => deferred.promise) as unknown as typeof runner.loadMore;
    const oldStmt: StatementResult = {
      index: 0,
      sql: "SELECT old FROM bigquery.public.x",
      status: "done",
      result: { columns: ["a"], rows: [[1]], rowCount: 1, durationMs: 0 },
      durationMs: 0,
    };
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render([oldStmt], "bq-hdr");
    const fake = lastView.current!;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Dispose then recreate with a NEW statement set.
    panel.dispose();
    panel.render([{ ...oldStmt, sql: "SELECT new FROM bigquery.public.x" }], "bq-hdr");
    const recreated = lastView.current!;
    expect(recreated).not.toBe(fake);
    recreated.webview.postMessage.mockClear();
    showErrMock().mockClear();

    // Stale continuation resolves NOW.
    deferred.resolve([oldStmt]);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    // The recreated panel must NOT receive the stale old-SQL state post.
    const staleState = recreated.webview.postMessage.mock.calls
      .map((c) => c[0] as { type?: string; results?: Array<{ sql?: string }> })
      .filter((m) => m.type === "state")
      .filter((m) => (m.results ?? []).some((r) => r.sql === "SELECT old FROM bigquery.public.x"));
    expect(staleState).toHaveLength(0);
    expect(showErrMock().mock.calls).toHaveLength(0);
  });

  // ---- Test #6 — edge: requery/re-render during in-flight loadMore does not
  // resurrect old rows (generation/seq guard).
  it("#6 — render() during an in-flight loadMore does not let the stale completion overwrite the newer lastResults", async () => {
    const runner = makeRunnerStub();
    const deferred = Promise.withResolvers<StatementResult[]>();
    runner.loadMore = vi.fn(() => deferred.promise) as unknown as typeof runner.loadMore;
    const original: StatementResult = {
      index: 0,
      sql: "SELECT * FROM bigquery.public.x",
      status: "done",
      result: { columns: ["a"], rows: [[1]], rowCount: 1, durationMs: 0 },
      durationMs: 0,
    };
    const refreshed: StatementResult = {
      index: 0,
      sql: "SELECT * FROM bigquery.public.x",
      status: "done",
      result: { columns: ["a"], rows: [[99]], rowCount: 1, durationMs: 0 },
      durationMs: 0,
    };
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    panel.render([original], "bq-hdr");
    const fake = lastView.current!;
    fake.webview.dispatch({ type: "loadMore", index: 0 });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Re-render with NEWER results while the loadMore is still in-flight.
    panel.render([refreshed], "bq-hdr");
    const internal = panel as unknown as {
      lastResults: StatementResult[];
      requerySeq: number;
      statementGeneration: number;
      sessionEpoch: number;
    };
    // The newer render must have bumped the generation.
    expect(internal.statementGeneration).toBeGreaterThanOrEqual(2);
    expect(internal.lastResults[0].result?.rows[0][0]).toBe(99);
    fake.webview.postMessage.mockClear();

    // Stale loadMore resolves with the OLD rows. The new generation/seq
    // (and the panel's loadMore-handler epoch) must drop it.
    deferred.resolve([original]);
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
    }

    expect(internal.lastResults[0].result?.rows[0][0]).toBe(99);
    // No state post re-asserted the OLD row on the wire.
    const resurrected = fake.webview.postMessage.mock.calls
      .map((c) => c[0] as { results?: Array<{ result?: { rows?: unknown[][] } }> })
      .filter((m) => (m.results ?? []).some(
        (r) => (r.result?.rows?.[0]?.[0]) === 1,
      ));
    expect(resurrected).toHaveLength(0);
  });

  // ---- Test #7 — regression: header passes through for non-BigQuery drivers ----
  it("#7 — postgres header string flows through to every state post unchanged (regression pin)", () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
    const header = "Run at 2026-09-03T00:00:00.000Z — postgres@localhost/db";
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 1",
          status: "done",
          result: { columns: ["x"], rows: [[1]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      header,
    );
    const fake = lastView.current!;
    const states = stateMsgs(fake);
    expect(states.length).toBeGreaterThan(0);
    for (const m of states) {
      expect(m.header).toBe(header);
    }
  });
});
