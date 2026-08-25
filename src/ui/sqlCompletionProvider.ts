// src/ui/sqlCompletionProvider.ts
// TASK-008 — CompletionItemProvider cho SQL, fed bởi SchemaCache.
//
// Logic trigger (chỉ nhìn text TRƯỚC cursor trên dòng hiện tại):
//   - `<identifier>.` → nếu identifier trùng tên table (search all tables)
//     → columns của table đó (Property kind); ngược lại coi identifier là
//     schema → tables trong schema đó (Class kind).
//   - `<prefix>` (identifier đang gõ) → schemas (Module kind) + tables
//     (Class kind) + SQL keywords (Keyword kind), lọc theo prefix.
//   - Không có active connection, hoặc adapter lỗi → [] (never-crash;
//     VS Code vẫn có word-based suggestions cơ bản).
import * as vscode from "vscode";
import type { SchemaCache } from "./schemaCache";

/** SQL keywords offering ở root context (filtered by prefix). */
export const SQL_KEYWORDS: readonly string[] = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "AS",
  "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS",
  "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET", "INSERT", "INTO",
  "VALUES", "UPDATE", "SET", "DELETE", "TRUNCATE", "CREATE", "TABLE",
  "VIEW", "INDEX", "ALTER", "DROP", "ADD", "COLUMN", "PRIMARY", "KEY",
  "FOREIGN", "REFERENCES", "DEFAULT", "DISTINCT", "UNION", "ALL",
  "EXISTS", "BETWEEN", "LIKE", "ILIKE", "ASC", "DESC", "COUNT", "SUM",
  "AVG", "MIN", "MAX", "CASE", "WHEN", "THEN", "ELSE", "END", "BEGIN",
  "COMMIT", "ROLLBACK", "WITH", "RETURNING", "CAST", "COALESCE",
  "EXPLAIN", "ANALYZE", "VACUUM", "GRANT", "REVOKE",
];

export interface SqlCompletionProviderDeps {
  /** Cache (TTL) wrapping adapter introspection. */
  cache: SchemaCache;
  /** False khi không có active connection → provider im lặng ([]). */
  hasConnection?: () => boolean;
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly deps: SqlCompletionProviderDeps) {}

  /**
   * (document, position) là 2 tham số thực sự dùng — token/context không
   * cần cho completion tĩnh từ cache (VS Code truyền thêm cũng bỏ qua).
   */
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    try {
      if (this.deps.hasConnection && !this.deps.hasConnection()) return [];
      const lineBefore = document
        .lineAt(position.line)
        .text.slice(0, position.character);

      const dotMatch = /([A-Za-z_][\w$]*)\s*\.\s*$/.exec(lineBefore);
      if (dotMatch) {
        return await this.completionsAfterDot(dotMatch[1]!);
      }

      const prefixMatch = /([A-Za-z_][\w$]*)$/.exec(lineBefore);
      const prefix = prefixMatch ? prefixMatch[1]! : "";
      return await this.rootCompletions(prefix);
    } catch {
      // Completion phải never-crash — mọi lỗi → im lặng.
      return [];
    }
  }

  // ---- Private ---------------------------------------------------------------

  /** `<word>.` — word là table → columns; ngược lại là schema → tables. */
  private async completionsAfterDot(
    word: string,
  ): Promise<vscode.CompletionItem[]> {
    const lower = word.toLowerCase();
    const tables = await this.deps.cache.getTables();
    const hit = tables.find((t) => t.name.toLowerCase() === lower);
    if (hit) {
      const columns = await this.deps.cache.getColumns(hit.name, hit.schema);
      return columns.map((c) => {
        const item = new vscode.CompletionItem(
          c.name,
          vscode.CompletionItemKind.Property,
        );
        item.detail = c.dataType;
        return item;
      });
    }
    const schemaTables = await this.deps.cache.getTables(word);
    return schemaTables.map((t) => {
      const item = new vscode.CompletionItem(
        t.name,
        vscode.CompletionItemKind.Class,
      );
      item.detail = t.schema;
      return item;
    });
  }

  /** Root context — schemas + tables + keywords, prefix-filtered. */
  private async rootCompletions(
    prefix: string,
  ): Promise<vscode.CompletionItem[]> {
    const [schemas, tables] = await Promise.all([
      this.deps.cache.getSchemas(),
      this.deps.cache.getTables(),
    ]);
    const lowerPrefix = prefix.toLowerCase();
    const matches = (label: string): boolean =>
      label.toLowerCase().startsWith(lowerPrefix);

    const items: vscode.CompletionItem[] = [];
    for (const s of schemas) {
      if (!matches(s.name)) continue;
      const item = new vscode.CompletionItem(
        s.name,
        vscode.CompletionItemKind.Module,
      );
      items.push(item);
    }
    for (const t of tables) {
      if (!matches(t.name)) continue;
      const item = new vscode.CompletionItem(
        t.name,
        vscode.CompletionItemKind.Class,
      );
      item.detail = t.schema;
      items.push(item);
    }
    for (const kw of SQL_KEYWORDS) {
      if (!matches(kw)) continue;
      items.push(
        new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword),
      );
    }
    return items;
  }
}
