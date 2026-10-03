# Session 交接：sound-control-tool → 导出任务两笔技术债（F9 缩减范围 + F11）（2026-10-04）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-10-04 00:12（Asia/Shanghai，+08:00） |
| 项目根 | `d:\Seed\sound-control-tool` |
| HEAD | `3e95aee`；工作树：**2 项未提交**（`docs/handoffs/2026-10-03-specb-timeline-pyramid.md`、`docs/superpowers/specs/2026-10-02-timeline-pyramid.md`，均为本次 session 补记验收结论的文档改动） |
| 验证基线 | typecheck 三包 **0 错** + build web/desktop **EXIT=0** + server unit **607/607（44 文件）**（**2026-10-04 00:12 实跑**） |
| 继任自 | `docs/handoffs/2026-10-03-specb-timeline-pyramid.md` |
| 状态 | **有 1 个开放问题**（见「开放问题」节：F9 缩减范围系 agent 判断、用户未表态） |

## 项目定位

`d:\Seed\sound-control-tool` —— Electron + Fastify + UmiJS 的**「音频录制与剪辑」桌面工具**：下载 B 站/YouTube 视频 → 剪辑室切段 → 导出音频/视频成品。

## 现状

- **已完成**：Spec B（时间轴分级重构：36 格总览 / 128s 中景 / 24s 近景 + Canvas 自绘波形）T1–T8 全部实施并验收；随后 **13 轮 OCR 收敛** + **1 起真机 401 事故修复**（见 `progress.md`「真机 401 事故」段）+ **5 轮事故后复审**（见同文件「第 14 轮 · 事故后复审」段）。用户已提交 `3e95aee`。
- **验证证据**：见元信息表『验证基线』（单源，勿重复填写）。
- **提交状态**：Spec B 全批已由用户提交（`3e95aee`）；本 session 新增的两个文档改动**未提交，由用户自行 commit**（用户全局规则：禁止任何 git 写操作）。
- **工作树异常**：无。

### 上一批验收结果（用户 2026-10-03 确认）

Spec §6 人工目验五条**用户已全部确认「没问题」**（原话：「这个 5 个我看过了，没问题」）。另有四条历史遗留目验同日销账：键盘激活卡片内删除按钮、Electron hover 预览出声、400ms 触感、滚动不回顶。

⚠️ **必须知道的事实**：Spec §6 的第 1/2/4 条是在 **401 事故修复之后**才第一次真正看到图的（事故期间切中景/近景必然失败）——「验过了」指「修完之后验过一遍」，不是「验过两遍」。

## 过程记录

- `.superpowers/sdd/2026-10-03-timeline-pyramid/progress.md`（**先读尾部**，三节按序：「真机 401 事故」→「第 14 轮 · 事故后复审」→「本批遗留」）
- 历史交接词链：`docs/handoffs/2026-10-01-timeline-thumbnails-and-audio-lineage.md` → `docs/handoffs/2026-10-03-specb-timeline-pyramid.md` → 本文件

## 本次任务

清理**导出任务（`server/src/media/ffmpeg-export.ts`）的两笔技术债**：F9 缩减范围（补 finally 清理 + 扩 format 类型联合）+ F11（取消导出时杀掉 ffmpeg 子进程）。

流程：**读码核实 → 改 → 立即 tsc → server `npm test` → web/desktop build → 更新 `progress.md`**；起点：**直接改代码**（无 spec 环节 —— 范围已在本 session 逐行论证，见「遗留裁决与留观项」）。

> 本项目一贯流程（供参考，本批**不需要**）：spec → 用户过目 → `writing-plans` 出实施计划 → `subagent-driven-development` 逐任务实现。本批改动小且范围已论证，**可直接实现 + 自验**。

## 范围依据

- **要读**：
  - `server/src/media/ffmpeg-export.ts` **全文**（254 行）—— 四条产物分支的清理路径全在这里：
    - 视频 separate：**第 139–160 行**（无 finally）
    - 视频 merge：**第 167–211 行**（**已有 finally**，第 204–211 行 —— 这是要对齐的样板）
    - 音频 separate：**第 215–236 行**（无 finally）
    - 音频 merge：**第 238–250 行**（无 finally）
  - `server/src/media/project-routes.ts` **第 158–196 行** —— 导出 payload 构造；第 175–177 行是 `format` 那段谎言的出处（注释里写明了当初为什么没扩）
  - `server/src/bootstrap.ts` **第 7–13 行** `cleanOrphans`、**第 15–29 行** `listActiveTempFiles` —— 泄漏的兜底清理机制，判断严重度必须读它
  - `server/src/media/ffmpeg-export.test.ts` **第 241–245 行** —— 那个 `as unknown as` 的强转
- **勿重做**：`3e95aee` 全部内容（Spec B 批次）；F9 的「抽 helper」子项**已论证不做**（理由见下节，别重新捡起来）。

## 开放问题

1. **F9 缩减范围（砍掉「抽 helper」子项）是本 session agent 的判断，用户未明确表态**；推断：**采纳缩减后的范围**。依据：
   - F9 原本三件事（见 `docs/handoffs/2026-10-03-specb-timeline-pyramid.md` 第 90 行），逐行核对后成色不同 —— ①finally 清理与 ③类型联合是**真缺陷**，②抽 helper 是**已完成的抽象再抽一层**。
   - ②的判据：共用件（`cancelGuard` / `discardIfWorkGone` / `ingest` / `formatClipTitle` / `tail` / `ffprobePathFrom`）**已全部是独立函数**（证据：`ffmpeg-export.ts` 第 38–40、49–90、113–127 行）；剩下的只是 20 行循环骨架、5 处差异，再抽需传 4–5 个回调，可读性反而下降。
   - 请用户：**确认**（默认按缩减范围做）／**纠正**（坚持三件全做）。
2. **F11 是否与本批一起做**；推断：**一起做**，理由见「遗留裁决与留观项」F11 条。请用户：确认／拆分。

## 既定约束（不要重新讨论、不要重新选型）

- **禁止任何 git 写操作**（commit/push/add 等）—— 用户全局规则；改动留工作树由用户提交。
- **每次编辑后立即 `npx tsc --noEmit`** —— 实测救场 4 次（T5 `Record` 键类型、T7 默认导出/类型窄化、OCR 修复轮多次漏 import）—— 出处：`progress.md` T5/T7 自查段。
- **server 测试必须用 `npm test`（不是 `npx vitest run`）** —— 后者缺 `--experimental-sqlite`，会让 23 个文件加载失败（`Error: No such built-in module: node:sqlite`），极易误判成「我的改动炸了」。出处：`progress.md` T1 踩坑记录（第 77 行）。
- **失败路径必须写 `pushLog`**（否则用户看到的「失败：」是空的）；**`execFile` 用三参回调、stderr 永远记下来** —— 出处：`.trae/rules/trae-project-rules.md`。
- **删除/写入接口的 IO 语义**：删文件失败**不让接口失败**（DB 行删了即达到「删了」语义）；写文件失败才返错 —— 出处：`.trae/rules/trae-project-rules.md`。
- **危险操作必须二次确认**（antd `Modal.confirm` + `okType:'danger'`）—— 出处：同文件。

## 遗留裁决与留观项

### F9（本批主体）—— 三子项的逐条处置

来源：`docs/handoffs/2026-10-03-specb-timeline-pyramid.md` **第 90 行**（原文：「ffmpeg-export.ts 视频/音频 separate 循环抽 helper + separate/音频分支统一 finally 清理 + `ExportJobPayload.format` 联合扩 'mp4'」）；上游：对 `554b4d5` 跑 `dry-refactor-newadd` 的头号候选。

| 子项 | 处置 | 证据与理由 |
|---|---|---|
| ① **统一 finally 清理** | ✅ **做** | **不对称**：四条分支里只有视频 merge 有 finally（第 204–211 行）；另三条只在「ffmpeg 失败」分支删临时文件，**入库那步抛错时（rename EBUSY，第 170 行注释点名）临时文件无人删**。4K 素材单段数百 MB、merge 成品数 GB |
| ② **抽 helper** | ❌ **不做**（agent 判断，待用户确认） | 共用件已全抽出（见「开放问题」1 的判据）；剩下循环骨架 5 处差异，再抽需 4–5 个回调，可读性下降 |
| ③ **`format` 联合扩 `'mp4'`** | ✅ **做** | 类型**说谎**：声明 `'mp3'\|'m4a'\|'wav'`（第 25 行），视频时运行值确实是 `'mp4'`（`project-routes.ts` 第 177 行注释自认「仅是类型层收窄」）。代价是 3 处强转，其中 `ffmpeg-export.test.ts` 第 245 行是 `as unknown as` —— **彻底绕过类型检查**。且当初没扩的理由**是任务文件白名单限制**（`project-routes.ts` 第 175–176 行原文：「本次任务文件清单不含 ffmpeg-export.ts 不扩类型」+「T3 测试注释预期过『T4 扩』」），**不是设计判断** → 属漏做 |

**①的严重度校准（必须知道，否则会高估）**：泄漏**有兜底** —— `bootstrap.ts` 第 45 行 `cleanOrphans(tempDir, keep)` 在每次启动时清空 temp 目录。而 `keep` 在实践中**恒为空集**：`listActiveTempFiles`（第 15–29 行）读 `payload.tempFiles`，但**全仓库无任何代码写入该字段**（证据：`grep -n tempFiles server/src` 仅命中 `bootstrap.ts` 4 处，全是读）。所以泄漏的实际形态是「**多 GB 文件在 temp 里躺到下次重启**」，不是永久泄漏。

**③的连带改动面**（改一处要同步三处）：
- `server/src/media/ffmpeg-export.ts` 第 25 行（联合定义）+ 第 135 行（`as string` 强转可删）
- `server/src/media/project-routes.ts` 第 177 行（`as 'mp3'|'m4a'|'wav'` 可简化）
- `server/src/media/ffmpeg-export.test.ts` 第 245 行（`as unknown as` 可删）
- ⚠️ 改前先确认：`format` 扩到含 `'mp4'` 后，音频路径的**运行时合法性**由 `project-routes.ts` 第 159–163 行的白名单校验继续保证（`mediaKind==='audio'` 时只接受 mp3/m4a/wav，否则 400）—— 类型放宽不等于校验放宽，**不要把路由那层校验一起放宽**。

### F11（本批第二主体）

来源：`docs/handoffs/2026-10-03-specb-timeline-pyramid.md` **第 91 行**。

**问题**：取消导出时**杀不掉正在跑的 ffmpeg 子进程**。

**机制（逐环说清）**：取消路由 `POST /api/jobs/:id/cancel`（`server/src/ytdlp/ytdlp-routes.ts` **第 755–776 行**）只做三件事 —— `queue.cancelQueued(id)`（排队中的，第 767 行）、`downloadManager.cancel(id)`（第 771 行，**只登记了下载的 yt-dlp 子进程**）、`jobsRepo.update(status:'cancelled')`（第 772 行）。而导出的 ffmpeg 是 `runFfmpegArgs` / `runClip` 起的，**不在任何进程登记表里** → kill 不到。

**后果**：用户点「取消」，界面停了、DB 置 cancelled，但 ffmpeg 继续跑到当前段编码完（4K 段可达数分钟；`timeoutMs` 上限 1 小时）。现有 `cancelGuard`（`ffmpeg-export.ts` 第 69–82 行）只做**事后收敛**（跑完才丢产物、维持 cancelled 终态），**不省 CPU**。代码注释已如实承认此事（第 58–60 行）。

**建议做法**：建一张按 jobId 的进程登记表（`Map<jobId, ChildProcess>`），`runFfmpegArgs`/`runClip` 起进程时登记、退出时注销；取消路由查出后 kill。⚠️ **实施前先向用户确认**（涉及跨模块改动：`clip.ts` + `ffmpeg-export.ts` + `ytdlp-routes.ts` 三处联动）。**收敛时机**：原记「用户拍板后专项」，本 session 判断可与 F9 合批（同属导出任务，改一次测一次）。

### 三条人工目验（仍未验，移交用户）

来源：`docs/handoffs/2026-10-03-specb-timeline-pyramid.md` **第 92 行**（累积清单，已销 3 条）：

1. **4K 全片 merge，拼接点音画同步**（人耳听 + 人眼看接缝）
2. **「导出内容」三选手感 + 4K 体积是否符合预期**（crf23 下 10 秒 ≈ 32MB）
3. **只读态两种黄条 + 重试恢复**（构造「素材被删」「作品被删」两种异常态；从 Spec C T9 挂下来的）

三件都要真机（Electron）+ 真实 4K 素材，程序侧验不了。

### 有意不做（不算欠账，别当遗留捡起来）

- **空闲预取** —— Spec B 只做「视口优先」（往回拖时现生成约 3.4s）；来源：`specs/2026-10-02-timeline-pyramid.md` D4，本批刻意划出。
- **L2 门槛真机观感** —— `>300s` 是推导值（依据：L0 的 36 格与 L1 的 12 格/128s 密度交叉点在 T≈384s），需一段 5–8 分钟素材才能验。
- **`buildFilmstripArgs` / `filmstripVfFor` / `filmstripShapeSig`** —— 生产无调用者但**有意保留**（锁着 N0 那段「为什么不能用 fps 滤镜」的推理与 9 条断言）。
- **`waveformUrl` 路由** —— 前端已无调用方，保留供老缓存混跑，**不是死代码**。

## 开工前先做

1. `git status --short` + `git log --oneline -3` 确认 HEAD 在 `3e95aee`；跑 `cd server; npm test` 复核基线（应为 **607/607**）。
2. 读 `server/src/media/ffmpeg-export.ts` **全文**，重点是四条分支的清理路径（行号见「范围依据」）。
3. 读 `server/src/media/project-routes.ts` **第 158–196 行**，确认 `format` 校验链与 payload 构造。
4. 读 `server/src/bootstrap.ts` **第 7–29 行**，理解 `cleanOrphans` 与 `payload.tempFiles` 的现状（决定 ① 的严重度表述）。
5. **就「开放问题」两问向用户取确认**（F9 缩减范围 / F11 是否合批）—— 拿到答复再动手。

## 开场话术

读 `docs/handoffs/2026-10-04-export-debt-f9-f11.md`，按交接词继续：清理导出任务两笔技术债（F9 缩减范围 + F11）。先按「开放问题」节向我确认两件事，再动手。
