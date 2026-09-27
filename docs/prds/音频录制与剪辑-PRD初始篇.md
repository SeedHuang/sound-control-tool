# 音频录制与剪辑工具 PRD · 初始篇

- 日期：2026-09-26
- 状态：需求与架构已评审确认（用户拍板：来源 A+D、剪辑全功能、建音频库、三包架构）；2026-09-26 完成第 1 轮多透镜评审修复（P0×1 + P1×10，处置记录见 §9 Backlog）；同日确定 superpowers 工具链 + 6 spec 路线图（§6.1，JIT 细化）
- 本篇定位：项目启动的顶层需求与架构文档。后续里程碑的细节设计拆分到 `docs/superpowers/specs/`，实施计划拆分到 `docs/superpowers/plans/`。

---

## 1. 背景与定位

一个 Windows 桌面端小工具：从网页或系统声音获取音频，进行裁剪、拼接、精修，产出可管理的本地音频文件。

- 定位：**个人效率工具**，先做小而完整的"获取 → 剪辑 → 归档"闭环。
- 演进方向：后续接入 AI 能力（转写、自动打标签、语义搜索），因此**数据模型从第一天起为 AI 预留地基**。
- 参照项目：`D:\Seed\bilibili_favorite_manager`（pnpm workspace + web/server 双包 + Fastify + better-sqlite3 + antd 5）。本项目沿用同一套工程习惯，外层加 Electron 壳。

### 1.1 目标

1. 粘贴网页 URL，用 yt-dlp 把视频/音频/播客提取为本地音频（支持片段下载）。
2. 一键录制系统正在播放的声音（Windows loopback）。
3. 在波形编辑器中完成：裁剪、多段拼接、淡入淡出、增益/标准化、变速、降噪。
4. 导出 mp3 / m4a / wav，可选码率。
5. 所有产出自动入库，提供音频库页面管理（列表、标签、检索）。

### 1.2 非目标（明确不做）

- 不做视频剪辑（仅音频）。
- 不做多轨混音、专业 DAW 功能。
- 不做 Chrome 插件（已论证：剪辑环节决定主程序必须是桌面端，见 §3.1）。
- 不内置分发 yt-dlp / ffmpeg 二进制（用户自备，本项目已装好；提供路径配置与检测）。
- 第一期不做 DRM 内容的绕过（受版权保护内容 yt-dlp 无法下载时，明确报错提示）。

---

## 2. 需求详述

### 2.1 音频获取 · URL 下载管线（来源 A）

**用户流程**：粘贴 URL → 后端解析元数据（标题、时长、可用格式）→ 用户可选"整个下载"或"片段下载（输入起止时间）"→ 选择输出格式与码率 → 提交下载 → 进度条实时反馈 → 完成后自动入库。

**功能点**：

- FR-1.1 URL 解析：调用 `yt-dlp -J <url>` 获取元数据，展示标题、时长、封面、可提取的音频格式列表。**播放列表/合集处理**：解析结果包含多个视频（B站合集、分 P、YouTube 播放列表）时，列出全部条目供用户勾选，默认仅勾选当前页对应的单条；用户选择单条时调用 yt-dlp 附加 `--no-playlist` 兜底，防止误下整个合集。
- FR-1.2 片段下载：支持 `--download-sections "*start-end"`，起止时间精确到秒。
- FR-1.3 音频提取：`-x --audio-format <mp3|m4a|wav> --audio-quality <bitrate>`，并附加 `--windows-filenames` 防止中文/特殊字符导致的文件名问题。
- FR-1.4 进度反馈：解析 yt-dlp stdout 的 progress 行，通过 SSE 推送到前端（长任务，参照 bfm 的异步任务模式）。完成后提示**含保存位置**（文件名 + 所在文件夹），并提供"去剪辑 / 去音频库"入口。
- FR-1.5 失败处理：网络失败、不支持的站点、DRM 内容等给出明确中文错误信息，且**每条错误附带可执行的下一步**（如"检查网络后重试""该站点需要登录，暂不支持"）；任务可重试。
- FR-1.6 支持批量粘贴多个 URL 排队下载（**M3**，与 §6 里程碑表一致；M1 仅支持单 URL）。

### 2.2 音频获取 · 系统声音录制（来源 D）

**用户流程**：点击"录制"→（引导文案：确认只打开要录的声音，关闭无关系统提示音）→ 选择录制来源 → 实时显示电平/波形 → 点击停止 → 生成录音文件并入库 → 可直接进入剪辑工作台。

**功能点**：

- FR-2.1 录制链路：渲染进程 `getDisplayMedia`（**实现要点：需 Electron 主进程通过 `setDisplayMediaRequestHandler` 提供屏幕/音频源选择并处理权限**；Windows 下用户选择"整个屏幕"并勾选"分享系统音频"，即获得系统混音流）→ `MediaRecorder` 分片 → HTTP 上传到 server 聚合写盘 → ffmpeg 转码为目标格式。全程不需要原生模块。权限被用户拒绝时给出明确提示与重试入口。完成提示含保存位置。
- FR-2.2 实时反馈：录制中显示已录时长与实时音量电平（Web Audio AnalyserNode）。
- FR-2.3 暂停/恢复：支持暂停后继续，最终产物为单个文件。**实现要点：用 MediaRecorder 的 pause()/resume()，禁止 stop 后重新 start（后者会重复输出 webm header 导致文件损坏）**。
- FR-2.4 崩溃保护：录制分片先落临时目录，异常退出时能恢复最近一次录音（M2 完成即可，M1 可先做基础版）。
- FR-2.5 已知限制写入 UI：录的是"系统混音"，会包含其他应用的声音；文档与界面均需提示。

### 2.3 剪辑工作台

**用户流程**：从音频库或刚完成的获取任务进入工作台 → 看到波形 → 框选区域 → 执行操作 → 预览 → 导出。

**功能点**：

- FR-3.1 波形显示与选区：wavesurfer.js v7 + Regions 插件。支持多选区（片段列表）、每个选区可微调边界（拖拽 + 数字输入精确到 0.1s）、试听单个选区。
- FR-3.2 裁剪：保留所选 / 删除所选。非破坏式——总是产出新文件，原文件不动。
- FR-3.3 多段拼接：多个选区按列表顺序重排后拼成一个文件。
- FR-3.4 精修效果（作用于输出结果）：
  - 淡入 / 淡出（秒数可调）
  - 音量增益（dB）与响度标准化（loudnorm）
  - 变速（0.5x–2.0x，atempo；超出范围级联处理）
  - 降噪（afftdn，强度档位：轻/中/强）
- FR-3.5 格式导出：mp3 / m4a / wav。**码率仅对有损格式（mp3/m4a）有意义：选择 wav 时 UI 禁用码率选项**；mp3 码率可选（128/192/320k 等）。
- FR-3.6 剪辑规格即数据：前端产出结构化 EditSpec JSON（见 §4.2），后端编译为 ffmpeg 命令执行。前端只做选区与预览，不做真正的音频处理。EditSpec 非法值由编译器防御性校验（规则见 §4.2）。
- FR-3.7 导出产物自动入库，并记录 parent_id 关联源音频（剪辑血缘）。**删除源音频时，其剪辑子产物保留**，parent 悬空时列表中显示"源已删除"。

### 2.4 音频库

- FR-4.1 列表页：标题、来源类型（下载/录制/剪辑产物）、时长、格式、大小、创建时间、标签。支持按标题搜索、按标签筛选、按时间排序。
- FR-4.2 标签：自由打标，多对多关系。标签名重复（UNIQUE 冲突）时提示"已存在"并复用现有标签，不报裸异常。为 AI 自动打标签预留同一套表结构。
- FR-4.3 操作：重命名、删除、打开所在文件夹。**重命名仅修改数据库显示名（title），不改磁盘文件名**（文件名仅在入库时确定，见 §3.5）。**删除需二次确认**，"同时删文件"选项需要更强的确认提示；删除条目后其剪辑子产物的处理见 FR-3.7。
- FR-4.4 从列表页一键进入剪辑工作台或播放预览。
- FR-4.5 **文件缺失检测**：所有读取 file_path 的操作（播放、剪辑加载、打开文件夹）先校验文件存在；文件被外部移动/删除时，列表条目标记"文件缺失"徽标，相关操作给出明确提示，不得抛裸异常。

### 2.5 设置

- FR-5.1 yt-dlp / ffmpeg 二进制路径（默认从 PATH 探测，可手动指定；检测失败时在设置页明确标红并说明影响范围）。
- FR-5.2 默认输出目录、默认导出格式与码率。
- FR-5.3 设置持久化到 SQLite。

### 2.6 AI 扩展（展望，M4+，不在本期实现）

- 语音转写（转写结果存音频条目下，未来可做"按内容搜索音频"）。
- 自动打标签（写入现有 tags 表）。
- 架构上仅需：server 增加 AI 模块 + audio_items 增加 transcript 等字段，数据模型已预留。

---

## 3. 架构设计

### 3.1 关键决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| ADR-1 | Electron 而非 Chrome 插件 | 剪辑需要 ffmpeg 子进程 + 本地文件管理；插件方案需 ffmpeg.wasm 或 Native Messaging，成本更高。详见启动讨论结论：剪辑环节决定主程序形态 |
| ADR-2 | 三包 workspace（方案一） | 与参照项目 web/server 结构完全对齐；server 可独立 vitest 测试；web 可脱离 Electron 用浏览器独立开发 |
| ADR-3 | server 导出 `createServer()` 工厂 | 开发时 tsx 独立跑（与 bfm 一致）；生产时 Electron 主进程直接 import 启动，免去子进程生命周期管理。**2026-09-26 修订：SQLite 驱动改为 Node 内置 node:sqlite（零原生模块），原生模块 ABI 风险消除；驱动决策见 spec m0-desktop-shell D9** |
| ADR-4 | 录制走 getDisplayMedia + MediaRecorder | Windows 原生支持系统音频 loopback，无需虚拟声卡/原生模块。**实现要点：主进程 `setDisplayMediaRequestHandler` + 权限处理（见 FR-2.1），渲染进程无法独立完成** |
| ADR-5 | 剪辑 = EditSpec JSON → ffmpeg 编译 | 前端不碰音频数据；每次剪辑产出新文件（非破坏式）；逻辑全部落在可测试的 server 层 |
| ADR-6 | 波形库选 wavesurfer.js v7 | 热度最高、维护活跃、TS 原生、官方插件（Regions/Timeline/Record）正好覆盖需求；与 antd 5 组合 |
| ADR-7 | yt-dlp / ffmpeg 由用户自备 | 项目已装好；避免二进制分发与升级负担；设置页做路径检测 |

### 3.2 仓库结构

```
sound-control-tool/
├─ pnpm-workspace.yaml          # packages: [web, server, desktop]
├─ package.json                 # 根脚本：concurrently 起 server + web + electron
├─ docs/
│  ├─ prds/                     # 本文档
│  └─ superpowers/              # specs/ 与 plans/（沿用 bfm 习惯）
├─ web/                         # @sct/web — UmiJS Max 4 + React 18 + antd 5 + wavesurfer.js v7
│  └─ src/
│     ├─ pages/                 # index(音频库) / acquire(获取) / editor(剪辑工作台) / settings
│     ├─ components/            # WaveEditor(波形+选区) / SegmentList / EffectPanel / JobProgress ...
│     ├─ hooks/                 # useWaveSurfer / useSse / useJobPolling
│     └─ api.ts                 # 封装后端 HTTP API
├─ server/                      # @sct/server — Fastify 5 + better-sqlite3
│  └─ src/
│     ├─ http/                  # 路由层：items / acquire / jobs / settings / sse
│     ├─ ytdlp/                 # yt-dlp 封装：meta 解析、下载、进度解析（可单测）
│     ├─ ffmpeg/                # EditSpec → ffmpeg 参数编译器、转码封装（核心可单测）
│     ├─ record/                # 录音分片聚合、转码
│     ├─ db/                    # better-sqlite3 + repo 模式（参照 bfm）
│     └─ index.ts               # 导出 createServer() 工厂
└─ desktop/                     # @sct/desktop — Electron
   └─ src/
      ├─ main.ts                # 主进程：createServer() → BrowserWindow；setDisplayMediaRequestHandler；单实例锁
      └─ preload.ts
```

**开发运行**：`pnpm dev` 同时起 `tsx server`（API :7310，示例端口；端口被占用时自动递增，实际端口在 UI 可见）、`max dev web`、`electron .`（加载 web dev URL）。Electron 使用 `requestSingleInstanceLock` 防双开（第二实例激活已有窗口即退出）。

**生产形态**：web 构建产物由 Electron 加载本地文件——**须采用 hash 路由 + `publicPath: './'`（或 Electron 自定义协议），否则 file:// 下路由与资源加载失败白屏**，此验证列入 M0；server 由主进程 `import('@sct/server')` 内嵌启动（ADR-3，注意原生模块 ABI，见 R7）。

### 3.3 数据流

```
渲染进程(React web)
   │  HTTP / SSE（与 bfm 相同的 API 习惯）
   ▼
Fastify server
   ├─ 获取: spawn yt-dlp ──stdout 进度──► SSE ──► 前端进度条
   ├─ 录制: 渲染进程 MediaRecorder 分片上传 ──► server 聚合写盘 ──► ffmpeg 转码
   ├─ 剪辑: EditSpec JSON ──► ffmpeg 参数编译 ──► spawn ffmpeg ──► 产物入库
   └─ 全程: better-sqlite3 记账（items / jobs / tags / settings）
```

### 3.4 错误处理原则

- 外部进程（yt-dlp/ffmpeg）的 stderr 必须捕获、截取关键行、翻译为用户可读信息，原始输出进日志文件。
- 长任务一律走 jobs 表 + SSE，前端可取消（kill 子进程树）。
- 文件写入先临时名，成功后原子改名，避免半成品入库。
- **应用启动时任务恢复**：将 jobs 表中所有 `pending`/`running` 状态置为 `error`（message="应用中断，可重试"），不自动续跑。
- **启动时清理孤儿临时文件**：扫描临时目录，删除无对应活跃任务的残留分片/半成品。

### 3.5 文件命名与唯一性策略

- 磁盘文件名在**入库时一次性确定**：`{slug(title)}-{id前8位}.{ext}`。slug 规则：替换 Windows 非法字符 `\/:*?"<>|` 为 `_`，去除首尾空格，截断至 80 字符（防路径超长）。
- 落盘冲突（目标位置已有同名文件）时追加序号 `-2`、`-3`……，保证 `file_path UNIQUE` 约束**永不触发裸异常**。三类入库入口（下载 / 录制 / 剪辑导出）统一适用。
- 默认标题：下载 = yt-dlp 元数据 title；录制 = `录音-{yyyyMMdd-HHmmss}`；剪辑产物 = `{源title}-剪辑-{yyyyMMdd-HHmmss}`。
- 同 URL 重复下载：解析阶段检测库中已有相同 source_url 的条目并提示"已存在"，用户可选择仍下载（生成新条目，文件名按冲突规则追加序号）或取消。
- 重命名（FR-4.3）仅改数据库显示名，不改磁盘文件名（避免文件被外部程序占用导致失败）。

---

## 4. 数据模型（SQLite）

### 4.1 表

```sql
-- 音频条目：下载产物、录音、剪辑产物统一为一行
CREATE TABLE audio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,          -- 显示名，可重命名；磁盘文件名见 §3.5
  source_type TEXT NOT NULL CHECK (source_type IN ('download','recording','edit')),
  source_url TEXT,              -- source_type=download 时的原始 URL（重复下载检测读取点）
  parent_id INTEGER,            -- source_type=edit 时指向源音频（剪辑血缘）；源删除后悬空，UI 显示"源已删除"
  file_path TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL,         -- mp3 | m4a | wav
  duration_sec REAL,
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 长任务：yt-dlp 下载 / ffmpeg 转码 / 录音转码
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,           -- ytdlp_meta | ytdlp_download | ffmpeg_edit | record_transcode
  payload TEXT NOT NULL,        -- JSON：参数（URL、EditSpec、格式等）
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','cancelled')),
  progress REAL NOT NULL DEFAULT 0,   -- 0~100
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

-- 标签（AI 自动打标签复用此表）
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audio_item_tags (
  audio_id INTEGER NOT NULL REFERENCES audio_items(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (audio_id, tag_id)
);

-- 设置（键值对）。键名在 server 侧集中常量定义，禁止散落字符串字面量
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 4.2 EditSpec（剪辑规格，payload 的核心结构）

```jsonc
{
  "sourceId": 12,
  "segments": [                    // 多段拼接按数组顺序
    { "start": 61.0, "end": 184.5 },
    { "start": 300.2, "end": 355.0 }
  ],
  "mode": "keep",                  // keep=只保留选区 | cut=删除选区
  "effects": {
    "fadeInSec": 1.5,
    "fadeOutSec": 3.0,
    "gainDb": -2,                  // 与 loudnorm 互斥，二选一
    "normalize": false,
    "tempo": 1.0,                  // 0.5~2.0，超出范围由编译器级联
    "denoise": "medium"            // none | light | medium | strong
  },
  "output": { "format": "mp3", "bitrate": "192k" }  // bitrate 仅对 mp3/m4a 生效，wav 时忽略
}
```

**校验规则（前端生成时保证 + 后端编译器防御性校验，编译器校验纳入单测）**：

1. 单段 `start >= end` 或时长 < 0.1s → 拒收，提示修正选区（选区交互本身禁止产生此类段）。
2. **重叠段合法**，语义明确：`mode=keep` 时按数组顺序逐段截取后拼接（同一内容出现两次是用户显式选择，如做循环）；`mode=cut` 时重叠区间等价于并集，只删一次。
3. `tempo` 限 0.5~2.0，前端钳制输入；超出范围由编译器级联多个 atempo。
4. `format` 枚举校验（mp3|m4a|wav）；`bitrate` 仅对有损格式生效，wav 时忽略。
5. `sourceId` 必须存在且文件可读（联动 FR-4.5 缺失检测）。

---

## 5. 页面结构（web）

| 页面 | 路由 | 内容 |
|---|---|---|
| 音频库 | `/` | 列表 + 搜索/筛选/标签 + 入口按钮；空状态引导"去获取页" |
| 获取 | `/acquire` | Tab1: URL 下载（解析→合集勾选→片段可选→格式选择→进度，完成后提供"去剪辑/去库"入口）；Tab2: 系统录音（电平表→暂停/停止） |
| 剪辑工作台 | `/editor/:id` | 波形(wavesurfer) + 选区列表 + 效果面板 + 导出面板 |
| 设置 | `/settings` | 二进制路径、输出目录、默认格式 |

UI 组件库：**antd 5**（沿用 bfm 体系）+ **wavesurfer.js v7**（波形/选区/时间轴）。没有现成的"React 音频剪辑器"组件库，波形与选区交互由 `useWaveSurfer` hook + antd 组件自行组合（ADR-6）。注意 wavesurfer v7 渲染在 Shadow DOM 中，融入 antd 主题需用 `::part()` 选择器定制样式。

---

## 6. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 脚手架** | 三包 workspace；Electron 壳加载 web（**hash 路由 + publicPath './' 验证**）；createServer 工厂内嵌跑通（**含 @electron/rebuild 适配 better-sqlite3 ABI，见 R7**）；单实例锁与端口策略；设置页 + 二进制路径检测 | Electron 窗口内展示 web 页面并能调通 server API（含 SQLite 读写成功） |
| **M1 获取管线** | URL 解析/合集勾选/下载/片段下载 + SSE 进度；系统声音录制全流程；产物入库 | 从 B 站课程 URL 拿到 mp3；录一段系统声音并能在库中播放 |
| **M2 剪辑工作台** | 波形+多选区；裁剪/拼接；淡入淡出/增益/标准化/变速/降噪；格式导出；EditSpec 编译器单测；录音崩溃保护完善 | 对 M1 产物完成"裁两段→拼接→加淡入淡出→导出 mp3"闭环 |
| **M3 音频库完善** | 标签、筛选、重命名、删除、打开文件夹；**批量下载**（FR-1.6） | 库页面可完成日常归档管理 |
| **M4（展望）AI** | 转写、自动打标签、按内容搜索 | 另立 PRD |

依赖顺序：M0 → M1 → M2 → M3。M2 的 EditSpec 编译器（server/ffmpeg）可与 M1 并行开发。

### 6.1 Spec 路线图（后续拆分计划）

**拆分原则（JIT）**：本节只固定各 spec 的**边界、大纲与依赖**，规格细节在各 spec 开工时再写成独立文档（`docs/superpowers/specs/`，superpowers 流程：spec → writing-plans → 执行），以当时的项目实态为准——避免早期细化导致的规格返工。

**shared 候选（只标注不建文件，开工第一个引用它的 spec 时创建，内容引用本 PRD 不抄写）**：数据模型与入库契约（→ PRD §4.1+§3.5，将来 `shared-data-model`）｜长任务与错误处理（→ §3.4，`shared-jobs-and-errors`）｜测试策略（→ §6 验收 + T.3 探针约定，`shared-testing`）｜前端约定（→ §5，`shared-frontend`）。

依赖图：`S1 → {S2, S3, S4} → S5 → S6`；S2、S3、S4 三者可并行。

**S1 · m0-desktop-shell — 桌面壳与内嵌 server**（依赖：无）
- 三包 pnpm workspace 脚手架（web/server/desktop）与根 dev 脚本
- Electron 主进程：加载 web、createServer() 工厂内嵌、单实例锁、端口策略
- @electron/rebuild 适配 better-sqlite3 ABI（R7）
- hash 路由 + publicPath './' 验证
- 设置页 + yt-dlp/ffmpeg 路径检测
- 验收锚点：M0（Electron 窗口调通 API，含 SQLite 读写成功）

**S2 · m1a-ytdlp-pipeline — URL 下载管线**（依赖：S1）
- server/ytdlp 模块：`-J` 元数据解析、合集勾选、下载/片段下载、`--windows-filenames`
- 进度解析 → SSE；jobs 表任务模型（取消/重试/启动恢复）
- 重复 URL 检测；产物入库（命名与唯一性策略 §3.5）
- 最小音频库列表页（支撑验收播放）
- 验收锚点：M1 前半（B 站课程 URL → mp3 并能播放）

**S3 · m1b-system-recording — 系统声音录制**（依赖：S1）
- Electron 主进程 setDisplayMediaRequestHandler + 权限拒绝处理
- 渲染进程 MediaRecorder 分片上传、pause/resume（禁 stop+start）、电平显示
- server 分片聚合写盘 + ffmpeg 转码；崩溃保护基础版（分片落临时目录）
- 产物入库
- 验收锚点：M1 后半（录一段系统声音 → 库中播放）

**S4 · m2a-editspec-compiler — EditSpec 编译器**（依赖：S1，可与 S2/S3 并行）
- EditSpec → ffmpeg 参数编译：段截取/拼接、afade、gain/loudnorm、atempo 级联、afftdn
- §4.2 校验规则全部落进编译器（防御性拒收）
- 完整 vitest 单测（含参数快照断言）
- 验收锚点：编译器单测绿

**S5 · m2b-editor-workbench — 剪辑工作台 UI**（依赖：S2、S3、S4）
- useWaveSurfer hook + Regions/Timeline 多选区交互
- 片段列表重排、边界微调（拖拽 + 数字输入 0.1s）、单选区试听
- 效果面板 + 导出面板（wav 时禁用码率）
- job 联动（SSE 进度、取消）；导出产物入库（parent_id 血缘）
- 录音崩溃保护完善（FR-2.4 完整版）
- 验收锚点：M2（裁两段→拼接→加淡入淡出→导出 mp3 闭环）

**S6 · m3-library-complete — 音频库完善**（依赖：S2、S3）
- 标签系统（打标/重名复用/筛选）、标题搜索、排序
- 重命名（仅显示名）、删除二次确认、打开所在文件夹
- 文件缺失检测（FR-4.5，读取点校验 + 缺失徽标）
- 批量 URL 下载（FR-1.6）
- 验收锚点：M3（日常归档管理闭环）

---

## 7. 风险与开放问题

| # | 风险/问题 | 应对 |
|---|---|---|
| R1 | 录制混入无关系统声音 | 引导文案 + 文档明示（本质限制） |
| R2 | DRM/加密流无法下载 | 明确报错提示，不绕过 |
| R3 | wavesurfer 全量解码长文件**慢或失败**（内存不足） | 一期：时长 >2h 或体积 >500MB 时提示"长文件建议先下载片段/裁剪"，仍可尝试，解码失败给出明确报错；降级路径（MediaElement 后端 + ffmpeg 预生成波峰 peaks）列为 M3 后评估项 |
| R4 | atempo 单滤镜限 0.5–2.0 | 编译器级联多个 atempo，单元测试覆盖 |
| R5 | Electron 打包（electron-builder）未定细节 | 推迟到 M3 后，一期先保证开发态顺畅 |
| R6 | Windows 版本要求（loopback 依赖 Win10+） | 明示系统要求 |
| R7 | ~~better-sqlite3 与 Electron ABI 不匹配~~ **已化解（2026-09-26 spike）**：双副本方案证伪后，SQLite 驱动改为内置 node:sqlite（零原生模块），rebuild 需求消失 | 详见 spec m0-desktop-shell §0.7；"内嵌形态下 SQLite 读写成功"仍为 M0 验收项 |

---

## 8. 已确认决策清单（用户拍板记录）

1. 音频来源：**A（网页内容，yt-dlp 下载）+ D（系统声音录制）**
2. 剪辑功能：**全量**（裁剪、多段拼接、精修四件套、格式导出）
3. 音频库：**要**（SQLite 入库，为 AI 铺路）
4. 架构：**方案一（三包 workspace + createServer 工厂）**，工程习惯对齐 `bilibili_favorite_manager`，使用 pnpm
5. 波形库：**wavesurfer.js v7** + antd 5
6. 2026-09-26 多透镜评审：P0-1 + P1-1~P1-10 修复方案全部采纳；重叠选区语义与长文件阈值按本篇 §4.2/§7-R3 执行
7. 2026-09-26 工具链决策：**继续使用 superpowers 流程**（spec → writing-plans → 执行），不引入 OpenSpec。PRD 拆分为 6 个 spec（§6.1 路线图），采用 **JIT 细化**——PRD 阶段只定边界与大纲，规格细节在各 spec 开工时写，避免规格返工
8. 2026-09-26 Task 1 spike：better-sqlite3 双副本方案**证伪**（pnpm 12 把 npm 别名与原版去重为同一物理实例 + Electron 44 需 ABI 149 而预编译仅到 v146 + 本机无 MSVC），按 spec §0.7 预授权切换**方案 C：SQLite 驱动 = node:sqlite 内置模块**；Node 22 侧经 `NODE_OPTIONS=--experimental-sqlite` 注入（用户拍板 C1，暂不升级 Node；Electron 44.4.5/Node 24.21 侧无 flag）

---

## 9. Backlog（P2 处置记录）

### 9.1 已采纳

| # | 优化项 | 落点 |
|---|---|---|
| P2-1 | 启动时清理孤儿临时文件 | §3.4 |
| P2-2 | 双开防护（requestSingleInstanceLock）+ 端口冲突策略 | §3.2 |
| P2-3 | 删除二次确认（同时删文件需更强确认） | FR-4.3 |
| P2-4 | 空状态引导 + 权限被拒提示 | §5 / FR-2.1 |
| P2-5 | 错误信息带可执行下一步；完成提示含保存位置 | FR-1.4 / FR-1.5 / FR-2.1 |
| P2-6 | yt-dlp `--windows-filenames` | FR-1.3 |
| P2-11 | wavesurfer v7 Shadow DOM `::part()` 样式注记 | §5 |
| P2-12 | MediaRecorder pause/resume（禁 stop+start）注记 | FR-2.3 |
| P2-13 | settings 键名集中常量定义 | §4.1 |
| P2-14 | 标签名重复时复用并提示 | FR-4.2 |
| P2-15 | 端口占用自动递增且 UI 可见 | §3.2（并入 P2-2） |

### 9.2 已关闭

| # | 优化项 | 理由 |
|---|---|---|
| P2-7 | Windows kill 进程树实现细节 | §3.4"kill 子进程树"已有等价覆盖，实现留 spec 层 |
| P2-8 | 验收标准标注自动/人工、golden file 回归、崩溃恢复测试法 | 由 writing-plans 阶段承接，PRD 不展开（本篇开头已声明文档分工） |

### 9.3 候选（记录触发信号，暂不实施）

| # | 优化项 | 触发信号 |
|---|---|---|
| P2-9 | 孤儿文件重扫描（删记录不删文件后，文件成为库外资源） | 该场景真实发生 ≥2 次 |
| P2-10 | "导出后删源"选项（非破坏式导致磁盘双份膨胀） | 用户反馈磁盘空间压力 |
