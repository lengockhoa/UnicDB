// src/ui/__tests__/bigQueryPreview.test.ts
// TASK-BQ02-002 — Pure-module unit tests for buildBigQueryPreviewSql.
//
// Verifies the contract:
//  - Backtick-quote dataset and table (no raw backticks in output except delimiters)
//  - Three-part reference `` `project`.`dataset`.`table` `` ONLY when project is
//    a non-empty string
//  - LIMIT 100 default; clamp to [1, BIGQUERY_PREVIEW_MAX_LIMIT] (1000)
//  - Backtick-doubling escape inside identifiers
//  - No trailing semicolon
import { describe, it, expect } from "vitest";
import {
  buildBigQueryPreviewSql,
  BIGQUERY_PREVIEW_MAX_LIMIT,
} from "../bigQueryPreview";

describe("buildBigQueryPreviewSql", () => {
  it("#1 two-part reference, default limit", () => {
    expect(buildBigQueryPreviewSql({ dataset: "my ds", table: "tbl" })).toBe(
      "SELECT * FROM `my ds`.`tbl` LIMIT 100",
    );
  });

  it("#2 three-part reference with project", () => {
    expect(
      buildBigQueryPreviewSql({ project: "proj-data", dataset: "ds", table: "tbl" }),
    ).toBe("SELECT * FROM `proj-data`.`ds`.`tbl` LIMIT 100");
  });

  it("#3 backtick inside identifier is doubled", () => {
    expect(buildBigQueryPreviewSql({ dataset: "ds", table: "we`ird" })).toBe(
      "SELECT * FROM `ds`.`we``ird` LIMIT 100",
    );
    expect(buildBigQueryPreviewSql({ dataset: "ds`x", table: "tbl" })).toBe(
      "SELECT * FROM `ds``x`.`tbl` LIMIT 100",
    );
    // Sanity: no raw (unescaped) backtick should appear inside an identifier
    // body — only the surrounding delimiters.
    const out = buildBigQueryPreviewSql({ dataset: "d", table: "a`b" });
    // Body of the table identifier between the outer backticks should contain
    // exactly one escaped backtick (i.e. two consecutive backticks).
    expect(out).toContain("`a``b`");
  });

  it("#4 limit clamped to [1, ceiling]", () => {
    expect(
      buildBigQueryPreviewSql({ dataset: "d", table: "t", limit: 0 }).endsWith(
        `LIMIT ${BIGQUERY_PREVIEW_MAX_LIMIT}`,
      ),
    ).toBe(true);
    expect(
      buildBigQueryPreviewSql({ dataset: "d", table: "t", limit: -5 }).endsWith(
        `LIMIT ${BIGQUERY_PREVIEW_MAX_LIMIT}`,
      ),
    ).toBe(true);
    expect(
      buildBigQueryPreviewSql({ dataset: "d", table: "t", limit: 100000 }).endsWith(
        `LIMIT ${BIGQUERY_PREVIEW_MAX_LIMIT}`,
      ),
    ).toBe(true);
    expect(
      buildBigQueryPreviewSql({ dataset: "d", table: "t", limit: 25 }),
    ).toBe("SELECT * FROM `d`.`t` LIMIT 25");
  });

  it("#5 ceiling constant equals 1000 and default limit is 100", () => {
    expect(BIGQUERY_PREVIEW_MAX_LIMIT).toBe(1000);
    expect(
      buildBigQueryPreviewSql({ dataset: "d", table: "t" }),
    ).toBe("SELECT * FROM `d`.`t` LIMIT 100");
  });

  it("#6 omitted/empty project → two-part reference (not three-part)", () => {
    // Empty string project must be treated as omitted.
    expect(
      buildBigQueryPreviewSql({ project: "", dataset: "d", table: "t" }),
    ).toBe("SELECT * FROM `d`.`t` LIMIT 100");
  });

  it("#7 no trailing semicolon", () => {
    expect(
      buildBigQueryPreviewSql({ dataset: "d", table: "t" }).endsWith(";"),
    ).toBe(false);
  });
});