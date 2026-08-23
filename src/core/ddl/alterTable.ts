// src/core/ddl/alterTable.ts
// Pure ALTER TABLE diff engine — TASK-003.
//
// Pure: no vscode, no I/O, no Date, no random. Types + specErrors come from
// ./createTable (TASK-001 canonical). Rendering helpers are local because
// ALTER output always double-quotes identifiers.
//
// Compares before → after TableSpecs and emits ordered PostgreSQL ALTER
// statements. Renames are detected via ColumnSpec.originalName so the engine
// never emits DROP+ADD for a renamed column.

import type { TableSpec, ColumnSpec, KeySpec } from "./createTable";
import { specErrors } from "./createTable";

// Local rendering helpers (always-quote style).

/**
 * Always-quote identifier (double-quote, escape inner quotes). Rendering in
 * ALTER statements always quotes, unlike createTable's conditional quoteIdent.
 */
export function alwaysQuote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTableRef(schema: string, name: string): string {
  const qSchema = schema === "" ? "" : alwaysQuote(schema);
  const qName = alwaysQuote(name);
  if (qSchema === "") return qName;
  return `${qSchema}.${qName}`;
}


// ===========================================================================
// normalizeDefaultExpr
// ===========================================================================

/**
 * Normalize a default expression for equality comparison:
 *  - trim
 *  - remove ALL whitespace inside
 *  - strip ONE outer paren layer if it wraps the whole expression
 *
 * Examples:
 *   "(now())" → "now()"
 *   "'x'"     === "('x')"
 *   "a+b"     === "a + b"
 *
 * Used purely for comparing two defaults to avoid spurious SET DEFAULT
 * statements in diffs.
 */
export function normalizeDefaultExpr(expr: string): string {
  let s = expr.trim();
  // Remove all whitespace.
  s = s.replace(/\s+/g, "");
  // Strip ONE outer paren layer (when wrapping the entire expression).
  if (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    let depth = 0;
    let matched = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0 && i === s.length - 1) {
          matched = true;
        }
        if (depth === 0 && i < s.length - 1) break;
      }
    }
    if (matched) {
      s = s.slice(1, -1);
    }
  }
  return s;
}

// ===========================================================================
// AlterPlan + diffTable
// ===========================================================================

export interface AlterPlan {
  statements: string[];
  errors: string[];
}

// ---------------- column pairing ------------------------------------------

interface ColumnPair {
  /** True when this is a rename (after.name !== before.name). */
  renamed: boolean;
  beforeName: string;
  after: ColumnSpec;
}

/**
 * Pair after-columns with before-columns:
 *
 *  1. If after.originalName is non-empty and matches a before-column's name,
 *     they pair (possibly renamed to after.name).
 *  2. Else (no originalName set), pair by equal name when the before-column
 *     hasn't already been paired. This keeps "reorder-only" and "identical"
 *     specs diff-free.
 *
 * After-columns that don't pair → NEW (ADD COLUMN).
 * Before-columns that don't pair → DROPPED (DROP COLUMN).
 */
function pairColumns(
  before: TableSpec,
  after: TableSpec,
): { pairs: ColumnPair[]; newColumns: ColumnSpec[]; dropNames: string[] } {
  const beforeByName = new Map<string, ColumnSpec>();
  for (const c of before.columns) beforeByName.set(c.name, c);

  const pairs: ColumnPair[] = [];
  const newColumns: ColumnSpec[] = [];
  const used = new Set<string>();

  // First pass: pair by originalName (explicit rename marker).
  for (const a of after.columns) {
    const orig = a.originalName;
    if (orig && orig !== "" && beforeByName.has(orig)) {
      used.add(orig);
      pairs.push({
        renamed: a.name !== orig,
        beforeName: orig,
        after: a,
      });
    }
  }
  // Second pass: remaining unmatched after-columns pair by name when possible.
  for (const a of after.columns) {
    if (pairs.some((p) => p.after === a)) continue;
    const orig = a.originalName;
    if (orig && orig !== "" && beforeByName.has(orig)) continue;
    if (beforeByName.has(a.name) && !used.has(a.name)) {
      used.add(a.name);
      pairs.push({
        renamed: false,
        beforeName: a.name,
        after: a,
      });
    } else {
      newColumns.push(a);
    }
  }

  const dropNames: string[] = [];
  for (const b of before.columns) {
    if (!used.has(b.name)) dropNames.push(b.name);
  }

  return { pairs, newColumns, dropNames };
}

// ---------------- key identity ---------------------------------------------

/**
 * Whether key k1 from before equals key k2 from after under identity rules:
 *  - name match when both named
 *  - else kind + columns.join(",") (+ normalized expr for check).
 */
function keysMatchIdentity(before: KeySpec, after: KeySpec): boolean {
  if (before.kind !== after.kind) return false;
  if (before.kind === "primaryKey" && after.kind === "primaryKey") {
    return before.columns.join(",") === after.columns.join(",");
  }
  if (before.kind === "unique" && after.kind === "unique") {
    if (before.name && after.name) return before.name === after.name;
    return before.columns.join(",") === after.columns.join(",");
  }
  if (before.kind === "check" && after.kind === "check") {
    if (before.name && after.name) return before.name === after.name;
    return (
      normalizeDefaultExpr(before.expr) ===
      normalizeDefaultExpr(after.expr)
    );
  }
  if (before.kind === "foreignKey" && after.kind === "foreignKey") {
    if (before.name && after.name) return before.name === after.name;
    return (
      before.columns.join(",") === after.columns.join(",") &&
      before.references.table === after.references.table &&
      before.references.columns.join(",") ===
        after.references.columns.join(",")
    );
  }
  return false;
}

// ---------------- column-default comparison helpers ------------------------

function normalizeTypeForCompare(t: string): string {
  return t.replace(/\s+/g, "").toLowerCase();
}

function nullableOf(c: ColumnSpec): boolean {
  return !!c.nullable;
}

function renderAddConstraint(t: string, k: KeySpec): string {
  switch (k.kind) {
    case "primaryKey":
      return `ALTER TABLE ${t} ADD PRIMARY KEY (${k.columns
        .map((c) => alwaysQuote(c))
        .join(",")});`;
    case "unique": {
      const name = k.name ? `CONSTRAINT ${alwaysQuote(k.name)} ` : "";
      return `ALTER TABLE ${t} ADD ${name}UNIQUE (${k.columns
        .map((c) => alwaysQuote(c))
        .join(",")});`;
    }
    case "check": {
      const name = k.name ? `CONSTRAINT ${alwaysQuote(k.name)} ` : "";
      return `ALTER TABLE ${t} ADD ${name}CHECK (${k.expr});`;
    }
    case "foreignKey": {
      const name = k.name ? `CONSTRAINT ${alwaysQuote(k.name)} ` : "";
      const cols = k.columns.map((c) => alwaysQuote(c)).join(",");
      const parts = k.references.table.split(".");
      const last = parts.pop()!;
      const refQualified = `${alwaysQuote(parts.join("."))}.${alwaysQuote(
        last,
      )}`;
      const refCols = k.references.columns.map((c) => alwaysQuote(c)).join(",");
      return `ALTER TABLE ${t} ADD ${name}FOREIGN KEY (${cols}) REFERENCES ${refQualified} (${refCols});`;
    }
  }
}

function renderDropConstraint(t: string, k: KeySpec): string | null {
  if (!k.name) return null;
  return `ALTER TABLE ${t} DROP CONSTRAINT ${alwaysQuote(k.name)};`;
}

// ---------------- diffTable ------------------------------------------------

export function diffTable(
  before: TableSpec,
  after: TableSpec,
): AlterPlan {
  const statements: string[] = [];

  // 0. schema change check
  if (after.schema !== before.schema) {
    return {
      statements: [],
      errors: ["Schema change is not supported"],
    };
  }

  // 1. validate the after spec — invalid block returns no statements
  const errs = specErrors(after);
  if (errs.length > 0) {
    return { statements: [], errors: errs };
  }

  const t = qualifiedTableRef(before.schema, before.name);

  // 2. pair columns
  const { pairs, newColumns, dropNames } = pairColumns(before, after);

  // 3. emit RENAMEs first
  for (const p of pairs) {
    if (p.renamed) {
      statements.push(
        `ALTER TABLE ${t} RENAME COLUMN ${alwaysQuote(
          p.beforeName,
        )} TO ${alwaysQuote(p.after.name)};`,
      );
    }
  }

  // 4. ADD COLUMN for newly added columns
  for (const c of newColumns) {
    statements.push(
      `ALTER TABLE ${t} ADD COLUMN ${alwaysQuote(c.name)} ${c.type};`,
    );
  }

  // 5. DROP COLUMN for columns no longer paired
  for (const name of dropNames) {
    statements.push(`ALTER TABLE ${t} DROP COLUMN ${alwaysQuote(name)};`);
  }

  // 6. Per paired column with actual changes
  for (const p of pairs) {
    const beforeCol = before.columns.find((c) => c.name === p.beforeName);
    if (!beforeCol) continue;
    const afterCol = p.after;

    // Type change (whitespace-insensitive)
    if (
      normalizeTypeForCompare(beforeCol.type) !==
      normalizeTypeForCompare(afterCol.type)
    ) {
      statements.push(
        `ALTER TABLE ${t} ALTER COLUMN ${alwaysQuote(
          afterCol.name,
        )} SET DATA TYPE ${afterCol.type};`,
      );
    }
    // Default change (normalized)
    const bDef = beforeCol.default;
    const aDef = afterCol.default;
    const bHasDef = bDef !== undefined && bDef !== null && bDef !== "";
    const aHasDef = aDef !== undefined && aDef !== null && aDef !== "";
    const sameDef =
      bHasDef &&
      aHasDef &&
      normalizeDefaultExpr(bDef) === normalizeDefaultExpr(aDef);
    if (!sameDef) {
      if (aHasDef) {
        statements.push(
          `ALTER TABLE ${t} ALTER COLUMN ${alwaysQuote(
            afterCol.name,
          )} SET DEFAULT ${aDef};`,
        );
      } else if (bHasDef) {
        statements.push(
          `ALTER TABLE ${t} ALTER COLUMN ${alwaysQuote(
            afterCol.name,
          )} DROP DEFAULT;`,
        );
      }
    }
    // Nullability change
    if (nullableOf(beforeCol) !== nullableOf(afterCol)) {
      const verb = afterCol.nullable ? "DROP NOT NULL" : "SET NOT NULL";
      statements.push(
        `ALTER TABLE ${t} ALTER COLUMN ${alwaysQuote(afterCol.name)} ${verb};`,
      );
    }
  }

  // 7. Key diff: drop unmatched before-keys; add unmatched after-keys
  const matchedAfter = new Set<number>();
  for (let i = 0; i < before.keys.length; i++) {
    const bk = before.keys[i];
    const matchIdx = after.keys.findIndex((ak, j) => {
      if (matchedAfter.has(j)) return false;
      return keysMatchIdentity(bk, ak);
    });
    if (matchIdx === -1) {
      const stmt = renderDropConstraint(t, bk);
      if (stmt) statements.push(stmt);
    } else {
      matchedAfter.add(matchIdx);
    }
  }
  for (let j = 0; j < after.keys.length; j++) {
    if (matchedAfter.has(j)) continue;
    const ak = after.keys[j];
    statements.push(renderAddConstraint(t, ak));
  }

  // 8. Table rename LAST
  if (after.name !== before.name) {
    statements.push(
      `ALTER TABLE ${t} RENAME TO ${alwaysQuote(after.name)};`,
    );
  }

  return { statements, errors: [] };
}
