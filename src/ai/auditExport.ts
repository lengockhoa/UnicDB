// src/ai/auditExport.ts — TASK-AIX07-002
//
// PURE audit-export primitive over AIX-06's in-memory trace dumps.
// No vscode, no fs, no net, no child_process: the host command
// (TASK-AIX07-003) owns file selection, authorization, and writing.
//
// Defense in depth: AIX-06's recorder already redacts every payload
// BEFORE storage, but the exporter still runs `redact()` again as the
// FINAL pass immediately before serialization, so a byte-scan of the
// output can never surface a credential signature that reached memory.

import { redact, type TraceDump } from "./trace";

/** Stable schema marker for the serialized envelope. */
export const AUDIT_EXPORT_SCHEMA = "vsdb.ai.audit-export";

/** Envelope schema version (bump on breaking shape changes). */
export const AUDIT_EXPORT_VERSION = 1;

export interface AuditExportEnvelope {
  schema: string;
  version: number;
  /** ISO-8601 timestamp supplied by the caller (or now). */
  exportedAt: string;
  /** Recorder insertion order (oldest turn first). */
  turns: TraceDump[];
}

/**
 * Build a redacted, serializable all-turn envelope from trace dumps.
 * Copies every dump so consumer mutation cannot reach the source.
 * The envelope itself carries no credential field.
 */
export function buildAuditEnvelope(
  dumps: readonly TraceDump[],
  exportedAt?: string,
): AuditExportEnvelope {
  const envelope: AuditExportEnvelope = {
    schema: AUDIT_EXPORT_SCHEMA,
    version: AUDIT_EXPORT_VERSION,
    exportedAt: exportedAt ?? new Date().toISOString(),
    turns: dumps.map((d) => ({
      turnId: d.turnId,
      events: d.events.slice(),
      truncated: d.truncated,
    })),
  };
  // Second redact pass over the assembled envelope (defense in depth;
  // serializeAuditExport redacts once more right before the wire).
  return redact(envelope) as AuditExportEnvelope;
}

/**
 * Serialize the envelope to UTF-8 JSON. `redact()` runs here as the
 * FINAL pass — nothing happens between redaction and stringification.
 */
export function serializeAuditExport(
  dumps: readonly TraceDump[],
  exportedAt?: string,
): string {
  return JSON.stringify(redact(buildAuditEnvelope(dumps, exportedAt)));
}
