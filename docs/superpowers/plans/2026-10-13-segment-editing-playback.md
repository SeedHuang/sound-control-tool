# 剪辑点精修 实现计划（起收双击 / 时间可编辑 / 区间播放）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让轨道双击能「打起点 + 补终点」、剪辑点列表里的起止时间可编辑（16 毫秒步进）、每个剪辑点能单独区间播放并可循环。

**Architecture:** 三块改动共享同一个数据源 `segments` state，因此天然双向同步，不设额外同步机制。区间播放走页面已有的监视器 `<video>`（定位到起点播、到终点停），**`audio-player.ts` 与 `server/` 零改动**。所有改时间的路径（轨道拖边 / 框里敲数字 / 上下按钮）统一经过同一个 clamp 函数，避免三份判定漂移。

**Tech Stack:** React 18 + TypeScript + Umi 4 + antd 5（`InputNumber` 带步进控制柄）

**Spec:** `docs/superpowers/specs/2026-10-13-segment-editing-playback-design.md`

## Global Constraints

以下约束**每个 Task 都适用**，不再逐条重复：

- **只动 `web/` 包。`server/` 一行不改，`web/src/audio-player.ts` 一行不改。**
- **本仓库前端没有测试框架**（`web/` 下无任何 `.test.ts`），验证手段是 `npx tsc --noEmit` + 浏览器实点。**不要新建测试文件，不要写"跑测试"这类步骤。**
- **最短段长 `MIN_SEG_SEC = 0.1` 秒**，与 `dragEdge`（`studio-detail.tsx:614-616`）、`addSegment`（`:589-590`）、服务端 `parseSegments`（`project-routes.ts:33`）**四处口径必须一致**。
- **吸附网格 `SEG_GRID_SEC = 0.016`（16 毫秒）。**
- **不得改动 `fmtTime` 的输出**（它被轨道时间尺与时长标签共用）。毫秒格式另开函数。
- **`segKey` 的 id 组成不得改动**（`SortableSegmentRow.tsx:57-58`）。不许加数组下标、不许改 occurrence 算法——带下标会让 dnd-kit 在重排后误判「位置又变了」，放下瞬间多播一遍交换动画（2026-10-09 用户实测报过）。
- **`useSensors` 必须继续无条件在组件顶层调用**（`studio-detail.tsx:852-856`）。写进 JSX 三元分支会导致 hook 数变化、整页崩。
- **轨道层三处双击拦截都不能少**：段区块 `:1578`、画轨重试 `:1455`、段图重试 `:1521`（另见 `TimelineWave.tsx:248`）。少一处 → 「双击重试」凭空多一段。
- **工具栏「打点」按钮必须写作 `onClick={() => addSegment()}`**，不能写裸引用 `onClick={addSegment}`（裸引用会把 MouseEvent 当 `atTime` 传进去）。
- **工具栏按钮的 Tooltip 约定**：antd 对 `disabled` 元素收不到鼠标事件，所有可能禁用的按钮都要包一层 `<span>`。
- **改完 .ts/.tsx 后必须运行 `npx tsc --noEmit --pretty`**，有错误先修完再进下一个 Task。
- **Git 禁令**：本计划**不含任何 git 写操作**。每个 Task 的收尾动作统一为「改动留在工作区，由用户决定提交方式」。禁止 `git add` / `git commit` / `git push` / `git checkout`。

---

### Task 1: 毫秒级时间格式化

**Files:**
- Modify: `web/src/time.ts`
- Test: 无（前端无测试框架，按 Global Constraints 用 `tsc` 验证）

**Interfaces:**
- Consumes: 无
- Produces:
  - `fmtTimeMs(sec: number): string` —— 秒 → `mm:ss.mmm`（如 `83.456` 秒 → `"01:23.456"`）
  - `parseTimeMs(text: string): number | null` —— 解析 `mm:ss.mmm` / `ss.mmm` / `m:ss` → 秒；解析失败返 `null`

---

- [ ] **Step 1: 在 `web/src/time.ts` 末尾追加两个函数**

在现有 `fmtTime` 定义之后追加。**不要修改 `fmtTime` 本体**。

```ts
/**
 * 秒 → `mm:ss.mmm`（毫秒级）。
 * 为什么单独开一个而不改 fmtTime：fmtTime 是全站唯一定义，被轨道时间尺与时长标签共用，
 * 改它的输出会把那些地方一起改掉（那是改变既有 UI，不是加功能）。
 * 判据：同一语义区用同一格式 —— 轨道时间尺/时长标签是 mm:ss，列表里可编辑的时间框是 mm:ss.mmm。
 *
 * ⚠️ 浮点陷阱：浮点秒数直接乘 1000 取整会得到 23499999 这类值（1.23 * 1000 = 1229.9999...）。
 *   故先四舍五入到毫秒再拆分，不要对浮点结果直接 Math.floor。
 */
export const fmtTimeMs = (sec: number): string => {
  const totalMs = Math.round(Math.max(0, sec) * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(Math.floor(totalSec / 60))}:${p(totalSec % 60)}.${p(ms, 3)}`;
};

/**
 * `mm:ss.mmm` / `ss.mmm` / `m:ss` → 秒。解析失败（空串、纯文字、多个冒号）返 null。
 * 调用方拿到 null 时的责任：夹到合法边界，不要弹错误——用户敲错一个字符不该被拦下，
 *   越界夹边界比报错顺手（spec D7）。
 * 接受不带分钟的形式（"23.456"）是刻意的：用户很可能只敲秒段。
 */
export const parseTimeMs = (text: string): number | null => {
  const t = text.trim();
  if (t === '') return null;
  const parts = t.split(':');
  if (parts.length > 2) return null;
  const tail = parts.length === 2 ? parts[1] : parts[0];
  // 分钟/秒段必须是纯数字；秒段允许带小数
  if (parts.length === 2 && !/^\d+$/.test(parts[0])) return null;
  if (!/^\d+(\.\d+)?$/.test(tail)) return null;
  const secs = Number(tail);
  const mins = parts.length === 2 ? Number(parts[0]) : 0;
  if (!Number.isFinite(secs) || !Number.isFinite(mins)) return null;
  return mins * 60 + secs;
};
```

- [ ] **Step 2: 跑类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/time.ts"`

Expected: 无任何输出（该文件零错误）。若报错，`fmtTime` 是否被误改是最可能的 cause。

- [ ] **Step 3: 手动验证两个函数的往返一致性（浏览器控制台或临时 tsx 脚本）**

确认这四个值符合预期：
- `fmtTimeMs(83.456)` === `"01:23.456"`
- `fmtTimeMs(1.23)` === `"00:01.230"`（不是 `"00:01.229"`——浮点陷阱）
- `parseTimeMs("01:23.456")` ≈ `83.456`
- `parseTimeMs("abc")` === `null`

- [ ] **Step 4: 确认 `fmtTime` 未被改动**

Run: `git diff web/src/time.ts`

Expected: diff 里**只有新增行**，没有任何 `-` 开头的行（尤其不能有 `-  export const fmtTime`）。

---

### Task 2: 统一 clamp 与 16 毫秒吸附

**Files:**
- Modify: `web/src/pages/studio-detail.tsx:604-625`（`dragEdge` 区域）

**Interfaces:**
- Consumes: 无（`dragEdge` 与 `addSegment` 已存在）
- Produces:
  - 模块级常量 `MIN_SEG_SEC = 0.1`、`SEG_GRID_SEC = 0.016`
  - `snapToGrid(t: number): number` —— 把秒吸附到 16 毫秒网格
  - `clampSegTime(t: number, otherEnd: number, edge: 'start' | 'end'): number` —— 吸附 + 夹进 `[0, duration]` + 保证与另一端至少差 `MIN_SEG_SEC`。`edge='start'` 时结果 ≤ `otherEnd - MIN_SEG_SEC`；`edge='end'` 时结果 ≥ `otherEnd + MIN_SEG_SEC`

---

- [ ] **Step 1: 在 `studio-detail.tsx` 的常量区加两个常量**

加在 `MAX_SEGMENTS`（第 54 行）之后：

```ts
const MIN_SEG_SEC = 0.1;   // 段的最短长度。与 addSegment(:589) 和服务端 parseSegments 同口径，改一处必须三处一起看
const SEG_GRID_SEC = 0.016; // 吸附网格 16 毫秒。列表上下按钮与轨道拖拽共用，保证两边产出同一批数值
```

- [ ] **Step 2: 加 `snapToGrid` 与 `clampSegTime`**

加在 `clamp`（第 61 行）之后——它们是纯函数，不依赖任何 state：

```ts
/**
 * 秒 → 吸附到 16 毫秒网格。
 * 为什么必须吸附：轨道拖边产出的值若不吸附（如 12.3456），与列表上下按钮（±0.016）产出的值
 * 属于两套数，同一个段在两边改几次后会越差越远。
 * ⚠️ 浮点：12.345 / 0.016 在二进制下不一定整除，直接 round 可能差一格。
 *   故用「乘 1000 转整数毫秒 → 除 62.5 → 取整 → 乘回来」的路径，让 16ms 恰好是 1/62.5 秒。
 */
const snapToGrid = (t: number): number => Math.round(t / SEG_GRID_SEC) * SEG_GRID_SEC;

/**
 * 改段起止时间的**唯一**判定处：吸附 → 夹进 [0, duration] → 保证两端至少差 MIN_SEG_SEC。
 *
 * ⚠️ 为什么只有这一份：改时间的入口有三个（轨道拖边、列表框里敲数字、上下按钮），
 *   三处各判一次必然漂移——本仓已为同类教训留过注释（addBlockReason :1065-1081 曾有三份判定互相矛盾）。
 *   Task 4 的列表编辑必须走这个函数，不要在那里另写一份 clamp。
 *
 * @param t        目标时间（秒）
 * @param otherEnd 另一端的当前值（秒）—— start 边传 end_sec，end 边传 start_sec
 * @param edge     被改的是哪一端
 */
const clampSegTime = (t: number, otherEnd: number, edge: 'start' | 'end'): number => {
  const snapped = snapToGrid(t);
  if (edge === 'start') return clamp(snapped, 0, Math.max(0, otherEnd - MIN_SEG_SEC));
  return clamp(snapped, Math.min(duration, otherEnd + MIN_SEG_SEC), duration);
};
```

- [ ] **Step 3: 让 `dragEdge` 走 `clampSegTime`**

把现有 `dragEdge`（第 606-625 行）里 `move` 回调的两行 clamp 替换掉。**只改 `move` 函数体，`up` 收尾与 window 监听部分一字不动。**

```ts
    const move = (ev: PointerEvent): void => {
      const t = xToTime(ev.clientX);
      setSegs((prev) => prev.map((s, i) => { // 走 setSegs → 置脏（拖边微调也是要保存的改动）
        if (i !== index) return s;
        // ⚠️ 统一走 clampSegTime：吸附 16ms 网格 + 夹边界 + 保证两端至少差 0.1s（2026-10-13 spec §2）
        return edge === 'start'
          ? { ...s, start_sec: clampSegTime(t, s.end_sec, 'start') }
          : { ...s, end_sec: clampSegTime(t, s.start_sec, 'end') };
      }));
    };
```

- [ ] **Step 4: 跑类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/pages/studio-detail"`

Expected: 无 `studio-detail` 相关输出。

⚠️ 若报 `duration` 未定义，检查 `clampSegTime` 是否被放在了有 early return 之后。`duration` 是第 101 行左右的 state，纯函数定义在第 61 行之后会通过闭包读到——TS 不会报错，但若实报，则把 `clampSegTime` 挪到 `duration` state 声明之后。

- [ ] **Step 5: 浏览器实点验证吸附生效**

打开剪辑页 → 在轨道上拖动段的左边缘 → 松手 → 看列表里的开始时间，**最后三位毫秒应是 000/016/032/048/064… 这种 16 的倍数**，不是任意小数。

---

### Task 3: 轨道双击改为起收配对

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`（state 区约 103 行、`onTrackDoubleClick` 约 827-840、段区块渲染约 1567-1593）

**Interfaces:**
- Consumes: `MIN_SEG_SEC` / `SEG_GRID_SEC` / `snapToGrid` / `clampSegTime`（Task 2 产出）
- Produces:
  - state `pendingStart: number | null` —— 半成品的起点秒数，`null` 表示当前没有半成品
  - state `setPendingStart: (v: number | null) => void`
  - `onTrackDoubleClick` 新语义（见 Step 3）

---

- [ ] **Step 1: 加 `pendingStart` state**

加在 `segments` state（第 103 行）之后：

```ts
  // 半成品段的起点（秒）。null = 当前没有半成品。
  // 为什么它**不在** segments 里：服务端硬规矩要求 0 ≤ start < end（project-routes.ts:33），
  // 半成品没有终点 → 存不进去 → 保存时自然被跳过（spec D2）。
  const [pendingStart, setPendingStart] = useState<number | null>(null);
```

- [ ] **Step 2: 改 `onTrackDoubleClick`**

把现有函数（第 827-840 行）整段替换：

```ts
  // 轨道双击：**起-收配对**（2026-10-13 spec D1）。
  //   第一次双击 → 落一个半成品（只有起点），轨道上画虚线块；
  //   第二次双击 → 终点定在双击处，半成品转成实心完整段。
  //   已有半成品时双击别处 → **丢弃半成品**、在新位置重起（用户 2026-10-13 拍板）：
  //   「收口」与「误双击丢弃」是同一条路径——离起点不足 MIN_SEG_SEC 就丢弃并在双击处重起，
  //   否则收口成完整段。不另设分支，行为才可预测。
  // ⚠️ atTime 参数仍然必传（不是读 current state）：current 由 <video onTimeUpdate> 异步更新
  //   （周期约 250ms），双击的两次 pointerdown 间隔远小于它 → 不传参会把段打在旧播放头处。
  const onTrackDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const reason = addBlockReason();
    if (reason !== null) {
      message.warning(reason);
      return;
    }
    const t = snapToGrid(xToTime(e.clientX));
    seek(t); // 播放头跟到双击处（复用既有 seek，不动 <video> 的控制逻辑）
    if (pendingStart === null) {
      setPendingStart(t);
      logFe('info', `打起点 project=${projectId} ${t.toFixed(3)}s`);
      return;
    }
    // 离起点太近 → 视为误双击：丢弃半成品，并在**双击处**重起一个
    if (t - pendingStart < MIN_SEG_SEC) {
      logFe('info', `收口失败(过短)→丢弃半成品重起 ${pendingStart.toFixed(3)}→${t.toFixed(3)}s`);
      setPendingStart(t);
      return;
    }
    // ⚠️ **收口时必须再查一次段数上限**（spec D15，2026-10-13 审查 P0-2）：
    //   addBlockReason 是在**进入**时查的，那时 pendingStart 还是 null；等到这一步收口时，
    //   segments.length 可能已经被别的入口（工具栏打点按钮 / 拖拽排序后的新增）顶到 MAX_SEGMENTS。
    //   不查 → setSegs 造出第 51 段 → 界面上看着加成功了，保存时才被服务端 parseSegments 拒。
    if (segments.length >= MAX_SEGMENTS) {
      message.warning(`最多 ${MAX_SEGMENTS} 段，先删一段`);
      setPendingStart(null); // 丢弃半成品，不要让它挂在那儿等下一次双击
      logFe('info', `收口被段数上限拦下 project=${projectId} 已有 ${segments.length} 段，半成品已丢弃`);
      return;
    }
    const start = pendingStart;
    setPendingStart(null);
    setSegs((prev) => [...prev, { start_sec: start, end_sec: t, label: null }]); // 走 setSegs → 置脏
    setSelected(segments.length); // 新段的下标 = 追加前的长度（与 addSegment:592 同款）
    logFe('info', `补终点 project=${projectId} ${start.toFixed(3)}-${t.toFixed(3)}s 共 ${segments.length + 1} 段`);
  };
```

⚠️ 若 `ReactMouseEvent` 未导入，检查文件顶部——现有 `onTrackDoubleClick` 已经用了这个类型（第 827 行），应该已导入。

- [ ] **Step 3: 在段区块之后画半成品块**

在段区块的 `segments.map(...)` 闭合之后（约第 1593 行 `)}` 之后）、播放头之前插入。**它必须在段区块层之上（DOM 顺序靠后），且不能拦双击。**

```tsx
                {/* 半成品段（2026-10-13 spec D1/D2）：只有起点、还没有终点。
                    虚线框 + 半透明，与实心完整段视觉上必须能一眼分开。
                    ⚠️ **刻意不挂 onDoubleClick 拦截**：完整段的区块挂了 stopPropagation（:1578）是**防双击加段**，
                    而半成品需要双击冒泡到轨道层走「收口」——挂了就永远收不了口。
                    宽度从起点画到窗口右缘（终点未定）。不参与保存、不在段列表里。 */}
                {duration > 0 && pendingStart !== null && (
                  <div
                    style={{
                      position: 'absolute', top: RULER_H, height: filmH + waveH,
                      left: `${timeToPct(pendingStart)}%`,
                      width: `${Math.max(0, ((windowStart + levelSpan - pendingStart) / levelSpan) * 100)}%`,
                      boxSizing: 'border-box', pointerEvents: 'none',
                      background: 'rgba(94,246,255,0.06)',
                      border: '1px dashed rgba(94,246,255,0.55)',
                    }}
                  />
                )}
```

- [ ] **Step 4: 确认三处双击拦截仍在**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/pages/studio-detail"` 之后再用编辑器搜索 `stopPropagation`，确认这四处仍在：

- 段区块 `onDoubleClick`（约 1578）
- 画轨重试链接（约 1455）
- 段图重试链接（约 1521）
- `TimelineWave.tsx` 约 248

- [ ] **Step 5: 浏览器实点验证四种情形**

1. 双击轨道 → 出现一个虚线半透明块，从双击处延伸到右缘
2. 再双击右侧远处 → 虚线块变成实心段，出现在列表里，时间正确
3. 双击起 → 立刻在附近再双击（距离不足 0.1 秒）→ 旧的丢弃，在新位置出现新的虚线块
4. 双击起 → 双击远处收口 → 再双击别处 → 又是一个新的虚线块（不该出现两个半成品）

⚠️ **检查三处拦截仍有效**：在画轨加载失败的重试链接上双击，**不应该**多出段。

---

### Task 4: 列表里的起止时间可编辑

**Files:**
- Modify: `web/src/components/SortableSegmentRow.tsx`（`SortableSegmentRowProps` 接口约 15-35、组件函数体、`.sr-span` 文本列约 132-134）
- Modify: `web/src/components/segment-row.css`
- Modify: `web/src/pages/studio-detail.tsx`（传新回调，约 1662-1676 行的 `SortableSegmentRow` 调用处）

**Interfaces:**
- Consumes: `MIN_SEG_SEC` / `SEG_GRID_SEC` / `snapToGrid` / `clampSegTime` / `fmtTimeMs` / `parseTimeMs`（Task 1-2 产出）
- Produces:
  - prop `onTimeChange: (index: number, edge: 'start' | 'end', nextSec: number) => void` —— 父组件实现，负责 clamp 与写 state
  - 段行内的两个 `InputNumber`（`step={0.016}` `precision={3}`）

---

- [ ] **Step 1: 给 `SortableSegmentRowProps` 加两个 prop**

在现有 props 接口里（`onLabelChange` 那一行之后）追加：

```tsx
  /** 改起止时间。**传进来的是已经 clamp 过的合法值**——clamp 与吸附全在父组件做（clampSegTime），
   *  行内不重复判定：本仓已为「同一个判定散在多处必然漂移」留过教训（addBlockReason 三份判定的旧事）。
   *  @param nextSec 已 clamp 到 [0, duration] 且两端至少差 0.1 秒的秒数 */
  onTimeChange: (index: number, edge: 'start' | 'end', nextSec: number) => void;
  /** 段播放按钮点击。**只读态禁用**（spec D13）：只读 = 资料已删除 / 没有视频素材 → <video> 无源可播。 */
  onPlaySegment: (index: number) => void;
  /** 该段是否正在播放（决定按钮图标与行高亮）。 */
  playing: boolean;
  /** 只读原因文案（父组件 :1038 算出）。播放按钮置灰时用它做 Tooltip。 */
  readOnlyMsg: string | null;
```

- [ ] **Step 2: 在父组件实现 `onTimeChange` 与 `onPlaySegment` 的接线**

在 `studio-detail.tsx` 的 `setLabel`（约 600-602 行）之后加：

```ts
  // 列表改时间：唯一入口。clamp 在这里做（clampSegTime），行内不重复判定。
  const setSegTime = (i: number, edge: 'start' | 'end', nextSec: number): void => {
    setSegs((prev) => prev.map((s, k) => {
      if (k !== i) return s;
      return edge === 'start'
        ? { ...s, start_sec: clampSegTime(nextSec, s.end_sec, 'start') }
        : { ...s, end_sec: clampSegTime(nextSec, s.start_sec, 'end') };
    })); // 走 setSegs → 置脏
  };
```

- [ ] **Step 3: 把行里的时间文本列换成两个 `InputNumber`**

把 `SortableSegmentRow.tsx` 第 132-134 行那个 `<Typography.Text className="sr-span">` 整块替换：

```tsx
      {/* 起止时间框：可编辑 + 上下按钮（2026-10-13 spec §4.2）。
          用 antd InputNumber 而不是裸 Input：它自带步进控制柄（上下按钮），
          step/precision 一行就够，不必自己画两个按钮再管焦点。
          ⚠️ **它显示的是纯数字（83.456）而不是 mm:ss.mmm** —— 与 spec D4 不一致，
          裁决见下方「格式取舍」：框内用纯数字，轨道时间尺与「时长」列仍是 mm:ss / mm:ss.mmm。
          ⚠️ 毫秒是必须的（precision={3}）：步进 16 毫秒，只显示到秒的话按了按钮像没反应。
          ⚠️ 类名带 sr-no-drag：拖拽排序时行内其它交互元素不许吃指针事件（segment-row.css:19）。 */}
      <InputNumber
        className="sr-time sr-no-drag"
        size="small"
        value={Number(seg.start_sec.toFixed(3))}
        step={0.016}
        precision={3}
        controls
        disabled={readOnly}
        aria-label={`第 ${index + 1} 段开始时间（秒）`}
        onFocus={() => onSelect(index)}
        onChange={(v) => { if (v !== null && typeof v === 'number') onTimeChange(index, 'start', v); }}
      />
      <span className="sr-time-sep sr-no-drag">→</span>
      <InputNumber
        className="sr-time sr-no-drag"
        size="small"
        value={Number(seg.end_sec.toFixed(3))}
        step={0.016}
        precision={3}
        controls
        disabled={readOnly}
        aria-label={`第 ${index + 1} 段结束时间（秒）`}
        onFocus={() => onSelect(index)}
        onChange={(v) => { if (v !== null && typeof v === 'number') onTimeChange(index, 'end', v); }}
      />
```

⚠️ **格式取舍（2026-10-13 审查 P2-2 裁决）**：`InputNumber` 只认数字，敲不进 `01:23.456` 这种带冒号的字符串。因此：

| 位置 | 格式 | 理由 |
|---|---|---|
| 列表里的两个可编辑时间框 | **纯数字**（`83.456`，单位秒） | 唯一能被 `InputNumber` 接受的格式。要 `mm:ss.mmm` 就得换掉 antd 控件自己实现解析，那是本计划明确不做（spec D4 的实现成本见下） |
| 轨道时间尺 | `mm:ss` | 现状，不动 |
| 「时长」列 | `mm:ss` | 现状，不动（spec §4.2 已裁决） |

**这偏离了 spec D4 写的 `mm:ss.mmm`**。要让框内也显示 `mm:ss.mmm`，唯一路径是放弃 `InputNumber`、改用 `Input` + 自写 `parseTimeMs`/`fmtTimeMs` + 自己画两个步进按钮——即 **spec 里 `fmtTimeMs` / `parseTimeMs` 那两个函数派上用场**（否则它们成为死代码，见 Task 1）。

**处置**：本计划保留 `InputNumber` 路线（用户核心诉求是「上下按钮 ±16 毫秒 + 能直接输入数字」，纯数字已满足；`mm:ss.mmm` 只影响观感）。**代价是 `fmtTimeMs` 暂不使用**——Task 1 仍实现它（spec 已定且它有解析价值，`parseTimeMs` 在 `Input` 路线下需要），但**不许**在注释里宣称「列表用的是 mm:ss.mmm」——那是与实现不符的说法。spec D4 已在下方同步修订。

⚠️ **键入中间态陷阱（2026-10-13 审查 P2-3）**：上面写的 `onChange` 直接提交，会在用户**键入过程中**每敲一个字符就提交一次。用户想把 `83.456` 改成 `90` 时：删掉 `83.4` 的过程中 `onChange` 依次抛 `83.45`→`83.4`→`83`→`8`，每次都走 clamp + 置脏，且 `value` 被 state 反灌 → 输入框内容会被抢走（打 `8` 想输 `80`，`8` 被 clamp 后立刻变回别的值）。

**实施时按此处理**：把 `value` 改成**本地 state**，键入期间由本地 state 接管，失焦（`onBlur`）或按回车时再调 `onTimeChange` 提交。具体做法：

```tsx
// TimeBox 小组件（**新建到 SortableSegmentRow.tsx 内部**，不要另开文件）：
//   本地 state 承接键入中的原始字符串；失焦/回车时 parseTimeMs → 提交 → 复位成格式化值。
const [draft, setDraft] = useState<string | null>(null);
const shown = draft ?? fmtTimeMs(segValue);        // draft 非空时用草稿，否则显示格式化值
```

这同时让 `fmtTimeMs` 有用武场（显示侧），并彻底避开中间态。**不要**用「只在差值是 16ms 整数倍时才提交」那种启发式——它是概率判定，遇到手敲的值恰好落在网格上就会漏提交。

- [ ] **Step 4: 补 CSS**

在 `segment-row.css` 的 `.sr-dur`（第 25 行）附近追加：

```css
/* 起止时间框（2026-10-13）：固定列宽，与 .sr-span 原来的 150px 同量级。
   ⚠️ InputNumber 默认宽度按内容撑，每行数字位数不一时跨行会对不齐 —— 与本文件头部
   「为什么必须固定宽度」是同一个理由，所以这里必须显式定死。 */
.sr-time { flex: 0 0 108px; }
.sr-time-sep { flex: 0 0 16px; text-align: center; color: rgba(255, 255, 255, 0.5); }
/* 行内播放按钮 */
.sr-play { flex: 0 0 36px; }
```

⚠️ **`.sr-span` 已在 Step 3 被替换掉，删掉 CSS 第 24 行那条**（别留死规则）。

⚠️ **「时长」列保持原样，用 `fmtTime`（到秒）不动**（2026-10-13 审查 P1-3 裁决）：时长是给人看的概览信息，不需要毫秒精度；它与两个可编辑时间框是不同语义、不同格式。若日后要精确到毫秒的时长，再单独换 `fmtTimeMs`——但那时**必须同时**把两处改齐，否则同一屏出现「框里到毫秒、时长到秒」两套写法（与 `time.ts` 头部那条「同一语义区用同一格式」的判据一致）。

- [ ] **Step 5: 把新 props 接到父组件的调用处**

把 `studio-detail.tsx` 里 `<SortableSegmentRow ... />`（约 1663-1675 行）的 props 补全，在 `onLabelChange={setLabel}` 之后加：

```tsx
                      onTimeChange={setSegTime}
                      // ⚠️ 这两个 prop 的实现由 Task 5 产出（playSegment / playingSegIndex）。
                      //   Task 4 单独跑 tsc 时它们还不存在 → 此时**先只接 onTimeChange**，
                      //   把 onPlaySegment / playing 两行连同 Task 5 Step 6 一起加（Task 5 的第一步就是补这两行）。
```

⚠️ `playSegment` / `playingSegIndex` 在 Task 4 阶段尚未定义，此刻**不要**写死值占位——那会让 Task 4 的 tsc 静默通过、到 Task 5 时忘了补。按上面注释所说，Task 4 只接 `onTimeChange`，Task 5 Step 6 负责补齐另两个 prop。

- [ ] **Step 6: 导入 `InputNumber`**

`SortableSegmentRow.tsx` 顶部 antd 导入行加上 `InputNumber`：

```tsx
import { Button, Input, InputNumber, Tooltip, Typography } from 'antd';
```

- [ ] **Step 7: 跑类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/components/SortableSegmentRow|src/pages/studio-detail"`

Expected: 两文件零输出。

- [ ] **Step 8: 浏览器实点验证五点**

1. 列表里出现两个时间框，格式 `01:23.456`（三位毫秒）
2. 点开始时间框的向上按钮 → 值 +0.016，毫秒位从 `456` 变 `472`
3. 直接点进框里敲 `01:23.000` 回车 → 值变，且**轨道上那一段的左边缘同步移动**
4. 把开始时间敲到超过结束时间 → **自动夹到 `结束 - 0.1`**（不报错）
5. 把开始时间敲成负数 → **夹到 0**
6. 拖动轨道上段的边缘 → 列表里的时间框同步变化，且毫秒位是 16 的倍数

---

### Task 5: 区间播放与循环开关

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`（state 区、`<video onTimeUpdate>` 约 1382 行、工具栏约 1164-1224）
- Modify: `web/src/components/SortableSegmentRow.tsx`（播放按钮）
- Modify: `web/src/components/segment-row.css`（播放按钮样式，Task 4 已加 `.sr-play`）

**Interfaces:**
- Consumes: Task 4 的 `onPlaySegment` / `playing` props
- Produces:
  - state `loopEnabled: boolean` —— 循环播放总开关
  - state `playingSegIndex: number | null` —— 正在播放的段下标，用于行高亮与区间判定

---

- [ ] **Step 1: 加两个 state**

加在 `segments` state（第 103 行）之后，与 `pendingStart` 同区：

```ts
  // 循环播放总开关（工具栏那颗，spec D11）。影响所有段的播放：开 → 到终点拨回起点继续。
  const [loopEnabled, setLoopEnabled] = useState(false);
  // 正在播放的段下标；null = 没有段在播。驱动两件事：区间结束判定、段行高亮。
  const [playingSegIndex, setPlayingSegIndex] = useState<number | null>(null);
```

- [ ] **Step 2: 实现 `playSegment` 与 `stopSegmentPlay`**

加在 `seek`（约 552-555 行）之后：

```ts
  // 播放某一段（spec D10）：**用监视器这个 <video> 本身**，定位到起点播、到终点停。
  // 为什么不用全局播放器 audio-player.ts：它是 <audio> 元素（audio-player.ts:24），能出声放不出画面，
  // 而用户要「在原来的完整视频上播」= 要画面。只用一个元素 → 声画天然同步，不存在错位。
  // ⚠️ 因此 audio-player.ts 零改动。
  const playSegment = async (i: number): Promise<void> => {
    const v = videoRef.current;
    const seg = segments[i];
    // ⚠️ readOnly **必须**挡住（spec D13，2026-10-13 审查 P0-1）：
    //   只读有两种成因 —— 资料已删除 / 资料没有视频素材（:1038-1042）。两者都意味着 <video> 没有可用源，
    //   此时点播放必然失败。判据是「有没有源可播」，**不是**「改不改数据」（播放确实不改数据）。
    //   行内按钮也据此置灰（Step 7），两处口径必须一致。
    if (v === null || seg === undefined || readOnly) return;
    v.pause(); // 先停，避免两路声音重叠
    v.currentTime = seg.start_sec;
    setPlayingSegIndex(i);
    logFe('info', `段播放 project=${projectId} 第 ${i + 1} 段 ${seg.start_sec.toFixed(3)}-${seg.end_sec.toFixed(3)}s loop=${loopEnabled}`);
    try {
      await v.play();
    } catch (e) {
      logFe('error', `段播放失败 第 ${i + 1} 段: ${(e as Error).message}`);
      setPlayingSegIndex(null);
      message.error('播放失败，请点一下播放器的播放按钮');
    }
  };

  // 手动停止段播放（再点一次播放按钮时走这里）。不影响 <video> 自己的普通播放。
  const stopSegmentPlay = (): void => {
    setPlayingSegIndex(null);
    videoRef.current?.pause();
  };
```

- [ ] **Step 3: 在 `onTimeUpdate` 里加区间判定**

把现有的 `onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}`（约 1382 行）替换：

```tsx
              onTimeUpdate={(e) => {
                const t = e.currentTarget.currentTime;
                setCurrent(t);
                // 区间结束判定（spec D10）。⚠️ timeupdate 周期约 250ms，
                //   所以到点后必须 pause() 再把 currentTime 夹回 end_sec，否则会溢出最多 250ms（听感是「停晚了」）。
                if (playingSegIndex === null) return;
                const seg = segments[playingSegIndex];
                if (seg === undefined) return;
                if (t < seg.end_sec) return;
                const v = e.currentTarget;
                if (t > seg.end_sec) v.currentTime = seg.end_sec; // 夹回去，消掉量化误差
                if (loopEnabled) {
                  v.currentTime = seg.start_sec;
                  void v.play();
                } else {
                  v.pause();
                  setPlayingSegIndex(null); // 播完 → 解除行高亮
                }
              }}
```

⚠️ **用户手动拖动原生控制条跳到段外时**，`t >= end_sec` 成立 → 会触发上面的暂停。这是「用户主动干预」，判定为**解除播放状态**而非强制暂停。上面代码在 `loopEnabled` 为 false 时会 `v.pause()`，这会打断用户的手动拖动。**修法**：加一个 `seeking` 侦听，一旦 `seeking` 事件触发就把 `playingSegIndex` 置 null。加在 state 区：

```ts
  // 用户手动拖动原生控制条 → seeking 事件触发 → 解除段播放状态（spec D10 注）。
  // 不这么做：用户把播放头拖到段外，onTimeUpdate 里的区间判定会**强制暂停**他的手动操作。
  useEffect(() => {
    const v = videoRef.current;
    if (v === null) return undefined;
    const onSeeking = (): void => setPlayingSegIndex(null);
    v.addEventListener('seeking', onSeeking);
    return () => v.removeEventListener('seeking', onSeeking);
  }, [previewSrc]);
```

⚠️ 该 effect 的依赖用 `previewSrc`（换素材时 `<video key>` 变了会重挂，见第 1364 行），**不要用 `playingSegIndex`**（进依赖会导致每帧重挂监听）。

⚠️ **区间判定每帧从 `segments[playingSegIndex]` 读当前值，不快照一份**（spec §4.3 裁决，2026-10-13 审查 P1-4）。所以：播放循环中把该段改短 → 下一次 `onTimeUpdate` 立刻停（开循环则跳回新起点继续）；改长 → 当前这一轮照原样播完、下一轮用新值。**不许**在 `playSegment` 里把起止秒数另存一份 state 做「本轮区间」——那是第二真相，必然漂移。

- [ ] **Step 4: 工具栏加循环开关按钮**

在工具栏按钮组里（约 1174 行「保存」之后、「导出」之前）插入：

```tsx
            {/* 循环播放总开关（spec D11）：开 → 点任何段的播放都循环那一段；关 → 只播一遍。
                type 随 loopEnabled 变（primary 底色）以便一眼看出状态，别只靠 Tooltip。 */}
            <Tooltip title={loopEnabled ? '循环播放：开（点任意段的播放都会循环）' : '循环播放：关'}>
              <span>
                <CyberButton
                  icon={<RetweetOutlined />}
                  type={loopEnabled ? 'primary' : 'default'}
                  aria-label="循环播放开关"
                  onClick={() => setLoopEnabled((v) => !v)}
                />
              </span>
            </Tooltip>
```

- [ ] **Step 5: 补 `RetweetOutlined` 导入**

检查文件顶部 `@ant-design/icons` 的导入行，加上 `RetweetOutlined`（若该行已很长，照现有格式续一行即可）。

⚠️ **图标名已实测存在**（2026-10-13 审查取证：`Test-Path web/node_modules/@ant-design/icons/es/icons/RetweetOutlined.js` → `True`）。本文档早前版本写的备选 `LoopOutlined` **不存在**（同命令返回 `False`）——照那条做会直接编译失败。用 `RetweetOutlined`。

- [ ] **Step 6: 补上 Task 4 Step 5 留下的两个 prop**

回到 `studio-detail.tsx` 里 `<SortableSegmentRow ... />` 的调用处（约 1663-1675 行），在 Task 4 已加的 `onTimeChange={setSegTime}` 之后补两行：

```tsx
                      onPlaySegment={(i) => void playSegment(i)}
                      playing={playingSegIndex === i}
```

- [ ] **Step 7: 在段行里加播放按钮**

`SortableSegmentRow.tsx` 里，在删除按钮（`:151` 那个 `<Tooltip title={readOnly ? ...`）**之前**插入：

```tsx
      {/* 单段播放：播这一段（spec D10）。⚠️ 必须 stopPropagation —— 行的 onClick 会 setSelected(index)，
          不拦会同时触发选中（与删除按钮同款理由，见下方 onDelete 的注释）。
          ⚠️ 只读态**禁用**（spec D13）：只读 = 资料已删除 / 没有视频素材（:1038-1042）→ <video> 没有源可播。
          判据是「有没有源可播」，不是「改不改数据」。与 playSegment 里的守卫同口径。 */}
      <Tooltip title={readOnly ? (readOnlyMsg ?? '资料不可用，无法播放') : (playing ? '停止播放这一段' : '播放这一段')}>
        {/* 包 span：antd Tooltip 对 disabled 按钮收不到鼠标事件（与上方删除按钮同款） */}
        <span className="sr-play sr-no-drag" style={{ display: 'flex' }}>
          <Button
            size="small"
            type="text"
            icon={playing ? <PauseOutlined /> : <PlayCircleOutlined />}
            disabled={readOnly}
            aria-label={playing ? `停止播放第 ${index + 1} 段` : `播放第 ${index + 1} 段`}
            onClick={(e) => { e.stopPropagation(); onPlaySegment(index); }}
            style={{ color: playing ? cyberColors.red : cyberColors.cyan }}
          />
        </span>
      </Tooltip>
```

同时给 props 解构加上 `onPlaySegment` 与 `playing`，并在图标导入里加 `PauseOutlined`、`PlayCircleOutlined`。

⚠️ **`readOnlyMsg` 需要能传进行内**：它在父组件（`studio-detail.tsx:1038`）算出。若 `SortableSegmentRow` 的 props 里还没有它，加一个 `readOnlyMsg: string | null` 并由父组件传入——**不要**在行内自己重算只读原因（本仓已为「同一判定散在多处必然漂移」留过教训，`addBlockReason` 的旧事）。

⚠️ **播放中的那一行要整行高亮**。在行的最外层 `div` 上加：

```tsx
      // 播放中的行整行高亮（spec D12）——与「选中」的红色底不同色，用青色描边区分
      className={`sr-row${isDragging ? ' is-dragging' : ''}${playing ? ' is-playing' : ''}`}
```

并在 `segment-row.css` 追加：

```css
/* 正在播放的段：青色描边。与「选中」的红色底（行内 style 给出）区分开，两个状态可以同时存在。 */
.sr-row.is-playing { box-shadow: inset 0 0 0 1px rgba(94, 246, 255, 0.6); }
```

- [ ] **Step 8: 跑类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | Select-String "src/pages/studio-detail|src/components/SortableSegmentRow"`

Expected: 两文件零输出。

- [ ] **Step 9: 浏览器实点验证六点**

1. 工具栏出现循环按钮，默认灰色（关）
2. 点某一行播放按钮 → 顶部监视器从该段起点开始播，**画面在动、声音在响**
3. 轨道上红色竖线跟着走（应该**自动**发生，不需要额外验证代码）
4. 播到终点 → 停住（不是停晚 250 毫秒），该行高亮消失
5. 打开循环开关 → 再点播放 → 播到终点自动跳回起点继续；关掉 → 只播一遍
6. 播放中点同一行的播放按钮 → 停

⚠️ **回归检查**：播放中手动拖动原生控制条的进度条 → 播放按钮图标应变为「播放」态（`playing` 变 false），且不该被强制暂停。

---

## 收尾自查（全部 Task 完成后逐条核对）

- [ ] `git status` 确认**只有 `web/` 下 4 个文件**被改：`web/src/time.ts`、`web/src/pages/studio-detail.tsx`、`web/src/components/SortableSegmentRow.tsx`、`web/src/components/segment-row.css`
- [ ] `web/src/audio-player.ts` **零改动**
- [ ] `server/` **零改动**
- [ ] `npx tsc --noEmit --pretty` 全量无新增错误
- [ ] `fmtTime` 输出未被改动（`git diff web/src/time.ts` 里只有 `+` 行，无 `-` 行）
- [ ] `segKey` 的 id 组成未被改动
- [ ] `useSensors` 仍无条件在组件顶层
- [ ] 轨道层三处双击拦截仍在，且「双击重试链接不会加段」实测通过
- [ ] `MIN_SEG_SEC` 与 `dragEdge` / `addSegment` / 服务端 `parseSegments` 四处口径一致
- [ ] 无死 CSS 残留（`.sr-span` 若已不用则已删）
- [ ] **只读态点播放按钮 → 置灰 + Tooltip 说明**（spec D13；不是「点了没反应」）
- [ ] **段数满 50 时收口被拦下**（spec D15）：先打到 50 段 → 双击落半成品 → 双击收口 → 提示「最多 50 段」并丢弃半成品，**不得出现第 51 段**
- [ ] `RetweetOutlined` 编译通过（已实测存在；早前版本的备选 `LoopOutlined` 不存在）
- [ ] 浏览器全流程实点：起→收→误双击丢弃→列表敲数字→上下按钮→轨道拖边→单段播→循环播→只读态播放