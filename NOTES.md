# UnicDB — Project Notes

> File này ở project root, NGOÀI phạm vi UKit (UKit touch `.claude/`, `.ukit/`, `docs/`). Mọi ghi chú dài hạn nên viết ở đây để không bị UKit bump/version scripts ghi đè.

---

## Workflow trên máy này (Lenk dev vibecode)

- **Không chạy test local** — máy vibecode dev, không có database test thật.
- **Mỗi fix xong → commit git + publish patch nhỏ lên Marketplace** để thấy ngay thay đổi.
- **UKit `bump-version.mjs`** luôn auto-bump patch + auto-add CHANGELOG placeholder → cần chú ý:
  - Mỗi lần chạy sẽ bump thêm 1 patch level (1.53.0 → 1.53.1 → 1.53.2 → ...).
  - Mỗi lần chạy sẽ THÊM 1 entry mới vào đầu CHANGELOG.md (kể cả khi đã có entry cũ chưa publish).
  - Nếu placeholder unfilled → script fail; pass `--changelog-summary "..."` để fill.
- **Patch publish** = `npx vsce publish patch` (chỉ bump version + push Marketplace, không cần bump-version.mjs nếu đã có version sẵn).

---

## Lesson learned — VS Code SCM context keys (2026-09-06)

**Bug regression từ 1.52.0 → fixed in 1.53.3:**
Generate Commit Message sparkle (UnicDB) bị ẩn hoàn toàn khỏi Source Control title bar.

**Root cause:**
```json
"when": "scmProvider == git && scmProviderHasChanges"
```
`scmProviderHasChanges` **không phải** VS Code SCM context key thật.

**Context keys thật của VS Code SCM:**
- `scmProvider` — id của SCM provider đang active
- `scmProviderHasRootUri` — provider có root URI không (không phải detached HEAD)
- (Không có `scmProviderHasChanges`)

**Khi VS Code gặp context key không tồn tại → evaluate thành `undefined`/`false` → cả `when` clause fail → menu item bị ẩn vĩnh viễn.**

**Fix:**
```json
"when": "scmProvider == git"
```

**Takeaway:** Khi viết `when` clause cho SCM menu, chỉ dùng các key thật:
- `scmProvider` (so sánh == với id, vd `git`)
- `scmProviderHasRootUri`
- `scmResourceGroup` (trong `scm/resourceGroup/*`)
- `scmResourceState` (trong `scm/resourceState/*`)

**Lesson cho frozen test assertions:** Test `commitGenManifest.test.ts` và `commitGenIntegration.test.ts` freeze `when` clause dưới dạng string literal. Mỗi lần fix `when`, phải update cả 2 test files (case 2 + constant).

---

## Menu locations cho SCM buttons

| Menu key | Vị trí hiển thị |
|----------|------------------|
| `scm/title` | Source Control panel header (top, cùng hàng với `...` more menu) |
| `scm/sourceControl/title` | Per-source-control-provider title (như `scm/title` nhưng riêng từng provider) |
| `scm/resourceGroup/title` | Resource group header (Changes subheader — nơi Copilot sparkle hiện) |
| `scm/resourceState/context` | Right-click trên 1 file changed |

Để sparkle hiện ngay hàng với GitHub Copilot (dễ thấy hơn), register vào `scm/resourceGroup/title` với `when: "scmProvider == git && scmResourceGroup =~ /Changes/"`.

---

## Release artifacts map

Mỗi version phát hành tạo:
1. `package.json` — bump version field
2. `CHANGELOG.md` — append entry ở đầu
3. `package-lock.json` — bump version
4. Git tag `vX.Y.Z`
5. GitHub release vX.Y.Z (attach `.vsix`)
6. Marketplace extension version

Tất cả 6 bước nên atomic — nếu fail bước nào thì rollback.
