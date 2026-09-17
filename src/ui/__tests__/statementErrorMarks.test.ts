import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ParsedStatement } from "../../config/types";

// Minimal vscode mock surface used by statementErrorMarks.ts
const decorationDispose = vi.fn();
const collectionSet = vi.fn();
const collectionDelete = vi.fn();
const collectionDispose = vi.fn();

vi.mock("vscode", () => {
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
  class ThemeColor {
    constructor(public id: string) {}
  }
  class Diagnostic {
    source?: string;
    constructor(
      public range: Range,
      public message: string,
      public severity: number,
    ) {}
  }
  return {
    Position,
    Range,
    ThemeColor,
    Diagnostic,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    OverviewRulerLane: { Right: 7 },
    window: {
      createTextEditorDecorationType: vi.fn(() => ({
        dispose: decorationDispose,
      })),
    },
    languages: {
      createDiagnosticCollection: vi.fn(() => ({
        set: collectionSet,
        delete: collectionDelete,
        dispose: collectionDispose,
        clear: vi.fn(),
      })),
    },
  };
});

import { createStatementErrorMarker } from "../statementErrorMarks";

const STATEMENTS: ParsedStatement[] = [
  { text: "select 1", start: 0, end: 8 },
  { text: "select bad", start: 10, end: 20 },
  { text: "select 3", start: 22, end: 30 },
];

import * as vscode from "vscode";

function makeRealEditor() {
  const uri = { fsPath: "/tmp/q.sql", scheme: "file" } as unknown as import("vscode").Uri;
  return {
    document: {
      uri,
      positionAt: (offset: number) => new vscode.Position(0, offset),
    },
    setDecorations: vi.fn(),
  } as unknown as import("vscode").TextEditor;
}

describe("statementErrorMarks", () => {
  beforeEach(() => {
    decorationDispose.mockClear();
    collectionSet.mockClear();
    collectionDelete.mockClear();
    collectionDispose.mockClear();
  });

  it("marks the failed statement range and publishes one diagnostic", () => {
    const editor = makeRealEditor();
    const marker = createStatementErrorMarker();
    marker.mark(editor, STATEMENTS, 1, "syntax error");

    expect(editor.setDecorations).toHaveBeenCalledTimes(1);
    const ranges = (editor.setDecorations as never as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as import("vscode").Range[];
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start).toEqual(new vscode.Position(0, 10));
    expect(ranges[0].end).toEqual(new vscode.Position(0, 20));

    expect(collectionSet).toHaveBeenCalledTimes(1);
    const [uri, diags] = collectionSet.mock.calls[0];
    expect(uri).toBe(editor.document.uri);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("syntax error");
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(diags[0].source).toBe("UnicDB");
  });

  it("no-ops when failedIndex is out of range or statements empty", () => {
    const editor = makeRealEditor();
    const marker = createStatementErrorMarker();
    expect(() => marker.mark(editor, STATEMENTS, 5, "x")).not.toThrow();
    expect(() => marker.mark(editor, [], 0, "x")).not.toThrow();
    expect(editor.setDecorations).not.toHaveBeenCalled();
    expect(collectionSet).not.toHaveBeenCalled();
  });

  it("clear() before any mark is a no-op", () => {
    const marker = createStatementErrorMarker();
    expect(() => marker.clear()).not.toThrow();
    expect(collectionDelete).not.toHaveBeenCalled();
  });

  it("second mark replaces prior decoration + diagnostic", () => {
    const editor = makeRealEditor();
    const marker = createStatementErrorMarker();
    marker.mark(editor, STATEMENTS, 0, "first");
    marker.mark(editor, STATEMENTS, 2, "second");

    // last set call holds exactly one diagnostic
    const lastCall = collectionSet.mock.calls[collectionSet.mock.calls.length - 1];
    expect(lastCall[1]).toHaveLength(1);
    expect(lastCall[1][0].message).toBe("second");
    // prior decoration cleared before re-marking
    expect((editor.setDecorations as never as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("dispose() disposes decoration type and collection", () => {
    const marker = createStatementErrorMarker();
    marker.dispose();
    expect(decorationDispose).toHaveBeenCalledTimes(1);
    expect(collectionDispose).toHaveBeenCalledTimes(1);
  });
});
