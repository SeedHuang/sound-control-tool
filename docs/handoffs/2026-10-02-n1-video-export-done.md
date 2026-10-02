# Session 交接：sound-control-tool → N1 视频导出全收口，余 Spec B（2026-10-02 深夜）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-10-02 深夜（Asia/Shanghai，+08:00） |
| 项目根 | `d:\Seed\sound-control-tool` |
| HEAD | `f70a336`；工作树 **42 项未提交**，全程零 git 写操作 |
| 验证基线 | typecheck **三包 0 错** + server test **509/509（42 文件）** + web build **成功** + desktop build **成功**（T6 实跑终态） |
| 继任自 | `docs/handoffs/2026-10-02-specc-complete-and-new-specs.md` |
| 状态 | **Spec C（T1–T11）+ N0/N2/N3/M2/deferred + N1 视频导出全部完成**；余 **Spec B 时间轴分级**（实测已过门槛，计划待写） |

## 本段做了什么（N1 视频导出，全流程）

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

## 工作树（42 项，等用户 commit；建议切分）

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
