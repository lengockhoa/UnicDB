# SPEC — <feature / cycle goal>

<!--
Written by the planner at handoff-create (Step 2, before PLAN.md tasks).
Rule: cụ thể đến mức executor implement KHÔNG cần đoán — exact paths, module names,
API methods, statuses, schemas, validation rules, permissions, empty/error states,
migration behavior, test expectations. Section nào không áp dụng thì ghi "N/A — <lý do>",
không xóa heading. Open question nào cũng phải chốt 1 default và ghi vào §14.
-->

## 1. Problem and context

<Vấn đề, hiện trạng code/docs liên quan, tại sao cần làm ngay.>

## 2. Goals

- <Kết quả đo được — thành công trông như thế nào.>

## 3. Non-goals

- <Cái CỤ THỂ không làm trong cycle này — chặn scope creep.>

## 4. User journeys

- <Ai dùng, flow từng bước, kể cả unhappy path.>

## 5. Functional requirements

- FR-001: <requirement>
  - Given: <pre-state>
  - When: <action>
  - Then: <observable result>
  - Error cases: <invalid input → exact behavior/message>

## 6. Fullstack scope

### Backend
<modules, functions, services — exact paths>
### Database / schema / migrations
<schema changes, migration file names, backfill behavior>
### API contract
<methods, routes, request/response shapes, status codes>
### Frontend UI and state
<components, states, empty/error/loading>
### Integration
<điểm nối giữa các layer>
### Security and permissions
<ai được làm gì, validation/authz checks>
### Performance
<budgets, query concerns, payload sizes>
### Observability / logging
<log points, metrics, error surfacing>
### Deployment and rollback
<feature flags, rollback path, ordering>

## 7. Data model

<entities, fields, types, invariants, indexes>

## 8. API contract

<endpoint table: method, path, request schema, response schema, error codes>

## 9. UI behavior

<state machine per screen: loading / empty / error / success; copy nếu user-facing>

## 10. Edge cases

- <concurrency, retries, offline, partial failure, large input, unicode, etc.>

## 11. Test matrix

| Area | Cases | Test file |
|------|-------|-----------|
| <unit> | <happy + edge list> | <tests/...> |

## 12. Acceptance criteria

- [ ] <verifiable criterion — ideally a command or observable state>

## 13. Migration / upgrade steps

<ordered steps for existing installs; nếu không có ghi N/A>

## 14. Open questions and chosen defaults

| Question | Chosen default | Rationale |
|----------|----------------|-----------|
| <q> | <default đã chọn> | <why> |

## 15. Review checklist

- [ ] Mọi FR testable (có Given/When/Then hoặc command).
- [ ] Mọi layer fullstack được cover hoặc ghi N/A có lý do.
- [ ] Không còn instruction mơ hồ ("improve", "better UX" không định nghĩa).
- [ ] Dependencies giữa các phần đã ghi rõ.
- [ ] Legacy/unfinished work từ Phase 0 sweep đã được tính vào.
