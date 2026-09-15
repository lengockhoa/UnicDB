// src/ai/capabilities.ts — TASK-CHATV2-002
//
// Host-authoritative engine capability vocabulary for the four chat engines
// (builtin / omp / claude-code / codex). This is the single source the V2
// webview reads instead of branching on provider names: the UI renders only
// what this snapshot says is supported.
//
// PURITY CONTRACT (mirrored from src/ai/policy.ts): no `vscode`, no filesystem,
// no network, no child process — unit/webview importable. The resolver is a
// pure function of its input; nothing here probes a binary or reads config.
//
// EVIDENCE RULE. Every static flag below is anchored to the frozen CHATV2-001
// baseline (`docs/AI_HANDOFF/notes/chatv2-baseline.md` §1 capability matrix).
// A cell the audit recorded `absent` or `unknown` is advertised `false` — parity
// is NEVER inferred from a provider name. Two capabilities are deliberately
// dynamic and come from input, not the engine switch: `savedTranscriptResume`
// (host-owned persistence) and `imageInput` (adapter transport AND active-model
// vision).
//
// PRIVACY. The snapshot carries only display-safe vocabulary: allowlisted
// display names, booleans, command names/descriptions and role/model ids. It
// has no apiKey/base64/path/credential/permission-token/trace field, and
// `reasonUnavailable` is a fixed mapped user string (never a raw adapter
// reason), capped at 160 chars.
import type { AiEngine, AiModelRole } from "./settings";
import { aiChatCommandsForEngine } from "../ui/aiChatPanelCommands";

/** Closed four-engine vocabulary. Structural mirror of `AiEngine`
 * (src/ai/settings.ts); a compile-time check below keeps them in lockstep. */
export type AiEngineName = "builtin" | "omp" | "claude-code" | "codex";

/** Canonical engine order (menu order). Frozen — callers must not reorder. */
export const AI_ENGINE_NAMES: readonly AiEngineName[] = Object.freeze([
  "builtin",
  "omp",
  "claude-code",
  "codex",
] as const);

/** Fixed, allowlisted display labels. Never derived from raw wire input. */
const ENGINE_DISPLAY_NAMES: Readonly<Record<AiEngineName, string>> = Object.freeze({
  builtin: "Builtin",
  omp: "OMP",
  "claude-code": "Claude Code",
  codex: "Codex",
});

/** Effective engine status surfaced to the UI. */
export type CapabilityStatus = "ready" | "starting" | "unavailable" | "fallback";

/** One semantic slash-command descriptor. `source` distinguishes universal
 * host commands from provider-supplied ones; the provider set is empty on every
 * engine today (no adapter has a verified command parser), so the UI never
 * offers a command the host cannot execute. `id` is a safe identifier — never a
 * raw CLI command string. */
export interface ChatCommandDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly syntax: string;
  readonly insertedTemplate: string;
  readonly source: "universal" | "provider";
  readonly available: boolean;
  /** Safe, user-visible reason when `available` is false (omitted otherwise). */
  readonly reason?: string;
}

/** One configured model role as the capability layer sees it: the closed role
 * literal, the model id and whether that model can accept images. No credential
 * or base URL rides along. */
export interface ChatModelRole {
  readonly role: AiModelRole;
  readonly modelId: string;
  readonly vision: boolean;
}

/** Capability flags. Closed 13-key object — adding a field is an API change. */
export interface EngineCapabilitySupports {
  readonly streamText: boolean;
  readonly streamThought: boolean;
  readonly toolTimeline: boolean;
  readonly imageInput: boolean;
  readonly nativeSessionResume: boolean;
  readonly savedTranscriptResume: boolean;
  readonly engineCommands: boolean;
  readonly permissions: boolean;
  readonly bypassPermissions: boolean;
  readonly modelRoles: boolean;
  readonly workspaceMentions: boolean;
  readonly dbMentions: boolean;
  readonly exportTranscript: boolean;
}

/** Host-produced, webview-consumed capability snapshot. Exactly these fields. */
export interface EngineCapabilitySnapshot {
  readonly engine: AiEngineName;
  readonly displayName: string;
  readonly status: CapabilityStatus;
  readonly supports: EngineCapabilitySupports;
  readonly commands: readonly ChatCommandDescriptor[];
  readonly modelRoles: readonly ChatModelRole[];
  /** Safe mapped user copy (<=160 chars) — present only when the effective
   * engine is `unavailable` or running as a `fallback`. */
  readonly reasonUnavailable?: string;
}

/** Live adapter availability, as observed by the host runtime seam. */
export interface EngineAdapterRuntime {
  state: "ready" | "starting" | "unavailable";
  /** Raw adapter reason key (e.g. "not-installed"). NEVER echoed verbatim —
   * it is mapped to fixed copy by `reasonForUnavailable`. */
  reason?: string;
}

/** Effective host policy projection the capability layer consumes. Context
 * mentions and bypass are policy-gated; destructive-SQL / workspace-trust gates
 * are NOT representable here (they stay in their existing enforcement paths). */
export interface EngineCapabilityPolicy {
  dbContext: boolean;
  workspaceContext: boolean;
  bypassAllowed: boolean;
}

/** Input to `resolveEngineCapabilities`. Only `engine` and `adapter` are
 * mandatory; everything else has a safe default. */
export interface EngineCapabilityInput {
  engine: AiEngineName;
  adapter: EngineAdapterRuntime;
  /** Configured roles for the active engine. Empty/absent → no role features. */
  modelRoles?: readonly ChatModelRole[];
  /** Active role literal used for the image-vision proof (default "work"). */
  activeRole?: AiModelRole;
  /** Effective policy; defaults to allow (callers own the real policy). */
  policy?: EngineCapabilityPolicy;
  /** Host has a persisted UnicDB transcript for resume (engine-independent). */
  savedTranscriptResume?: boolean;
  /** Set when the host fell back from another engine to this effective one. */
  fallbackFrom?: AiEngineName;
}

// ---------------------------------------------------------------------------
// Static per-engine base matrix — anchored to chatv2-baseline.md §1.
// ---------------------------------------------------------------------------

/** Engine-owned capability facts (everything except the input-derived
 * `imageInput` and `savedTranscriptResume`). */
interface EngineBase {
  /** Adapter can carry image parts at all (independent of model vision). */
  readonly transportsImages: boolean;
  readonly streamText: boolean;
  readonly streamThought: boolean;
  readonly toolTimeline: boolean;
  readonly nativeSessionResume: boolean;
  readonly engineCommands: boolean;
  readonly permissions: boolean;
  /** Engine exposes its own bypass-permission control. */
  readonly bypass: boolean;
  /** Engine honors the host's active-role selection. */
  readonly modelRoles: boolean;
}

/** Resolve the engine-owned base matrix with an exhaustive switch. A new
 * `AiEngineName` member fails compilation here (never-guard). */
function engineBase(engine: AiEngineName): EngineBase {
  switch (engine) {
    case "builtin":
      return {
        transportsImages: true,
        streamText: true,
        // AgentCallbacks exposes no onThought; builtin never streams reasoning.
        streamThought: false,
        toolTimeline: true,
        // No host session store; history is panel-session only.
        nativeSessionResume: false,
        // Closed local command registry; no provider commands.
        engineCommands: false,
        permissions: true,
        bypass: true,
        modelRoles: true,
      };
    case "omp":
      return {
        // Panel forces visionCapable=false for omp — engine is the belt.
        transportsImages: false,
        streamText: true,
        streamThought: true,
        toolTimeline: true,
        // omp proves native session resume (session/load).
        nativeSessionResume: true,
        engineCommands: false,
        permissions: true,
        bypass: true,
        // omp owns its own model selection; host roles are not forwarded.
        modelRoles: false,
      };
    case "claude-code":
      return {
        transportsImages: true,
        streamText: true,
        // onThought declared but no emit site — `unknown` ⇒ false.
        streamThought: false,
        toolTimeline: true,
        nativeSessionResume: false,
        engineCommands: false,
        permissions: true,
        // No engine-level bypass toggle; CLI is pinned default-deny.
        bypass: false,
        modelRoles: false,
      };
    case "codex":
      return {
        transportsImages: true,
        streamText: true,
        streamThought: true,
        // No tool frame emitted — `unknown` ⇒ false.
        toolTimeline: false,
        nativeSessionResume: false,
        engineCommands: false,
        // No approval/permission parsing — `unknown` ⇒ false.
        permissions: false,
        bypass: false,
        modelRoles: false,
      };
    default:
      // Exhaustive guard: an unknown literal can only reach here by an unsafe
      // cast, and capability decisions must fail closed, never guess.
      return assertNeverEngine(engine);
  }
}

function assertNeverEngine(engine: never): never {
  throw new Error(
    `resolveEngineCapabilities: unknown AI engine ${JSON.stringify(
      engine as unknown,
    )}`,
  );
}

// ---------------------------------------------------------------------------
// Safe reasons
// ---------------------------------------------------------------------------

/** Fixed allowlist of user-facing unavailable copy per adapter reason key.
 * Any other value (missing, hostile, migrated) falls back to the generic line —
 * raw adapter text never reaches the snapshot. */
const UNAVAILABLE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  "not-installed": "This engine is not installed.",
  "version-too-old": "This engine is out of date.",
  "version-unknown": "This engine's version could not be determined.",
  "spawn-failed": "This engine could not be started.",
});
const UNAVAILABLE_FALLBACK = "This engine is not available in the current workspace.";

/** Map an adapter reason key to fixed, <=160-char user copy. */
export function reasonForUnavailable(reason: string | undefined): string {
  if (typeof reason === "string" && Object.prototype.hasOwnProperty.call(UNAVAILABLE_REASONS, reason)) {
    return UNAVAILABLE_REASONS[reason];
  }
  return UNAVAILABLE_FALLBACK;
}

/** Safe fallback notice: "<From display> is unavailable. Using <To display>." */
function fallbackReason(from: AiEngineName, to: AiEngineName): string {
  const copy = `${ENGINE_DISPLAY_NAMES[from]} is unavailable. Using ${ENGINE_DISPLAY_NAMES[to]} instead.`;
  return copy.length <= 160 ? copy : UNAVAILABLE_FALLBACK;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Semantic command descriptors for `engine`, sourced from the implemented
 * host registry (`src/ui/aiChatPanelCommands.ts`). Provider command descriptors
 * are added only once an adapter has a verified parser — none do today. */
function commandsForEngine(engine: AiEngineName): readonly ChatCommandDescriptor[] {
  return aiChatCommandsForEngine(engine).map((entry) => {
    const descriptor: {
      -readonly [K in keyof ChatCommandDescriptor]: ChatCommandDescriptor[K];
    } = {
      id: entry.command,
      name: entry.command,
      description: entry.description,
      syntax: `/${entry.command}`,
      insertedTemplate: `/${entry.command} `,
      source: "universal",
      available: entry.available,
    };
    if (entry.reason !== undefined) descriptor.reason = entry.reason;
    return Object.freeze(descriptor) as ChatCommandDescriptor;
  });
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Role literal used for the image-vision proof when the caller omits it. */
const DEFAULT_ACTIVE_ROLE: AiModelRole = "work";

/** True when the active role's configured model can accept images. */
function activeRoleVision(
  roles: readonly ChatModelRole[],
  activeRole: AiModelRole,
): boolean {
  for (const r of roles) {
    if (r.role === activeRole) return r.vision === true;
  }
  return false;
}

/** Normalize caller roles into a frozen, minimal projection. */
function freezeRoles(roles: readonly ChatModelRole[] | undefined): readonly ChatModelRole[] {
  if (!Array.isArray(roles) || roles.length === 0) return Object.freeze([]);
  return Object.freeze(
    roles.map((r) =>
      Object.freeze({
        role: r.role,
        modelId: typeof r.modelId === "string" ? r.modelId : "",
        vision: r.vision === true,
      }),
    ),
  );
}

const DEFAULT_POLICY: EngineCapabilityPolicy = Object.freeze({
  dbContext: true,
  workspaceContext: true,
  bypassAllowed: true,
});

/**
 * Resolve the engine capability snapshot. Pure; never throws for valid input
 * (only an unknown engine literal is a programming error and fails closed).
 */
export function resolveEngineCapabilities(
  input: EngineCapabilityInput,
): EngineCapabilitySnapshot {
  const { engine, adapter } = input;
  const base = engineBase(engine);

  const roles = freezeRoles(input.modelRoles);
  const activeRole = input.activeRole ?? DEFAULT_ACTIVE_ROLE;
  const policy = input.policy ?? DEFAULT_POLICY;
  const savedTranscriptResume = input.savedTranscriptResume === true;

  // Status precedence: an unavailable adapter outranks a fallback downgrade,
  // which outranks a starting engine.
  const unavailable = adapter.state === "unavailable";
  const isFallback =
    !unavailable &&
    input.fallbackFrom !== undefined &&
    input.fallbackFrom !== engine;

  const status: CapabilityStatus = unavailable
    ? "unavailable"
    : isFallback
      ? "fallback"
      : adapter.state === "starting"
        ? "starting"
        : "ready";

  // Engine-dependent actions are false whenever the engine cannot run.
  const live = !unavailable;

  const supports: EngineCapabilitySupports = Object.freeze({
    streamText: live && base.streamText,
    streamThought: live && base.streamThought,
    toolTimeline: live && base.toolTimeline,
    // Image input needs BOTH the adapter transport AND active-model vision.
    imageInput: live && base.transportsImages && activeRoleVision(roles, activeRole),
    // Native provider resume is engine-owned; never advertised unproven.
    nativeSessionResume: live && base.nativeSessionResume,
    // Saved UnicDB transcript resume is host-owned and engine-independent.
    savedTranscriptResume,
    engineCommands: live && base.engineCommands,
    permissions: live && base.permissions,
    bypassPermissions: live && base.bypass && policy.bypassAllowed === true,
    // A role selector with nothing to select is not a capability.
    modelRoles: live && base.modelRoles && roles.length > 0,
    workspaceMentions: policy.workspaceContext === true,
    dbMentions: policy.dbContext === true,
    // Export is a host writer, not an engine feature.
    exportTranscript: true,
  });

  const commands = Object.freeze(commandsForEngine(engine));

  const snapshot: {
    -readonly [K in keyof EngineCapabilitySnapshot]: EngineCapabilitySnapshot[K];
  } = {
    engine,
    displayName: ENGINE_DISPLAY_NAMES[engine],
    status,
    supports,
    commands,
    modelRoles: roles,
  };
  if (unavailable) {
    snapshot.reasonUnavailable = reasonForUnavailable(adapter.reason);
  } else if (isFallback) {
    snapshot.reasonUnavailable = fallbackReason(input.fallbackFrom as AiEngineName, engine);
  }
  return Object.freeze(snapshot) as EngineCapabilitySnapshot;
}

// Compile-time lockstep check: `AiEngineName` must equal `AiEngine`
// (src/ai/settings.ts). A drift in either union breaks the build here.
type _EngineUnionLockstep = AiEngine extends AiEngineName
  ? AiEngineName extends AiEngine
    ? true
    : never
  : never;
const _engineUnionLockstep: _EngineUnionLockstep = true;
void _engineUnionLockstep;
