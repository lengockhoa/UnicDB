Command: handoff-fullstack
Goal: Ship ARP-09 Redacted support diagnostics + release-confidence profiles — lazy VSDB Output Channel with redacted lifecycle/connection/AI summaries, reveal/clear commands, no raw SQL/secrets; named `profile:fast` / `profile:release` npm profiles over real existing commands; redaction reused from trace.ts (no copy).
Base: main @ 293b344 (v1.44.0 + plan commit)
Phase: I3
Cursor: wave 1 done — ARP09-001 PASS (diagnostics.ts formatter 9/9, RED confirmed) + ARP09-002 PASS (profile:fast/profile:release pins, releaseVerify stays green 19/19) committed 076dde5. Worktrees deleted.
Next: wave 2 — two parallel feature-implementer agents: TASK-ARP09-003 (channel wiring, owns extension.ts + extension.test.ts + package.json command contributions/activationEvents) + TASK-ARP09-004 (verify-first redaction-reuse gate, owns src/ai/__tests__/trace.test.ts evidence only). Then wave 3 = 005 (conditional).
