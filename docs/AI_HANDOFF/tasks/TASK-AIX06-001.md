# TASK-AIX06-001 — TraceRecorder pure module

Cycle: AIX-06 · Wave 5 · Priority: P1
Status: pending
Depends on: —
Reviewer: unic-smart (cycle reviewer)

## Spec

Create `src/ai/trace.ts` — PURE (no vscode, no fs, no net):

1. `TraceEvent` = `{ turnId: string; seq: number; kind: TraceKind; ts: number; payload: unknown }`
   where `TraceKind = "prompt" | "delta" | "thought" | "tool_start" | "tool_end" | "error" | "done"`.
2. `class TraceRecorder`:
   - `record(turnId: string, kind: TraceKind, payload: unknown): void` —
     apply `redact(payload)` before storing.
   - `events(turnId?: string): readonly TraceEvent[]` — frozen copy;
     when `turnId` is omitted, return ALL events across turns in
     insertion order.
   - `clear(): void` — drop everything.
   - `dump(turnId: string): { turnId: string; events: TraceEvent[]; truncated: boolean }` —
     JSON-serialisable envelope. `truncated === true` iff the turn
     was clipped to `MAX_ENTRIES_PER_TURN`.
3. Bounded storage: `MAX_TURNS = 50`, `MAX_ENTRIES_PER_TURN = 1000`.
   A new `turnId` past the cap evicts the OLDEST turn entirely
   (FIFO at the turn level, ring at the entry level).
4. `redact(value: unknown): unknown` — pure helper, exported:
   - Replaces any string containing `apiKey`, `secret`, `password`,
     `token`, `Bearer`, `Authorization`, `Basic` followed by `=`/`:`/` `
     with `<redacted>`.
   - Scrubs any value shaped like a long opaque run (≥ 24 hex/base64
     characters) inside string values.
   - Recurses into objects/arrays. Leaves primitives alone.
   - NEVER throws; on any error returns the original value.

## Acceptance

- [ ] `redact` scrubs `apiKey: "sk-live-abc..."` → payload apiKey = `<redacted>`.
- [ ] `redact` scrubs `Authorization: Bearer abc...` header.
- [ ] Bounded: 51 distinct turnIds → oldest evicted; per-turn ring
      caps at 1000 with `truncated:true`.
- [ ] `events()` returns a frozen copy; mutating the returned array
      is a no-op on the recorder.
- [ ] `npx vitest run src/ai/__tests__/trace.test.ts` green.

## Executor

(to be filled by executor with RED + GREEN evidence)

## Reviewer

(verdict appended by reviewer)
