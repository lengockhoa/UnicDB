// src/ui/permissionDetail.ts — TASK-001 pure sanitizer for ACP permission
// `toolCall` data.
//
// Goal: turn the server's `toolCall` payload into a small, safe
// `{id, name, detail}` triple the host can post to the webview without ever
// leaking an apiKey or letting an oversized blob break the card layout.
//
// The omp toolCall field name for arguments is unverified (no omp source in
// repo). We accept the args record, in order, from any of these field names:
//
//   1. server-provided `detail` (string)        — passthrough, capped
//   2. `arguments` (record)                     — pretty JSON or SQL preview
//   3. `args`      (record)                     — pretty JSON or SQL preview
//   4. fallback                                  — empty string
//
// If none of the above is present, we degrade gracefully to today's behavior
// (empty detail) rather than guess at additional field names. Pure / total
// over `unknown` — never throws.
export const PERMISSION_DETAIL_CAP = 2000;

/** Keys whose values must be replaced with `[redacted]` regardless of value
 * shape. Matched case-insensitively against the property name. */
const SECRET_KEY_RE =
  /^(api[_-]?key|apikey|authorization|bearer|password|secret|token)$/i;

/** Pretty-JSON indent for object fallback (no extra whitespace cost — these
 * payloads are small, ~tens to hundreds of chars). */
const JSON_INDENT = 2;

const TRUNCATION_MARKER = "… (truncated)";

/** SQL-extractable DB tool names. Conservative — extend as new DB tools land. */
const SQL_TOOL_NAMES: Record<string, true> = {
  run_sql: true,
  execute_sql: true,
  sql: true,
};

/** Recursively replace any secret-like values inside `value` with the
 * redaction marker. Primitives and `null`/`undefined` pass through
 * unchanged. */
const redactSecrets = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactSecrets(v);
  }
  return out;
};

/** Build the host-safe `{id, name, detail}` triple from any server
 * `toolCall`. Total over `unknown` — never throws. The `id` and `name` are
 * passed through verbatim when they are non-empty strings; everything else
 * is an empty string. `detail` is sanitized:
 *   - secret-like keys (`apiKey`, `authorization`, `password`, …) redacted
 *     recursively
 *   - SQL-preview path for known DB tools (single `sql` field)
 *   - pretty JSON (indent 2) for everything else
 *   - capped at PERMISSION_DETAIL_CAP (2000) chars with `… (truncated)`
 *     marker when longer
 */
export function buildPermissionToolInfo(
  toolCall: unknown,
): { id: string; name: string; detail: string } {
  if (toolCall === null || typeof toolCall !== "object") {
    return { id: "", name: "", detail: "" };
  }
  const tc = toolCall as Record<string, unknown>;
  const id = typeof tc["id"] === "string" ? tc["id"] : "";
  const name = typeof tc["name"] === "string" ? tc["name"] : "";

  // Args fallback chain: server `detail` string > `arguments` > `args` > "".
  const detailField = tc["detail"];
  if (typeof detailField === "string" && detailField.length > 0) {
    return {
      id,
      name,
      detail:
        detailField.length <= PERMISSION_DETAIL_CAP
          ? detailField
          : detailField.slice(0, PERMISSION_DETAIL_CAP) + TRUNCATION_MARKER,
    };
  }
  const rawArgs =
    tc["arguments"] && typeof tc["arguments"] === "object" && !Array.isArray(tc["arguments"])
      ? (tc["arguments"] as Record<string, unknown>)
      : tc["args"] && typeof tc["args"] === "object" && !Array.isArray(tc["args"])
        ? (tc["args"] as Record<string, unknown>)
        : null;
  if (rawArgs === null) return { id, name, detail: "" };

  const redacted = redactSecrets(rawArgs) as Record<string, unknown>;
  let rendered: string;
  if (SQL_TOOL_NAMES[name]) {
    const sql = redacted["sql"];
    if (typeof sql === "string" && sql.length > 0) {
      rendered = `SQL:\n${sql}`;
    } else {
      try {
        rendered = JSON.stringify(redacted, null, JSON_INDENT);
      } catch {
        rendered = "";
      }
    }
  } else {
    try {
      rendered = JSON.stringify(redacted, null, JSON_INDENT);
    } catch {
      rendered = "";
    }
  }
  const detail =
    rendered.length <= PERMISSION_DETAIL_CAP
      ? rendered
      : rendered.slice(0, PERMISSION_DETAIL_CAP) + TRUNCATION_MARKER;
  return { id, name, detail };
}
