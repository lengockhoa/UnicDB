// src/ui/codeLensProvider.ts
// CodeLensProvider — "▶ Run" lens trên mỗi statement SQL.
//
// Lens command: "vsdb.runStatement" với argument [statement, index].
// Filter: languageId === 'sql' AND vsdb.showRunLens === true.
// onDidChangeConfiguration: invalidates + bắn event để VS Code refresh.
import * as vscode from "vscode";
import { splitStatements } from "../core/statementParser";
import type { ParsedStatement } from "../config/types";

export class VsdbCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  private readonly configSub: vscode.Disposable;

  constructor() {
    // Re-emit khi config đổi → VS Code sẽ gọi lại provideCodeLenses.
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vsdb.showRunLens")) {
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  /** Dispose event emitters + config subscription. */
  dispose(): void {
    this.configSub.dispose();
    this._onDidChangeCodeLenses.dispose();
  }

  provideCodeLenses(
    document: vscode.TextDocument,
  ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
    // Filter language: chỉ SQL.
    if (document.languageId !== "sql") return [];

    // Filter config: respect showRunLens.
    const cfg = vscode.workspace.getConfiguration("vsdb");
    const showRunLens: boolean = cfg.get<boolean>("showRunLens") ?? true;
    if (!showRunLens) return [];

    const sql = document.getText();
    const statements: ParsedStatement[] = splitStatements(sql);

    return statements.map((stmt, index) => {
      const startPos = document.positionAt(stmt.start);
      const endPos = document.positionAt(stmt.end);
      const range = new vscode.Range(startPos, endPos);
      const cmd: vscode.Command = {
        command: "vsdb.runStatement",
        title: "$(play) Run",
        arguments: [stmt, index],
      };
      return new vscode.CodeLens(range, cmd);
    });
  }
}
