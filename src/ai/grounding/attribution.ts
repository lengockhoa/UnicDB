// src/ai/grounding/attribution.ts — TASK-AIX01-001
// Per-turn attribution record. Pure, order-stable, dedupe by ref.

export type AttributionKind = "file" | "selection" | "schema";

export interface AttributionEntry {
  kind: AttributionKind;
  ref: string;
  bytes: number;
}

export interface AttributionRecord {
  turnId: string;
  entries: AttributionEntry[];
  totalBytes: number;
}

export function emptyAttributionRecord(turnId: string): AttributionRecord {
  return { turnId, entries: [], totalBytes: 0 };
}

export function recordAttribution(
  rec: AttributionRecord,
  incoming: readonly AttributionEntry[],
): AttributionRecord {
  if (incoming.length === 0) return rec;
  const seen = new Set(rec.entries.map((e) => e.ref));
  const entries = rec.entries.slice();
  let totalBytes = rec.totalBytes;
  for (const e of incoming) {
    if (seen.has(e.ref)) continue;
    seen.add(e.ref);
    entries.push(e);
    totalBytes += e.bytes;
  }
  return { turnId: rec.turnId, entries, totalBytes };
}

export function formatAttributionFooter(rec: AttributionRecord): string {
  if (rec.entries.length === 0) return "";
  return `Grounded in: ${rec.entries.map((e) => e.ref).join(", ")}`;
}
