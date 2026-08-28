# TASK-003 (cycle AB) — CSS for attachments strip + attach button + warning

Wave: 1 (parallel with TASK-001 host + TASK-005 pure helpers).
Owner files: `webview/styles.css` + new test file.
Constraint: no same-wave file overlap (T-001 owns .ts host; T-005 owns a new test only).

## §Spec

CSS contract additions for the image attach + paste feature. New classes (defined by TASK-002 webview) get theme-aware styles.

### New class declarations to add to `webview/styles.css`

```css
/* Attach button (icon button in composer row, left of send) */
.vsdb-chat-attach-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--vsdb-input-border);
  border-radius: 6px;
  background: var(--vsdb-input-bg);
  color: var(--vsdb-fg);
  cursor: pointer;
}
.vsdb-chat-attach-btn:hover:not(:disabled) {
  background: var(--vsdb-input-hover-bg);
}
.vsdb-chat-attach-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* Attachments strip — horizontal scroll row above the textarea */
.vsdb-chat-attachments {
  display: flex;
  flex-direction: row;
  gap: 8px;
  padding: 6px 8px;
  max-height: 80px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--vsdb-input-border);
}
.vsdb-chat-thumb {
  position: relative;
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--vsdb-input-border);
}
.vsdb-chat-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.vsdb-chat-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--vsdb-overlay-bg);
  color: var(--vsdb-fg);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
}
.vsdb-chat-thumb-remove:hover {
  background: var(--vsdb-error-bg);
}

/* Warning bubble for attach rejections */
.vsdb-chat-attach-warning {
  background: var(--vsdb-warning-bg);
  color: var(--vsdb-warning-fg);
  border-left: 3px solid var(--vsdb-warning-border);
  padding: 6px 10px;
  margin: 4px 0;
  border-radius: 4px;
  font-size: 12px;
}
```

### Theme tokens (add to the existing `:root` and `[data-theme="dark"]` blocks)

The warning + overlay tokens may already exist; if not, add them. CSS contract test asserts presence.

### Regression pin

The cycle-AA `body.vsdb-chat-body { height: 100vh; }` rule (height chain fix from cycle-AA round 1b) MUST stay present. The new attachments strip lives inside `.vsdb-chat-input` (composer column) — it MUST NOT alter the panel flex chain.

## §Verification Commands

```bash
cd .worktrees/task-003
npx vitest run src/ui/__tests__/chatLayoutCss.test.ts
npm run typecheck
```

## §Dependency direction note (cycle AB review round 2)

T3 (wave 1) consumes T2's (wave 2) class names. Mechanically OK only because T3's tests assert the CSS source as text — the DOM is constructed by T2 and not asserted by T3. T3 declares the contract; T2 fulfils it.

## §Acceptance Criteria (revised round 2 — added edge rows)

1. **Happy**: all required declarations present in `webview/styles.css` (regex check, one assertion per declaration).
2. **Happy (theme)**: theme tokens used (no hardcoded colors).
3. **Happy (thumb)**: `.vsdb-chat-thumb img { object-fit: cover }` ensures 56×56 thumbnails don't distort.
4. **Regression (cycle AA)**: body height chain still present (regression pin: `.vsdb-chat-body { height: 100vh }`).
5. **Edge (overflow)**: with >4 thumbnails the strip scrolls horizontally (`overflow-x: auto`), no layout overflow breaks the composer column.
6. **Edge (theme fallback)**: the warning rule references `var(--vsdb-warning-bg)` (or an existing token) — never a hardcoded color string.
7. **Edge (focus)**: `.vsdb-chat-attach-btn:focus-visible` (or equivalent) declares a visible focus ring via theme token.
8. **Edge (dark theme)**: the `[data-theme="dark"]` block declares dark variants of the new tokens (no light-only fallback that breaks dark mode).


1. All required declarations present in `webview/styles.css` (regex check, one assertion per declaration).
2. Theme tokens used (no hardcoded colors).
3. `.vsdb-chat-thumb img { object-fit: cover }` ensures 56×56 thumbnails don't distort.
4. Cycle-AA body height chain still present (regression pin: `.vsdb-chat-body { height: 100vh }`).
5. CSS contract test exists in `src/ui/__tests__/chatLayoutCss.test.ts` (or a new task-003 file) and asserts the above.

## §Out of scope
- Webview DOM construction (TASK-002)
- Webview runtime logic (TASK-002)

## Reviewer Verdict — R2 [TASK-003] (unic-smart)
- TASK: TASK-003
- VERDICT: APPROVED-WITH-MINOR
- VERIFICATION_RERUN: npx vitest run src/ui/__tests__/chatLayoutCss.test.ts → 25/25 pass (1 file); npm run typecheck → exit 0. All 8 acceptance rows confirmed in webview/styles.css (attach-btn 1453, strip 1481, thumb 1489, img cover 1499, remove overlay 1507, warning token 1529, focus ring 1473, dark block 1436) + cycle-AA pin body.vsdb-chat-body{height:100vh} intact at 1302 (guarded by test h). No hardcoded color values in new rules — hex appears only as var() fallbacks per file-wide convention.
- BLOCKING: none
- NOTES: Minor (non-blocking): (1) styles.css:1452 comment says "24×24 hit target" but the rule is 28×28 — fix the comment; (2) styles.css:1436-1448 dark-block overrides for warning/error tokens are byte-identical to :root (only --vsdb-overlay-bg alpha 0.4→0.6 differs), so the "sharpen contrast" comment overstates — harmless since --vscode-* vars track theme; (3) chatLayoutCss.test.ts:469-493 test g only requires ≥1 dark token, could pin all 6. Model isolation OK: executor unic-code ≠ reviewer unic-smart. RED baseline evidence (8 fail / 17 pass → 25/25) is in commit da29b04 message, not appended to this task file.
