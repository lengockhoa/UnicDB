// src/ui/importWizard.ts
// DBX-01-004 — CSV/JSON import wizard host. Reads a file the user
// picks, parses via the pure importer modules, runs a dry-run, funnels
// the write through the existing confirmDangerousStatements flow, then
// executes inside a single transaction via executeImport.
// The importer owns NO cache and NO timer-based retry (PLAN_DBX01 §3
// Approach 2; guarded by dbx01Scaffold.test.ts).

import * as vscode from "vscode";
import { parseCsv } from "../core/importer/importCsv";
import { parseJson } from "../core/importer/importJson";
import type { DbAdapter } from "../adapters/types";
import { applyMapping, type ColumnMapping } from "../core/importer/importMapping";
import { buildDryRunPlan, type DryRunPlan } from "../core/importer/importDryRun";
import { executeImport } from "../core/importer/importExecute";

export interface ImportWizardContext {
  getAdapter: () => Promise<DbAdapter | undefined>;
  getActiveDriver: () => string | undefined;
  /** Existing destructive-SQL confirm flow (red tier). */
  confirm: (statements: string[], driver?: string) => Promise<boolean>;
  batchSize?: number;
}

export interface ImportWizardResult {
  ok: boolean;
  rowCount: number;
  errors: string[];
}

/**
 * Quick-pick a target table from the adapter's public tables.
 */
async function pickTable(adapter: DbAdapter): Promise<{ schema: string; table: string } | undefined> {
  const tables = await adapter.listTables();
  if (tables.length === 0) return undefined;
  const picked = await vscode.window.showQuickPick(
    tables.map((t) => ({
      label: `${t.schema}.${t.name}`,
      schema: t.schema,
      table: t.name,
    })),
    { placeHolder: "Import into which table?" },
  );
  if (picked === undefined) return undefined;
  return { schema: picked.schema, table: picked.table };
}

/**
 * Auto-map source headers to target columns when the names match
 * (case-insensitive). Returns null if the user cancels.
 */
async function buildMapping(
  headers: string[],
  adapter: DbAdapter,
  target: { schema: string; table: string },
): Promise<ColumnMapping[] | null> {
  const columns = await adapter.listColumns(target.table, target.schema);
  const byLower = new Map<string, { name: string; dataType: string }>();
  for (const c of columns) byLower.set(c.name.toLowerCase(), c);

  const mapping: ColumnMapping[] = [];
  for (const h of headers) {
    const col = byLower.get(h.toLowerCase());
    if (col === undefined) continue; // unmapped sources are dropped
    mapping.push({
      source: h,
      target: col.name,
      type: coerceForDataType(col.dataType),
    });
  }
  if (mapping.length === 0) {
    void vscode.window.showErrorMessage("No matching columns between file and table");
    return null;
  }
  return mapping;
}

function coerceForDataType(dataType: string): ColumnMapping["type"] {
  const d = dataType.toLowerCase();
  if (d.includes("int")) return "int";
  if (d.includes("numeric") || d.includes("decimal") || d.includes("real") || d.includes("double")) {
    return "numeric";
  }
  if (d.includes("bool")) return "bool";
  if (d.includes("timestamp") || d.includes("date")) return "timestamp";
  if (d.includes("json") || d.includes("jsonb")) return "json";
  return "text";
}

/**
 * Run the full import flow for one already-read file content.
 * Command handlers for `UnicDB.importCsv` / `UnicDB.importJson` call this
 * after the user picks a file.
 */
export async function runImport(
  content: string,
  format: "csv" | "json",
  target: { schema: string; table: string },
  ctx: ImportWizardContext,
): Promise<ImportWizardResult> {
  const errors: string[] = [];
  const adapter = await ctx.getAdapter();
  const driver = ctx.getActiveDriver();
  if (adapter === undefined || driver === undefined) {
    return { ok: false, rowCount: 0, errors: ["No active connection"] };
  }
  if (driver !== "postgres") {
    return { ok: false, rowCount: 0, errors: ["Import requires the PostgreSQL driver"] };
  }

  // 1. Parse.
  const parsed = format === "csv" ? parseCsv(content) : parseJson(content);
  for (const e of parsed.errors) {
    errors.push(`line ${e.line}: ${e.message}`);
  }
  if (parsed.rows.length === 0) {
    return { ok: false, rowCount: 0, errors };
  }

  // 2. Map (auto-match by name, case-insensitive).
  const mapping = await buildMapping(parsed.headers, adapter, target);
  if (mapping === null) {
    return { ok: false, rowCount: 0, errors: [...errors, "No usable column mapping"] };
  }

  const targetColumns = mapping.map((m) => m.target);
  const mapped = applyMapping(parsed, mapping, targetColumns);
  for (const e of mapped.errors) {
    errors.push(e.line > 0 ? `line ${e.line} [${e.column ?? "?"}]: ${e.message}` : e.message);
  }

  // 3. Dry-run (no DB calls).
  const plan: DryRunPlan = buildDryRunPlan(mapped, target, { batchSize: ctx.batchSize });

  // 4. Confirm via the existing dangerous-statement flow.
  const confirmed = await ctx.confirm(plan.sqlStatements, driver);
  if (!confirmed) {
    return { ok: false, rowCount: 0, errors: [...errors, "Import cancelled"] };
  }

  // 5. Execute in one transaction.
  const result = await executeImport(plan, adapter);
  for (const e of result.errors) {
    errors.push(e.line > 0 ? `line ${e.line} [${e.column ?? "?"}]: ${e.message}` : e.message);
  }
  if (result.error !== undefined) {
    errors.push(`${result.error.phase}: ${result.error.message}`);
    return { ok: false, rowCount: result.rowCount, errors };
  }
  return { ok: true, rowCount: result.rowCount, errors };
}

/**
 * Command entry: pick a file, then run the flow.
 */
export async function openImportWizard(
  format: "csv" | "json",
  ctx: ImportWizardContext,
): Promise<ImportWizardResult | undefined> {
  const adapter = await ctx.getAdapter();
  if (adapter === undefined) {
    void vscode.window.showErrorMessage("UnicDB import: connect to PostgreSQL first");
    return undefined;
  }
  const target = await pickTable(adapter);
  if (target === undefined) return undefined;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: format === "csv" ? { "CSV files": ["csv", "txt"] } : { "JSON files": ["json", "ndjson"] },
  });
  if (picked === undefined || picked.length === 0) return undefined;

  const fileUri = picked[0];
  if (fileUri === undefined) return undefined;
  const content = await vscode.workspace.fs.readFile(fileUri).then((bytes) =>
    Buffer.from(bytes).toString("utf8"),
  );
  return runImport(content, format, target, ctx);
}
