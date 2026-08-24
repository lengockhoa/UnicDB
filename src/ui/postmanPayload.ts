// src/ui/postmanPayload.ts
// TASK-008 — Pure builder for the Postman Payload JS object literal.
//
// `buildPostmanPayload(schema, name, columns)` produces a string like
//
//   {
//     schema: "public",
//     table: "users",
//     id: this.workingObj.id,
//     name: this.workingObj.name,
//   }
//
// for table/view/routine nodes (the key `table` stays the same regardless of
// kind — see plan §3-G / TASK-008 Discussion). Column names that are not
// plain JS identifiers (hyphens, leading digits, reserved words) are emitted
// as double-quoted keys with bracket-access on `this.workingObj`.

/**
 * JS reserved words + a few contextual keywords that the parser rejects as
 * bare identifier keys (case #8). Membership lookup uses string equality.
 */
const JS_RESERVED: Record<string, true> = {
  break: true,
  case: true,
  catch: true,
  class: true,
  const: true,
  continue: true,
  debugger: true,
  default: true,
  delete: true,
  do: true,
  else: true,
  enum: true,
  export: true,
  extends: true,
  false: true,
  finally: true,
  for: true,
  function: true,
  if: true,
  import: true,
  in: true,
  instanceof: true,
  let: true,
  new: true,
  null: true,
  return: true,
  super: true,
  switch: true,
  this: true,
  throw: true,
  true: true,
  try: true,
  typeof: true,
  var: true,
  void: true,
  while: true,
  with: true,
  yield: true,
};

/**
 * Emit a JS object-literal key for the given name.
 *  - `id`           → `id`
 *  - `weird-col`    → `"weird-col"`
 *  - `1abc`         → `"1abc"`
 *  - `default`      → `"default"`
 *
 * Bare identifier = starts with letter / `$` / `_`, rest is letters / digits
 * / `$` / `_`, AND not in the JS reserved set.
 */
export function jsKey(name: string): string {
  if (name.length === 0) return JSON.stringify(name);
  const first = name.charCodeAt(0);
  // eslint-disable-next-line no-bitwise
  const firstOk =
    (first >= 0x41 && first <= 0x5a) || // A-Z
    (first >= 0x61 && first <= 0x7a) || // a-z
    first === 0x24 /* $ */ ||
    first === 0x5f; /* _ */
  if (!firstOk) return JSON.stringify(name);
  for (let i = 1; i < name.length; i++) {
    const c = name.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    const ok =
      (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x24 ||
      c === 0x5f;
    if (!ok) return JSON.stringify(name);
  }
  return JS_RESERVED[name] === true ? JSON.stringify(name) : name;
}

/**
 * Build the JS object-literal string the user pastes into Postman.
 * Always uses the key `table` (per spec) regardless of node kind.
 *
 * `schema` and `table` are emitted as JSON-quoted strings. Column names
 * use `jsKey`: bare when valid, double-quoted otherwise. Empty list →
 * `{ schema, table }` only. Always syntactically valid JS (assertable
 * via `new Function`).
 */
export function buildPostmanPayload(
  schema: string,
  name: string,
  columns: string[],
): string {
  const lines: string[] = ["{"];
  lines.push(`  schema: ${JSON.stringify(schema)},`);
  lines.push(`  table: ${JSON.stringify(name)},`);
  for (const col of columns) {
    if (col.length === 0) continue;
    const key = jsKey(col);
    if (key === col) {
      lines.push(`  ${col}: this.workingObj.${col},`);
    } else {
      lines.push(`  ${key}: this.workingObj[${key}],`);
    }
  }
  lines.push("}");
  return lines.join("\n");
}
