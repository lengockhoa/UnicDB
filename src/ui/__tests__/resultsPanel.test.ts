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
