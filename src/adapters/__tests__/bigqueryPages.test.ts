// src/adapters/__tests__/bigqueryPages.test.ts
//
// TASK-BQ03-002 — BigQuery result page bridge (pure helpers).
//
// Pinned invariants (per task §Test Cases):
//   1. empty result → no rows, pageToken null, limited false; second call pure
//   2. first page → rows + pageToken + limited false
//   3. page token preserved verbatim ("  CkA+complex/token==")
//   4. final page → null token, hasNext false (token-driven, NOT row-driven)
//   5. 20 MB-aware budget → marks limited at the boundary, no accumulation
//   6. nested RECORD cell preserved without flattening errors
//   7. REPEATED cell preserved with order
//   8. JSON + BYTES + temporal cells render as raw text
//   9. INT64 / NUMERIC / BIGNUMERIC stay canonical strings (NO Number() coercion)
//  10. null cell + missing field arg handled without throw
//  11. fetcher composes frozen `toBigQueryPage` (parity)
//
// Module MUST NOT import from `@google-cloud/bigquery` or `vscode`.
import { describe, it, expect } from "vitest";
import {
  createBigQueryPageFetcher,
  formatBigQueryCell,
  type BigQueryPageFetch,
} from "../bigqueryPages";
import {
  toBigQueryPage,
  hasNextPage,
  type BigQueryRawQueryResponse,
  type BigQueryInt64String,
  type BigQueryNumericString,
  type BigQueryBigNumericString,
} from "../bigqueryTypes";

// ---------------------------------------------------------------------------
// Synthetic fixtures. Field names mirror the installed `.d.ts` shapes
// (see bigqueryTypes.test.ts header for line refs).
// ---------------------------------------------------------------------------

const JOB_REF = {
  projectId: "UnicDB-it",
  location: "US",
  jobId: "job_abc",
} as const;

const SCHEMA_SIMPLE = [
  { name: "id", type: "INT64", mode: "REQUIRED" },
  { name: "name", type: "STRING", mode: "NULLABLE" },
] as const;

// Helper: build a `fetch` spy that returns a single canned response regardless
// of opts (most tests don't care about pagination params).
function singleFetch(raw: BigQueryRawQueryResponse) {
  return async (_opts: { maxResults?: number; pageToken?: string }) => raw;
}

describe("TASK-BQ03-002 BigQuery page bridge", () => {
  // =========================================================================
  // 1. empty result
  // =========================================================================
  it("1. empty result: no rows, pageToken null, limited false; pure (idempotent)", async () => {
    const RAW_EMPTY: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [],
      pageToken: null,
    };
    const fetcher = createBigQueryPageFetcher({ fetch: singleFetch(RAW_EMPTY) });
    const first = await fetcher.first();
    expect(first.page.jobRef).toEqual(JOB_REF);
    expect(first.rows).toEqual([]);
    expect(first.page.pageToken).toBeNull();
    expect(first.limited).toBe(false);
    // No state leaked — a second first() call on the same fetcher yields
    // identical output (the function is pure across invocations).
    const again = await fetcher.first();
    expect(again).toEqual(first);
    expect(hasNextPage(first.page)).toBe(false);
  });

  // =========================================================================
  // 2. first page
  // =========================================================================
  it("2. first page: 2 rows, pageToken 'tok-1', limited false; schema columns preserved", async () => {
    const RAW: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [
        { f: [{ v: "1" }, { v: "alice" }] },
        { f: [{ v: "2" }, { v: "bob" }] },
      ],
      pageToken: "tok-1",
    };
    const fetcher = createBigQueryPageFetcher({ fetch: singleFetch(RAW) });
    const result = await fetcher.first();
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual(["1", "alice"]);
    expect(result.rows[1]).toEqual(["2", "bob"]);
    expect(result.page.pageToken).toBe("tok-1");
    expect(result.limited).toBe(false);
    expect(result.page.schema.map((s) => s.name)).toEqual(["id", "name"]);
    expect(hasNextPage(result.page)).toBe(true);
  });

  // =========================================================================
  // 3. page token preserved verbatim
  // =========================================================================
  it("3. page token preserved verbatim: spaces, slashes, '=' round-trip exactly", async () => {
    const VERBATIM = "  CkA+complex/token==";
    const RAW: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [{ f: [{ v: "1" }, { v: "x" }] }],
      pageToken: VERBATIM,
    };
    const fetcher = createBigQueryPageFetcher({ fetch: singleFetch(RAW) });
    const first = await fetcher.first();
    expect(first.page.pageToken).toBe(VERBATIM);
    // No normalization — byte-equal, no trim, no decode.
    expect(first.page.pageToken).toHaveLength(VERBATIM.length);
    expect(first.page.pageToken).toContain("/");
    expect(first.page.pageToken).toContain("==");
    expect(first.page.pageToken?.startsWith(" ")).toBe(true);
  });

  // =========================================================================
  // 4. final page: null token decides continuation, NEVER row count
  // =========================================================================
  it("4. final page: pageToken null → hasNext false even with rows present (token-driven)", async () => {
    const RAW: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [
        { f: [{ v: "1" }, { v: "alice" }] },
        { f: [{ v: "2" }, { v: "bob" }] },
      ],
      pageToken: null, // final page despite rows present
    };
    const fetcher = createBigQueryPageFetcher({ fetch: singleFetch(RAW) });
    const first = await fetcher.first();
    expect(first.page.pageToken).toBeNull();
    expect(hasNextPage(first.page)).toBe(false);
    // next() returns null once the last seen token is null.
    const next = await fetcher.next();
    expect(next).toBeNull();
    expect(fetcher.exhausted).toBe(true);
  });

  // =========================================================================
  // 5. 20 MB-aware bounded page
  // =========================================================================
  it("5. byte budget: totalBytesProcessed > budget → limited true; inside budget → false", async () => {
    const RAW_OVER: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [{ f: [{ v: "1" }, { v: "x" }] }],
      pageToken: null,
      totalBytesProcessed: "25000000", // 25 MB
    };
    const fetcherOver = createBigQueryPageFetcher({
      fetch: singleFetch(RAW_OVER),
      byteBudget: 20 * 1024 * 1024, // 20 MB
    });
    const over = await fetcherOver.first();
    expect(over.limited).toBe(true);
    expect(over.rows).toHaveLength(1); // NOT accumulated, NOT mutated

    const RAW_UNDER: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [{ f: [{ v: "1" }, { v: "x" }] }],
      pageToken: null,
      totalBytesProcessed: "10485760", // 10 MB
    };
    const fetcherUnder = createBigQueryPageFetcher({
      fetch: singleFetch(RAW_UNDER),
      byteBudget: 20 * 1024 * 1024,
    });
    const under = await fetcherUnder.first();
    expect(under.limited).toBe(false);
    expect(under.rows).toHaveLength(1);
  });

  // =========================================================================
  // 6. nested RECORD cell preserved
  // =========================================================================
  it("6. nested RECORD cell: formatBigQueryCell renders structure, INT64 child stays '8'", () => {
    const recordCell = { f: [{ v: "a" }, { v: "8" as BigQueryInt64String }] };
    const out = formatBigQueryCell(recordCell);
    // Both fields present in the rendered output.
    expect(out).toContain("a");
    expect(out).toContain("8");
    // INT64 child is a string — formatter did NOT Number()-coerce it.
    expect(typeof out).toBe("string");
    // No crash on RECORD; non-empty output.
    expect(out.length).toBeGreaterThan(0);
  });

  // =========================================================================
  // 7. REPEATED cell preserved
  // =========================================================================
  it("7. REPEATED cell: formatBigQueryCell shows elements in order, no Number() coercion", () => {
    const repeated = [{ v: "x" }, { v: "y" }];
    const out = formatBigQueryCell(repeated);
    // Both elements present in order (x before y).
    const idxX = out.indexOf("x");
    const idxY = out.indexOf("y");
    expect(idxX).toBeGreaterThanOrEqual(0);
    expect(idxY).toBeGreaterThan(idxX);
  });

  // =========================================================================
  // 8. JSON + BYTES + temporal cells render as raw text
  // =========================================================================
  it("8. JSON + BYTES + temporal cells render verbatim", () => {
    const jsonText = '{"k":1}';
    const out1 = formatBigQueryCell(jsonText);
    expect(out1).toBe(jsonText); // raw text, NOT JSON.parse'd

    const bytesB64 = "aGVsbG8=";
    const out2 = formatBigQueryCell(bytesB64);
    expect(out2).toBe(bytesB64); // base64 stays base64, no decode

    const out3 = formatBigQueryCell("2026-09-03"); // DATE
    expect(out3).toBe("2026-09-03");
    const out4 = formatBigQueryCell("12:00:00"); // TIME
    expect(out4).toBe("12:00:00");
    const out5 = formatBigQueryCell("2026-09-03T12:00:00Z"); // TIMESTAMP
    expect(out5).toBe("2026-09-03T12:00:00Z");
  });

  // =========================================================================
  // 9. INT64 / NUMERIC / BIGNUMERIC stay canonical strings (NO Number() coercion)
  // =========================================================================
  it("9. large decimals stay strings (no Number coercion, no scientific notation)", () => {
    const int64 = "9007199254740993" as BigQueryInt64String; // > MAX_SAFE_INTEGER
    const numeric = "123.45" as BigQueryNumericString;
    const bignumeric = "9007199254740993.0000000001" as BigQueryBigNumericString;

    const outInt = formatBigQueryCell(int64);
    expect(outInt).toBe("9007199254740993");
    expect(typeof outInt).toBe("string");
    expect(outInt).not.toMatch(/e/i); // no scientific notation

    const outNum = formatBigQueryCell(numeric);
    expect(outNum).toBe("123.45");
    expect(typeof outNum).toBe("string");

    const outBig = formatBigQueryCell(bignumeric);
    expect(outBig).toBe("9007199254740993.0000000001");
    expect(typeof outBig).toBe("string");
  });

  // =========================================================================
  // 10. null cell + missing field arg
  // =========================================================================
  it("10. null cell + missing field arg handled without throw", () => {
    const outNull = formatBigQueryCell(null);
    expect(typeof outNull).toBe("string");
    expect(outNull).toBe(""); // agreed empty marker for null

    // field arg omitted — should still work.
    const outNoField = formatBigQueryCell("hello");
    expect(outNoField).toBe("hello");

    // field arg provided but unused for plain STRING — also works.
    const outWithField = formatBigQueryCell("hello", {
      name: "x",
      type: "STRING",
      mode: "NULLABLE",
    });
    expect(outWithField).toBe("hello");
  });

  // =========================================================================
  // 11. frozen mapper parity — fetcher composes toBigQueryPage
  // =========================================================================
  it("11. fetcher rows equal toBigQueryPage(raw).rows — frozen mapper composes", async () => {
    const RAW: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [
        { f: [{ v: "1" }, { v: "alice" }] },
        { f: [{ v: "2" }, { v: "bob" }] },
      ],
      pageToken: "tok-1",
      totalBytesProcessed: "1024",
    };
    const direct = toBigQueryPage(RAW);
    const fetcher = createBigQueryPageFetcher({ fetch: singleFetch(RAW) });
    const result = await fetcher.first();
    // rows parity
    expect(result.rows).toEqual(direct.rows);
    // pageToken parity
    expect(result.page.pageToken).toBe(direct.pageToken);
    // jobRef parity
    expect(result.page.jobRef).toEqual(direct.jobRef);
    // totalBytes parity
    expect(result.page.totalBytesProcessed).toBe(direct.totalBytesProcessed);
  });

  // =========================================================================
  // Continuation: next() returns the next page until token null, then null.
  // =========================================================================
  it("12. next() walks pages; returns null once token is null; exhausted flag flips", async () => {
    const PAGE_A: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [{ f: [{ v: "1" }, { v: "alice" }] }],
      pageToken: "tok-a",
    };
    const PAGE_B: BigQueryRawQueryResponse = {
      jobReference: { ...JOB_REF },
      schema: { fields: [...SCHEMA_SIMPLE] },
      rows: [{ f: [{ v: "2" }, { v: "bob" }] }],
      pageToken: null, // final
    };
    // Programmable fetch: hand out pages in order, ignore opts.
    const pages = [PAGE_A, PAGE_B];
    let i = 0;
    const fetchSpy = async () => {
      const page = pages[i++];
      if (!page) throw new Error("unexpected extra fetch");
      return page;
    };
    const fetcher = createBigQueryPageFetcher({ fetch: fetchSpy });
    expect(fetcher.exhausted).toBe(false);
    const first = await fetcher.first();
    expect(first.page.pageToken).toBe("tok-a");
    expect(fetcher.exhausted).toBe(false);

    const second = await fetcher.next();
    expect(second).not.toBeNull();
    expect(second!.page.pageToken).toBeNull();
    expect(fetcher.exhausted).toBe(true);

    const third = await fetcher.next();
    expect(third).toBeNull();
  });
});