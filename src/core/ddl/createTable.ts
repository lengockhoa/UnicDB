// src/core/ddl/createTable.ts
// TASK-001 — Pure PostgreSQL CREATE TABLE generator.
// No vscode imports, no async, no I/O. Single source of truth for the
// TableSpec contract that downstream tasks (rendering, integration tests,
// webview preview) import.

export interface ColumnSpec {
  name: string;
  type: string;
  default?: string;
  nullable?: boolean;
  comment?: string;
  originalName?: string;
  isPrimaryKey?: boolean;
}

export type KeySpec =
  | { kind: "primaryKey"; columns: string[]; name?: string }
  | { kind: "unique"; name?: string; columns: string[] }
  | { kind: "check"; name?: string; expr: string }
  | {
      kind: "foreignKey";
      name?: string;
      columns: string[];
      references: { table: string; columns: string[] };
    };

export interface TableSpec {
  name: string;
  schema: string;
  columns: ColumnSpec[];
  keys: KeySpec[];
  ifNotExists?: boolean;
}

export const UUID_DEFAULT_EXPR =
  "uuid_in(overlay(overlay(md5(random()::text || ':' || random()::text) placing '4' from 13) placing to_hex(floor(random() * (11 - 8 + 1) + 8)::int)::text from 17)::cstring)";

export const CREATED_AT_DEFAULT_EXPR =
  "TO_CHAR(date_trunc('second', now() AT TIME ZONE 'Asia/Ho_Chi_Minh'), 'YYYY-MM-DD HH24:MI:SS')::character varying";

const RESERVED: Record<string, true> = {
  order: true,
  group: true,
  table: true,
  user: true,
  select: true,
  check: true,
  primary: true,
  references: true,
  default: true,
  from: true,
  where: true,
};

// quoteIdent: quote iff empty / chars outside [a-z0-9_] / leading digit /
// in RESERVED / contains uppercase; otherwise return the bare identifier.
// This is exported for callers; the CREATE TABLE renderer wraps every
// identifier in double quotes unconditionally to match the canonical
// fixture SQL.
export function quoteIdent(name: string): string {
  if (name === "") return '""';
  if (/^[0-9]/.test(name)) return `"${name}"`;
  if (RESERVED[name.toLowerCase()] === true) return `"${name}"`;
  if (!/^[a-z0-9_]+$/.test(name)) return `"${name}"`;
  if (/[A-Z]/.test(name)) return `"${name}"`;
  return name;
}

export function defaultColumnSpecs(tableName: string): ColumnSpec[] {
  return [
    { name: `id_${tableName}`, type: "varchar", default: UUID_DEFAULT_EXPR },
    {
      name: "created_at",
      type: "varchar",
      default: CREATED_AT_DEFAULT_EXPR,
    },
  ];
}

export function generateCreateTable(spec: TableSpec): string {
  const errors = specErrors(spec);
  if (errors.length > 0) {
    throw new Error(`Invalid TableSpec: ${errors.join("; ")}`);
  }

  const tableIdent = spec.name.includes(".")
    ? spec.name.split(".").map((p) => `"${p}"`).join(".")
    : spec.schema !== ""
      ? `"${spec.schema}"."${spec.name}"`
      : `"${spec.name}"`;

  const ifNotExists = spec.ifNotExists ? "IF NOT EXISTS " : "";
  const lines: string[] = [];

  for (const col of spec.columns) {
    const parts: string[] = [`"${col.name}" ${col.type}`];
    if (col.nullable === false) parts.push("NOT NULL");
    if (col.default !== undefined && col.default !== "") {
      const trimmed = col.default.trim();
      parts.push(`DEFAULT ${trimmed}`);
    }
    if (col.isPrimaryKey) parts.push("PRIMARY KEY");
    lines.push("    " + parts.join(" "));
  }

  for (const key of spec.keys) {
    if (key.kind === "primaryKey") {
      const cols = key.columns.map((c) => `"${c}"`).join(",");
      const prefix =
        key.name !== undefined
          ? `    CONSTRAINT "${key.name}" PRIMARY KEY`
          : `    PRIMARY KEY`;
      lines.push(`${prefix} (${cols})`);
    } else if (key.kind === "unique") {
      const autoName = `${spec.name}_${key.columns.join("_")}_key`.slice(0, 63);
      const name = key.name ?? autoName;
      const cols = key.columns.map((c) => `"${c}"`).join(",");
      lines.push(`    CONSTRAINT "${name}" UNIQUE (${cols})`);
    } else if (key.kind === "check") {
      const autoName = `${spec.name}_check`.slice(0, 63);
      const name = key.name ?? autoName;
      lines.push(`    CONSTRAINT "${name}" CHECK (${key.expr})`);
    } else if (key.kind === "foreignKey") {
      const autoName = `${spec.name}_${key.columns.join("_")}_key`.slice(0, 63);
      const name = key.name ?? autoName;
      const cols = key.columns.map((c) => `"${c}"`).join(",");
      const refSchema = spec.schema;
      const refTable = key.references.table.includes(".")
        ? key.references.table.split(".").map((p) => `"${p}"`).join(".")
        : refSchema !== ""
          ? `"${refSchema}"."${key.references.table}"`
          : `"${key.references.table}"`;
      const refCols = key.references.columns.map((c) => `"${c}"`).join(",");
      lines.push(
        `    CONSTRAINT "${name}" FOREIGN KEY (${cols}) REFERENCES ${refTable} (${refCols})`,
      );
    }
  }

  return (
    `CREATE TABLE ${ifNotExists}${tableIdent} (\n` +
    lines.join(",\n") +
    "\n);\n"
  );
}

export function specErrors(spec: TableSpec): string[] {
  const errors: string[] = [];
  if (!spec.name || spec.name.trim() === "") {
    errors.push("Table name is required");
  }
  const seen: Record<string, true> = {};
  for (const col of spec.columns) {
    if (!col.name || col.name.trim() === "") {
      errors.push("Column name is required");
    } else if (seen[col.name] === true) {
      errors.push(`Duplicate column name: ${col.name}`);
    } else {
      seen[col.name] = true;
    }
    if (!col.type || col.type.trim() === "") {
      errors.push(`Column type is required: ${col.name || "(unnamed)"}`);
    }
  }
  const columnNames: Record<string, true> = {};
  for (const c of spec.columns) columnNames[c.name] = true;
  for (const key of spec.keys) {
    if (
      key.kind === "primaryKey" ||
      key.kind === "unique" ||
      key.kind === "foreignKey"
    ) {
      if (key.kind === "foreignKey" && key.references.columns.length === 0) {
        errors.push("FK must reference at least one column");
      }
      for (const c of key.columns) {
        if (columnNames[c] !== true) {
          errors.push(`Key references unknown column: ${c}`);
        }
      }
    } else if (key.kind === "check") {
      if (!key.expr || key.expr.trim() === "") {
        errors.push("Check expression is required");
      }
    }
  }
  return errors;
}