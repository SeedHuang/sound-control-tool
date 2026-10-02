# 视频导出（N1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 导出内容三选——音频（现状，零回归）/ 视频·带音轨 / 视频·纯视频（mp4/H.264），成品入库挂作品、前端分流播放。

**Architecture:** `audio_items` 加 3 列（media_kind/width/height）复用整条成品链；导出任务链在 `ffmpeg-export.ts` 加视频分支（separate 逐段编码；merge = 逐段同参编码 → concat demuxer `-c copy` 两阶段，实测 0.46s/93 倍快于重编码拼接）；前端按 `media_kind` 分流 `<audio>`/`<video>`。

**Tech Stack:** Fastify 5 + node:sqlite + ffmpeg 9.0.2（Gyan full build）+ UmiJS Max 4 + antd 5。

**Spec:** `docs/superpowers/specs/2026-10-02-video-export.md`（裁决 D1–D6 在 spec，本计划不再论证）
**实测依据:** `.superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md`（A1–A6 组；素材实为 **4K**：media-13 3840×2160@25fps、media-12 4K60）

## Global Constraints

- **禁止任何 git 写操作**（提交授权制；改动留工作树由用户 commit）——用户全局规则
- **不引入新依赖**
- 术语统一「作品/成品」（"工程"是旧词）；表名 `audio_items` 保留不改（spec D1）
- 日志诚实：失败路径必有 pushLog + stderr 摘要；退出码 0 ≠ 有产物（`statSync` 复核）
- 删磁盘文件失败不让接口失败（DB 行删掉即"删了"）；D22 逐段入库前校验作品仍在——**原样复用**
- 破坏性操作二次确认（成品单条删除已有 `Modal.confirm`，语义覆盖视频成品，文案不变）
- web 页面沿用内联 style；不新建 sc 文件
- **音频导出零回归**：所有既有音频路径的参数、标题、入库、SSE 形状不变
- 验证基线：`pnpm --filter @sct/server test` **478/478**（只增不减）、`pnpm typecheck` 三包 0 错、web/desktop build 成功
- 控制器/子代理不 commit；每任务：快照（`pkg.ps1 -Mode snapshot`）→ 实现 → 独立审查 → 修复轮 → 限定范围复核 → 记账（`.superpowers/sdd/2026-10-01-clip-works/progress.md` 追加「N1 批次」段）

## 实测定死的参数（写进代码，不再自由发挥）

| 参数 | 值 | 依据（实测报告） |
|---|---|---|
| 视频编码 | `-c:v libx264 -preset veryfast -crf <N>` | A1–A4 |
| CRF 映射 | quality `high`→20、`mid`/缺省→23、`low`→28 | A4：体积 41.5/32.2/21.0MB per 10s |
| 音频（带音轨） | `-c:a aac -b:a 192k`（**重编码**，不走 copy——copy 仅省 0.07s） | A2 |
| 纯视频 | `-an` | A3 |
| 切段精度 | 输入侧 `-ss T -to T+D`（与音频同口径） | A 组：10.000s 整 |
| merge | 逐段同参编码 → concat demuxer `-f concat -safe 0 -i list.txt -c copy` | A5：0.46s vs 42.89s，4500 帧分毫不差 |
| 视频编码超时 | `timeoutMs: 3_600_000`（runFfmpegArgs 默认 120s 对 4K 不够） | A 组 + 素材 4K 事实 |
| 波形/派生图 | 不涉及（N0 已有） | — |

⚠️ **素材是 4K**：crf23 下 10s ≈ 32MB。体积大是事实，UI 不加劝阻文案（spec D6），但报告与验收要有这个预期。

---

### Task 1: DB 迁移 + repo 层

**Files:**
- Modify: `server/src/db/schema.ts`（`audio_items` 建表语句加 3 列 + `CLIP_PROJECTS_COLUMNS` 同款列注释惯例处）
- Modify: 迁移代码处（**先读** Spec C T1 的迁移落点：`schema.ts` 内 `ensureSchema`/迁移函数，照同款模式加 3 条 ALTER）
- Modify: `server/src/db/repo/audio-items.ts`（`create`/`update`/列表与单查的列映射）
- Test: `server/src/db/schema.test.ts`（老库升级用例照 Spec C T1 同款）

**Interfaces:**
- Produces: `audio_items` 新列 `media_kind TEXT NOT NULL DEFAULT 'audio' CHECK (media_kind IN ('audio','video'))`、`width INTEGER`、`height INTEGER`；`AudioItemsRepo.create` 入参与 `get/list` 返回行**透传**这 3 个字段（老调用不传 → 'audio'/null/null）

- [ ] **Step 1: 读磁盘实况**——`schema.ts` 的迁移函数与 Spec C T1 用例（备份→ALTER→幂等模式照抄）；`audio-items.ts` 的 create/行映射现状
- [ ] **Step 2: 写失败测试**——① 新建库：`PRAGMA table_info(audio_items)` 含 3 新列且 media_kind 默认 'audio'；② **老库升级**：手工建一张**没有**这 3 列的旧表 + 插 1 行 → 跑迁移 → 3 列出现、旧行 media_kind='audio'、width/height 为 NULL；③ 迁移幂等（跑两遍不炸、备份只做一次——照 Spec C T1 用例形状）
- [ ] **Step 3: 跑测试确认失败**（`pnpm --filter @sct/server test -- schema.test`）→ **Step 4: 实现**（ALTER + repo 透传）→ **Step 5: 全绿**（478 基线 + 新增）
- [ ] **Step 6: 停在此处，不 commit**

---

### Task 2: 视频导出参数 + 视频元数据探测

**Files:**
- Modify: `server/src/ffmpeg/export-args.ts`（新增 `buildVideoClipArgs` / `buildVideoConcatArgs` / `crfOf`）
- Modify: `server/src/ffmpeg/export-args.test.ts`（参数快照，照既有 `derived-args.test.ts` 风格）
- Modify: `server/src/ytdlp/ffprobe.ts`（新增 `probeVideoMeta`）

**Interfaces:**
- Produces:
  ```ts
  /** quality → CRF（实测 A4）：high→20、mid/medium/缺省→23、low→28 */
  export function crfOf(quality?: string): number;
  /** 切一段视频（带音轨 an=false / 纯视频 an=true）。输入侧 -ss/-to 与音频同口径 */
  export function buildVideoClipArgs(o: { inputPath: string; outPath: string; start: number; end: number; crf: number; an: boolean }): string[];
  /** 逐段编码后的 concat 拼接：list 文件由调用方写好（路径用正斜杠），-c copy 秒拼 */
  export function buildVideoConcatArgs(o: { listPath: string; outPath: string }): string[]; // ['-f','concat','-safe','0','-i',listPath,'-c','copy',outPath]
  /** 视频宽高（入库用）；探测失败 → null（调用方按未知处理，不失败） */
  export function probeVideoMeta(ffprobePath: string, filePath: string): Promise<{ width: number | null; height: number | null }>;
  ```
- Consumes: 既有 `runFfmpegArgs`（视频编码调用方**必须传 `timeoutMs: 3_600_000`**，在 Task 3 落实）

- [ ] **Step 1: 写参数快照测试**（TDD）——crfOf 三档；buildVideoClipArgs 含 `-c:v libx264 -preset veryfast -crf N`、`an=true` 时含 `-an` 且**不含** `-c:a`、`an=false` 时含 `-c:a aac -b:a 192k`；buildVideoConcatArgs 精确数组
- [ ] **Step 2: 红** → **Step 3: 实现** → **Step 4: 绿**（`probeVideoMeta` 用既有 `probeDuration` 同款 execFile 包装，`-select_streams v:0 -show_entries stream=width,height -of json`；解析失败/无流 → null/null）
- [ ] **Step 5: 停在此处，不 commit**

---

### Task 3: 导出任务链（ffmpeg-export.ts 视频分支）

**Files:**
- Modify: `server/src/media/ffmpeg-export.ts`
- Modify: `server/src/ytdlp/ingest.ts`（ingest opts 加 `mediaKind?/width?/height?` 透传给 `audioRepo.create`）
- Test: `server/src/media/ffmpeg-export.test.ts`

**Interfaces:**
- Consumes: T1 的 repo 列、T2 的 `crfOf`/`buildVideoClipArgs`/`buildVideoConcatArgs`/`probeVideoMeta`、既有 `cancelGuard`（M2 已就位，**视频分支必须同样在每个 await 后检查**）、`discardIfWorkGone`（D22）
- Produces:
  ```ts
  // ExportJobPayload 增：
  mediaKind?: 'audio' | 'video';   // 缺省 'audio'（老 payload 重试兼容）
  videoAn?: boolean;               // 纯视频 true（仅 mediaKind='video' 有意义）
  // emit done：kind 扩为 'video'（字段名 audioId 保留 = 成品行 id，不破坏 subscribeJob 类型）
  ```

**行为规格：**
1. `mediaKind==='video'`：format 固定按 `'mp4'`（payload.format 由路由层保证，防御性忽略其它值——记日志）
2. separate：逐段 `buildVideoClipArgs` → `runFfmpegArgs(timeoutMs: 3_600_000)` → `cancelGuard` → `probeDuration` + `probeVideoMeta` → `ingest(..., mediaKind:'video', width, height)` → progress emit（与音频同节奏）→ done emit `kind:'video', count`
3. merge：**两阶段**——逐段编码到 `export-<jobId>-m<id>-<ts>.mp4`（同 crf/an 参数）→ 全部成功后写 concat 列表文件（**路径统一正斜杠**：`file 'C:/...'`，`-safe 0`；列表文件放 tempDir，用后删）→ `buildVideoConcatArgs` 拼接 → 探测 → cancelGuard → ingest（title 用既有 `formatMergeTitle`）→ done `kind:'video', count:1`。**每阶段之间都过 cancelGuard**；任一段失败 → fail（清临时段）
4. 临时段文件清理：成功 rename 后由 ingest 接管；失败/取消路径 `rmSync force`（照既有音频分支写法）
5. 日志：`export job X kind=video mode=... crf=N an=<bool> 段=i/L`；失败带 stderr 尾行（既有 `tail`）

- [ ] **Step 1: 读磁盘实况**（ffmpeg-export.ts 现状——cancelGuard/kept 语义、ingest 闭包、done emit 形状）
- [ ] **Step 2: RED 测试**——① separate 视频 2 段（ffmpeg 桩照 S1 的 mock 版 Once：真写文件）→ 两行入库 `media_kind='video'`、width/height 来自 probe 桩、done emit kind='video'；② **取消在第 2 段** → 第 1 段保留（media_kind='video'）、status=cancelled、message 含「已保留」；③ merge 3 段 → concat 被调（桩断言 args 含 `-f concat`）、产物 1 行、标题含 `[共3段]`；④ merge 第 2 段编码失败 → fail、无入库、临时段被清；⑤ 音频回归锁：既有全部音频用例原样绿
- [ ] **Step 3: 红** → **Step 4: 实现** → **Step 5: 全绿** → **Step 6: 停在此处，不 commit**

---

### Task 4: 路由校验 + 作品摘要补最新成品类型

**Files:**
- Modify: `server/src/media/project-routes.ts`（export 路由校验；`WorkSummaryRow` 查询加 `latest_product_kind`）
- Modify: `server/src/db/repo/clip-projects.ts`（summary 查询透传该字段）
- Test: `server/src/media/project-routes.test.ts`

**Interfaces:**
- Produces: export 路由接受 body.mediaKind（`'audio'|'video'`，缺省 'audio'；video 时 format 必须 'mp4'，audio 时 format 必须 mp3|m4a|wav——**audio 分支报错文案与现状逐字一致**）；`WorkSummaryDTO.latest_product_kind: 'audio'|'video'|null`（`latest_product_id` 同源的行的 media_kind）

- [ ] **Step 1: RED**——① video+format=mp3 → 400；② video 缺 mediaKind（老客户端）→ 按 audio 处理成功；③ audio 分支全部既有校验文案不变（回归）；④ summary 返回 latest_product_kind（桩一行 video 成品 → 'video'）
- [ ] **Step 2: 红** → **Step 3: 实现** → **Step 4: 全绿（478+新增）** → **Step 5: 停，不 commit**

---

### Task 5: 前端（导出区 / 成品明细 / 预览 / hover）

**Files:**
- Modify: `web/src/api.ts`（`AudioRow` += `media_kind?: 'audio'|'video'`、`width?/height?: number|null`（**缺省按 'audio' 兜底**——老服务端混跑防护）；`exportWork` 入参加 `mediaKind?/videoAn?`；`WorkSummaryDTO` += `latest_product_kind`）
- Modify: `web/src/pages/studio-detail.tsx`（导出区 + 成品明细 + 预览音频语义）
- Modify: `web/src/components/WorkPreview.tsx`（仅音频卡播最新成品——video 时用 `<video muted playsInline>`）

**UI 规格（spec D5，逐条）：**
1. 导出区在「导出」标题行后加 Radio「导出内容」：`音频 / 视频（带音轨） / 视频（纯视频）`，state `exportKind: 'audio'|'video'|'videoAn'`，**缺省 'audio'**。选视频任一项 → 格式 Radio（mp3/m4a/wav）隐藏；切回音频恢复（保留上次选中值）。Radio.Group 用小号（`size="small"` 或按钮式，与既有两个 Radio.Group 视觉一致）
2. `doExport`：`exportWork(projectId, { mode, format: exportKind==='audio' ? exportFormat : 'mp4', mediaKind: exportKind==='audio'?'audio':'video', videoAn: exportKind==='videoAn', segments })`；onDone 分支**按 kind 无关**刷新 `listProducts`（现状已按 kind==='audio'&&count 取文案——改为 `typeof d.count === 'number'`，文案「已导出 N 段」通用）
3. 成品明细行：`media_kind==='video'` → `<video controls preload="metadata" src={audioFileUrl(it.id)}>`（复用同一 URL 路由）+ 分辨率徽标 `{height ? `${height}p` : null}`（Tag size 小）；音频行现状不动。**删除按钮/确认框/空态不动**
4. 「预览音频」按钮：只数**音频**成品（`products.filter(p => (p.media_kind ?? 'audio') === 'audio')`）；全视频时 disabled + Tooltip「这个作品只导出过视频，可在下方成品列表直接播放」
5. WorkPreview：`latest_product_kind==='video'` → `<video muted playsInline preload="none">`（纪律①②③不变：单实例/卸载/静音回退逻辑共用）

- [ ] **Step 1: 读磁盘实况**（studio-detail 导出区与成品明细现状、WorkPreview 音频分支）
- [ ] **Step 2: 实现**（无 web 单测基建——typecheck + build + 真机三查兜底）
- [ ] **Step 3: 验证**：`pnpm typecheck` 0 错、`pnpm --filter @sct/web build` 成功、`pnpm --filter @sct/server test` 478+ 不变
- [ ] **Step 4: 真机目验**（浏览器）：① 导出一段 10s 视频（带音轨）→ 成品明细出现视频行、内联可播**有声**、有 `2160p` 徽标；② 纯视频段 → 播放无音轨条；③ 音频导出回归一次；④ 「预览音频」对只有视频成品的作品禁用且 tooltip 正确；⑤ 作品墙 hover 只有视频成品的卡静音预览；⑥ **删除视频成品确认框真机点过一次**（破坏性操作铁律）
- [ ] **Step 5: 停，不 commit**

---

### Task 6: 文档回扫 + 整支验证

**Files:** `docs/superpowers/specs/2026-10-02-video-export.md`（⏳ 收口标注）、`docs/prds/剪辑体验改进需求-2026-10-02.md`（N1 节补「已实现」注记）、`docs/handoffs/` 新交接词

- [ ] **Step 1**: `pnpm typecheck` + server test + web build + desktop build 四项终态数字入报告；`git status` 无产物混入
- [ ] **Step 2**: 全库扫「只导出音频|音频导出|exportProject」类残留说法；**人工目验清单移交用户**（含 4K 体积预期：crf23 10s≈32MB，全片 merge 外推 ~2-3s 拼接 + 编码 5min 级）
- [ ] **Step 3: 停，不 commit**

## 串行约束

T1 → T2 → T3 → T4 → T5 → T6 严格串行（T3 依赖 T1/T2 契约；T4/T5 依赖 T3；全程都会触碰 `ffmpeg-export.ts`/`studio-detail.tsx`/`api.ts` 这几个今天已改过多次的文件——**每任务开工先 `git status --short` 确认工作区，diff 范围只认本任务文件**）。预期红色：T1 落地后 T2 前 server 全绿（迁移向后兼容）；T3 落地后 T4 前可能出现路由层 format 校验对 video payload 拒绝的用例红——那是 T4 要清的边界，实现者不许越界改路由。
