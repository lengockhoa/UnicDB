// webview/tabTitle.ts
// TASK-UX2-002 — pure tab-label helpers extracted from webview/main.ts
// so they can be unit-tested without the full webview bundle.
//
//   tabTitle(r, i)  → "Run N · <hint>"
//     hint = error path: r.label || r.sql.slice(0,30) || "failed"
//     hint = label path: r.label
//     hint = sql path:   r.sql.slice(0, 30)
//     hint = fallback:   `Stmt ${r.runStmtNo ?? i + 1}`
//
//   tabBadge(r)      → "⚠ " if r.status === "error" else ""
//
// Pure / cheap: one slice + one ternary per call, no allocations in the hot
// loop (the caller reuses the returned string as the tab textContent).

/** Minimal read-only contract. The webview's full `StatementResult` is a
 *  structural superset — the helper only touches these fields. Defining it
 *  as a structural type keeps this module dependency-free. */
export interface TabTitleInput {
  sql?: string;
  label?: string;
  status?: "running" | "done" | "error" | "cancelled";
  error?: string;
  runNo?: number;
  runStmtNo?: number;
}

/** Max chars of SQL/label used as the tab's statement hint. Matches the
 *  plan's `slice(0, 30)` contract. */
export const TAB_TITLE_SQL_MAX = 30;

export function tabTitle(r: TabTitleInput, i: number): string {
  const runNo = r.runNo ?? i + 1;

  // Error path: show label (preferred) or the first 30 chars of sql —
  // or fall back to "failed" so the tab never reads as empty.
  if (r.error) {
    const hint =
      (r.label && r.label.length > 0 && r.label) ||
      (r.sql && r.sql.length > 0 && r.sql.slice(0, TAB_TITLE_SQL_MAX)) ||
      "failed";
    return `Run ${runNo} · ${hint}`;
  }

  if (r.label && r.label.length > 0) {
    return `Run ${runNo} · ${r.label}`;
  }

  if (r.sql && r.sql.length > 0) {
    return `Run ${runNo} · ${r.sql.slice(0, TAB_TITLE_SQL_MAX)}`;
  }

  return `Run ${runNo} · Stmt ${r.runStmtNo ?? i + 1}`;
}

export function tabBadge(r: TabTitleInput): string {
  return r.status === "error" ? "⚠ " : "";
}
