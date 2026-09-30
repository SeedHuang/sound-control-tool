# P2 · 资料库（下载统一）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）or superpowers:executing-plans。Steps 用 checkbox（`- [ ]`）跟踪。

**Goal:** 资料库页成为"只负责下载"的页面：产物类型（音频/视频）收进工具栏 Radio；集数网格音视频共用；视频按已裁决的方案 A **一次只选一集**下载；已下素材的那一集在网格里高亮（D20）；换集下载前二次确认（D19）。

**Architecture:** 后端三处小增量（source_videos 记 entry_index、视频下载支持单集、/api/imports 加布尔）+ 前端 library.tsx 的工具栏/网格/下载流重构。**剪辑功能（VideoClipPanel）从资料库移除**——按 spec D4"资料库只负责下载"，剪辑在 P4 于剪辑室详情页回归（临时功能空窗，见风险节）。

**Tech Stack:** 不变（UmiJS Max 4 + antd 5 + Fastify 5 + node:sqlite + vitest）。

**Spec:** `docs/superpowers/specs/m2-workspace.md` —— 本计划实现其中 **§0.5 P2**，依赖决定 **D4 / D5 / D19 / D20** 与「已裁决」段（方案 A），替换语义沿用 m1c spec §0.4。

## Global Constraints

- **方案 A（已裁决）**：视频一次只选一集；点集=选中，点"下载"=下载/替换该集素材；重复下载同来源视频 = 覆盖，不弹确认（沿用 m1c）；**换集**（目标集 ≠ 当前素材集）才弹二次确认（D19）；**同集只换清晰度**不弹换集确认。
- **D20**：已下素材的那一集在网格里高亮标出"当前素材"。
- **D19 服务端**：视频下载完成时 `entry_index` 与旧值不同 → 清空该来源的剪辑工程；相同（含同为 NULL）→ 保留。
- **替换语义沿用 m1c §0.4**：写本体失败报错；删附属失败只记日志；用户手工放置的同名文件绝不静默覆盖（`resolveUniquePath` 加序号）。
- **日志（仓库铁律）**：新增后端分支的关键步骤（entry_index 记录、换集判定、清工程、布尔查询）必须 `pushLog`。
- **提交**：逐任务提交需用户当场授权（沿用 P1 模式）；无授权不 commit。
- 验证基线：server `vitest` 全绿 + 三包 `typecheck` 0 错 + web `build` 0 错。
- **⚠️ 执行纪律（本轮特别重要）**：工具回执曾出现污染。每个任务**第一步必须 Read 目标文件磁盘实况**，以语义锚点（函数名/注释）定位，**代码以磁盘实况为准适配**，不得盲信计划里的行号或"现状引用"。

---

### Task 1: 后端 —— source_videos.entry_index + 视频单集下载

**Files:**
- Modify: `server/src/db/schema.ts`（ensureColumns 增补）
- Modify: `server/src/db/repo/source-videos.ts`（upsert 增 entryIndex）
- Modify: `server/src/ytdlp/args.ts`（视频参数支持单集）
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（video 分支透传 + finalize 记录）
- Test: `server/src/ytdlp/args.test.ts`、`server/src/ytdlp/ytdlp-routes.test.ts`

**Interfaces:**
- Produces: `SourceVideoRow.entry_index: number | null`；下载 payload `options.entryIndices?: number[]` 在 **video 分支**同样生效（单集选择）；`source_videos` 行携带该集号。

- [ ] **Step 1: 读磁盘实况，定位三处锚点**（不得跳过）

1. `server/src/ytdlp/args.ts`：找到 `buildVideoDownloadArgs`（m1c 增）与 `buildDownloadArgs`（音频）；确认音频侧 `entryIndices → --playlist-items` 的现有写法（m1a 起就有，测试 `args.test.ts` 有对应用例）——视频侧**镜像同一写法**。
2. `server/src/ytdlp/ytdlp-routes.ts`：找到 video 分支（`produce === 'video'`）的 payload 处理与 `finalizeDownload` 的视频落盘函数（`videosRepo.upsert(...)` 调用处）。
3. `server/src/db/repo/source-videos.ts`：`upsert` 的入参形状（`{ importId, filePath, height, fileSize }`）。

- [ ] **Step 2: schema 幂等补列**

`server/src/db/schema.ts` 的 `initSchema` 里，仿照 `imported_sources.thumbnail` 的既有 `ensureColumns` 调用，追加：

```ts
  // 2026-09-30 方案A(P2):视频素材一次只留一集,记"这份素材是哪一集"(单视频为 NULL)
  ensureColumns(db, 'source_videos', [
    { name: 'entry_index', ddl: 'entry_index INTEGER' },
  ]);
```

- [ ] **Step 3: repo upsert 增 entryIndex**

`source-videos.ts` 的 `upsert` 入参与 INSERT/UPDATE 增 `entry_index`（可空）。**注意**：`list()`/`get()` 的 SELECT 需带出 `entry_index` 并在映射里归一（`Number | null`，仿照 `height` 的既有写法）。`SourceVideoRow` 接口同步加 `entry_index: number | null`。

- [ ] **Step 4: 视频参数支持单集**

`args.ts` 的 `buildVideoDownloadArgs`：接受 `entryIndices?: number[]`（长度 1，由路由校验），存在时追加 `'--playlist-items', String(entryIndices[0])`。镜像音频侧写法；不影响单视频（不传就不加）。

- [ ] **Step 5: 路由与 finalize 接线**

1. video 分支的 payload 读取处：透传 `options.entryIndices`（沿用音频侧"长度 1"校验口径；video 分支**不参与音频判重**的现状不变）。
2. `finalizeDownload` 视频落盘处：upsert **前**先 `videosRepo.get(importId)` 取旧行的 `entry_index`（记 `oldEntryIndex`）；upsert 传入本次的 `entry_index = payload.entryIndex ?? null`（**顶层字段**，与音频的合集条目口径一致）。
3. `pushLog('info', 'ytdlp', \`video 素材 entry_index: ${oldEntryIndex} → ${newEntryIndex} import=${importId}\`)`（D19 判定留痕，Task 2 消费）。

- [ ] **Step 6: 测试**

- `args.test.ts`：`buildVideoDownloadArgs` 带 `entryIndices: [3]` → 含 `--playlist-items` 与 `'3'`；不带 → 不含（镜像音频既有两例）。
- `ytdlp-routes.test.ts`：video 下载 payload 带 `entryIndex: 3` + `options.entryIndices: [3]`（mock 下载与 ffprobe）→ 落库后 `source_videos.entry_index === 3`；不带 → NULL。

- [ ] **Step 7: 运行测试 + 提交（需授权）**

`pnpm --filter @sct/server test`；绿后提交：`feat(server): 视频素材记录集号并支持单集下载(P2/方案A)`。

---

### Task 2: 后端 —— D7 表提前建 + D19 换集清工程 + imports 布尔 + media 集号

> 说明：`clip_projects/clip_segments` 两表按 spec §0.4 属本 spec 数据模型；P2 的 D19"换集清工程"需要它们，且 finalize 路径本任务已在改——**在此一并落地，避免 P4 二次触碰同一文件**。P2 阶段无 UI 产生剪辑点，清工程是"就位的空转逻辑"。

**Files:**
- Modify: `server/src/db/schema.ts`（两新表 + 索引）
- Create: `server/src/db/repo/clip-projects.ts`
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（finalize 换集清工程）
- Modify: imports 列表路由（`/api/imports`）与 media 列表路由（`/api/media`）
- Test: `server/src/db/repo/clip-projects.test.ts`、imports/media 路由测试

**Interfaces:**
- Produces: `createClipProjectsRepo(db)` → `{ clearByImportId(importId): number, countSegmentsByImportId(importId): number }`（P4 再扩 CRUD）；`/api/imports` 行增 `has_video / has_project / segment_count`；`/api/media` 行增 `entry_index`。

- [ ] **Step 1: schema 两新表**

`initSchema` 追加（spec §0.4 原文 DDL）：

```sql
CREATE TABLE IF NOT EXISTS clip_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS clip_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_clip_segments_project ON clip_segments(project_id, sort_order);
```

- [ ] **Step 2: repo `clip-projects.ts`**

P2 只需两个方法（P4 扩 CRUD）：

```ts
clearByImportId(db, importId): number   // DELETE segments WHERE project_id IN (SELECT id FROM clip_projects WHERE import_id=?) + DELETE project；返回删除段数
countSegmentsByImportId(db, importId): number
```

入库不存在的 importId → 返回 0（幂等）。

- [ ] **Step 3: finalize 换集清工程（D19 服务端）**

Task 1 Step 5 已取 `oldEntryIndex`。upsert 后判定：`oldEntryIndex !== newEntryIndex`（NULL 与 NULL 视为相同）→ `clearByImportId(importId)`，`pushLog('info', 'ytdlp', \`换集 ${old} → ${new}: 清空剪辑工程 N 段\`)`；相同 → 只记 debug。

- [ ] **Step 4: /api/imports 与 /api/media 增列**

1. imports 列表 SQL 加三个派生列（LEFT JOIN `source_videos` / `clip_projects` + segments 计数）：`has_video`（素材行存在）、`has_project`、`segment_count`。repo 的 `ImportSummaryRow` 与前端 `ImportSource` 类型同步。
2. `/api/media` 列表 SELECT 增 `v.entry_index`，映射进 `MediaItem`（`entry_index: number | null`）；前端 `api.ts` 的 `MediaItem` 同步。

- [ ] **Step 5: 测试**

- repo：clear 幂等（工程不存在返 0）、count 正确。
- imports 路由：有/无素材、有/无工程三态断言。
- media 路由：entry_index 带出。
- finalize 换集：旧 2 → 新 5 → 工程被清；旧 2 → 新 2（换清晰度）→ 保留。

- [ ] **Step 6: 运行测试 + 提交（需授权）**

---

### Task 3: 前端 —— 资料库工具栏重构（产物类型 Radio）

**Files:**
- Modify: `web/src/pages/library.tsx`

**Interfaces:**
- Produces: 页面状态 `produce: 'audio' | 'video'`（替代现 `mode`）；工具栏 = 产物类型 Radio + （音频：格式 mp3/m4a/wav）（视频：档位 360/480/720/1080）+ 下载 + 删除来源。

- [ ] **Step 1: 读磁盘实况** —— 定位 P1 落下的 `PageHeader`（toolbar 里是旧 Segmented）与 Card `extra`（格式 Radio + 下载 + 删除来源）。

- [ ] **Step 2: 重构**

1. `mode` 改名 `produce`，类型 `'audio' | 'video'`（语义对齐后端 payload，减少映射）。
2. `PageHeader` toolbar 重排为：产物类型 `Radio.Group`（`音频` / `视频`，optionType button）→ 按 produce 条件渲染：audio → 格式 Radio（现有三选）；video → 档位 Radio（360/480/720/1080，默认 480，新 state `videoHeight`）→ 下载按钮（`下载(N)` / `下载`）→ 删除来源（danger）。
3. Card `extra` 清空（动作全部上移）；`title` 保持 `null`。
4. 切换 produce 时清 error/done/选中集（视频）。

- [ ] **Step 3: typecheck + 提交（需授权）**

---

### Task 4: 前端 —— 集数网格共用 + 视频单选 + D20 高亮

**Files:**
- Modify: `web/src/pages/library.tsx`
- Modify: `web/src/api.ts`（`MediaItem` 增 `entry_index`；`ImportSource` 增三布尔）

- [ ] **Step 1: 读磁盘实况** —— 定位现 Checkbox.Group 网格与 `detail.entries` 渲染。

- [ ] **Step 2: 网格双形态**

- audio：现状不变（Checkbox 多选 + 下载(N)）。
- video：**单选卡片**——同一网格视觉，点击切换选中（一次一个）；选中集蓝框；若该集是**当前素材**（`mediaList` 中该来源的 `entry_index`）→ 角标"当前素材"（D20）。`kind='single'` 的来源视频模式不渲染网格（现状）。
- 新状态：`videoSelectedIndex: number | null`、`mediaList: MediaItem[]`（video 模式挂载时与下载完成后 `listMedia()` 刷新）。

- [ ] **Step 3: typecheck + 提交（需授权）**

---

### Task 5: 前端 —— 视频下载流程（D19 确认）+ 移除 VideoClipPanel

**Files:**
- Modify: `web/src/pages/library.tsx`
- Delete: `web/src/components/VideoClipPanel.tsx`

- [ ] **Step 1: 读磁盘实况** —— 定位 `onDownload`（音频批量流）与 VideoClipPanel 引用。

- [ ] **Step 2: 视频下载流**

video 模式点"下载"：

```ts
const current = mediaList.find((m) => m.import_id === source.id);
if (current && videoSelectedIndex !== current.entry_index) {
  // D19 换集确认;segment_count > 0 时追加清点文案(P4 后才会出现)
  Modal.confirm({ title: '替换视频素材？', content: ..., okText: '下载并替换', okType: 'danger', onOk: () => doDownloadVideo() });
} else {
  void doDownloadVideo(); // 首次下载 / 同集换清晰度:不确认(m1c 覆盖语义)
}
```

`doDownloadVideo`：`startDownload({ url, title: 该集标题, entryIndex: X, collectionTitle, produce: 'video', options: { videoHeight, format: 'mp3', entryIndices: [X] } })` → 复用**现有** jobId/percent/phase 两段进度与 onDone（`kind==='video'` 分支已有）→ done 后刷新 `mediaList`（高亮随之更新）。

- [ ] **Step 3: 移除 VideoClipPanel**

1. library.tsx 删 import 与 `produce === 'video'` 下的旧渲染块。
2. **删除文件** `web/src/components/VideoClipPanel.tsx`（git 历史可寻；api 层 `clipMedia/mediaFileUrl/listMedia` 保留，P4 编辑器复用）。
3. ⚠️ **已知临时空窗**：P2 起至 P4 前，"从视频剪音频"在 UI 上暂不可用（资料库只下载、剪辑室详情页未建）。P3/P4 紧随交付。

- [ ] **Step 4: build + 提交（需授权）**

---

### Task 6: 收尾 —— 全量验证 + 手工目验

- [ ] `pnpm typecheck`（三包）+ `pnpm --filter @sct/server test` + `pnpm --filter @sct/web build` 全绿
- [ ] 手工目验（对照 spec §0.8 #4）：
  - 同一合集来源：音频模式多选下载（现状回归）；视频模式单选一集 → 下载 → 网格该集出现"当前素材"高亮
  - 换集下载弹确认；同集换清晰度不弹
  - bfm dev server 占 8000 时 `pnpm dev`：窗口仍是本项目（端口修复回归）
- [ ] 文档回写核对：spec §0.5 P2 勾选态、m1c spec 的"获取页模式"废弃标注是否仍准确

## 风险与已知取舍

1. **临时功能空窗**（剪辑能力 P2→P4 间不可用）：spec 分阶段交付的代价，已在 Task 5 与用户确认。
2. **后端锚点以磁盘实况为准**：本轮工具回执曾污染（单文件 grep 返回了他文件内容），Task 1/2 的第一步都是"读实况定位"，测试是最终安全网。
3. **D7 表提前建**：为 D19 服务端清工程；P4 不再触碰 finalize 路径。
