// src/ai/commitGenGate.ts — TASK-GITMSG-001 (SPEC FR-001 / §8.1)
//
// Single-flight gate for the Generate Commit Message command. Pure module —
// no vscode import, no ports. The host (`src/extension.ts`) holds ONE gate at
// module scope; the command callback acquires first and, on `null`, shows
// TOAST_GENERATION_IN_PROGRESS and returns without calling `withProgress`.
//
// State machine (SPEC §7.1):
//   acquire() → release fn   (slot free → run proceeds; release() in finally)
//   acquire() → null         (in flight → toast, return)
//   release()                (idempotent; frees the slot exactly once)

export interface CommitGenGate {
  /** Take the slot. Returns the release function, or `null` when a run is
   *  already in flight. The release is idempotent: extra calls are no-ops
   *  and a stale release can never free a later holder's slot. */
  acquire(): (() => void) | null;
}

export function createCommitGenGate(): CommitGenGate {
  let held = false;
  return {
    acquire() {
      if (held) {
        return null;
      }
      held = true;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        held = false;
      };
    },
  };
}
