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
    insertText?: string;
    constructor(label: string, kind: number) {
      this.label = label;
      this.kind = kind;
    }
  }
  // Values mirror @types/vscode's enum ordinals for the kinds we use.
  const CompletionItemKind = {
    Class: 7,
    Function: 2,
    Constant: 13,
    Interface: 7,
    Module: 9,
    Property: 10,
    Keyword: 14,
    Value: 14,
  };
  return { CompletionItem, CompletionItemKind };
});

import * as vscode from "vscode";
import { SqlCompletionProvider } from "../sqlCompletionProvider";
import { SchemaCache } from "../schemaCache";
import type {
  CatalogForeignKeyRow,
  CatalogResolver,
  CatalogRootRow,
} from "../sqlCatalog";

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

const emptyCatalogResolver: CatalogResolver = {
  async listRootRows(): Promise<readonly CatalogRootRow[]> {
    return [];
  },
  async listForeignKeys(): Promise<readonly CatalogForeignKeyRow[]> {
    return [];
  },
  async getDefinition(): Promise<string | undefined> {
    return undefined;
  },
};

function makeProvider(
  adapterProvider: () => Promise<DbAdapter | null> | DbAdapter | null,
  hasConnection = true,
  resolver?: CatalogResolver,
  isPostgres = true,
): SqlCompletionProvider {
  const cache = new SchemaCache(adapterProvider);
  return new SqlCompletionProvider({
    cache,
    catalog: resolver ?? emptyCatalogResolver,
    isPostgres: () => isPostgres,
    hasConnection: () => hasConnection,
  });
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

  // ---- TASK-DBX02-002 §Test Cases ------------------------------------------

  it("#7 FK target table appears under <table>. dot trigger", async () => {
    const { adapter } = makeAdapter();
    const listForeignKeys = vi.fn(async () => [
      {
        kind: "foreignKey" as const,
        schema: "public",
        table: "orders",
        name: "fk_orders_user",
        columns: ["user_id"],
        target: { schema: "public", table: "users", columns: ["id"] },
      },
    ]);
    const resolver: CatalogResolver = {
      ...emptyCatalogResolver,
      listForeignKeys,
    };
    const provider = makeProvider(() => adapter, true, resolver);
    const items = await provider.provideCompletionItems(
      doc("SELECT * FROM orders."),
      pos("SELECT * FROM orders.".length),
    );
    const labels = items.map((i) => i.label);
    expect(labels).toContain("users");
    const usersItem = items.find((i) => i.label === "users");
    expect(usersItem?.kind).toBe(vscode.CompletionItemKind.Class);
    expect(usersItem?.insertText).toBe("users");
    expect(listForeignKeys).toHaveBeenCalledWith("public", "orders");
  });

  it("#8 views/routines/sequences appear under root prefix", async () => {
    const { adapter } = makeAdapter();
    const listRootRows = vi.fn(async () =>
      [
        { kind: "view" as const, schema: "public", name: "v_orders" },
        {
          kind: "routine" as const,
          schema: "public",
          name: "fn_total",
          routineKind: "function" as const,
        },
        {
          kind: "sequence" as const,
          schema: "public",
          name: "order_seq",
          dataType: "bigint",
        },
      ] as readonly CatalogRootRow[],
    );
    const resolver: CatalogResolver = {
      ...emptyCatalogResolver,
      listRootRows,
    };
    const provider = makeProvider(() => adapter, true, resolver);
    const items = await provider.provideCompletionItems(doc("SELECT "), pos(7));
    const byLabel = new Map(items.map((i) => [i.label, i]));
    const view = byLabel.get("v_orders");
    const routine = byLabel.get("fn_total");
    const sequence = byLabel.get("order_seq");
    expect(view?.kind).toBe(vscode.CompletionItemKind.Class);
    expect(view?.detail).toBe("view · public");
    expect(view?.insertText).toBe("v_orders");
    expect(routine?.kind).toBe(vscode.CompletionItemKind.Function);
    expect(routine?.detail).toBe("function · public");
    expect(routine?.insertText).toBe("fn_total");
    expect(sequence?.kind).toBe(vscode.CompletionItemKind.Constant);
    expect(sequence?.detail).toBe("bigint · public");
    expect(sequence?.insertText).toBe("order_seq");
  });

  it("#9 isPostgres=false silences catalog rows; no connection still returns []", async () => {
    const { adapter } = makeAdapter();
    const listRootRows = vi.fn(async () =>
      [
        { kind: "view" as const, schema: "public", name: "v_orders" },
      ] as readonly CatalogRootRow[],
    );
    const resolver: CatalogResolver = {
      ...emptyCatalogResolver,
      listRootRows,
    };
    // isPostgres=false → catalog rows suppressed even though resolver returns data.
    const providerNonPg = makeProvider(() => adapter, true, resolver, false);
    const itemsNonPg = await providerNonPg.provideCompletionItems(
      doc("SELECT "),
      pos(7),
    );
    expect(itemsNonPg.map((i) => i.label)).not.toContain("v_orders");
    expect(itemsNonPg.map((i) => i.label)).toContain("public");
    expect(itemsNonPg.map((i) => i.label)).toContain("users");
    // isPostgres=true with the same resolver → catalog row MUST appear (proves the gate).
    const providerPg = makeProvider(() => adapter, true, resolver, true);
    const itemsPg = await providerPg.provideCompletionItems(
      doc("SELECT "),
      pos(7),
    );
    expect(itemsPg.map((i) => i.label)).toContain("v_orders");
    // hasConnection=false → silent [], same shape as before.
    const providerNoConn = makeProvider(() => adapter, false);
    const itemsNoConn = await providerNoConn.provideCompletionItems(
      doc("SELECT "),
      pos(7),
    );
    expect(itemsNoConn).toEqual([]);
  });

  it("#10 FK target uses schema-qualified insertText when schema differs", async () => {
    const { adapter } = makeAdapter();
    const listForeignKeys = vi.fn(async () => [
      {
        kind: "foreignKey" as const,
        schema: "public",
        table: "orders",
        name: "fk_orders_archive",
        columns: ["archive_id"],
        target: {
          schema: "archive",
          table: "archived_orders",
          columns: ["id"],
        },
      },
    ]);
    const resolver: CatalogResolver = {
      ...emptyCatalogResolver,
      listForeignKeys,
    };
    const provider = makeProvider(() => adapter, true, resolver);
    const items = await provider.provideCompletionItems(
      doc("SELECT * FROM orders."),
      pos("SELECT * FROM orders.".length),
    );
    const fkItem = items.find((i) => i.label === "archived_orders");
    expect(fkItem).toBeDefined();
    expect(fkItem?.kind).toBe(vscode.CompletionItemKind.Class);
    expect(fkItem?.insertText).toBe("archive.archived_orders");
    expect(fkItem?.detail).toBe("archive");
  });
});
