// src/adapters/bigqueryAdc.ts
//
// TASK-BQ00-003 — ADC diagnostic classifier + client seam.
//
// Public surface (per task file §Interfaces):
//   - classifyAdcDiagnostic(err: unknown): AdcDiagnostic
//   - AdcDiagnostic { category, remediation }
//   - createBigQueryClient(projectId?, impl?) — thin injectable seam
//   - runAdcSmoke(client) — lists one allowed resource, resolves "ok" or a diagnostic
//
// Design rules (per task Discussion thread, planner, 2026-09-02):
//   - Classification is REDACTION BY CONSTRUCTION: the AdcDiagnostic output type
//     has no field for the raw error message, so echo is impossible by type,
//     not just by test.
//   - Remediation text is FIXED COPY per category — never interpolated from
//     err.message, env values, or token-shaped substrings.
//   - We match on error `code` / `status` properties where the client exposes
//     them, falling back to keyword regex over `err.message` only when the
//     property channel is empty (the synthetic test fixtures are substring
//     shaped so this branch is what they exercise).
//   - The seam wraps `new BigQuery(opts)`; tests inject an `impl` spy. The
//     module performs NO I/O at import time.
import { BigQuery } from "@google-cloud/bigquery";

/**
 * The five ADC/connection failure categories the roadmap distinguishes.
 * `unknown` is the safe default for any unrecognised input.
 */
export type AdcDiagnosticCategory =
  | "missing_adc"
  | "bad_billing_project"
  | "api_denied"
  | "location_mismatch"
  | "unknown";

/**
 * Diagnostic envelope. Note: NO raw-error field, NO env-field, NO token slot.
 * The absence of those fields is what makes redaction structural.
 */
export interface AdcDiagnostic {
  category: AdcDiagnosticCategory;
  /** Fixed copy-safe remediation text. Never derived from err.message. */
  remediation: string;
}

/**
 * Minimal structural client surface the smoke needs — fakes implement this.
 * The real `@google-cloud/bigquery` BigQuery instance is assignable to this
 * because `listDatasets(projectId?)` matches the package's declared signature.
 */
export interface BigQueryClientLike {
  listDatasets(projectId?: string): Promise<Array<{ id?: string }>>;
}

/** Fixed remediation copy per category. NEVER mutated by err contents. */
const REMEDIATION: Readonly<Record<AdcDiagnosticCategory, string>> = Object.freeze(
  {
    missing_adc:
      "Application Default Credentials not found. Run: gcloud auth application-default login",
    bad_billing_project:
      "The configured billing project could not be resolved. Verify the project ID and that billing is enabled for it.",
    api_denied:
      "The BigQuery API is not enabled (or your credentials lack permission). Enable the BigQuery API on the project and ensure your principal has BigQuery access.",
    location_mismatch:
      "The dataset's region does not match the configured location. Use a client whose location matches the dataset's region.",
    unknown:
      "Could not classify the ADC/connection error. Check the developer console output and confirm ADC, billing project, API enablement, and dataset location.",
  },
);

/**
 * Best-effort numeric status code extraction from an unknown error.
 * Returns undefined when the error shape doesn't expose one.
 */
function statusOf(err: unknown): number | undefined {
  if (err === null || err === undefined) return undefined;
  // Common shapes: { code, status, statusCode } — strings OR numbers.
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const key of ["code", "status", "statusCode"]) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = parseInt(v, 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

/**
 * Best-effort message string. Returns "" for any non-messageable input.
 * NEVER thrown — callers may safely stringify weird shapes.
 */
function messageOf(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const m = o.message;
    if (typeof m === "string") return m;
    // Some GCP-style errors nest the message at .errors[0].message.
    const errs = o.errors;
    if (Array.isArray(errs) && errs.length > 0) {
      const first = errs[0];
      if (first && typeof first === "object") {
        const fm = (first as Record<string, unknown>).message;
        if (typeof fm === "string") return fm;
      }
    }
  }
  return "";
}

/**
 * Pure classifier: maps an arbitrary error shape to a category + fixed
 * remediation. NEVER throws. NEVER echoes the raw message.
 *
 * Status-channel first (403 / 404 carry categorical info that substring
 * matching loses), keyword fallback second.
 */
export function classifyAdcDiagnostic(err: unknown): AdcDiagnostic {
  // Status channel.
  const status = statusOf(err);
  if (status === 404) {
    return { category: "bad_billing_project", remediation: REMEDIATION.bad_billing_project };
  }
  if (status === 403) {
    return { category: "api_denied", remediation: REMEDIATION.api_denied };
  }
  if (status === 401) {
    return { category: "missing_adc", remediation: REMEDIATION.missing_adc };
  }

  // Keyword channel — synthetic fixtures & real client English text.
  const msg = messageOf(err).toLowerCase();
  if (msg.length > 0) {
    // Missing ADC — google-auth-library's canonical message.
    if (/could not load the default credentials/.test(msg)) {
      return { category: "missing_adc", remediation: REMEDIATION.missing_adc };
    }
    // Permission / denied API.
    if (/\baccess denied\b/.test(msg)) {
      return { category: "api_denied", remediation: REMEDIATION.api_denied };
    }
    // Project not found.
    if (/project not found/.test(msg)) {
      return { category: "bad_billing_project", remediation: REMEDIATION.bad_billing_project };
    }
    // Location mismatch — dataset not found in expected region.
    if (/(not found in (region|location))|location mismatch|region mismatch/.test(msg)) {
      return {
        category: "location_mismatch",
        remediation: REMEDIATION.location_mismatch,
      };
    }
  }

  return { category: "unknown", remediation: REMEDIATION.unknown };
}

/**
 * Test seam: production default constructs the real `@google-cloud/bigquery`
 * client; CI passes a fake via the second parameter. The `impl` parameter IS
 * the observation point — wrap it in a `vi.fn((opts) => fakeClient)` to assert
 * call counts / option propagation.
 *
 * No I/O at module load; `new BigQuery(...)` runs only when called.
 */
export function createBigQueryClient(
  projectId?: string,
  impl?: (opts: { projectId?: string }) => BigQueryClientLike,
): BigQueryClientLike {
  const factory = impl ?? ((opts: { projectId?: string }) => new BigQuery(opts) as unknown as BigQueryClientLike);
  return factory({ projectId });
}

/**
 * Smoke: list one allowed resource. Resolves "ok" on success, or a
 * diagnostic envelope if the underlying call rejects.
 */
export async function runAdcSmoke(
  client: BigQueryClientLike,
): Promise<"ok" | AdcDiagnostic> {
  try {
    const datasets = await client.listDatasets();
    // Treat any non-empty result as success — even an empty array means we
    // reached the BigQuery API and the project is reachable.
    void datasets;
    return "ok";
  } catch (err) {
    return classifyAdcDiagnostic(err);
  }
}