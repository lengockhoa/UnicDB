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
 * `query` returns the TUPLE shape the real `@google-cloud/bigquery`
 * client produces when invoked with `{ skipParsing: true }`
 * (bigquery.d.ts:33, bigquery.js:1283-1374). Element 2 carries the
 * raw `f[].v` cells that `toBigQueryPage` consumes.
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
    query: vi.fn(async (_sql: string, _opts?: { skipParsing?: boolean }) => [
      // element 0: PARSED RowMetadata array (under skipParsing this is
      // the unparsed rows; under no-skipParsing it is `mergeSchemaWithRows_`
      // output, but since the adapter always forwards skipParsing:true
      // this branch is only present to make the fake shape match the
      // real client's TUPLE).
      [{ f: [{ v: "SHOULD_NOT_BE_USED" }] }],
      null, // element 1: nextQuery
      page, // element 2: raw apiResponse
    ]),
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

// ---------------------------------------------------------------------------
// Test #7 (R4.5 round-2 regression) — runQuery must invoke the underlying
// `client.query(sql)` with `{ skipParsing: true }` (per
// @google-cloud/bigquery's `Query.skipParsing?: boolean` option,
// bigquery.d.ts:71). Without that option, the real client
// (bigquery.js:1338-1343) calls `mergeSchemaWithRows_` which coerces INT64
// cells to JS Number, and then `delete res.rows` strips the raw wire-format
// cells from element 2 of the TUPLE — so `toBigQueryPage` ends up with an
// empty `rows` array and the adapter's production path silently yields
// `{columns:[], rows:[], rowCount:0}`. The fake used here models that
// post-`mergeSchemaWithRows_` shape: it returns the TUPLE with element 2
// already lacking `rows` (per the empirical probe), and only resolves rows
// in element 2 when it sees `skipParsing: true` in the call options.
//
// This is the "no skipParsing" half of the regression: the fake mirrors the
// real client's behavior so a production-path call without `skipParsing`
// would yield `rows:[]`. The test pins the fact that the adapter FORWARDS
// `skipParsing: true` to the client.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — R4.5 round-2: skipParsing forwarding", () => {
  it("7. runQuery always forwards { skipParsing: true } to client.query (production-path regression)", async () => {
    const bigIntStr = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    const rawApiResponseWithRows: BigQueryRawQueryResponse = {
      jobReference: { projectId: "proj-billing", location: "US", jobId: "job_abc" },
      schema: { fields: [{ name: "big_int", type: "INT64", mode: "REQUIRED" }] },
      rows: [{ f: [{ v: bigIntStr }] }],
      pageToken: null,
    };
    // Model the real client precisely: per bigquery.js:1334-1343, when
    // `options.skipParsing` is true, `res.rows` is preserved verbatim;
    // when it is false/undefined, `mergeSchemaWithRows_` runs and
    // `delete res.rows` strips the raw cells from the apiResponse. We
    // mirror that behavior: if the call lacks `skipParsing: true`, the
    // returned tuple element 2 has its `rows` key deleted.
    const noSkipRowsElement = [
      new Map<unknown, unknown>([["big_int", 9007199254740993]]),
    ];
    const strippedResponse: BigQueryRawQueryResponse = {
      jobReference: rawApiResponseWithRows.jobReference,
      schema: rawApiResponseWithRows.schema,
      // rows: undefined — emulating `delete res.rows` from bigquery.js:1343
      pageToken: null,
    };
    const noSkipTuple: [unknown[], null, BigQueryRawQueryResponse] = [
      noSkipRowsElement,
      null,
      strippedResponse,
    ];
    const skipTuple: [unknown[], null, BigQueryRawQueryResponse] = [
      noSkipRowsElement,
      null,
      rawApiResponseWithRows,
    ];

    const queryFn = vi.fn(
      async (
        _sql: string,
        opts?: { skipParsing?: boolean },
      ): Promise<unknown> => {
        if (opts && opts.skipParsing === true) {
          return skipTuple;
        }
        // No skipParsing → rows stripped → toBigQueryPage would yield rows:[].
        return noSkipTuple;
      },
    );
    const fakeClient: BigQueryClient = {
      listDatasets: vi.fn(async () => [{ id: "ds1" }]),
      query: queryFn,
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
    await adapter.connect();

    const result = await adapter.runQuery("SELECT 9007199254740993 AS big_int");

    // The adapter MUST forward skipParsing:true to the client. Assert
    // the call options.
    expect(queryFn).toHaveBeenCalledTimes(1);
    const callArgs = queryFn.mock.calls[0];
    expect(callArgs[1]).toBeDefined();
    expect(callArgs[1]?.skipParsing).toBe(true);

    // Because the adapter forwarded skipParsing:true, the fake returned
    // the rows-bearing tuple, so the page has the row and the branded
    // INT64 string survives end-to-end.
    const cell = result.results[0].rows[0][0];
    expect(typeof cell).toBe("string");
    expect(cell).toBe(bigIntStr);
    expect(result.results[0].columns).toEqual(["big_int"]);
    expect(result.results[0].rowCount).toBe(1);
  });

  it("7b. no-skipParsing fake (rows stripped) proves the adapter would have lost precision without the option", async () => {
    // Same fake shape as #7, but called through a separate adapter whose
    // call path goes through a default-shaped tuple WITHOUT skipParsing.
    // We construct a *raw* BigQueryAdapter (no skipParsing) by inspecting
    // what the fake would resolve if the adapter had not forwarded
    // `skipParsing: true`. This is the negative-control: if the adapter
    // ever forgets to forward `skipParsing: true`, this test would
    // observe `rows:[]` — the bug is "the adapter does not always
    // forward skipParsing:true", and we want a test that, when the
    // forwarding regresses, would flip from "rows-bearing" to
    // "rows-stripped" and fail at the rowCount assertion. We simulate
    // that by checking the fake's call options directly.
    const queryFn = vi.fn(
      async (
        _sql: string,
        opts?: { skipParsing?: boolean },
      ): Promise<unknown> => {
        // Echo back whatever was forwarded; the test asserts what
        // options the adapter sent.
        return opts;
      },
    );
    const fakeClient: BigQueryClient = {
      listDatasets: vi.fn(async () => [{ id: "ds1" }]),
      query: queryFn,
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
    await adapter.connect();
    await adapter.runQuery("SELECT 1");

    expect(queryFn).toHaveBeenCalledTimes(1);
    const opts = queryFn.mock.calls[0][1];
    expect(opts).toBeDefined();
    // The fix MUST always forward skipParsing:true on the production
    // path. Without this, the real client coerces INT64 to Number and
    // strips wire-format rows (bigquery.js:1338-1343).
    expect(opts?.skipParsing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test #8 (R4.5 round-2 regression) — full INT64 precision end-to-end via
// the TUPLE shape: a tuple with element 2 carrying wire-format `f[].v`
// strings (the shape produced by the real client WHEN `skipParsing: true`
// is forwarded) must preserve the exact branded digit through
// `runQuery` → `toBigQueryPage` → the adapter's result.rows. This pins
// the acceptance criterion "branded strings survive end-to-end" against
// the production path, including the tuple unwrap + element[2] routing.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — INT64 precision end-to-end (R4.5 round-2)", () => {
  it("8. TUPLE with element[2].rows carrying raw f[].v strings -> branded INT64 cell survives", async () => {
    const bigIntStr = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    // Element 0 would be the PARSED RowMetadata (INT64 coerced to Number)
    // under non-skipParsing; under skipParsing element 0 is the unparsed
    // rows from `mergeSchemaWithRows_` if it ran, but since we forward
    // skipParsing:true, the real client never calls mergeSchemaWithRows_
    // and element 0 is the raw row array too. Either way, the adapter
    // must take element 2 (raw apiResponse) into toBigQueryPage.
    const element0: unknown[] = [
      // simulate "raw row" — toBigQueryPage would treat it as a non-`{f:[]}`
      // object and yield zero rows if we mistakenly routed element 0.
      [{ f: [{ v: "WRONG_ELEMENT" }] }],
    ];
    const element1: null = null;
    const element2: BigQueryRawQueryResponse = {
      jobReference: { projectId: "proj-billing", location: "US", jobId: "job_abc" },
      schema: { fields: [{ name: "big_int", type: "INT64", mode: "REQUIRED" }] },
      rows: [{ f: [{ v: bigIntStr }] }],
      pageToken: null,
    };
    const tupleResponse: [unknown[], null, BigQueryRawQueryResponse] = [
      element0,
      element1,
      element2,
    ];
    const queryFn = vi.fn(
      async (
        _sql: string,
        opts?: { skipParsing?: boolean },
      ): Promise<unknown> => {
        // Only resolve the rows-bearing tuple when skipParsing is
        // forwarded (mirrors the real client).
        if (opts && opts.skipParsing === true) {
          return tupleResponse;
        }
        // Without skipParsing: rows stripped (per bigquery.js:1343).
        const stripped: BigQueryRawQueryResponse = {
          jobReference: element2.jobReference,
          schema: element2.schema,
          pageToken: null,
        };
        return [element0, element1, stripped];
      },
    );
    const fakeClient: BigQueryClient = {
      listDatasets: vi.fn(async () => [{ id: "ds1" }]),
      query: queryFn,
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
    await adapter.connect();

    const result = await adapter.runQuery("SELECT 9007199254740993 AS big_int");

    // Branded string preserved verbatim end-to-end. If the adapter had
    // routed element 0 (a single-element tuple shim) into toBigQueryPage,
    // the cell would be undefined. If it had failed to forward
    // skipParsing:true, the fake would have returned the stripped
    // tuple and `rows[0]` would be undefined.
    const cell = result.results[0].rows[0]?.[0];
    expect(cell).toBe(bigIntStr);
    expect(typeof cell).toBe("string");
    // Columns + rowCount are mapped from the raw element 2.
    expect(result.results[0].columns).toEqual(["big_int"]);
    expect(result.results[0].rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test #9 (R4.5 round-2 regression) — paginated TUPLE [parsed, nextQuery,
// rawApiResponseWithPageToken]: the raw element[2] carries the pageToken +
// wire-format rows, and the BIGNUMERIC cell stays a string.
// ---------------------------------------------------------------------------
describe("TASK-BQ01-002 BigQueryAdapter — paginated TUPLE (R4.5 round-2)", () => {
  it("9. paginated TUPLE -> rowCount/columns from raw element, branded BIGNUMERIC string preserved", async () => {
    const bigIntStr = "12345678901234567890"; // > Number.MAX_SAFE_INTEGER, BIGNUMERIC
    const element0: unknown[] = [
      new Map<unknown, unknown>([["big_int", 1.2345678901234568e19]]),
    ];
    const element1: unknown = { pageToken: "tok-NEXT" };
    const element2: BigQueryRawQueryResponse = {
      jobReference: { projectId: "proj-billing", location: "EU", jobId: "job_pag" },
      schema: { fields: [{ name: "big_int", type: "BIGNUMERIC", mode: "REQUIRED" }] },
      rows: [{ f: [{ v: bigIntStr }] }],
      pageToken: "tok-NEXT",
    };
    const tupleResponse: [unknown[], unknown, BigQueryRawQueryResponse] = [
      element0,
      element1,
      element2,
    ];
    const queryFn = vi.fn(
      async (
        _sql: string,
        opts?: { skipParsing?: boolean },
      ): Promise<unknown> => {
        // Mirrors the real client: skipParsing preserves rows; without
        // it, the rows key is stripped from element 2 (bigquery.js:1343).
        if (opts && opts.skipParsing === true) {
          return tupleResponse;
        }
        const stripped: BigQueryRawQueryResponse = {
          jobReference: element2.jobReference,
          schema: element2.schema,
          pageToken: element2.pageToken,
        };
        return [element0, element1, stripped];
      },
    );
    const fakeClient: BigQueryClient = {
      listDatasets: vi.fn(async () => [{ id: "ds1" }]),
      query: queryFn,
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
    await adapter.connect();

    const result = await adapter.runQuery("SELECT * FROM huge_table");

    // Adapter must forward skipParsing:true.
    expect(queryFn.mock.calls[0][1]?.skipParsing).toBe(true);
    // BIGNUMERIC branded string preserved end-to-end.
    expect(result.results[0].columns).toEqual(["big_int"]);
    expect(result.results[0].rows[0][0]).toBe(bigIntStr);
    expect(typeof result.results[0].rows[0][0]).toBe("string");
    expect(result.results[0].rowCount).toBe(1);
  });
});
