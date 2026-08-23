// src/ai/tools/schemaContext.ts — TASK-002
// Render introspection results into a system-prompt-sized context blob with a
// character budget. Cut happens at table boundaries; tail reports how many
// tables were dropped. NO vscode import.

import type { TableInfo, TableDetail } from "../../adapters/types";

const OMITTED_FOOTER = (n: number): string => `… (+${n} more tables omitted)`;

function fmtColumn(col: TableDetail["columns"][number]): string {
  const nullable = col.is_nullable === "YES" ? "NULL" : "NOT NULL";
  return `${col.column_name} ${col.format_type} ${nullable}`;
}

function fmtConstraint(con: TableDetail["constraints"][number], columnNames: string[]): string {
  const cols = con.conkey.map((idx) => columnNames[idx - 1] ?? `col${idx}`);
  if (con.contype === "p") {
    return `PK: ${con.conname} -> [${cols.join(", ")}]`;
  }
  if (con.contype === "f") {
    const target = con.confrelidname ?? "?";
    const targetCols = con.confkeycols ? `([${con.confkeycols.join(", ")}])` : "";
    return `FK: ${con.conname} [${cols.join(", ")}] -> ${target}${targetCols}`;
  }
  return `${con.conname}: ${con.consrc}`;
}

function renderTable(t: TableInfo, d: TableDetail): string {
  const lines: string[] = [];
  lines.push(`Table: ${t.schema}.${t.name}`);
  const columnNames = d.columns.map((c) => c.column_name);
  for (const col of d.columns) lines.push(`  - ${fmtColumn(col)}`);
  for (const con of d.constraints) lines.push(`  ${fmtConstraint(con, columnNames)}`);
  return lines.join("\n");
}

export function formatSchemaContext(
  tables: TableInfo[],
  details: TableDetail[],
  budgetChars: number,
): string {
  if (budgetChars <= 0) return "";
  if (tables.length === 0) return "";

  const rendered: string[] = [];
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    const d = details[i] ?? { columns: [], constraints: [] };
    rendered.push(renderTable(t, d));
  }
  const joined = rendered.join("\n\n");
  if (joined.length <= budgetChars) return joined;

  // Build incrementally: keep tables in order while they fit. Append the
  // footer only when at least one table is dropped AND the footer still fits
  // in the remaining budget.
  let acc = "";
  let kept = 0;
  for (let i = 0; i < rendered.length; i++) {
    const block = rendered[i];
    const candidate = acc.length === 0 ? block : acc + "\n\n" + block;
    if (candidate.length > budgetChars) break;
    acc = candidate;
    kept = i + 1;
  }
  const dropped = rendered.length - kept;
  if (dropped === 0) return acc;
  const sep = acc.length > 0 ? "\n\n" : "";
  const footerText = OMITTED_FOOTER(dropped);
  if (acc.length + sep.length + footerText.length > budgetChars) return acc;
  return `${acc}${sep}${footerText}`;
}