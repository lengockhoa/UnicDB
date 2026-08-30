// src/ui/sqlCatalogDocumentProvider.ts
//
// TASK-DBX02-003 — Lazy `vsdb-sql-catalog:` virtual document provider.
// The navigation provider hands this provider a `vscode.Uri` and the
// populated metadata / DDL string via `put(...)`; when VS Code asks for the
// document content of that URI (after a definition jump), we serve it back
// verbatim from the cache.
//
// Why lazy: PostgreSQL catalog objects (tables, columns, FKs, sequences)
// have no workspace source URI. We mint virtual URIs whose path encodes
// the kind/schema/name so the editor tab shows a readable label, and let
// this provider resolve content only when VS Code actually opens the tab.
//
// The cache is keyed by `uri.toString()`. No in-memory document state
// beyond the string the navigation provider deposited — there is no
// language server, controller, or debounce here.
import * as vscode from "vscode";

export const CATALOG_SCHEME = "vsdb-sql-catalog";

/**
 * Object kinds the virtual catalog documents can describe. Tables, columns,
 * foreign keys, and sequences are populated from typed SchemaCache +
 * CatalogResolver data; views/routines additionally accept resolver DDL.
 */
export type CatalogKind =
  | "table"
  | "column"
  | "foreignKey"
  | "view"
  | "routine"
  | "sequence";

/**
 * `put(...)` callers — the navigation provider — deposit typed metadata
 * or DDL text. The provider returns it unchanged when VS Code opens the
 * matching URI. If the navigation never deposited anything for a URI,
 * `provideTextDocumentContent` returns an empty string (VS Code displays
 * an empty buffer).
 */
export interface SqlCatalogDocumentProviderShape
  extends vscode.TextDocumentContentProvider {
  /**
   * Drop the cached entry for `uri`. Used by the navigation provider when
   * a stale token no longer resolves.
   */
  clear(uri: vscode.Uri): void;
  /**
   * Populate / overwrite the content associated with `uri`.
   */
  put(uri: vscode.Uri, content: string): void;
}

export class SqlCatalogDocumentProvider
  implements SqlCatalogDocumentProviderShape
{
  private readonly entries = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.entries.get(uri.toString()) ?? "";
  }

  put(uri: vscode.Uri, content: string): void {
    this.entries.set(uri.toString(), content);
  }
  clear(uri: vscode.Uri): void {
    this.entries.delete(uri.toString());
  }

  dispose(): void {
    this.entries.clear();
  }
}

/**
 * Build the canonical `vsdb-sql-catalog:` URI for one object identity.
 * The path encodes `(kind, schema, name)` so VS Code's tab label is
 * human-readable (e.g. `/view/public/v_orders`).
 */
export function buildCatalogMetadataUri(
  kind: CatalogKind,
  schema: string,
  name: string,
): vscode.Uri {
  return vscode.Uri.parse(
    `${CATALOG_SCHEME}:/${kind}/${schema}/${name}`,
  );
}
