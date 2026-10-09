# 逐条问题清单：剪辑室改版代码往死里审

> 已修的问题全部移出本表（它们变成了代码注释）。本表只留**不改**与**误报**——
> 测试记不住取舍的理由，下一轮遇到同一个取舍会重新纠结一遍。

## 不改

### 1. `CyberAudioPlayer` 的 `fmtTime` 与 `@/time` 的同名函数重复
- **来源**：OCR 第3 轮（说「三份副本」）
- **核实**：实测 3 处 —— `studio-detail.tsx` 与 `SortableSegmentRow.tsx` 两份**逐字符相同**；`CyberAudioPlayer.tsx` 那份是 `m:ss`（分钟**不**补零，`String(sec).padStart(2,'0')` + `Math.floor(total/60)` 写成 `m`），与另两份的 `mm:ss` 是**不同规格**。
- **不改的理由**：合并 `CyberAudioPlayer` 那份会把播放器时间码从 `1:05` 改成 `01:05` —— 那是**改变既有 UI**，不是去重。判据：spec §9 定的是 `m:ss`，轨道/段列表用的是 `mm:ss`，两者各自有出处。
- **落地位置**：`web/src/time.ts` 头部注释 + `CyberAudioPlayer.tsx` 的 `fmtTime` 注释（「别把它当重复代码合进 @/time」）。

### 2. `total` prop（段行）——第 2 轮已删除，此处记删除前的取舍
- **来源**：handoff「预留首尾约束」vs OCR 第 2 轮「死参数」
- **不改的理由**：**已删除**。原本 handoff 判为「预留」，但仓库规则「不预先为假想需求设计」，而真要「首尾不能拖」时改签名只有一行。留着的代价是长期死代码。
- **落地位置**：`SortableSegmentRowProps` 已无 `total`。

## 误报

### 1. 拖拽结束那一下click 会覆盖 `setSelected(to)`（第 7 轮）
- **来源**：OCR 第 7 轮（作为「次要风险」提出，建议加短时标志吞click）
- **它说的后果**：`PointerSensor` 不保证抑制拖拽结束的 click，行 `onClick → onSelect` 会把刚结算的选中覆盖成松手位置那一行。
- **我的核实**：读 `node_modules/@dnd-kit/core/dist/core.esm.js:1506`：`documentListeners.add(EventName.Click, stopPropagation, { capture: true })`。document **capture 阶段**先于 target触发 → 行上的 `onClick` 不会被调用。
- **结论**：该风险**不成立**，不需要短时标志。
- **为什么还改了**：`setSelected(to)` 该加还是加（spec D9 要求结算选中），只是**不用**加吞 click 的标志。
- **落地位置**：`onDragEnd` 注释里写明了这条依据与 `core.esm.js:1506` 的位置。

### 2. `ExportSettingsModal` 的 `readOnlyMsg ?? …` 是死代码（第 6 轮）
- **来源**：OCR 第 6 轮第 1 条（说 `readOnly`/`readOnlyMsg` 分支不可达）
- **它说的后果**：父页面 `readOnly ≡ readOnlyMsg !== null`，故组件内 `?? 默认说明` 永远走不到。
- **我的核实**：读组件代码，`readOnlyMsg ?? 默认说明` 出现在 3 处 Tooltip 里，都在**函数体内、每次渲染按实际 `readOnlyMsg` 取值** —— 组件作为独立件不保证 `readOnly 为真时 readOnlyMsg 必非空`（父页面目前恰好如此，但那是它的内部实现，不是本组件的契约）。
- **结论**：**关闭**。与 `addBlockReason` 那处性质不同（那里 `readOnly` 就是由 `readOnlyMsg` 推出来的）。
- **落地位置**：组件 props 上写了注释，防止后人把它当重复死代码一起删掉。

### 3. 「项目规则明令禁止嵌套三元」（第 11 轮的措辞）
- **来源**：OCR 第 11 轮
- **它说的后果**：违反项目规则。
- **我的核实**：`grep "三元|ternary" .trae/rules` → **零命中**。本仓规则库没有这条禁令。
- **结论**：**规则不实**（OCR 自己的偏好），但**修法仍采纳** —— if/else 与同文件 `addBlockReason` 一致、且比嵌套三元易读。
- **落地位置**：代码注释里写的是「与 addBlockReason 保持一致」，**没**写「项目规则要求」，避免把不存在的规则写成事实。

---

## 已修条目的长期形态（供下一轮查「处理过没有」）

修好的 bug 都变成了代码注释，不在此表。分布：

- `studio-detail.tsx`：`sensors` 顶层化（Hook 规则）、`addSegment(atTime?)`、`addBlockReason`、`exportBlockReason`、`onDragEnd` 结算 `selected`、`onTrackDoubleClick`（readOnly 守卫 + MouseEvent 类型 + 三处重试链接挡 dblclick + `verticalOnly`）、`exportingRef` + `finish()`、`productsErr` 可见性（Badge）、Drawer `stop()` + `destroyOnHidden`、清空按钮移出视频条件块
- `SortableSegmentRow.tsx`：`segKey` 单一来源、`disabled: readOnly`、`isDragging` 内取、`zIndex`、`setActivatorNodeRef`、删除按钮 `stopPropagation`
- `segment-row.css`：`touch-action: none`、`.is-dragging` 规则
- `TimelineWave.tsx`：重试链接挡 dblclick
- `time.ts`（新）：`mm:ss` 唯一定义

**移出去之前的自检**：每条修好的都在对应代码处留了带轮次号的注释（`2026-10-09 审查第 N 轮`），可grep 追溯。