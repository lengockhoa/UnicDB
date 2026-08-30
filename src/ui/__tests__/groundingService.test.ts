import { describe, expect, it } from "vitest";
import { collectGrounding, MENTION_FILE_BYTES_CAP } from "../groundingService";

describe("collectGrounding", () => {
  it("returns null selection and empty files when no deps", async () => {
    const r = await collectGrounding({});
    expect(r.selection).toBeNull();
    expect(r.files).toHaveLength(0);
    expect(r.excluded).toHaveLength(0);
  });

  it("captures the editor selection when getSelection provides it", async () => {
    const r = await collectGrounding({
      getSelection: () => ({ path: "src/x.ts", text: "alpha\nbeta", startLine: 10 }),
    });
    expect(r.selection?.path).toBe("src/x.ts");
    expect(r.selection?.text).toBe("alpha\nbeta");
  });

  it("reads files via injected readFile with per-file cap", async () => {
    const tooLong = "x".repeat(MENTION_FILE_BYTES_CAP + 100);
    const r = await collectGrounding({
      readFile: (p) => Promise.resolve(p === "small.ts" ? "alpha" : tooLong),
      filesToRead: ["small.ts", "big.ts"],
    });
    const big = r.files.find((f) => f.path === "big.ts");
    expect(big).toBeDefined();
    expect(big!.content.length).toBe(MENTION_FILE_BYTES_CAP);
  });

  it("excludes binary and secret files and reports them", async () => {
    const r = await collectGrounding({
      readFile: (p) =>
        Promise.resolve(
          p === "bin.dat" ? "alpha\u0000alpha"
            : p === "creds.txt" ? "key: AKIAABCDEFGHIJKLMNOP"
            : "alpha in ts",
        ),
      filesToRead: ["ok.ts", "bin.dat", "creds.txt"],
    });
    expect(r.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(r.excluded).toContain("bin.dat");
    expect(r.excluded).toContain("creds.txt");
  });

  it("swallows readFile failures and reports the path in excluded", async () => {
    const r = await collectGrounding({
      readFile: (p) => (p === "bad.ts" ? Promise.reject(new Error("gone")) : Promise.resolve("alpha")),
      filesToRead: ["ok.ts", "bad.ts"],
    });
    expect(r.files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(r.excluded).toContain("bad.ts");
  });

  it("records the selection in the attribution record", async () => {
    const r = await collectGrounding({
      getSelection: () => ({ path: "a.ts", text: "alpha" }),
      turnId: "t1",
    });
    expect(r.record.entries).toHaveLength(1);
    expect(r.record.entries[0]).toMatchObject({ kind: "selection", ref: expect.stringContaining("a.ts") });
    expect(r.record.totalBytes).toBe(5);
  });

  it("records file hits (not reads) in the attribution", async () => {
    const r = await collectGrounding({
      readFile: () => Promise.resolve("alpha"),
      filesToRead: ["a.ts", "b.ts"],
      turnId: "t2",
    });
    expect(r.record.entries.length).toBe(2);
    for (const e of r.record.entries) expect(e.kind).toBe("file");
  });

  it("returns empty bundle when disabled", async () => {
    const r = await collectGrounding({
      enabled: false,
      getSelection: () => ({ path: "a.ts", text: "alpha" }),
      readFile: () => Promise.resolve("alpha"),
      filesToRead: ["a.ts"],
    });
    expect(r.selection).toBeNull();
    expect(r.files).toHaveLength(0);
  });
});