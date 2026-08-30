import { describe, expect, it } from "vitest";
import {
  containsSecretHeuristic,
  isProbablyBinary,
  matchesGlob,
  searchWorkspaceFiles,
  MAX_FILE_HITS,
  MAX_CONTEXT_LINES,
  type GroundedFile,
} from "../fileSearch";

const f = (path: string, content: string): GroundedFile => ({ path, content });

describe("isProbablyBinary", () => {
  it("flags content with a NUL byte in the first 8 KB", () => {
    expect(isProbablyBinary("hi\u0000there")).toBe(true);
    expect(isProbablyBinary("hi\nthere")).toBe(false);
  });
});

describe("containsSecretHeuristic", () => {
  it("matches AWS access keys", () => {
    expect(containsSecretHeuristic("key = AKIAABCDEFGHIJKLMNOP")).toBe(true);
  });
  it("matches PRIVATE KEY blocks", () => {
    expect(containsSecretHeuristic("-----BEGIN PRIVATE KEY-----\nfoo")).toBe(true);
  });
  it("matches GitHub tokens", () => {
    expect(containsSecretHeuristic("token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789")).toBe(true);
  });
  it("matches Anthropic API keys", () => {
    expect(containsSecretHeuristic("sk-ant-api03-1234567890abcdefghij")).toBe(true);
  });
  it("does not match innocuous prose", () => {
    expect(containsSecretHeuristic("import express from 'express';")).toBe(false);
  });
});

describe("matchesGlob", () => {
  it("matches simple wildcards", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/sub/a.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/sub/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/a.tx", "src/*.ts")).toBe(false);
  });
});

describe("searchWorkspaceFiles", () => {
  it("returns [] for empty query", () => {
    const r = searchWorkspaceFiles([f("a.ts", "foo")], { terms: [] });
    expect(r.hits).toEqual([]);
    expect(r.excluded).toEqual([]);
  });

  it("ranks higher match count first; deterministic tie-break by path", () => {
    const files = [
      f("zzz.ts", "alpha alpha\nfoo"),
      f("aaa.ts", "alpha"),
    ];
    const r = searchWorkspaceFiles(files, { terms: ["alpha"] });
    expect(r.hits[0].path).toBe("zzz.ts");
    expect(r.hits[1].path).toBe("aaa.ts");
  });

  it("respects the glob filter", () => {
    const r = searchWorkspaceFiles(
      [f("src/a.ts", "alpha"), f("lib/a.ts", "alpha"), f("src/b.md", "alpha")],
      { terms: ["alpha"], glob: "src/**" },
    );
    expect(r.hits.every((h) => h.path.startsWith("src/"))).toBe(true);
  });

  it("caps to MAX_FILE_HITS and MAX_CONTEXT_LINES", () => {
    const big = Array.from({ length: MAX_CONTEXT_LINES + 5 }, () => "alpha").join("\n");
    const many = Array.from({ length: MAX_FILE_HITS + 2 }, (_, i) => f(`f${i}.ts`, big));
    const r = searchWorkspaceFiles(many, { terms: ["alpha"] });
    expect(r.hits.length).toBeLessThanOrEqual(MAX_FILE_HITS);
    const totalLines = r.hits.reduce((acc, h) => acc + (h.endLine - h.startLine + 1), 0);
    expect(totalLines).toBeLessThanOrEqual(MAX_CONTEXT_LINES);
  });

  it("excludes binary files and reports them in excluded", () => {
    const r = searchWorkspaceFiles(
      [f("text.ts", "alpha"), f("blob.bin", "alpha\u0000alpha")],
      { terms: ["alpha"] },
    );
    expect(r.hits.map((h) => h.path)).toEqual(["text.ts"]);
    expect(r.excluded).toContain("blob.bin");
  });

  it("excludes secret-bearing files", () => {
    const r = searchWorkspaceFiles(
      [f("text.ts", "alpha"), f("creds.txt", "key: AKIAABCDEFGHIJKLMNOP")],
      { terms: ["alpha", "AKIAABCDEFGHIJKLMNOP"] },
    );
    expect(r.hits.map((h) => h.path)).toEqual(["text.ts"]);
    expect(r.excluded).toContain("creds.txt");
  });

  it("returns the matching line range with score=match count", () => {
    const r = searchWorkspaceFiles(
      [f("a.ts", "alpha\nbeta\ngamma alpha\nalpha alpha")],
      { terms: ["alpha"] },
    );
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].path).toBe("a.ts");
    expect(r.hits[0].score).toBeGreaterThan(1);
    expect(r.hits[0].startLine).toBe(1);
    expect(r.hits[0].endLine).toBe(4);
  });
});
