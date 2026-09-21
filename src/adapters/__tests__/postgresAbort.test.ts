// src/adapters/__tests__/postgresAbort.test.ts
//
// TASK-SQLHANG-002 — PostgresAdapter.abortActiveQuery + bounded cleanup.
// Cases 1-4 and 8 of the task file's §Test Cases.
//
// Pattern: vi.mock("pg") hoisted factory + module-scoped state shared via
// closure (same convention as postgres.test.ts). `state.nextClient` is the
// client pool.connect() hands to the NEXT checkout — tests install a
// per-case client (parked query, hanging ROLLBACK, processID) after
// connect() so the SELECT 1 probe still uses the default client.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import { Client } from "pg";
import { PostgresAdapter } from "../postgres";

interface FakeClient {
  query: Mock;
  release: Mock;
  processID?: number;
}
interface FakeDedicated {
  connect: Mock;
  query: Mock;
  end: Mock;
}

// Module-scoped state — read by the vi.mock factory callbacks at call time.
const state = {
  nextClient: null as FakeClient | null,
  dedicatedClients: [] as FakeDedicated[],
};

vi.mock("pg", () => {
  const defaultClient: FakeClient = {
    query: vi.fn(() => Promise.resolve({ rows: [], fields: [] })),
    release: vi.fn(),
  };
  const fakePool = {
    query: vi.fn(() => Promise.resolve({ rows: [], fields: [] })),
    connect: vi.fn(() => Promise.resolve(state.nextClient ?? defaultClient)),
    end: vi.fn(() => Promise.resolve()),
  };
  const PoolCtor = vi.fn(() => fakePool);
  // Dedicated one-off Client used by cancelBackendViaDedicatedClient /
  // cancelActiveQuery / abortActiveQuery for pg_cancel_backend.
  const ClientCtor = vi.fn(() => {
    const dedicated: FakeDedicated = {
      connect: vi.fn(() => Promise.resolve()),
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      end: vi.fn(() => Promise.resolve()),
    };
    state.dedicatedClients.push(dedicated);
    return dedicated;
  });
  return { Pool: PoolCtor, Client: ClientCtor };
});

function cfg(): ConnectionConfig {
  return {
    id: "c1",
    name: "test",
    driver: "postgres",
    host: "127.0.0.1",
    port: 5433,
    user: "UnicDB",
    database: "UnicDB",
  };
}

beforeEach(() => {
  state.nextClient = null;
  state.dedicatedClients.length = 0;
  vi.mocked(Client).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

type Abortable = { abortActiveQuery?: () => Promise<void> };

describe("PostgresAdapter — abortActiveQuery (TASK-SQLHANG-002)", () => {
  it("case 1: abort with a checked-out runQuery client cancels the PID via a dedicated client and destroy-releases the held client", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const inFlight = Promise.withResolvers<never>();
    let calls = 0;
    const client: FakeClient = {
      processID: 4242,
      query: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          // The in-flight statement parks until the connection is destroyed.
          return inFlight.promise;
        }
        // Post-destroy cleanup queries (ROLLBACK) fail fast.
        return Promise.reject(new Error("connection destroyed"));
      }),
      release: vi.fn((destroy?: boolean) => {
        // Real pg: release(true) destroys the socket → parked query rejects.
        if (destroy) inFlight.reject(new Error("connection destroyed"));
      }),
    };
    state.nextClient = client;

    const run = adapter.runQuery("UPDATE t SET a = 1; UPDATE t SET b = 2");
    run.catch(() => undefined);
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(1));

    await (adapter as Abortable).abortActiveQuery!();

    // Dedicated client issued pg_cancel_backend for the tracked PID.
    expect(state.dedicatedClients.length).toBe(1);
    expect(state.dedicatedClients[0].query).toHaveBeenCalledWith(
      "SELECT pg_cancel_backend($1)",
      [4242],
    );
    // The held client was destroy-released, settling the parked query.
    expect(client.release).toHaveBeenCalledWith(true);
    await expect(run).rejects.toThrow("connection destroyed");
  });

  it("case 2: a second abortActiveQuery is a no-op — no extra dedicated client, never throws", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const inFlight = Promise.withResolvers<never>();
    const client: FakeClient = {
      processID: 5150,
      query: vi.fn(() => inFlight.promise),
      release: vi.fn((destroy?: boolean) => {
        if (destroy) inFlight.reject(new Error("connection destroyed"));
      }),
    };
    state.nextClient = client;

    const run = adapter.runQuery("UPDATE t SET a = 1; UPDATE t SET b = 2");
    run.catch(() => undefined);
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(1));

    await (adapter as Abortable).abortActiveQuery!();
    await (adapter as Abortable).abortActiveQuery!();
    await (adapter as Abortable).abortActiveQuery!();

    // Exactly one dedicated client for the single tracked PID — the repeat
    // aborts found empty tracking sets and did nothing.
    expect(state.dedicatedClients.length).toBe(1);
    await expect(run).rejects.toThrow("connection destroyed");
  });

  it("case 3: abort with nothing in flight resolves immediately and constructs NO dedicated Client", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    // Fresh adapter — never connected, empty tracking sets.
    await expect(
      (adapter as Abortable).abortActiveQuery!(),
    ).resolves.toBeUndefined();
    expect(state.dedicatedClients.length).toBe(0);
    expect(Client).not.toHaveBeenCalled();

    // Connected but idle — still nothing to abort.
    await adapter.connect();
    await expect(
      (adapter as Abortable).abortActiveQuery!(),
    ).resolves.toBeUndefined();
    expect(state.dedicatedClients.length).toBe(0);
    await adapter.close();
  });

  it("case 4: statement error + hanging ROLLBACK → runQuery rejects with the ORIGINAL error and destroy-releases the client", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const hanging = Promise.withResolvers<never>();
    const client: FakeClient = {
      processID: 777,
      query: vi.fn((sql: string) => {
        if (sql === "ROLLBACK") return hanging.promise; // never settles
        return Promise.reject(new Error("stmt boom"));
      }),
      release: vi.fn(),
    };
    state.nextClient = client;

    vi.useFakeTimers();
    const run = adapter.runQuery("UPDATE t SET a = 1; UPDATE t SET b = 2");
    const assertion = expect(run).rejects.toThrow("stmt boom");
    // CLEANUP_GRACE_MS (3s) expires → destroy path, original error wins.
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it("case 8 (regression): multi-stmt batch, stmt 2 rejects inside BEGIN…COMMIT script → original error, client released exactly once (destroy)", async () => {
    const adapter = new PostgresAdapter(cfg(), "pw");
    await adapter.connect();

    const hanging = Promise.withResolvers<never>();
    const client: FakeClient = {
      processID: 888,
      query: vi.fn((sql: string) => {
        if (sql === "ROLLBACK") return hanging.promise; // dead conn
        if (sql.startsWith("UPDATE t SET b")) {
          return Promise.reject(new Error("stmt-2 boom"));
        }
        return Promise.resolve({
          rows: [],
          fields: [],
          rowCount: 1,
          command: "UPDATE",
        });
      }),
      release: vi.fn(),
    };
    state.nextClient = client;

    vi.useFakeTimers();
    const run = adapter.runQuery(
      "BEGIN; UPDATE t SET a = 1; UPDATE t SET b = 2; COMMIT;",
    );
    const assertion = expect(run).rejects.toThrow("stmt-2 boom");
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    // Exactly one release — the destroy path after the bounded ROLLBACK
    // timed out; no plain release() poisoning the pool.
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
