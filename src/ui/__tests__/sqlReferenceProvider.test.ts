// src/ui/__tests__/sqlReferenceProvider.test.ts
// TASK-DBX02-004 — minimal contract: find-usages scans the document for
// whole-word identifier matches; cancellation token returns [].
//
// The vscode mock is registered before the production import so vitest's
// hoisting applies to sqlReferenceProvider.ts as well. Tests consume the
// mock classes through a local namespace alias instead of a value import.

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => {
  class Uri {
    public readonly scheme: string;
    public readonly path: string;
    public readonly query: string;
    public readonly fsPath: string;
    private constructor(s: string, p: string, q: string) {
      this.scheme = s;
      this.path = p;
      this.query = q;
      this.fsPath = p;
    }
    static parse(v: string): Uri {
      const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*?)(\?.*)?$/.exec(v);
      return new Uri(m ? m[1] : "file", m ? m[2] : v, m ? m[3] ?? "" : "");
    }
    toString(): string {
      return `${this.scheme}:${this.path}${this.query}`;
    }
  }
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class Location {
    constructor(
      public uri: Uri,
      public range: Range,
    ) {}
  }
  class CancellationToken {
    isCancellationRequested = false;
    onCancellationRequested = () => ({ dispose: () => {} });
  }
  const vscodeMock = {
    Uri,
    Position,
    Range,
    Location,
    CancellationToken,
  };
  (globalThis as unknown as { __vsdbVscodeMock: typeof vscodeMock }).__vsdbVscodeMock = vscodeMock;
  return vscodeMock;
});

// Import the production module AFTER the mock is registered (vitest hoists
// vi.mock above all imports, so sqlReferenceProvider.ts sees the mock).
import { SqlReferenceProvider } from "../sqlReferenceProvider";

// Local alias bound to the registered mock — avoids a value import of
// "vscode" in the test body (the transform cannot resolve it).
const vscode = (globalThis as unknown as {
  __vsdbVscodeMock: {
    Uri: new (s: string) => { scheme: string; path: string; toString(): string };
    Position: new (line: number, character: number) => { line: number; character: number };
    Range: new (
      start: { line: number; character: number },
      end: { line: number; character: number },
    ) => { start: unknown; end: unknown };
    Location: new (uri: unknown, range: unknown) => { uri: { toString(): string } };
    CancellationToken: new () => { isCancellationRequested: boolean };
  };
}).__vsdbVscodeMock;

function makeDoc(text: string): {
  uri: { toString(): string };
  lineAt: (line: number) => { text: string };
  getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => string;
  getWordRangeAtPosition: (
    pos: { line: number; character: number },
    regex?: RegExp,
  ) => { start: { line: number; character: number }; end: { line: number; character: number } } | undefined;
  positionAt: (offset: number) => { line: number; character: number };
} {
  const lines = text.split("\n");
  return {
    uri: new vscode.Uri("file:///test.sql"),
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
    getText: (range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
      if (!range) return text;
      const linesArr = text.split("\n");
      const startLine = linesArr[range.start.line] ?? "";
      if (range.start.line === range.end.line) {
        return startLine.slice(range.start.character, range.end.character);
      }
      const first = startLine.slice(range.start.character);
      const middle: string[] = [];
      for (let i = range.start.line + 1; i < range.end.line; i++) middle.push(linesArr[i] ?? "");
      const last = (linesArr[range.end.line] ?? "").slice(0, range.end.character);
      return [first, ...middle, last].join("\n");
    },
    getWordRangeAtPosition: (pos, regex) => {
      const lineText = lines[pos.line] ?? "";
      const re = new RegExp(regex?.source ?? "\\w+", "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText)) !== null) {
        const s = m.index;
        const e = s + m[0].length;
        if (pos.character >= s && pos.character <= e) {
          return {
            start: new vscode.Position(pos.line, s),
            end: new vscode.Position(pos.line, e),
          };
        }
        if (m[0].length === 0) break;
      }
      return undefined;
    },
    positionAt: (offset: number) => {
      let cursor = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = (lines[i] ?? "").length + 1;
        if (offset <= cursor + len) {
          return new vscode.Position(i, Math.max(0, offset - cursor));
        }
        cursor += len;
      }
      const last = lines.length - 1;
      return new vscode.Position(last, (lines[last] ?? "").length);
    },
  };
}

describe("SqlReferenceProvider — minimal contract", () => {
  it("returns matching references across the document", async () => {
    const doc = makeDoc("SELECT users.id FROM users WHERE users.active = true;");
    const provider = new SqlReferenceProvider();
    const pos = new vscode.Position(0, 7);
    const refs = await provider.provideReferences(
      doc as never,
      pos as never,
      { includeDeclaration: true } as never,
      new vscode.CancellationToken() as never,
    );
    expect(refs).toBeDefined();
    expect(refs!.length).toBeGreaterThanOrEqual(2);
    for (const r of refs!) {
      expect(r.uri.toString()).toContain("test.sql");
    }
  });

  it("returns [] when there is no identifier at the cursor", async () => {
    const doc = makeDoc("  ");
    const provider = new SqlReferenceProvider();
    const refs = await provider.provideReferences(
      doc as never,
      new vscode.Position(0, 0) as never,
      { includeDeclaration: true } as never,
      new vscode.CancellationToken() as never,
    );
    expect(refs).toEqual([]);
  });

  it("returns [] when cancellation requested", async () => {
    const token = new vscode.CancellationToken();
    token.isCancellationRequested = true;
    const provider = new SqlReferenceProvider();
    const refs = await provider.provideReferences(
      makeDoc("users") as never,
      new vscode.Position(0, 0) as never,
      { includeDeclaration: true } as never,
      token as never,
    );
    expect(refs).toEqual([]);
  });
});
