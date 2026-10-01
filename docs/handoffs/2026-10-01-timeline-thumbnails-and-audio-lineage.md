# Session 交接：音视频素材工具 → 两份 spec（音频血缘 + 时间轴缩略图重构）（2026-10-01）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-10-01 17:05（本机时区） |
| 项目根 | `d:\Seed\sound-control-tool` |
| HEAD | `1bbdc13`（master，与 origin/master 同步）；工作树：**83 个路径未提交**（`git status --short` 实测），无 stash／无冲突／无游离 HEAD |
| 验证基线 | typecheck **0 错误**（server/web/desktop 三包 Done）+ build **成功**（web `Compiled successfully`、desktop exit 0）+ unit **42 文件 / 399 用例全绿** + e2e **无**（本项目无 e2e 设施）（**17:05:09–17:05:19 实跑**） |
| 继任自 | `docs/handoffs/2026-09-30-m2-p3-p4-p5-execution.md` |
| 状态 | **有 4 个开放问题**（见"开放问题"节），其中第 1 条是**开工第一问** |

## 项目定位

`d:\Seed\sound-control-tool` —— 本地桌面工具（Electron 壳 + Fastify 5 服务端 + `node:sqlite`）：从 B 站等平台下载视频/音频素材 → 抽音频剪片段 → 导出成品 mp3。

## 现状

**已完成（四批切片，代码全部落地并过独立审查，全部未提交）**：
1. **M2 剩余阶段 P3/P4/P5**：剪辑室媒体卡墙、剪辑详情页（波形/胶片条 + 多段剪辑 + 导出）、首页 | 账本 `.superpowers/sdd/2026-09-30-m2-remaining-execution/progress.md`
2. **导出目录 + 工具栏图标化**：设置页可配导出目录、工具栏图标 + tooltip、导出成功绿条带「打开导出目录」 | 账本 `.superpowers/sdd/2026-09-30-export-dir-and-toolbar-icons/progress.md`
3. **资料库 UI 精修**：页面头降为右栏头、4 个 Tab 图标、下载/删除/原视频图标化、**清晰度改为按视频实测列档**（新增 `GET /api/imports/:id/formats`） | 账本 `.superpowers/sdd/2026-09-30-library-ui-polish/progress.md`
4. **下载队列 + 全局抽屉 + 托盘**：并发受限队列（默认 1）、风控节流、`GET /api/jobs?active=1`、全局任务抽屉、托盘（关窗收托盘）、托盘图标打包兜底 | 账本 `.superpowers/sdd/2026-09-30-download-queue-tray/progress.md`

- **提交状态**：**83 个路径未提交，由用户自行 commit**（提交授权制，本 session 全程未 commit）
- **验证证据**：见元信息表『验证基线』（单源，勿重复填写）
- **工作树异常**：无

## 过程记录

（**先读尾部**，最新裁决都在末尾）

- `.superpowers/sdd/2026-09-30-download-queue-tray/progress.md`
- `.superpowers/sdd/2026-09-30-library-ui-polish/progress.md`
- `.superpowers/sdd/2026-09-30-export-dir-and-toolbar-icons/progress.md`
- `.superpowers/sdd/2026-09-30-m2-remaining-execution/progress.md`
- 历史交接词链：`docs/handoffs/2026-09-30-m2-p3-p4-p5-execution.md` → 本文档

## 本次任务

在**新 session 产出两份 spec**（本 session 已讨论完两者的**决策与依据**，但**未落任何 spec 文件**）：

- **Spec A · 音频血缘 + 来源/成品信息架构**：落地 PRD FR-3.7 的剪辑血缘 —— `audio_items` 增 `source_import_id`，**下载与剪辑产物两条路径都写**；剪辑室的归并键从 `source_url` 字符串**改为该外键**；来源卡内分「素材 / 成品」两组；无来源的（录制 + 历史遗留）收成**一张**「无来源」卡。
- **Spec B · 时间轴缩略图/波形的专业重构**：把「一条 12 格合成 PNG + 固定 1600px 波形」换成「**分级 + 分段雪碧图** + **多级波形峰值**」，支持**可缩放且随缩放变密**、**视口优先 + 空闲预取**。**第一步必须先跑一轮 ffmpeg 实测**（抽帧耗时/粗层级铺满耗时/波形峰值数据量）再定参数。

流程：spec → 用户过目 → `writing-plans` 出实施计划 → `subagent-driven-development` 逐任务实现 + 独立审查 + 台账记账（**禁止 commit**）
起点：**Spec A 的写 spec 环节**（决策已讨论完，可直接落文档；但**先答"开放问题"**）

## 范围依据

**要读**：
- Spec A（血缘）：
  - `docs/prds/音频录制与剪辑-PRD初始篇.md` **行 78-82**（FR-3.5–3.7；FR-3.7 在行 80）与 **行 193-197**（`audio_items` 表定义，`parent_id` 注释在行 195）
  - `docs/superpowers/specs/m2-workspace.md` **行 38**（事实 6：明确"`parent_id` 有列但从未被写入…FR-3.7 血缘设计尚未落地"）与 **行 300**（backlog B4）
  - `server/src/db/schema.ts`（`audio_items` 表定义，含未使用的 `parent_id`）
  - `server/src/media/ffmpeg-export.ts` **行 53-58**（导出产物入库处 `sourceType: 'edit'`）
  - `server/src/media/clip-job.ts` **行 85-87**（剪辑路径同为 `'edit'`）
  - `server/src/media/project-routes.ts` **行 88**（导出路由注释）
  - `web/src/pages/studio.tsx` **行 223-240**（现有"按 `source_url` 归并、空串各自成卡"的逻辑与注释——正是要改的地方）
  - `server/src/media/home-routes.test.ts` **行 123**（首页排除 `edit`/`recording` 的固化用例）
- Spec B（缩略图/波形）：
  - `server/src/ffmpeg/derived-args.ts` **行 1-29**：`DERIVED_FILM_TILES = 12`（行 6）；`buildFilmstripArgs` 的 **`fps` 下限 `0.05`（行 27）＝"只覆盖开头 4 分钟"的根因**；波形 `showwavespic` 固定 1600×120（行 12-19）
  - `server/src/media/derived-images.ts` 全文：缓存命中判定**只按 importId**（行 23-27）、生成流程（行 36-98）、失效（行 101-106）
  - `server/src/media/media-routes.ts` **行 28-53**（`serveDerived` + 两个路由，`no-store` 在行 49）
  - `web/src/pages/studio-detail.tsx` **行 396-418**（两条轨道 `<img>` 与 `onError`——占位/骨架要加在这里）
- 四份过程账本（路径见"过程记录"节）

**勿重做**（本 session 已实现并过审的先行项，文件级）：
`server/src/ytdlp/download-queue.ts`、`server/src/ytdlp/probe-formats.ts`、`server/src/media/{jobs-routes,formats-routes,home-routes,project-routes,derived-images,ffmpeg-export,clip-job}.ts`、`server/src/output-dir.ts`、`server/src/db/{tx.ts,repo/home.ts}`、`web/src/components/TaskDrawer.tsx`、`web/src/desktop.ts`、`web/src/export-dir.ts`、`desktop/src/tray-icon.ts`、`desktop/scripts/make-tray-icon.mjs`

## 开放问题

（每条已穷尽磁盘与 git 考古，附最佳推断供**确认/纠正**）

1. **【开工第一问】Spec B 的调度策略，是否采纳本 session 提出的修正**：「**粗层级先铺满全片**（如 256 秒/格 → 30 分钟片仅需 8 帧）→ 视口细化 → 空闲**只补粗层级**；**细层级永不预取全片**」。
   **推断：采纳**。依据：`server/src/ffmpeg/derived-args.ts:27` 的 `fps` 下限本就是为限制解码耗时（`-frames:v 1`+`tile` 凑满即退出）；细层级（1 帧/秒）**无法**用 `-skip_frame nokey` 跳过（关键帧通常 1–10 秒一个，跳了会丢格）→ 只能顺序解码整片，故全片预取细层级 = 几分钟 CPU。请**确认/纠正**。
2. **两份 spec 的先后**。**推断：先 A（血缘/IA）后 B（缩略图重构）**。依据：A 改动局部、无前置依赖；B 第一步是"跑 ffmpeg 实测定参数"，可随后独立进行。请**确认/纠正**。
3. **Spec A 的血缘指向**：采纳"指向**来源**（`imported_sources.id`）"而非 PRD 原意的"源音频"。
   **推断：指向来源**。依据：PRD FR-3.7（`docs/prds/音频录制与剪辑-PRD初始篇.md:80`）写的是"`parent_id` 关联**源音频**"，但**今天的剪辑输入是视频**（`source_videos`，`import_id` 为 PK，见 `server/src/db/schema.ts`），**根本不存在"源音频"这个对象**，`parent_id` 指不动 → 新增 `source_import_id`；`parent_id` 留给未来"从音频剪音频"（列本就在，非新增）。请**确认/纠正**。
4. **来源身份是否按平台 id 归一**：现状 `imported_sources.url` 是**完整 URL + UNIQUE**，而 B 站 URL 带一堆追踪参数（见 dev 库 id 12 的 url 含 `?trackid=…&vd_source=…`）→ **同一视频从不同链接进来会变成两个来源**（`web/src/pages/studio.tsx:225` 的注释承认了这个代价）。
   **推断：现在不做**，记 backlog，触发条件 = 出现"同一作品两张来源卡"。依据：dev 库 `imported_sources` 仅 2 行、无重复证据。请**确认/纠正**。

## 既定约束（不要重新讨论、不要重新选型）

- **提交授权制**：子代理一律不 commit，由用户按逻辑块自行提交 —— 出处：用户全局规则（本 session 全程遵守）
- **每份 spec 走完整流程**：spec → 用户过目 → plan → subagent-driven-development（逐任务实现 + 独立审查 + 台账记账）—— 出处：用户全局规则
- **技术栈既定、不引入新依赖**：Electron + Fastify 5 + `node:sqlite`（跑脚本需 `--experimental-sqlite`）+ UmiJS Max 4 + antd 5 —— 出处：`desktop/package.json:17-22`、四份 spec 的 Global Constraints
- **派生图与波形由服务端 ffmpeg 出图**（不引 wavesurfer.js）—— 出处：`docs/superpowers/specs/m2-workspace.md:39`（事实 7）与 D6
- **首页"最近下载"排除 `source_type='edit'`** —— 出处：spec D8，固化用例 `server/src/media/home-routes.test.ts:123`
- **"零 schema 迁移"只约束下载队列**（复用 `jobs.status='pending'` 表达"排队中"）；**Spec A 明确要加列**，不受该约束 —— 出处：`.superpowers/sdd/2026-09-30-download-queue-tray/progress.md` 预检扫描 #8

## 遗留裁决与留观项

- **派生图缓存键只到 `importId`**（不含文件路径/mtime/size）→ 应用外替换视频文件不会失效，会一直显示旧素材的图 —— 来源：`.superpowers/sdd/2026-09-30-download-queue-tray/progress.md`；**收敛时机：Spec B 触碰 `server/src/media/derived-images.ts` 时**
- **波形覆盖全片、胶片条只覆盖前 4 分钟**（两条轨道口径不一致）—— 同上；**收敛时机：Spec B**
- **`--impersonate`（yt-dlp 浏览器指纹伪装）从未试过** —— 来源：本 session 风控讨论的收尾；**收敛时机：另立小项，不属两个 spec**
- **4K 档位是"设计保证"（探测无上界）但未拿真 4K 源实测** —— 来源：`.superpowers/sdd/2026-09-30-library-ui-polish/progress.md`；**收敛时机：用户提供 4K 源时**
- **四个切片累计约 88 条 deferred minor**（文案/注释/测试厚度/极端边界，逐条已分诊为"可延后"）—— 来源：四份账本各自的 `minor (deferred)` 行；**收敛时机：触碰相关文件时顺手收**
- **M3 打包时**需把 `desktop/assets/` 列进打包文件清单，并把托盘图标从"由构造保证"升级为"实测过" —— 来源：`.superpowers/sdd/2026-09-30-download-queue-tray/progress.md` 末节

## 开工前先做

1. `git status --short`（应为 **83 个未提交路径**）+ `git log -n 1 --oneline`（应为 `1bbdc13`）；再**实跑**基线：`pnpm typecheck` + `pnpm --filter @sct/server test`（应为 42 文件 / 399 用例）+ `pnpm --filter @sct/web build` + `pnpm --filter @sct/desktop build`
2. 读四份账本**尾部**（路径见"过程记录"），尤其 `.superpowers/sdd/2026-09-30-download-queue-tray/progress.md` 末节（托盘图标打包修复 + 它的"诚实边界"）
3. **问用户"开放问题"1–4**（第 1 条是开工第一问）
4. 读 `docs/prds/音频录制与剪辑-PRD初始篇.md` 行 78-82 与行 193-197，再读 `docs/superpowers/specs/m2-workspace.md` 行 38 与行 300
5. **提醒用户**：本 session 四批改动**全部未提交**、且**从未在真机跑过**（所有 UI 手工冒烟均为"未执行，交用户目验"）——建议先目验、再决定提交切分（81→83 个路径建议切成 4–5 笔）

## 开场话术

```
读 docs/handoffs/2026-10-01-timeline-thumbnails-and-audio-lineage.md，按交接词继续：先做 Spec A（音频血缘 + 来源/成品信息架构），再做 Spec B（时间轴缩略图/波形的专业重构）。
注意：先答交接词里的 4 个开放问题（第 1 个是开工第一问）；另外本 session 有 83 个路径未提交且从未真机验证，先提醒我处理。
```
