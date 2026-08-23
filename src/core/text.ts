// src/core/text.ts
// TASK-702 — code-point-safe truncate with `…` suffix.
// `String.slice` cuts on UTF-16 code units and can split a surrogate pair
// (e.g. emoji in SQL comments), producing `�` in the modal. Walk code points
// via the spread iterator and step back when the next code point would land
// on the high surrogate of a pair we cannot finish.
const ELLIPSIS = "…"; // U+2026, single code unit, never breaks a pair

export function truncateAtBoundary(s: string, cap: number): string {
  if (cap <= 0) return s.length === 0 ? "" : ELLIPSIS;
  if (s.length <= cap) return s;
  // Cap is in UTF-16 code units (matches String.slice semantics callers expect).
  // Walk code points until we would exceed cap; if the next code point would
  // be a lone high surrogate that won't fit, drop it and suffix with `…`.
  const cps = [...s]; // code-point view (emoji = 1 element, not 2)
  let units = 0;
  let count = 0;
  for (const cp of cps) {
    // UTF-16 length of one code point: BMP = 1, supplementary = 2.
    const len = cp.length;
    if (units + len > cap) break;
    units += len;
    count++;
  }
  // `cps.slice(0, count)` is already aligned to code-point boundaries, so
  // every surrogate pair is whole. Suffixing `…` keeps the result pair-safe.
  return cps.slice(0, count).join("") + ELLIPSIS;
}
