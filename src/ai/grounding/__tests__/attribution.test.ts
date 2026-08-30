import { describe, expect, it } from "vitest";
import {
  formatAttributionFooter,
  recordAttribution,
  emptyAttributionRecord,
  type AttributionEntry,
} from "../attribution";

const e = (kind: "file" | "selection" | "schema", ref: string, bytes = 10): AttributionEntry => ({ kind, ref, bytes });

describe("attribution", () => {
  it("dedupes by ref and preserves order", () => {
    let rec = emptyAttributionRecord("t1");
    rec = recordAttribution(rec, [e("file", "src/a.ts"), e("file", "src/b.ts"), e("file", "src/a.ts")]);
    expect(rec.entries.map((x) => x.ref)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("accumulates totalBytes for each recorded entry", () => {
    let rec = emptyAttributionRecord("t2");
    rec = recordAttribution(rec, [e("file", "src/a.ts", 100), e("schema", "public.users", 50)]);
    expect(rec.totalBytes).toBe(150);
    expect(rec.entries).toHaveLength(2);
  });

  it("formatAttributionFooter lists refs in record order", () => {
    let rec = emptyAttributionRecord("t3");
    rec = recordAttribution(rec, [e("file", "src/a.ts"), e("selection", "src/b.ts:3-7"), e("schema", "public.users")]);
    const out = formatAttributionFooter(rec);
    expect(out).toContain("src/a.ts");
    expect(out).toContain("src/b.ts:3-7");
    expect(out).toContain("public.users");
  });

  it("returns empty footer for an empty record", () => {
    const out = formatAttributionFooter(emptyAttributionRecord("empty"));
    expect(out).toBe("");
  });

  it("preserves first-seen kind for duplicate refs (no kind flip)", () => {
    let rec = emptyAttributionRecord("t4");
    rec = recordAttribution(rec, [e("file", "x.ts"), e("selection", "x.ts:1-2")]);
    expect(rec.entries[0].kind).toBe("file");
  });

  it("stamps every record with the supplied turnId", () => {
    const rec = emptyAttributionRecord("turn-42");
    expect(rec.turnId).toBe("turn-42");
  });
});
