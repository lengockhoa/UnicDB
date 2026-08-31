// src/ui/confirmDangerous.ts — TASK-AIX04-003
// Shared dangerous-statement consent gate. Extracted from extension.ts so
// BOTH the statement-run pipeline AND the AI chat panel plan-apply path
// use the SAME modal logic — the AIX-04 contract: every proposed SQL
// funnels through the existing consent path.
import * as vscode from "vscode";
import { analyzeStatement, guardTier } from "../core/dangerousStatement";
import type { SqlDialect } from "../core/statementParser";
import { truncateAtBoundary } from "../core/text";

/** Cap detail modal để dialog không tràn (VS Code không scroll detail). */
export const RED_DETAIL_CAP = 2000;
export const AMBER_DETAIL_CAP = 500;

export interface DangerousStatementLike {
  text: string;
}

/**
 * TASK-606 — Hỏi lại user trước khi chạy statement phá hoại.
 * Trả `true` = proceed, `false` = user cancel (huỷ CẢ LÔ).
 * Tier đỏ (DELETE/UPDATE không WHERE, mọi TRUNCATE/DROP) thắng tier amber.
 */
export async function confirmDangerousStatements(
  statements: DangerousStatementLike[],
  dialect?: SqlDialect,
): Promise<boolean> {
  // TASK-AHL-004 re-review fix: classify FIRST. `vsdb.confirmDestructive=false`
  // may skip the red/amber prompts, but admin DCL is a distinct risk class and
  // must still reach its own `vsdb.admin.confirmGrant` gate below.
  const enabled =
    vscode.workspace
      .getConfiguration("vsdb")
      .get<boolean>("confirmDestructive") ?? true;

  const red: string[] = [];
  const amber: string[] = [];
  const admin: string[] = [];
  for (const stmt of statements) {
    const tier = guardTier(analyzeStatement(stmt.text, dialect));
    if (tier === "red") red.push(stmt.text.trim());
    else if (tier === "amber") amber.push(stmt.text.trim());
    else if (tier === "admin-red") admin.push(stmt.text.trim());
  }
  if (!enabled) {
    // Non-admin prompts suppressed — but admin DCL still gated below.
    red.length = 0;
    amber.length = 0;
  }

  // TASK-AHL-004 — admin DCL (GRANT/REVOKE/KILL/TERMINATE) always prompts.
  // Gated by `vsdb.admin.confirmGrant` (default true) — separate from
  // `vsdb.confirmDestructive` because admin DCL is a distinct risk class
  // (changes who-can-do-what, or kills another user's session).
  if (admin.length > 0) {
    const adminEnabled =
      vscode.workspace
        .getConfiguration("vsdb.admin")
        .get<boolean>("confirmGrant") ?? true;
    if (adminEnabled) {
      const picked = await vscode.window.showWarningMessage(
        "VSDB: ADMIN DCL — câu lệnh này thay đổi quyền (GRANT/REVOKE) hoặc kết thúc session khác (KILL/TERMINATE). Chắc chắn chưa?",
        { modal: true, detail: capDetail(admin, RED_DETAIL_CAP) },
        "Vẫn chạy (admin)",
      );
      if (picked !== "Vẫn chạy (admin)") return false;
    }
  }

  if (red.length > 0) {
    const picked = await vscode.window.showWarningMessage(
      "VSDB: CỰC KỲ NGUY HIỂM — câu lệnh sẽ XÓA SẠCH DỮ LIỆU (DELETE không WHERE / TRUNCATE / DROP). Kiểm tra lại query!",
      { modal: true, detail: capDetail(red, RED_DETAIL_CAP) },
      "Vẫn chạy (nguy hiểm)",
    );
    return picked === "Vẫn chạy (nguy hiểm)";
  }

  if (amber.length > 0) {
    const picked = await vscode.window.showWarningMessage(
      "VSDB: DELETE có điều kiện — chạy câu lệnh này?",
      { modal: true, detail: capDetail(amber, AMBER_DETAIL_CAP) },
      "Run",
    );
    return picked === "Run";
  }

  return true;
}

function capDetail(texts: string[], cap: number): string {
  const joined = texts.join("\n\n");
  return truncateAtBoundary(joined, cap);
}
