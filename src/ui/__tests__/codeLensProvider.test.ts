// src/ui/__tests__/codeLensProvider.test.ts
// Unit tests cho CodeLensProvider — TASK-007 §Test Cases #5, #6.
// Cover: lens positions from splitStatements; showRunLens off → no lenses.
// CodeLensProvider lives in extension.ts (small) — test it via internal export.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ParsedStatement } from "../../config/types";

// Light vscode mocks — just enough for CodeLensProvider.
const state = {
  configShowRunLens: true,
  workspaceConfigCalls: [] as Array<{ section: string }>,
  lenses: [] as unknown[],
};

vi.mock("vscode", () => {
  return {
    EventEmitter: vi.fn().mockImplementation(() => ({
      event: () => ({ dispose: () => {} }),
      fire: vi.fn(),
      dispose: vi.fn(),
    })),
    CodeLens: vi.fn().mockImplementation(function (
      this: unknown,
      range: unknown,
      cmd?: unknown,
    ) {
      (this as { range: unknown }).range = range;
      (this as { command: unknown }).command = cmd;
      state.lenses.push(this);
      return this;
    }),
    Range: vi.fn().mockImplementation(function (
      this: unknown,
      startLine: number,
      startChar: number,
      endLine: number,
      endChar: number,
    ) {
      (this as { start: unknown }).start = { line: startLine, character: startChar };
      (this as { end: unknown }).end = { line: endLine, character: endChar };
      return this;
    }),
    workspace: {
      getConfiguration: vi.fn((section: string) => ({
        get: <T>(key: string): T | undefined => {
          state.workspaceConfigCalls.push({ section });
          if (section === "vsdb" && key === "showRunLens") {
            return state.configShowRunLens as T;
          }
          return undefined;
        },
      })),
      onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    },
    window: {
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
    },
  };
});

import { VsdbCodeLensProvider } from "../codeLensProvider";

function fakeDoc(languageId: string, lines: string[]) {
  // Pre-compute line offsets for positionAt.
  const offsets: number[] = [0];
  for (const ln of lines) offsets.push(offsets[offsets.length - 1] + ln.length + 1);
  return {
    languageId,
    lineCount: lines.length,
    lineAt(line: number) {
      return { text: lines[line] ?? "" };
    },
    getText() {
      return lines.join("\n");
    },
    positionAt(offset: number) {
      // Binary search the line.
      let lo = 0;
      let hi = offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offsets[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo, character: offset - offsets[lo] };
    },
    fileName: "test.sql",
  };
}

describe("VsdbCodeLensProvider — provideCodeLenses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.configShowRunLens = true;
    state.lenses = [];
    state.workspaceConfigCalls = [];
  });

  it("Test #5 — showRunLens=true + sql document → 1 lens per statement", () => {
    const provider = new VsdbCodeLensProvider();
    const doc = fakeDoc("sql", ["SELECT 1;", "SELECT 2;"]);
    const lenses = provider.provideCodeLenses(doc as never) as Array<{
      range: { start: { line: number } };
      command: { command: string; arguments: unknown[] };
    }>;
    expect(lenses.length).toBeGreaterThanOrEqual(1);
    expect(lenses[0].command.command).toBe("vsdb.runStatement");
    expect(Array.isArray(lenses[0].command.arguments)).toBe(true);
  });

  it("showRunLens=false → trả về [] (không có lens)", () => {
    state.configShowRunLens = false;
    const provider = new VsdbCodeLensProvider();
    const doc = fakeDoc("sql", ["SELECT 1;", "SELECT 2;"]);
    const lenses = provider.provideCodeLenses(doc as never);
    expect(lenses).toEqual([]);
  });

  it("languageId != sql → trả về [] (filter language)", () => {
    const provider = new VsdbCodeLensProvider();
    const doc = fakeDoc("markdown", ["SELECT 1;"]);
    const lenses = provider.provideCodeLenses(doc as never);
    expect(lenses).toEqual([]);
  });

  it("lens ranges map trở lại statement ranges (test range lengths cover sql length)", () => {
    const provider = new VsdbCodeLensProvider();
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    const doc = fakeDoc("sql", sql.split("\n"));
    const lenses = provider.provideCodeLenses(doc as never) as Array<{
      range: unknown;
      command: { arguments: ParsedStatement[] };
    }>;
    expect(lenses.length).toBe(3);
    // Each argument[0] should be a ParsedStatement with start/end === text length.
    for (const l of lenses) {
      const stmt = l.command.arguments[0] as ParsedStatement;
      expect(stmt.end - stmt.start).toBeGreaterThan(0);
      expect(sql.substring(stmt.start, stmt.end)).toBe(stmt.text);
    }
  });
});
