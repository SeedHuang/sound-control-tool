# Session 交接：sound-control-tool → N1 视频导出全收口，余 Spec B（2026-10-02 深夜）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-10-02 深夜（Asia/Shanghai，+08:00）；OCR 交接前复审 + **修复轮已完成**（2026-10-03 凌晨） |
| 项目根 | `d:\Seed\sound-control-tool` |
| HEAD | **`43c032a`**（用户已提交全天工作）+ **工作树 12 项未提交**（OCR 修复轮 F1–F8，等用户 commit） |
| 验证基线 | typecheck **三包 0 错** + server test **511/511（42 文件）** + web build **成功** + desktop build **成功**（修复轮实跑终态） |
| 继任自 | `docs/handoffs/2026-10-02-specc-complete-and-new-specs.md` |
| 状态 | **Spec C（T1–T11）+ N0/N2/N3/M2/deferred + N1 视频导出全部完成并提交；OCR 复审 F1–F8 已修复（工作树）**；余 **Spec B 时间轴分级**（实测过门槛，计划待写）+ F9/F10 重构候选 |

## OCR 外部审查（用户提交 43c032a 后，控制器裁决）

`ocr review --from f70a336 --to 43c032a --exclude 'docs/**'` → 22 文件 / 13 条 / 5m37s。**覆盖面披露**：studio-detail.tsx + studio.tsx 一组因上下文压缩被取消（HTTP 200 取消），未全审；1 条幻觉占位（`mm/media-routes.ts` 不存在）丢弃。逐条裁决：

### 待修（下个 session 开工清单，约 6 处一行级 + 1 处中型）

| # | 位置 | 严重度 | 问题 | 控制器裁决 |
|---|---|---|---|---|
| F1 | `ytdlp-routes.ts`（/api/audio/:id/file 的 MIME 表） | **medium** | mp4 成品被 `application/octet-stream` 提供（MIME 表只有 mp3/m4a/wav）；Chromium 嗅探救了真机目验，但与 /api/media 路由不一致、有静默播放失败风险 | **修**：MIME 表加 `mp4: 'video/mp4'` + 测试断言 |
| F2 | `export-args.ts:64` | **medium** | `-movflags +faststart` 只落在逐段中间产物上，**concat 输出（真正被预览服务的最终成品）moov 在尾** → `<video preload=metadata>` 要下完才播 | **修**：buildVideoConcatArgs 加 `-movflags +faststart` + 快照更新 |
| F3 | `media-routes.ts:33` | **medium** | PROBE_FAIL 422 断言"素材坏了"，但 ffprobe 不存在（自定义 ffmpeg 路径无兄弟 ffprobe → ENOENT → null）与 60s 超时也走到这 → 好文件被引去重下 | **修**（廉价 80%）：probe 前置 `existsSync(ffprobePath)` → 走 NO_FFMPEG；next 文案补「若重下后仍失败，见日志页」。错误源细分（ENOENT/超时各自 code）记 deferred |
| F4 | `ffmpeg-export.ts:177` | low | concat 列表单引号未转义（用户名含撇号 O'Brien → 路径截断） | **修**：`'` → `'\''` 一行 |
| F5 | `ffmpeg-export.ts:180` | low | concat `-c copy` 没传 timeoutMs（默认 120s），与逐段 1h 不一致 | **修**：显式 `timeoutMs: 3_600_000` |
| F6 | `media-routes.ts:32` | low | FFMPEG_FAIL 也被两条磁盘写失败路径复用，next 仍引去查 ffmpeg | **修**：next 文案补「磁盘写入失败也会走到这里」 |
| F7 | `studio-detail.tsx:1009` | low | 删除确认文案「同时删除**音频**文件」对视频成品是假话（spec 验收第 5 条明确要求） | **修**：改 kind 无关「成品文件」 |
| F8 | `WorkPreview.tsx:125` | low | 渲染分支与 5s 上限用两个等价判定，会漂移 | **修**：统一用 `productIsVideo` |
| F9 | `ffmpeg-export.ts:141` | **medium(maint)** | 视频 separate 与音频 separate 整段复制（执行器/探测项不同） | **不现在修**——正是下个 session 对 43c032a 跑 `dry-refactor-newadd` 的头号候选（抽 runSegment/ingestSegment 回调 helper） |
| F10 | `project-routes.ts:177` | low(maint) | `ExportJobPayload.format` 联合没扩 'mp4'，路由 `as` 断言写入越界值 | **deferred**：扩联合会让音频 `CODEC_BY_FORMAT[payload.format]` 索引报 TS 错，需连带收窄；运行时安全（视频分支不消费该表）。与 F9 同批 |

low 级风格条（两层/三层嵌套三元 ×2）按 OCR 自己的口径「可能误报/nitpick」丢弃。

### ✅ 修复轮已完成（F1–F8，工作树 12 项未提交；用户撤回"多轮 OCR"，本轮为最终态）

| # | 状态 | 修复内容 |
|---|---|---|
| F1 | ✅ | `ytdlp-routes.ts` MIME 表加 `mp4: 'video/mp4'` + 新用例（video 成品 → `video/mp4`） |
| F2 | ✅ | `buildVideoConcatArgs` 加 `-movflags +faststart` + 参数快照更新 |
| F3 | ✅ | `derived-images.ts` probe 前置 `existsSync(ffprobePath)` → 缺失走 NO_FFMPEG（不冤判素材）+ 新用例；PROBE_FAIL next 补「若重下后仍失败，见日志页」；NO_FFMPEG next 补 ffprobe 同目录说明 |
| F4 | ✅ | concat 列表条目单引号转义（`concatQuote`）+ merge 测试借 clipHook 捕获列表原文断言（单引号包裹/正斜杠/3 条目） |
| F5 | ✅ | concat `-c copy` 显式 `timeoutMs: 3_600_000` + merge 测试断言 |
| F6 | ✅ | FFMPEG_FAIL next 补「磁盘写入失败也会走到这里」 |
| F7 | ✅ | 删除确认文案改 kind 无关「删除成品文件」 |
| F8 | ✅ | WorkPreview 渲染分支统一用 `productIsVideo` |
| F9/F10 | deferred | 见上表（F9 = 下个 session 对 43c032a 跑 `dry-refactor-newadd` 头号候选） |

**修复轮终态（实跑）**：server **511/511**（509 + ffprobe 缺失用例 + mp4 MIME 用例）、typecheck 三包 0、web build 成功。测试基建变化：`derived-images.test.ts` 的 `resolveOk` 从假路径改为**真桩文件**（beforeEach 造 ffmpeg.exe/ffprobe.exe——F3 的 existsSync 需要真文件）。

## 下个 session 开工清单（按序）

1. **用户 commit 工作树 12 项**（OCR 修复轮，一个 commit 即可）
2. **Spec B 时间轴分级**：写实施计划（spec D1–D5 已定，参数用 `ffmpeg-measure-report.md` B 组数字填）→ 用户过目 → 逐任务实现。锚点：N0 的 meta/自愈/inflight 基建（`derived-images.ts`）直接扩展；前端时间轴三区分权（N2-c）在缩放态语义保持
3. **F9 重构**（对 43c032a + 修复轮跑 `dry-refactor-newadd`：视频/音频 separate 循环抽 helper）+ **F10**（`ExportJobPayload.format` 扩 'mp4' + 音频索引收窄）——两件同批
4. 人工目验遗留：4K 全片 merge 拼接点音画同步、导出三选手感、Electron 出声、键盘删除（上一份交接词清单仍有效）

### 本段做了什么（N1 视频导出，全流程）

用户批准两份 spec → **先实测**（ffmpeg 11 组实验，报告 `ffmpeg-measure-report.md`）→ `writing-plans` 出 [实施计划](file:///d:/Seed/sound-control-tool/docs/superpowers/plans/2026-10-02-video-export.md) → T1–T6 逐任务（实现 → 审查 → 修复）全收口。

### 实测定死的参数（写进了计划，不许自由发挥）

- 切段：输入侧 `-ss T -to T+D`（实测 10.000s 整）
- 视频编码：`libx264 -preset veryfast -crf {high:20, mid:23, low:28}` + `-movflags +faststart`；音频 AAC 192k 重编码（直拷只省 0.07s）
- merge：**两阶段**（逐段同参编码 → concat demuxer `-c copy`，实测 0.46s vs 重编码 42.89s，93 倍、帧数分毫不差）
- 素材实为 **4K** → 视频编码 `timeoutMs: 3_600_000`
- Spec B 门槛已过：逐格 seek 36 格全片 10.29s vs 全解码 45–52s（4.4–5.1 倍）；128s 窗雪碧图 3.38s；波形走 astats（`reset=44100` 字面打印已实证禁用）

### 各任务要点（详见账本 `progress.md` 深夜批次段）

- **T1** `audio_items` 加 `media_kind/width/height`（建表 + ensureColumns 两路；repo 全链路透传）
- **T2** `crfOf`/`buildVideoClipArgs`/`buildVideoConcatArgs`/`probeVideoMeta`（实现者正确否决音频的输出侧 -ss 摆位——那是流拷贝理由，不适用于重编码）
- **T3** 任务链视频分支（**插在音频 mode 判断之前**——video 的 mode 也是 separate；merge 两阶段全程 cancelGuard；列表文件路径强制正斜杠+单引号）
- **T4** 路由校验矩阵（audio 文案逐字保留、老客户端零回归）+ `latest_product_kind` 孪生子查询
- **T5** 前端：导出内容三选 Radio / 成品明细 `<video>` 分流 + 分辨率徽标 / 预览音频只数音频 / WorkPreview 视频成品。**真机目验 7/7**（有声/无声用 `webkitAudioDecodedByteCount` 实证）
- **T6** 补「DELETE 作品连带删视频成品」锁定用例 + spec/PRD 收口注记 + 整支验证

### 审查记录

T1+T2 联合审查 Approved（0C/0I/3M，F1 失真注释控制器已修）；T3 审查通过（0C/0I/4M 均不阻塞）；T4+T5 联合审查 Approved（0C/0I/4M——控制器修掉 ②hover 5s 上限、③dev 库残留用真实 API 清理并顺带真机验证连带删除）；T6 控制器 proportionate 审查（最低风险批次，记录在案）。

## 工作树与提交

**已全部提交**：用户把全天 42 项提交为 `43c032a`「feat: 支持导出视频（带音轨/纯视频）及相关功能」（含本交接词与两份 spec/plan/PRD）。此后 OCR 复审产生的修复（若用户批准）将形成新的未提交改动。

前 30 项见上一份交接词；N1 新增：`server/src/db/schema.ts`+`schema.test.ts`、`db/repo/audio-items.ts`、`ffmpeg/export-args{,.test}.ts`、`ytdlp/ffprobe{,.test}.ts`、`media/ffmpeg-export{,.test}.ts`、`ytdlp/ingest.ts`、`media/project-routes{,.test}.ts`、`db/repo/clip-projects.ts`、`web/src/api.ts`、`web/src/pages/studio-detail.tsx`、`web/src/components/WorkPreview.tsx`、`docs/superpowers/plans/2026-10-02-video-export.md`。

## 待用户人工目验（N1 相关）

1. **4K 全片 merge 的拼接点音画同步**——实测只能验帧数/时长/无解码错误，同步要人耳人眼（导一个多段合并的视频作品听听看）
2. 「导出内容」三选的实际手感；视频导出的耗时/体积预期（4K crf23 ≈ 32MB/10s）
3. 之前遗留：Electron 出声、键盘删除、只读态、hover 触感等（见上一份交接词清单）

## 下一步：Spec B 时间轴分级

- **实测已过门槛**（B 组数据齐，逐格 seek 成立、astats 波形可行）
- **计划待写**：spec `docs/superpowers/specs/2026-10-02-timeline-pyramid.md`（D1–D5 裁决已定，参数槽用 B 组数字填）；与 N1 的串行约束已解除（N1 收口）
- 锚点：N0 已把派生图 meta/自愈/inflight 基建建好（`derived-images.ts`），Spec B 的多级/分段缓存**扩展它**不另起炉灶；前端时间轴三区分权（N2-c）在缩放态下语义要保持
- 老规矩：计划写完交用户过目 → subagent-driven 逐任务
