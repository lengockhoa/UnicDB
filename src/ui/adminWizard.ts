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
