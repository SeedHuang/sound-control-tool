# 审查过程账 · 剪辑室改版代码往死里审

> 命令：`/review-code-to-death`（code 模式）｜对象：`docs/superpowers/plans/2026-10-09-studio-detail-ui-redesign.md` 的 7 个任务落地代码

## 范围（一旦定下，后续轮次只在其上做增量）

- **范围**：工作区未提交
- **起始 diff**：**6 文件 +427 / -202**（取数命令：`ocr review --preview`）
- **未跟踪新增**（取数命令：`git status --porcelain`）：
  - `web/src/components/ExportSettingsModal.tsx`、`SortableSegmentRow.tsx`、`StudioToolbar.tsx`、`segment-row.css`
- **已跟踪修改**：`web/src/pages/studio-detail.tsx`、`web/src/components/PageHeader.tsx`
- **审查中新增**（由修复引入，一并纳入后续轮次）：`web/src/time.ts`
- **⚠️ 每轮范围 = 上一轮修完后的增量**

## 轮次账

**轮次编号从这张表数，不许口头数。**

| 轮 | 时间 | OCR session id | FILES/COMMENTS | 逐条处置完 | 段二 | 段三 | 本轮核销 |
|---|---|---|---|---|---|---|---|
| 1 | 20:34 | `2ab5611e-dc61-4907-8e06-af233c1dd42b` | 6 / 4 | ✅ 4/4 | 空转（code 模式） | 空转（code 模式） | ✅ |
| 2 | 20:41 | `0b5e9215-010f-4e26-87a8-ea4e1af34322` | 6 / 5 | ✅ 5/5 | 空转 | 空转 | ✅ |
| 3 | 20:47 | `0f224eb1-fa20-4315-b0f4-13bba11b6908` | 6 / 3 | ✅ 3/3 | 空转 | 空转 | ✅ |
| 4 | 20:54 | `3c305df5-7d41-4101-ba2f-ec679bcc5bc6` | 8 / 5 | ✅ 5/5 | 空转 | 空转 | ✅ |
| 5 | 21:05 | `c960b96b-da1b-4b08-b26a-e53c788c9a52` | 8 / 2 | ✅ 2/2 | 空转 | 空转 | ✅ |
| 6 | 21:13 | `948f189e-c1d1-44e9-a095-50f7b5f45d48` | 9 / 4 | ✅ 4/4 | 空转 | 空转 | ✅ |
| 7 | 21:25 | `7e890af8-9af9-4152-8b5d-39080e785e32` | 9 / 2 | ✅ 2/2 | 空转 | 空转 | ✅ |
| 8 | 21:39 | `656d0852-7e5e-43f2-8f64-0de685381de1` | 9 / 2 | ✅ 2/2 | 空转 | 空转 | ✅ |
| 9 | 21:48 | `a44518d3-4bc5-4801-8f94-8711e423da67` | 9 / 3 | ✅ 3/3 | 空转 | 空转 | ✅ |
| 10 | 22:00 | `fe4975ae-d493-4591-a61b-db971a3064a2` | 9 / 2 | ✅ 2/2 | 空转 | 空转 | ✅ |
| 11 | 22:13 | `88308e66-f273-4b00-97a7-f6f7e0eee60e` | 9 / 1 | ✅ 1/1 | 空转 | 空转 | ✅ |
| 12 | 22:19 | `5f8c5700-4af5-4308-b525-8dc28084a8fd` | 9 / **0** | ✅ 0 | 空转 | 空转 | ✅ 复查干净 |
| 13 | 22:24 | `c57568e3-f5b8-4008-917d-f3c7ded59478` | 9 / **0** | ✅ 0 | 空转 | 空转 | ✅ 复查干净 → **停** |

取数命令：`ocr session list`

### 第 11 轮（1 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | `exportBlockReason` 用嵌套三元 + `readOnlyMsg ??兜底`（与我在 `addBlockReason` 上刚修掉的同款） | 已修（改if/else + 去死兜底） |

⚠️ OCR 那条把「嵌套三元」说成「项目规则明令禁止」，已核实 `.trae/rules` **零命中**（无此规则）—— 规则不实，但修法仍采纳（与同文件 `addBlockReason` 一致）。

### 第 12–13 轮（复查轮）

- 第 12 轮 session `5f8c5700`：**0 findings**，OCR 内部第1/2 轮「无新增、提前停止」
- 第 13 轮 session `c57568e3`：**0 findings**，同上
- 按 loop.md §1「修复轮 + 复查轮两轮都干净才停」→ **停**

### 第 10 轮（2 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | `verticalOnly` 手写 dnd-kit 的 `Transform` 形状 → 库升级后会漂移 | 已修（改用库导出的 `Modifier` 类型） |
| 2 | low | 导出按钮无段时仍可点 → 「开对话框→点开始→被关掉→才看到 toast」，白跑一趟（Task 6 引入的退化） | 已修（入口禁用 + Tooltip 说明，新增 `exportBlockReason`） |

### 第 8 轮（2 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | 删除按钮 `onClick` 未 stopPropagation → 冒泡到行的 `onSelect`，而 `removeSegment` 刚置 `selected=null`，被改回已前移的 `index` → 删一行高亮跳到另一行 | 已修 |
| 2 | medium | 关抽屉只 `stop()`，管不到原生 `<video>` 成品；`Drawer` 默认 `destroyOnHidden=false` → 关闭后视频仍播且无停止控件 | 已修（加 `destroyOnHidden`） |

### 第 9 轮（3 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | 拖拽行无 z-index elevated → 被 DOM 顺序在后的兄弟盖住，看起来「从被挤开那行底下划过」 | 已修（`zIndex: isDragging ? 1 : 0`） |
| 2 | low | 缺 `setActivatorNodeRef` → dnd-kit 回退量整行矩形（把手只24px）→ 起手有错位挫感 | 已修（挂到把手上） |
| 3 | low | 无 `modifiers` → `applyModifiers` 默认空数组、两轴自由漂移，单列列表里横向漂像jank | 已修（内联 `verticalOnly`，不引新依赖） |

## 各轮处置摘要（逐条明细见每轮的「本轮改了什么」）

### 第 1 轮（4 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | critical | `useSensors` 写在 JSX 三元 false 分支内 → 打第一段时 hook 数 0→2，React 抛「Rendered more hooks」整页崩 | 已修（提到组件体顶层） |
| 2 | medium | 段 id 用纯 `${start}-${end}` 会撞键（同一播放头打点两次）→ 拖错行 | 已修（id 加下标后缀） |
| 3 | medium | `addSegment` 读闭包 `current` state，而它由 `onTimeUpdate` 异步更新 → 双击打到旧位置 | 已修（`addSegment(atTime?)`） |
| 4 | low | `isDragging`/`total` 死路径，且 CSS 注释写了**未验证**的「实测不冲突」 | 已处置（注释去虚假陈述；死路径第 2 轮彻底处理） |

### 第 2 轮（5 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | `isDragging` 父组件写死 false → CSS 规则不可达 | 已修（改用 `useSortable` 自带返回值，比 plan 设想的 activeId state 更简单） |
| 2 | low | `onTrackDoubleClick` 标注 `ReactPointerEvent`，实挂 `onDoubleClick`（类型是 MouseEvent） | 已修 |
| 3 | low | 段 id 模板字符串三处各写一份，漂移即静默排错行 | 已修（导出 `segKey` 单一来源） |
| 4 | low | `total` 声明未用（死参数） | 已修（删除） |
| 5 | medium | `.sr-handle` 缺 `touch-action: none` → 触屏拖拽被浏览器滚动接管、静默取消 | 已修 |

### 第 3 轮（3 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | `fmtTime` 重复 | **部分采纳**（见下） |
| 2 | low | 轨道双击打点未查 `readOnly` → 只读态能加段并置脏 | 已修（两处守卫） |
| 3 | medium | 成品抽屉入口在 `productsErr` 时禁用 → 抽屉里的错误 Alert 不可达，改版前「失败可见」能力丢失 | 已修（去掉禁用） |

**第 3 轮第 1 条的处置取整**：OCR 说「三份副本」，实测 `studio-detail` 与 `SortableSegmentRow` 两份**逐字符相同**（真重复，同屏显示，漂移会让列表时间与轨道刻度对不上）→ 抽 `@/time`；但 `CyberAudioPlayer` 那份是 `m:ss`（分钟**不**补零），与 `mm:ss` 是**不同规格**，合并会把播放器时间码从 `1:05` 改成 `01:05`，属改变既有 UI → **不合，并在两处写明为何刻意保持两份**。

### 第 4 轮（5 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | medium | 导出双提交回归：`doExport` 无重入守卫，对话框 OK 按钮连点 → 两个并发 job、重复成品 | 已修（`exportingRef` 同步 ref + `finish()` 统一复位） |
| 2 | low | 清空按钮被移进视频条件块内 → 视频加载失败时按钮消失（功能退化） | 已修（移到段列表上方，无条件渲染） |
| 3 | low | 轨道内两处「重试」链接未挡 dblclick → 双击会误加段 | 已修 |
| 4 | low | 只有 PointerSensor → 键盘无法排序（原来是两个可 Tab 的 Button） | 已修（加 KeyboardSensor + sortableKeyboardCoordinates） |

### 第 5 轮（2 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | 第 4 轮第 3 条的**漏网同类**：`TimelineWave.tsx` 里的第三处「重试」链接同样未挡 dblclick | 已修 |
| 2 | low | 「能不能加段」判定与文案在三处各写一份 | 已修（抽 `addBlockReason()` 单一判定） |

### 第 6 轮（4 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | `ExportSettingsModal` 的 `readOnly`/`readOnlyMsg` 疑似不可达兜底 | **关闭**（该组件独立于父页面推导，`??` 真会走到；补注释防误删） |
| 2 | low | `addBlockReason` 里 `readOnlyMsg ?? …` 是死兜底（`readOnly ≡ readOnlyMsg !== null`） | 已修（第 7 轮把固定文案改回直接返回 `readOnlyMsg`） |
| 3 | medium | `productsErr` 只在抽屉内可见，入口按钮与成功态长得一样、唯一线索是 hover tooltip | 已修（入口加常驻红色 Badge + 警示色图标） |
| 4 | low | 关抽屉不停播，而常驻「停止」按钮已在 Task 2 删掉 → 页面上无停止控件 | 已修（`onClose` 里 `stop()`） |

### 第 7 轮（2 条）

| # | 级别 | 问题 | 处置 |
|---|------|------|------|
| 1 | low | 第 6 轮第 2 条的修法过头：固定文案让打点按钮丢失具体只读原因，与同页其他按钮说法不一 | 已修（撤回固定文案，直接 `return readOnlyMsg`） |
| 2 | medium | `onDragEnd` 换位后不结算 `selected`（它存下标）→ 高亮落到别的段上| 已修（`setSelected(to)`，落实 spec D9） |

**第 7 轮第 2 条的次要风险经取证不成立**：OCR 提到「拖拽结束的 click 可能覆盖选中」。实测 dnd-kit 在 `core.esm.js:1506` 注册了 `documentListeners.add(EventName.Click, stopPropagation, { capture: true })` —— document capture 先于 target，故行上的 `onClick` 不会被触发，不需要额外的「短时标志吞click」。

### 本轮改了什么（第 1 轮，示例）

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `studio-detail.tsx` | `sensors` 提到组件体顶层 | Hooks 规则违规 → 整页崩 |
| `studio-detail.tsx` | `addSegment(atTime?)` + 双击显式传参 | `current` 异步更新导致位置错 |
| `SortableSegmentRow.tsx` | `segId` 加下标 | 撞键 |
| `segment-row.css` | 删「实测不冲突」这句未验证断言 | 虚假陈述 |

## 段二 / 段三（每轮相同，空转）

- **段二 · 文档**：**空转** —— 本命令是 code 模式，按loop.md 段序只跑段一。`git status --porcelain` 实测改动全是 `.tsx`/`.ts`/`.css`，**零 `.md`**。不算已跑
- **段三 · 对账**：**空转** —— 同上。**不算已跑**

## 重复劳动

**现象**：第 4 轮第 3 条（轨道内重试链接未挡 dblclick）在第 5 轮又报了一次同类（`TimelineWave.tsx` 里的第三处）。

**为什么没发现**：第 4 轮我只搜了 `studio-detail.tsx` 内的 `stopPropagation`（命中 2 处），没搜整个 `web/src`。轨道子树里还有 `TimelineWave.tsx` 这个组件自带的重试链接。

**代价**：多一轮 OCR（约 6 分钟）。

**根治**：同族扫描要按「**事件冒泡的边界**」搜，不是按「我改过的文件」搜 —— 轨道层是容器，容器内任何可交互子元素都要挡。

## 最终结论

- **共 13 轮**，每轮修的问题数：4 / 5 / 3 / 5 / 2 / 4 / 2 / 2 / 3 / 2 / 1 / 0 / 0 = **33 条**（其中 critical 1、medium 9、low 23）
- **最终状态：核销干净** —— 第 12、13 轮连续两轮 OCR 0 findings（`5f8c5700` / `c57568e3`，各 9 文件），且 OCR 自带内部复查亦「无新增、提前停止」
- **本轮有没有做到「清单核销干净」**：有。逐轮 33 条全部独立取证后处置完毕，无一条以「轮数够了」为理由放过
- **验证**（数字均为实测）：
  - `pnpm -r run typecheck` → server / web / desktop **三包零错，EXIT=0**
  - `rg "moveSegment|latestProduct|previewing|previewTip|onPreviewAudio|audioProducts|stopPreview|CustomerServiceOutlined|StopOutlined" web/src` → **零命中**
  - `npx tsc --noEmit --listFiles | Select-String "time.ts"` → 在检查范围内（新增的 `web/src/time.ts` 没被 `include` 漏掉）
  - `git status --short` → 4 改 + 6 新增（含本审查账本目录），**HEAD 仍是`bc88d65`，未做任何 git 写操作**
- **段二/ 段三**：**空转**（本命令是 code 模式，按 loop.md 段序只跑段一；`git status --porcelain` 实测改动全是 `.tsx`/`.ts`/`.css`，**零 `.md`**）。空转**不算已跑**
- **未验证（下一轮/下个 session 别当成已验证）**：
  - **全部真机验证项一条未做**：`web/` 无单测、vitest 在本环境 stuck 在 `[queued]`，typecheck 证明不了交互行为。plan §9 的 7 条交付自检清单（双击打点位置 / 拖拽手感 / 列宽对齐 / 清空按钮位置 / 导出对话框三种内容 / 成品抽屉空态与播放 / 工具栏窄窗）仍待用户点过
  - `EditableTitle` 保存动画仍未验（本session 遗留，非本次审查范围）
  - `is-dragging` 的 `pointer-events: none` 效果、拖拽行 z-index 抬升、`verticalOnly` 约束手感 —— 均为**按代码逻辑与库源码取证**后的修复，**未经真机确认**
  - `destroyOnHidden` 的代价（每次开抽屉重挂播放器、重发请求）未实测