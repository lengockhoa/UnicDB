/**
 * statementErrorMarks.ts — marks the failing statement in the editor after a run
 * stops on error. Draws a red wavy underline over the failing statement's range
 * and publishes a matching Diagnostic so it shows up in the Problems panel.
 *
 * Self-contained: consumers create one marker via createStatementErrorMarker(),
 * call mark(...) on failure, clear() at the start of each run, and dispose()
 * on extension teardown.
 */
import * as vscode from "vscode";
import type { ParsedStatement } from "../config/types";

export interface StatementErrorMarker {
  mark(
    editor: vscode.TextEditor,
    statements: ParsedStatement[],
    failedIndex: number,
    message: string,
  ): void;
  clear(): void;
  dispose(): void;
}

export function createStatementErrorMarker(): StatementErrorMarker {
  const decorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: "underline wavy",
    color: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  const diagnostics = vscode.languages.createDiagnosticCollection("unicdb-run");

  let lastEditor: vscode.TextEditor | undefined;
  let lastUri: vscode.Uri | undefined;

  function clear(): void {
    if (lastEditor) {
      lastEditor.setDecorations(decorationType, []);
      lastEditor = undefined;
    }
    if (lastUri) {
      diagnostics.delete(lastUri);
      lastUri = undefined;
    }
  }

  function mark(
    editor: vscode.TextEditor,
    statements: ParsedStatement[],
    failedIndex: number,
    message: string,
  ): void {
    clear();
    const stmt = statements?.[failedIndex];
    if (!editor || !stmt) {
      return;
    }
    const doc = editor.document;
    const range = new vscode.Range(
      doc.positionAt(stmt.start),
      doc.positionAt(stmt.end),
    );
    editor.setDecorations(decorationType, [range]);
    const diagnostic = new vscode.Diagnostic(
      range,
      message,
      vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = "UnicDB";
    diagnostics.set(doc.uri, [diagnostic]);
    lastEditor = editor;
    lastUri = doc.uri;
  }

  function dispose(): void {
    clear();
    decorationType.dispose();
    diagnostics.dispose();
  }

  return { mark, clear, dispose };
}
