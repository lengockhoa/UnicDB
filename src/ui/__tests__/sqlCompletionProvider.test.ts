// src/ui/__tests__/sqlCompletionProvider.test.ts
// TASK-008 §Test Cases #1-#6 — SqlCompletionProvider unit tests.
// Mock adapter (listSchemas/listTables/listColumns) + light vscode mock
// (CompletionItem capturing label/kind + CompletionItemKind constants).
import { describe, it, expect, vi } from "vitest";
import type { DbAdapter, ColumnInfo, TableInfo } from "../../adapters/types";

vi.mock("vscode", () => {
  class CompletionItem {
    label: string;
    kind: number;
    detail?: string;
    constructor(label: string, kind: number) {
      this.label = label;
      this.kind = kind;
    }
  }
  // Values mirror @types/vscode's enum ordinals for the kinds we use.
  const CompletionItemKind = {
    Class: 7,
    Module: 9,
    Property: 10,
    Keyword: 14,
  };
  return { CompletionItem, CompletionItemKind };
});

import * as vscode from "vscode";
import { SqlCompletionProvider } from "../sqlCompletionProvider";
import { SchemaCache } from "../schemaCache";

const ALL_TABLES: TableInfo[] = [
  { name: "users", schema: "public" },
  { name: "orders", schema: "public" },
];

const USERS_COLUMNS: ColumnInfo[] = [
  { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
  { name: "email", dataType: "text", nullable: true },
];

interface AdapterMocks {
  adapter: DbAdapter;
  listSchemas: ReturnType<typeof vi.fn>;
  listTables: ReturnType<typeof vi.fn>;
  listColumns: ReturnType<typeof vi.fn>;
}

function makeAdapter(): AdapterMocks {
  const listSchemas = vi.fn(
    async () => [{ name: "public" }, { name: "sales" }],
  );
  const listTables = vi.fn(async (schema?: string) =>
    schema ? ALL_TABLES.filter((t) => t.schema === schema) : ALL_TABLES.slice(),
  );
  const listColumns = vi.fn(async () => USERS_COLUMNS.slice());
  const adapter = { listSchemas, listTables, listColumns } as unknown as DbAdapter;
  return { adapter, listSchemas, listTables, listColumns };
}

function makeProvider(
  adapterProvider: () => Promise<DbAdapter | null> | DbAdapter | null,
  hasConnection = true,
): SqlCompletionProvider {
  const cache = new SchemaCache(adapterProvider);
  return new SqlCompletionProvider({ cache, hasConnection: () => hasConnection });
}

function doc(text: string): vscode.TextDocument {
  return {
    languageId: "sql",
    lineAt: (_line: number) => ({ text }),
  } as unknown as vscode.TextDocument;
}

function pos(character: number): vscode.Position {
  return { line: 0, character } as unknown as vscode.Position;
}

describe("SqlCompletionProvider — TASK-008 §Test Cases", () => {
  it("#1 provideCompletions returns tables for dot trigger", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    // Cursor right after "public." → tables of that schema, Class kind.
    const items = await provider.provideCompletionItems(
      doc("SELECT * FROM public."),
      pos("SELECT * FROM public.".length),
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("users");
    expect(labels).toContain("orders");
    for (const item of items) {
      expect(item.kind).toBe(vscode.CompletionItemKind.Class);
    }
  });

  it("#2 provideCompletions returns columns after table dot", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    // "users." matches a known table → its columns, Property kind.
    const items = await provider.provideCompletionItems(
      doc("SELECT * FROM users."),
      pos("SELECT * FROM users.".length),
    );
    expect(items.map((i) => i.label)).toEqual(["id", "email"]);
    for (const item of items) {
      expect(item.kind).toBe(vscode.CompletionItemKind.Property);
    }
  });

  it("#3 provideCompletions returns schemas", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    // Root context (no dot, no prefix) → schemas offered with Module kind.
    const items = await provider.provideCompletionItems(doc("SELECT "), pos(7));
    const moduleItems = items.filter(
      (i) => i.kind === vscode.CompletionItemKind.Module,
    );
    expect(moduleItems.map((i) => i.label)).toEqual(["public", "sales"]);
  });

  it("#4 provideCompletions filters by prefix", async () => {
    const { adapter } = makeAdapter();
    const provider = makeProvider(() => adapter);
    // Prefix "us" → only "users" from ["users","orders"] (no schema/keyword
    // in the fixture starts with "us").
    const items = await provider.provideCompletionItems(
      doc("SELECT us"),
      pos("SELECT us".length),
    );
    expect(items.map((i) => i.label)).toEqual(["users"]);
  });

  it("#5 provideCompletions with no active connection", async () => {
    const provider = makeProvider(() => null, false);
    const items = await provider.provideCompletionItems(
      doc("SELECT us"),
      pos("SELECT us".length),
    );
    expect(items).toEqual([]);
  });

  it("#6 provideCompletions handles adapter error gracefully", async () => {
    const { adapter, listTables } = makeAdapter();
    listTables.mockRejectedValue(new Error("connection lost"));
    const provider = makeProvider(() => adapter);
    // Dot path needs listTables → adapter throws → empty array, no exception.
    const items = await provider.provideCompletionItems(
      doc("SELECT * FROM public."),
      pos("SELECT * FROM public.".length),
    );
    expect(items).toEqual([]);
  });
});
