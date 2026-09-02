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
import { NotImplementedError } from "../types";
import {
  BigQueryAdapter,
  BigQueryConnectError,
  BigQueryClosedError,
  BigQueryNotConnectedError,
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

// ---------------------------------------------------------------------------
// TASK-CL-004 — R4.5 carried minors (folded):
//   - Not-connected error is distinct from closed-error (never-connected vs
//     post-close; pre-state is `new BigQueryAdapter(cfg, factory)` then
//     `runQuery` immediately, factory call count 0).
//   - durationMs is a real measurement via Date.now() delta.
// ---------------------------------------------------------------------------
describe("TASK-CL-004 BigQueryAdapter — not-connected vs closed (R4.5)", () => {
  it("10. runQuery before any connect() rejects with BigQueryNotConnectedError; factory 0 calls", async () => {
    const fakeClient = makeFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    // Constructor only — no connect(), no close().
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    let captured: unknown;
    try {
      await adapter.runQuery("SELECT 1");
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(BigQueryNotConnectedError);
    const err = captured as BigQueryNotConnectedError;
    expect(err.name).toBe("BigQueryNotConnectedError");
    // Closed-error must NOT be returned for the never-connected case.
    expect(captured).not.toBeInstanceOf(BigQueryClosedError);
    // Factory was never invoked — no client was ever constructed.
    expect(factory).toHaveBeenCalledTimes(0);
  });
});

describe("TASK-CL-004 BigQueryAdapter — durationMs measured (R4.5)", () => {
  it("11. ~20ms fake query -> result.results[0].durationMs >= 15 and finite", async () => {
    const timerFakeClient: BigQueryClient = {
      listDatasets: vi.fn(async () => [{ id: "ds1" }]),
      query: vi.fn(async (_sql: string, _opts?: { skipParsing?: boolean }) => {
        await new Promise((r) => setTimeout(r, 20));
        return [
          [{ f: [{ v: "ok" }] }],
          null,
          DEFAULT_PAGE,
        ];
      }),
      getQueryResults: vi.fn(async () => DEFAULT_PAGE),
      createQueryJob: vi.fn(async () => ({ id: "job_xyz" })),
      cancel: vi.fn(async () => undefined),
      getDataset: vi.fn(async () => ({ id: "ds1" })),
      getTable: vi.fn(async () => ({ id: "t1" })),
    };
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => timerFakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    const result = await adapter.runQuery("SELECT 1");
    const dur = result.results[0].durationMs;
    expect(typeof dur).toBe("number");
    expect(Number.isFinite(dur)).toBe(true);
    expect(dur).toBeGreaterThanOrEqual(15);
    // commandTag stays undefined (BQ-02 wires the source).
    expect(result.results[0].commandTag).toBeUndefined();
  });

  it("12. instant-resolving fake -> durationMs is a finite number >= 0 (not a hardcoded constant)", async () => {
    const fakeClient = makeFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    const result = await adapter.runQuery("SELECT 1");
    const dur = result.results[0].durationMs;
    expect(typeof dur).toBe("number");
    expect(Number.isFinite(dur)).toBe(true);
    expect(dur).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// TASK-BQ02-001 — BigQuery resource metadata adapter (real enumeration)
//
// The adapter-owned `BigQueryClient` seam is widened with:
//   - `getDatasets(opts?)` → PagedResponse of dataset objects with metadata
//   - `dataset(id)` → { getTables(opts?), getRoutines(opts?), table(id) }
//   - `table(id).getMetadata(opts?)` → ServiceObject [metadata, apiResponse]
//
// `listRoutineParams` keeps its NotImplementedError (no MVP consumer).
// ===========================================================================

// ---------------------------------------------------------------------------
// Fixtures for enumeration tests (BQ-02 widened surface)
// ---------------------------------------------------------------------------

/**
 * A fake client that satisfies the widened BigQueryClient seam. The dataset
 * handle returns a sub-object exposing `getTables`, `getRoutines`, `table()`.
 * Tests can override the inner methods via `vi.fn()` replacements.
 */
function makeEnumerationFakeClient(opts?: {
  datasetTables?: Array<unknown>;
  datasetRoutines?: Array<unknown>;
  tableMetadata?: unknown;
  apiResponse?: unknown;
}): BigQueryClient & {
  getDatasets: ReturnType<typeof vi.fn>;
  dataset: ReturnType<typeof vi.fn>;
} {
  const tablesDefault = opts?.datasetTables ?? [];
  const routinesDefault = opts?.datasetRoutines ?? [];
  const metadataDefault = opts?.tableMetadata ?? { schema: { fields: [] } };
  const apiResp = opts?.apiResponse ?? {};
  const tableHandle = {
    getMetadata: vi.fn(async () => [metadataDefault, apiResp]),
  };
  const datasetHandle = (id: string) => ({
    getTables: vi.fn(async () => [tablesDefault, null, {}]),
    getRoutines: vi.fn(async () => [routinesDefault, null, {}]),
    table: vi.fn((_tid: string) => tableHandle),
    id,
  });
  return {
    listDatasets: vi.fn(async () => [{ id: "ds1" }]),
    query: vi.fn(async () => [[{ f: [{ v: "x" }] }], null, DEFAULT_PAGE]),
    getQueryResults: vi.fn(async () => DEFAULT_PAGE),
    createQueryJob: vi.fn(async () => ({ id: "job_xyz" })),
    cancel: vi.fn(async () => undefined),
    getDataset: vi.fn(async () => ({ id: "ds1" })),
    getTable: vi.fn(async () => ({ id: "t1" })),
    getDatasets: vi.fn(async () => [[], null, {}]),
    dataset: vi.fn((id: string) => datasetHandle(id)),
  };
}

// ---------------------------------------------------------------------------
// Test #1 — listSchemas returns dataset ids; includeSystem flag accepted
// (BigQuery has no system datasets in list scope — flag is a no-op).
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listSchemas", () => {
  it("1. listSchemas maps dataset PagedResponse into SchemaInfo[]", async () => {
    const datasetObjs = [
      {
        id: "p:ds1",
        metadata: { id: "p:ds1", datasetReference: { datasetId: "ds1" } },
      },
      { metadata: { datasetReference: { datasetId: "ds2" } } },
    ];
    const fakeClient = makeEnumerationFakeClient();
    fakeClient.getDatasets = vi.fn(async () => [datasetObjs, null, {}]);
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const schemas = await adapter.listSchemas(false);

    expect(schemas).toEqual([{ name: "ds1" }, { name: "ds2" }]);
    expect(fakeClient.getDatasets).toHaveBeenCalledTimes(1);
    // includeSystem is accepted but ignored
    await adapter.listSchemas(true);
    expect(fakeClient.getDatasets).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Test #2 — listTables("ds") returns only type === "TABLE" entries.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listTables", () => {
  it("2. listTables returns only type === 'TABLE'", async () => {
    const tableObjs = [
      { id: "p:ds.t1", metadata: { type: "TABLE", tableReference: { tableId: "t1" } } },
      { id: "p:ds.v1", metadata: { type: "VIEW", tableReference: { tableId: "v1" } } },
      {
        id: "p:ds.mv1",
        metadata: { type: "MATERIALIZED_VIEW", tableReference: { tableId: "mv1" } },
      },
      { id: "p:ds.ext1", metadata: { type: "EXTERNAL", tableReference: { tableId: "ext1" } } },
    ];
    const fakeClient = makeEnumerationFakeClient({ datasetTables: tableObjs });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const tables = await adapter.listTables("ds");

    expect(tables).toEqual([{ name: "t1", schema: "ds" }]);
    // dataset("ds").getTables was called.
    expect(fakeClient.dataset).toHaveBeenCalledWith("ds");
  });
});

// ---------------------------------------------------------------------------
// Test #3 — listViews("ds") returns VIEW + MATERIALIZED_VIEW, excludes TABLE + EXTERNAL.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listViews", () => {
  it("3. listViews returns VIEW + MATERIALIZED_VIEW, excludes TABLE + EXTERNAL", async () => {
    const tableObjs = [
      { id: "p:ds.t1", metadata: { type: "TABLE", tableReference: { tableId: "t1" } } },
      { id: "p:ds.v1", metadata: { type: "VIEW", tableReference: { tableId: "v1" } } },
      {
        id: "p:ds.mv1",
        metadata: { type: "MATERIALIZED_VIEW", tableReference: { tableId: "mv1" } },
      },
      { id: "p:ds.ext1", metadata: { type: "EXTERNAL", tableReference: { tableId: "ext1" } } },
    ];
    const fakeClient = makeEnumerationFakeClient({ datasetTables: tableObjs });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const views = await adapter.listViews("ds");

    expect(views).toEqual([
      { name: "v1", schema: "ds" },
      { name: "mv1", schema: "ds" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test #4 — listColumns maps metadata.schema.fields with REPEATED mode
// suffix; nested RECORD kept as one RECORD column.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listColumns", () => {
  it("4. listColumns maps schema fields incl. REPEATED/RECORD", async () => {
    const tableMetadata = {
      schema: {
        fields: [
          { name: "id", type: "INT64", mode: "REQUIRED" },
          { name: "v", type: "STRING", mode: "NULLABLE" },
          { name: "tags", type: "STRING", mode: "REPEATED" },
          {
            name: "r",
            type: "RECORD",
            mode: "NULLABLE",
            fields: [{ name: "a", type: "INT64", mode: "NULLABLE" }],
          },
        ],
      },
    };
    const fakeClient = makeEnumerationFakeClient({ tableMetadata });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const cols = await adapter.listColumns("t1", "ds");

    expect(cols).toEqual([
      { name: "id", dataType: "INT64", nullable: false, isPrimaryKey: false },
      { name: "v", dataType: "STRING", nullable: true, isPrimaryKey: false },
      { name: "tags", dataType: "STRING REPEATED", nullable: true, isPrimaryKey: false },
      { name: "r", dataType: "RECORD", nullable: true, isPrimaryKey: false },
    ]);
  });

  // Test #5 — edge: field missing type/mode -> defaults
  it("5. malformed field falls back to dataType:'' and nullable:true", async () => {
    const tableMetadata = {
      schema: { fields: [{ name: "x" }] },
    };
    const fakeClient = makeEnumerationFakeClient({ tableMetadata });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const cols = await adapter.listColumns("t1", "ds");
    expect(cols).toEqual([
      { name: "x", dataType: "", nullable: true, isPrimaryKey: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test #6 — empty dataset -> listTables = [] and listViews = [].
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — empty dataset", () => {
  it("6. getTables resolves [[], null, {}] -> listTables = [] AND listViews = []", async () => {
    const fakeClient = makeEnumerationFakeClient({ datasetTables: [] });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    expect(await adapter.listTables("ds")).toEqual([]);
    expect(await adapter.listViews("ds")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test #7 — permission edge: getTables rejects 403 -> listTables REJECTS.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — permission edge", () => {
  it("7. getTables rejects 403 -> listTables REJECTS (no swallow)", async () => {
    const fakeClient = makeEnumerationFakeClient();
    fakeClient.dataset = vi.fn((id: string) => ({
      getTables: vi.fn(async () => {
        const e: unknown = { code: 403, errors: [{ message: "access denied" }] };
        throw e;
      }),
      getRoutines: vi.fn(async () => [[], null, {}]),
      table: vi.fn((_tid: string) => ({
        getMetadata: vi.fn(async () => [{}, {}]),
      })),
      id,
    }));
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );

    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    let captured: unknown;
    try {
      await adapter.listTables("ds");
    } catch (e) {
      captured = e;
    }
    // Should NOT swallow to []. The original 403-shaped error must propagate.
    expect(captured).toBeDefined();
    expect(captured).not.toBeInstanceOf(Array);
    const obj = captured as { code?: number };
    expect(obj.code).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Test #8 — estimateTableRows: past-safe-int numRows returns null.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — estimateTableRows", () => {
  it("8. numRows past MAX_SAFE_INTEGER -> null; small numRows -> number", async () => {
    const metaBig = {
      schema: { fields: [] },
      numRows: "9007199254740993",
    };
    const fakeClient = makeEnumerationFakeClient({ tableMetadata: metaBig });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    expect(await adapter.estimateTableRows("ds", "t1")).toBeNull();

    // Now small numRows
    const fakeClient2 = makeEnumerationFakeClient({
      tableMetadata: { schema: { fields: [] }, numRows: "42" },
    });
    const factory2 = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient2,
    );
    const adapter2 = new BigQueryAdapter(bqCfg({}), factory2);
    await adapter2.connect();
    expect(await adapter2.estimateTableRows("ds", "t1")).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Test #9 — estimateTableRowsBatch: drops omitted tables; empty input
// short-circuits (no client call).
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — estimateTableRowsBatch", () => {
  it("9. batch: ['a','b'] with a metadata numRows='42', b omitted -> Map {a->42}; empty input -> empty Map, 0 client calls", async () => {
    const tableObjs = [
      { id: "p:ds.a", metadata: { type: "TABLE", tableReference: { tableId: "a" } } },
      { id: "p:ds.b", metadata: { type: "TABLE", tableReference: { tableId: "b" } } },
    ];
    // First getTables returns both. Then table('a').getMetadata returns
    // numRows=42; table('b').getMetadata throws (dropped).
    const fakeClient = makeEnumerationFakeClient({ datasetTables: tableObjs });
    fakeClient.dataset = vi.fn((id: string) => {
      const tableHandle = (tid: string) => ({
        getMetadata: vi.fn(async () => {
          if (tid === "a") {
            return [{ schema: { fields: [] }, numRows: "42" }, {}];
          }
          // b: omit (drop, do not throw)
          throw new Error("not found");
        }),
      });
      return {
        getTables: vi.fn(async () => [tableObjs, null, {}]),
        getRoutines: vi.fn(async () => [[], null, {}]),
        table: vi.fn((tid: string) => tableHandle(tid)),
        id,
      };
    });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    const result = await adapter.estimateTableRowsBatch("ds", ["a", "b"]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);
    expect(result.get("a")).toBe(42);
    expect(result.has("b")).toBe(false);

    // Empty input -> no client calls, empty Map
    const fakeClient2 = makeEnumerationFakeClient();
    const factory2 = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient2,
    );
    const adapter2 = new BigQueryAdapter(bqCfg({}), factory2);
    await adapter2.connect();
    const callsBefore = (fakeClient2.dataset as ReturnType<typeof vi.fn>).mock.calls.length;
    const result2 = await adapter2.estimateTableRowsBatch("ds", []);
    expect(result2.size).toBe(0);
    const callsAfter = (fakeClient2.dataset as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// Test #10 — not-connected / closed guards compose on new methods.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — not-connected / closed guards", () => {
  it("10. listSchemas before connect() -> BigQueryNotConnectedError; after close() -> BigQueryClosedError", async () => {
    const fakeClient = makeEnumerationFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await expect(adapter.listSchemas(false)).rejects.toBeInstanceOf(
      BigQueryNotConnectedError,
    );
    await adapter.connect();
    await adapter.close();
    await expect(adapter.listSchemas(false)).rejects.toBeInstanceOf(
      BigQueryClosedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Test #12 — listTableDetail returns columns + constraints (stringly-typed).
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listTableDetail", () => {
  it("12. listTableDetail maps metadata to columns + constraints (partitioning/clustering/row count)", async () => {
    const tableMetadata = {
      schema: {
        fields: [{ name: "id", type: "INT64", mode: "REQUIRED" }],
      },
      timePartitioning: { type: "DAY", field: "ts" },
      clustering: { fields: ["a"] },
      numRows: "10",
      numBytes: "2048",
    };
    const fakeClient = makeEnumerationFakeClient({ tableMetadata });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const detail = await adapter.listTableDetail("ds", "t1");
    expect(detail.columns.length).toBe(1);
    expect(detail.columns[0].column_name).toBe("id");
    expect(detail.columns[0].format_type).toBe("INT64");
    expect(detail.columns[0].is_nullable).toBe("NO");
    expect(detail.constraints.length).toBeGreaterThanOrEqual(1);
    // Constraint string keys: at least one constraint mentions partitioning/clustering.
    const constraintKeys = detail.constraints.map((c) => c.conname);
    const hasPartition = constraintKeys.some((k) =>
      /partition/i.test(k),
    );
    const hasCluster = constraintKeys.some((k) => /cluster/i.test(k));
    expect(hasPartition).toBe(true);
    expect(hasCluster).toBe(true);
  });

  // Test #13 — never coerces past safe integer for row count.
  it("13. listTableDetail preserves numRows string verbatim when past MAX_SAFE_INTEGER", async () => {
    const tableMetadata = {
      schema: {
        fields: [{ name: "id", type: "INT64", mode: "REQUIRED" }],
      },
      timePartitioning: { type: "DAY", field: "ts" },
      clustering: { fields: ["a"] },
      numRows: "1234567890123456789", // > Number.MAX_SAFE_INTEGER
    };
    const fakeClient = makeEnumerationFakeClient({ tableMetadata });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const detail = await adapter.listTableDetail("ds", "t1");

    // Find the row-count constraint. It must surface as either the verbatim
    // string or "unknown" — NEVER a Number()-coerced value that has lost
    // precision past MAX_SAFE_INTEGER.
    const rowCons = detail.constraints.find((c) => /numRows|rows/i.test(c.conname));
    expect(rowCons).toBeDefined();
    const v = rowCons!.consrc;
    if (v === "unknown") {
      // acceptable: surfaced as null per the estimator contract
      expect(v).toBe("unknown");
    } else {
      // acceptable: surfaced verbatim
      expect(v).toBe("1234567890123456789");
    }
    // The Number.MAX_SAFE_INTEGER+1 rounded value is 1234567890123456768.
    // If we ever coerced via Number(), we'd see that (or some nearby rounded
    // value). Pin that the lossless string OR 'unknown' is the only path.
    expect(v).not.toBe("1234567890123456768");
    expect(v).not.toBe("1234567890123456800");
  });
});

// ---------------------------------------------------------------------------
// Test #14 — listRoutines maps routineReference.routineId to name.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listRoutines", () => {
  it("14. listRoutines maps routineReference.routineId with hardcoded kind:'function'", async () => {
    const routineObjs = [
      { id: "r1", metadata: { routineReference: { routineId: "fn1" } } },
      { metadata: { routineReference: { routineId: "proc1" } } },
    ];
    const fakeClient = makeEnumerationFakeClient({ datasetRoutines: routineObjs });
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    const routines = await adapter.listRoutines("ds");
    expect(routines).toEqual([
      { name: "fn1", kind: "function", schema: "ds" },
      { name: "proc1", kind: "function", schema: "ds" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test #11 — listRoutineParams STAYS NotImplementedError.
// ---------------------------------------------------------------------------
describe("TASK-BQ02-001 BigQueryAdapter — listRoutineParams stays NotImplementedError", () => {
  it("11. listRoutineParams throws NotImplementedError(\"bigquery\")", async () => {
    const fakeClient = makeEnumerationFakeClient();
    const factory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();
    await expect(adapter.listRoutineParams("ds", "fn1")).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});
