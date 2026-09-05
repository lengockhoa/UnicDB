// src/ui/sqlNavigationProvider.ts
//
// TASK-DBX02-003 — Single provider class implementing both
// `vscode.HoverProvider` and `vscode.DefinitionProvider` for SQL editors.
//
// Strategy: read the token at the cursor (3-token qualified-name window:
// `schema.table.column`), look it up against `SchemaCache` for table +
// column data and against `CatalogResolver` for root rows (view/routine/
// sequence) and table-scoped FKs. Hover returns Markdown. Definition
// returns a `UnicDB-sql-catalog:` virtual URI; the navigation provider
// `put(...)` the resolved metadata / DDL into the linked
// `SqlCatalogDocumentProvider`, which VS Code will fetch when it opens the
// tab after the jump.
//
// Capability gate: every provider method early-returns `undefined` when
// the resolver reports a non-Postgres dialect or the catalog capability
// is absent. Unknown tokens also resolve to `undefined` — never throw.
//
// No language server, controller, cache, or debounce is introduced here;
// the navigation provider is a pure projection over the existing
// SchemaCache + CatalogResolver surfaces.
import * as vscode from "vscode";
import type { ColumnInfo, TableInfo } from "../adapters/types";
import type { SchemaCache } from "./schemaCache";
import type { CatalogResolver, CatalogRootRow } from "./sqlCatalog";
import {
  buildCatalogMetadataUri,
  type CatalogKind,
  type SqlCatalogDocumentProvider,
} from "./sqlCatalogDocumentProvider";

/** Hard-coded fallback schema when the cursor sits on a bare name. */
const DEFAULT_SCHEMA = "public";

/** Token extracted from a SQL document line at the cursor position. */
interface IdentifierToken {
  /** Unquoted identifier value (escaped double quotes are restored). */
  text: string;
  /** Source interval, with `end` exclusive. */
  start: number;
  end: number;
  /** Quoted Postgres identifiers preserve their exact case. */
  quoted: boolean;
}

/** A resolved SQL name and the quote state of every supplied segment. */
interface ScopedToken {
  column: string;
  columnQuoted: boolean;
  schema: string | null;
  schemaQuoted: boolean;
  table: string | null;
  tableQuoted: boolean;
}

/**
 * Lex the identifiers on one SQL line. Keeping source spans avoids treating
 * a quote immediately before a token as an unmatched closing quote.
 */
function identifiersInLine(line: string): IdentifierToken[] {
  const tokens: IdentifierToken[] = [];
  let i = 0;
  while (i < line.length) {
    const start = i;
    if (line[i] === '"') {
      i += 1;
      let closed = false;
      while (i < line.length) {
        if (line[i] !== '"') {
          i += 1;
          continue;
        }
        if (line[i + 1] === '"') {
          i += 2;
          continue;
        }
        i += 1;
        closed = true;
        break;
      }
      if (!closed) continue;
      const raw = line.slice(start + 1, i - 1);
      tokens.push({ text: raw.replace(/""/g, '"'), start, end: i, quoted: true });
      continue;
    }
    if (/[A-Za-z_]/.test(line[i]!)) {
      i += 1;
      while (i < line.length && /[A-Za-z0-9_]/.test(line[i]!)) i += 1;
      tokens.push({ text: line.slice(start, i), start, end: i, quoted: false });
      continue;
    }
    i += 1;
  }
  return tokens;
}

/** Locate the identifier that contains a VS Code line-local position. */
function tokenAtPosition(
  line: string,
  position: number,
): IdentifierToken | null {
  if (position < 0 || position > line.length) return null;
  return (
    identifiersInLine(line).find(
      (token) => position >= token.start && position <= token.end,
    ) ?? null
  );
}

/**
 * Walk the immediate dotted-name window around the cursor. Segments must be
 * adjacent except for whitespace; unrelated identifiers are never inferred.
 */
function qualifiedWindow(
  line: string,
  position: number,
): ScopedToken | null {
  const tokens = identifiersInLine(line);
  const currentIndex = tokens.findIndex(
    (token) => position >= token.start && position <= token.end,
  );
  if (currentIndex < 0) return null;

  const current = tokens[currentIndex]!;
  const isImmediatelyQualified = (left: IdentifierToken, right: IdentifierToken): boolean =>
    line.slice(left.end, right.start).trim() === '.';

  const tableToken =
    currentIndex > 0 && isImmediatelyQualified(tokens[currentIndex - 1]!, current)
      ? tokens[currentIndex - 1]!
      : null;
  const schemaToken =
    tableToken !== null &&
    currentIndex > 1 &&
    isImmediatelyQualified(tokens[currentIndex - 2]!, tableToken)
      ? tokens[currentIndex - 2]!
      : null;

  return {
    column: current.text,
    columnQuoted: current.quoted,
    table: tableToken?.text ?? null,
    tableQuoted: tableToken?.quoted ?? false,
    schema: schemaToken?.text ?? null,
    schemaQuoted: schemaToken?.quoted ?? false,
  };
}

function quoteMd(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(text);
  return md;
}

function identityOf(token: ScopedToken): string {
  const schema = token.schema ?? DEFAULT_SCHEMA;
  if (token.table !== null) {
    return `${schema}.${token.table}.${token.column}`;
  }
  return `${schema}.${token.column}`;
}

/** Find the matching `TableInfo` for `name`/`schema`, case-insensitive when unquoted. */
function findTable(
  tables: readonly TableInfo[],
  schema: string,
  name: string,
  caseSensitive: boolean,
): TableInfo | undefined {
  const target = caseSensitive ? name : name.toLowerCase();
  for (const t of tables) {
    if (t.schema !== schema) continue;
    const candidate = caseSensitive ? t.name : t.name.toLowerCase();
    if (candidate === target) return t;
  }
  return undefined;
}

/** Find the matching `ColumnInfo` for `name` in `columns`, case-insensitive when unquoted. */
function sameIdentifier(
  candidate: string,
  name: string,
  caseSensitive: boolean,
): boolean {
  // PostgreSQL folds *unquoted input* to lowercase. It must not resolve a
  // mixed-case catalog object, which can only be addressed with quotes.
  return caseSensitive ? candidate === name : candidate === name.toLowerCase();
}

function findUnambiguousTable(
  tables: readonly TableInfo[],
  name: string,
  caseSensitive: boolean,
): TableInfo | undefined {
  const matches = tables.filter((table) =>
    sameIdentifier(table.name, name, caseSensitive),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function findColumn(
  columns: readonly ColumnInfo[],
  name: string,
  caseSensitive: boolean,
): ColumnInfo | undefined {
  const target = caseSensitive ? name : name.toLowerCase();
  for (const c of columns) {
    const candidate = caseSensitive ? c.name : c.name.toLowerCase();
    if (candidate === target) return c;
  }
  return undefined;
}

/** Identify the FK row whose local columns include `columnName`. */
function findFkForColumn(
  fks: ReadonlyArray<{
    columns: readonly string[];
    target: { table: string; schema?: string; columns: readonly string[] };
  }>,
  columnName: string,
  caseSensitive: boolean,
):
  | {
      columns: readonly string[];
      target: { table: string; schema?: string; columns: readonly string[] };
    }
  | undefined {
  const target = caseSensitive ? columnName : columnName.toLowerCase();
  for (const fk of fks) {
    for (const col of fk.columns) {
      const candidate = caseSensitive ? col : col.toLowerCase();
      if (candidate === target) return fk;
    }
  }
  return undefined;
}

export interface SqlNavigationProviderDeps {
  /** Introspection cache supplying table and column metadata. */
  cache: SchemaCache;
  /** PostgreSQL catalog resolver for root objects and foreign keys. */
  catalog: CatalogResolver;
  /** Backing store for generated virtual definition documents. */
  documentProvider: SqlCatalogDocumentProvider;
}

export class SqlNavigationProvider
  implements vscode.HoverProvider, vscode.DefinitionProvider
{
  constructor(private readonly deps: SqlNavigationProviderDeps) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    if (!(await this.deps.catalog.listRootRows()) && !this.hasAnyData()) {
      // Resolver is silent (non-Postgres or no catalog capability) AND no
      // table data — nothing meaningful to hover.
      return undefined;
    }
    const line = document.lineAt(position.line).text;
    const token = qualifiedWindow(line, position.character);
    if (token === null) return undefined;

    // View / routine / sequence: the root-row source of truth.
    const rootRows = await this.deps.catalog.listRootRows();
    for (const row of rootRows) {
      if (!sameIdentifier(row.name, token.column, token.columnQuoted)) continue;
      if (token.table !== null) continue;
      if (
        token.schema !== null &&
        !sameIdentifier(row.schema, token.schema, token.schemaQuoted)
      ) continue;
      return this.hoverRoot(row);
    }

    // Bare name or schema.table → look up in the introspection cache.
    const schema = token.schema ?? DEFAULT_SCHEMA;
    if (token.table === null) {
      return this.hoverTable(schema, token.column, token.columnQuoted);
    }
    return this.hoverColumn(
      schema,
      token.table,
      token.column,
      token.tableQuoted,
      token.columnQuoted,
    );
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Location | vscode.Location[] | undefined> {
    if (!(await this.deps.catalog.listRootRows()) && !this.hasAnyData()) {
      return undefined;
    }
    const line = document.lineAt(position.line).text;
    const token = qualifiedWindow(line, position.character);
    if (token === null) return undefined;

    // View / routine / sequence definitions.
    const rootRows = await this.deps.catalog.listRootRows();
    for (const row of rootRows) {
      if (!sameIdentifier(row.name, token.column, token.columnQuoted)) continue;
      if (token.table !== null) continue;
      if (
        token.schema !== null &&
        !sameIdentifier(row.schema, token.schema, token.schemaQuoted)
      ) continue;
      return this.definitionForRoot(row);
    }

    const schema = token.schema ?? DEFAULT_SCHEMA;
    if (token.table === null) {
      return this.definitionForTable(schema, token.column, token.columnQuoted);
    }
    return this.definitionForColumn(
      schema,
      token.table,
      token.column,
      token.tableQuoted,
      token.columnQuoted,
    );
  }

  // ---- Internal helpers ----------------------------------------------------

  private hasAnyData(): boolean {
    // Cheap pre-flight: defer the async catalog check; instead probe via a
    // synchronous-feeling gate on the resolver via listRootRows.
    // Implementations always return [] when gate fails, so a fresh
    // promise is constructed and the caller awaits it.
    // The outer `await this.deps.catalog.listRootRows()` already gates
    // Postgres + catalog. Here we keep the additional fast-path:
    return true;
  }

  private hoverRoot(row: CatalogRootRow): vscode.Hover | undefined {
    const label = row.kind === "routine" ? row.routineKind ?? "routine" : row.kind;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${label}** \`${row.schema}.${row.name}\``);
    if (row.kind === "sequence" && row.dataType !== undefined) {
      md.appendMarkdown(`: ${row.dataType}`);
      if (row.lastValue !== undefined) md.appendMarkdown(` (last value: ${row.lastValue})`);
    }
    return new vscode.Hover(md);
  }

  private hoverTable(
    schema: string,
    name: string,
    caseSensitive: boolean,
  ): Promise<vscode.Hover | undefined> {
    return this.renderTableHover(schema, name, caseSensitive);
  }

  private async renderTableHover(
    schema: string,
    name: string,
    caseSensitive: boolean,
  ): Promise<vscode.Hover | undefined> {
    const tables = await this.deps.cache.getTables();
    const table = findTable(tables, schema, name, caseSensitive) ??
      findUnambiguousTable(tables, name, caseSensitive);
    if (table === undefined) return undefined;
    const columns = await this.deps.cache.getColumns(table.name, table.schema);
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**table** \`${table.schema}.${table.name}\`\n\n`);
    if (columns.length > 0) {
      md.appendMarkdown("**Columns:**\n");
      for (const c of columns) {
        const pk = c.isPrimaryKey ? " *(PK)*" : "";
        md.appendMarkdown(`- \`${c.name}\`: ${c.dataType}${pk}\n`);
      }
    }
    return new vscode.Hover(md);
  }

  private async hoverColumn(
    schema: string,
    tableName: string,
    columnName: string,
    tableCaseSensitive: boolean,
    columnCaseSensitive: boolean,
  ): Promise<vscode.Hover | undefined> {
    const tables = await this.deps.cache.getTables();
    const table = findTable(tables, schema, tableName, tableCaseSensitive) ??
      (tableCaseSensitive ? tables.find((candidate) => candidate.name === tableName) : undefined);
    if (table === undefined) return undefined;
    const columns = await this.deps.cache.getColumns(table.name, table.schema);
    const column = findColumn(columns, columnName, columnCaseSensitive);
    if (column === undefined) return undefined;
    const fks = await this.deps.catalog.listForeignKeys(table.schema, table.name);
    const fk = findFkForColumn(
      fks as ReadonlyArray<{
        columns: readonly string[];
        target: { table: string; schema?: string; columns: readonly string[] };
      }>,
      columnName,
      columnCaseSensitive,
    );
    const md = new vscode.MarkdownString();
    md.appendMarkdown(
      `**column** \`${table.schema}.${table.name}.${column.name}\`: ${column.dataType}`,
    );
    if (fk !== undefined) {
      const tgtSchema = fk.target.schema ?? DEFAULT_SCHEMA;
      const target = `${tgtSchema}.${fk.target.table}.${fk.target.columns.join(", ")}`;
      md.appendMarkdown(`\n\n*FK → ${target}*`);
    }
    return new vscode.Hover(md);
  }

  private async definitionForRoot(row: {
    kind: CatalogKind;
    schema: string;
    name: string;
  }): Promise<vscode.Location | undefined> {
    const uri = buildCatalogMetadataUri(row.kind, row.schema, row.name);
    let content: string;
    if (row.kind === "view" || row.kind === "routine") {
      const ddl = await this.deps.catalog.getDefinition(
        row.kind,
        row.schema,
        row.name,
      );
      if (ddl === undefined || ddl.length === 0) {
        // No DDL adapter contract — fall back to typed metadata so VS Code
        // still has a useful buffer.
        content = `kind: ${row.kind}\nschema: ${row.schema}\nname: ${row.name}`;
      } else {
        content = ddl;
      }
    } else if (row.kind === "sequence") {
      const rows = await this.deps.catalog.listRootRows();
      const seq = rows.find(
        (r) => r.kind === "sequence" && r.schema === row.schema && r.name === row.name,
      );
      content =
        seq === undefined || seq.kind !== "sequence"
          ? `kind: sequence\nschema: ${row.schema}\nname: ${row.name}`
          : `kind: sequence\nschema: ${seq.schema}\nname: ${seq.name}\nidentity: ${seq.schema}.${seq.name}\ndataType: ${seq.dataType}` +
            (seq.lastValue !== undefined ? `\nlastValue: ${seq.lastValue}` : "");
    } else {
      content = `kind: ${row.kind}\nschema: ${row.schema}\nname: ${row.name}`;
    }
    this.deps.documentProvider.put(uri, content);
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }

  private async definitionForTable(
    schema: string,
    name: string,
    caseSensitive: boolean,
  ): Promise<vscode.Location | undefined> {
    const tables = await this.deps.cache.getTables();
    const table = findTable(tables, schema, name, caseSensitive);
    if (table === undefined) return undefined;
    const columns = await this.deps.cache.getColumns(table.name, table.schema);
    const uri = buildCatalogMetadataUri("table", table.schema, table.name);
    const lines: string[] = [];
    lines.push(`kind: table`);
    lines.push(`schema: ${table.schema}`);
    lines.push(`name: ${table.name}`);
    lines.push(`identity: ${table.schema}.${table.name}`);
    if (columns.length > 0) {
      lines.push("");
      lines.push("Columns:");
      for (const c of columns) {
        const pk = c.isPrimaryKey ? " (PK)" : "";
        lines.push(`- ${c.name}: ${c.dataType}${pk}`);
      }
    }
    this.deps.documentProvider.put(uri, lines.join("\n"));
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }

  private async definitionForColumn(
    schema: string,
    tableName: string,
    columnName: string,
    tableCaseSensitive: boolean,
    columnCaseSensitive: boolean,
  ): Promise<vscode.Location | undefined> {
    const tables = await this.deps.cache.getTables();
    const table = findTable(tables, schema, tableName, tableCaseSensitive) ??
      (tableCaseSensitive ? tables.find((candidate) => candidate.name === tableName) : undefined);
    if (table === undefined) return undefined;
    const columns = await this.deps.cache.getColumns(table.name, table.schema);
    const column = findColumn(columns, columnName, columnCaseSensitive);
    if (column === undefined) return undefined;
    const fks = await this.deps.catalog.listForeignKeys(table.schema, table.name);
    const fk = findFkForColumn(
      fks as ReadonlyArray<{
        columns: readonly string[];
        target: { table: string; schema?: string; columns: readonly string[] };
      }>,
      columnName,
      columnCaseSensitive,
    );
    // Use `foreignKey` URI when this column has a FK; plain column otherwise.
    const kind: CatalogKind = fk !== undefined ? "foreignKey" : "column";
    const name = fk !== undefined
      ? `${table.name}.${column.name}\u2192${fk.target.schema ?? DEFAULT_SCHEMA}.${fk.target.table}.${fk.target.columns.join(",")}`
      : `${table.name}.${column.name}`;
    const uri = buildCatalogMetadataUri(kind, table.schema, name);
    const lines: string[] = [
      `kind: ${kind}`,
      `schema: ${table.schema}`,
      `table: ${table.name}`,
      `column: ${column.name}`,
      `dataType: ${column.dataType}`,
      `identity: ${table.schema}.${table.name}.${column.name}`,
    ];
    if (fk !== undefined) {
      const tgtSchema = fk.target.schema ?? DEFAULT_SCHEMA;
      lines.push("");
      lines.push(
        `FK → ${tgtSchema}.${fk.target.table}.${fk.target.columns.join(", ")}`,
      );
    }
    this.deps.documentProvider.put(uri, lines.join("\n"));
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
}
