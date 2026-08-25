// src/ui/__tests__/manualCommit.test.ts
//
// TASK-009 — host-side manual-commit transaction flow. This is deliberately a
// node-environment test: ResultsPanel imports vscode, which cannot be mocked
// from jsdom in this repository. Webview controls are exercised through the
// same fake Webview message boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (msg: unknown) => void;

class FakeWebview {
  html = "";
  postMessage = vi.fn(async (_msg: unknown) => undefined);
  private handler: MessageHandler | null = null;
  onDidReceiveMessage = (handler: MessageHandler) => {
    this.handler = handler;
    return { dispose: () => undefined };
  };
  asWebviewUri = (uri: unknown) => uri;
  get cspSource() {
    return "vscode-resource:webview";
  }
  dispatch(message: unknown): void {
    this.handler?.(message);
  }
}

class FakeWebviewPanel {
  webview = new FakeWebview();
  visible = true;
  private disposeHandlers: Array<() => void> = [];
  reveal(_column?: unknown): void {}
  onDidDispose(handler: () => void) {
    this.disposeHandlers.push(handler);
    return { dispose: () => undefined };
  }
  dispose(): void {
    for (const handler of this.disposeHandlers) handler();
  }
}

const lastPanel: { current: FakeWebviewPanel | null } = { current: null };

vi.mock("vscode", () => ({
  Uri: {
    file: (path: string) => ({ fsPath: path, path, toString: () => path }),
    joinPath: (...parts: Array<{ fsPath?: string; path?: string } | string>) => ({
      path: parts.map((part) => typeof part === "string" ? part : part.fsPath ?? part.path ?? "").join("/"),
    }),
  },
  ViewColumn: { Beside: 1 },
  window: {
    createWebviewPanel: () => {
      const panel = new FakeWebviewPanel();
      lastPanel.current = panel;
      return panel;
    },
    showErrorMessage: vi.fn(async () => undefined),
  },
  env: { clipboard: { writeText: vi.fn(async () => undefined) } },
}));

import { ResultsPanel, type SaveContext } from "../resultsPanel";
import type { QueryRunner, RunResult, StatementResult } from "../../core/queryRunner";

function messages(): Array<Record<string, unknown>> {
  return lastPanel.current!.webview.postMessage.mock.calls.map(
    ([message]) => message as Record<string, unknown>,
  );
}

async function flush(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for expected webview message");
}

function makePanel(options: { manualCommit: boolean; failSave?: boolean }) {
  const calls: string[] = [];
  const runner = {
    loadMore: vi.fn(async () => [] as StatementResult[]),
    cancel: vi.fn(async () => undefined),
    runSql: vi.fn(async (sql: string): Promise<RunResult> => {
      calls.push(sql);
      if (options.failSave && /^BEGIN/i.test(sql.trim())) {
        throw new Error("database write failed");
      }
      return {
        results: [{ columns: ["id", "name"], rows: [[1, "updated"]], rowCount: 1, durationMs: 0 }],
      };
    }),
  } as unknown as QueryRunner;
  const saveContext: SaveContext = {
    getDriver: () => "mssql",
    getManualCommit: () => options.manualCommit,
    listPkColumns: async () => ["id"],
  };
  const panel = new ResultsPanel({ runner, saveContext });
  panel.render([{
    index: 0,
    sql: "SELECT id, name FROM people",
    status: "done",
    result: { columns: ["id", "name"], rows: [[1, "original"]], rowCount: 1, durationMs: 0 },
    durationMs: 0,
  }], "manual commit test");
  return { calls, panel, webview: lastPanel.current!.webview };
}

beforeEach(() => {
  lastPanel.current = null;
  vi.clearAllMocks();
});

describe("ResultsPanel manual-commit mode (TASK-009)", () => {
  it("manualCommit wraps save in BEGIN and leaves commit for explicit action", async () => {
    const { calls, webview } = makePanel({ manualCommit: true });
    webview.dispatch({
      type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));

    expect(calls[0]).toMatch(/^BEGIN TRANSACTION;\nUPDATE[\s\S]*;$/);
    expect(calls[0]).not.toMatch(/COMMIT TRANSACTION/i);
    expect(messages()).toContainEqual({ type: "transactionStatus", open: true });
  });

  it("manualCommit off preserves the existing automatic transaction save", async () => {
    const { calls, webview } = makePanel({ manualCommit: false });
    webview.dispatch({
      type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    await flush(() => messages().some((message) => message.type === "saveResult"));

    expect(calls[0]).toMatch(/^BEGIN TRANSACTION;[\s\S]*COMMIT TRANSACTION;$/);
    expect(messages()).not.toContainEqual({ type: "transactionStatus", open: true });
  });

  it("rollback sends ROLLBACK TRANSACTION and reports closed state", async () => {
    const { calls, webview } = makePanel({ manualCommit: true });
    webview.dispatch({
      type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
    webview.dispatch({ type: "rollbackTransaction" });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === false));

    expect(calls).toContain("ROLLBACK TRANSACTION");
    expect(messages()).toContainEqual({ type: "transactionStatus", open: false });
  });

  it("transactionStatus is open only after a manual transaction begins", async () => {
    const { webview } = makePanel({ manualCommit: true });
    expect(messages()).not.toContainEqual({ type: "transactionStatus", open: true });

    webview.dispatch({
      type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
  });

  it("Commit and Rollback controls stay absent until transactionStatus is open", () => {
    const { webview } = makePanel({ manualCommit: false });
    webview.dispatch({ type: "ready" });
    expect(messages()).not.toContainEqual({ type: "transactionStatus", open: true });
  });

  it("failed manual statement rolls back before sending the error response", async () => {
    const { calls, webview } = makePanel({ manualCommit: true, failSave: true });
    webview.dispatch({
      type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    await flush(() => messages().some((message) => message.type === "saveResult" && message.ok === false));

    const rollbackIndex = calls.indexOf("ROLLBACK TRANSACTION");
    const errorIndex = messages().findIndex((message) => message.type === "saveResult" && message.ok === false);
    expect(rollbackIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(calls[rollbackIndex]).toBe("ROLLBACK TRANSACTION");
  });

  it("commit sends COMMIT TRANSACTION and reports closed state", async () => {
    const { calls, webview } = makePanel({ manualCommit: true });
    webview.dispatch({
      type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
      edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
    });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
    webview.dispatch({ type: "commitTransaction" });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === false));

    expect(calls).toContain("COMMIT TRANSACTION");
    expect(messages()).toContainEqual({ type: "transactionStatus", open: false });
  });
});
