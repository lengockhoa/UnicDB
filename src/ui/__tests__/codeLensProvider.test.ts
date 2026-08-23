// src/ui/__tests__/codeLensProvider.test.ts
// Unit tests cho CodeLensProvider — TASK-007 §Test Cases #5, #6, TASK-605 #3-#6.
// Cover: lens positions from splitStatements; showRunLens off → no lenses;
// shellscript lens on line 0; showRunLensSh off → no shell lens; markdown → [];
// config change on showRunLensSh triggers lens re-emit.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ParsedStatement } from "../../config/types";

// Light vscode mocks — just enough for CodeLensProvider.
const state = {
  configShowRunLens: true,
  configShowRunLensSh: true,
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
      start: { line: number; character: number } | number,
      end?: { line: number; character: number } | number,
      startChar?: number,
      endLine?: number,
      endChar?: number,
    ) {
      // Support Range(startPos, endPos) and Range(startLine, startChar, endLine, endChar)
      const startObj =
        typeof start === "number"
          ? { line: start, character: startChar ?? 0 }
          : start;
      const endObj =
        typeof end === "number"
          ? { line: endLine ?? 0, character: endChar ?? 0 }
          : end;
      (this as { start: unknown }).start = startObj;
      (this as { end: unknown }).end = endObj;
      return this;
    }),
    Position: vi.fn().mockImplementation(function (
      this: unknown,
      line: number,
      character: number,
    ) {
      (this as { line: number }).line = line;
      (this as { character: number }).character = character;
      return this;
    }),
    workspace: {
      getConfiguration: vi.fn((section: string) => ({
        get: <T>(key: string): T | undefined => {
          state.workspaceConfigCalls.push({ section });
          if (section === "vsdb" && key === "showRunLens") {
            return state.configShowRunLens as T;
          }
          if (section === "vsdb" && key === "showRunLensSh") {
            return state.configShowRunLensSh as T;
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

import * as vscode from "vscode";
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
    state.configShowRunLensSh = true;
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
    for (const l of lenses) {
      const stmt = l.command.arguments[0] as ParsedStatement;
      expect(stmt.end - stmt.start).toBeGreaterThan(0);
      expect(sql.substring(stmt.start, stmt.end)).toBe(stmt.text);
    }
  });

  // ===== TASK-605: shellscript "▶ Run" lens =====

  it("Test #3 — shellscript document → exactly 1 lens on line 0, command 'vsdb.runScript', title '$(play) Run', no args", () => {
    const provider = new VsdbCodeLensProvider();
    const doc = fakeDoc("shellscript", ["#!/bin/bash", "echo hi"]);
    const lenses = provider.provideCodeLenses(doc as never) as Array<{
      range: { start: { line: number; character: number } };
      command: { command: string; title: string; arguments: unknown[] };
    }>;
    expect(lenses.length).toBe(1);
    expect(lenses[0].range.start.line).toBe(0);
    expect(lenses[0].range.start.character).toBe(0);
    expect(lenses[0].command.command).toBe("vsdb.runScript");
    expect(lenses[0].command.title).toBe("$(play) Run");
    expect(lenses[0].command.arguments).toEqual([]);
  });

  it("Test #4 — showRunLensSh=false → [] cho shellscript; SQL path vẫn dùng showRunLens như cũ", () => {
    const provider = new VsdbCodeLensProvider();

    state.configShowRunLensSh = false;
    const shDoc = fakeDoc("shellscript", ["#!/bin/bash", "echo hi"]);
    const shLenses = provider.provideCodeLenses(shDoc as never);
    expect(shLenses).toEqual([]);

    state.configShowRunLensSh = true;
    state.configShowRunLens = true;
    const sqlDoc = fakeDoc("sql", ["SELECT 1;", "SELECT 2;"]);
    const sqlLenses = provider.provideCodeLenses(sqlDoc as never) as Array<{
      command: { command: string };
    }>;
    expect(sqlLenses.length).toBeGreaterThanOrEqual(2);
    for (const l of sqlLenses) {
      expect(l.command.command).toBe("vsdb.runStatement");
    }
  });

  it("Test #5 (TASK-605) — languageId neither sql nor shellscript (markdown) → []", () => {
    const provider = new VsdbCodeLensProvider();
    const doc = fakeDoc("markdown", ["# heading", "echo nope"]);
    const lenses = provider.provideCodeLenses(doc as never);
    expect(lenses).toEqual([]);
  });

  it("Test #6 — config change trên showRunLensSh trigger _onDidChangeCodeLenses (mirror SQL pattern)", () => {
    // Provider phải được tạo TRƯỚC khi inspect mock results (clearAllMocks reset state).
    const provider = new VsdbCodeLensProvider();
    void provider;

    const EventEmitterMock = vi.mocked(vscode.EventEmitter);
    const lastInstance = EventEmitterMock.mock.results.at(-1)?.value as
      | { fire: ReturnType<typeof vi.fn> }
      | undefined;
    expect(lastInstance).toBeDefined();
    if (!lastInstance) return;
    const fireSpy = lastInstance.fire;

    const onDidChangeConfigMock = vi.mocked(vscode.workspace.onDidChangeConfiguration);
    const cb = onDidChangeConfigMock.mock.calls.at(-1)?.[0] as
      | ((e: { affectsConfiguration: (s: string) => boolean }) => void)
      | undefined;
    expect(cb).toBeDefined();
    if (!cb) return;

    fireSpy.mockClear();
    cb({ affectsConfiguration: (s: string) => s === "vsdb.showRunLensSh" });
    expect(fireSpy).toHaveBeenCalled();

    fireSpy.mockClear();
    cb({ affectsConfiguration: (s: string) => s === "vsdb.unrelated" });
    expect(fireSpy).not.toHaveBeenCalled();
  });
});
