# 剪辑室页面交互改版 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按用户 2026-10-09 的 10 张截图标注意见，改版剪辑室页面（`studio-detail.tsx`）的交互与布局：工具栏规范化、导出搬进对话框、成品列表搬进抽屉、段列表改拖拽排序并对齐列宽、轨道支持双击打点。

**Architecture:** 纯前端改动，`server/` 一行不改。新增 2 个组件（`StudioToolbar` 右侧按钮组容器、`SortableSegmentRow` 段行），`PageHeader` 加一个可选 prop（`leading`）。导出设置从常驻卡片搬进 antd `Modal`，成品列表搬进 antd `Drawer`（照项目里 `TaskDrawer.tsx` 已有范式）。段排序用已装好的 dnd-kit。

**Tech Stack:** Umi 4 (`@umijs/max`) + antd 5.21 + React 18.3 + TypeScript 5.9；样式为纯 CSS / 内联 style（**不引入 styled-components / less**）；拖拽用 `@dnd-kit/core` 6.3.1 + `@dnd-kit/sortable` 10.0.0（**已装进 `web/package.json`**）。

**Spec:** `docs/superpowers/specs/2026-10-09-studio-detail-ui-redesign.md`

## Global Constraints

- **禁止任何 git 写操作**（`git add` / `commit` / `push` 一律不做）。每个任务的收尾动作统一为「改动留在工作区，由用户提交」。理由：用户有全局禁令，且计划里的 commit 步骤不算授权。
- **`web/` 包没有任何单元测试**（实测 `web/**/*.test.ts(x)` 零命中），且本项目 vitest 在受限环境会 stuck 在 `[queued]`。→ **本计划不写 TDD 步骤**，验证手段固定为：`cd web; npx tsc --noEmit`（必须零错）+ 每批末尾的**真机验证清单**。
- 样式只用**内联 style + 纯 CSS 类**；色值只用 `cyberColors`（`@/setup/theme`）；切角只用 `var(--cyber-clip)`。**禁止引入 styled-components / less。**
- **不引入新依赖**。图标只用已有的 `@ant-design/icons`（`HolderOutlined`、`InboxOutlined` 等都已在包里）。拖拽只准用已装的 `@dnd-kit/*`。
- 禁用态必须包一层 `<span>`，否则 antd Tooltip 收不到鼠标事件、悬停不出提示（**本文件既有铁律**，`library.tsx` 同一写法）。
- 图标按钮必须有中文 Tooltip + `aria-label`。
- 破坏性操作（清空所有剪辑点、删除成品）必须 `Modal.confirm` + `okType: 'danger'`。`clearAll` 与 `removeProduct` 里现有的确认框**一字不动**。
- 列表空态一律用 antd `<Empty>`（禁止纯文本占位）。
- ⚠️ **不要在 `studio-detail.tsx` 里加「组件是否还活着」的 ref**。React 18 开发模式会「挂载→立刻卸载→再挂载」，清理函数会把标记永久置假，导致后续所有 `if (!alive) return` 拦截生效、交互全卡死（2026-10-09 刚踩过，详见 spec §8）。
- ⚠️ **不要动 Ctrl+滚轮切档**（`studio-detail.tsx` 里的 `onWheel`，含 `levelRef` / `applyLevel` 那套）。本计划不碰图 10 的手势改造。
- 所有被删的符号，删完**必须全局搜索确认无残留引用**（尤其 `latestProduct` / `previewing` / `previewTip` / `onPreviewAudio` / `audioProducts` / `moveSegment`）。

---

## 0 开工前须知

### 0.1 已完成（不要重做）

`@dnd-kit/core` / `@dnd-kit/sortable` / `@dnd-kit/utilities` **已装进 `web/package.json`**（6.3.1 / 10.0.0 / 3.2.2，React 18 兼容）。

⚠️ 装依赖时 pnpm 报的 peer 警告**与 dnd-kit 无关**（全是 Umi 4.7 自带历史依赖：`dva` 要 React 16、`@utoo/pack` 要特定 postcss）。已用 `pnpm peers check` 核过，dnd-kit 三包零命中。**不要去"修"它。**

### 0.2 环境自检（Task 1 开工前做一次）

```powershell
cd d:\Seed\sound-control-tool\web
node -e "console.log(require('./package.json').dependencies['@dnd-kit/core'])"
# 期望输出：^6.3.1（若报undefined → 依赖没装上，先跑 pnpm add）
```

### 0.2b 行号取证表（2026-10-09 实测）

本计划正文引用了 `studio-detail.tsx` 的若干行号。**执行时先跑这条命令复核，别盲信文档**（前面几个任务改完之后，后面任务的行号会自然偏移）：

```powershell
cd d:\Seed\sound-control-tool\web\src\pages
Select-String -Path studio-detail.tsx -Pattern "const moveSegment|const clearAll|const addSegment|const setSegs|<PageHeader|stopPreview|全片</Button>|导出设置（时间轴下方）|成品明细（D16/D17）" | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

2026-10-09 基线（**未做任何改动前**）：

| 断言 | 行号 | 内容 |
|---|---|---|
| `setSegs` 定义 | 230 | 改段的唯一入口（内部 `setDirty(true)`） |
| 删除成品里停播 | 439 | `if (player.audioId === it.id) stopPreview();` |
| `addSegment` 定义 | 528 | 内部已 `setSelected(新下标)` |
| `moveSegment` 定义 | 545 | **Task 3 要删** |
| `clearAll` 定义 | 773 | `Modal.confirm` + `okType:'danger'` |
| `stopPreview` 定义 | 836 | **Task 2 要删** |
| `stopPreview` 工具栏调用 | 990 | **Task 2 随按钮一起删** |
| 缩放档位行 | 1081 | **Task 5 往这行右边加清空按钮** |
| 导出常驻卡片 | 1338 | **Task 6 要搬走** |
| 成品常驻卡片 | 1388 | **Task 7 要搬走** |
| 文件总行数 | 1410 | — |

⚠️ **Task 1 之前所有行号有效**；每完成一个任务，后续任务的行号会偏移 —— **以命令实跑结果为准，不要按本文档的死行号硬改**。

### 0.3 这批改动的关键文件

| 文件 | 角色 |
|---|---|
| `web/src/pages/studio-detail.tsx` | **主战场**——10 处改动全在这里（实测 **1410 行**，2026-10-09） |
| `web/src/components/PageHeader.tsx` | 加一个可选 prop `leading`（多页共用，改完必须验资料库） |
| `web/src/components/StudioToolbar.tsx` | **新建**：右侧按钮组容器 |
| `web/src/components/SortableSegmentRow.tsx` | **新建**：段行（拖拽 + 固定列宽） |
| `web/src/components/ExportSettingsModal.tsx` | **新建**：导出设置对话框 |

---

### Task 1: 抽 `StudioToolbar` + `PageHeader.leading` + 返回键最左

**Files:**
- Create: `web/src/components/StudioToolbar.tsx`
- Modify: `web/src/components/PageHeader.tsx`（加 `leading` prop）
- Modify: `web/src/pages/studio-detail.tsx`（工具栏包一层 + 返回键移最左）

**Interfaces:**
- Consumes: 现有 `CyberButton`（`@/components/cyber`）、`cyberColors`
- Produces:
  ```tsx
  // StudioToolbar.tsx
  interface StudioToolbarProps { tools: ReactNode }
  export default function StudioToolbar({ tools }: StudioToolbarProps): JSX.Element

  // PageHeader.tsx 新增 prop
  leading?: ReactNode   // 渲染在 icon 之后、title 之前
  ```

- [ ] **Step 1: 建 `StudioToolbar.tsx`**

创建 `web/src/components/StudioToolbar.tsx`：

```tsx
// 剪辑室工具栏的**右侧按钮组容器**（spec D3）。
// 为什么只抽这一段、不抽整行：整行的「同排 / 限宽 / 靠右」布局已由 PageHeader 的 toolbarInline 模式实现，
//   在这里重写第二遍会出现两套布局真相。返回按钮也不归这里——它走 PageHeader 的 leading。
// 为什么值得单独抽：用户要求「工具栏布局固定下来成为一个标准组件」，后续页面接入直接用。
import type { ReactNode } from 'react';

export interface StudioToolbarProps {
  /** 右侧按钮组（由调用方给，本组件不关心具体有哪些按钮） */
  tools: ReactNode;
}

export default function StudioToolbar({ tools }: StudioToolbarProps) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>{tools}</div>;
}
```

- [ ] **Step 2: 给 `PageHeader` 加 `leading` prop**

`web/src/components/PageHeader.tsx`：在 `PageHeaderProps` 接口里加（放在 `icon` 之后）：

```tsx
  /** 标题左侧插槽（返回按钮等）。2026-10-09 新增：与 icon 分开——icon 的语义是「平台 logo」
   *  （资料库传 SiteLogo），塞返回按钮会污染那个语义。默认不渲染，故资料库不受影响。 */
  leading?: ReactNode;
```

组件解构里加上 `leading`，并在 `{icon}` **之后**、`{title}` 之前插入：

```tsx
        {icon}
        {leading}
```

⚠️ **不要动 `toolbarInline` / `titleMaxWidth` / 标题容器 flex 的任何逻辑**——那三处上一轮刚改过并验证过。

- [ ] **Step 3: `studio-detail.tsx` 包一层 + 返回键移最左**

在 `PageHeader` 调用处（约 L938-995），把 `toolbar={...}` 的内容整体包进 `StudioToolbar`，并给 `PageHeader` 传 `leading`：

```tsx
      <PageHeader
        leading={(
          <Tooltip title="返回剪辑室">
            <CyberButton icon={<ArrowLeftOutlined />} onClick={goBack} />
          </Tooltip>
        )}
        title={(
          <EditableTitle
            value={work?.name ?? null}
            placeholder={`作品 #${projectIdRaw ?? '?'}`}
            disabled={readOnly}
            maxWidth={560}
            onSave={doSaveName}
          />
        )}
        meta={epText}
        toolbarInline
        titleMaxWidth={620}
        toolbar={<StudioToolbar tools={<>{/* 原有 6 个图标按钮，原封不动搬进来 */}</>} />}
      />
```

然后**从 `toolbar` 里删掉最外层那个 `<>` 与 `</>`**（由 `StudioToolbar` 承担）。

**返回键原来在 toolbar 的最末**（`<Tooltip title="返回剪辑室"><CyberButton icon={<ArrowLeftOutlined />} .../></Tooltip>`，约 L990-992），**整块删掉**，不要重复渲染。

- [ ] **Step 4: 补 import**

`studio-detail.tsx` 顶部加：

```tsx
import StudioToolbar from '@/components/StudioToolbar';
```

- [ ] **Step 5: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```
Expected: 无输出（零错）。

若报 `ArrowLeftOutlined` / `StopOutlined` 未使用——说明 §0「删返回键」那步只删了一半，检查是不是把 `StopOutlined` 也一起留着没用了（它属于 Task 2 的删除范围，**Task 1 里先留着**）。

- [ ] **Step 6: 真机验证**

```powershell
cd d:\Seed\sound-control-tool\web; pnpm dev
```
打开剪辑室页面，确认：
1. 返回键（←）在**最左**，其余 6 个按钮在右侧
2. 点击返回仍弹「有未保存的剪辑点」确认框（`goBack` 逻辑未变）
3. **切到资料库页**（`PageHeader` 的另一个调用方）——布局与改动前**完全一致**，`leading` 不渲染

- [ ] **Step 7: 收尾**

改动留工作区，**不做任何 git 操作**。

---

### Task 2: 删「试听最新一条成品」

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`

**Interfaces:**
- Consumes: 无（纯删除）
- Produces: 无新导出；**清理掉的符号**：`latestProduct` / `previewing` / `previewTip` / `onPreviewAudio` / `audioProducts`

- [ ] **Step 1: 删工具栏里那组按钮**

在 `StudioToolbar` 的 `tools` 里删掉（现约 L981-992，两块：试听按钮 + `previewing !== null` 时的「正在试听《…》」文字与「停止」按钮）：

```tsx
            {/* 「预览音频」（D16）：试听这个作品最新一条成品；只读态下**仍可用**（成品不依赖素材） */}
            <Tooltip title={previewTip}>
              <span>
                <CyberButton icon={<CustomerServiceOutlined />} disabled={latestProduct === null || productsErr !== null} onClick={onPreviewAudio} />
              </span>
            </Tooltip>
            {previewing !== null && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>正在试听《{previewing.title}》</Typography.Text>
                <Button size="small" type="link" icon={<StopOutlined />} onClick={stopPreview}>停止</Button>
              </>
            )}
```

⚠️ **块内的注释「（D16）」连同删掉**——它在描述一个已不存在的能力，留着就是过时声明。

- [ ] **Step 2: 删 `stopPreview` 的定义，但保留 `stop` 的能力**

⚠️ **这是本任务最容易出错的一处**。`stopPreview` 只是 `stop` 的一层包装，全文共**3 处**引用（实测行号，取自 `Select-String -Pattern "stopPreview"`）：

| 行 | 位置 | Step 1 删按钮后是否还在 | 怎么处理 |
|---|---|---|---|
| 439 | 删除成品后「停掉正在播的那条」 | **在**（不随按钮删） | **改成直接调 `stop()`** |
| 836 | 定义 `const stopPreview = () => { stop(); }` | 在 | **整个删掉** |
| 990 | 工具栏「停止试听」按钮的 `onClick` | **随 Step 1 一起没了** | 无需处理 |

先删定义（L836）：

```tsx
  const stopPreview = (): void => { stop(); };
```

再改 L439 的调用处：

```tsx
          if (player.audioId === it.id) stop(); // 正在播的就是这条 → 停掉（判据来自引擎，不再用本地副本）
```

`stop` 已在顶部从 `@/audio-player` 导入（`import { getSnapshot, stop, subscribe, toggle } from '@/audio-player';`），**不要重复导入**。

- [ ] **Step 3: 删 `latestProduct` / `previewing` / `previewTip` / `onPreviewAudio` / `audioProducts`**

删掉这一整块（约 L824-850，包含 `audioProducts` / `latestProduct` / `previewing` / `previewTip` / `stopPreview` / `onPreviewAudio` 全部定义与其上的注释）。

⚠️ **`productSrcs`（约 L806-809）必须保留** —— 它被成品列表里的播放器/`<video>` 用着。

⚠️ `onPreviewAudio` 的函数体里若引用了 `latestProduct`，随它一起删即可。

- [ ] **Step 4: 全局搜残留**

```powershell
cd d:\Seed\sound-control-tool\web
rg -n "latestProduct|previewing|previewTip|onPreviewAudio|audioProducts|stopPreview|CustomerServiceOutlined|StopOutlined" src/pages/studio-detail.tsx
```
Expected: **零命中**。

若有命中：`StopOutlined` 单独判断（它可能只被上面那处用，一并删干净）；其余符号必须清零。

- [ ] **Step 5: 清理 import**

从 `import { Alert, Button, Empty, Input, message, Modal, Progress, Radio, Space, Tag, Tooltip, Typography } from 'antd';` 里删掉不再用到的项（Step 4 搜出来的）。

从 `import { ArrowLeftOutlined, CustomerServiceOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, PlusOutlined, SaveOutlined, StopOutlined } from '@ant-design/icons';` 里删掉 `CustomerServiceOutlined` 与 `StopOutlined`（若 Step 4 确认零使用）。

- [ ] **Step 6: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```
Expected: 零错。**报错集中在未使用的 import / 未定义的引用** —— 按提示逐个删干净。

- [ ] **Step 7: 真机验证**

1. 工具栏**少一个**（试听没了）。⚠️ 别数按钮个数做验收——相邻任务还会继续加减（Task 5 减清空、Task 7 加成品抽屉），中途任何时刻的总数都不是终态。**验收判据是「没有那个耳机图标」**
2. 点击「删除成品」若正在播那条 → 声音会停（验 Step 2 的改法对）
3. 成品列表里**仍能正常播放**（这次删的只是顶部那个冗余入口）

- [ ] **Step 8: 收尾**

改动留工作区，不做 git 操作。

---

### Task 3: 段列表改拖拽排序 + 列宽对齐 + 删除改 icon

**Files:**
- Create: `web/src/components/SortableSegmentRow.tsx`
- Create: `web/src/components/segment-row.css`
- Modify: `web/src/pages/studio-detail.tsx`（段列表换成 `DndContext` 包裹 + 删 `moveSegment`）

**Interfaces:**
- Consumes: 已装的 `@dnd-kit/core`（`DndContext` / `closestCenter` / `PointerSensor` / `useSensor` / `useSensors`）、`@dnd-kit/sortable`（`SortableContext` / `useSortable` / `verticalListSortingStrategy` / `arrayMove`）、`@dnd-kit/utilities`（`CSS`）；`cyberColors` / `cyberFontStack`
- Produces:
  ```tsx
  // SortableSegmentRow.tsx
  export interface SortableSegmentRowProps {
    index: number;                                  // 当前下标（= dnd-kit 的 id）
    total: number;                                  // 总段数（算序号、判首尾）
    seg: { start_sec: number; end_sec: number; label: string | null };
    selected: boolean;
    readOnly: boolean;
    isDragging: boolean;                            // ← 由父组件经 DndContext 的 active 派生
    onSelect: (index: number) => void;
    onDelete: (index: number) => void;
    onLabelChange: (index: number, label: string) => void;
  }
  export default function SortableSegmentRow(props: SortableSegmentRowProps): JSX.Element
  ```

- [ ] **Step 1: 建 `segment-row.css`**

创建 `web/src/components/segment-row.css`：

```css
/* 段列表行：固定列宽 + 自适应标签框（spec D8）。
   为什么必须固定宽度：原来「时间段」「时长」都是「按内容撑宽」的裸 flex 项，
   每行宽度不同 → 跨行对不齐（2026-10-09 用户反馈图 9）。
   ⚠️ 宽度用 flex:0 0 Npx 而非 width —— 单纯 width 在 flex 容器里会被 flex-shrink 压掉。 */

.sr-handle {
  flex: 0 0 24px; display: flex; align-items: center; justify-content: center;
  cursor: grab; color: rgba(255, 255, 255, 0.4); user-select: none;
}
.sr-handle:active { cursor: grabbing; }
/* 拖拽中：行内其它交互元素（尤其是左右拖边把手）不许再吃指针事件，
   否则拖行时会顺手把某段的起止拖动。 */
.sr-row.is-dragging { opacity: 0.6; }
.sr-row.is-dragging .sr-no-drag { pointer-events: none; }

.sr-index { flex: 0 0 48px; }
.sr-span { flex: 0 0 150px; }
.sr-dur  { flex: 0 0 90px; }
.sr-del  { flex: 0 0 36px; }
/* 标签框吃掉剩余空间；min-width:0 是它能被压缩的前提 */
.sr-label { flex: 1 1 auto; min-width: 0; }
```

- [ ] **Step 2: 建 `SortableSegmentRow.tsx`**

创建 `web/src/components/SortableSegmentRow.tsx`：

```tsx
// 剪辑点列表的**单行**（spec D7/D8，2026-10-09 用户反馈图 8/图 9）。
// 两处改动：
//   ① 排序从「上移/下移按钮」换成**拖拽**（dnd-kit sortable）。只有左侧把手能拖（不整行拖）——
//      整行拖会与行内的拖边微调把手打架，用户想微调某段时会误触发整行搬家。
//   ② 列宽固定：序列/时间段/时长/删除按钮各自定宽，只有标签框自适应 —— 解决跨行对不齐。
// ⚠️ 本组件是**纯展示 + 事件回调**，不碰任何业务逻辑（增删改排序由父组件 setSegs 统一走）。
import { DeleteOutlined, HolderOutlined } from '@ant-design/icons';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Input, Tag, Tooltip, Typography } from 'antd';
import { cyberColors, cyberFontStack } from '@/setup/theme';
import './segment-row.css';

const fmtTime = (sec: number): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 60))}:${p(Math.floor(sec % 60))}`;
};

export interface SortableSegmentRowProps {
  index: number;
  total: number;
  seg: { start_sec: number; end_sec: number; label: string | null };
  selected: boolean;
  readOnly: boolean;
  isDragging: boolean;
  onSelect: (index: number) => void;
  onDelete: (index: number) => void;
  onLabelChange: (index: number, label: string) => void;
}

export default function SortableSegmentRow({
  index, total, seg, selected, readOnly, isDragging,
  onSelect, onDelete, onLabelChange,
}: SortableSegmentRowProps) {
  // ⚠️ id 用「起止时间」而非数组下标：删中间行后下标会整体前移，而 dnd-kit 缓存的仍是旧下标 → 落位算错。
  // EditSeg 没有自增 id（改数据结构会牵连保存格式），起止时间是现有字段里最稳定的唯一键。
  // React 自己的渲染 key 仍用 index（在父组件 map 上），两套key 别混。
  const segId = `${seg.start_sec}-${seg.end_sec}`;
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: segId });

  return (
    <div
      ref={setNodeRef}
      className={`sr-row${isDragging ? ' is-dragging' : ''}`}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        background: selected ? cyberColors.redSoft : 'transparent',
        border: `1px solid ${selected ? cyberColors.borderRed : cyberColors.borderWhite}`,
        transform: CSS.Transform.toString(transform),
        transition,
        borderRadius: 0,
      }}
    >
      {/* 拖拽把手：attributes/listeners **只挂这里**，行本身不挂 → 只有抓把手才拖得动 */}
      <span className={`sr-handle sr-no-drag${readOnly ? ' sr-disabled' : ''}`} {...attributes} {...listeners}>
        <HolderOutlined />
      </span>

      <span className="sr-index sr-no-drag" style={{ display: 'flex' }}>
        <Tag color="blue" style={{ marginInlineEnd: 0, borderRadius: 0, fontFamily: cyberFontStack }}>{index + 1}</Tag>
      </span>

      <Typography.Text className="sr-span" style={{ fontFamily: cyberFontStack, color: cyberColors.cyan }}>
        {fmtTime(seg.start_sec)} - {fmtTime(seg.end_sec)}
      </Typography.Text>

      <Typography.Text className="sr-dur" type="secondary" style={{ fontSize: 12, fontFamily: cyberFontStack, color: cyberColors.cyan }}>
        时长 {fmtTime(seg.end_sec - seg.start_sec)}
      </Typography.Text>

      <Input
        className="sr-label"
        size="small"
        placeholder="标签（可空）"
        value={seg.label ?? ''}
        maxLength={100}
        disabled={readOnly}
        onFocus={() => onSelect(index)}
        onChange={(e) => onLabelChange(index, e.target.value)}
      />

      <Tooltip title={readOnly ? '只读态不能删除' : '删除这一段'}>
        {/* 包 span：antd Tooltip 对 disabled 按钮收不到鼠标事件 */}
        <span className="sr-del sr-no-drag" style={{ display: 'flex' }}>
          <Button
            size="small"
            type="text"
            icon={<DeleteOutlined />}
            disabled={readOnly}
            aria-label={`删除第 ${index + 1} 段`}
            onClick={() => onDelete(index)}
            style={{ color: cyberColors.red }}
          />
        </span>
      </Tooltip>
    </div>
  );
}
```

⚠️ `total` 这个 prop 本版**没用上**（首尾判断交给 dnd-kit 的 `arrayMove`）。留着是为了后续若要做「首尾不能拖」时不用改签名；**若 `tsc` 因未使用参数报错（`noUnusedParameters`），把 `total: _total` 改名或在解构里省略该字段**。不要为了消除警告改结构。

- [ ] **Step 3: `studio-detail.tsx` 删 `moveSegment`**

删掉整个函数（约 L545-553）：

```tsx
  const moveSegment = (i: number, dir: -1 | 1): void => {
    setSegs((prev) => { // 走 setSegs → 置脏（顺序变即要保存的改动）
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[i]!; next[i] = next[j]!; next[j] = tmp; // 交换顺序 = 保存时段的先后（sort_order 按数组序）
      return next;
    });
  };
```

⚠️ 删完搜一次 `moveSegment` 确认零残留。

- [ ] **Step 4: 加拖拽结束处理函数**

在 `studio-detail.tsx` 里 `clearAll` 附近（约 L788 之后）加：

```tsx
  // 拖拽排序落定（spec D7）：dnd-kit 给的是「从哪个拖到哪个」，搬运用它的 arrayMove。
  //   必须走 setSegs —— 它内部 setDirty(true)，是「有未保存改动」的唯一来源（同 addSegment/removeSegment）。
  const onDragEnd = ({ active, over }: { active: { id: number | string }; over: { id: number | string } | null }): void => {
    if (over === null) return;
    const from = Number(active.id);
    const to = Number(over.id);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to) return;
    setSegs((prev) => arrayMove(prev, from, to));
  };
```

顶部补 import：

```tsx
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import SortableSegmentRow from '@/components/SortableSegmentRow';
```

⚠️ 若 dnd-kit 的 `DragEndEvent` 类型能导入，优先用它（`import type { DragEndEvent } from '@dnd-kit/core';`）替代上面手写的内联类型；内联类型只是兜底，两者都能过 tsc。

- [ ] **Step 5: 段列表 JSX 换成 `DndContext` 包裹**

把现有段列表（现约 L1316-1337 的 `segments.map(...)` 那一坨）整段替换为：

```tsx
            <DndContext
              sensors={useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              {/* items 用「起止时间」作 id，与 SortableSegmentRow 内部 useSortable 的 idKey 必须是同一个值（见 Step 5 末尾的id 约定） */}
              <SortableContext items={segments.map((s) => `${s.start_sec}-${s.end_sec}`)} strategy={verticalListSortingStrategy}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {segments.map((s, i) => (
                    <SortableSegmentRow
                      key={i}
                      index={i}
                      total={segments.length}
                      seg={s}
                      selected={selected === i}
                      readOnly={readOnly}
                      isDragging={false}
                      onSelect={setSelected}
                      onDelete={removeSegment}
                      onLabelChange={setLabel}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
```

⚠️ **`activationConstraint: { distance: 4 }` 不能省**：不设的话「点一下标签框」会被当成拖拽起点，标签就编辑不了。

⚠️ **id 必须用「段的稳定键」，不能用数组下标**（这是本任务最容易做错的一处，`spec §4.7` 提了风险但没给修法，此处补齐）。

**为什么不能用下标**：`removeSegment` 删中间一行后，后面所有行的下标会整体前移一位，而 dnd-kit 内部缓存的 `activeId`/`overId` 还是旧下标 → 落位算错，表现为「删完再拖，段跳到错误位置」。

**稳定键取 `${start_sec}-${end_sec}`**（`EditSeg` 只有这两个数值字段，没有自增 id；改数据结构会牵连保存格式，代价远大于收益）。

**两处 id 必须字面一致**（Step 2 的 `useSortable` 与 Step 5 JSX 里的 `SortableContext items` 都已经写成这个了，**照抄即可，不要再改成下标**）：

| 位置 | 写法 |
|---|---|
| `SortableSegmentRow.tsx` 组件内 | `useSortable({ id: segId })`，其中 `const segId = \`${seg.start_sec}-${seg.end_sec}\`` |
| 父组件 `SortableContext` | `items={segments.map((s) => \`${s.start_sec}-${s.end_sec}\`)}` |
| React 自己的渲染 `key` | **仍用 `index`**（那是 React 的 key，与 dnd-kit 的 id 是两回事） |

`onDragEnd` 按 id 反查下标（**不能直接 `Number(id)`**，因为 id 现在是字符串）：

```tsx
  const onDragEnd = ({ active, over }: { active: { id: string | number }; over: { id: string | number } | null }): void => {
    const keyOf = (s: EditSeg): string => `${s.start_sec}-${s.end_sec}`;
    const from = segments.findIndex((s) => keyOf(s) === active.id);
    const to = over === null ? -1 : segments.findIndex((s) => keyOf(s) === over.id);
    // ⚠️ 启用 isDragging 时，这行复位**必须放在所有 early-return 之前**：
    //   拖到列表外（over===null）也是一次有效的拖拽结束，漏复位会让那一行永久半透明。
    //   **未启用 isDragging 时把这一行整行删掉** —— 否则 setActiveId 不存在会编译不过。
    // setActiveId(null);
    if (from < 0 || to < 0 || from === to) return;
    setSegs((prev) => arrayMove(prev, from, to));
  };
```

⚠️ 上面那行 `setActiveId(null)` **默认注释掉**（因为 `isDragging` 这一版默认传`false`，没有 activeId state）。真机验证发现需要启用拖拽中禁用时，**连同取消注释 + 加 state + 改 `isDragging={activeId === segId}` 一起做**，别只取消注释。

⚠️ **`onDragEnd` 里读的是闭包里的 `segments`**：拖拽过程中若用户能加段/删段（同一时刻只有一个手势，正常不会），闭包值会过期。**本次不修** —— 拖拽是单指手势，期间不会触发加段/删段。

⚠️ **已知残留风险（不必修，但要真机确认）**：两段的起止**完全相同**时（如两条一模一样的段）键会撞。撞了的表现是「拖其中一条，另一条跟着动」。这不是本次要解决的（用户没提），但 Step 7 第5 条的验证要顺带看一眼。

⚠️ **`isDragging` 现在传 `false`**（占位），**但这一步不算完成** —— `segment-row.css` 里的 `.sr-row.is-dragging` 与 `.sr-no-drag` 规则是为此准备的，现在等于死代码。

**判定口径（Step 7 真机验证的第 4 条就是验收点）**：
- 若拖行时**没有**顺手把某段起止拖动 → `isDragging` 留 `false` 可以，但要在 `segment-row.css` 顶部加一行注释说明「当前未启用，原因：实测不冲突」，别留无解释的死规则。
- 若**发生了**（鼠标压到行内拖边把手） → 补：`const [activeId, setActiveId] = useState<string | null>(null);`，在 `DndContext` 上挂 `onDragStart={(e) => setActiveId(String(e.active.id))}` 与 `onDragEnd` 末尾 `setActiveId(null)`，然后 `isDragging={activeId === segId}`。

**判断依据**：`EditSeg` 里没有拖边把手（那只在轨道上的段区块里），所以大概率**不会**冲突。但别跳过验证直接假设。

- [ ] **Step 6: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```

- [ ] **Step 7: 真机验证（这一批的验证最关键）**

```powershell
cd d:\Seed\sound-control-tool\web; pnpm dev
```
打开一个有 ≥3 段剪辑点的作品，确认：
1. **四列跨行对齐**：序号 / 时间段 / 时长 / 删除按钮，每行都在同一条竖线上
2. 标签框**拉满剩余宽度**（不再被 `maxWidth: 200` 卡住）
3. 拖左把手能换位；**拖别的位置不能换位**
4. **拖行时不会顺手把某段的起止拖动**（若发生就按Step 5 末尾的判定口径补 `activeId` state）
5. **删中间一行后再拖**，顺序不错位（这是「dnd-kit 的 id 必须用稳定键而非下标」那条的验收点，Step 5 已给修法）
6. **造两条起止完全相同的段**，拖其中一条时另一条**不应**跟着动（已知残留风险，见 Step 5）
7. 点标签框能正常输入（`distance: 4` 生效了）
8. 「上移/下移」按钮没了，「删除」是红色垃圾桶图标

- [ ] **Step 8: 收尾**

改动留工作区，不做 git 操作。

---

### Task 4: 轨道双击打点

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`（轨道层加 `onDoubleClick`；段区块中部挡双击；tooltip 文案）

**Interfaces:**
- Consumes: 既有 `addSegment()`（自带 `setSelected(新下标)`）、`xToTime()`、`seek()`、`trackRef`
- Produces: `const onTrackDoubleClick: (e: ReactPointerEvent<HTMLDivElement>) => void`

- [ ] **Step 1: 加双击处理函数**

在 `startScrub` 定义之后（约 L770 附近）加：

```tsx
  // 轨道双击打点（spec D1，2026-10-09 用户反馈图 1）。
  // 为什么显式再seek 一次：双击 = 两次 pointerdown，第一次已 seek；第二次可能被
  //   startScrub 里的「位移< 4px 按单击处理」分支吃掉 → 显式重算一次，段起点才准确。
  const onTrackDoubleClick = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (duration <= 0 || segments.length >= MAX_SEGMENTS) return; // 无时长 / 段满：与按钮同款守卫
    seek(xToTime(e.clientX));
    addSegment();
  };
```

⚠️ `addSegment()` 内部已有 `setSelected(segments.length)`（新段下标 = 追加前长度），**D1 的「加号就选中新段」自动满足，不要再写一遍 `setSelected`**。

⚠️ 段满时给 `message.warning`（与按钮一致的口径）：

```tsx
    if (segments.length >= MAX_SEGMENTS) { message.warning(`最多 ${MAX_SEGMENTS} 段，先删一段`); return; }
```

- [ ] **Step 2: 轨道层挂 `onDoubleClick`**

在轨道层那个带 `ref={trackRef}` / `onPointerDown={startScrub}` 的 `div` 上加：

```tsx
                onDoubleClick={onTrackDoubleClick}
```

- [ ] **Step 3: 段区块中部挡双击**

⚠️ **这一步不做会导致「在段上双击 → 又加一段」**（事件冒泡到轨道层）。

段区块是那个 `onPointerDown={(e) => e.stopPropagation()}` 的元素（在 L1/L2 才渲染，约 L1143 与 L1208 两处 —— **两处都要加**）。在它的 `onPointerDown` 旁边加：

```tsx
                onDoubleClick={(e) => e.stopPropagation()}
```

⚠️ 若该元素上没有 `onPointerDown`，则在它自己的 `onClick` 旁加。**逐个搜 `stopPropagation` 定位这两处**：

```powershell
cd d:\Seed\sound-control-tool\web; rg -n "stopPropagation" src/pages/studio-detail.tsx
```

- [ ] **Step 4: tooltip 文案**

把打点按钮的 Tooltip 从 `'在当前播放头打点'` 改成 `'打点（也可在轨道上双击）'`。

同时改三个禁用分支的文案（L1/L2 与否都要说清）：

```tsx
<Tooltip title={readOnlyMsg ?? (duration <= 0 ? '视频还没加载出时长，无法打点' : segments.length >= MAX_SEGMENTS ? `最多 ${MAX_SEGMENTS} 段，先删一段` : '打点（也可在轨道上双击）')}>
```

- [ ] **Step 5: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```

- [ ] **Step 6: 真机验证**

1. 轨道**空白处**双击 → 新增一段，且**新段被选中**（列表行高亮 + 段区块描边）
2. 段从双击处开始，长度仍是 10 秒（**开销没变**）
3. **在段区块上双击 → 不应新增**（Step 3 生效）
4. 拖边的把手上双击 → 不应新增
5. 全片档位（L0）双击也能加段
6. 时间轴出现「拖动定位」文案那一行仍正常

- [ ] **Step 7: 收尾**

改动留工作区，不做 git 操作。

---

### Task 5: 清空剪辑点按钮挪到缩放行右端

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`

**Interfaces:**
- Consumes: 既有 `clearAll`（`Modal.confirm` + `okType:'danger'`）、`segments.length`、`readOnly`
- Produces: 无新导出

- [ ] **Step 1: 从工具栏删掉按钮**

从 `StudioToolbar` 的 `tools` 里删掉现约 L985-989 那块：

```tsx
            <Tooltip title={readOnlyMsg ?? '清空所有剪辑点'}>
              <span>
                <CyberButton variant="red" icon={<DeleteOutlined />} disabled={readOnly || segments.length === 0} onClick={clearAll} />
              </span>
            </Tooltip>
```

- [ ] **Step 2: 加到缩放档位行右端**

在缩放档位那行（现约 L1079-1087，`缩放 / 全片 / 中景 / 近景 / Ctrl+滚轮提示` 那一行）的**最后**（那句提示文字之后）插入：

```tsx
              {/* 清空剪辑点（2026-10-09 用户反馈图 4）：红色垃圾桶放在工具栏里紧挨返回键与保存键，
                  读起来像「删除当前作品」。挪到缩放行右端：离时间轴语境更近、离返回键更远，误点风险更低。
                  ⚠️ clearAll 内部的 Modal.confirm（okType:'danger'）是仓库铁律，一字未动。 */}
              <Tooltip title={readOnlyMsg ?? '清空所有剪辑点'}>
                {/* 无桥禁用时包 span：antd Tooltip 对 disabled 元素收不到鼠标事件 */}
                <span style={{ marginLeft: 'auto' }}>
                  <CyberButton variant="red" icon={<DeleteOutlined />} disabled={readOnly || segments.length === 0} onClick={clearAll} />
                </span>
              </Tooltip>
```

⚠️ `marginLeft: 'auto'` 把它推到该行最右。若视觉上没贴右（因为那行有 `flexWrap: 'wrap'`），改成给外层那个 div 加 `marginLeft: 'auto'` 而不是 span。

- [ ] **Step 3: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```

- [ ] **Step 4: 真机验证**

1. 工具栏里**没有那个红色垃圾桶**了；它出现在「缩放 全片 中景 近景」那一行的**最右**。⚠️ 同样别数按钮总数（Task 7 还会再加一个成品抽屉按钮），验收判据是「红色垃圾桶在缩放行里、不在工具栏里」
2. 点它仍弹二次确认，文案是「清空所有剪辑点？」，取消/清空两个按钮都对
  3. 无段时按钮是灰的，且**悬停能看到 Tooltip**（验 `span` 垫层）
  4. 只读态下也是灰的，Tooltip 走 `readOnlyMsg`

- [ ] **Step 5: 收尾**

改动留工作区，不做 git 操作。

---

### Task 6: 导出设置搬进对话框

**Files:**
- Create: `web/src/components/ExportSettingsModal.tsx`
- Modify: `web/src/pages/studio-detail.tsx`（删常驻卡片；导出按钮改为开对话框；保留导出期进度条）

**Interfaces:**
- Consumes: 现有 `exportKind` / `exportMode` / `exportFormat` / `readOnly` / `readOnlyMsg` 状态与 setter；`cyberColors`
- Produces:
  ```tsx
  // ExportSettingsModal.tsx
  export interface ExportSettingsModalProps {
    open: boolean;
    onClose: () => void;
    readOnly: boolean;
    readOnlyMsg: string | null;
    kind: 'audio' | 'video' | 'videoAn';
    onKindChange: (v: 'audio' | 'video' | 'videoAn') => void;
    mode: 'separate' | 'merge';
    onModeChange: (v: 'separate' | 'merge') => void;
    format: 'mp3' | 'm4a' | 'wav';
    onFormatChange: (v: 'mp3' | 'm4a' | 'wav') => void;
    /** 确认导出。**只负责收参数后回调**，不自己调接口 —— 导出逻辑留父组件 */
    onConfirm: () => void;
  }
  export default function ExportSettingsModal(props: ExportSettingsModalProps): JSX.Element
  ```

- [ ] **Step 1: 建 `ExportSettingsModal.tsx`**

创建 `web/src/components/ExportSettingsModal.tsx`：

```tsx
// 导出设置对话框（spec D5，2026-10-09 用户反馈图 6）。
// 为什么从常驻搬进对话框：那 4 组控件常驻正文占一整块、离导出按钮又远，而它是低频操作。
// **本组件只管收参数并回调，不调任何接口** —— 导出逻辑（含 SSE 进度）留在父组件，
//   否则这份「进度只发一次」的逻辑会被复制两份。
import { Button, Modal, Radio, Space, Tooltip, Typography } from 'antd';

export interface ExportSettingsModalProps {
  open: boolean;
  onClose: () => void;
  readOnly: boolean;
  readOnlyMsg: string | null;
  kind: 'audio' | 'video' | 'videoAn';
  onKindChange: (v: 'audio' | 'video' | 'videoAn') => void;
  mode: 'separate' | 'merge';
  onModeChange: (v: 'separate' | 'merge') => void;
  format: 'mp3' | 'm4a' | 'wav';
  onFormatChange: (v: 'mp3' | 'm4a' | 'wav') => void;
  onConfirm: () => void;
}

export default function ExportSettingsModal({
  open, onClose, readOnly, readOnlyMsg,
  kind, onKindChange, mode, onModeChange, format, onFormatChange, onConfirm,
}: ExportSettingsModalProps) {
  return (
    <Modal
      title="导出"
      open={open}
      onCancel={onClose}
      okText="开始导出"
      cancelText="取消"
      okButtonProps={{ disabled: readOnly }}
      onOk={onConfirm}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>导出内容</Typography.Text>
          <Tooltip title={readOnlyMsg ?? '导出什么：音频（mp3/m4a/wav）或视频（mp4）'}>
            <span>
              <Radio.Group
                value={kind}
                onChange={(e) => onKindChange(e.target.value as 'audio' | 'video' | 'videoAn')}
                options={[
                  { label: '音频', value: 'audio' },
                  { label: '视频（带音轨）', value: 'video' },
                  { label: '视频（纯视频）', value: 'videoAn' },
                ]}
                disabled={readOnly}
              />
            </span>
          </Tooltip>
        </div>

        <div>
          <Typography.Text strong>怎么切段</Typography.Text>
          <Tooltip title={readOnlyMsg ?? '每一段单独成一个文件，还是全部合成一个'}>
            <span>
              <Radio.Group
                value={mode}
                onChange={(e) => onModeChange(e.target.value as 'separate' | 'merge')}
                options={[{ label: '分多段', value: 'separate' }, { label: '合并成一段', value: 'merge' }]}
                disabled={readOnly}
              />
            </span>
          </Tooltip>
        </div>

        {/* 格式仅音频导出需要（服务端对视频固定 mp4）；切走时 state 不重置 → 切回不丢上次选择 */}
        {kind === 'audio' && (
          <div>
            <Typography.Text strong>格式</Typography.Text>
            <Tooltip title={readOnlyMsg ?? '导出成什么格式'}>
              <span>
                <Radio.Group
                  value={format}
                  onChange={(e) => onFormatChange(e.target.value as 'mp3' | 'm4a' | 'wav')}
                  options={[{ label: 'mp3', value: 'mp3' }, { label: 'm4a', value: 'm4a' }, { label: 'wav', value: 'wav' }]}
                  disabled={readOnly}
                />
              </span>
            </Tooltip>
          </div>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          导出的是当前界面上的剪辑段，不会自动保存
        </Typography.Text>
      </Space>
    </Modal>
  );
}
```

⚠️ `Button` 在上面这段里其实没用到（`okButtonProps` 是 Modal 的 prop）—— **删掉 `Button` 的 import**，否则 `noUnusedLocals` 可能报错。

- [ ] **Step 2: 父组件加对话框 state 与 open/close**

`studio-detail.tsx` 里，在 `const [exporting, setExporting] = useState(false);` 附近加：

```tsx
  const [exportModalOpen, setExportModalOpen] = useState(false);
```

- [ ] **Step 3: 导出按钮改为开对话框**

把工具栏里「导出」那个按钮的 `onClick` 从 `() => void doExport()` 改成：

```tsx
onClick={() => setExportModalOpen(true)}
```

（保持 `loading={exporting}` 与 `disabled={readOnly}` 不变。）

- [ ] **Step 4: 挂对话框，并让「开始导出」关闭它**

在返回的 JSX 里（`<PageHeader .../>` 之后、正文容器之内或之外均可，紧挨着 PageHeader 放最省事）加：

```tsx
      <ExportSettingsModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        readOnly={readOnly}
        readOnlyMsg={readOnlyMsg}
        kind={exportKind}
        onKindChange={setExportKind}
        mode={exportMode}
        onModeChange={setExportMode}
        format={exportFormat}
        onFormatChange={setExportFormat}
        onConfirm={() => { setExportModalOpen(false); void doExport(); }}
      />
```

⚠️ **`onConfirm` 里先关 Modal 再导出** —— 这是 spec §4.5 的决定：Modal 长时间开着会挡住错误信息（失败走 `message.error`）。

- [ ] **Step 5: 删常驻导出卡片，只留导出期进度条**

删掉正文里那整个常驻 `CyberCard`（现约 L1339-1386，含 4 组控件 + 提示 + `Progress`）。

⚠️ **别把进度条一起删掉**。在同一位置改成一个临时的裸进度条（spec §4.5）：

```tsx
        {/* 导出进度：设置已搬进对话框，但进度留在正文（原导出卡片的位置，裸条无卡片外壳）——
            原因是失败信息走 message.error，若进度在对话框里，用户得先关窗才看得到错误（spec D5）。 */}
        {exporting && <Progress percent={exportPercent} />}
```

- [ ] **Step 6: 清理 import**

删掉正文卡片搬走后不再用的 antd 组件（`Space` / `Radio` 若页面别处也不用就要删；`CyberCard` 若别处还用就留）。逐个按 `tsc` 提示来。

⚠️ `Progress` **必须保留**（Step 5 还在用）。

- [ ] **Step 7: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```

- [ ] **Step 8: 真机验证**

1. 点「导出」弹对话框，里面有 4 组控件（内容三选 / 怎么切段 / 格式 / 那句提示）
2. 选「视频（带音轨）」→ **格式那组消失**（服务端对视频固定 mp4）
3. 点「开始导出」→ **对话框立刻关闭**，正文原位置出现进度条
4. 导出中点工具栏导出按钮 → `loading` 生效
5. **故意导一个会失败的**（例如先把导出目录设成不可写）→ 错误 toast **看得见**（这条是 Step 5 那段决策的验收点）
6. 导出成功后成品列表多出新行

- [ ] **Step 9: 收尾**

改动留工作区，不做 git 操作。

---

### Task 7: 已导出成品列表搬进抽屉

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`（删常驻卡片；工具栏加开抽屉按钮）

**Interfaces:**
- Consumes: 既有 `products` / `productsErr` / `productSrcs` / `loadProducts` / `removeProduct` / `CyberAudioPlayer` / `OpenFileDirButton`；范式照 `TaskDrawer.tsx`
- Produces: `const [productsDrawerOpen, setProductsDrawerOpen] = useState(false)`

- [ ] **Step 1: 加 state**

在 `const [products, setProducts] = useState<AudioRow[]>([]);` 附近加：

```tsx
  const [productsDrawerOpen, setProductsDrawerOpen] = useState(false);
```

- [ ] **Step 2: 工具栏加按钮**

在 `StudioToolbar` 的 `tools` 里（打点按钮之后、打开目录按钮之前）加：

```tsx
            <Tooltip title={productsErr !== null ? '成品列表读取失败，暂时打不开' : '查看已导出的成品'}>
              <span>
                <CyberButton icon={<InboxOutlined />} disabled={productsErr !== null} onClick={() => setProductsDrawerOpen(true)} />
              </span>
            </Tooltip>
```

顶部补 `InboxOutlined`：

```tsx
import { ArrowLeftOutlined, CustomerServiceOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, InboxOutlined, PlusOutlined, SaveOutlined, StopOutlined } from '@ant-design/icons';
```

⚠️ `CustomerServiceOutlined` 与 `StopOutlined` 若 Task 2 已删，**这一行不要把它们加回来**。按 Task 2 完成后 `package.json` 里的实际 import 行做增量修改。

- [ ] **Step 3: 常驻卡片整块搬进抽屉**

把正文里那整个「已导出的成品」`CyberCard`（现约 L1390-1460，含 `SectionTitle` / 错误 `Alert` / 空态 `Empty` / 成品行 map）**整段剪出来**，放进：

```tsx
      <Drawer
        title={productsErr !== null ? '已导出的成品（数量未知）' : `已导出的成品（${products.length}）`}
        width={720}
        open={productsDrawerOpen}
        onClose={() => setProductsDrawerOpen(false)}
      >
        {productsErr !== null && <Alert type="error" showIcon message={`成品列表读取失败：${productsErr}`} />}
        {products.length === 0 && productsErr === null
          ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个作品还没有导出过成品" />
          : products.map((it) => (
            /* 原成品行的 JSX 原封不动搬进来，一字不改 */
          ))}
      </Drawer>
```

`Drawer` 需从 antd 导入：

```tsx
import { Alert, Button, Drawer, Empty, message, Modal, Progress, Tooltip, Typography } from 'antd';
```

- [ ] **Step 4: 清理正文里搬走后留下的空白**

正文从「剪辑点列表」到页面底部之间现在可能只剩一个孤立的临时 `Progress`（Task 6 留下的），**保留它**。删掉空的 `CyberCard` 外壳即可。

- [ ] **Step 5: typecheck**

```powershell
cd d:\Seed\sound-control-tool\web; npx tsc --noEmit
```

- [ ] **Step 6: 真机验证**

1. 点工具栏那个新按钮 → 抽屉从右滑出，标题是「已导出的成品（N）」
2. 抽屉里成品行**能正常播放**（`CyberAudioPlayer` 在抽屉里仍工作）
3. 视频成品行仍能用原生 `<video>` 播
4. 📂 打开目录按钮 hover 仍出完整路径
5. 删除成品仍弹二次确认
6. 无成品时抽屉里是 `Empty` 空态，不是纯文本
7. 抽屉开着时执行一次导出 → **抽屉内列表自动刷新**（`doExport` 的 `onDone` 里 `loadProducts()` 未改）
8. 正文里不再有「已导出的成品」卡片，**省出的空间在正文底部**

- [ ] **Step 7: 收尾**

改动留工作区，不做 git 操作。

---

## 8 全局自查（做完 7 个任务后过一遍）

```powershell
cd d:\Seed\sound-control-tool
pnpm -r run typecheck          # 期望：三包都零错
rg -n "moveSegment|latestProduct|previewing|previewTip|onPreviewAudio|audioProducts|stopPreview" web/src
# 期望：零命中
rg -n "上移|下移" web/src/pages/studio-detail.tsx
# 期望：零命中（按钮已换成拖拽）
```

**跨页面回归**（`PageHeader` 是共用组件）：
```powershell
cd d:\Seed\sound-control-tool\web; pnpm dev
```
1. **资料库页**（`library.tsx` 另一个 `PageHeader` 调用方）：标题、logo、工具栏第二行布局与改动前**逐像素一致**
2. **作品墙页**（`studio.tsx`）：正常
3. **剪辑室页**：本次全部改动的实际效果

## 9 交付给用户的自检清单（程序侧验不了的）

以下**必须真机点过**，typecheck 全绿也证明不了：

1. 轨道双击加段：位置对不对？新段是否选中？**在段区块上双击会不会误加**？
2. 拖拽排序：拖把手能拖吗？**拖行时会不会顺手把某段的起止拖动**？**删中间行后再拖会不会错位**？
3. 列宽对齐：四列跨行真的齐吗？窗口变窄时标签框会不会把别的列挤走？
4. 缩放行右端的清空按钮：位置符合预期吗？二次确认还弹吗？
5. 导出对话框：三种导出内容 + 三种格式各跑一遍；**失败时错误信息看得见吗**？进度看得见吗？
6. 成品抽屉：空态、失败态、行内播放器能播、导出后自动刷新。
7. 工具栏：按钮顺序顺手吗？窄窗口下会不会挤爆？