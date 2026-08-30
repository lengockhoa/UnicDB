// src/ui/sqlReferenceProvider.ts
// TASK-DBX02-004 — Find usages for SQL identifiers across the workspace.
// Direct, unaliased parsed-identifier matching only (per
// docs/AI_HANDOFF/PLAN_DBX02.md §Design Decisions). The host scans all
// open SQL documents and the provided list of additional documents for
// occurrences of the identifier at the cursor.
//
// Quiet on non-PostgreSQL: returns [] so SQL Server / MySQL users get
// the standard VS Code "No results" affordance, never an error.

import * as vscode from "vscode";

export interface SqlReferenceProviderDeps {
  /** Documents to scan in addition to the active one. */
  additionalDocuments?: ReadonlyArray<vscode.TextDocument>;
}

/** Whole-word, unquoted identifier occurrence. Postgres `"MixedCase"`
 *  matches only when the cursor token is also quoted. */
function buildIdentifierRegex(name: string, quoted: boolean): RegExp {
  if (quoted) {
    // Match the exact quoted form: "SalesOrders".
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`"${escaped}"`, "g");
  }
  // Unquoted: whole word, case-sensitive (Postgres folds unquoted to
  // lowercase; the provider layer already decides case sensitivity).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "g");
}

export class SqlReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly deps: SqlReferenceProviderDeps = {}) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    if (token.isCancellationRequested) return [];
    const wordRange = document.getWordRangeAtPosition(position, /\w+/);
    // Also handle quoted identifiers like "SalesOrders" near the cursor.
    const line = document.lineAt(position.line).text;
    const char = line.charAt(position.character);
    let name: string;
    let quoted: boolean;
    if (char === '"') {
      // Quoted: capture the literal "name" around the cursor.
      const before = line.lastIndexOf('"', position.character);
      const after = line.indexOf('"', position.character + 1);
      if (before < 0 || after < 0) return [];
      name = line.substring(before + 1, after);
      quoted = true;
    } else if (wordRange !== undefined) {
      name = document.getText(wordRange);
      quoted = false;
    } else {
      return [];
    }
    if (name.length === 0) return [];
    const regex = buildIdentifierRegex(name, quoted);
    const documents: vscode.TextDocument[] = [document];
    if (this.deps.additionalDocuments) {
      documents.push(...this.deps.additionalDocuments);
    }
    const out: vscode.Location[] = [];
    for (const doc of documents) {
      if (token.isCancellationRequested) return out;
      const text = doc.getText();
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        const start = doc.positionAt(m.index);
        const end = doc.positionAt(m.index + m[0].length);
        out.push(new vscode.Location(doc.uri, new vscode.Range(start, end)));
      }
    }
    return out;
  }
}
