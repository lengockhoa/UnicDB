# ROADMAP — DataGrip Parity (durable)

Mục đích: bản đồ multi-cycle đưa VSDB tới feature-parity với JetBrains DataGrip, PostgreSQL-first.
File này **durable** — sống qua các vòng archive; mỗi cycle khi bắt đầu bóc phần của mình ra vào PLAN_XX.md.
Trạng thái hiện hành của từng cycle xem `ACTIVE.md` + `INDEX_XX.md`; đây chỉ là bản đồ.

Nguyên tắc chung:
- TDD bắt buộc (RED trước); mọi cycle có full-suite green + typecheck 0.
- PostgreSQL-first: feature mới làm chuẩn trên Postgres; MySQL/MSSQL parity gom về Cycle AK.
- Foundation trước: AF (catalog + DDL) mở đường cho diff/diagram/refactor.
- AI synergy: panel chat AI hiện có (DB-aware tools, permission cards) được tái sử dụng — không viết trùng tính năng AI.

| Cycle | Chủ đề | Trạng thái |
|---|---|---|
| AF | Catalog + DDL + Console + Formatter | planned (wave 1 của roadmap) |
| AG | Import/Export + Data grid nâng cao | planned |
| AH | Admin: users/roles/grants + sessions/locks | planned |
| AI | Diff (schema + data) + rename refactor | planned |
| AJ | ER diagrams + SSH tunnel + connection UX | planned |
| AK | MySQL/MSSQL parity + polish | planned |

---

## Cycle AF — Catalog + DDL + Console + Formatter (current, see PLAN_AF.md)
- Schema tree: indexes / constraints / triggers per table, sequences, row counts.
- DDL viewer: real DDL (pg_get_viewdef / functiondef / triggerdef) qua `vsdb-ddl:` docs.
- SQL formatter pure module (`formatSql`).
- Console v2: multi-tab, per-statement + selection run, history (recall + persisted), EXPLAIN(ANALYZE) pane, Format button.
- Rough: 4 tasks. Foundation cho AI, AJ.

## Cycle AG — Import/Export + Data grid nâng cao
- Import wizard: CSV/JSON từ disk → column mapping preview → INSERT batches (dangerousStatement compliance, dry-run count).
- Grid: row add/delete inline, numbered pagination (bên cạnh Load More), form view (sửa theo row), value editor JSON/large text.
- Copy table giữa 2 connections (schema + data, chọn batch).
- Rough: 4-5 tasks. Depends: none cứng (AF giúp DDL copy nhưng không bắt buộc).

## Cycle AH — Admin: users/roles/grants + sessions/locks
- Tree category `Roles` (login/role attributes), per-role grants (tables/sequences/schema), member-of.
- Grant/revoke wizard với preview SQL + confirm (dangerous-statement gate).
- Sessions viewer: active queries (pid, user, state, duration, query), lock waits (blocked → blocking chain), kill/terminate (confirm).
- Rough: 4 tasks. Depends: AF (tree + catalog patterns).

## Cycle AI — Diff + Refactor
- Schema diff: chọn 2 tables/2 schemas (cùng hoặc khác connection) → ALTER plan, copy/run từng bước.
- Data diff: 2 tables cùng shape → row-level diff theo PK (inserted/changed/deleted), sync wizard hướng 2 chiều tùy chọn.
- Rename refactor: rename table/column với usage update qua catalog (FK, views, routines) → preview + confirm.
- Find usages của object từ schema cache.
- Rough: 4-5 tasks. Depends: AF (catalog DDL), cần schema cache mở rộng.

## Cycle AJ — ER diagrams + SSH tunnel + connection UX
- ER diagram webview từ FK introspection (bảng box + cạnh FK, zoom/pan, highlight bảng liên quan, export SVG).
- SSH tunnel cho connection form (jump host, key/password, tunnel tự quản lý lifecycle).
- Connection UX: groups/folders, màu per-connection, read-only flag (grid chặn edit + warning).
- Rough: 5 tasks. Depends: AF (FK catalog), AG (grid read-only surface).

## Cycle AK — MySQL/MSSQL parity + polish
- Nâng catalog cho mysql (SHOW INDEX / information_schema) + mssql (sys.* views); bỏ NotImplementedError còn lại.
- DDL thật cho view/routine trên cả 2 driver (SHOW CREATE / sp_helptext).
- Quick doc (hover thấy column type/comment), go-to-definition từ SQL → tree, find usages mở rộng.
- Full-text search trong data (ILIKE/LIKE panel + tsvector hint), result-set compare, query parameters (:name binding).
- Rough: 5-6 tasks. Depends: tất cả cycle trước đã ổn trên Postgres.

---

## Feature → Cycle map (không orphan)

| DataGrip feature | Cycle |
|---|---|
| Object tree đầy đủ + row counts | AF |
| DDL trong editor (view/routine/trigger) | AF |
| Multi-tab console + history + EXPLAIN + format | AF |
| Import wizard (CSV/JSON disk) | AG |
| Grid row add/delete, pagination, form/value editors | AG |
| Copy table giữa DBs | AG |
| Users/roles/privileges UI | AH |
| Sessions + locks viewer + kill | AH |
| Schema diff | AI |
| Data diff | AI |
| Safe rename + find usages | AI |
| ER diagrams | AJ |
| SSH/SSL tunnels | AJ |
| Connection colors/groups/read-only | AJ |
| Full-text search in data, result compare, query params, quick doc, go-to-def | AK |
| MySQL/MSSQL parity | AK |

## Đã có sẵn (không lên kế hoạch lại)
- AI chat + DB-aware tools + permission cards + omp engine (cycle AA/AD/AE).
- Data grid: server-side sort/filter, keyset paging, inline edit, paste, undo/redo, export 8 formats.
- Connection manager (add/edit/test, SecretStorage, SSL), destructive-SQL confirm, completion + semantic tokens.
