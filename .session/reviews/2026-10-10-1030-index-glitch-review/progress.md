# 审查过程账 · 序号框色散动画（RGB 错位）

> 命令：`/review-code-to-death`（code 模式）｜对象：段序号框的 RGB 色散动画改动（2026-10-09/10 用户三轮反馈迭代）

## 范围（一旦定下，后续轮次只在其上做增量）

- **范围**：工作区未提交
- **起始 diff**：**6 文件 +1288 / -29**（取数命令：`ocr review --preview`）
- **已跟踪修改**（取数命令：`git status --porcelain`）：
  - `web/src/components/SortableSegmentRow.tsx` +42/-18
  - `web/src/components/segment-row.css` +96/-0
  - `web/src/pages/studio-detail.tsx` +107/-11
- **未跟踪新增**：`docs/demo/segment-index-rgb-glitch.html` +272、`segment-swap-channel-switch.html` +377、`segment-swap-signal-loss.html` +394
- **⚠️ 每轮范围 = 上一轮修完后的增量**
- **⚠️ 与上一轮审查（`2026-10-09-2030-code-review-to-death`，13 轮 33 条，已核销）的关系**：那是同一批文件的**改版落地审查**；本轮审的是其后的**色散动画增量**。上一轮的账本里已核销的条目不在本轮重复处置，但若本轮发现是那 13 轮修复引入的，**要回写到上一轮账本**。

## 轮次账

**轮次编号从这张表数，不许口头数。**

| 轮 | 时间 | OCR session id | FILES/COMMENTS | 逐条处置完 | 段二 | 段三 | 本轮核销 |
|---|---|---|---|---|---|---|---|
| 1 | 19:05 | 待填 | 6 / 待填 | ⬜ | 空转（code 模式） | 空转（code 模式） | ⬜ |

取数命令：`ocr session list`

## 段二 / 段三（每轮相同，空转）

- **段二 · 文档**：**空转** —— 本命令是 code 模式，按 loop.md 段序只跑段一。`git status --porcelain` 实测改动全是 `.tsx`/`.css`/`.html`，**零 `.md`**。不算已跑
- **段三 · 对账**：**空转** —— 同上。**不算已跑**