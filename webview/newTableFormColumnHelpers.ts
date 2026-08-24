// webview/newTableFormColumnHelpers.ts
// Pure helpers cho column-type dropdown (TASK-004). Không phụ thuộc DOM, dễ
// test. Được re-export từ webview/newTableFormMain.ts cho host/test consumers.
export type FormType = "varchar" | "numeric" | "boolean";

/**
 * Map a wire (real) PostgreSQL type → the closest form-select option.
 * Unknown / exotic types fall back to "varchar" (covers `timestamp`, `date`,
 * `jsonb`, `_int4`, ...). Mapping table mirrors DataGrip designer defaults.
 */
export function mapTypeToForm(realType: string): FormType {
  const t = realType.toLowerCase();
  if (
    t === "text" || t === "varchar" || t === "char" || t === "uuid" ||
    t === "json" || t === "xml"
  ) return "varchar";
  if (
    t === "int" || t === "serial" || t === "decimal" || t === "numeric" ||
    t === "real" || t === "double" || t === "float" || t === "money"
  ) return "numeric";
  if (t === "boolean" || t.startsWith("bool")) return "boolean";
  return "varchar";
}

/**
 * Auto-fill default value per form type. Unknown types return "" (safe).
 *   varchar → ""
 *   numeric → "0"
 *   boolean → "FALSE"
 */
export function defaultColumnDefault(type: string): string {
  if (type === "varchar") return "";
  if (type === "numeric") return "0";
  if (type === "boolean") return "FALSE";
  return "";
}
