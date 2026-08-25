// src/ui/codeLensProvider.ts
// CodeLensProvider — "▶ Run" lens trên mỗi statement SQL.
//
// Lens command: "vsdb.runStatement" với argument [statement, index].
// Filter: languageId === 'sql' AND vsdb.showRunLens === true.
// onDidChangeConfiguration: invalidates + bắn event để VS Code refresh.
import * as vscode from "vscode";
import { splitStatements, type SqlDialect } from "../core/statementParser";
import type { ParsedStatement } from "../config/types";

export class VsdbCodeLensProvider implements vscode.CodeLensProvider {
  private readonly _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  private readonly configSub: vscode.Disposable;

  /**
   * `getDialect` (review fix round C, Finding #3) — optional & additive so
   * every existing zero-arg `new VsdbCodeLensProvider()` call (incl. all
   * existing tests) stays valid. Without it `splitStatements` always ran as
   * if the file were Postgres, so MSSQL's `GO` batch separator (gated behind
   * `dialect === "mssql"`, see statementParser.ts) never split lenses for a
   * MSSQL connection's `.sql` file.
   */
  constructor(private readonly getDialect?: () => SqlDialect | undefined) {
    // Re-emit khi config đổi → VS Code sẽ gọi lại provideCodeLenses.
    this.configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vsdb.showRunLens")) {
        this._onDidChangeCodeLenses.fire();
      }
      if (e.affectsConfiguration("vsdb.showRunLensSh")) {
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
    // Shellscript lens: 1 lens ở line 0, command vsdb.runScript, gated by showRunLensSh.
    if (document.languageId === "shellscript") {
      const cfgSh = vscode.workspace.getConfiguration("vsdb");
      const showRunLensSh: boolean = cfgSh.get<boolean>("showRunLensSh") ?? true;
      if (!showRunLensSh) return [];
      const topRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0),
      );
      const cmd: vscode.Command = {
        command: "vsdb.runScript",
        title: "$(play) Run",
        arguments: [],
      };
      return [new vscode.CodeLens(topRange, cmd)];
    }

    // Filter language: chỉ SQL.
    if (document.languageId !== "sql") return [];

    // Filter config: respect showRunLens.
    const cfg = vscode.workspace.getConfiguration("vsdb");
    const showRunLens: boolean = cfg.get<boolean>("showRunLens") ?? true;
    if (!showRunLens) return [];

    const sql = document.getText();
    const statements: ParsedStatement[] = splitStatements(sql, this.getDialect?.());

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
