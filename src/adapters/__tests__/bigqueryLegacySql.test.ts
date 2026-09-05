// src/adapters/__tests__/bigqueryLegacySql.test.ts
// TASK-BQF-002 — useLegacySql UI toggle plumbing.
//
// Strategy: drive the pure gate `assertSingleReadOnlyGoogleSql` (with the
// `useLegacySql` opt) and drive `BigQueryAdapter.runQuery({ sql, useLegacySql })`
// to verify the flag threads through to `createQueryJob` and that legacy SQL
// is rejected at the gate (the MVP scope explicitly disallows legacy SQL —
// there is no `useLegacySql: true` happy path).
//
// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "../../config/types";
import type { BigQueryConnectionFields } from "../../config/types";
import type { BigQueryRawQueryResponse } from "../bigqueryTypes";
import {
  BigQueryAdapter,
  assertSingleReadOnlyGoogleSql,
  type BigQueryClient,
  type BigQueryClientFactory,
} from "../bigquery";

// ---------------------------------------------------------------------------
// Fixtures
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

const SCHEMA_TWO_COLS: BigQueryRawQueryResponse = {
  jobReference: { projectId: "proj-billing", location: "US", jobId: "job_abc" },
  schema: {
    fields: [
      { name: "id", type: "INT64", mode: "REQUIRED" },
      { name: "name", type: "STRING", mode: "NULLABLE" },
    ],
  },
  rows: [{ f: [{ v: "1" }, { v: "alice" }] }],
  pageToken: null,
};

function makeClient(): BigQueryClient & {
  createQueryJob: ReturnType<typeof vi.fn>;
  getQueryResults: ReturnType<typeof vi.fn>;
} {
  const job = {
    id: "job_abc",
    metadata: {
      jobReference: { projectId: "proj-billing", location: "US", jobId: "job_abc" },
    },
    getQueryResults: vi.fn(async () => [SCHEMA_TWO_COLS, null, SCHEMA_TWO_COLS]),
    cancel: vi.fn(async () => undefined),
  };
  return {
    listDatasets: vi.fn(async () => [{ id: "ds1" }]),
    query: vi.fn(),
    getQueryResults: vi.fn(),
    createQueryJob: vi.fn(async () => [job, job.metadata]),
    cancel: vi.fn(async () => undefined),
    getDataset: vi.fn(async () => ({ id: "ds1" })),
    getTable: vi.fn(async () => ({ id: "t1" })),
    getDatasets: vi.fn(async () => [[], null, {}]),
    dataset: vi.fn((id: string) => ({
      id,
      getTables: vi.fn(async () => [[], null, {}]),
      getRoutines: vi.fn(async () => [[], null, {}]),
      table: vi.fn((_tid: string) => ({
        getMetadata: vi.fn(async () => [{}, {}]),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Pure gate: useLegacySql opt
// ---------------------------------------------------------------------------

describe("TASK-BQF-002 assertSingleReadOnlyGoogleSql — useLegacySql opt", () => {
  it("default (no opts) treats legacySql as false → SELECT admitted", () => {
    const r = assertSingleReadOnlyGoogleSql("SELECT 1");
    expect(r.ok).toBe(true);
  });

  it("explicit useLegacySql: false → SELECT admitted", () => {
    const r = assertSingleReadOnlyGoogleSql("SELECT 1", { useLegacySql: false });
    expect(r.ok).toBe(true);
  });

  it("useLegacySql: true → gate rejects with legacy-SQL reason", () => {
    const r = assertSingleReadOnlyGoogleSql("SELECT 1", { useLegacySql: true });
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.reason).toMatch(/legacy SQL/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Adapter: useLegacySql threads through to createQueryJob (default false)
// ---------------------------------------------------------------------------

describe("TASK-BQF-002 BigQueryAdapter.runQuery — useLegacySql threading", () => {
  it("default (no opts) → createQueryJob called with { useLegacySql: false }", async () => {
    const fakeClient = makeClient();
    const factory: BigQueryClientFactory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    await adapter.runQuery("SELECT 1");

    expect(fakeClient.createQueryJob).toHaveBeenCalledTimes(1);
    const opts = fakeClient.createQueryJob.mock.calls[0][0] as {
      query?: string;
      useLegacySql?: boolean;
      location?: string;
    };
    expect(opts.query).toBe("SELECT 1");
    expect(opts.useLegacySql).toBe(false);
    expect(opts.location).toBe("US");
  });

  it("opts.useLegacySql: true → gate rejects; createQueryJob NOT called", async () => {
    const fakeClient = makeClient();
    const factory: BigQueryClientFactory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    let captured: unknown;
    try {
      await adapter.runQuery("SELECT 1", { useLegacySql: true });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/legacy SQL/i);
    expect(fakeClient.createQueryJob).not.toHaveBeenCalled();
  });

  it("opts.useLegacySql: false → submitted; createQueryJob called with useLegacySql: false", async () => {
    const fakeClient = makeClient();
    const factory: BigQueryClientFactory = vi.fn(
      (_opts: { projectId: string; location?: string }): BigQueryClient => fakeClient,
    );
    const adapter = new BigQueryAdapter(bqCfg({}), factory);
    await adapter.connect();

    await adapter.runQuery("SELECT id, name FROM t", { useLegacySql: false });

    expect(fakeClient.createQueryJob).toHaveBeenCalledTimes(1);
    const opts = fakeClient.createQueryJob.mock.calls[0][0] as {
      useLegacySql?: boolean;
    };
    expect(opts.useLegacySql).toBe(false);
  });
});
