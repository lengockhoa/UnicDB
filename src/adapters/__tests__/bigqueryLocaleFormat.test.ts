// src/adapters/__tests__/bigqueryLocaleFormat.test.ts
// TASK-BQF-003 — locale-aware temporal formatting in formatBigQueryCell.
//
// Strategy: drive `formatBigQueryCell(value, field)` with explicit
// `field.locale` and assert:
//   - DATE / DATETIME / TIMESTAMP / TIME route through `Intl.DateTimeFormat`
//     when `field.type` is temporal AND `field.locale` is set.
//   - The output is NOT equal to the verbatim input (i.e. the formatter ran)
//     and contains the year / time-of-day components the input carried.
//   - Verbatim fallback when `field.locale` is omitted (frozen pre-BQF-003
//     contract).
//   - Invalid temporal strings fall back to the raw text (defensive).
//   - Non-temporal fields are NOT routed through the formatter (INT64 stays
//     canonical, JSON stays verbatim).
//   - `Intl.DateTimeFormat` is monkey-patched via `Intl.DateTimeFormat`
//     constructor spy so the test is deterministic across hosts — the
//     spy records the (locale, options) tuple, and `format()` returns a
//     deterministic `<locale>:<iso>` shape.
//
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatBigQueryCell } from "../bigqueryPages";

// ---- Intl constructor spy: capture (locale, options) and return a
//         deterministic formatter ----------------------------------------

interface SpyCall {
  locale: string;
  options: Intl.DateTimeFormatOptions;
}

const spyCalls: SpyCall[] = [];
const realIntl = Intl.DateTimeFormat;

let restoreIntl: (() => void) | null = null;

function installIntlSpy(): void {
  spyCalls.length = 0;
  // Replace the global Intl.DateTimeFormat with a spy constructor.
  const spy = function IntlDateTimeFormatSpy(
    this: unknown,
    locale?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    const l = Array.isArray(locale) ? (locale[0] ?? "en-US") : (locale ?? "en-US");
    spyCalls.push({ locale: l, options: options ?? {} });
    // Implement the small slice we use: `resolvedOptions` + `format(Date)`.
    const resolved: Intl.ResolvedDateTimeFormatOptions = {
      locale: l,
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: "UTC",
      ...options,
    } as Intl.ResolvedDateTimeFormatOptions;
    const formatter = {
      resolvedOptions: () => resolved,
      format: (value: Date | number): string => {
        const dt = value instanceof Date ? value : new Date(value);
        const iso = dt.toISOString();
        const hasDate =
          resolved.year !== undefined ||
          resolved.month !== undefined ||
          resolved.day !== undefined;
        const hasTime =
          resolved.hour !== undefined ||
          resolved.minute !== undefined ||
          resolved.second !== undefined;
        if (hasDate && hasTime) {
          return `${l}:${iso.slice(0, 19).replace("T", " ")}`;
        }
        if (hasDate) return `${l}:${iso.slice(0, 10)}`;
        if (hasTime) return `${l}:${iso.slice(11, 19)}`;
        return `${l}:${iso}`;
      },
    };
    return formatter;
  } as unknown as typeof Intl.DateTimeFormat;
  // Replace globally for the duration of the test.
  (globalThis as unknown as { Intl: { DateTimeFormat: typeof Intl.DateTimeFormat } }).Intl =
    { ...globalThis.Intl, DateTimeFormat: spy };
  restoreIntl = () => {
    (globalThis as unknown as { Intl: { DateTimeFormat: typeof Intl.DateTimeFormat } }).Intl =
      { ...globalThis.Intl, DateTimeFormat: realIntl };
  };
}

afterEach(() => {
  if (restoreIntl) {
    restoreIntl();
    restoreIntl = null;
  }
  vi.restoreAllMocks();
});

// ---- Tests ---------------------------------------------------------------

describe("TASK-BQF-003 formatBigQueryCell — locale-aware temporal", () => {
  it("DATE with locale='en-US' → en-US:YYYY-MM-DD; spy receives locale+date options", () => {
    installIntlSpy();
    const out = formatBigQueryCell("2024-09-05", { type: "DATE", locale: "en-US" });
    expect(out).toBe("en-US:2024-09-05");
    expect(spyCalls.length).toBe(1);
    expect(spyCalls[0].locale).toBe("en-US");
    expect(spyCalls[0].options.year).toBe("numeric");
    expect(spyCalls[0].options.month).toBe("2-digit");
    expect(spyCalls[0].options.day).toBe("2-digit");
  });

  it("DATE with locale='de-DE' → de-DE:YYYY-MM-DD", () => {
    installIntlSpy();
    const out = formatBigQueryCell("2024-09-05", { type: "DATE", locale: "de-DE" });
    expect(out).toBe("de-DE:2024-09-05");
  });

  it("DATETIME with locale='en-US' → en-US:YYYY-MM-DD HH:MM:SS; spy receives date+time options", () => {
    installIntlSpy();
    const out = formatBigQueryCell("2024-09-05 12:34:56", {
      type: "DATETIME",
      locale: "en-US",
    });
    expect(out).toBe("en-US:2024-09-05 12:34:56");
    expect(spyCalls[0].options.hour).toBe("2-digit");
    expect(spyCalls[0].options.minute).toBe("2-digit");
    expect(spyCalls[0].options.second).toBe("2-digit");
  });

  it("TIMESTAMP with locale='en-US' → en-US:ISO", () => {
    installIntlSpy();
    const out = formatBigQueryCell("2024-09-05T12:34:56Z", {
      type: "TIMESTAMP",
      locale: "en-US",
    });
    expect(out).toBe("en-US:2024-09-05 12:34:56");
  });

  it("TIME with locale='vi-VN' → vi-VN:HH:MM:SS; spy receives time-only options", () => {
    installIntlSpy();
    const out = formatBigQueryCell("12:34:56", { type: "TIME", locale: "vi-VN" });
    expect(out).toBe("vi-VN:12:34:56");
    expect(spyCalls[0].options.year).toBeUndefined();
    expect(spyCalls[0].options.hour).toBe("2-digit");
  });

  it("regression: no field → temporal string stays verbatim (frozen pre-BQF-003 contract)", () => {
    installIntlSpy();
    expect(formatBigQueryCell("2024-09-05")).toBe("2024-09-05");
    expect(formatBigQueryCell("2024-09-05T12:34:56Z")).toBe("2024-09-05T12:34:56Z");
    expect(spyCalls.length).toBe(0);
  });

  it("regression: field.type without locale → temporal string stays verbatim", () => {
    installIntlSpy();
    expect(formatBigQueryCell("2024-09-05", { type: "DATE" })).toBe("2024-09-05");
    expect(spyCalls.length).toBe(0);
  });

  it("edge: invalid DATE string + locale → falls back to verbatim; spy NOT called", () => {
    installIntlSpy();
    expect(formatBigQueryCell("not-a-date", { type: "DATE", locale: "en-US" })).toBe(
      "not-a-date",
    );
    expect(spyCalls.length).toBe(0);
  });

  it("edge: empty temporal string + locale → falls back to verbatim; spy NOT called", () => {
    installIntlSpy();
    expect(formatBigQueryCell("", { type: "DATE", locale: "en-US" })).toBe("");
    expect(spyCalls.length).toBe(0);
  });

  it("regression: non-temporal field.type with locale → stays verbatim; spy NOT called", () => {
    installIntlSpy();
    expect(formatBigQueryCell("hello world", { type: "STRING", locale: "en-US" })).toBe(
      "hello world",
    );
    expect(
      formatBigQueryCell("9007199254740993", { type: "INT64", locale: "en-US" }),
    ).toBe("9007199254740993");
    expect(spyCalls.length).toBe(0);
  });

  it("edge: invalid locale tag (Intl throws) → falls back to verbatim", () => {
    // Patch the constructor to throw — simulates an invalid BCP-47 tag.
    (globalThis as unknown as { Intl: { DateTimeFormat: typeof Intl.DateTimeFormat } }).Intl = {
      ...globalThis.Intl,
      DateTimeFormat: function ThrowingDateTimeFormat() {
        throw new Error("Invalid locale");
      } as unknown as typeof Intl.DateTimeFormat,
    };
    restoreIntl = () => {
      (globalThis as unknown as { Intl: { DateTimeFormat: typeof Intl.DateTimeFormat } }).Intl = {
        ...globalThis.Intl,
        DateTimeFormat: realIntl,
      };
    };
    expect(formatBigQueryCell("2024-09-05", { type: "DATE", locale: "en-US" })).toBe(
      "2024-09-05",
    );
  });
});
