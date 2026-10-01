# Spec: M2 剩余阶段 —— P3 剪辑室媒体列表 / P4 剪辑详情页 / P5 首页（m2-remaining）

> 本文是 P2 收口后**剩余工作的固化 spec**，供新 session 直接执行。
> **权威与冲突裁决顺序**：P3/P4/P5 的详细契约以 `docs/superpowers/specs/m2-workspace.md`（§0.2 决定 D1–D20、§0.3 接口、§0.4 数据模型、§0.5 阶段、§0.6 实测、§0.8 验收）为权威；本文记录**其后的增补裁决**与**现状基线**，两者冲突时以本文（更新者）为准。
> 状态：**P3/P4/P5 已落地**（代码完成，待用户目验与提交）。

## 0. 现状基线（2026-09-30 交接时实核）

- HEAD `be3708d`；已提交：P1 外壳、端口修复（`4da0ecb`）、P2 T1–T5（`8ad3127`）、T7 纯视频收敛（`cf92a0a`）、DRY 清扫（`be3708d`，含 T8 标题去重/T9 封面视频位/终审修复——均折叠于前述提交）。
- 验证基线：typecheck 三包 0 错 + server 27 文件 242 用例全绿 + web build 成功（22:21 实跑）。
- 已就位设施（P3/P4/P5 直接复用，勿重做）：
  - D7 表 `clip_projects/clip_segments`（空表）+ `createClipProjectsRepo`（`clearByImportId/countSegmentsByImportId`）
  - `/api/imports`：`has_video/has_project/segment_count/material_entry_index`（`material_entry_index` **P3-T1 已增补**）
  - 封面设施：`covers.ts`（解析时后台预热）+ `coverUrl(importId)` + `GET /api/imports/:id/cover`
  - `mediaFileUrl(importId)`（Range + `?token=`；追加参数用 `&`）
  - D19 服务端：换集清工程（NULL→已知集号也算变化）+ `DELETE /api/imports/:id` 级联
  - `/studio/:importId` 占位页；`PageHeader` 组件；api.ts 休眠：`clipMedia/mediaFileUrl/listMedia/deleteMedia`（P4 复用）
  - 服务端 `produce='audio'` 管线（D4 休眠，勿删）

## 1. P3 —— 剪辑室媒体列表（修"下载视频后剪辑室空白"）

**根因**：现 `studio.tsx` 只列 `audio_items`（音频文件）；视频素材在 `source_videos`，剪辑室不可见。

**设计（用户原话落地）**：剪辑室 = **媒体中心**——列表由"来源"驱动（而非音频驱动），每个来源一张媒体卡：

1. **T1（后端）**：`/api/imports` 的 `derivedJoin` 同一 JOIN 带出 `source_videos.entry_index AS material_entry_index`（NULL 归一）；`ImportSummaryRow` 同步；路由测试补断言。
2. **T2（前端）**：`web/src/api.ts` 的 `ImportSource` 增 `material_entry_index: number | null`；`studio.tsx` 重构：
   - 列表 = `imports`（/api/imports 全量）∪ **孤儿音频**（source_url 匹配不上任何 import 的 audio_items → "未关联来源"组，沿用现 WorkGroup 的兜底键）
   - 媒体卡 = 封面（`coverUrl`，onError 灰底回退）+ 标题 + 素材状态（`has_video` → "素材：第 N 集"/"素材：集数未知"；无素材无标记）+ 音频数 + **编辑入口**（`has_video` → `/studio/:importId`；无素材 → 禁用 + tooltip，D17）
   - 点媒体卡展开该来源音频行（现有 renderRow/试听/删除复用）
   - 搜索/分页/删除音频/播放行为保留；**不加与 Tab 重名的标题**（T8 裁决）；空态引导去资料库
3. **T3**：三包 typecheck + server test + web build + 目验（下载视频后剪辑室出现媒体卡）

## 2. P4 —— 剪辑详情页（编辑器正主，结束临时功能空窗）

**权威**：m2-workspace §0.5 P4 + §0.3 接口（projects CRUD/export）+ §0.4 数据模型（已建表）+ §0.6 开工前实测 F/G/H + §0.8 验收。

**开工前实测（必做）**：F `ffmpeg showwavespic` 参数与尺寸；G `fps+tile` 胶片条换算；H 图片端点与 `sendFileWithRange` 兼容。

**范围（增补裁决已并入）**：

1. **服务端派生图**：`GET /api/media/:id/waveform`（showwavespic，固定 1600×120）与 `/filmstrip`（12 帧 tile，1600×90）；原子落盘（临时名→rename，命中=size>0）；缓存 `derived/wave-<id>.png`/`film-<id>.png`；**素材替换/删除即作废**；`onRequest` 守卫豁免（同 /cover）；失败带 stderr 摘要；全程 pushLog。
2. **剪辑工程 CRUD**：`GET /api/projects`、`GET /api/projects/:importId`（无工程 → `project: null`）、`PUT /api/projects/:importId`（全量替换**包事务** D18；校验 0≤start<end、段数≤50、label≤100；end 可超时长；`updated_at` 代码显式写 D13）、`DELETE`（幂等 200，不删素材/音频）。
3. **导出**：`POST /api/projects/:importId/export` → job `ffmpeg_export`；`segments` 必传（D15 请求体为准）；`separate` 每段入库（标题后端拼 `[mm:ss-mm:ss]`）/ `merge` concat（`[共N段]`）；payload 存素材绝对路径，retry 校验素材在；产物 `ingestDownloadedFile` 带 **`sourceType='edit'`（D8）**——`ingest.ts` 加可选参数 + `initSchema` 历史纠偏 SQL（`LIKE '%[__:__-__:__]'` + 三位分钟 GLOB 补充，配单测）。
4. **前端 `/studio/:importId`**（替换占位页）：页面头 = 来源名 + "第 N 集"（D20）；预览监视器；时间轴 = 时间尺 + 画轨（胶片条）+ 音轨（波形）+ 播放头 + 段区块；图 1600 宽固定、CSS 拉伸，`t = x/1600*duration`，**duration 以 `<video>.duration` 为唯一真相**；多段 CRUD（播放头打点/拖边微调/删除/排序/列表）；保存（PUT）；导出（分多段/合并，两段进度）；「清空所有剪辑点」二次确认；无素材空态（D17：提示 + 跳资料库）；**预览版本刷新沿用 mediaRev，并把 `file_size` 拼进版本串**（收口 P2 遗留窗口）。
5. **P4 backlog（随任务收口）**：`clearByImportId` 包事务（随 D18）；NULL→NULL 保留用例；`aria-pressed`；video 进度尾缀措辞；`source-videos.ts` upsert 注释校正（缺省=清 NULL）；imports 派生列 SQL 去重（`list()` 复用 `derivedJoin`）；"删来源级联"回归用例显式化。

**不做（YAGNI，spec §0.8）**：effects 层、多层多轨、视频画面剪辑/导出、cut 模式、波形缩放、标签、录制、自动清理。

## 3. P5 —— 首页

- `GET /api/home`：`editing` = `clip_projects` 按 `updated_at` 倒序 3（含 import_id/name/site/segment_count）；`recent` = `audio_items` `source_type='download'` **按来源去重**后最近 3；两者排除 `import_id` 为 NULL 的条目。
- `index.tsx` 重构：两块 Top3（封面 `coverUrl`、点击分别进 `/studio/:importId` 与资料库对应来源）；空态 antd `Empty`；健康检查挪到设置页；**无重复标题**。

## 4. 收尾

1. PRD 回写（`docs/prds/音频录制与剪辑-PRD初始篇.md`）：§5 页面结构表（新路由）、§6 里程碑（P1–P5 对应）、§2.3/§2.4 措辞对齐"资料库/剪辑室/仅视频下载"。
2. m1c spec §0.6：标注"获取页视频预览剪音频模式"已废弃（迁剪辑室）。
3. P4 backlog 逐项执行 + 分诊记录。

## 5. 验证基线与提交

- 每任务后：对应包 typecheck + server vitest（基线 242 + 增量）+ web build。
- 提交：**用户授权制**（沿用 P2：子代理不 commit，用户按逻辑块自行提交）。
- 手工目验累计清单随各阶段 report 汇编。
