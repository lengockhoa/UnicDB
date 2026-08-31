# INDEX_DBX05

Cycle DBX-05 — **CONNECTION WORKSPACE**: folders/colors, read-only intent, SSH tunnel lifecycle. Plan: PLAN_DBX05.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-DBX05-001 | connectionGroups + readOnlyIntent pure modules | pending | none | unic-smart (via cycle reviewer) |
| TASK-DBX05-002 | sshTunnel argv/parse + SshTunnelManager | pending | DBX05-001 (types only) | unic-smart (via cycle reviewer) |
| TASK-DBX05-003 | Config fields + manager wiring + form/tree | pending | DBX05-001, DBX05-002 | unic-smart (via cycle reviewer) |
| TASK-DBX05-004 | scaffold hygiene + regression + docs | done | DBX05-003 | unic-smart (via cycle reviewer) |

Graph: DBX05-001 → DBX05-002 → DBX05-003 → DBX05-004.

Release target: v1.20.0.

---
Status: done — executed 2de43e2 (features) + 6 review fix rounds (d49b7af, 0f236a4, fb88be0, identity-proof rounds, 65b53a7). unic-smart reviewer VERDICT: APPROVED (round 6).
Final verification: 2499 passed | 2 skipped (185 files); typecheck 0; esbuild clean.
Release: v1.20.0.
