# TASK-006 — ACP transport: `initialized` handshake, bounded timeout, stderr capture, Windows detect

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §3.6 / §3.7 (B4, B10, B12) — §7 Global Constraints applies by reference

## Goal

Make the omp transport start reliably, fail loudly, and be detectable on every platform.

- **B4a** — `AcpProcess.start` (`src/ai/omp/acpProcess.ts:155-167`) goes `initialize` →
  `session/new` and never sends the `initialized` notification, despite the file's own comments
  at `:9` and `:86` and the live smoke probe (`src/ai/omp/__tests__/acpLiveSmoke.test.ts:112`)
  documenting the handshake as `initialize → initialized → session/new`.
- **B4b** — there is no timeout anywhere in `AcpClient` (`acp.ts:120`): the only settle path is
  `Promise.race([request, startError])`, so a stalled handshake hangs `ensureAcpSession()`
  forever — no error, no `done`, permanent spinner. Add a bounded timeout per request with a
  clear error message.
- **B10** — the child's `stderr` is piped but never read (`acpProcess.ts:96-100`), so omp's own
  auth/model/config error text is discarded and an unread pipe can block the child once its
  buffer fills. Drain it, keep a bounded tail, and attach that tail to startup errors.
- **B12** — `detectOmp` (`detect.ts:72,80`) shells `which omp` with no Windows `where` fallback
  and interpolates an unquoted `${path} --version` into a shell. Fix both; this matters now
  because TASK-011 makes `detectOmp` live in production for the first time.

## Target Files

- `src/ai/omp/acpProcess.ts`
- `src/ai/omp/acp.ts`
- `src/ai/omp/detect.ts`
- `src/ai/omp/__tests__/acpProcess.test.ts`
- `src/ai/omp/__tests__/detect.test.ts`
- `src/ai/omp/__tests__/acp.test.ts`

## Test Cases (REQUIRED — TDD)

| Type | Name | Expected |
|------|------|----------|
| Happy | handshake frame order | recorded outbound frames are exactly `initialize`, `initialized` (notification, **no** `id`), `session/new` |
| Happy | session id | `start()` resolves with the `sessionId` from the `session/new` result |
| Edge (timeout) | agent never answers `initialize` | rejects within the configured bound; message names the phase; child killed |
| Edge (stderr) | child writes to stderr then exits non-zero | startup error message includes the stderr tail |
| Edge (backpressure) | 1 MB of stderr | pipe drained, retained tail is bounded (≤ 8 KB), no unbounded buffer |
| Edge (platform) | `process.platform === "win32"` | detect uses `where`, not `which` |
| Edge (malformed) | `--version` prints garbage | `{available:true, ok:false, reason:"version-unknown"}` |
| Edge (path with spaces) | omp at `/opt/my apps/omp` | version probe still succeeds; the path is quoted/argv-passed, not shell-concatenated |
| R (B4a) | today's frames | `initialized` missing today — assert on recorded frames, not on a comment |
| R (B4b) | stalled handshake | today hangs forever; after fix it rejects |
| R (B10) | stderr content | today discarded; after fix surfaced in the error |
| R (B12) | win32 detect | today runs `which` on Windows and reports `not-installed` |

## Test Files

- `src/ai/omp/__tests__/acpProcess.test.ts` (extend — handshake order, timeout, stderr; **replace the comment at `:8` that merely claims `initialized` is sent with a real assertion**)
- `src/ai/omp/__tests__/detect.test.ts` (extend — win32, quoting, garbage version)
- `src/ai/omp/__tests__/acp.test.ts` (extend — per-request timeout)

## Verification Commands

```bash
npm run typecheck
npm test -- src/ai/omp/__tests__/acpProcess.test.ts
npm test -- src/ai/omp/__tests__/detect.test.ts
npm test -- src/ai/omp/__tests__/acp.test.ts
npm test -- src/ai/omp/__tests__/hostTools.test.ts
```

`src/ai/omp/__tests__/acpLiveSmoke.test.ts` requires a real `omp` binary — run it manually when
one is available; it is not part of the per-task gate.

## Acceptance Criteria

- [ ] All 12 cases pass; each regression case confirmed failing on `main` first (output in report).
- [ ] `acpProcess.test.ts` no longer contains a **comment** asserting the handshake — the frame
      order is asserted programmatically.
- [ ] Every `AcpClient.request` is bounded by a timeout; the bound is a named constant and
      overridable for tests (no 30-second sleeps in the suite).
- [ ] Timeout rejection kills the child and disposes the client (no orphan process, no leaked
      pending resolver).
- [ ] stderr is drained continuously (a `data` listener from spawn onwards, not read once on
      failure) with a bounded retained tail.
- [ ] `detectOmp` still honors `MIN_OMP_VERSION = "17.0.0"` and never throws (ENOENT ⇒
      `{available:false, reason:"not-installed"}`).
- [ ] `npm run typecheck` clean; no new dependency.

## Dependencies

- (none)

## Interfaces

- Consumes: `(none)`
- Produces:

```ts
// src/ai/omp/detect.ts — shape unchanged, behavior fixed
export const MIN_OMP_VERSION = "17.0.0";
export const OMP_INSTALL_HINT = "curl -fsSL https://omp.sh/install | sh";
export const OMP_UPDATE_HINT = "omp update";
export interface OmpDetection {
  available: boolean; ok: boolean; path?: string; version?: string; reason?: string;
}
export async function detectOmp(execFn?: ExecFn): Promise<OmpDetection>;

// src/ai/omp/acpProcess.ts
export interface AcpProcessOptions {
  ompPath?: string;
  cwd: string;
  supportCwdFlag: boolean;
  execFn?: AcpExecFn;
  /** NEW (B4b): per-request bound in ms. Default 30_000; tests pass a small value. */
  requestTimeoutMs?: number;
}
export interface AcpProcessHandle {
  acp: AcpClient; sessionId: string; version: string; dispose: () => void;
}
```

`detectOmp` is consumed by TASK-011 (engine selection + banner). `AcpProcessOptions` is extended
again by TASK-012 (`mcpServers`) in a later wave.

---

## Discussion

### 2026-08-25 · planner · claude-opus-5

Verified at HEAD (`acpProcess.ts:155-167`): the code awaits `initialize`, then `session/new`,
with `Promise.race([…, startError])` and no timer. `startError` only settles on child `error` /
`exit`, so a live-but-silent agent hangs indefinitely — this is one of the two ways the chat
spinner never stops (TASK-007 fixes the other).

`session/new` currently passes `mcpServers: []`, which the ACP research doc
(`docs/AI_HANDOFF/queue/ACP-SESSION-research.md:7`) confirms is **required to be an array**.
Leave it as `[]` here; TASK-012 owns populating it.

---
