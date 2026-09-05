// src/ui/formView.ts
// DBX-01-004 — single-row labeled form renderer. Host-side data
// shaping only; the actual DOM lives in the webview (CSP-clean).
// `null` renders as "(NULL)"; long values are NOT truncated here —
// the webview delegates to the `UnicDB-lv:` large-value editor.

export interface FormViewEntry {
  column: string;
  /** Rendered value. `null` for SQL NULL → the webview shows "(NULL)". */
  value: string | null;
  /** True when this entry should offer the large-value editor affordance. */
  large?: boolean;
}

export const NULL_LABEL = "(NULL)";

/** Values longer than this get the large-value affordance. */
export const LARGE_VALUE_THRESHOLD = 256;

/**
 * Build the labeled entries for one row. Order follows the record's
 * own key insertion order (matches the result-grid column order the
 * caller passes in).
 */
export function buildFormEntries(row: Record<string, unknown>): FormViewEntry[] {
  const entries: FormViewEntry[] = [];
  for (const [column, v] of Object.entries(row)) {
    if (v === null || v === undefined) {
      entries.push({ column, value: null });
      continue;
    }
    if (typeof v === "object") {
      const text = JSON.stringify(v);
      entries.push({ column, value: text, large: text.length > LARGE_VALUE_THRESHOLD });
      continue;
    }
    const text = String(v);
    entries.push({ column, value: text, large: text.length > LARGE_VALUE_THRESHOLD });
  }
  return entries;
}

/**
 * Render the form for display inside a webview. Returns the message
 * payload the host posts to the webview main script; the webview never
 * receives raw database rows.
 */
export function renderFormMessage(row: Record<string, unknown>, title: string): {
  type: "formView";
  title: string;
  entries: FormViewEntry[];
} {
  return { type: "formView", title, entries: buildFormEntries(row) };
}
