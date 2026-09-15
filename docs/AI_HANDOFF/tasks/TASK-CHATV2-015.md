# TASK-CHATV2-015 — Sessions, structured persistence, export and diagnostics

- Status: `ready`
- Owner: `-`
- Reviewer: `-`
- Parent plan: `docs/AI_HANDOFF/PLAN.md` §§2,4,6

## Goal
Replace DOM-scraped history/export with host-side structured sessions: hydrate, page, new/rename/clear/resume saved transcript, confirmed Markdown/JSON export and safe diagnostics IDs.

## Target Files
- `src/ui/aiChatSessionStore.ts` — new structured record/storage/retention/paging service.
- `src/ui/aiChatExport.ts` — new Markdown/JSON serializers and VS Code save result.
- `src/ui/aiChatPanel.ts` — session intents, hydrate/checkpoint/export frames.
- `webview/aiChat/sessions.ts` — picker/sidebar/rename/new/clear/export UX.
- `src/ui/__tests__/aiChatSessionStore.test.ts`, `src/ui/__tests__/aiChatExport.test.ts`.
- `webview/aiChat/__tests__/sessions.test.ts`.

## Required Work / Exact Spec
Define versioned persisted session: id, title, createdAt/updatedAt, engine/model display metadata, visible user prompts, final/partial assistant text, safe activity summaries, selected context identities/status, timestamps, terminal state and diagnostic IDs. Exclude reasoning text by default, raw tool output, credentials, permission IDs/tokens, connection strings, raw trace/stderr and attachment base64.

Use existing VS Code extension host storage mechanism identified in 001; never browser storage. Persist terminal updates immediately and streaming checkpoint after 750ms debounce. Crash-safe write/migration: validate schema, ignore/quarantine corrupt record with safe warning; never crash panel. Hydrate recent content before ready UI; page older history 50 at a time; viewport renderer remains <=200 units. Retention uses existing project policy or explicit conservative default documented/tested; no hidden indefinite binary retention.

Header overflow actions: New chat, Rename, Export, Clear, Diagnostics, Settings. New creates a fresh saved session; if active/history/draft would be affected show confirmation and preserve old session. Rename click/F2 inline; Enter emits request and waits title_updated ack; Escape reverts; failed save keeps edit and toast. Clear confirmation states it clears current transcript but does not silently delete other sessions. Resume picker max 20 recent cwd-scoped entries, title/fallback, updated time/message count; label `Resume saved UnicDB chat`. Claude/Codex native resume must not be claimed when capability false.

Export flow selects Markdown/JSON and host destination. Serializer uses structured records, not DOM/innerText. Markdown contains visible transcript and safe activity summaries; JSON has schemaVersion. Announce `Exported chat` only on `export_completed`; cancel produces no success; failure exact `Could not export chat` + safe reason. Diagnostics exposes/copies short ID and safe metadata, never raw trace by default.

All menu rows >=40px, dialogs keyboard/focus safe. Session IDs are opaque exact echoes. Concurrent rename/export/session switch responses correlate by clientRequestId and sessionId.

## Test Cases
| # | Type | Test name | Expected |
|---|---|---|---|
| 1 | persistence | close/reopen hydrate | same structured visible transcript/order/metadata |
| 2 | debounce | stream checkpoint | one write after 750ms; terminal flushes immediately |
| 3 | privacy | forbidden payload scan | no reasoning/base64/secrets/raw tools/permission IDs |
| 4 | migration | corrupt/old schema | safe migrate or quarantine; panel opens with warning |
| 5 | interaction | rename/new/clear/resume | confirmations + host ack + draft preservation |
| 6 | export | Markdown/JSON/cancel/fail | exact structured content; success only after completion |
| 7 | regression | unsupported native resume | UI says saved UnicDB transcript, not provider resume |
| 8 | boundary | 50 paging/200 DOM | correct order, load earlier, renderer cap |
| 9 | race | stale response | old session/request ack cannot mutate current session |

## Test Files
- `src/ui/__tests__/aiChatSessionStore.test.ts`
- `src/ui/__tests__/aiChatExport.test.ts`
- `webview/aiChat/__tests__/sessions.test.ts`

## Verification Commands
```bash
npm test -- --run src/ui/__tests__/aiChatSessionStore.test.ts src/ui/__tests__/aiChatExport.test.ts webview/aiChat/__tests__/sessions.test.ts src/ui/__tests__/aiChatPanelResume.test.ts
npm run typecheck
npm run compile
```

## Acceptance Criteria
- [ ] Session records survive panel closure and are versioned/migrated safely.
- [ ] Session UI labels every saved/native distinction truthfully.
- [ ] Export is structured and host-confirmed; no DOM scraping remains.
- [ ] Sensitive/large payload exclusions are test-enforced.

## Dependencies
- TASK-CHATV2-003, TASK-CHATV2-004, TASK-CHATV2-006

## Interfaces
- Consumes: V2 terminal/stream/context/activity records and transcript renderer paging.
- Produces: `AiChatSessionStore`, serializers, session/export frames/views for 016/017.

## Discussion
(no comments yet)
