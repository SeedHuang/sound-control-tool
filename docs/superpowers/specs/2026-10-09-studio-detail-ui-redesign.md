# 剪辑室页面交互改版设计（sound-control-tool）

- 日期：2026-10-09
- 状态：**待实施**（下一个 session 开工）
- 目标仓库：`d:\Seed\sound-control-tool`（只动 `web/` 包，`server/` 一行不改）
- 相关设计：`docs/superpowers/specs/2026-10-07-cyberpunk-ui-overhaul-design.md`（CP2077 视觉层）、`2026-10-07-cyber-audio-player-design.md`（播放器组件）
- 触发来源：用户 2026-10-09 提出的 10 张截图标注意见（本文档 §1逐条落地）

---

## 0 给下一个 session 的读前须知

**这份文档是自足的**：接手时不需回看对话，照着§3 的决策表 + §5 的实施顺序做即可。

**已完成的准备工作**（不用重做）：

| 项 | 状态 | 说明 |
|---|---|---|
| 依赖 `@dnd-kit/core` / `sortable` / `utilities` | ✅ **已装进 `web/package.json`** | 6.3.1 / 10.0.0 / 3.2.2，React 18 兼容（peer 要求 `>=16.8`） |
| 拖拽库选型 | ✅ 用户拍板用 dnd-kit（否决了手写） | 别再重新评估这件事 |
| 代码改动 | ⬜ **一行未动** | `studio-detail.tsx` 仍是原样 |

⚠️ 装依赖时pnpm 报了一条 peer 警告，**与 dnd-kit 无关**（全是 Umi 4.7 自带的历史依赖：`dva` 要 React 16、`@utoo/pack` 要特定 postcss）。已用 `pnpm peers check`核过，dnd-kit 三个包零命中。别去"修"它。

---

## 1 背景：用户提出的 10 处意见与落地情况

用户对着 10 张截图提了意见。逐条裁决如下—— **图 10 整块不做（§2.1 有依据），图 4 的一处我追问确认过位置（§2.2），其余全部照做**。

| 图 | 用户意见 | 落地决定 | 章节 |
|---|---|---|---|
| 图 1 | 「打点」按钮的功能能在轨道上**双击**触发；tooltip 要说明 | ✅ 做：轨道双击加段 + tooltip 补文案 | §4.1 |
| 图 2 | 「试听最新一条成品」按钮及其逻辑不要了 | ✅ 做：删按钮 + 删逻辑（成品行本身能播） | §4.2 |
| 图 3 | 回退按钮放到**最左边**；工具栏布局**固定成一个标准组件** | ✅ 做：抽 `StudioToolbar`，只含外壳 + 布局 + 返回 | §4.3 |
| 图 4 | 红色删除按钮看着像「删作品」；清空剪辑点挪到**缩放行右侧** | ✅ 做：清空按钮挪到缩放档位行右端 | §4.4 |
| 图 5 | （同上，是「缩放 全片/中景/近景」那一行） | —— 与图 4 同一处改动 | §4.4 |
| 图 6 | 导出区常驻占地方、操作频率低、离导出按钮远 → **改成点导出按钮弹对话框** | ✅ 做：导出设置搬进 `Modal` | §4.5 |
| 图 7 | 已导出成品列表常驻不合适 → 工具栏加按钮，**点开抽屉** | ✅ 做：搬进 `Drawer` | §4.6 |
| 图 8 | 去掉上移/下移，改**拖拽排序**；「删除」改 icon | ✅ 做：dnd-kit 拖拽 + icon 化 | §4.7 |
| 图 9 | 段列表**没对齐**：序列/时间段/时长/删除按钮**宽度固定**，标签框自适应 | ✅ 做：固定列宽 + `flex:1` 标签框 | §4.8 |
| 图 10 | 中景/远景下 Shift+滚轮平移时间轴；轨道上不拖拽（改拖进度） | ❌ **不做**（用户已确认跳过） | §2.1 |

## 2 两条我不照做的（附依据）

### 2.1 图 10 为什么跳过 —— 已与用户确认

用户原话「图10和对应的需求你先别做」。技术上也站得住：轨道上目前**只有一个手势**（按下拖 = 拖播放头），并不存在「拖拽时间轴」这个手势；拖时间轴指的是拖**时间尺**，而那里已经是拖播放头了。若再把轨道上的拖拽禁掉，用户挪播放头只能去20px 高的时间尺上拖，**精度只会更低**。

**结论**：图 10 整块不进本次范围。若日后要做，判据是先确认「轨道上原本有没有独立的平移手势」。

### 2.2 图 4 的另一种解读（已确认按用户框选位置做）

用户最初说「放在图 5 这个位置的右侧」，我追问过一次（图 5 是缩放档位行），用户回图框选确认：**就是缩放档位那一行的右侧空白处**。

⚠️ 语义上「清空剪辑点」属于段列表的操作，放到时间轴控制行旁边是拧的；但用户明确框选了，**照做**，不再争辩。若日后觉得别扭，可以再挪。

---

## 3 决策清单

| # | 决策 | 值 |
|---|---|---|
| D1 | 轨道双击加段 | 加段 + 选中新段；**现有开销不要改变**（默认长度 10 秒、片尾回退 10 秒这两条逻辑原样，别改数值） |
| D2 | 「试听最新一条成品」 | **删除**（按钮 + `onPreviewAudio` + `previewTip` + `previewing` state 一并删） |
| D3 | 工具栏组件 | `PageHeader` 加可选 `leading`（返回按钮走它）；新建 `StudioToolbar.tsx` **只承载右侧按钮组**。详见 §4.3 |
| D4 | 清空剪辑点按钮位置 | 缩放档位行右端（用户框选处） |
| D5 | 导出设置 | 从常驻 `CyberCard` 搬进点「导出」弹出的 `Modal`；**全部选项都进去**（内容三选 + 分段模式 + 格式 + 那句提示） |
| D6 | 已导出成品列表 | 从常驻 `CyberCard` 搬进 `Drawer`；工具栏加一个按钮开抽屉 |
| D7 | 段排序 | dnd-kit拖拽；行**左侧加把手**，只有把手能拖（不整行拖） |
| D8 | 段列表列宽 | 序列 48 / 时间段 150 / 时长 90 / 删除 36；标签框 `flex: 1` 吃掉剩余 |
| D9 | 拖拽 vs 选中 | 拖拽时**不触发**行选中（选中改为拖拽结束后才结算），避免高亮乱跳 |
| D10 | 返回按钮 | 工具栏**最左**（原最右） |

---

## 4 逐项设计

### 4.1 轨道双击加段（图 1）

**触发点**：轨道层（`trackRef` 那个 `div`）的 `onDoubleClick`。

**关键冲突**：轨道层已有 `onPointerDown={startScrub}`。双击 = 两次 pointerdown + dblclick，所以**双击时定位已经发生了**（播放头已跳到那一点）—— 这恰好是对的：段从播放头起，加段前先定位，双击点哪就是从哪开始。

**必须做的一件事**：`startScrub` 在 L1/L2 档位下拖动 = 平移窗口。双击会被识别成「两次按下 + 没位移」，走单击分支定位，不触发平移。**这一条现有代码已覆盖**（4px 阈值 + `moved` 标记），不需要改。

**实现**：
```ts
const onTrackDoubleClick = (e: ReactPointerEvent<HTMLDivElement>): void => {
  // 双击 = 先定位到那一点，再加段（startScrub 的 pointerdown 已经 seek 过了）
  seek(xToTime(e.clientX));   // 显式再来一次：第二次 pointerdown 可能被阈值分支吃掉
  addSegment();
};
```
`addSegment()` 自带 `setSelected(新段下标)`（[studio-detail.tsx:537](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx#L537)），**D1 的「加号就选中新段」已天然满足**，不用额外写。

**tooltip 改文案**（图 1 要求）：
```
'打点（也可在轨道上双击）'
```

**边界**：全片档位（L0）双击也加段——用户说「双击就会加」，不区分档位。

⚠️ **别忘了给拖边把手加 `stopPropagation`**：段区块左右 8px 的拖边把手已有 `onPointerDown={dragEdge(...)}` 且内部已 `stopPropagation`，双击不会误触发。但**段区块中部**的双击会冒泡到轨道层 → 在段上双击会在该处再加一段。加段区块中部的 `onDoubleClick` 调 `stopPropagation` 挡住。

### 4.2 删「试听最新一条成品」（图 2）

**用户理由**（已确认）：成品列表里本身就能播放，所以工具栏那个按钮是冗余的。

**要删的东西**（都在 [studio-detail.tsx](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx)）：

| 删除项 | 位置 |
|---|---|
| 工具栏 `CustomerServiceOutlined` 按钮 + Tooltip | ~L966-970 |
| `onPreviewAudio` 函数 | L837 |
| `previewTip` 常量 | L831 |
| `previewing` state | 声明在 L94 附近 |
| `stopPreview` | 若只被此处用，一并删；若成品行也用则留 |

⚠️ **删完必须跑一次全局搜索确认没残留引用**。`stopPreview` 和 `player` 的关系要查清——成品行的播放器走的是单例引擎（`@/audio-player`），跟 `previewing` 那套是两码事，别误删。

⚠️ 工具栏少了两个按钮（试听、返回移位），**顺序会变**，见 §4.3。

### 4.3 抽 `StudioToolbar` 组件（图 3）

**范围：只抽外壳与按钮组，不抽具体按钮。** 用户明确「这个是指布局和回退功能」。

**为什么值得抽**：返回按钮 + 一行布局这个外壳，在剪辑室之外没有第二处用（资料库用的是它自己那套）。抽出来是**为可复用打底**，不是立刻复用。**若 review 时被质疑「只有一处用」，答案是：这是用户明确要求的「固定下来成为一个标准组件」，后续页面接入时直接用。**

#### 落地方案

行结构（`toolbarInline` 的同排 / `flex:0 1 auto` 限宽 / `marginLeft:auto` 靠右）**已经在 `PageHeader` 里实现过了**，不重写第二遍。所以分工是：

- `PageHeader` 新增可选 prop `leading?: ReactNode` → 渲染在标题**左侧**（`icon` 之后、标题之前），**返回按钮走这里**
- 新建 `web/src/components/StudioToolbar.tsx` → 只承载「右侧按钮组」，作为 `toolbar` 传入

理由：
- 行结构由 `PageHeader` 统一管，不在第二个组件里重写一遍
- `StudioToolbar` 退化成纯按钮组容器，资料库将来接入时能直接拿去用

⚠️ **不要复用现成的 `icon` prop** —— 它的语义是「平台 logo」（资料库传的是 `SiteLogo`）。把返回按钮塞进去会让「这里该放 logo」的语义被污染，后来人无从判断。**新增独立的 `leading` 才干净。**

**实现后的调用形态**：
```tsx
<PageHeader
  leading={<Tooltip title="返回剪辑室"><CyberButton icon={<ArrowLeftOutlined />} onClick={goBack} /></Tooltip>}
  title={<EditableTitle ... />}
  meta={epText}
  toolbarInline
  titleMaxWidth={620}
  toolbar={<StudioToolbar tools={<>{/* 6 个图标按钮 */}</>} />}
/>
```

⚠️ `PageHeader` 是**多页共用组件**（`library.tsx` 也在用）。`leading` 必须是**可选**、默认不渲染 —— 否则会破坏资料库现有布局。改完必须跑 `library.tsx` 那一页看有没有被动到。

### 4.4 清空剪辑点挪到缩放行（图 4/5）

**从**：工具栏的 `DeleteOutlined`（红，`variant="red"`）。
**到**：缩放档位行（[studio-detail.tsx](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx#L1079) 那行）的右端，`marginLeft: 'auto'` 贴右。

**为什么这样更好**（用户的判断成立）：红色垃圾桶在工具栏里，紧挨着返回键和保存键，读起来像「删除当前作品」。挪到缩放行后，它离「轨道」这个语境更近（都是时间轴相关），且离返回键远了，误点风险下降。

**改动**：
- 按钮从 `toolbar` 里删掉，加到缩放行
- Tooltip 保持「清空所有剪辑点」
- 保留 `okType: 'danger'`（`clearAll` 里的 `Modal.confirm` 一字不动，仓库铁律）
- disabled 条件不变：`readOnly || segments.length === 0`

### 4.5 导出设置搬进对话框（图 6）

**现状**：[studio-detail.tsx:1339-1386](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx#L1339-L1386) 一个常驻 `CyberCard`，含 4 组控件 + 提示文字 + 导出进度条。

**改成**：工具栏点「导出」→ 弹 `Modal`，把这些全放进去。**用户拍板「都要」**，即：
- 导出内容三选（音频/视频带音轨/视频纯视频）
- 分段模式（分多段/合并成一段）
- 格式（mp3/m4a/wav，仅音频时显示）
- 提示「导出的是当前界面上的剪辑段，不会自动保存」
- 导出进度条 `Progress`

**关键取舍：进度条放哪？（⚠️ 这条是我判断的，用户没明说）**

进度只在 `exporting === true` 时出现。若进度留在 Modal 里，Modal 就得一直开着等导出结束——**导出失败时用户得先关掉 Modal 才看得到错误**。

**决定：点「开始导出」后立刻关闭 Modal。** 进度与成败仍走原有的 `Progress` + `message` 通路（进度走 SSE，本来就有终态只发一次的逻辑在[studio-detail.tsx:365-394](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx#L365-L394)）。

📍 **进度条渲染位置**：在**原导出卡片的位置**渲染一个临时的 `Progress`，但不重建那张卡片——即正文里保留一条 `exporting && <Progress percent={exportPercent} />`（无卡片外壳、无其他控件）。导出结束后自动消失。

这样：① Modal 不会被长时间占用；② 失败信息（`message.error`）一定看得见；③ 用户能看到进度。四项同时满足。

⚠️ 这条是**我自己的判断**，用户没明说。实施时若觉得别扭可调整，但**必须保证失败信息用户看得到**。

### 4.6 已导出成品搬进抽屉（图 7）

**照抄项目里已有的抽屉范式**（`TaskDrawer.tsx` / `LogsButton.tsx` 都是这个形状）：

```tsx
<Drawer title={`已导出的成品（${products.length}）`} width={720} open={open} onClose={() => setOpen(false)}>
  {/* 原 CyberCard 里的内容整段搬进来 */}
</Drawer>
```

- 工具栏加一个按钮（图标：`InboxOutlined` 或 `SoundOutlined`；用户没指定，用 `@ant-design/icons` 现成的）
- 空态用 `Empty`（仓库铁律：列表空态一律 antd `Empty`）
- 拉取失败仍显示 `Alert`，**不能静默**（现状如此，保持）
- 导出成功后 `loadProducts()` 的调用**不变**——抽屉开着也会实时刷新

⚠️ 抽屉里的成品行带播放器（`CyberAudioPlayer`），**单例引擎在抽屉打开时仍工作**，无需额外处理。

### 4.7 段列表改拖拽排序（图 8）

**依赖**：已装好 dnd-kit（§0）。

**改法**（照 dnd-kit sortable 标准形状）：

```
<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
  <SortableContext items={indices} strategy={verticalListSortingStrategy}>
    {segments.map((s, i) => <SortableRow key={i} index={i} .../>)}
  </SortableContext>
</DndContext>
```

**D7 的「只有把手能拖」怎么实现**：
dnd-kit 的 `useSortable` 默认整个子元素都是拖拽源。做法：把拖拽监听器（`attributes` / `listeners`）**只挂在把手上**，行本身不挂。

```tsx
function SortableRow({ index, seg, ... }) {
  // id 用「起止时间」，**不用 index** —— 理由见下方 ⚠️
  const segId = `${seg.start_sec}-${seg.end_sec}`;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: segId });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <span {...attributes} {...listeners} className="drag-handle"><HolderOutlined /></span>
      {/* 行内容 */}
    </div>
  );
}
```

⚠️ **父组件的 `SortableContext items` 必须用同一个键**（`segments.map((s) => \`${s.start_sec}-${s.end_sec}\`)`）——两处不一致 dnd-kit 直接失效。完整落地方案见 [实施计划 Task 3](../plans/2026-10-09-studio-detail-ui-redesign.md)。

⚠️ **把手图标用哪个**：`@ant-design/icons` 里有 `HolderOutlined`（六点格子）。**不要引新图标库**（仓库既有铁律）。

⚠️ **拖拽中禁用拖边把手**：拖动行时若鼠标压到行内的拖边把手（左右 8px），会同时触发「拖边微调」。`isDragging` 时给行内交互元素 `pointerEvents: 'none`。

⚠️ **`onDragEnd` 要走 `setSegs`**，不能直接改 `segments`——`setSegs` 内部 `setDirty(true)`，是「有未保存改动」的唯一来源（[studio-detail.tsx:229](file:///d:/Seed/sound-control-tool/web/src/pages/studio-detail.tsx#L229)）。

⚠️ **`items` / `useSortable` 的 id不能用数组下标**：dnd-kit 要求 id 稳定且唯一。用 index 的话，删除中间行后所有行的 id 会平移，而 dnd-kit 缓存的 `activeId`/`overId` 仍是旧下标 → 落位算错（表现为「删完再拖，段跳到错误位置」）。

→ **决定（2026-10-09 审查时修正）**：id 取 **`${start_sec}-${end_sec}`**。`EditSeg` 没有自增 id，但改数据结构会牵连保存格式（代价远大于收益），而**起止时间已经是现成的唯一键**，用它既不动数据结构又能消掉下标平移问题。

⚠️ **残留风险（接受，不修）**：两段起止**完全相同**时键会撞（拖一条另一条跟着动）。本次不处理（用户未提），但实施时要真机确认一下这个场景。

⚠️ React 的 `key` 仍用 `index`（那是 React 自己的渲染 key，与 dnd-kit 的 id 是两回事）；dnd-kit 的 `items` 与 `useSortable` 用 `start-end` 键。**两套别混。**

**删掉 `moveSegment`**：两个按钮没了，函数没有调用方 → 整个删掉（L545-553）。

**「删除」改 icon**：`DeleteOutlined` + Tooltip「删除」。破坏性操作仍走 `Modal.confirm`（`removeSegment` 目前**没有**二次确认——它删的是编辑中的本地段、不是磁盘文件，所以仓库铁律里「删数据要确认」不适用；但**存盘后**删除即不可恢复。⚠️ **这处需要产品决策**：是否给单段删除加确认？我倾向**不加**（单段删除是高频轻操作，加确认会很烦；现有行为保持不变）。

### 4.8 段列表列宽对齐（图 9）

**现状问题**（图 9 红框）：时间段、时长都是「按内容撑宽」的裸 flex 项 → 每行宽度不同，跨行对不齐。

**改法**：

| 列 | 宽度 | 写法 |
|---|---|---|
| 拖拽把手 | 24px | `flexShrink: 0` |
| 序列 Tag | 48px | `flexShrink: 0`，`width: 48` |
| 时间段 | 150px | `flexShrink: 0`，`width: 150` |
| 时长 | 90px | `flexShrink: 0`，`width: 90` |
| 标签输入框 | 剩余 | `flex: 1`，`minWidth: 0`（原 `maxWidth: 200` 要去掉，否则吃不满） |
| 删除按钮 | 36px | `flexShrink: 0` |

**去掉标签框的 `maxWidth: 200`** —— 它是「不让标签框抢太多」的旧设定，与「自适应吃掉剩余」冲突。改 `flex: 1; minWidth: 0`。

⚠️ 用固定 `width` 还是 `flex: 0 0 <n>px`？**用 `flex: 0 0 Npx`** —— 单纯 `width` 在 flex 容器里会被 `flex-shrink` 压掉。

---

## 5 实施顺序（建议拆 5 个可独立验证的批次）

每批做完都能单独跑起来看，不攒到最后。

| 批次 | 内容 | 对应章节 | 验证方式 |
|---|---|---|---|
| **B1** | 删「试听最新一条成品」 | §4.2 | 工具栏少一个按钮；`tsc` 零错 |
| **B2** | 段列表：列宽对齐 + 删除改 icon + 拖拽排序 + 删 `moveSegment` | §4.7 §4.8 | 真机：拖一行换位、删中间行后再拖、标签框拉宽 |
| **B3** | 轨道双击加段 + tooltip 文案 | §4.1 | 真机：轨道任意位置双击 → 新段且选中；在段区块上双击**不应**加段 |
| **B4** | 工具栏：抽 `StudioToolbar`、返回键最左、清空按钮挪到缩放行 | §4.3 §4.4 | 真机：返回在最左；清空按钮在缩放行右端且确认弹窗仍弹 |
| **B5** | 导出搬进 Modal + 成品列表搬进 Drawer | §4.5 §4.6 | 真机：导出三种内容各跑一次看进度与失败提示；抽屉开合、导出后列表自动刷新 |

**每批结束必跑**：`cd web; npx tsc --noEmit`（零错才算完）。

⚠️ **本项目 vitest 在受限环境会stuck 在 `[queued]`**（worker pool 起不来）。若测试跑不起来，改用 `npx tsc --noEmit` + `GetDiagnostics` 作为替代验证，**不要反复重试**。

---

## 6 需要真机验证的清单（程序侧验不了）

以下**必须真机点过**，typecheck 全绿也证明不了：

1. 轨道双击加段：位置对不对？新段是否选中？**在段区块上双击会不会误加**？
2. 拖拽排序：拖把手能不能拖？会不会同时触发拖边微调？**删中间行后再拖**会不会错位？
3. 列宽对齐：四列跨行是否真的齐了？窗口变窄时标签框会不会把别的列挤走？
4. 缩放行右端的清空按钮：位置符合预期吗？二次确认还弹吗？
5. 导出 Modal：三种导出内容 + 三种格式各跑一遍；**失败时错误信息看得见吗**？进度条看得见吗？
6. 成品抽屉：空态、失败态、行内播放器能不能播、导出后是否自动刷新。
7. 工具栏：按钮顺序是否顺手？窄窗口下会不会挤爆？

---

## 7 明确不做（防下次会话重提）

| 不做 | 理由 |
|---|---|
| 图 10 的 Shift+滚轮平移 + 轨道禁拖 | 用户明确跳过（§2.1） |
| 引入 dnd-kit 之外的新图标库 | 仓库既有铁律：用 `@ant-design/icons` |
| 给单段删除加二次确认 | 高频轻操作，加确认会很烦；保持现状 |
| 改 `server/` | 本次纯前端交互改动 |
| 给段加**自增 id**（为拖拽用） | 会牵连保存格式，代价 >> 收益。**注**：改用现成的 `${start_sec}-${end_sec}` 作 dnd-kit 的 id，无需加字段（§4.7） |
| 「修」pnpm peer 警告 | 与本次改动无关，是 Umi 的历史依赖（§0） |

---

## 8 决策依据里值得记住的坑

**别在 `studio-detail.tsx` 里加「组件是否还活着」的 ref。**
这不是理论——2026-10-09 刚踩过：`useEffect(() => () => { alive.current = false }, [])` 在 React 18 开发模式的「挂载→立刻卸载→再挂载」中，清理函数会把标记**永久**置假，导致后续所有 `if (!alive) return` 拦截生效、动画与交互全部卡死。同款坑在 `TaskDrawer.tsx` 有注释记录（那边能用是因为请求就在 effect 内发起）。修复方式是删掉这个 ref，而不是加特判。

**项目里已有抽屉范式**，新做抽屉照 `TaskDrawer.tsx` 的形状抄（antd `Drawer` + `open`/`onClose` + 方角化已在 `global.css` 全局配好），不要另造。