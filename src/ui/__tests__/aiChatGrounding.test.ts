import { describe, expect, it } from "vitest";
import { collectGrounding } from "../groundingService";

describe("grounding bundle → per-turn block assembly", () => {
  it("selection alone produces a 1-line block + a single selection attribution", async () => {
    const r = await collectGrounding({
      getSelection: () => ({ path: "src/x.ts", text: "const alpha = 1;" }),
      turnId: "t",
    });
    expect(r.selectionBlock).toContain("src/x.ts");
    expect(r.record.entries[0]).toMatchObject({ kind: "selection" });
  });

  it("files produce a per-file block and a file attribution", async () => {
    const r = await collectGrounding({
      readFile: (p) => Promise.resolve(p === "a.ts" ? "alpha" : "beta"),
      filesToRead: ["a.ts", "b.ts"],
      turnId: "t",
    });
    expect(r.files).toHaveLength(2);
    expect(r.record.entries.filter((e) => e.kind === "file")).toHaveLength(2);
  });

  it("excluded files appear in the bundle but NEVER in files or record", async () => {
    const r = await collectGrounding({
      readFile: (p) => Promise.resolve(p === "ok.ts" ? "alpha" : "AKIAABCDEFGHIJKLMNOP"),
      filesToRead: ["ok.ts", "creds.txt"],
      turnId: "t",
    });
    expect(r.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(r.excluded).toContain("creds.txt");
    // File refs are line-ranged (path:1-N) per the attribution contract.
    expect(r.record.entries.map((e) => e.ref)).toEqual(["ok.ts:1-1"]);
  });

  it("selection + files together produce both blocks", async () => {
    const r = await collectGrounding({
      getSelection: () => ({ path: "a.ts", text: "alpha" }),
      readFile: () => Promise.resolve("alpha"),
      filesToRead: ["b.ts"],
      turnId: "t",
    });
    expect(r.selection).not.toBeNull();
    expect(r.files).toHaveLength(1);
    expect(r.record.entries).toHaveLength(2);
  });

  it("formatAttributionFooter summary matches the recorded refs", async () => {
    const r = await collectGrounding({
      getSelection: () => ({ path: "a.ts", text: "alpha" }),
      readFile: () => Promise.resolve("alpha"),
      filesToRead: ["b.ts"],
      turnId: "t",
    });
    const { formatAttributionFooter } = await import("../../ai/grounding/attribution");
    const footer = formatAttributionFooter(r.record);
    // selection wins over the same-named file (dedupe by ref); b.ts is
    // the file hit, a.ts appears via a.ts:1-1.
    expect(footer).toMatch(/a\.ts/);
    expect(footer).toContain("b.ts");
  });
});