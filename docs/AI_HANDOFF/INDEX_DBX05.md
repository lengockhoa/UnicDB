# INDEX_DBX05

Cycle DBX-05 — **CONNECTION WORKSPACE**: folders/colors, read-only intent, SSH tunnel lifecycle. Plan: PLAN_DBX05.md.

| Task | Title | Status | Dependencies | Reviewer |
|------|-------|--------|--------------|----------|
| TASK-DBX05-001 | connectionGroups + readOnlyIntent pure modules | pending | none | unic-smart (via cycle reviewer) |
| TASK-DBX05-002 | sshTunnel argv/parse + SshTunnelManager | pending | DBX05-001 (types only) | unic-smart (via cycle reviewer) |
| TASK-DBX05-003 | Config fields + manager wiring + form/tree | pending | DBX05-001, DBX05-002 | unic-smart (via cycle reviewer) |
| TASK-DBX05-004 | scaffold hygiene + regression + docs | pending | DBX05-003 | unic-smart (via cycle reviewer) |

Graph: DBX05-001 → DBX05-002 → DBX05-003 → DBX05-004.

Release target: v1.20.0.
