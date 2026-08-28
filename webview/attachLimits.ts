// webview/attachLimits.ts — TASK-002 (cycle AB).
//
// Webview-side mirror of the canonical caps in src/ui/aiChatAttachments.ts.
// The webview bundle is built separately from the host bundle (esbuild's
// webview entry has no path into src/) so the two layers must export the
// same three constants in lockstep. Drift between the two files breaks the
// local pre-flight validation in webview/aiChatPanelMain.ts (which uses
// these caps to gate attach before the host even sees the payload).
//
// Mirror contract — values MUST match src/ui/aiChatAttachments.ts verbatim:
//   - MAX_ATTACH_BYTES          = 5 * 1024 * 1024
//   - MAX_ATTACHMENTS_PER_TURN  = 4
//   - ATTACH_ALLOWED_MIME       = {image/png, image/jpeg, image/webp, image/gif}
//
// Test #15 in src/ui/__tests__/aiChatPanelWebviewTask002.test.ts enforces
// this equality — change one value here, change it in the host module too,
// and vice-versa.

/** Hard cap on bytes per single attachment (5 MB). */
export const MAX_ATTACH_BYTES = 5 * 1024 * 1024;

/** Hard cap on attachments per chat turn. */
export const MAX_ATTACHMENTS_PER_TURN = 4;

/** Whitelisted MIME types for image attachments. */
export const ATTACH_ALLOWED_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
