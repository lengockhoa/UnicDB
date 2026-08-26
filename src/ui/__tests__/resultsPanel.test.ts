// src/ui/__tests__/resultsPanel.test.ts
// Unit tests for ResultsPanel — fix round 1 (IMPORTANT #5 BigInt serialization
// + postMessage rejection surfacing).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  private disposables: { dispose: () => void }[] = [];
  private didDisposeHandlers: (() => void)[] = [];
  constructor(public viewType: string, public title: string, public viewColumn: number, public options: unknown) {}
  reveal(_col?: unknown) {}
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
        const p = new FakeWebviewPanel(vt, t, col, opts);
        lastPanel.current = p;
        return p;
      },
      showErrorMessage: vi.fn(async () => undefined),
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

