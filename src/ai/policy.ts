// src/ai/policy.ts — TASK-AIX07-001: central effective AI policy (PURE).
//
// The single default-deny source of truth for: effective AI provider route,
// sensitive context classes, tool classes, audit-export permission, excluded
// workspace paths, and the user-visible governance notice. Host code
// (TASK-AIX07-003: AiChatPanel funnels, UnicDB.ai.* commands) consumes these
// decisions; it must NOT re-derive policy per tool.
//
// Purity contract (pinned by policy.test.ts): no `vscode`, no filesystem, no
// network, no child process — webview/test importable like settings.ts.
//
// Derivation rules (PLAN_AIX07 §3, plan review Round 1 Finding 1):
//   - `configuredEngine` is validated ONLY as known preference vocabulary
//     ("builtin" | "omp" — src/ai/settings.ts `AiEngine`). It never decides
//     the effective route by itself.
//   - The effective provider comes exclusively from a valid
//     `resolveEngine()` choice (`EngineChoice.engine`). resolveEngine() is
//     detection-first: a user-configured "builtin" default legitimately
//     resolves to "omp" whenever omp detection succeeds. That valid route is
//     ALLOWED, not a conflict (pinned by test case 2).
//   - Sensitive capabilities (context, tools, audit export) require ALL of:
//     valid configured vocabulary + valid resolver choice + trusted workspace.
//     Anything else fails closed with a concrete, non-empty notice.
//   - Shared ALLOWED_*/DENIED_* decision constants are deep-frozen: a host
//     mutating its returned decision object cannot corrupt default-deny for
//     any later resolution (pinned by the mutation-guard tests).
//   - Capability denial keeps the resolver route observable (`provider`) so
//     `UnicDB.ai.showPolicy` can still report the effective provider; only a
//     missing/invalid resolver choice leaves `provider` null.
import type { AiEngine } from "./settings";
import type { EngineChoice } from "./engineChoice";

/** Raw user preference (`UnicDB.ai.engine`) as read from configuration —
 * deliberately `unknown` because migrated/corrupted values must reach this
 * module un-trusted and be rejected here. */
export type ConfiguredEngineInput = unknown;

/** Sensitive context classes AI turns may consume. */
export interface PolicyContextDecision {
  /** Database schema/table introspection supplied to the model. */
  schema: boolean;
  /** Workspace file reads / mention expansion / grounding. */
  workspace: boolean;
  /** Query result rows / data-bearing DB content supplied to the model. */
  rows: boolean;
}

/** Sensitive tool classes admitted into a chat session's registry. */
export interface PolicyToolDecision {
  /** DB-aware tools (query/inspect/data-bearing). */
  database: boolean;
  /** Workspace read/write/grounding tools. */
  workspace: boolean;
}

/** Effective, resolved AI governance posture — consumed by panel funnels
 * and `UnicDB.ai.*` commands without duplicating any policy rule. */
export interface EffectivePolicy {
  /** Effective provider derived from the valid `EngineChoice.engine`; null
   * only when the resolver choice itself is missing/invalid. Remains
   * observable even when capabilities are denied. */
  provider: AiEngine | null;
  /** Sensitive context class admission (default deny). */
  context: PolicyContextDecision;
  /** Sensitive tool class admission (default deny). */
  tools: PolicyToolDecision;
  /** Whether the redacted in-memory trace may be exported (default deny). */
  auditExportAllowed: boolean;
  /** "" when fully allowed; otherwise a stable, non-empty, user-visible
   * denial notice ("UnicDB AI policy: …"). */
  notice: string;
}

/** Input to `resolvePolicy` — trust, raw configured value, resolved choice. */
export interface PolicyInput {
  /** VS Code workspace-trust state (AIX-02 seam). */
  workspaceTrusted: boolean;
  /** Raw `UnicDB.ai.engine` preference value, un-validated. */
  configuredEngine: ConfiguredEngineInput;
  /** Output of `resolveEngine()` — or null/invalid when unavailable. */
  resolvedEngine: EngineChoice | null;
}

const CONFIGURED_ENGINE_VALUES: readonly string[] = ["builtin", "omp"];

// Decision objects are flat (boolean fields only), so Object.freeze is a deep
// freeze for them: no host can mutate a shared ALLOWED_*/DENIED_* constant
// through a returned policy and corrupt later default-deny resolutions.
const ALLOWED_CONTEXT: Readonly<PolicyContextDecision> = Object.freeze({
  schema: true,
  workspace: true,
  rows: true,
});
const DENIED_CONTEXT: Readonly<PolicyContextDecision> = Object.freeze({
  schema: false,
  workspace: false,
  rows: false,
});
const ALLOWED_TOOLS: Readonly<PolicyToolDecision> = Object.freeze({
  database: true,
  workspace: true,
});
const DENIED_TOOLS: Readonly<PolicyToolDecision> = Object.freeze({
  database: false,
  workspace: false,
});

/** True only when the raw configured value is known preference vocabulary.
 * Migrated/unsupported values (e.g. a pre-cycle engine string) fail closed. */
export function isKnownConfiguredEngine(value: ConfiguredEngineInput): value is AiEngine {
  return (
    typeof value === "string" && CONFIGURED_ENGINE_VALUES.includes(value)
  );
}

/** True only when `resolvedEngine` is a usable `EngineChoice` — i.e. it
 * carries a valid engine discriminator. Guards migrated/host-side drift. */
export function isValidEngineChoice(value: EngineChoice | null): value is EngineChoice {
  return (
    value !== null &&
    typeof value === "object" &&
    (value.engine === "omp" || value.engine === "builtin")
  );
}

/**
 * Resolve the effective AI policy. Default deny: sensitive context classes,
 * tool classes, and audit export are admitted only when the configured
 * engine value is known vocabulary, the resolver choice is valid, AND the
 * workspace is trusted. A valid configured "builtin" that `resolveEngine()`
 * resolved to "omp" is a permitted route, not a conflict.
 */
export function resolvePolicy(input: PolicyInput): EffectivePolicy {
  const { workspaceTrusted, configuredEngine, resolvedEngine } = input;

  const reasons: string[] = [];

  const knownConfigured = isKnownConfiguredEngine(configuredEngine);
  if (!knownConfigured) {
    reasons.push("unsupported or migrated AI engine setting");
  }

  const validChoice = isValidEngineChoice(resolvedEngine);
  const provider: AiEngine | null = validChoice ? resolvedEngine.engine : null;
  if (!validChoice) {
    reasons.push("AI engine resolver state is unavailable or invalid");
  }

  if (!workspaceTrusted) {
    reasons.push("workspace is not trusted");
  }

  const allowed = knownConfigured && validChoice && workspaceTrusted;
  if (allowed) {
    return {
      provider,
      context: ALLOWED_CONTEXT,
      tools: ALLOWED_TOOLS,
      auditExportAllowed: true,
      notice: "",
    };
  }

  return {
    provider,
    context: DENIED_CONTEXT,
    tools: DENIED_TOOLS,
    auditExportAllowed: false,
    notice: `UnicDB AI policy: sensitive AI capabilities are unavailable — ${reasons.join("; ")}. Check UnicDB: Open AI Settings and workspace trust.`,
  };
}

/**
 * Centralized excluded-path decision: credential and generated-configuration
 * locations are never admitted to workspace context, wherever they appear in
 * the tree. Pure predicate over a relative workspace path using `/`
 * separators; backslashes are normalized so Windows-shaped input behaves the
 * same. Fails closed (excluded) on unusable input.
 */
export function isExcludedWorkspacePath(relativePath: string): boolean {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    return true;
  }
  const normalized = relativePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Credentials: .env plus conventional variants (.env.local,
    // .env.production, ...) — anything named exactly ".env" or ".env" followed
    // by more characters.
    if (seg === ".env" || seg.startsWith(".env.")) {
      return true;
    }
    if (seg === ".git") {
      return true;
    }
    // Generated AI configuration: exactly .vscode/UnicDB-ai-config.yml.
    if (seg === ".vscode" && segments[i + 1] === "UnicDB-ai-config.yml") {
      return true;
    }
  }
  return false;
}
