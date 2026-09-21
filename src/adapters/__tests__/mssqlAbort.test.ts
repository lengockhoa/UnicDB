// src/adapters/__tests__/mssqlAbort.test.ts
// TASK-SQLHANG-003 — MsSqlAdapter.abortActiveQuery: hard abort of in-flight
// work, queueGeneration stale-op rejection, and lazy reconnect.
//
// Fixture convention follows mssql.parameterized.test.ts: a fake tedious
// Connection (EventEmitter) is injected into the adapter's private
// `connection`/`connected` fields, and `newRequest` is shadowed at instance
// level so created requests can be observed/settled by the test.
//
// tedious 18.x behavior verified against node_modules: Connection.close() →
// transitionTo(FINAL) → cleanupConnection() fires the in-flight request's
// callback with RequestError('Connection closed before request completed.',
// 'ECLOSE'). The fake connection's close() mirrors that teardown so parked
// runRequest promises settle exactly like the real driver.
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Request as TediousRequest } from "tedious";
import { MsSqlAdapter } from "../mssql";
import type { ConnectionConfig } from "../../config/types";

const STALE_OP_MESSAGE =
  "MsSqlAdapter: operation aborted — connection was reset";

function cfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver: "mssql",
    host: "127.0.0.1",
    port: 1433,
    user: "UnicDB",
    database: "UnicDB",
  };
}

type RequestCallback = (
  error: Error | null | undefined,
  rowCount?: number,
) => void;

function callbackOf(request: TediousRequest): RequestCallback | null {
  return (request as unknown as { callback: RequestCallback | null })
    .callback;
}

/**
 * Fake tedious Connection. `execSql` never settles on its own — the test
 * drives completion via settle() — and `close()` mirrors tedious teardown:
 * every still-pending request callback fires with an ECLOSE-style error.
 */
class FakeConnection extends EventEmitter {
  state = { name: "LoggedIn" };
  readonly pending = new Set<TediousRequest>();
  readonly execSql = vi.fn((request: TediousRequest) => {
    this.pending.add(request);
  });
  readonly close = vi.fn(() => {
    for (const request of [...this.pending]) {
      this.pending.delete(request);
      callbackOf(request)?.(
        new Error("Connection closed before request completed."),
      );
    }
  });
  readonly connect = vi.fn(() => {
    this.emit("connect");
  });
}

function makeAdapter(): {
  adapter: MsSqlAdapter;
  connection: FakeConnection;
  requests: TediousRequest[];
  settle: (
    request: TediousRequest,
    error?: Error | null,
    rowCount?: number,
  ) => void;
} {
  const adapter = new MsSqlAdapter(cfg(), "pw");
  const requests: TediousRequest[] = [];
  const originalNewRequest = (
    MsSqlAdapter.prototype as unknown as {
      newRequest: (
        this: MsSqlAdapter,
        sql: string,
        params?: unknown,
      ) => TediousRequest;
    }
  ).newRequest;
  (adapter as unknown as { newRequest: unknown }).newRequest = (
    sql: string,
    params?: unknown,
  ) => {
    const request = originalNewRequest.call(adapter, sql, params);
    requests.push(request);
    return request;
  };
  const connection = new FakeConnection();
  (adapter as unknown as { connection: unknown }).connection = connection;
  (adapter as unknown as { connected: boolean }).connected = true;
  const settle = (
    request: TediousRequest,
    error: Error | null = null,
    rowCount = 0,
  ): void => {
    connection.pending.delete(request);
    callbackOf(request)?.(error, rowCount);
  };
  return { adapter, connection, requests, settle };
}

/** Route the next connect() through a fresh FakeConnection. */
function stubNextConnection(adapter: MsSqlAdapter): FakeConnection {
  const next = new FakeConnection();
  (adapter as unknown as { createConnection: unknown }).createConnection =
    () => next;
  return next;
}

function callExecute(adapter: MsSqlAdapter, sql: string): Promise<unknown> {
  return (
    adapter as unknown as {
      execute: (sql: string, params?: unknown) => Promise<unknown>;
    }
  ).execute(sql);
}

function queueGenerationOf(adapter: MsSqlAdapter): number {
  return (adapter as unknown as { queueGeneration: number }).queueGeneration;
}

function activeRequestsOf(adapter: MsSqlAdapter): Set<TediousRequest> {
  return (adapter as unknown as { activeRequests: Set<TediousRequest> })
    .activeRequests;
}

describe("MsSqlAdapter.abortActiveQuery (TASK-SQLHANG-003)", () => {
  it("#1 abort with live connection + active request cancels and tears down", async () => {
    const { adapter, connection, requests } = makeAdapter();

    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    runPromise.catch(() => undefined); // settled by teardown below
    await vi.waitFor(() => expect(requests.length).toBe(1));
    const request = requests[0];
    const cancelSpy = vi.spyOn(request, "cancel");
    const genBefore = queueGenerationOf(adapter);

    await adapter.abortActiveQuery();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(queueGenerationOf(adapter)).toBe(genBefore + 1);
    expect(
      (adapter as unknown as { connected: boolean }).connected,
    ).toBe(false);
    expect(
      (adapter as unknown as { connection: unknown }).connection,
    ).toBeNull();
    await expect(runPromise).rejects.toThrow(
      "Connection closed before request completed.",
    );
  });

  it("#2 runQuery after abort lazily reconnects and executes", async () => {
    const { adapter, requests } = makeAdapter();
    await adapter.abortActiveQuery();

    const next = stubNextConnection(adapter);
    const connectSpy = vi.spyOn(adapter, "connect");

    const runPromise = adapter.runQuery("UPDATE dbo.t SET a = 1");
    await vi.waitFor(() => expect(requests.length).toBe(1));
    settleOn(next, requests[0]);

    await expect(runPromise).resolves.toMatchObject({
      results: [{ rows: [] }],
    });
    expect(connectSpy).toHaveBeenCalled();
    expect(next.execSql).toHaveBeenCalledTimes(1);
  });

  it("#3 op enqueued behind a hung op rejects stale after abort", async () => {
    const { adapter, connection, requests } = makeAdapter();

    const hung = callExecute(adapter, "UPDATE dbo.t SET a = 1");
    hung.catch(() => undefined);
    await vi.waitFor(() => expect(requests.length).toBe(1));

    const queued = callExecute(adapter, "UPDATE dbo.t SET a = 2");
    const queuedAssertion = expect(queued).rejects.toThrow(STALE_OP_MESSAGE);

    await adapter.abortActiveQuery();

    await queuedAssertion;
    // Only the hung op ever reached the driver; the queued op never ran.
    expect(connection.execSql).toHaveBeenCalledTimes(1);
    hung.catch(() => undefined);
  });

  it("#4 abort with null connection and no requests is a no-op that still bumps generation", async () => {
    const adapter = new MsSqlAdapter(cfg(), "pw");
    const genBefore = queueGenerationOf(adapter);

    await expect(adapter.abortActiveQuery()).resolves.toBeUndefined();
    expect(queueGenerationOf(adapter)).toBe(genBefore + 1);
  });

  it("#5 abort settles a never-completing runRequest and advances the queue", async () => {
    const { adapter, connection, requests } = makeAdapter();
    // execSql never calls back — the request hangs until teardown.
    const runPromise = adapter.runQuery("UPDATE dbo.t SET a = 1");
    await vi.waitFor(() => expect(requests.length).toBe(1));

    await adapter.abortActiveQuery();

    await expect(runPromise).rejects.toThrow(
      "Connection closed before request completed.",
    );
    expect(connection.execSql).toHaveBeenCalledTimes(1);

    // enqueue's finally ran → the queue advanced: a new op reconnects and runs.
    const next = stubNextConnection(adapter);
    const followUp = adapter.runQuery("UPDATE dbo.t SET a = 2");
    await vi.waitFor(() => expect(requests.length).toBe(2));
    settleOn(next, requests[1]);
    await expect(followUp).resolves.toMatchObject({
      results: [{ rows: [] }],
    });
  });

  it("#6 abort is idempotent — second call resolves without re-closing", async () => {
    const { adapter, connection, requests } = makeAdapter();

    const runPromise = callExecute(adapter, "SELECT 1 AS one");
    runPromise.catch(() => undefined);
    await vi.waitFor(() => expect(requests.length).toBe(1));

    await adapter.abortActiveQuery();
    await expect(adapter.abortActiveQuery()).resolves.toBeUndefined();

    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it("#7 regression: hung statement no longer parks every later runQuery", async () => {
    const { adapter, connection, requests } = makeAdapter();

    const first = adapter.runQuery("UPDATE dbo.t SET a = 1");
    await vi.waitFor(() => expect(requests.length).toBe(1));

    // Pre-fix this second call parks behind the wedged queue forever.
    // Post-fix it either rejects §8.3 or lazily reconnects — stub the next
    // connection up front so the reconnect path can complete.
    const next = stubNextConnection(adapter);
    const second = adapter.runQuery("UPDATE dbo.t SET a = 2");

    await adapter.abortActiveQuery();

    await expect(first).rejects.toThrow(
      "Connection closed before request completed.",
    );
    await vi.waitFor(() => expect(requests.length).toBe(2));
    settleOn(next, requests[1]);
    await expect(second).resolves.toMatchObject({
      results: [{ rows: [] }],
    });
    expect(connection.execSql).toHaveBeenCalledTimes(1);
    expect(next.execSql).toHaveBeenCalledTimes(1);
  });

  it("#8 abort in the enqueue await-window rejects the op before it executes", async () => {
    const { adapter, connection } = makeAdapter();

    // Queue is idle → `await previous` resolves on a microtask. Aborting
    // synchronously lands inside that window: the op must see the bumped
    // generation and reject without ever reaching execSql.
    const op = callExecute(adapter, "UPDATE dbo.t SET a = 1");
    const opAssertion = expect(op).rejects.toThrow(STALE_OP_MESSAGE);
    await adapter.abortActiveQuery();

    await opAssertion;
    expect(connection.execSql).not.toHaveBeenCalled();
    expect(activeRequestsOf(adapter).size).toBe(0);
  });
});

function settleOn(
  connection: FakeConnection,
  request: TediousRequest,
  error: Error | null = null,
  rowCount = 0,
): void {
  connection.pending.delete(request);
  callbackOf(request)?.(error, rowCount);
}
