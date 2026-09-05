// src/ui/largeValueEditor.ts
// DBX-01-004 — large-value editor. Registers a `UnicDB-lv:` text
// document content provider that serves full-fidelity cell values
// (JSON blobs, long text) in a read-only editor tab. Content passes
// through verbatim — 200 KB or 2 MB, never truncated. State is a
// simple Map keyed by URI; entries live only for the editor session.

import * as vscode from "vscode";

export const LARGE_VALUE_SCHEME = "UnicDB-lv";

export class LargeValueProvider implements vscode.TextDocumentContentProvider {
  private readonly entries = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.entries.get(uri.toString()) ?? "";
  }

  put(label: string, value: string): vscode.Uri {
    const key = `${encodeURIComponent(label)}`;
    const uri = vscode.Uri.parse(`${LARGE_VALUE_SCHEME}:/${key}`);
    this.entries.set(uri.toString(), value);
    return uri;
  }

  dispose(): void {
    this.entries.clear();
  }
}

let shared: LargeValueProvider | undefined;

/** Shared provider instance for the activation lifetime. */
export function getLargeValueProvider(): LargeValueProvider {
  if (shared === undefined) {
    shared = new LargeValueProvider();
  }
  return shared;
}

/**
 * Open a cell value in a read-only editor via the `UnicDB-lv:` scheme.
 * Command handler for `UnicDB.editLargeValue`.
 */
export async function openLargeValueEditor(cell: { label: string; value: string }): Promise<void> {
  const provider = getLargeValueProvider();
  const uri = provider.put(cell.label, cell.value);
  await vscode.window.showTextDocument(uri, { preview: false });
}
