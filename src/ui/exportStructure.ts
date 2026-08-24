// src/ui/exportStructure.ts
// Export Structure — render CREATE TABLE DDL string cho table/view node,
// copy vào clipboard (pattern TASK-008 postmanPayload: pure builder + command
// trong tableCommands + context menu table/view).
//
// Nguồn dữ liệu: adapter.listColumns (name/dataType/nullable/isPrimaryKey).
// PK đánh dấu qua column_default không có → dùng ColumnInfo.isPrimaryKey trên
// mỗi cột; nếu ≥1 cột có isPrimaryKey thì emit CONSTRAINT ... PRIMARY KEY (...)
// dòng cuối, else mỗi cột NOT NULL giữ nguyên nullable flag.

/** Escape ' inside COMMENT-style string literals. */
function sqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Reserved keywords phải quote kể cả khi toàn chữ thường (SELECT, ORDER...).
 * Tối thiểu theo PGreserved thông dụng — đủ cho DDL emit an toàn.
 */
const SQL_RESERVED: Record<string, true> = {
  select: true, from: true, where: true, order: true, group: true, having: true,
  limit: true, offset: true, insert: true, update: true, delete: true,
  table: true, view: true, index: true, primary: true, foreign: true,
  references: true, constraint: true, default: true, null: true, true: true,
  false: true, not: true, and: true, or: true, in: true, is: true, as: true,
  on: true, join: true, inner: true, left: true, right: true, outer: true,
  full: true, cross: true, union: true, all: true, distinct: true, case: true,
  when: true, then: true, else: true, end: true, create: true, drop: true,
  alter: true, add: true, column: true, check: true, unique: true, values: true,
  into: true, set: true, user: true, grant: true, revoke: true, begin: true,
  commit: true, rollback: true, with: true, recursive: true, using: true,
  cast: true, collate: true, desc: true, asc: true, between: true, exists: true,
};

/** Quote identifier khi không phải chữ thường thường gặp [a-z_][a-z0-9_]*. */
export function quoteIdentIfNeeded(name: string): string {
  if (SQL_RESERVED[name]) return `"${name.replace(/"/g, '""')}"`;
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export interface ExportColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
}

/**
 * Build CREATE TABLE DDL cho bảng (thuần data → string, không I/O).
 * View node: chỉ trả header CREATE VIEW ... AS SELECT ...; -- columns list
 * (definition column không có trong ColumnInfo — ghi chú estruct limitation).
 */
export function buildTableStructure(
  schema: string,
  table: string,
  columns: ExportColumn[],
): string {
  const q = quoteIdentIfNeeded;
  const lines: string[] = [`CREATE TABLE ${q(schema)}.${q(table)} (`];
  const body = columns.map((c) => {
    let line = `    ${q(c.name)} ${c.dataType}`;
    if (!c.nullable) line += " NOT NULL";
    return line;
  });
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name));
  if (pk.length > 0) {
    body.push(`    CONSTRAINT ${q(`pk_${table}`)} PRIMARY KEY (${pk.join(", ")})`);
  }
  lines.push(body.join(",\n"));
  lines.push(");");
  return lines.join("\n");
}

/** Build structure text cho view node (column list + note). */
export function buildViewStructure(
  schema: string,
  view: string,
  columns: ExportColumn[],
): string {
  const q = quoteIdentIfNeeded;
  const cols = columns.map((c) => `    ${q(c.name)} ${c.dataType}`).join(",\n");
  return [
    `-- View structure: ${q(schema)}.${q(view)}`,
    `-- Output columns (${columns.length}):`,
    cols,
    `-- CREATE VIEW definition requires pg_get_viewdef — not in ColumnInfo.`,
  ].join("\n");
}

/** Input shape cho buildDatabaseStructure — agent tool builds from adapter results. */
export interface DatabaseStructureInput {
  schemas: Array<{ name: string }>;
  tables: Array<{ schema: string; name: string }>;
  views: Array<{ schema: string; name: string }>;
  /** Key "schema.table" → column list cho table/view. Missing key → empty columns. */
  columns: Record<string, ExportColumn[]>;
}

/**
 * Render full-DB DDL text từ introspection results.
 * Pure, deterministic. Empty DB → header only, không schema/table blocks.
 * Blocks cách nhau bằng 1 blank line; trailing blanks stripped.
 */
export function buildDatabaseStructure(db: DatabaseStructureInput): string {
  const header = `-- Database structure (${db.schemas.length} schemas, ${db.tables.length} tables, ${db.views.length} views)`;
  if (db.schemas.length === 0) return header;

  const blocks: string[] = [];
  for (const s of db.schemas) {
    blocks.push(`-- Schema: ${s.name}`);
    for (const t of db.tables.filter((x) => x.schema === s.name)) {
      const key = `${t.schema}.${t.name}`;
      blocks.push(buildTableStructure(t.schema, t.name, db.columns[key] ?? []));
      blocks.push("");
    }
    for (const v of db.views.filter((x) => x.schema === s.name)) {
      const key = `${v.schema}.${v.name}`;
      blocks.push(buildViewStructure(v.schema, v.name, db.columns[key] ?? []));
      blocks.push("");
    }
  }

  while (blocks.length > 0 && blocks[blocks.length - 1] === "") blocks.pop();
  return [header, ...blocks].join("\n");
}

export { sqlLiteral };
