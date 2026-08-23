# ACP Approval Bridge Research — Cycle M

> Generated 2026-08-23 from a read-only ACP scout and local `omp acp --help` probe.

## Verified facts

- `omp acp` exists in locally installed oh-my-pi 18.0.1 and declares itself an ACP server over stdio.
- ACP is JSON-RPC 2.0 carried as NDJSON, not Cycle L's custom RPC frame protocol.
- Lifecycle is `initialize` → `newSession` → `prompt`. Streaming arrives as `session/update`; the relevant message kind is `agent_message_chunk`. `agent_thought_chunk` must never be rendered.
- The agent requests host approval using `session/request_permission` with `sessionId`, `toolCall`, and `options`. The client replies with either `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
- ACP can deliver permission decisions to a VS Code webview; VSDB must display the request and resolve it by user Allow/Deny. This replaces Cycle L's `--approval-mode yolo` for omp workspace tools.
- ACP streaming has at least parity with the Cycle L bridge through `agent_message_chunk`.

## Architecture decision

ACP is a rewrite of the omp bridge layer, not a drop-in mode: custom RPC frames and ACP JSON-RPC are incompatible. Retain Cycle L's detection, read-only VSDB DB host-tool boundary, panel fallback behavior, and builtin path. Replace the process/client/session plumbing and add an explicit permission request/response channel between extension host and webview.

## Risks to resolve in plan

- ACP SDK is ESM-only while the extension host is CommonJS. Prefer a small, injected, typed JSON-RPC NDJSON ACP client over a new worker/runtime unless live protocol evidence proves a dependency is required.
- ACP session lifecycle and persistence must be explicit; do not assume RPC `--no-session` flags apply.
- Permission requests require correlation, timeout, panel disposal/stop handling, and default-deny fail-safe behavior.
- Only user-visible agent workspace tool permissions are ACP-approved. VSDB DB access remains read-only under existing guardrails; no API key crosses the ACP path.
