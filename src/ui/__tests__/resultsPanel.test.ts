// src/ui/__tests__/resultsPanel.test.ts
// Unit tests for ResultsPanel — fix round 1 (IMPORTANT #5 BigInt serialization
// + postMessage rejection surfacing).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- vscode mock -----------------------------------------------------------

type MessageHandler = (msg: unknown) => void;

class FakeWebview {
  html = "";
  private csp = "vscode-resource:webview";
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  onDidReceiveMessage = (h: MessageHandler) => { this.handler = h; return { dispose: () => undefined }; };
  asWebviewUri = (u: unknown) => u;
  get cspSource() { return this.csp; }
  /** Dispatch a message from the webview into the panel handler (test-only). */
  dispatch(msg: unknown) { if (this.handler) this.handler(msg); }
  private handler: MessageHandler | null = null;
}

class FakeWebviewPanel {
  webview = new FakeWebview();
  visible = true;
  /** AI-001 — every reveal() call's argument list (tests assert the
   *  no-arg "preserve user's group" contract via args.length === 0). */
  revealArgs: unknown[][] = [];
  private disposables: { dispose: () => void }[] = [];
  private didDisposeHandlers: (() => void)[] = [];
  constructor(public viewType: string, public title: string, public viewColumn: number, public options: unknown) {}
  reveal(...args: unknown[]) { this.revealArgs.push(args); }
  onDidReceiveMessage(h: MessageHandler) { return { dispose: () => undefined }; }
  onDidDispose(h: () => void) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  dispose() {
    for (const h of this.didDisposeHandlers) h();
  }
}

const lastPanel: { current: FakeWebviewPanel | null } = { current: null };

const createCalls: Array<{ col: number | undefined }> = [];

/** AI-001 — mutable placement the mocked getConfiguration returns.
 *  Tests flip it between cases to exercise the resultsPlacement setting. */
const configState: { resultsPlacement: unknown } = { resultsPlacement: undefined };

vi.mock("vscode", () => {
  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, path: p, toString: () => p }),
      joinPath: (...parts: unknown[]) => ({
        path: parts.map((p) => p?.fsPath ?? p?.path ?? "").join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      createWebviewPanel: (vt: string, t: string, col: number, opts: unknown) => {
        createCalls.push({ col });
        const p = new FakeWebviewPanel(vt, t, col, opts);
        lastPanel.current = p;
        return p;
      },
      showErrorMessage: vi.fn(async () => undefined),
    },
    commands: {
      executeCommand: vi.fn(async () => undefined),
    },
    workspace: {
      getConfiguration: vi.fn(() => ({
        get: (_key: string) => configState.resultsPlacement,
      })),
    },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
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

beforeEach(() => {
  lastPanel.current = null;
  createCalls.length = 0;
  configState.resultsPlacement = undefined;
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
    const fake = lastPanel.current!;
    const callArg = fake.webview.postMessage.mock.calls[0][0];
    const rowVal = callArg.results[0].result.rows[0][0];
    expect(typeof rowVal).toBe("string");
    expect(rowVal).toBe("9007199254740993");
  });

  it("postMessage rejection được surface (không void)", async () => {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
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
    const fake = lastPanel.current!;
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
    const fake = lastPanel.current!;
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
    return { panel, runner, fake: lastPanel.current! };
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
    const fake = lastPanel.current!;
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
    return { panel, runner, fake: lastPanel.current! };
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
    const fake = lastPanel.current!;
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
      const fake = lastPanel.current!;
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
    const fake = lastPanel.current!;
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
    fake: FakeWebviewPanel,
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
    fake: FakeWebviewPanel;
  } {
    const runner = makeRunnerStub();
    const panel = new ResultsPanel({ runner });
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
    return { panel, runner, fake: lastPanel.current! };
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
    const fake = lastPanel.current!;
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
      /VSDB:|Load more failed:|VSDB requery failed:/.test(m) &&
      /cancel/i.test(m),
    );
    expect(noise).toBeUndefined();
  });
});


// ---- AI-001 — resultsPlacement (below default, beside opt-out) -------------

/** Minimal StatementResult fixture for tests that only exercise placement. */
function makePlacementRunner(): QueryRunner {
  return {
    loadMore: vi.fn(async () => []),
    cancel: vi.fn(async () => {}),
  } as unknown as QueryRunner;
}

describe("ResultsPanel — resultsPlacement (AI-001)", () => {
  it("T1. default creation (no options) opens below: moveEditorToBelowGroup fired exactly once", () => {
    const panel = new ResultsPanel({ runner: makePlacementRunner() });
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
      "Statement 1",
    );
    const mock = vi.mocked(vscode.commands.executeCommand);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith("workbench.action.moveEditorToBelowGroup");
  });

  it("T2. explicit viewColumn: Beside honored at creation — no move-below command", () => {
    configState.resultsPlacement = "beside";
    const panel = new ResultsPanel({
      runner: makePlacementRunner(),
      viewColumn: vscode.ViewColumn.Beside,
    });
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
      "Statement 1",
    );
    expect(lastPanel.current!.viewColumn).toBe(vscode.ViewColumn.Beside);
    expect(vi.mocked(vscode.commands.executeCommand)).not.toHaveBeenCalled();
  });

  it("T3. placement 'beside' (via config) → plain creation, no move-below command", () => {
    configState.resultsPlacement = "beside";
    const panel = new ResultsPanel({ runner: makePlacementRunner() });
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
      "Statement 1",
    );
    expect(vi.mocked(vscode.commands.executeCommand)).not.toHaveBeenCalled();
  });

  it("T3a. package.json manifest declares vsdb.resultsPlacement (enum below|beside, default below)", () => {
    const raw = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "package.json"),
      "utf-8",
    );
    const manifest = JSON.parse(raw) as {
      contributes?: {
        configuration?: {
          properties?: Record<
            string,
            { enum?: string[]; default?: string; description?: string }
          >;
        };
      };
    };
    const prop = manifest.contributes?.configuration?.properties?.[
      "vsdb.resultsPlacement"
    ];
    expect(prop).toBeDefined();
    expect(prop!.enum).toEqual(["below", "beside"]);
    expect(prop!.default).toBe("below");
    expect(typeof prop!.description).toBe("string");
    expect(prop!.description!.length).toBeGreaterThan(0);
  });

  it("T4. existing panel: second render reuses panel and calls reveal() with NO column arg", () => {
    const panel = new ResultsPanel({ runner: makePlacementRunner() });
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
      "Statement 1",
    );
    const fake = lastPanel.current!;
    expect(createCalls).toHaveLength(1);
    vi.mocked(vscode.commands.executeCommand).mockClear();

    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 2",
          status: "done",
          result: { columns: ["x"], rows: [[2]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "Statement 1",
    );
    expect(lastPanel.current).toBe(fake);
    expect(createCalls).toHaveLength(1);
    expect(fake.revealArgs).toHaveLength(1);
    expect(fake.revealArgs[0]).toHaveLength(0);
    expect(vi.mocked(vscode.commands.executeCommand)).not.toHaveBeenCalled();
  });

  it("T5. changing placement never moves a live panel; only dispose+recreate applies it", () => {
    configState.resultsPlacement = "below";
    const panel = new ResultsPanel({ runner: makePlacementRunner() });
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
      "Statement 1",
    );
    const fake = lastPanel.current!;

    configState.resultsPlacement = "beside";
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 2",
          status: "done",
          result: { columns: ["x"], rows: [[2]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "Statement 1",
    );
    expect(lastPanel.current).toBe(fake);
    expect(fake.revealArgs[0]).toHaveLength(0);
    expect(createCalls).toHaveLength(1);

    // Dispose → onDidDispose fires → panel=null → next render recreates,
    // and the CURRENT setting applies to the new panel.
    panel.dispose();
    configState.resultsPlacement = "beside";
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT 3",
          status: "done",
          result: { columns: ["x"], rows: [[3]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "Statement 1",
    );
    expect(lastPanel.current).not.toBe(fake);
    expect(createCalls).toHaveLength(2);
    // Exactly ONE move-below total: creation #1 (placement "below").
    // The live-panel re-render (step 2) and the "beside" recreate
    // (step 3) must never fire the command.
    expect(vi.mocked(vscode.commands.executeCommand)).toHaveBeenCalledTimes(1);
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

  function panelWith(
    runner: QueryRunner,
    results: StatementResult[],
  ): { panel: ResultsPanel; fake: FakeWebviewPanel } {
    const panel = new ResultsPanel({ runner });
    panel.render(results, "hdr");
    return { panel, fake: lastPanel.current! };
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
    // Panel is torn down; a later render() recreates a working panel.
    expect(lastPanel.current).toBe(fake);
    panel.render([oldSqlResult("SELECT 2")], "hdr");
    expect(createCalls).toHaveLength(2);
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
    const newFake = lastPanel.current; // still the OLD fake — render() recreates.
    panel.render([oldSqlResult("SELECT new_sql FROM new_table")], "hdr");
    const recreated = lastPanel.current!;
    expect(recreated).not.toBe(fake);
    expect(newFake).toBe(fake);
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
    panel.render(results, "hdr");
    const fake = lastPanel.current!;

    fake.webview.dispatch({ type: "requery", index: 0, where: "", orderBy: "" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    panel.dispose();
    panel.render([oldSqlResult("SELECT * FROM users_after")], "hdr");
    const recreated = lastPanel.current!;
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

    // dispose() #1 → panel.dispose() → FakeWebviewPanel.dispose() fires
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
    const recreated = lastPanel.current!;
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
    const recreated = lastPanel.current!;
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
    panel.render([oldSqlResult("SELECT * FROM app.users")], "hdr");
    const fake = lastPanel.current!;
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
    const recreated = lastPanel.current!;
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
    const fake = lastPanel.current!;
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
    const recreated = lastPanel.current!;
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
    showErrMock().mockClear();
    panel.render([limitedStatement()], "hdr");
    const fake = lastPanel.current!;

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
    // Pre-populate lastResults with a LIMITED statement via an initial render.
    panel.render([limitedStatement()], "hdr");
    const fake = lastPanel.current!;
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
    // NO resultLimited on this statement.
    panel.render([limitedStatement({ resultLimited: undefined })], "hdr");
    const fake = lastPanel.current!;
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
    const fake = lastPanel.current!;
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
