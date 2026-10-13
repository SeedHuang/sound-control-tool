# 剪辑点精修：起收双击、时间可编辑、区间播放（sound-control-tool）

- 日期：2026-10-13
- 状态：**待实施**
- 目标仓库：`d:\Seed\sound-control-tool`（只动 `web/` 包，`server/` 一行不改）
- 相关设计：`2026-10-09-studio-detail-ui-redesign.md`（剪辑室页面交互改版，本文档在其基础上改）
- 触发来源：用户 2026-10-13 提出的三个问题

---

## 0 给下一个 session 的读前须知

**这份文档是自足的**：接手时不需回看对话，照着 §3 决策表 + §5 实施顺序做即可。

**本文档只在 `web/` 包内改动，`server/` 一行不改。** 半成品段的「保存时跳过」是天然成立的（它根本不在提交的那个数组里），不需要后端配合。

**前端没有测试框架**：`web/` 下不存在任何 `.test.ts` / `.test.tsx`，仓库里只有 `server/` 与 `desktop/src/shared/` 用 vitest。因此本次改动的验证手段是 `npx tsc --noEmit` 加浏览器实点，**不要为了「有测试」而新建测试文件**。

---

## 1 背景：用户提的三个问题

| # | 用户原话 | 根因 |
|---|---|---|
| ① | 「我在轨道上打点时候，双击只能打一个开始点，却不能设置他的结束点」 | 双击的实现是 `onTrackDoubleClick` → `addSegment(t)`，而 `addSegment` **一次造一整段**：起点=双击处，终点=起点后固定 10 秒。没有「只有起点」这个中间状态 |
| ② | 「在剪辑点列表上把开始和结束时间做成可编辑的，可以通过输入数字直接改，可以通过上下按钮改，上下步数为16毫秒」 | 列表里的时间列是纯文本 `fmtTime(start) - fmtTime(end)`（`SortableSegmentRow.tsx:132-134`），不是控件。改时间只有一条路：在轨道上拖那 8px 拖柄 |
| ③ | 「每个剪辑点都可以单独进行播放，从剪辑点的开始播到剪辑点的结束，剪辑的工具栏上多添加一个循环播放按钮」 | 页面上没有任何「区间播放」的概念。`addSegment` 造出的段只能整段编辑，没有单段试听入口 |

三条互相独立，但共享同一个数据源（`segments` state），因此一并落地。

---

## 2 现状事实核对（实施前必读，避免照着过时描述改）

| 事实 | 位置 | 为什么重要 |
|---|---|---|
| 段的最短长度是 **0.1 秒**，三处同口径 | `dragEdge`（`studio-detail.tsx:614-616`）、`addSegment`（`:589-590`）、服务端 `parseSegments`（`project-routes.ts:33`） | 改 clamp 时三处口径必须一起看，别只改前端一处 |
| 服务端硬规矩：`0 ≤ start < end`，否则 `PUT /api/projects/:id` 拒 | `project-routes.ts:26-45` | **半成品段存不进去** → 它必须活在 `segments` 之外 |
| 保存是**全量替换**：`putWork(projectId, { name, segments })` | `studio-detail.tsx:366` | 半成品不在 `segments` 里 → 保存自动跳过，**不需要写任何跳过逻辑** |
| 段列表排序 id 由 `segKey(start, end, occurrence)` 决定 | `SortableSegmentRow.tsx:57-58`，父组件三处走 `segKeyAt()` | id **绝不能带数组下标**，否则重排时多播一遍交换动画（2026-10-09 用户实测报过） |
| `useSensors` 必须在组件顶层无条件调用 | `studio-detail.tsx:852-856` | 写进 JSX 三元分支 → hook 数变化 → 整页崩 |
| 轨道层有三处双击拦截不能少 | 段区块 `:1578`、画轨重试 `:1455`、段图重试 `:1521`、`TimelineWave.tsx:248` | 少一处 → 「双击重试」凭空多一段 |
| `addSegment` 必须写成 `onClick={() => addSegment()}` | `studio-detail.tsx:1193` | 裸引用会把 MouseEvent 当 `atTime` 传进去 |
| 轨道上的播放头由 `<video onTimeUpdate>` 驱动 | `:1382`、`:1597-1599` | **段播放若走监视器 `<video>`，红色竖线自动跟着走，不需要额外代码** |

---

## 3 决策清单

| # | 决策 | 值 |
|---|---|---|
| D1 | 轨道双击语义 | **起-收配对**：第一次双击落半成品（只有起点），第二次双击补终点转实心段。已有半成品时双击别处 = **丢弃半成品**、在新位置重起 |
| D2 | 半成品段的可见性 | **只画在轨道上**（虚线框、半透明、无终点拖柄），**不进段列表、不参与保存、不参与段数上限计数** |
| D3 | 工具栏「打点」按钮 | **保持原样**（一次造 10 秒完整段）。它服务「快速加一段」意图，与「精确打起点」是两种意图，混起来行为不可预测 |
| D4 | 列表时间框的显示格式 | **纯数字秒**（`83.456`），**不是** `mm:ss.mmm`。原设计写 `mm:ss.mmm`，但它要求输入框显示带冒号的字符串——antd `InputNumber` 敲不进冒号，唯一实现路径是放弃它、自写解析与步进按钮（多写约 40 行 + 自己管焦点/边界）。用户核心诉求是「上下按钮 ±16 毫秒 + 能直接输入数字」，纯数字已满足。**新增 `fmtTimeMs`/`parseTimeMs` 仍落地**（键入草稿的显示侧用得上 `fmtTimeMs`；日后改回 `mm:ss.mmm` 路线时 `parseTimeMs` 现成）。轨道时间尺与「时长」列维持现状 `mm:ss` 不动 |
| D5 | 上下按钮步进 | **±16 毫秒**，**不支持** Ctrl/Shift 变速（用户未要求，YAGNI） |
| D6 | 最短长度 | **保持 0.1 秒**。放宽到 16 毫秒会让轨道上的拖柄挤在一起几乎抓不住 |
| D7 | 数值越界处理 | **夹到边界，不报错**（比弹错误提示顺手） |
| D8 | 轨道拖拽吸附 | **吸附到 16 毫秒网格**。否则拖出来的值与按钮加减出来的值会越差越远 |
| D9 | 双向同步 | 轨道拖边 / 列表敲数字 / 点上下按钮，改的都是同一个 `segments` state → **天然同步**，不设额外同步机制 |
| D10 | 段播放的实现载体 | **监视器 `<video>` 本身**（定位到 `start_sec` 播，到 `end_sec` 停）。**`audio-player.ts` 一行不改** |
| D11 | 循环开关粒度 | **工具栏一个总开关**，影响所有段的播放。放工具栏而非每行一个，避免每行挤一个按钮 |
| D12 | 播放时播放头 | 自动跟随（`<video>` 时间驱动，见 §2 最后一行），**无需额外代码** |
| D13 | 只读态下的段播放 | **禁用**。只读有两种成因（`studio-detail.tsx:1038-1042`）：资料已删除 / 资料没有视频素材。两种都意味着**`<video>` 没有可用源**，点播放必然失败 → 按钮置灰 + Tooltip 说明。**判据是「有没有源可播」，不是「改不改数据」**（播放确实不改数据，但没源时按钮会静默失败，那比禁用更糟） |
| D14 | 半成品与只读态 | 只读态下**双击不落半成品**（`addBlockReason` 已在 `onTrackDoubleClick:831-835` 里挡住），不存在「只读态存着半成品」的状态 |
| D15 | 段数上限的计数口径 | 半成品**不计入** `MAX_SEGMENTS`（它在 `segments` 之外）。但**收口时**若 `segments.length` 已达 50，必须先提示「最多 50 段，先删一段」并丢弃半成品——否则 `setSegs` 会造出第 51 段，保存时被服务端拒 |

### 3.1 关于 D10 的取舍说明

设计过程中曾考虑过「用全局播放器 `audio-player.ts` 播区间」，已否掉，理由两条：

1. **要画面就得用 `<video>`**。`audio-player.ts` 是 `<audio>` 元素（`audio-player.ts:24`），能出声放不出画面。而用户明确要求「在原来的完整视频上播」——即要画面。
2. **只用 `<video>` 就不会有声画错位**。若两者同时播（监视器出画面、全局播放器出声），两套播放头各走各的，循环几遍后能明显看出画面和声音对不齐。只用一个元素，此问题从根上不存在。

`audio-player.ts` 保持零改动，是本决策的直接收益。

---

## 4 逐块设计

### 4.1 轨道双击：起-收配对

**新增 state**：`pendingStart: number | null`，表示半成品的起点（秒），`null` = 当前没有半成品。

**轨道上多画一种块**，与现有段区块区分开：
- 虚线边框、半透明底色
- **只有左侧拖柄，没有右侧拖柄**（还没有终点可拖）
- 宽度从起点画到轨道右缘（终点未定）

**`onTrackDoubleClick` 的新逻辑**：

```
t = xToTime(e.clientX)   // 现有 atTime 传参机制不变，见 §2 那条 250ms 异步坑
若 pendingStart === null:
    落半成品：pendingStart = snap(t)；在轨道上把播放头 seek 到 t
否则:
    若 snap(t) - pendingStart < MIN_SEG_SEC（0.1）: 提示「段太短，至少 0.1 秒」，**丢弃半成品**、返回
    否则: 追加一个完整段 { start: pendingStart, end: snap(t) }；清空 pendingStart
```

**「误双击丢弃」的具体口径**（用户 2026-10-13 拍板）：已有半成品时，**任何一次双击**都走「收口」分支——若双击处离起点不足 0.1 秒，则丢弃半成品并在**双击处**重新起一个（而不是报错中止）。这样「误双击」与「正常收口」是同一条路径，不需要额外分支，行为也可预测。

⚠️ **半成品存在期间，`addSegment`（工具栏打点按钮）不受影响**——它照旧造完整段；此时轨道上会同时存在一个半成品和一个新完整段，两者不冲突（半成品独立于 `segments`）。但打完完整段后，半成品**仍然留着**，直到下次双击收口或被丢弃。

**双击半成品块本身**：它画在段区块层之上，沿用现有的 `onDoubleClick={(e) => e.stopPropagation()}` 拦截会**导致无法收口**——所以半成品块**必须放行双击**，冒泡到轨道层走收口逻辑。

### 4.2 列表时间可编辑

**新增格式化函数**（`time.ts`，与现有 `fmtTime` 并列，不改它）：

```ts
/** 秒 → `mm:ss.mmm`。用于列表时间框在**非键入态**的显示值（键入中间态用 draft 原文，见下）。 */
export const fmtTimeMs = (sec: number): string => ...
/** `mm:ss.mmm` 或 `ss.mmm` → 秒。解析失败返 null（调用方夹到边界）。 */
export const parseTimeMs = (text: string): number | null => ...
```

⚠️ `fmtTime` 是全站唯一定义且被轨道时间尺、时长标签共用，**不要改它的输出**（会把 `01:05` 变成 `00:01:05` 之类）。新增函数即可。

**行内布局**（`SortableSegmentRow.tsx`）：把现在那一个 `.sr-span` 文本列换成两个时间输入框（antd `InputNumber`，`step={0.016}`、`precision={3}`、`controls`）：

| 控件 | 说明 |
|---|---|
| 开始时间框 | 值 = 秒（纯数字，`precision={3}`），固定宽度 |
| 结束时间框 | 同上 |
| 中间的连接符 | `→`，纯展示 |

⚠️ **键入中间态必须挡**（手法 4 输入空间枚举发现）：`InputNumber` 在用户键入过程中会逐字符抛值（想把 `83.456` 改成 `90`，会依次抛 `83.45`→`83.4`→`83`→`8`）。若每次 `onChange` 都提交，`value` 被 state 反灌会把输入内容抢走（打 `8` 想输 `80`，`8` 被 clamp 后立刻变别的值）。**做法**：框内用**本地 draft state** 承接键入中的原始字符串，失焦或回车时才提交；`fmtTimeMs` 在这里用于把非草稿态格式化成显示值。**不用**「差值是 16ms 整数倍才提交」那种启发式——那是概率判定，手敲的值恰好落在网格上时会漏提交。

⚠️ **「时长」列保持原样**（继续用 `fmtTime`，到秒）。时长是概览信息，不需要毫秒精度；它与两个时间框是不同语义区。若日后要让时长也精确到毫秒，**必须同时**把两处改齐——否则同一屏出现「框里到毫秒、时长到秒」两套写法，违反 `time.ts` 头部那条「同一语义区用同一格式」的判据。

⚠️ **`.sr-span` 那条 CSS 要删掉**（第 24 行）。留死规则会让下一个人以为还有东西在用它。

**统一 clamp 函数**（放在 `studio-detail.tsx`，三条改动路径共用）：

```ts
const MIN_SEG_SEC = 0.1;      // 与 dragEdge / addSegment / 服务端 parseSegments 同口径
const SEG_GRID_SEC = 0.016;   // 16 毫秒吸附网格

/** 把任意时间夹到合法值：吸附网格 → 夹进 [0, duration] → 保证与另一端至少差 MIN_SEG_SEC。
 *  拖边、敲数字、点上下按钮三条路径全部走它，避免三份判定漂移。 */
const clampSegTime = (t: number, otherEnd: number, edge: 'start' | 'end'): number => ...
```

⚠️ **「三条路径共一份 clamp」是本块的核心不变式**。现有代码已经有同类教训（`addBlockReason` 曾有三份判定互相漂移，见 `studio-detail.tsx:1065-1081` 的注释），不要再复制一次。

**轨道拖边改造**（`dragEdge`，`:606-625`）：`move` 回调里把 `xToTime(ev.clientX)` 的结果先过 `SEG_GRID_SEC` 吸附，再走 clamp。

### 4.3 区间播放 + 循环

**新增 state**：
- `loopEnabled: boolean` —— 工具栏循环开关，默认 `false`
- `playingSegIndex: number | null` —— 正在播的段下标，用于行高亮

**播放一段的核心逻辑**（放 `studio-detail.tsx`，不碰 `audio-player.ts`）：

```
playSegment(i):
    若 videoRef.current 为 null → 返回
    pause()                                  // 先停，避免两路声音
    video.currentTime = segments[i].start_sec
    await video.play()
```

**区间结束与循环**：在现有 `<video onTimeUpdate>`（`:1382`）里加判定——它现在只做 `setCurrent`，现在多一句：

```
若 playingSegIndex !== null 且 current >= segments[playingSegIndex].end_sec:
    video.pause()
    video.currentTime = end_sec          // 夹回去，消掉 timeupdate 的量化误差
    若 loopEnabled:
        video.currentTime = start_sec
        video.play()
    否则:
        setPlayingSegIndex(null)          // 播完 → 解除行高亮
```

⚠️ **`timeupdate` 的触发间隔约 250 毫秒**，所以不加「夹回去」这一步会溢出最多 250 毫秒，听感上是「停晚了」。

⚠️ **`playingSegIndex` 不能进 `onTimeUpdate` 的判断依据之外**——用户手动拖动原生控制条跳到段外时，`current >= end_sec` 成立 → 会触发暂停。这属于「用户主动干预」，判定为**解除播放状态**（`setPlayingSegIndex(null)`）而非强制暂停，让用户能自由操作。实现时用 `seeking` 事件或简单地：区间外时直接 `setPlayingSegIndex(null)` 且不干预 `<video>` 自身状态。

⚠️ **正在播放的那一段被改时间时的行为**（2026-10-13 审查 P1-4 裁决，明确写死，不留给执行者猜）：

| 场景 | 行为 |
|---|---|
| 播放循环中把该段改**短**（`end_sec` 调到当前播放位置之前） | `onTimeUpdate` 下一次触发时 `current >= end_sec` 成立 → 立即停止（开循环则跳回新的 `start_sec` 继续）。**这是正确行为**：区间被改短了就该停 |
| 播放循环中把该段改**长**（`end_sec` 调大） | 当前这一轮**照原区间播完**，之后每轮用新值。不会中途改道 |
| 播放循环中把该段改**长/短**，且用户正拖动轨道拖柄 | 同上——`onTimeUpdate` 每帧从 `segments[playingSegIndex]` 读当前值，读到的自然是新值。无需额外机制 |

**为什么不需要额外机制**：区间判定是**每帧从 state 读**的，不是启动时快照一份。所以「改时间」与「播放」天然同步——这与 §3 D9「双向同步靠同一份 state」是同一个道理。**不许**在 `playSegment` 里把 `start_sec`/`end_sec` 存进另一份 state 做「本轮区间」——那会立刻制造一份漂移的第二真相。

**每行加一颗播放按钮**（`SortableSegmentRow.tsx`）：`▶` / `❚❚` 两态，点它调 `playSegment(i)`，播放中再点一次停。
- 事件必须 `stopPropagation()`（与删除按钮同款理由，见 `SortableSegmentRow.tsx:160-162`），否则会同时触发行的 `onSelect`
- **只读态禁用播放按钮**（D13）：只读意味着资料已删除或没有视频素材，`<video>` 没有源可播 → 置灰 + Tooltip 说明原因。判据是「有没有源可播」，不是「改不改数据」

**工具栏加循环开关**（`studio-detail.tsx:1164-1224` 那组按钮里）：图标按钮 + 中文 Tooltip「循环播放」，`type` 随 `loopEnabled` 变化（开=primary 底色）以便一眼看出状态。

⚠️ 工具栏现有约定：所有按钮禁用时都包一层 `<span>`，否则 antd Tooltip 收不到鼠标事件。循环开关不禁用，但 Tooltip 写法与相邻按钮保持一致。

---

## 5 实施顺序

按依赖关系排，每步做完都能独立验证：

| 步 | 内容 | 涉及文件 | 验证点 |
|---|---|---|---|
| 1 | 毫秒级格式化 | `time.ts` | 加 `fmtTimeMs` / `parseTimeMs`，不改 `fmtTime` |
| 2 | 统一 clamp + 16ms 吸附 | `studio-detail.tsx` | `clampSegTime` + `SEG_GRID_SEC`；`dragEdge` 改走它 |
| 3 | 轨道双击起收配对 | `studio-detail.tsx` | `pendingStart` state + 半成品块渲染 + 收口/丢弃逻辑 |
| 4 | 列表时间框 | `SortableSegmentRow.tsx`、`segment-row.css` | 两个 `InputNumber`；三条改动路径都走 `clampSegTime` |
| 5 | 区间播放 + 循环 | `studio-detail.tsx`、`SortableSegmentRow.tsx` | `playSegment` / `onTimeUpdate` 区间判定 / 工具栏循环开关 |

**全部改动只在 `web/` 包内。`server/` 一行不改，`audio-player.ts` 一行不改。**

---

## 6 自查清单

**改完逐条核对，任何一条不满足即不合格**：

- [ ] `fmtTime` 的输出**没有**被改动（轨道时间尺与时长标签仍显示到秒）
- [ ] 三条改时间的路径（轨道拖边、框里敲数字、上下按钮）**都**经过同一个 clamp 函数
- [ ] 最短长度仍是 0.1 秒，与 `dragEdge` / `addSegment` / 服务端 `parseSegments` 四处口径一致
- [ ] 轨道拖拽产生的值都在 16 毫秒网格上
- [ ] `segKey` 的 id 组成**未改动**（没加数组下标、没改 occurrence 算法）
- [ ] `useSensors` 仍无条件在组件顶层调用
- [ ] 轨道层三处双击拦截（段区块 / 画轨重试 / 段图重试）**都还在**
- [ ] 工具栏「打点」按钮仍写作 `onClick={() => addSegment()}`，不是裸引用
- [ ] `server/` 与 `audio-player.ts` **零改动**（`git status` 核对）
- [ ] **只读态点播放按钮 → 置灰且有 Tooltip 说明**（D13 的实测项；不是「点了没反应」）
- [ ] **段数满 50 时收口被拦下**（D15 的实测项）：先打到 50 段 → 双击落半成品 → 双击收口 → 应提示「最多 50 段」并丢弃半成品，**界面上不得出现第 51 段**
- [ ] `RetweetOutlined` 已实测存在（`Test-Path web/node_modules/@ant-design/icons/es/icons/RetweetOutlined.js`）
- [ ] `.sr-span` 死 CSS 已删；「时长」列仍是 `fmtTime` 到秒
- [ ] `npx tsc --noEmit` 零新增错误
- [ ] 浏览器实点：双击起→收、误双击丢弃、列表敲数字、上下按钮、拖边、单段播、循环播、只读态播放