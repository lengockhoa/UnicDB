// src/ui/__tests__/resultsPanelRetry.test.ts
//
// TASK-005 — A19 failed-row retry affordance (host side).
//
// Verifies ResultsPanel.handleRetryFailedRows rebuilds a save batch from
// JUST the failed rows and runs it through the same save pipeline as
// saveEdits. Node environment (vi.mock("vscode") does not resolve under
// jsdom — see webviewRetry.test.ts for the webview-side bundle tests).
//
//   H1. retryFailedRows → combined BEGIN/UPDATE/COMMIT with exactly ONE
//       UPDATE for the failed row + ok:true ack (same pipeline as saveEdits)
//   H2. edits whose rowId is NOT in rowIds are dropped (defensive re-filter)
//   H3. empty rowIds + empty edits → silent no-op (no BEGIN, no ack)
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

type MessageHandler = (msg: unknown) => void;

class FakeWebview {
  html = "";
  private csp = "vscode-resource:webview";
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  onDidReceiveMessage = (h: MessageHandler) => {
    this.handler = h;
    return { dispose: () => undefined };
  };
  asWebviewUri = (u: unknown) => u;
  get cspSource() {
    return this.csp;
  }
  dispatch(msg: unknown) {
    if (this.handler) this.handler(msg);
  }
  private handler: MessageHandler | null = null;
}

class FakeWebviewView {
  webview = new FakeWebview();
  description: string | undefined;
  title: string | undefined;
  viewType = "UnicDB.results";
  visible = true;
  private didDisposeHandlers: Array<() => void> = [];
  onDidDispose(h: () => void) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  fireDidDispose() {
    for (const h of this.didDisposeHandlers) h();
  }
  dispose() {}
}
class FakeWebviewPanel {
  webview = new FakeWebview();
  visible = true;
  private didDisposeHandlers: (() => void)[] = [];
  constructor(
    public viewType: string,
    public title: string,
    public viewColumn: number,
    public options: unknown,
  ) {}
  reveal(_col?: unknown) {}
  onDidReceiveMessage(_h: MessageHandler) {
    return { dispose: () => undefined };
  }
  onDidDispose(h: () => void) {
    this.didDisposeHandlers.push(h);
    return { dispose: () => undefined };
  }
  dispose() {
    for (const h of this.didDisposeHandlers) h();
  }
}

const providerStore: Array<{
  viewId: string;
  provider: { resolveWebviewView: (view: unknown) => unknown };
}> = [];
const lastView: { current: FakeWebviewView | null } = { current: null };
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
      registerWebviewViewProvider: (
        viewId: string,
        provider: { resolveWebviewView: (view: unknown) => unknown },
        _options?: unknown,
      ) => {
        providerStore.push({ viewId, provider });
        lastView.current = null;
        lastPanel.current = null;
        return { dispose: () => undefined };
      },
      showErrorMessage: vi.fn(async () => undefined),
    },

    commands: {
      executeCommand: vi.fn(async (cmd: string, ..._rest: unknown[]) => {
        if (cmd === "UnicDB.results.focus" && providerStore.length > 0) {
          if (lastView.current && !(lastView.current as unknown as { isDisposed?: boolean }).isDisposed) {
            return undefined;
          }
          const provider = providerStore[providerStore.length - 1]!.provider;
          const v = new FakeWebviewView();
          (provider as { resolveWebviewView: (v: unknown) => unknown }).resolveWebviewView(v);
          lastView.current = v;
          lastPanel.current = v as unknown as FakeWebviewPanel;
        }
        return undefined;
      }),
    },

    workspace: { onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    env: {
      clipboard: { writeText: vi.fn(async () => undefined) },
    },
  };
});

import { ResultsPanel, type SaveContext } from "../resultsPanel";
import type {
  QueryRunner,
  RunResult,
  StatementResult,
} from "../../core/queryRunner";

interface RecordedCall {
  sql: string;
}

function saveResultAcks(fake: FakeWebviewPanel) {
  return fake.webview.postMessage.mock.calls
    .map(
      (c) =>
        c[0] as {
          type?: string;
          ok?: boolean;
          errors?: string[];
          index?: number;
          rowErrors?: Array<{ rowId: number; error: string }>;
        },
    )
    .filter((m) => m.type === "saveResult");
}

async function pumpUntilAck(fake: FakeWebviewPanel): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (saveResultAcks(fake).length > 0) break;
    await Promise.resolve();
  }
}

function makeHostPanel(
  columns: string[],
  rows: unknown[][],
): { recorded: RecordedCall[]; fake: FakeWebviewPanel; panel: ResultsPanel } {
  const saveCtx: SaveContext = {
    getDriver: () => "postgres",
    listPkColumns: async () => ["id"],
  };
  const recorded: RecordedCall[] = [];
  const fakeRunQuery = vi.fn(async (sql: string): Promise<RunResult> => {
    recorded.push({ sql });
    return { results: [{ columns, rows, rowCount: rows.length, durationMs: 0 }] };
  });
  const runner = {
    loadMore: vi.fn(async () => [] as StatementResult[]),
    cancel: vi.fn(async () => undefined),
    runSql: fakeRunQuery,
  } as unknown as QueryRunner;
  const panel = new ResultsPanel({ runner, saveContext: saveCtx });
  vscode.window.registerWebviewViewProvider(ResultsPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } });
  panel.render(
    [
      {
        index: 0,
        sql: "SELECT id, name FROM t",
        status: "done",
        result: { columns, rows, rowCount: rows.length, durationMs: 0 },
        durationMs: 0,
      },
    ],
    "hdr",
  );
  return { recorded, fake: lastPanel.current!, panel };
}

beforeEach(() => {
  lastView.current = null;
  providerStore.length = 0;
  lastPanel.current = null;
  vi.clearAllMocks();
});

describe("ResultsPanel — handleRetryFailedRows (TASK-005 / A19)", () => {
  it("H1. retryFailedRows → same save pipeline: combined transaction with exactly ONE UPDATE for the failed row + ok:true ack", async () => {
    const { recorded, fake } = makeHostPanel(
      ["id", "name"],
      [
        [1, "alice"],
        [2, "bob"],
      ],
    );
    // Row 1 (bob, pk id=2) failed in the previous save; row 0 succeeded and
    // is absent from the retry payload.
    fake.webview.dispatch({
      type: "retryFailedRows",
      index: 0,
      rowIds: [1],
      edits: [{ rowId: 1, colIndex: 1, value: "bob-2" }],
      serverIndexByRowId: { "0": 0, "1": 1 },
    });
    await pumpUntilAck(fake);

    const combined = recorded.find((c) => /^BEGIN/i.test(c.sql.trim()));
    expect(combined).toBeDefined();
    expect((combined!.sql.match(/UPDATE/gi) ?? []).length).toBe(1);
    expect(combined!.sql).toMatch(/'bob-2'/);
    expect(combined!.sql).toMatch(/WHERE\s+"id"=2/);
    const acks = saveResultAcks(fake);
    const okAck = acks.find((a) => a.ok === true);
    expect(okAck).toBeDefined();
  });

  it("H2. edits whose rowId is NOT in rowIds are dropped (defensive re-filter)", async () => {
    const { recorded, fake } = makeHostPanel(
      ["id", "name"],
      [
        [1, "alice"],
        [2, "bob"],
      ],
    );
    // rowIds says only row 1 failed, but the payload smuggles an edit for
    // row 0 too — the host MUST rebuild the batch from just rowIds.
    fake.webview.dispatch({
      type: "retryFailedRows",
      index: 0,
      rowIds: [1],
      edits: [
        { rowId: 0, colIndex: 1, value: "alice-x" },
        { rowId: 1, colIndex: 1, value: "bob-2" },
      ],
      serverIndexByRowId: { "0": 0, "1": 1 },
    });
    await pumpUntilAck(fake);

    const combined = recorded.find((c) => /^BEGIN/i.test(c.sql.trim()));
    expect(combined).toBeDefined();
    expect((combined!.sql.match(/UPDATE/gi) ?? []).length).toBe(1);
    expect(combined!.sql).toMatch(/'bob-2'/);
    expect(combined!.sql).not.toMatch(/'alice-x'/);
    expect(combined!.sql).not.toMatch(/WHERE\s+"id"=1/);
  });

  it("H3. empty rowIds + empty edits → silent no-op (no BEGIN, no saveResult ack)", async () => {
    const { recorded, fake } = makeHostPanel(
      ["id", "name"],
      [[1, "alice"]],
    );
    fake.webview.dispatch({
      type: "retryFailedRows",
      index: 0,
      rowIds: [],
      edits: [],
    });
    // Pump the microtask queue — handleMessage resolves without any ack.
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    expect(
      recorded.find((c) => /^BEGIN/i.test(c.sql.trim())),
    ).toBeUndefined();
    expect(saveResultAcks(fake)).toHaveLength(0);
  });
});
