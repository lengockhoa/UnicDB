// src/ui/__tests__/sqlNavigationProvider.test.ts
// TASK-DBX02-003 §Test Cases #1-#5 — SqlNavigationProvider (hover +
// definition) and SqlCatalogDocumentProvider unit tests.
//
// vscode is mocked: only the symbols the navigation provider + content
// provider actually touch (Position, Uri, MarkdownString) need real shapes.
// Resolver + cache fixtures mirror the schemaCache/sqlCatalog test patterns:
// lightweight hand-rolled mocks cast as the public types — no `as any`.
import { describe, it, expect, vi } from "vitest";
import type {
  ColumnInfo,
  RoutineInfo,
  SequenceInfo,
  TableConstraintInfo,
  TableInfo,
  ViewInfo,
} from "../../adapters/types";
import type { SchemaCache } from "../schemaCache";
import type {
  CatalogForeignKeyRow,
  CatalogResolver,
  CatalogRootRow,
} from "../sqlCatalog";
import { createCatalogResolver } from "../sqlCatalog";
import {
  SqlCatalogDocumentProvider,
  buildCatalogMetadataUri,
} from "../sqlCatalogDocumentProvider";
import { SqlNavigationProvider } from "../sqlNavigationProvider";

vi.mock("vscode", () => {
  class MarkdownString {
    public value = "";
    public isTrusted = false;
    appendMarkdown(text: string): MarkdownString {
      this.value += text;
      return this;
    }
  }
  class Hover {
    public contents: MarkdownString;
    constructor(contents: MarkdownString) {
      this.contents = contents;
    }
  }
  class Uri {
    public readonly scheme: string;
    public readonly path: string;
    public readonly query: string;
    public readonly fsPath: string;
    private constructor(scheme: string, path: string, query: string) {
      this.scheme = scheme;
      this.path = path;
      this.query = query;
      this.fsPath = path;
    }
    static parse(value: string): Uri {
      const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*?)(\?.*)?$/.exec(value);
      if (!match) {
        return new Uri("file", value, "");
      }
      const [, scheme, path, query = ""] = match;
      return new Uri(scheme, path, query);
    }
    toString(): string {
      const q = this.query ? this.query : "";
      return `${this.scheme}:${this.path}${q}`;
    }
  }
  class Position {
    public readonly line: number;
    public readonly character: number;
    constructor(line: number, character: number) {
      this.line = line;
      this.character = character;
    }
  }
  class Range {
    public readonly start: Position;
    public readonly end: Position;
    constructor(start: Position, end: Position) {
      this.start = start;
      this.end = end;
    }
  }
  class Location {
    public readonly uri: Uri;
    public readonly range: Range;
    constructor(uri: Uri, range: Range) {
      this.uri = uri;
      this.range = range;
    }
  }
  return { MarkdownString, Hover, Uri, Position, Range, Location };
 });
import * as vscode from "vscode";

interface CacheMockOptions {
  hasCatalog?: boolean;
  views?: ViewInfo[];
  routines?: RoutineInfo[];
  tables?: TableInfo[];
  columns?: ColumnInfo[];
  constraints?: TableConstraintInfo[];
  sequences?: SequenceInfo[];
  objectDdl?: string;
}

function makeCacheMock(opts: CacheMockOptions): SchemaCache {
  const hasCatalog = opts.hasCatalog ?? true;
  const views = opts.views ?? [];
  const routines = opts.routines ?? [];
  const tables = opts.tables ?? [];
  const columns = opts.columns ?? [];
  const constraints = opts.constraints ?? [];
  const sequences = opts.sequences ?? [];
  const objectDdl = opts.objectDdl ?? "";

  const cache = {
    hasCatalog: vi.fn(async () => hasCatalog),
    getViews: vi.fn(async (schema?: string) =>
      schema ? views.filter((v) => v.schema === schema) : views.slice(),
    ),
    getRoutines: vi.fn(async (schema?: string) =>
      schema ? routines.filter((r) => r.schema === schema) : routines.slice(),
    ),
    getTables: vi.fn(async (schema?: string) =>
      schema ? tables.filter((t) => t.schema === schema) : tables.slice(),
    ),
    getColumns: vi.fn(async (_table: string) => columns.slice()),
    getConstraints: vi.fn(
      async (_schema: string, _table: string) => constraints.slice(),
    ),
    getSequences: vi.fn(async (schema?: string) =>
      schema ? sequences.filter((s) => s.schema === schema) : sequences.slice(),
    ),
    getObjectDdl: vi.fn(async () => objectDdl),
    invalidate: vi.fn(),
  };
  return cache as unknown as SchemaCache;
}

interface DocumentMockOptions {
  text: string;
}

function makeDoc(opts: DocumentMockOptions): vscode.TextDocument {
  const lines = opts.text.split("\n");
  return {
    languageId: "sql",
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[line] ?? "",
    }),
    getText: () => opts.text,
    positionAt: (offset: number) => {
      let cursor = 0;
      for (let i = 0; i < lines.length; i++) {
        const len = (lines[i] ?? "").length + 1;
        if (offset <= cursor + len) {
          return new vscode.Position(i, Math.max(0, offset - cursor));
        }
        cursor += len;
      }
      const last = lines.length - 1;
      return new vscode.Position(last, (lines[last] ?? "").length);
    },
  } as unknown as vscode.TextDocument;
}

interface ResolverMockOptions {
  isPostgres?: boolean;
  hasCatalog?: boolean;
  rootRows?: CatalogRootRow[];
  foreignKeys?: CatalogForeignKeyRow[];
  definition?: string;
}

interface ProviderFixture {
  cache: SchemaCache;
  resolver: CatalogResolver;
  document: SqlCatalogDocumentProvider;
  provider: SqlNavigationProvider;
}

function makeNavigationProvider(
  cacheOpts: CacheMockOptions,
  resolverOpts: ResolverMockOptions,
): ProviderFixture {
  const cache = makeCacheMock(cacheOpts);
  const resolver = createCatalogResolver(cache, {
    isPostgres: () => resolverOpts.isPostgres ?? true,
  }) as CatalogResolver & {
    getDefinition: ReturnType<typeof vi.fn>;
  };
  // createCatalogResolver builds plain methods; tests that re-stub behavior
  // (#2) need a replaceable vi.fn — wrap getDefinition so mockImplementation
  // works while the default keeps delegating to the real resolver logic.
  const defaultGetDefinition = resolver.getDefinition.bind(resolver);
  resolver.getDefinition = vi.fn(
    async (
      kind: "view" | "routine",
      schema: string,
      name: string,
    ): Promise<string | undefined> => defaultGetDefinition(kind, schema, name),
  );
  if (resolverOpts.rootRows !== undefined) {
    resolver.listRootRows = vi.fn(async () => resolverOpts.rootRows ?? []);
  }
  if (resolverOpts.foreignKeys !== undefined) {
    resolver.listForeignKeys = vi.fn(async () => resolverOpts.foreignKeys ?? []);
  } else {
    const defaultListForeignKeys = resolver.listForeignKeys.bind(resolver);
    resolver.listForeignKeys = vi.fn(async (schema, table) => defaultListForeignKeys(schema, table));
  }
  const document = new SqlCatalogDocumentProvider();
  const provider = new SqlNavigationProvider({
    cache,
    catalog: resolver,
    documentProvider: document,
  });
  return { cache, resolver, document, provider };
}

describe("SqlNavigationProvider — TASK-DBX02-003 §Test Cases", () => {
  it("#1 table/column hover names qualified token and definition URI populates metadata", async () => {
    const { provider, document, resolver } = makeNavigationProvider(
      {
        tables: [
          { name: "users", schema: "public" },
          { name: "orders", schema: "public" },
        ],
        columns: [
          { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true },
          { name: "user_id", dataType: "integer", nullable: false },
          { name: "email", dataType: "text", nullable: true },
        ],
        constraints: [
          {
            name: "orders_user_id_fkey",
            type: "fk",
            columns: ["user_id"],
            fkTarget: { schema: "public", table: "users", columns: ["id"] },
          },
        ],
        objectDdl: "CREATE TABLE public.orders (...);",
      },
      { isPostgres: true, hasCatalog: true },
    );

    const columnText = "SELECT public.orders.user_id FROM public.orders";
    const columnDoc = makeDoc({ text: columnText });
    const columnPos = new vscode.Position(0, columnText.indexOf("user_id"));
    const columnHover = await provider.provideHover(columnDoc, columnPos);
    expect(columnHover).toBeDefined();
    if (columnHover === undefined) return;
    const columnMd =
      typeof columnHover.contents === "string"
        ? columnHover.contents
        : columnHover.contents.value;
    expect(columnMd).toContain("public.orders.user_id");
    expect(columnMd).toContain("FK → public.users.id");

    const columnDef = await provider.provideDefinition(columnDoc, columnPos);
    expect(columnDef).toBeDefined();
    if (columnDef === undefined) return;
    const columnLocation = Array.isArray(columnDef) ? columnDef[0] : columnDef;
    expect(columnLocation).toBeDefined();
    const columnUri =
      columnLocation === undefined
        ? null
        : (columnLocation as { uri: vscode.Uri }).uri;
    expect(columnUri).not.toBeNull();
    if (columnUri === null) return;
    expect(columnUri.scheme).toBe("vsdb-sql-catalog");
    expect(columnUri.path).toContain("/foreignKey/");
    const columnContent = document.provideTextDocumentContent(columnUri);
    expect(columnContent).toContain("public.orders.user_id");
    expect(columnContent).toContain("FK → public.users.id");

    const tableText = "SELECT * FROM users";
    const tableDoc = makeDoc({ text: tableText });
    const tablePos = new vscode.Position(0, tableText.indexOf("users"));
    const tableHover = await provider.provideHover(tableDoc, tablePos);
    expect(tableHover).toBeDefined();
    if (tableHover === undefined) return;
    const tableMd =
      typeof tableHover.contents === "string"
        ? tableHover.contents
        : tableHover.contents.value;
    expect(tableMd).toContain("public.users");
    expect(tableMd).toContain("Columns:");
    expect(tableMd).toContain("id");

    const tableDef = await provider.provideDefinition(tableDoc, tablePos);
    expect(tableDef).toBeDefined();
    if (tableDef === undefined) return;
    const tableLocation = Array.isArray(tableDef) ? tableDef[0] : tableDef;
    expect(tableLocation).toBeDefined();
    const tableUri =
      tableLocation === undefined
        ? null
        : (tableLocation as { uri: vscode.Uri }).uri;
    expect(tableUri).not.toBeNull();
    if (tableUri === null) return;
    expect(tableUri.scheme).toBe("vsdb-sql-catalog");
    expect(tableUri.path).toContain("/table/");
    const tableContent = document.provideTextDocumentContent(tableUri);
    expect(tableContent).toContain("public.users");
    expect(tableContent).toContain("Columns:");
    expect(tableContent).not.toContain("CREATE TABLE");

    expect(resolver.listForeignKeys).toHaveBeenCalledWith("public", "orders");
  });

  it("#2 view/routine/sequence hover includes schema+kind and definition returns cached DDL or sequence metadata", async () => {
    const rootRows: CatalogRootRow[] = [
      { kind: "view", schema: "public", name: "v_orders" },
      {
        kind: "routine",
        schema: "public",
        name: "fn_total",
        routineKind: "function",
      },
      {
        kind: "sequence",
        schema: "public",
        name: "order_seq",
        dataType: "bigint",
        lastValue: "100",
      },
    ];
    const viewDdl = "CREATE VIEW public.v_orders AS SELECT 1;";
    const routineDdl = "CREATE FUNCTION public.fn_total() RETURNS int ...";
    const { provider, document, resolver } = makeNavigationProvider(
      { views: [], routines: [], sequences: [], objectDdl: "" },
      { isPostgres: true, hasCatalog: true, rootRows, definition: viewDdl },
    );
    const baseResolver = resolver.getDefinition as unknown as ReturnType<
      typeof vi.fn
    >;
    baseResolver.mockImplementation(
      async (kind: "view" | "routine", _schema: string, name: string) => {
        if (kind === "view" && name === "v_orders") return viewDdl;
        if (kind === "routine" && name === "fn_total") return routineDdl;
        return undefined;
      },
    );

    const viewText = "SELECT * FROM v_orders";
    const viewDoc = makeDoc({ text: viewText });
    const viewPos = new vscode.Position(0, viewText.indexOf("v_orders"));
    const viewHover = await provider.provideHover(viewDoc, viewPos);
    expect(viewHover).toBeDefined();
    if (viewHover === undefined) return;
    const viewMd =
      typeof viewHover.contents === "string"
        ? viewHover.contents
        : viewHover.contents.value;
    expect(viewMd).toContain("view");
    expect(viewMd).toContain("public.v_orders");

    const viewDef = await provider.provideDefinition(viewDoc, viewPos);
    expect(viewDef).toBeDefined();
    if (viewDef === undefined) return;
    const viewLocation = Array.isArray(viewDef) ? viewDef[0] : viewDef;
    expect(viewLocation).toBeDefined();
    const viewUri =
      viewLocation === undefined
        ? null
        : (viewLocation as { uri: vscode.Uri }).uri;
    expect(viewUri).not.toBeNull();
    if (viewUri === null) return;
    expect(viewUri.scheme).toBe("vsdb-sql-catalog");
    expect(viewUri.path).toContain("/view/");
    const viewContent = document.provideTextDocumentContent(viewUri);
    expect(viewContent).toBe(viewDdl);

    const routineText = "SELECT fn_total()";
    const routineDoc = makeDoc({ text: routineText });
    const routinePos = new vscode.Position(0, routineText.indexOf("fn_total"));
    const routineHover = await provider.provideHover(routineDoc, routinePos);
    expect(routineHover).toBeDefined();
    if (routineHover === undefined) return;
    const routineMd =
      typeof routineHover.contents === "string"
        ? routineHover.contents
        : routineHover.contents.value;
    expect(routineMd).toContain("function");
    expect(routineMd).toContain("public.fn_total");

    const routineDef = await provider.provideDefinition(routineDoc, routinePos);
    expect(routineDef).toBeDefined();
    if (routineDef === undefined) return;
    const routineLocation = Array.isArray(routineDef)
      ? routineDef[0]
      : routineDef;
    expect(routineLocation).toBeDefined();
    const routineUri =
      routineLocation === undefined
        ? null
        : (routineLocation as { uri: vscode.Uri }).uri;
    expect(routineUri).not.toBeNull();
    if (routineUri === null) return;
    expect(routineUri.path).toContain("/routine/");
    const routineContent = document.provideTextDocumentContent(routineUri);
    expect(routineContent).toBe(routineDdl);

    const sequenceText = "SELECT nextval('order_seq')";
    const sequenceDoc = makeDoc({ text: sequenceText });
    const sequencePos = new vscode.Position(
      0,
      sequenceText.indexOf("order_seq"),
    );
    const sequenceHover = await provider.provideHover(sequenceDoc, sequencePos);
    expect(sequenceHover).toBeDefined();
    if (sequenceHover === undefined) return;
    const sequenceMd =
      typeof sequenceHover.contents === "string"
        ? sequenceHover.contents
        : sequenceHover.contents.value;
    expect(sequenceMd).toContain("sequence");
    expect(sequenceMd).toContain("public.order_seq");
    expect(sequenceMd).toContain("bigint");

    const sequenceDef = await provider.provideDefinition(
      sequenceDoc,
      sequencePos,
    );
    expect(sequenceDef).toBeDefined();
    if (sequenceDef === undefined) return;
    const sequenceLocation = Array.isArray(sequenceDef)
      ? sequenceDef[0]
      : sequenceDef;
    expect(sequenceLocation).toBeDefined();
    const sequenceUri =
      sequenceLocation === undefined
        ? null
        : (sequenceLocation as { uri: vscode.Uri }).uri;
    expect(sequenceUri).not.toBeNull();
    if (sequenceUri === null) return;
    expect(sequenceUri.path).toContain("/sequence/");
    const sequenceContent = document.provideTextDocumentContent(sequenceUri);
    expect(sequenceContent).toContain("sequence");
    expect(sequenceContent).toContain("public.order_seq");
    expect(sequenceContent).toContain("bigint");
    expect(sequenceContent).not.toContain("CREATE");
  });

  it("#3 FK local column hover shows FK → public.users.id and definition URI identifies target table/column", async () => {
    const { provider, document } = makeNavigationProvider(
      {
        tables: [{ name: "orders", schema: "public" }],
        columns: [{ name: "user_id", dataType: "integer", nullable: false }],
        constraints: [
          {
            name: "orders_user_id_fkey",
            type: "fk",
            columns: ["user_id"],
            fkTarget: { schema: "public", table: "users", columns: ["id"] },
          },
        ],
      },
      { isPostgres: true, hasCatalog: true },
    );

    const text = "SELECT public.orders.user_id";
    const doc = makeDoc({ text });
    const pos = new vscode.Position(0, text.indexOf("user_id"));

    const hover = await provider.provideHover(doc, pos);
    expect(hover).toBeDefined();
    if (hover === undefined) return;
    const md =
      typeof hover.contents === "string" ? hover.contents : hover.contents.value;
    expect(md).toContain("FK → public.users.id");

    const def = await provider.provideDefinition(doc, pos);
    expect(def).toBeDefined();
    if (def === undefined) return;
    const loc = Array.isArray(def) ? def[0] : def;
    const uri = loc === undefined ? null : (loc as { uri: vscode.Uri }).uri;
    expect(uri).not.toBeNull();
    if (uri === null) return;
    const content = document.provideTextDocumentContent(uri);
    expect(content).toContain("public.orders.user_id");
    expect(content).toContain("public.users");
    expect(content).toContain("id");
  });

  it("#4 quoted mixed-case identifier resolves exact catalog identity; unquoted does not match it", async () => {
    const { provider } = makeNavigationProvider(
      {
        tables: [{ name: "SalesOrders", schema: "sales" }],
        columns: [
          { name: "Id", dataType: "integer", nullable: false, isPrimaryKey: true },
          { name: "Total", dataType: "numeric", nullable: false },
        ],
      },
      { isPostgres: true, hasCatalog: true },
    );

    const quotedText = 'SELECT "SalesOrders"."Id" FROM "SalesOrders"';
    const quotedDoc = makeDoc({ text: quotedText });
    const quotedHover = await provider.provideHover(
      quotedDoc,
      new vscode.Position(0, quotedText.indexOf("SalesOrders")),
    );
    expect(quotedHover).toBeDefined();
    if (quotedHover === undefined) return;
    const quotedMd =
      typeof quotedHover.contents === "string"
        ? quotedHover.contents
        : quotedHover.contents.value;
    expect(quotedMd).toContain("sales.SalesOrders");

    const unquotedText = "SELECT salesorders.id FROM salesorders";
    const unquotedDoc = makeDoc({ text: unquotedText });
    const unquotedHover = await provider.provideHover(
      unquotedDoc,
      new vscode.Position(0, unquotedText.indexOf("salesorders")),
    );
    expect(unquotedHover).toBeUndefined();
  });

  it("#5 unknown token or no catalog returns undefined with no throw", async () => {
    const nonPg = makeNavigationProvider(
      { tables: [], columns: [], constraints: [], sequences: [] },
      { isPostgres: false, hasCatalog: true },
    );
    const unknownText = "SELECT * FROM missing_table";
    const unknownDoc = makeDoc({ text: unknownText });
    const unknownPos = new vscode.Position(
      0,
      unknownText.indexOf("missing_table"),
    );
    expect(
      await nonPg.provider.provideHover(unknownDoc, unknownPos),
    ).toBeUndefined();
    expect(
      await nonPg.provider.provideDefinition(unknownDoc, unknownPos),
    ).toBeUndefined();

    const noCatalog = makeNavigationProvider(
      {
        tables: [],
        columns: [],
        constraints: [],
        sequences: [],
        hasCatalog: false,
      },
      { isPostgres: true, hasCatalog: false },
    );
    expect(
      await noCatalog.provider.provideHover(unknownDoc, unknownPos),
    ).toBeUndefined();
    expect(
      await noCatalog.provider.provideDefinition(unknownDoc, unknownPos),
    ).toBeUndefined();

    const pgKnown = makeNavigationProvider(
      { tables: [{ name: "users", schema: "public" }], columns: [] },
      { isPostgres: true, hasCatalog: true },
    );
    const knownText = "SELECT * FROM missing_table";
    const knownDoc = makeDoc({ text: knownText });
    const knownPos = new vscode.Position(
      0,
      knownText.indexOf("missing_table"),
    );
    expect(
      await pgKnown.provider.provideHover(knownDoc, knownPos),
    ).toBeUndefined();
    expect(
      await pgKnown.provider.provideDefinition(knownDoc, knownPos),
    ).toBeUndefined();

    const rootOnly = makeNavigationProvider(
      { tables: [], columns: [], constraints: [], sequences: [] },
      {
        isPostgres: true,
        hasCatalog: true,
        rootRows: [{ kind: "view", schema: "public", name: "v_orders" }],
        definition: undefined,
      },
    );
    const undefDdlText = "SELECT * FROM v_does_not_exist";
    const undefDdlDoc = makeDoc({ text: undefDdlText });
    const undefDdlPos = new vscode.Position(
      0,
      undefDdlText.indexOf("v_does_not_exist"),
    );
    expect(
      await rootOnly.provider.provideHover(undefDdlDoc, undefDdlPos),
    ).toBeUndefined();
    expect(
      await rootOnly.provider.provideDefinition(undefDdlDoc, undefDdlPos),
    ).toBeUndefined();
  });
});

describe("SqlCatalogDocumentProvider — DBX-02 contract", () => {
  it("returns empty string for unknown URIs and round-trips put() content", () => {
    const doc = new SqlCatalogDocumentProvider();
    const uri = vscode.Uri.parse("vsdb-sql-catalog:table/public.users");
    expect(doc.provideTextDocumentContent(uri)).toBe("");
    doc.put(uri, "metadata");
    expect(doc.provideTextDocumentContent(uri)).toBe("metadata");
  });

  it("buildCatalogMetadataUri encodes kind/schema/name path segments", () => {
    const uri = buildCatalogMetadataUri("view", "public", "v_orders");
    expect(uri.scheme).toBe("vsdb-sql-catalog");
    expect(uri.path).toBe("/view/public/v_orders");
  });
});
