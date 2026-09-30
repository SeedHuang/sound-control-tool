# Session 交接：sound-control-tool → 执行 M2 剩余阶段 P3/P4/P5（2026-09-30）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-09-30 22:25（本机时区 Asia/Shanghai） |
| 项目根 | d:\Seed\sound-control-tool |
| HEAD | `be3708d`（chore: 移除无用依赖及废弃函数）；工作树：仅 3 个未跟踪 docs 文件（P3 计划 / remaining spec / 本交接词）+ 1 个未跟踪 P2 计划（`docs/superpowers/plans/2026-09-30-m2-workspace-p2-library.md`），无代码改动 |
| 验证基线 | typecheck 三包 0 错误 + web build 成功（Webpack 2.83s）+ unit 27 文件/242 用例全绿（2026-09-30 22:21 实跑，`pnpm typecheck` / `pnpm --filter @sct/server test` / `pnpm --filter @sct/web build`） |
| 继任自 | 无（首份交接） |
| 状态 | 可直接开工（P3 计划已细化；P4 授权执行 session 按 spec 细化） |

## 项目定位

`d:\Seed\sound-control-tool` —— sound-control-tool：Electron 桌面工具，从 B 站等视频源**下载视频素材**并在剪辑室**剪辑出音频**（视频优先工作流）。pnpm 三包：`web`（UmiJS Max 4 + antd 5，hash 路由）、`server`（Fastify 5 + node:sqlite）、`desktop`（Electron 壳）。

## 现状

- 已完成（全部已提交，hash 见元信息表 HEAD 与下述链条）：
  - **P1 外壳**：页面改名（首页/资料库/剪辑室/设置）、PageHeader 统一页面头、滚动收口、路由互换（提交链见 git log）
  - **端口修复**（`4da0ecb`）：dev 编排器 `scripts/dev.js`（选空闲端口→解析 Umi 实际端口→写 `.sct/dev-web-port`→拉 Electron），根治"写死 8000 加载到别人家 dev server 页面"
  - **P2 资料库下载统一**（`8ad3127` T1–T5、`cf92a0a` T7、T8/T9/终审修复折叠于其中）：`source_videos.entry_index` + 视频单集下载 + D19 换集清工程 + `/api/imports` 布尔 + 剪辑工程两表（D7）+ `DELETE /api/imports/:id` 级联 + 工具栏产物类型 Radio + 单选网格 + D20"当前素材"标记 + VideoClipPanel 移除 + 终审修复（D19 NULL 盲区）
  - **T7 纯视频收敛**（用户二次裁决）：资料库**仅视频下载**，音频一律从剪辑获得；音频下载 UI 移除，服务端 `produce='audio'` 管线休眠保留（spec D4 已修订）
  - **T9 封面/视频共用位**：解析后主区显示封面，下载后同位变视频预览（mediaRev 版本计数器，含 Critical cache-buster 修复）；点击集数=选中并下载该集
  - **DRY 清扫**（`be3708d`）：删 `retryJob`/`listAudio`/unused import/`concurrently` 死依赖/`findVideoFiles` 多余 export；重复率 0.8%（6 克隆全在测试文件，按分诊规则保留）
- 验证证据：见元信息表『验证基线』（单源）
- 提交状态：无未提交代码；未跟踪文件仅 4 个 docs（见元信息表『HEAD』），随 P3 开工一并提交
- 工作树异常：无

## 过程记录

- P2 台账（**先读尾部**，含 T1–T9 全部裁决/偏离/deferred minors）：`.superpowers/sdd/2026-09-30-m2-workspace-p2-library/progress.md`
- 各任务报告与审查包：同目录 `task-N-report.md` / `review-*.md`（P2 目验 6 条清单在 `task-6-report.md`）
- 历史交接词：无（本份为首份）

## 本次任务

按既定 spec 依次执行 **P3 剪辑室媒体列表 → P4 剪辑详情页 → P5 首页 → 收尾**；流程：**计划（已固化，勿重写）→ 子代理逐任务实现 → 独立审查（review 包落盘）→ 修复环（≤5 轮）→ 用户目验/提交 → 台账记账**；起点：**Phase P3 Task 1**（后端 `/api/imports` 增 `material_entry_index`）。

## 范围依据

- 要读（按序）：
  1. `docs/handoffs/2026-09-30-m2-p3-p4-p5-execution.md`（本文件全文）
  2. `docs/superpowers/specs/2026-09-30-m2-remaining-p3-p4-p5.md`（剩余工作 spec：现状基线 §0 / P3 §1 / P4 §2 / P5 §3 / 收尾 §4 / 验证 §5）
  3. `docs/superpowers/specs/m2-workspace.md` §0.2（D1–D20 决定表）、§0.3（P4 接口契约：projects CRUD/export 形状）、§0.4（D7 表与 D8 历史纠偏 SQL）、§0.5 P4（阶段范围）、§0.6（开工前实测 F/G/H）、§0.8（YAGNI 边界）
  4. `docs/superpowers/plans/2026-09-30-m2-remaining-execution.md`（总执行计划，逐任务清单）
  5. `docs/superpowers/plans/2026-09-30-m2-workspace-p3-studio.md`（P3 细化版——已并入总计划，交叉核对用）
  6. P2 台账尾部（见"过程记录"）
- 勿重做（文件级清单）：`source_videos.entry_index` 列与单集下载（`server/src/ytdlp/args.ts` 等）、D19 换集清工程（`server/src/ytdlp/ytdlp-routes.ts:178-185`）、`clip_projects/clip_segments` 表与 `clip-projects.ts`、`/api/imports` 布尔、library.tsx 全部视频流（共用位/单选网格/D20/D19/mediaRev）、PageHeader 组件、`scripts/dev.js` 端口编排。

## 开放问题

无。（P4 的任务粒度细化被显式授权给执行 session：按 remaining spec §2 把 8 个任务落成带代码块的实施计划即可，无需回本 session 确认。）

## 既定约束（不要重新讨论、不要重新选型）

- **方案 A**：视频一次只选一集；同集换清晰度静默覆盖不弹确认；换集（含 NULL 集号→已知集号）必弹 danger 确认 —— spec m2-workspace §0.5 P2 终审注记
- **D4**：资料库仅视频下载；音频一律从剪辑获得；音频下载 UI 不恢复；服务端音频管线休眠保留 —— spec D4（2026-09-30 修订）
- **D6/D14**：时间轴底图由服务端 ffmpeg 出图（非 wavesurfer）；固定 1600 宽 + 原子落盘 —— spec §0.2
- **D15/D18**：导出以请求体 segments 为准、不自动保存；PUT 全量替换必须包事务 —— spec §0.2
- **D17/D20**：无素材不进空编辑器（空态+跳资料库）；页面头与网格标"第 N 集" —— spec §0.2
- **D8**：剪辑产物 `source_type='edit'` + `initSchema` 历史纠偏 SQL（配单测）—— spec §0.4
- **T8 标题纪律**：任何页面不得渲染与导航 Tab 重名的标题 —— P2 台账 T8 行
- **日志铁律**：关键步骤/失败路径必须 pushLog/logFe；source 只能用 `logs.ts:14` 联合类型合法值（无 `'ytdlp'`，用 `'job'`）
- **子代理纪律**：实现子代理不 commit、不派子子代理；控制器不自己改代码（修复走子代理）；每任务第一步 Read 磁盘实况、每次编辑后读回核对（本会话工具回执有污染史，磁盘为准）
- **提交授权制**：子代理不 commit；用户按逻辑块自行提交（P1/P2 均如此）
- **Umi 纪律**：布局子页面必须 `<Outlet />`；mfsu 已关闭；hash 路由；web 无测试框架（验证=typecheck+build+手工目验）

## 遗留裁决与留观项

（来源：P2 台账；全部不阻塞，随对应阶段收口）
1. `clearByImportId` 两条 DELETE 未包事务 —— 随 P4 D18 PUT 事务顺手包
2. NULL→NULL 保留路径无专门用例 —— P4 建工程 CRUD 时补
3. D20 卡片缺 `aria-pressed` —— P4 编辑器/网格触碰时补
4. video 进度尾缀"正在写进剪辑室"措辞 —— P4 重做进度 UI 时改
5. `source-videos.ts` upsert 注释误导（缺省=清 NULL 非保留）—— P4 触碰时改
6. imports 派生列 SQL 两份（list() 内联 + derivedJoin）—— P4 触碰 imports.ts 时去重
7. mediaRev 刷新页面归零的陈旧缓存窄窗口 —— P4 编辑器版本串拼 `file_size` 收口（纯前端一行）
8. 导入弹窗 placeholder"播客"措辞（纯音频播客源无视频流）—— 随 P3/P4 文案统一

## 开工前先做

1. `git log --oneline -5; git status --short` —— 确认 HEAD ≥ `be3708d`、工作树仅有 docs 新增（若用户已提交 docs 则以实际为准）
2. 读 `docs/handoffs/2026-09-30-m2-p3-p4-p5-execution.md`（本文件全文）
3. 读 `docs/superpowers/specs/2026-09-30-m2-remaining-p3-p4-p5.md` 全文 + `docs/superpowers/specs/m2-workspace.md` §0.2–§0.8
4. 读 `docs/superpowers/plans/2026-09-30-m2-remaining-execution.md` 全文（Phase P3 T1 起逐任务执行）
5. 读 `.superpowers/sdd/2026-09-30-m2-workspace-p2-library/progress.md` 尾部（全部裁决与 deferred 明细）；并新建 P3 台账 `.superpowers/sdd/2026-09-30-m2-remaining-execution/progress.md`（首行 `# SDD ledger — plan: docs/superpowers/plans/2026-09-30-m2-remaining-execution.md`）

## 开场话术

读 docs/handoffs/2026-09-30-m2-p3-p4-p5-execution.md，按交接词继续：执行 M2 剩余阶段 P3/P4/P5（从 P3 Task 1 开始，沿用子代理逐任务+独立审查流程，不 commit 待授权）。
