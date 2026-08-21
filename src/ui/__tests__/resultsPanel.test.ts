// src/ui/__tests__/resultsPanel.test.ts
// Unit tests for ResultsPanel — fix round 1 (IMPORTANT #5 BigInt serialization
// + postMessage rejection surfacing).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- vscode mock -----------------------------------------------------------

type MessageHandler = (msg: any) => void;

class FakeWebview {
  html = "";
  private csp = "vscode-resource:webview";
  postMessage = vi.fn(async (_msg: any) => undefined);
  onDidReceiveMessage = (h: MessageHandler) => ({ dispose: () => undefined });
  asWebviewUri = (u: any) => u;
  get cspSource() { return this.csp; }
}

class FakeWebviewPanel {
  webview = new FakeWebview();
  visible = true;
  private disposables: { dispose: () => void }[] = [];
  private didDisposeHandlers: (() => void)[] = [];
  constructor(public viewType: string, public title: string, public viewColumn: number, public options: any) {}
  reveal(_col?: any) {}
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
      joinPath: (...parts: any[]) => ({
        fsPath: parts.map((p) => p?.fsPath ?? p?.path ?? "").join("/"),
        path: parts.map((p) => p?.fsPath ?? p?.path ?? "").join("/"),
      }),
    },
    ViewColumn: { Beside: 1, Active: 2, One: 3, Two: 4, Three: 5 },
    window: {
      createWebviewPanel: (vt: string, t: string, col: number, opts: any) => {
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
import type { QueryRunner } from "../../core/queryRunner";

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
    const obj = r.result!.rows[0][0] as any;
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
    const a: any = { x: 1 };
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
    const obj = r.result!.rows[0][0] as any;
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
    const msg = String(
      (vscode.window.showErrorMessage as any).mock.calls[0][0],
    );
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
    const msg = String(
      (vscode.window.showErrorMessage as any).mock.calls[0][0],
    );
    expect(msg).toMatch(/postMessage failed/);
  });
});
