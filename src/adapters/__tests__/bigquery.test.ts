// src/adapters/__tests__/bigquery.test.ts
//
// TASK-BQ01-002 — `BigQueryAdapter implements DbAdapter` (BQ-01 cycle).
//
// This test file exercises the adapter's:
//   1. happy connect — fake client, projectId propagates, smoke resolves "ok"
//   2. typed diagnostic on no-ADC failure — BigQueryConnectError w/ AdcDiagnostic,
//      raw message NOT carried on the error object, remediation matches gcloud copy
//   3. idempotent close — second close is a no-op; factory NOT re-called
//   4. location propagation — cfg.bigquery.location flows through to the factory opts
//   5. branded strings survive normalization — INT64 cell remains typeof "string"
//   6. runQuery after close — rejects with BigQueryClosedError, factory NOT re-called
//
// All client I/O is via injected fakes. No real GCP calls. No @google-cloud/bigquery
// mock plumbing (seam only).
import { describe, it, expect, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import type { BigQueryConnectionFields } from "../../config/types";
import type { BigQueryPage, BigQueryRawQueryResponse } from "../bigqueryTypes";
import type { BigQueryClientLike } from "../bigqueryAdc";
import {
  BigQueryAdapter,
  BigQueryConnectError,
  BigQueryClosedError,
  type BigQueryClient,
  type BigQueryClientFactory,
} from "../bigquery";

// ---------------------------------------------------------------------------
// Fixtures — minimal configs and fake clients (mirror bigqueryAdc.test.ts style)
// ---------------------------------------------------------------------------

function bqCfg(overrides: {
  billingProject?: string;
  location?: string;
}): ConnectionConfig {
  const bigquery: BigQueryConnectionFields = {
    billingProject: overrides.billingProject ?? "proj-billing",
  };
  if (overrides.location !== undefined) {
    bigquery.location = overrides.location;
  }
  return {
    id: "c1",
    name: "bq-test",
    driver: "bigquery",
    host: "",
    port: 0,
    user: "",
    database: "",
    bigquery,
  };
}

/**
 * Build a `BigQueryClient` (the adapter's broader seam) that records calls.
 * `listDatasets` resolves to a one-row list so `runAdcSmoke` returns "ok".
 * `query` returns a synthetic raw response shaped like the BigQuery wire.
 */
function makeFakeClient(
  page: BigQueryRawQueryResponse = DEFAULT_PAGE,
): BigQueryClient & {
  listDatasets: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  getQueryResults: ReturnType<typeof vi.fn>;
  createQueryJob: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  getDataset: ReturnType<typeof vi.fn>;
  getTable: ReturnType<typeof vi.fn>;
} {
  return {
    listDatasets: vi.fn(async () => [{ id: "ds1" }]),
    query: vi.fn(async () => page),
    getQueryResults: vi.fn(async () => page),
    createQueryJob: vi.fn(async () => ({ id: "job_xyz" })),
    cancel: vi.fn(async () => undefined),
    getDataset: vi.fn(async () => ({ id: "ds1" })),
    getTable: vi.fn(async () => ({ id: "t1" })),
  };
}

/** Default page — 1 row, INT64 cell as branded string > MAX_SAFE_INTEGER. */
const DEFAULT_PAGE: BigQueryRawQueryResponse = {
  jobReference: { projectId: "proj-billing", location: "US", jobId: "job_abc" },
  schema: { fields: [{ name: "big_int", type: "INT64", mode: "REQUIRED" }] },
  rows: [{ f: [{ v: "9007199254740993" }] }],
  pageToken: null,
};

// ---------------------------------------------------------------------------
// Test #1 — happy: connect() resolves; projectId propagates to factory
// opts; runAdcSmoke returns "ok".
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — happy connect", () => {
  it("1. connect resolves; factory called once with projectId; smoke ok", async () => {
    const fakeClient = makeFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    // Factory invoked exactly once with the cfg's billing project (location omitted).
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      projectId: "proj-billing",
    });

    // runAdcSmoke exercised the fake's listDatasets.
    expect(fakeClient.listDatasets).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test #2 — typed diagnostic: no-ADC failure -> BigQueryConnectError with
// diagnostic.category === "missing_adc" + remediation matches gcloud copy.
// Raw message must NOT be carried on the error object.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — typed diagnostic on no-ADC failure", () => {
  it("2. smoke throwing missing-adc -> BigQueryConnectError(diagnostic) without raw msg", async () => {
    const leak = "ZZZ-LEAK-9981";
    const fakeClient: BigQueryClient = {
      listDatasets: vi.fn(async () => {
        throw new Error(`Could not load the default credentials. context=${leak}`);
      }),
      query: vi.fn(),
      getQueryResults: vi.fn(),
      createQueryJob: vi.fn(),
      cancel: vi.fn(),
      getDataset: vi.fn(),
      getTable: vi.fn(),
    };
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await expect(adapter.connect()).rejects.toBeInstanceOf(BigQueryConnectError);

    let captured: unknown;
    try {
      await adapter.connect();
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(BigQueryConnectError);
    const err = captured as BigQueryConnectError;
    expect(err.diagnostic.category).toBe("missing_adc");
    expect(err.diagnostic.remediation).toMatch(/gcloud auth application-default login/);
    // Raw message must NOT be carried.
    expect(err.message).not.toMatch(leak);
    expect(err.diagnostic.remediation).not.toMatch(leak);
  });
});

// ---------------------------------------------------------------------------
// Test #3 — idempotent close: double close resolves; factory still called
// exactly once; connect() after close throws the explicit closed-error.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — idempotent close", () => {
  it("3. double close resolves; connect() after close throws closed-error; factory still 1 call", async () => {
    const fakeClient = makeFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    expect(factory).toHaveBeenCalledTimes(1);

    // First close: resolves, drops client.
    await expect(adapter.close()).resolves.toBeUndefined();
    // Second close: idempotent no-op.
    await expect(adapter.close()).resolves.toBeUndefined();
    // Factory still called exactly once — no rebuild on second close.
    expect(factory).toHaveBeenCalledTimes(1);

    // Subsequent connect() after close must throw the explicit closed-error,
    // and must NOT call the factory again.
    await expect(adapter.connect()).rejects.toBeInstanceOf(BigQueryClosedError);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Test #4 — location propagation: cfg.bigquery.location === "EU" -> factory
// observed opts include location "EU" alongside projectId.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — explicit location propagation", () => {
  it("4. cfg.location='EU' propagates to factory opts alongside projectId", async () => {
    const fakeClient = makeFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(
      bqCfg({ location: "EU" }),
      factory,
    );
    await adapter.connect();

    expect(factory).toHaveBeenCalledTimes(1);
    const opts = factory.mock.calls[0][0];
    expect(opts.projectId).toBe("proj-billing");
    expect(opts.location).toBe("EU");
  });
});

// ---------------------------------------------------------------------------
// Test #5 — branded strings survive normalization: INT64 cell remains typeof
// "string" with exact digit equality after the adapter's runQuery.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — branded strings survive normalization", () => {
  it("5. INT64 cell stays a string with exact digit equality through runQuery", async () => {
    const bigIntStr = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    const rawPage: BigQueryRawQueryResponse = {
      jobReference: { projectId: "proj-billing", location: "US", jobId: "job_abc" },
      schema: { fields: [{ name: "big_int", type: "INT64", mode: "REQUIRED" }] },
      rows: [{ f: [{ v: bigIntStr }] }],
      pageToken: null,
    };
    const fakeClient = makeFakeClient(rawPage);
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    const result = await adapter.runQuery("SELECT 9007199254740993 AS big_int");

    // Column name mapped from schema.
    expect(result.results[0].columns).toEqual(["big_int"]);
    // INT64 cell survives as a string with exact digit equality.
    const cell = result.results[0].rows[0][0];
    expect(typeof cell).toBe("string");
    expect(cell).toBe(bigIntStr);
    // rowCount is the mapped page row count.
    expect(result.results[0].rowCount).toBe(1);
    // No batched cursor for a small query.
    expect(result.batched).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test #6 — runQuery after close: rejects with BigQueryClosedError, does
// NOT construct a fresh client.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — runQuery after close", () => {
  it("6. runQuery after close rejects with closed-error; factory still 1 call", async () => {
    const fakeClient = makeFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    expect(factory).toHaveBeenCalledTimes(1);
    await adapter.close();

    await expect(adapter.runQuery("SELECT 1")).rejects.toBeInstanceOf(
      BigQueryClosedError,
    );
    // Factory not re-called for the post-close runQuery.
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
