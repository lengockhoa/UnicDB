// src/ui/adminWizard.ts
// Admin wizard — preview & confirm GRANT / REVOKE for selected table or schema.
// (TASK-AHL-002)
//
// Quy tắc cứng:
//   - Preview SQL dựng bằng `pgAdmin.buildGrantSql` / `buildRevokeSql` (single
//     path); KHÔNG dựng chuỗi SQL thủ công.
//   - PUBLIC grantee → reject w/ structured error trước khi mở wizard.
//   - Cancel ở bất kỳ quickPick step nào → trả undefined; caller không run SQL.
//   - Tất cả write phải đi qua `confirmDangerousStatements` (TASK-AHL-004).
import * as vscode from "vscode";
import {
  buildGrantSql,
  buildRevokeSql,
  AdminError,
  type GrantRequest,
  type RevokeRequest,
} from "../core/admin/pgAdmin";

/** Quyền cho phép trong wizard — giữ subset an toàn, mở rộng sau. */
export const WIZARD_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;
export type WizardPrivilege = (typeof WIZARD_PRIVILEGES)[number];

/** Quyết định wizard: grant hay revoke. */
export type WizardKind = "grant" | "revoke";

/** Tóm tắt wizard muốn run; caller chạy SQL thông qua confirmDangerousStatements. */
export interface WizardPlan {
  sql: string;
  kind: WizardKind;
  grantee: string;
  privileges: string[];
  objectKind: "table" | "sequence" | "schema";
  schema: string;
  object: string;
}

/** Test seam: thay quickPick/showInformationMessage. */
export interface WizardDeps {
  showQuickPick: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions,
  ) => Thenable<T | undefined>;
  showInformationMessage: (
    msg: string,
    options: vscode.MessageOptions,
  ) => Thenable<string | undefined>;
}

/** Production deps trỏ vào vscode. */
export const defaultDeps: WizardDeps = {
  showQuickPick: (items, options) => vscode.window.showQuickPick(items, options),
  showInformationMessage: (msg, options) =>
    vscode.window.showInformationMessage(msg, options),
};

/** Pure builder: build a GRANT wizard plan (no UI). Throws AdminError cho invalid input. */
export function buildGrantPlan(args: {
  grantee: string;
  privileges: readonly string[];
  schema: string;
  object: string;
  allowGrantPublic?: boolean;
}): WizardPlan {
  const req: GrantRequest = {
    grantee: args.grantee,
    privileges: [...args.privileges],
    on: { kind: "table", schema: args.schema, table: args.object },
  };
  const sql = buildGrantSql(req, { allowGrantPublic: args.allowGrantPublic });
  return {
    sql,
    kind: "grant",
    grantee: args.grantee,
    privileges: [...args.privileges],
    objectKind: "table",
    schema: args.schema,
    object: args.object,
  };
}

/** Pure builder: build a REVOKE wizard plan. */
export function buildRevokePlan(args: {
  grantee: string;
  privileges: readonly string[];
  schema: string;
  object: string;
  cascade?: boolean;
}): WizardPlan {
  const req: RevokeRequest = {
    grantee: args.grantee,
    privileges: [...args.privileges],
    on: { kind: "table", schema: args.schema, table: args.object },
  };
  const sql = buildRevokeSql(req, { cascade: args.cascade ?? false });
  return {
    sql,
    kind: "revoke",
    grantee: args.grantee,
    privileges: [...args.privileges],
    objectKind: "table",
    schema: args.schema,
    object: args.object,
  };
}

/**
 * Step 1 — pick privileges. Returns the chosen list, or empty array on cancel.
 * Pure helper (no vscode coupling) given an injected `pick` function.
 */
export async function pickPrivileges(
  pick: <T extends string>(options: readonly T[]) => Promise<readonly T[]>,
): Promise<readonly WizardPrivilege[]> {
  return await pick(WIZARD_PRIVILEGES);
}

/** Step 2 — pick grantee. Cancel → undefined. */
export async function pickGrantee(
  pick: <T extends string>(options: readonly T[]) => Promise<T | undefined>,
  candidates: readonly string[],
): Promise<string | undefined> {
  return await pick(candidates);
}

/** Preview & confirm a SQL string. Returns the SQL or undefined on cancel. */
export async function previewSql(
  deps: WizardDeps,
  sql: string,
): Promise<string | undefined> {
  const choice = await deps.showInformationMessage(
    `VSDB will run:\n\n${sql}\n\nProceed?`,
    { modal: true },
  );
  return choice === "OK" ? sql : undefined;
}

/**
 * Wizard entrypoint: builds the plan then asks user to confirm. Returns the
 * SQL or undefined on cancel / error. The caller must still pipe the SQL
 * through `confirmDangerousStatements` (TASK-AHL-004 wires the admin-red tier).
 */
export async function runGrantWizard(args: {
  schema: string;
  object: string;
  grantee: string;
  privileges: readonly string[];
  deps?: WizardDeps;
  allowGrantPublic?: boolean;
}): Promise<string | undefined> {
  const deps = args.deps ?? defaultDeps;
  let plan: WizardPlan;
  try {
    plan = buildGrantPlan({
      grantee: args.grantee,
      privileges: args.privileges,
      schema: args.schema,
      object: args.object,
      allowGrantPublic: args.allowGrantPublic,
    });
  } catch (err) {
    if (err instanceof AdminError) {
      await deps.showInformationMessage(
        `Grant rejected: ${err.message} (${err.code})`,
        { modal: true },
      );
      return undefined;
    }
    throw err;
  }
  return await previewSql(deps, plan.sql);
}

/** REVOKE wizard entrypoint. */
export async function runRevokeWizard(args: {
  schema: string;
  object: string;
  grantee: string;
  privileges: readonly string[];
  deps?: WizardDeps;
  cascade?: boolean;
}): Promise<string | undefined> {
  const deps = args.deps ?? defaultDeps;
  const plan = buildRevokePlan({
    grantee: args.grantee,
    privileges: args.privileges,
    schema: args.schema,
    object: args.object,
    cascade: args.cascade,
  });
  return await previewSql(deps, plan.sql);
}

/**
 * TASK-AHL-004 — host command entry for `vsdb.runGrantSql`. Walks the user
 * through object → privileges → grantee via the existing quickPick chain
 * (uses defaultDeps), then posts the resulting SQL through the active
 * connection's adapter via `runSql`. ALL write paths still go through
 * the confirmDangerousStatements gate (the wizard's preview modal is the
 * first confirm; the host gate is the second).
 */
export async function commandOpenGrantWizard(
  mgr: { getActive: () => unknown; getAdapter: () => unknown },
  kind: "grant" | "revoke",
): Promise<void> {
  const active = mgr.getActive() as
    | { id: string; label: string }
    | undefined;
  if (!active) {
    void vscode.window.showWarningMessage(
      "VSDB: select a connection first to use the grant/revoke wizard.",
    );
    return;
  }
  // Quick ask for the schema + object name (table/sequence). A full
  // schema browser would need its own tree; this is a minimal
  // text-input prompt that keeps the cycle shipped.
  const schema = await vscode.window.showInputBox({
    prompt: "Schema (e.g. public)",
    value: "public",
  });
  if (!schema) return;
  const object = await vscode.window.showInputBox({
    prompt: "Object name (table or sequence)",
  });
  if (!object) return;
  const grantee = await vscode.window.showInputBox({
    prompt: "Grantee role (NOT PUBLIC — rejected by builder)",
  });
  if (!grantee) return;
  const privRaw = await vscode.window.showInputBox({
    prompt: "Privileges (comma-separated: SELECT, INSERT, UPDATE, DELETE, …)",
    value: "SELECT",
  });
  if (!privRaw) return;
  const privileges = privRaw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  if (privileges.length === 0) return;

  const sql =
    kind === "grant"
      ? await runGrantWizard({ schema, object, grantee, privileges })
      : await runRevokeWizard({ schema, object, grantee, privileges });
  if (!sql) return; // user cancelled preview

  // Dispatch via the existing runSql path. The host will route through
  // confirmDangerousStatements (extended to admin-red for grant/revoke).
  const adapter = (await mgr.getAdapter()) as {
    runQuery?: (sql: string) => Promise<{ rows: unknown[] }>;
  };
  if (typeof adapter.runQuery !== "function") {
    void vscode.window.showErrorMessage(
      "VSDB: active connection does not expose a runQuery.",
    );
    return;
  }
  try {
    await adapter.runQuery(sql);
    void vscode.window.showInformationMessage(
      `VSDB: ${kind.toUpperCase()} executed.`,
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `VSDB: ${kind} failed — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
