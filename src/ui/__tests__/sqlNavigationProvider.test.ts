// src/ui/__tests__/sqlNavigationProvider.test.ts
// TASK-DBX02-003 — minimal contract: hover + definition return Markdown
// / Location when navigation is enabled; quiet on non-PostgreSQL.

import { describe, it, expect, vi } from "vitest";
import type { ColumnInfo, TableInfo } from "../../adapters/types";
import type { SchemaCache } from "../schemaCache";
import { createCatalogResolver } from "../sqlCatalog";
import { SqlCatalogDocumentProvider } from "../sqlCatalogDocumentProvider";
import { SqlNavigationProvider } from "../sqlNavigationProvider";

vi.mock("vscode", () => {
  class MarkdownString { public value = ""; public isTrusted = false;
    appendMarkdown(t: string) { this.value += t; return this; } }
  class Hover { constructor(public contents: MarkdownString) {} }
  class Uri {
    public readonly scheme: string; public readonly path: string; public readonly query: string; public readonly fsPath: string;
    private constructor(s: string, p: string, q: string) { this.scheme=s; this.path=p; this.query=q; this.fsPath=p; }
    static parse(v: string) { const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*?)(\?.*)?$/.exec(v); return new Uri(m?m[1]:"file", m?m[2]:v, m?m[3]??"":""); }
    toString() { return `${this.scheme}:${this.path}${this.query}`; }
  }
  class Position { constructor(public line: number, public character: number) {} }
  class Range { constructor(public start: Position, public end: Position) {} }
  class Location { constructor(public uri: Uri, public range: Range) {} }
  return { MarkdownString, Hover, Uri, Position, Range, Location };
});

import * as vscode from "vscode";

function makeCacheMock(tables: TableInfo[], columns: ColumnInfo[]): SchemaCache {
  return {
    hasCatalog: vi.fn(async () => true),
    getViews: vi.fn(async () => []),
    getRoutines: vi.fn(async () => []),
    getTables: vi.fn(async () => tables),
    getColumns: vi.fn(async () => columns),
    getConstraints: vi.fn(async () => []),
    getSequences: vi.fn(async () => []),
    getObjectDdl: vi.fn(async () => ""),
    invalidate: vi.fn(),
  } as unknown as SchemaCache;
}

function makeDoc(text: string): vscode.TextDocument {
  const lines = text.split("\n");
  return {
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  } as unknown as vscode.TextDocument;
}

function makeProvider(tables: TableInfo[], columns: ColumnInfo[], isPostgres = true) {
  const cache = makeCacheMock(tables, columns);
  const resolver = createCatalogResolver(cache, { isPostgres: () => isPostgres });
  const document = new SqlCatalogDocumentProvider();
  const provider = new SqlNavigationProvider({ cache, catalog: resolver, documentProvider: document });
  return { provider, document };
}

describe("SqlNavigationProvider — minimal contract", () => {
  it("returns hover for a known table with column list", async () => {
    const { provider } = makeProvider(
      [{ name: "users", schema: "public" }],
      [{ name: "id", dataType: "integer", nullable: false, isPrimaryKey: true }],
    );
    const doc = makeDoc("SELECT * FROM users");
    const pos = new vscode.Position(0, 14);
    const hover = await provider.provideHover(doc, pos);
    expect(hover).toBeDefined();
    const md = (hover!.contents as { value: string }).value;
    expect(md).toContain("public.users");
    expect(md).toContain("id");
  });

  it("returns a definition Location for a known table", async () => {
    const { provider, document } = makeProvider(
      [{ name: "users", schema: "public" }],
      [{ name: "id", dataType: "integer", nullable: false, isPrimaryKey: true }],
    );
    const doc = makeDoc("SELECT * FROM users");
    const pos = new vscode.Position(0, 14);
    const def = await provider.provideDefinition(doc, pos);
    expect(def).toBeDefined();
    const loc = Array.isArray(def) ? def[0] : def;
    expect((loc as { uri: vscode.Uri }).uri.scheme).toBe("vsdb-sql-catalog");
    const content = document.provideTextDocumentContent((loc as { uri: vscode.Uri }).uri);
    expect(content).toContain("public.users");
  });

  it("returns undefined on non-PostgreSQL", async () => {
    const { provider } = makeProvider([], [], false);
    const doc = makeDoc("SELECT * FROM users");
    const pos = new vscode.Position(0, 14);
    expect(await provider.provideHover(doc, pos)).toBeUndefined();
    expect(await provider.provideDefinition(doc, pos)).toBeUndefined();
  });
});
