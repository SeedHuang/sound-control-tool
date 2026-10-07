# CP2077 音频播放器设计（sound-control-tool）

- 日期：2026-10-07
- 状态：**已实施**（2026-10-07）
- 实施结果：见文末 §15
- 目标仓库：`d:\Seed\sound-control-tool`（`web/` 包 + `server/` 包）
- 相关设计：`docs/superpowers/specs/2026-10-07-cyberpunk-ui-overhaul-design.md`（CP2077 视觉层，本设计复用其令牌与原语）
- 设计过程留档：`.superpowers/brainstorm/991-1791380051/content/`（交互式选型截图，**不进 git**）

## 1 背景与目标

**动因**：当前项目所有音频播放面都用**浏览器原生 `<audio controls>`** —— 样式是浏览器给的（浅色/圆角/系统控件），与刚完成的 CP2077 赛博改造**完全脱节**；且原生播放器在深色界面上视觉突兀。

**目标**：自研一个 CP2077 风格的音频播放器组件，替换全部音频播放面，并把「原生能给的能力」补齐，同时**加酷**（曲线波形、赛博配色）。

**范围界定（用户拍板）**：
- ✅ 覆盖**全部音频播放场景**（3 处，见 §2）
- ❌ **不含视频**：`<video controls>` 的行（library 素材预览、studio-detail 视频成品行）保持原生不动
- ❌ 不含 `WorkPreview` 的 hover 快速预览（它是「移开即卸载」的特殊纪律，见 §8.3）

## 2 现状：3 处音频播放面

| # | 位置 | 当前形态 | 说明 |
|---|---|---|---|
| 1 | `web/src/pages/studio.tsx:334` | `<audio controls src={audioFileUrl(it.id)}>` | 「无作品（安全网）」成品行试听 |
| 2 | `web/src/pages/studio-detail.tsx:1422` | `<audio controls src={productSrcs.get(it.id)}>` | 「已导出的成品」行试听 |
| 3 | `web/src/pages/studio-detail.tsx:1434` | `<audio ref={previewAudioRef}>`（**无 controls**） | 顶栏「预览音频」按钮驱动的隐藏播放器 |

## 3 决策清单（全部经用户逐项拍板）

| # | 决策 | 值 | 用户选定方式 |
|---|---|---|---|
| D1 | 覆盖范围 | 全部音频场景（上表 3 处）；视频行不动 | 选项「全部音频场景」 |
| D2 | 播放纪律 | **全局单实例**：同一时刻只播一个，播新的自动停旧的 | 选项「全局单实例」 |
| D3 | 顶栏预览按钮 | **复用同一引擎实例**（不再用独立隐藏 `<audio>`） | 选项「复用同一实例」 |
| D4 | 架构 | **单例播放引擎 + 订阅钩子**（模块级唯一媒体元素） | 选项「路 A：单例引擎」 |
| D5 | 布局 | **单行**（高 42px）：播放键 · 曲线波形 · 时间码 · 音量 | 先选 B 再要求压成一行 |
| D6 | 播放器内标题 | **不显示**（行外已有标题／格式） | 选项「不显示」 |
| D7 | 波形形态 | **平滑曲线兼任进度条**；已播=青实线、未播=暗青；红竖线=播放头；点击跳转 | 选项「C」 |
| D8 | 已播区背景 | **青色背景带**（`rgba(94,246,255,.14)`） | 选项「C（青）」 |
| D9 | 波形数据 | **真实峰值**（非装饰花纹）→ 需新增服务端路由 | 选曲线时确认（见 §10 范围扩张说明） |
| D10 | 播放键 | **青描边空心切角块**；暂停态=青三角、播放态=白双竖条 | 选项「B」 |
| D11 | 键盘快捷键 | 空格=播放/暂停、←/→=后退/前进 5 秒 | 多选「键盘快捷键」 |
| D12 | 倍速 | 0.5 / 1 / 1.5 / 2 | 多选「倍速播放」 |
| D13 | 时间刻度 | 波形底部主/次刻度 + 中线 | 用户指出前版漏画 |
| D14 | 图标库 | **不引入新库**，用已有 `@ant-design/icons` | `pick-ui-library` 结论（清单不含图标库） |
| D15 | 与「预览声音开关」的关系 | **共享一个总开关**：工具栏那个开关 = 全局声音开/关，hover 预览与播放器都听它 | 选项「共享一个总开关」 |
| D16 | 音量 / 静音 | 静音=**复用既有** `studio_preview_muted` 设置键（不新建第二份状态）；音量=新增设置键 `studio_player_volume`（持久化） | D15 的直接推论 |

## 4 架构：单例播放引擎

### 4.1 为什么要单例（而不是每行一个 `<audio>`）

现有 `WorkPreview` 的模式是「每张卡自己持一个媒体元素 + 模块级 `currentEl` 互斥」。它适用于「每张卡自己播自己」；但本设计有两条硬要求把它排除：
1. **D2 全局单实例** —— 要跨页面、跨列表互斥；
2. **D3 顶栏按钮复用同一实例** —— 按钮不在任何列表里，若各自持元素，「谁在播」的状态要散落多处维护。

单例引擎把这两件事变成天然成立：**全应用只有一个媒体元素、一份播放状态**。

### 4.2 引擎接口（`web/src/audio-player.ts`）

```ts
export type PlayerState = {
  audioId: number | null;   // 当前装载的成品 id（null = 未装载）
  playing: boolean;
  loading: boolean;         // 起播中（等 play() Promise）
  currentTime: number;
  duration: number;
  volume: number;           // 0..1
  muted: boolean;
  rate: number;             // 0.5 / 1 / 1.5 / 2
  error: string | null;
};

export function loadAndPlay(audioId: number, src: string): void; // 装载 + 播放（D2：先停旧的）
export function toggle(audioId: number, src: string): void;      // 同一 id → 播/停切换；不同 id → 装载并播
export function stop(): void;
export function seek(sec: number): void;
export function setVolume(v: number): void;
export function toggleMute(): void;
export function setRate(r: number): void;
export function subscribe(cb: () => void): () => void;
export function getSnapshot(): PlayerState;
```

**订阅用 `useSyncExternalStore`**（React 18 内建）—— 避免引入状态管理库；引擎是模块级单例，天然适配外部 store 模型。

### 4.3 与 hover 预览互斥（D2 的完整落地）

单实例只覆盖「播放器自己」。但 `WorkPreview`（studio 卡片 hover）也会出声 —— 若不管，两者会重叠。处置：引入一个**极小的「谁在出声」注册表**（复用 `WorkPreview` 里 `currentEl` 的既有思路）：

```ts
// web/src/silence.ts
export function registerSource(pause: () => void): () => void; // 返回注销函数
export function silenceOthers(self: () => void): void;          // 停掉除 self 外的所有源
```

- 播放引擎起播前调 `silenceOthers(enginePause)`；
- `WorkPreview` 起播前调 `silenceOthers(预览元素 pause)`（改造其现有 `currentEl` 逻辑，行为不变）。

**这是本设计唯一需要改动 `WorkPreview` 的地方**，且只改「互斥」一处，不动它的三条既有纪律。

### 4.4 全局声音开关（D15/D16 的落地）

**一个开关，一个真相**。工具栏那个「预览声音开关」从「只控 hover 预览」升级为**应用级声音总开关**：

| 项 | 归属 | 持久化键 |
|---|---|---|
| **静音（开/关）** | 共享 —— hover 预览与播放器**都读同一份** | `studio_preview_muted`（**既有键，不加新的**） |
| **音量（0..1）** | 播放器专有（hover 预览无音量概念） | `studio_player_volume`（新增键；`getSettings`/`putSettings` 是通用 KV，**零服务端改动**） |

**语义**：开关关 = 全局无声（hover 预览静音 + 播放器静音）；开关开 = 两者都可出声；音量滑块只在「开」时有意义。

**⚠️ 一个必须处理的体验缺口**：该键**默认值就是静音**（`studio_preview_muted` 缺省 `'1'`，是 spec clip-works D12 为「hover 自动播放不该突然出声」定的，**不改这个默认**）。于是用户**首次点播放键会没声音**。处置：

- 播放器的音量区**如实显示静音态**（划掉的喇叭 + 文案色 `cyberColors.textMuted`），让「为什么没声」一眼可见；
- 静音态下用户点播放 → 给**一次轻提示**（如播放器内浮现一行「声音已关闭 · 点喇叭开启」），**不自动改用户设置**（擅自出声比没声更糟）；
- 工具栏开关的 Tooltip 文案从「预览声音」改为「声音」（它现在是全局的了）。

**绝不新建第二份静音状态**：播放器不得有自己的 `muted` —— 那正是 D15 要消除的两份真相。

## 5 组件

### 5.1 `CyberAudioPlayer`（`web/src/components/CyberAudioPlayer.tsx`）

```tsx
interface Props {
  audioId: number;    // 成品 id（audio_items.id）
  src: string;        // 音频流地址（调用方传 audioFileUrl(id)，保持既有鉴权口径）
  durationHint?: number | null; // 行外已知的 duration_sec —— **仅用于时间码在元数据加载前的占位显示**
}
```

> `durationHint` **不发给服务端**：波形那边服务端直接读 `audio_items.duration_sec`（DB 权威），客户端再传一份时长就是第二份真相。这里它只服务于 UI 占位。

**形态（单行，高 42px）**：

```
[▶]  [ ~~~~ 曲线波形（撑满剩余宽度，兼任进度条）~~~~ ]  0:42/1:52  |  🔊
```

- 左侧播放键：切角块，**暂停态显示青三角 / 播放态显示白双竖条**（D10）
- 中间：曲线波形（D7/D8/D13），撑满剩余宽度
- 右侧：时间码（青 `#5EF6FF`，`cyberFontStack`）→ 分隔线 → 音量控件
- **无标题/格式**（D6）
- 非当前装载行：显示静态波形（未播状态），播放键为三角

**状态来源**：`useSyncExternalStore(subscribe, getSnapshot)`；`state.audioId === audioId` 才是「当前行」，否则显示静止态。

### 5.2 `PlayerWaveform`（`web/src/components/PlayerWaveform.tsx`）

Canvas 自绘，职责单一：**给峰值数组 + 时长 + 播放位置 + 画布宽度，画出曲线波形**。

- 曲线：把峰值数组平滑成曲线（相邻点二次贝塞尔 / `quadraticCurveTo`），不画成柱状
- 已播/未播：以播放头 x 坐标分段 —— 已播段青实线 + 青色背景带（D8），未播段 `rgba(94,246,255,.28)`
- 播放头：红 `#F75049` 竖线，贯穿全高
- 刻度（D13）：底部主刻度（长线）+ 次刻度（短线）+ 中线，颜色沿用 `rgba(255,255,255,.22)` / `.10`
- 交互：点击/拖动任意位置 → `seek`（`pointerdown` + `pointermove`，与既有时间轴手势口径一致：只定位，不缩放）
- `devicePixelRatio` 处理（2x 屏不糊）—— 照抄 `TimelineWave.tsx` 的既有做法
- 峰值未就绪 / 失败：显示**静态基线 + 可重试**，不画假波形（宁可空，不可撒谎）

### 5.3 键位作用域（D11 的边界）

键盘快捷键**只在「播放器所在页面可见时」生效**，且必须避让既有快捷键冲突：

- 空格 / ←→：**仅当焦点不在输入框、文本域、可编辑元素内**时响应（否则会抢输入）
- 页面若已有同名快捷键（studio-detail 的时间轴似有键盘交互，落地时逐一核对），以**不冲突**为准，冲突则让位既有
- 监听挂在组件的 `useEffect` 上，卸载即解绑

## 6 服务端：成品波形峰值

### 6.1 为什么必须新增（不能复用素材那条链路）

素材波形链路 `ensureWavePeaks` 有**两处硬绑定**，都无法套用到成品：

1. **寻址键不同**：素材峰值按 `importId` 命名（`wavepeak-<importId>-L0.json`），而成品是 `audio_items` 的行（各自 `file_path`）。若拿成品的 `source_import_id` 去调，会**与素材自己的 L0 峰值撞名**（同一 `importId` 会同名）→ 互相覆盖。
2. **取样策略不同**：素材 L0 用 `N=48000`（约 1 点/秒）适配「21 分钟整片」；而一条成品可能只有 **10 秒**，同样 N 只能得到 10 个点 —— 画不出波形。

### 6.2 新增：`ensureAudioWavePeaks`（`server/src/media/wave-peaks.ts` 内新增，复用既有纯函数）

**复用**（不重写）：`wavePeakArgs`（`derived-args.ts`）、`parseRmsStderr`、`buildWavePeakJson`、`tail`（`derived-images.ts`）—— 这三条纯函数是链路的全部实质逻辑，成品与素材**共用同一份**。

**新增部分**：

| 项 | 值 / 规则 |
|---|---|
| 输入 | `audioId`、`audioPath`（`audio_items.file_path`）、`durationSec`（来自 `audio_items.duration_sec`，缺失则 ffprobe）、`derivedDir`、`tempDir`、`db` |
| 产物名 | `waveaudio-<audioId>.json`（新 stem，与 `wavepeak-` 完全分开，避免 §6.1 的撞名） |
| 取样点数 | **固定目标点数** `TARGET_POINTS = 1200`：`nsamples = clamp(round(durationSec * 48000 / TARGET_POINTS), 1, 48000)` —— 时长越短窗口越小，保证不论多长的成品都得到 ~1200 个点，波形密度稳定 |
| 段 | 整条（等价素材链路的 `seg = null`，不加 `-ss/-t`） |
| 命中判定 | 文件存在 + size>0 + `v === FILM_META_V` + `sig` 逐字相同 + `points` 非空 —— **照抄 `readPeakIfFresh` 的口径**（不复用其函数体，因为它把 `sig` 绑到 `waveShapeSig(level)`；成品的 sig 用下面的新签名） |
| 签名 | `waveaudioShapeSig()` = `v<FILM_META_V>\|points=1200\|n=<nsamples 推导规则版本>` —— 改 `TARGET_POINTS` 或取样规则时自动判失效 |
| 失败 | 与素材链路同款码：`NO_FFMPEG` / `FFMPEG_FAIL` / `PROBE_FAIL` / `SRC_CHANGED`（落盘前变局复核）；**拿不到 RMS 行 → 明确失败，绝不落空 points**（仓库既有铁律） |

### 6.3 新增路由：`GET /api/audio/:id/wavepeak`

| 项 | 规则 |
|---|---|
| 位置 | `server/src/ytdlp/ytdlp-routes.ts`（成品相关路由的既有归属地） |
| 鉴权 | 与既有 `/api/media/:importId/wavepeak` **完全一致**（本机 origin / 本机 referer / query token 三件套） |
| `id` 校验 | 非正整数 → 404（照抄同文件既有口径） |
| 行不存在 | 404 |
| 文件不存在 | 404（`FILE_MISSING` 语义，照抄成品文件路由） |
| 成功 | `200 application/json`，body = 七字段 `{v, sig, level?, seg?, t0, stepSec, points}`。**成品波形不分档**：`level` 固定 `0`、`seg` 固定 `0`、`t0` 固定 `0`，`stepSec = durationSec / points.length`（用**实际点数反推**，与素材链路同口径） |
| 缓存头 | `no-store`（同素材峰值：URL 恒定，长缓存会拿到旧波形） |

### 6.4 成品删除时清理波形缓存

`DELETE /api/audio/:id` 的既有流程里，**追加**删除 `waveaudio-<id>.json`（按 `audioId` 精确名，不涉及前缀匹配，无 `film-1-` vs `film-11-` 那类坑）。

**IO 语义**：删缓存文件失败**不让接口失败**（仓库既有铁律：删文件失败只记日志，DB 行删了即达「删了」语义）。

## 7 前端 API

`web/src/api.ts` 新增：

```ts
/** 成品波形峰值（整条，不分档，无 rev）：成品内容不可变——删了重导出会得到新的 audioId，故不需要 cache-buster。
 *  服务端回 no-store，同样保证不拿旧波形。 */
export function audioWavepeakUrl(audioId: number): string
```

> **为什么不像 `wavePeakUrl` 那样带 `rev`**：素材的 `rev` 是给「同一 importId 的素材被换源」用的；成品不存在换源（id 唯一、内容不可变），传一个恒定的 `rev` 只是死参数。**不复刻无用的对称性**。

## 8 落地到 3 处播放面

### 8.1 `studio.tsx` 孤儿成品行

`<audio controls src={audioFileUrl(it.id)} />` → `<CyberAudioPlayer audioId={it.id} src={audioFileUrl(it.id)} durationHint={it.duration_sec} />`

### 8.2 `studio-detail.tsx` 成品行（音频分支）

同 8.1。视频分支（`media_kind === 'video'`）**保持原生 `<video controls>` 不动**。

### 8.3 `studio-detail.tsx` 顶栏「预览音频」按钮

- **删除**隐藏 `<audio ref={previewAudioRef}>`（D3：复用单例引擎）
- `onPreviewAudio` 改为 `toggle(latestProduct.id, audioFileUrl(latestProduct.id))`
- 移除 `previewAudioRef` 与 `stopPreview` 里的元素操作（改调引擎的 `stop()`）
- 「正在试听」的视觉标记（现有 `previewingId`）改为读引擎状态（`state.audioId === latestProduct.id && state.playing`），**不再本地维护第二份真相**
- 删除成品时若正在播它 → 调引擎 `stop()`（现有逻辑保留，实现换成引擎调用）

> ⚠️ 这三处必须用**同一份**「谁在播」状态（引擎），不得保留任何本地的 `previewingId` 式副本 —— 两份真相必然漂移。

### 8.4 `studio.tsx` 工具栏「预览声音开关」升级为总开关

- Tooltip 文案 `预览声音：${muted ? '关' : '开'}` → `声音：${muted ? '关' : '开'}`（D15：它现在管全局）
- `muted` 状态与引擎**共享**：开关切换后，播放器立即跟随（引擎订阅到即可）；播放器内点喇叭也回写这个状态
- 既有 `getPreviewMuted()` / `setPreviewMuted()` **继续复用，不改键名、不改默认值**（改键名会让已存用户设置丢失）
- `unlockAudio()`（打开声音那一下的用户手势解锁）**保留** —— 播放器首次起播同样受益

## 9 视觉规格

| 元素 | 值 |
|---|---|
| 行高 | 42px |
| 容器底 | `cyberColors.bgLayout` `#0E0E17`（与所在行一致） |
| 播放键 | 切角块（`var(--cyber-clip)`），青描边 `rgba(94,246,255,.9)` + 深底 `rgba(0,0,0,.75)`；暂停态图标青 `#5EF6FF` 实心三角，播放态图标白 `#fff` 双竖条 |
| 曲线（已播） | `#5EF6FF`，线宽 2.2 |
| 曲线（未播） | `rgba(94,246,255,.28)`，线宽 2 |
| 已播背景带 | `rgba(94,246,255,.14)`（D8 用户选「青」） |
| 播放头 | `#F75049`，宽 1.6，贯穿全高 |
| 中线 / 主刻度 / 次刻度 | `rgba(255,255,255,.07)` / `.22` / `.10` |
| 时间码 | `#5EF6FF` + `cyberFontStack`，格式 `0:42/1:52` |
| 音量 | 图标 `rgba(255,255,255,.5)`，hover 提亮；**静音态**显示划掉的喇叭 + 降为 `cyberColors.textMuted`；展开为滑块（方角）。静音状态与工具栏总开关**同一份**（D15） |
| 倍速 | 文本按钮（`1x` / `1.5x`…），点击循环或弹出小菜单 |

> **关于「青色既做波形又做已播带」**：用户明确选了青色（对比度最弱的一档）。落地时通过**线宽差（2.2 vs 2）+ 明度差（100% vs 28%）+ 背景带**三重区分保证可读；若实测对比不足，作为待调项记录（见 §12）。

## 10 范围扩张说明（必须记录）

**用户在选择「功能档次」时选的是「对齐原生 + 赛博皮（不碰服务端）」**，但随后在波形选型中选择了**真实峰值曲线** —— 真实峰值**必须有服务端支持**，故本设计**包含服务端新增路由**（§6）。

这不是我擅自扩大范围，而是选型链条的自然结果；此处显式记录，供审阅时判断是否接受。若用户希望严格守住「不碰服务端」，替代方案是回退到 §12 的「装饰波形」——但那与 Spec B 反复确立的「不撒谎」原则相悖，**我不推荐**。

## 11 不做 / 押后

| 项 | 状态 | 理由 |
|---|---|---|
| 视频播放器 | 不做 | 用户明确只做音频；视频行保持原生 |
| `WorkPreview` hover 预览改版 | 不做（仅改互斥一处） | 它是「移开即卸载」的特殊纪律，与本设计目标不同 |
| 播放列表 / 顺序播放 | 不做 | 无此需求（YAGNI） |
| 循环 / 随机 | 不做 | 同上 |
| 波形缓存清理的「孤儿巡检」 | 押后 | 启动时的 `cleanOrphans` 只清 temp；成品波形留在 derived 目录，成品删除时已清（§6.4），暂无孤儿场景 |
| 视频成品的波形 | 不做 | 视频行不归本设计 |

## 12 风险与缓解

| 风险 | 缓解 |
|---|---|
| **青色已播带对比度弱**（用户选了最弱一档） | 线宽 + 明度 + 背景带三重区分；真机若仍不够，调亮背景带或改红（**记为待调项**） |
| **短音频点数不足** | 用固定目标点数（§6.2），不论时长都 ~1200 点 |
| **多条成品同屏 = 多次 ffmpeg** | 每条首次加载跑一次（~1-3s，之后命中缓存）；成品行数量有界（一页通常数条）；失败显示静态基线不影响播放 |
| **键盘快捷键抢输入** | 作用域限定（§5.3）：焦点在输入类元素时全部忽略 |
| 与既有时间轴快捷键冲突 | 落地时逐一核对既有键位，冲突则让位 |
| `useSyncExternalStore` 快照不稳定导致重渲染风暴 | `getSnapshot` 返回**不可变对象**（仅在状态真变时换引用），照 React 官方要求实现 |
| 波形请求与 `<audio>` 元数据竞态（先有波形后有时长） | 波形按点数自洽绘制，不依赖 `<audio>.duration`；时长只用于时间码与刻度 |
| 扫描线层遮挡点击 | 既有 `.cyber-app::after` 已 `pointer-events:none`，无影响 |

## 13 验证

1. **服务端单测**（TDD）：`ensureAudioWavePeaks` 命中/生成/失败各路径 + 路由 200/400/404 + 鉴权；`cd server; npm test`（须用 `npm test`，不是 `npx vitest run`）
2. **类型与构建**：`pnpm -r run typecheck`、`pnpm --filter @sct/web run build`
3. **人工目验**（web 无单测）：三处播放面的观感、单实例互斥（播 A 再播 B 应停 A）、顶栏按钮与列表行联动、键盘快捷键、倍速、拖动定位、波形与真实音频对得上
4. **回归**：`WorkPreview` hover 预览仍正常（改的是互斥一处）；视频行未被误伤

## 14 交付物清单

| 类型 | 文件 |
|---|---|
| 新增（前端） | `web/src/audio-player.ts`（引擎）、`web/src/silence.ts`（互斥注册表）、`web/src/components/CyberAudioPlayer.tsx`、`web/src/components/PlayerWaveform.tsx`、`web/src/components/CyberAudioPlayer.css` |
| 新增（服务端） | `ensureAudioWavePeaks`（加进 `server/src/media/wave-peaks.ts`）、路由（加进 `server/src/ytdlp/ytdlp-routes.ts`）、`waveaudioShapeSig`（加进 `server/src/ffmpeg/derived-args.ts`） |
| 修改（前端） | `web/src/api.ts`（+`audioWavepeakUrl`）、`web/src/pages/studio.tsx`（接入播放器 + 开关升级为总开关）、`web/src/pages/studio-detail.tsx`、`web/src/components/WorkPreview.tsx`（仅互斥） |
| 修改（服务端） | `server/src/ytdlp/ytdlp-routes.ts`（`DELETE /api/audio/:id` 追加清缓存） |
| 测试 | `server/src/media/wave-peaks.test.ts`、`server/src/ytdlp/ytdlp-routes.test.ts`（追加用例） |

## 15 实施结果（2026-10-07）

### 新增文件
| 文件 | 作用 |
|---|---|
| `web/src/audio-player.ts` | 单例播放引擎（模块级唯一媒体元素 + 订阅） |
| `web/src/silence.ts` | 「谁在出声」互斥注册表 |
| `web/src/components/PlayerWaveform.tsx` | Canvas 曲线波形（兼任进度条） |
| `web/src/components/CyberAudioPlayer.tsx` + `.css` | 播放器外壳（单行 42px） |
| `server/src/media/wave-peaks.ts` 内 `ensureAudioWavePeaks` | 成品波形生成器 |
| `server/src/ffmpeg/derived-args.ts` 内 `audioWaveNsamples`/`waveaudioShapeSig`/`AUDIO_WAVE_TARGET_POINTS` | 成品波形纯函数 |

### 改动文件
`server/src/ytdlp/ytdlp-routes.ts`（新路由 + 删除清理）、`server/src/media/media-routes.ts`（导出 `DERIVED_FAIL`）、
`server/src/index.ts`（守卫豁免）、`web/src/api.ts`（+`audioWavepeakUrl`）、
`web/src/pages/studio.tsx`、`web/src/pages/studio-detail.tsx`、`web/src/components/WorkPreview.tsx`

### 验证（终态实测，取数命令随数字一并写出）
| 项 | 结果 | 取数命令 |
|---|---|---|
| 三包 typecheck | 0 错（3 包 typecheck 全部 Done，EXIT=0） | `pnpm -r run typecheck` |
| web build | EXIT=0（Webpack Compiled successfully） | `pnpm --filter @sct/web run build` |
| desktop build | EXIT=0（tsc -p tsconfig.build.json 无报错） | `pnpm --filter @sct/desktop run build` |
| server 测试 | 632/632 绿（45 文件全通过） | `cd server; npm test` |
| 原生音频播放面残留 | 0 命中 | 见 Step 2 ① |

### 实施中的两处设计修正（如实记录）
1. **守卫豁免**：新路由 `/api/audio/:id/wavepeak` 必须加进 `server/src/index.ts` 的 `onRequest` 豁免名单
   （该路由只认 query token / 本机 Origin / 本机 Referer；生产 file:// 下 Origin 为 null），
   否则整条链路会在守卫层被 401（与本项目 2026-10-03 事故同源）。
2. **状态码映射**：失败码不再自建映射，改为复用 `media-routes.ts` 既有的 `DERIVED_FAIL` 表
   （`NO_FFMPEG/FFMPEG_FAIL→500`、`PROBE_FAIL→422`、`SRC_CHANGED→409`、其余 404），避免同后端两套口径。

### 待人工目验
见 `docs/after/cyberpunk-ui-visual-acceptance-open-decisions.md` 的音频播放器一节。

### 终审后的修正与偏离补记（2026-10-07）

终审通过后做了一小波修复，以下五条如实记录（含一处「有意不做」，避免日后被当成漏做）：

1. **签名补了取样规则版本段。** `waveaudioShapeSig()` 从 `v3|points=1200` 补成 `v3|points=1200|nf=1`（常量 `AUDIO_WAVE_NSAMPLES_V`）。
   原因：点数 1200 不变、只改 `audioWaveNsamples` 的反推公式时，旧签名会与新的逐字相同 → 老缓存被判新鲜继续用，
   而实际点密度已变，波形与时长（`stepSec`）错位。补上版本段后，改公式只要把版本号 +1，老缓存即自动判失效。

2. **成品波形的失败提示在路由层做了「音频语境」覆盖。** 路由 `GET /api/audio/:id/wavepeak` 之前直接复用素材链路的
   `DERIVED_FAIL` 表，其 `PROBE_FAIL.next` 写的是「删除该素材后重新下载完整视频」——对音频成品是误导（成品不能
   「重新下载」，只能重新导出）。现在在 `ytdlp-routes.ts` 里维护一个小覆盖映射 `AUDIO_WAVE_FAIL_NEXT`，
   只覆盖音频链路真正会返回的 `PROBE_FAIL` / `FFMPEG_FAIL`，**不改 `DERIVED_FAIL` 表本身**（免得影响素材链路）。

3. **有意不做：`SRC_CHANGED`（落盘前换源复核）。** 素材链路的波形在落盘前会复核「素材是否被换源」，换源则丢弃产物。
   成品链路**有意不做**这一步——成品内容不可变（重导出会得到新的 `audioId`），不存在「同一 id 内容被换」的场景。
   已在代码注释里写明，属**主动取舍而非漏做**。

4. **接口微调（两处，与 §4.2 的接口草案有出入）。**
   - `loadAndPlay(audioId, src)` 未单独实现：`toggle` 已覆盖「装载 + 播放（先停旧的）」这一场景，再加一个几乎同义的入口无收益。
   - `PlayerState.currentTime` 改为**不存字段**、由 `getTime()` 直读媒体元素：状态里存一份实时时间必然落后于元素，
     等于制造第二份真相（与 D15 同一精神）。

5. **波形失败已补重试入口。** 落地时只画了静态基线，漏了 spec §5.2 要求的「可重试」。现在 `CyberAudioPlayer` 在波形
   失败态显示一个「波形加载失败 · 重试」小按钮，点击重新 fetch `audioWavepeakUrl(audioId)`；失败态下**仍允许播放**
   （波形取不到不影响播放键与时间码）。

