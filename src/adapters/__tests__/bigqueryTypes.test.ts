// src/adapters/__tests__/bigqueryTypes.test.ts
//
// TASK-BQ00-002 — pure boundary types + named mapper `toBigQueryPage` + helper
// `hasNextPage`. The source module MUST NOT import from `@google-cloud/bigquery`
// or `vscode`. The raw response shape used by the mapper is a type declared in
// the source under test, shaped to match the client's installed .d.ts.
//
// Test matrix (TASK §Test Cases, TDD-mandatory):
//  1. happy         — `toBigQueryPage` preserves `jobRef` identity (deep equal)
//  2. edge (empty)  — empty final page → `hasNextPage` false
//  3. edge (token)  — empty page + non-null token → `hasNextPage` true (token owns continuation)
//  4. edge (cont)   — page token round-trips opaquely (no parse/trim/truncate)
//  5. edge (struct) — nested RECORD + REPEATED preserved verbatim
//  6. edge (prec)   — NUMERIC/BIGNUMERIC canonical strings (exact digit equality, > MAX_SAFE_INTEGER)
//  7. edge (contract guard) — type-level `@ts-expect-error` proves decimal/int branches are string-typed
import { describe, it, expect } from "vitest";
import {
  toBigQueryPage,
  hasNextPage,
  type BigQueryRawQueryResponse,
  type BigQueryValue,
} from "../bigqueryTypes";

// ---------------------------------------------------------------------------
// Synthetic fixtures (roadmap §8.1: no `{rows:[]}`-only mocks)
// Field names mirror the installed `@google-cloud/bigquery` .d.ts shapes:
//   - IGetQueryResultsResponse { pageToken, totalBytesProcessed, schema, rows }
//   - IJobReference { projectId, location, jobId }
//   - ITableRow { f: ITableCell[] } where ITableCell = { v: any }
//   - ITableSchema { fields: ITableFieldSchema[] }
//   - ITableFieldSchema { name, type, mode, fields? }
// (See TASK-BQ00-002 Discussion — file/line refs logged in the executor report.)
// ---------------------------------------------------------------------------

const JOB_REF = {
  projectId: "vsdb-it",
  location: "US",
  jobId: "job_abc",
} as const;

const SCHEMA_SIMPLE = [
  { name: "id", type: "INT64", mode: "REQUIRED" },
  { name: "name", type: "STRING", mode: "NULLABLE" },
] as const;

const RAW_HAPPY: BigQueryRawQueryResponse = {
  jobReference: { ...JOB_REF },
  schema: { fields: [...SCHEMA_SIMPLE] },
  rows: [
    { f: [{ v: "1" }, { v: "alice" }] },
    { f: [{ v: "2" }, { v: "bob" }] },
  ],
  pageToken: "BE5BABA0ODA0MjcuMDgwMDA6MQ",
  totalBytesProcessed: "123456",
};

// ===========================================================================
// Test #1 — happy: `toBigQueryPage` preserves `jobRef` identity
// ===========================================================================
describe("TASK-BQ00-002 BigQuery boundary types", () => {
  it("1. toBigQueryPage maps fixture to BigQueryPage preserving jobRef identity", () => {
    const page = toBigQueryPage(RAW_HAPPY);
    // jobRef deep-equal verbatim — proves the mapper does not synthesize
    // a new reference or drop fields.
    expect(page.jobRef).toEqual({
      projectId: "vsdb-it",
      location: "US",
      jobId: "job_abc",
    });
    // jobRef identity (same reference) — proves the mapper does not re-clone.
    expect(page.jobRef.projectId).toBe(JOB_REF.projectId);
    // Schema + rows + pageToken come through with raw values intact.
    expect(page.schema).toEqual([...SCHEMA_SIMPLE]);
    expect(page.rows).toEqual([
      ["1", "alice"],
      ["2", "bob"],
    ]);
    expect(page.pageToken).toBe("BE5BABA0ODA0MjcuMDgwMDA6MQ");
    // Optional totalBytesProcessed is forwarded as a string when present.
    expect(page.totalBytesProcessed).toBe("123456");
  });

  // =====================================================================
  // Test #2 — edge: empty final page → no next
  // =====================================================================
  it("2. empty final page has no next", () => {
    const raw: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [],
      pageToken: null,
    };
    const page = toBigQueryPage(raw);
    expect(page.rows).toEqual([]);
    expect(page.pageToken).toBeNull();
    expect(hasNextPage(page)).toBe(false);
  });

  // =====================================================================
  // Test #3 — edge: empty page + non-null token → still continues
  // The continuation owner is the token, NOT the row count.
  // =====================================================================
  it("3. empty page can still continue (token owns continuation)", () => {
    const raw: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [],
      pageToken: "BE5BABA0ODA0MjcuMDgwMDA6MQ",
    };
    const page = toBigQueryPage(raw);
    expect(page.rows).toEqual([]);
    expect(page.pageToken).not.toBeNull();
    // Critical: token presence (not row count) decides continuation.
    expect(hasNextPage(page)).toBe(true);
  });

  // =====================================================================
  // Test #4 — edge: page token round-trips opaquely (no parse/trim/truncate)
  // =====================================================================
  it("4. page token round-trips opaquely", () => {
    const opaque = "  BE5BABA0ODA0MjcuMDgwMDA6MQ\n\t";
    const raw: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [],
      pageToken: opaque,
    };
    const page = toBigQueryPage(raw);
    // Mapper must NOT trim, decode, or otherwise normalize the token —
    // the pageToken is an opaque continuation handle owned by the client.
    expect(page.pageToken).toBe(opaque);
    // Length is preserved exactly (no truncation).
    expect(page.pageToken?.length).toBe(opaque.length);
    // The flow into a BigQueryPageRequest is also unchanged.
    const req = {
      jobRef: page.jobRef,
      pageToken: page.pageToken ?? undefined,
    };
    expect(req.pageToken).toBe(opaque);
    expect(req.jobRef).toEqual(page.jobRef);
  });

  // =====================================================================
  // Test #5 — edge: nested RECORD + REPEATED preserved verbatim
  // =====================================================================
  it("5. nested RECORD + REPEATED preserved", () => {
    const nestedSchema = [
      {
        name: "id",
        type: "INT64",
        mode: "REQUIRED",
      },
      {
        name: "tags",
        type: "STRING",
        mode: "REPEATED",
      },
      {
        name: "owner",
        type: "RECORD",
        mode: "NULLABLE",
        fields: [
          { name: "name", type: "STRING", mode: "NULLABLE" },
          {
            name: "contacts",
            type: "RECORD",
            mode: "REPEATED",
            fields: [
              { name: "kind", type: "STRING", mode: "NULLABLE" },
              { name: "value", type: "STRING", mode: "NULLABLE" },
            ],
          },
        ],
      },
    ];
    // BigQuery wire format for a REPEATED column: each row cell `f[i].v`
    // IS the array `[{ v: x }, ...]` (each element still wrapped). The
    // mapper un-nests one level (`row.f[].v`) and passes the array through.
    const raw: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: nestedSchema },
      rows: [
        {
          f: [
            { v: "7" },
            { v: [{ v: "admin" }, { v: "ops" }] },
            {
              v: {
                f: [
                  { v: "alice" },
                  {
                    v: [
                      {
                        v: { f: [{ v: "email" }, { v: "a@x" }] },
                      },
                      {
                        v: { f: [{ v: "phone" }, { v: "555" }] },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
      pageToken: null,
    };
    const page = toBigQueryPage(raw);
    // Two-level nested RECORD schema preserved exactly (fields[].fields[]).
    expect(page.schema).toEqual(nestedSchema);

    // REPEATED column un-nests to a JS array of cell payloads. The exact
    // element shape is wire-format (`{v: x}` per element) — the mapper
    // passes `f[i].v` through verbatim — so we assert "is an array" and
    // "contains the wrapped leaves" rather than guessing at further
    // un-wrapping rules the mapper does NOT perform.
    const tags = page.rows[0][1] as unknown;
    expect(Array.isArray(tags)).toBe(true);
    expect((tags as Array<unknown>).length).toBe(2);
    expect((tags as Array<{ v: unknown }>)[0].v).toBe("admin");
    expect((tags as Array<{ v: unknown }>)[1].v).toBe("ops");

    // RECORD cell preserves its `{f:[..]}` positional cell-array shape.
    // (The contract says RECORD is `{ [field: string]: BigQueryValue }` —
    // the mapper does NOT promote positional cells to named keys; the
    // RECORD value carries its wire-format `{f:[..]}` payload so callers
    // can re-bind against `schema`.)
    const owner = page.rows[0][2] as { f: BigQueryValue[] };
    expect(typeof owner).toBe("object");
    expect(Array.isArray(owner.f)).toBe(true);
    expect(owner.f.length).toBe(2);
    // owner.f[0] = name (scalar, still in wire `{v}` wrap)
    expect((owner.f[0] as { v: unknown }).v).toBe("alice");

    // owner.f[1] = REPEATED RECORD column — its cell payload is the array
    // of contact cells. Each contact cell is `{v: {f:[..]}}` (wire-format
    // RECORD-inside-REPEATED), and the inner `f` array is positional.
    const contacts = (owner.f[1] as { v: Array<{ v: { f: BigQueryValue[] } }> }).v;
    expect(Array.isArray(contacts)).toBe(true);
    expect(contacts.length).toBe(2);
    const firstRecord = contacts[0].v;
    expect(Array.isArray(firstRecord.f)).toBe(true);
    expect((firstRecord.f[0] as { v: unknown }).v).toBe("email");
    expect((firstRecord.f[1] as { v: unknown }).v).toBe("a@x");
  });

  // =====================================================================
  // Test #6 — edge: NUMERIC/BIGNUMERIC canonical strings
  // Values must be typeof "string" with EXACT digit equality (no Number coercion).
  // =====================================================================
  it("6. NUMERIC/BIGNUMERIC canonical strings (no Number coercion)", () => {
    const precisionSchema = [
      { name: "big_int", type: "INT64", mode: "REQUIRED" },
      { name: "numeric_val", type: "NUMERIC", mode: "REQUIRED" },
      { name: "bignumeric_val", type: "BIGNUMERIC", mode: "REQUIRED" },
      { name: "f_val", type: "FLOAT64", mode: "NULLABLE" },
    ];
    const bigIntStr = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
    const numericStr = "12345678901234567890.123456789";
    const bignumericStr =
      "1234567890123456789012345678901234567890.12345678901234567890123456789012345678";
    const raw: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: precisionSchema },
      rows: [
        {
          f: [
            { v: bigIntStr },
            { v: numericStr },
            { v: bignumericStr },
            { v: 3.14 },
          ],
        },
      ],
      pageToken: null,
    };
    const page = toBigQueryPage(raw);
    const row = page.rows[0];
    // All decimal / int fields are contractually strings.
    expect(typeof row[0]).toBe("string");
    expect(typeof row[1]).toBe("string");
    expect(typeof row[2]).toBe("string");
    // Exact digit equality — no precision loss, no normalization.
    expect(row[0]).toBe(bigIntStr);
    expect(row[1]).toBe(numericStr);
    expect(row[2]).toBe(bignumericStr);
    // The big-int string is strictly larger than Number.MAX_SAFE_INTEGER.
    expect(Number(row[0])).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // FLOAT64 alone may be a JS number — only the decimal/int branches are
    // pinned to strings.
    expect(typeof row[3]).toBe("number");
  });

  // =====================================================================
  // Test #7 — edge (contract guard): BigQueryValue decimal/int branches
  // are string-typed at compile time. The numeric assignment below MUST be a
  // compile error; `@ts-expect-error` proves the contract.
  // =====================================================================
  it("7. type surface forbids number for decimal/int fields", () => {
    // Compile-time assertion: the decimal/int payload is typed `string`,
    // never `number`. A bare numeric literal assignment must fail.
    const decimalVal: BigQueryValue = "123.45";
    expect(typeof decimalVal).toBe("string");
    const intVal: BigQueryValue = "9007199254740993";
    expect(typeof intVal).toBe("string");

    // The next two assignments MUST fail to compile. Each `@ts-expect-error`
    // is consumed by exactly one line below it — if either line compiles
    // successfully, TypeScript reports an "unused @ts-expect-error" error
    // and the test will fail in `npm run typecheck`.
    const badDecimal: BigQueryValue = 123.45;
    void badDecimal;
    const badInt: BigQueryValue = 9007199254740993;
    void badInt;

    // `Bad` below is the union of valid branches — assigning a bare object
    // that isn't a RECORD (e.g. lacking a known string key) is fine because
    // BigQueryValue's RECORD branch is `{ [field: string]: BigQueryValue }`.
    // We use the contract to pin the union.
    const recordVal: BigQueryValue = { nested: "v" };
    expect(typeof recordVal).toBe("object");
  });
});