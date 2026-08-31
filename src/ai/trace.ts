// src/ai/trace.ts — TASK-AIX06-001
//
// PURE trace recorder (no vscode, no fs, no net). In-memory ring
// bounded by MAX_TURNS turns × MAX_ENTRIES_PER_TURN entries. Every
// payload is run through `redact()` BEFORE storage so secrets never
// land on disk or on the wire when the dump envelope is exported.

export type TraceKind =
  | "prompt"
  | "delta"
  | "thought"
  | "tool_start"
  | "tool_end"
  | "error"
  | "done";

export interface TraceEvent {
  turnId: string;
  seq: number;
  kind: TraceKind;
  /** Epoch milliseconds (Date.now()). */
  ts: number;
  /** Redacted payload (any JSON-serialisable value). */
  payload: unknown;
}

export interface TraceDump {
  turnId: string;
  events: TraceEvent[];
  /** true iff the per-turn ring overflowed and dropped older entries. */
  truncated: boolean;
}

export const MAX_TURNS = 50;
export const MAX_ENTRIES_PER_TURN = 1000;

const SECRET_KEY_RE =
  /(?:api[_-]?key|secret|password|passphrase|credential|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|token)$/i;
const HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]+/gi;
const BASIC_RE = /Basic\s+[A-Za-z0-9._\-+/=]+/gi;
/** Key=value / key: value / key value forms inside plain strings. */
const KV_RE = /\b(api[_-]?key|secret|password|passphrase|token)\b\s*[=: ]\s*["']?[A-Za-z0-9._\-+/=]+["']?/gi;
/** Long opaque run — ≥ 24 hex/base64 chars incl. + / = padding. */
const LONG_RUN_RE = /[A-Za-z0-9_+/=-]{24,}/g;

/** Recursively scrub secret-shaped strings. Never throws. */
export function redact(value: unknown): unknown {
  try {
    return redactInner(value, new WeakSet());
  } catch {
    return value;
  }
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((v) => redactInner(v, seen));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEY_RE.test(k) || HEADER_RE.test(k)) {
        out[k] = "<redacted>";
      } else {
        out[k] = redactInner(v, seen);
      }
    }
    return out;
  }
  return value;
}

function scrubString(s: string): string {
  let out = s.replace(BEARER_RE, "Bearer <redacted>");
  out = out.replace(BASIC_RE, "Basic <redacted>");
  // key=value / key: value forms inside plain strings —
  // 'apiKey=short-value', 'token: abc', 'PASSWORD="x"' etc.
  out = out.replace(KV_RE, (_m, k) => `${k}<redacted>`);
  // Opaque long runs (>= 24 chars incl. base64 + / =) look like
  // secrets — normal English words and SQL identifiers are shorter.
  out = out.replace(LONG_RUN_RE, () => "<redacted>");
  return out;
}

/** Hidden global-sequence accessor for events() ordering. */
function gseq(e: TraceEvent): number {
  return (e as TraceEvent & { __g?: number }).__g ?? 0;
}

/** Per-turn entry ring with a `truncated` flag. */
interface TurnBuffer {
  events: TraceEvent[];
  /** Earliest seq still present (1 if no overflow). */
  startSeq: number;
  truncated: boolean;
}

export class TraceRecorder {
  private readonly turns = new Map<string, TurnBuffer>();
  /** AIX-06 r1: global insertion sequence so events() across turns
   *  can be returned in true insertion order. */
  private globalSeq = 0;
  /** FIFO order of turnIds (oldest first). */
  private readonly order: string[] = [];
  private readonly maxTurns: number;
  private readonly maxEntries: number;

  constructor(opts?: { maxTurns?: number; maxEntriesPerTurn?: number }) {
    this.maxTurns = opts?.maxTurns ?? MAX_TURNS;
    this.maxEntries = opts?.maxEntriesPerTurn ?? MAX_ENTRIES_PER_TURN;
  }

  record(turnId: string, kind: TraceKind, payload: unknown): TraceEvent {
    const safePayload = redact(payload);
    const ev: TraceEvent = {
      turnId,
      seq: 0,
      kind,
      ts: Date.now(),
      payload: safePayload,
    };
    // Non-enumerable stamp keeps the wire shape clean while enabling
    // a stable global sort for events().
    Object.defineProperty(ev, "__g", {
      value: this.globalSeq += 1,
      enumerable: false,
      writable: true,
    });
    let buf = this.turns.get(turnId);
    if (buf === undefined) {
      buf = { events: [], startSeq: 1, truncated: false };
      this.turns.set(turnId, buf);
      this.order.push(turnId);
      this.evictIfOverCap();
    }
    ev.seq = buf.startSeq + buf.events.length;
    buf.events.push(ev);
    if (buf.events.length > this.maxEntries) {
      const drop = buf.events.length - this.maxEntries;
      buf.events.splice(0, drop);
      buf.startSeq += drop;
      buf.truncated = true;
    }
    return ev;
  }

  events(turnId?: string): readonly TraceEvent[] {
    if (turnId !== undefined) {
      const buf = this.turns.get(turnId);
      return buf === undefined ? [] : Object.freeze(buf.events.slice());
    }
    const all: TraceEvent[] = [];
    for (const id of this.order) {
      const buf = this.turns.get(id);
      if (buf) all.push(...buf.events);
    }
    all.sort((a, b) => gseq(a) - gseq(b));
    return Object.freeze(all);
  }

  dump(turnId: string): TraceDump {
    const buf = this.turns.get(turnId);
    if (buf === undefined) {
      return { turnId, events: [], truncated: false };
    }
    return {
      turnId,
      events: buf.events.slice(),
      truncated: buf.truncated,
    };
  }

  clear(): void {
    this.turns.clear();
    this.order.length = 0;
  }

  private evictIfOverCap(): void {
    while (this.order.length > this.maxTurns) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.turns.delete(oldest);
    }
  }
}
