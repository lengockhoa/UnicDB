// src/ui/__tests__/manualCommit.test.ts
//
// TASK-009 — host-side manual-commit transaction flow. This is deliberately a
// node-environment test: ResultsPanel imports vscode, which cannot be mocked
// from jsdom in this repository. Webview controls are exercised through the
// same fake Webview message boundary.
//
// Cycle U / R1: manual-commit now uses a session-pinned DbTransaction
// (adapter.beginTransaction → transaction.runQuery) instead of bundling BEGIN
// into a pooled runSql call. The old flow leaked the transaction onto a
// released pooled client, so the post-save requery landed on a different
// connection and Postgres rejected it ("cannot run inside a transaction
// block"), silently discarding the save. These tests assert the NEW contract:
// the save statements travel through the transaction handle, BEGIN/COMMIT no
// longer appear in runSql calls, and Commit/Rollback actions invoke the
// handle's commit()/rollback().
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
import type { DbTransaction } from "../../adapters/types";

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
  // Statements observed by the fake transaction handle (the session-pinned
  // connection the manual window owns). The fake transaction runs on the
  // SAME client as BEGIN/COMMIT — that is exactly what the R1 fix pins.
  const txStatements: string[] = [];
  const transaction: DbTransaction & {
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
  } = {
    runQuery: async (sql: string): Promise<RunResult> => {
      txStatements.push(sql);
      if (options.failSave) throw new Error("database write failed");
      return { results: [] };
    },
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
  const beginTransaction = vi.fn(async (): Promise<DbTransaction> => transaction);
  const runner = {
    loadMore: vi.fn(async () => [] as StatementResult[]),
    cancel: vi.fn(async () => undefined),
    runSql: vi.fn(async (sql: string): Promise<RunResult> => {
      calls.push(sql);
      return {
        results: [{ columns: ["id", "name"], rows: [[1, "updated"]], rowCount: 1, durationMs: 0 }],
      };
    }),
    beginTransaction,
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
  return { calls, txStatements, transaction, beginTransaction, panel, webview: lastPanel.current!.webview };
}

function save(webview: FakeWebview): void {
  webview.dispatch({
    type: "saveEdits", index: 0, tableName: "people", pkColumns: ["id"],
    edits: [{ rowId: 0, colIndex: 1, value: "updated" }],
  });
}

beforeEach(() => {
  lastPanel.current = null;
  vi.clearAllMocks();
});

describe("ResultsPanel manual-commit mode (TASK-009)", () => {
  it("opens a session-pinned transaction and runs saves through it; COMMIT left for explicit action", async () => {
    const { calls, txStatements, transaction, beginTransaction, webview } = makePanel({ manualCommit: true });
    save(webview);
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));

    expect(beginTransaction).toHaveBeenCalledTimes(1);
    // The save statements travel through the transaction handle — NOT a
    // pooled runSql call. No BEGIN/COMMIT wrapper: the handle is the window.
    expect(txStatements).toHaveLength(1);
    expect(txStatements[0]).toMatch(/UPDATE[\s\S]*name[\s\S]*/i);
    expect(txStatements[0]).not.toMatch(/^BEGIN/i);
    expect(txStatements[0]).not.toMatch(/COMMIT/i);
    expect(calls).toHaveLength(0);
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(messages()).toContainEqual({ type: "transactionStatus", open: true });
  });

  it("reuses the open transaction for a second save (no new beginTransaction)", async () => {
    const { txStatements, beginTransaction, webview } = makePanel({ manualCommit: true });
    save(webview);
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
    save(webview);
    await flush(() => txStatements.length >= 2);

    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(txStatements).toHaveLength(2);
  });

  it("manualCommit off preserves the existing automatic transaction save", async () => {
    const { calls, txStatements, beginTransaction, webview } = makePanel({ manualCommit: false });
    save(webview);
    await flush(() => messages().some((message) => message.type === "saveResult"));

    expect(beginTransaction).not.toHaveBeenCalled();
    expect(txStatements).toHaveLength(0);
    expect(calls[0]).toMatch(/^BEGIN TRANSACTION;[\s\S]*COMMIT TRANSACTION;$/);
    expect(messages()).not.toContainEqual({ type: "transactionStatus", open: true });
  });

  it("rollback invokes transaction.rollback and reports closed state", async () => {
    const { transaction, webview } = makePanel({ manualCommit: true });
    save(webview);
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
    webview.dispatch({ type: "rollbackTransaction" });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === false));

    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(messages()).toContainEqual({ type: "transactionStatus", open: false });
  });

  it("transactionStatus is open only after a manual transaction begins", async () => {
    const { webview } = makePanel({ manualCommit: true });
    expect(messages()).not.toContainEqual({ type: "transactionStatus", open: true });

    save(webview);
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
  });

  it("Commit and Rollback controls stay absent until transactionStatus is open", () => {
    const { webview } = makePanel({ manualCommit: false });
    webview.dispatch({ type: "ready" });
    expect(messages()).not.toContainEqual({ type: "transactionStatus", open: true });
  });

  it("failed manual statement rolls back the transaction before sending the error response", async () => {
    const { transaction, webview } = makePanel({ manualCommit: true, failSave: true });
    save(webview);
    await flush(() => messages().some((message) => message.type === "saveResult" && message.ok === false));

    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    const errorAck = messages().find((message) => message.type === "saveResult" && message.ok === false);
    expect(errorAck).toBeDefined();
    expect((errorAck as Record<string, unknown>).errors).toEqual(["database write failed"]);
  });

  it("commit invokes transaction.commit and reports closed state", async () => {
    const { transaction, webview } = makePanel({ manualCommit: true });
    save(webview);
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === true));
    webview.dispatch({ type: "commitTransaction" });
    await flush(() => messages().some((message) => message.type === "transactionStatus" && message.open === false));

    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(messages()).toContainEqual({ type: "transactionStatus", open: false });
  });
});

// ---- TASK-006 (cycle X) — P1-4: the manual COMMIT/ROLLBACK *button* paths
// must requery the manual window's statement (runSql + state post) so the
// grid shows server truth; the dispose-time teardown rollback must NOT.
describe("ResultsPanel manual-commit button refresh (TASK-006 P1-4)", () => {
  function makeRefreshPanel(postRollbackRows: unknown[][]) {
    const runSqlCalls: string[] = [];
    const runSql = vi.fn(async (sql: string): Promise<RunResult> => {
      runSqlCalls.push(sql);
      return {
        results: [
          { columns: ["id", "name"], rows: postRollbackRows, rowCount: postRollbackRows.length, durationMs: 0 },
        ],
      };
    });
    const txStatements: string[] = [];
    const transaction: DbTransaction & {
      commit: ReturnType<typeof vi.fn>;
      rollback: ReturnType<typeof vi.fn>;
    } = {
      runQuery: async (sql: string): Promise<RunResult> => {
        txStatements.push(sql);
        return { results: [] };
      },
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
    };
    const adopt = vi.fn();
    const runner = {
      loadMore: vi.fn(async () => [] as StatementResult[]),
      cancel: vi.fn(async () => undefined),
      runSql,
      beginTransaction: vi.fn(async (): Promise<DbTransaction> => transaction),
      adopt,
    } as unknown as QueryRunner;
    const saveContext: SaveContext = {
      getDriver: () => "mssql",
      getManualCommit: () => true,
      listPkColumns: async () => ["id"],
    };
    const panel = new ResultsPanel({ runner, saveContext });
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT * FROM t",
          status: "done",
          result: { columns: ["id", "name"], rows: [[1, "uncommitted"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "manual commit refresh test",
    );
    return { panel, transaction, runSql, runSqlCalls, adopt, webview: lastPanel.current!.webview };
  }

  it("P1-4 — ROLLBACK requeries the manual window's statement and posts the refreshed state", async () => {
    const { runSqlCalls, transaction, webview } = makeRefreshPanel([[1, "server-truth"]]);
    save(webview);
    await flush(() => messages().some((m) => m.type === "transactionStatus" && m.open === true));
    const postsBefore = messages().length;
    webview.dispatch({ type: "rollbackTransaction" });
    await flush(() => messages().slice(postsBefore).some((m) => m.type === "state"));

    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    // Exactly one follow-up runSql for the refresh — no second save batch.
    expect(runSqlCalls.filter((sql) => sql === "SELECT * FROM t")).toHaveLength(1);
    const lastState = messages()
      .slice(postsBefore)
      .filter((m) => m.type === "state")
      .pop();
    expect(lastState).toBeDefined();
    expect((lastState!.results as Array<{ result: { rows: unknown[][] } }>)[0].result.rows).toEqual(
      [[1, "server-truth"]],
    );
  });

  it("P1-4 — COMMIT requeries the same statement; refreshed state carries a boolean batched", async () => {
    const { runSqlCalls, transaction, adopt, webview } = makeRefreshPanel([[1, "server-truth"]]);
    save(webview);
    await flush(() => messages().some((m) => m.type === "transactionStatus" && m.open === true));
    const postsBefore = messages().length;
    webview.dispatch({ type: "commitTransaction" });
    await flush(() => messages().slice(postsBefore).some((m) => m.type === "state"));

    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(runSqlCalls.filter((sql) => sql === "SELECT * FROM t")).toHaveLength(1);
    const lastState = messages()
      .slice(postsBefore)
      .filter((m) => m.type === "state")
      .pop();
    expect(lastState).toBeDefined();
    expect((lastState!.results as Array<{ result: { rows: unknown[][] } }>)[0].result.rows).toEqual(
      [[1, "server-truth"]],
    );
    // `batched` is present on the wire for the new cursor (normalized to a
    // boolean by sanitizeStatementResult — P3-3).
    const batched = (lastState!.results as Array<{ batched?: unknown }>)[0].batched;
    expect(batched).toBe(false);
    expect(adopt).toHaveBeenCalled();
  });

  it("teardown — dispose-time rollback does NOT requery and posts no state after dispose", async () => {
    const { panel, runSql, transaction, webview } = makeRefreshPanel([[1, "server-truth"]]);
    save(webview);
    await flush(() => messages().some((m) => m.type === "transactionStatus" && m.open === true));
    const postsBefore = messages().length;
    runSql.mockClear();
    panel.dispose();
    for (let i = 0; i < 200; i++) await Promise.resolve();
    // The teardown rollback path must fire the adapter rollback exactly once
    // but issue ZERO follow-up queries and ZERO state posts.
    await Promise.resolve();
    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(runSql).not.toHaveBeenCalled();
    expect(messages().slice(postsBefore).filter((m) => m.type === "state")).toHaveLength(0);
  });

  // ---- TASK-004 (cycle Y) — stale-index render regression -----------------
  // After a manual window records manualStatementIndex = 0, a fresh
  // render() swaps in a NEW statement set. The recorded index then points
  // at an unrelated statement; the later Commit/Rollback button must NOT
  // execute that statement's SQL. render() clears the index alongside its
  // other statement-set state.
  it("fresh render() invalidates the recorded manual index — Commit executes no unrelated statement", async () => {
    const { panel, runSqlCalls, transaction, webview } = makeRefreshPanel([[1, "server-truth"]]);
    save(webview);
    await flush(() => messages().some((m) => m.type === "transactionStatus" && m.open === true));
    // Simulate the user running a NEW query while the manual window is open:
    // statement 0 now belongs to a completely different table.
    panel.render(
      [
        {
          index: 0,
          sql: "SELECT secret FROM audit_log",
          status: "done",
          result: { columns: ["secret"], rows: [["x"]], rowCount: 1, durationMs: 0 },
          durationMs: 0,
        },
      ],
      "next run",
    );
    const postsBefore = messages().length;
    webview.dispatch({ type: "commitTransaction" });
    await flush(
      () =>
        messages()
          .slice(postsBefore)
          .some((m) => m.type === "transactionStatus" && m.open === false),
    );
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    // No requery of ANY statement ran — in particular nothing executed the
    // unrelated audit_log statement.
    expect(runSqlCalls.filter((sql) => sql === "SELECT secret FROM audit_log")).toHaveLength(0);
    expect(runSqlCalls.filter((sql) => sql === "SELECT * FROM t")).toHaveLength(0);
  });
});
