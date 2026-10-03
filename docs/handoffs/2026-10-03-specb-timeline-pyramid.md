# Session 交接：sound-control-tool → Spec B 时间轴分级落盘与实施（2026-10-03）

## 元信息

| 键 | 值 |
|---|---|
| 交接时间 | 2026-10-03 17:52（Asia/Shanghai，+08:00） |
| 项目根 | `d:\Seed\sound-control-tool` |
| HEAD | `554b4d5`（feat(media): 新增素材生成期间被替换/删除的 SRC_CHANGED 错误处理）；工作树：**clean**（`git status --short` 实查无输出） |
| 验证基线 | typecheck 三包 0 错 + web build 成功 + desktop build 成功（EXIT=0）+ server test **516/516（42 文件）**（全部 17:52 实跑） |
| 继任自 | `docs/handoffs/2026-10-02-n1-video-export-done.md`（该文中「工作树 12 项未提交」「上轮 OCR 为最终态」两行已过时，以本文件为准） |
| 状态 | 可直接开工。唯一前置：Spec B 实施计划正文落盘后交用户过目（计划骨架已定稿收录在本文「范围依据」，落盘是誊写不是重新设计） |

## 项目定位

`d:\Seed\sound-control-tool` —— 本地音视频下载/剪辑/导出桌面工具：Electron 壳 + Fastify 5 + node:sqlite 服务端 + UmiJS Max/antd5 前端 + ffmpeg 9.0.2（Gyan full build），Windows。

## 现状

- 已完成（commit 链）：`43c032a` N1 视频导出全收口 → `005760d` OCR 复审修复 F1–F8 → `554b4d5` 本 session 的 OCR 12 轮收敛修复（7 文件，用户已自行 commit）。
- 本 session（OCR 循环）修掉的问题按主题归并：
  1. **临时文件泄漏**：`server/src/media/ffmpeg-export.ts` 视频 merge 成品纳入 finally 清理（`mergedTmp` 哨兵）。
  2. **僵尸手势监听**：`web/src/pages/studio-detail.tsx` startScrub 增加 window capture 阶段 pointerdown 兜底收尾（stop 内自拆，注释同步 ×4）。
  3. **触屏定位**：时间轴轨道层补 `touchAction:'none'`。
  4. **派生图换源竞态（最深的一个，OCR 四轮递进挖出）**：生成期间素材被换源/删除时，旧内容图凭 meta 自洽会**永久命中缓存**。最终三层防护全在 `server/src/media/derived-images.ts`：①在途 key 折进内容身份（`srcIdentityOf`/`srcIdentityKey`/`sameSrcIdentity` 三 helper 单一来源，key = dir|kind|importId|path|mtime:size）；②落盘前**一次性变局分类器**（`srcChanged: 'replaced'|'deleted'|null`，被替换→刷新自愈文案，被删除→引导重下文案）；③路由注入三态 `sourceState`（`media-routes.ts` 查 DB 现登记：row 没了='gone'、换人='replaced'）。
  5. **新失败码**：`SRC_CHANGED` → 409（`media-routes.ts` DERIVED_FAIL 表 + `derived-images.ts` DerivedResult 联合）。
  6. **作品墙滚动补偿**：`web/src/pages/studio.tsx` `Math.ceil`→`Math.round`（真实位移取决于锚点列位，round 才是多数锚点的真位移；delta=1 最常见路径不再被无端推一行）。
  7. **诚实性勘误**：ffmpeg-export cancelGuard「message 抽屉可见」说法不实（`GET /api/jobs` 只回 pending/running），注释改为如实写明可见渠道。
  8. **新增 5 个测试**（derived-images.test.ts 4 个：videoPath 不同的并发不并任务、换源 SRC_CHANGED、稳定源不误伤、sourceState replaced/gone 分流；media-routes.test.ts 1 个：409 映射）。
- OCR 轮次台账：R1(7 条)→R2(0)→R3(11)→R4(1)→R5(5)→R6(3)→R7(3)→R8(2)→R9(2)→R10(3)→R11(1)→R12(**0，收敛**)。逐轮原始输出在 `C:\Users\HuangChunhua\AppData\Local\Temp\sct-ocr-r1.txt` … `sct-ocr-r12.txt`（temp 目录可能被系统清理，关键裁决已收录本文）。
- 提交状态：clean（见元信息表）。
- 工作树异常：无。

## 过程记录

- 账本：`.superpowers/sdd/2026-10-01-clip-works/progress.md`（先读尾部「N1 批次」段；**Spec B 尚无自己的 sdd 目录**，开工时建，见「开工前先做」第 4 条）。
- 实测报告：`.superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md`（§B 组 = Spec B 全部参数依据；裁决表②在文末）。
- 历史交接词链：`docs/handoffs/2026-09-30-m2-p3-p4-p5-execution.md` → `2026-10-01-timeline-thumbnails-and-audio-lineage.md` → `2026-10-02-specc-complete-and-new-specs.md` → `2026-10-02-n1-video-export-done.md` → 本文件。

## 本次任务

**Spec B 时间轴分级重构**：看得清（采样密度随缩放变密）+ 两种切换方式（缩放+平移都流畅）。流程：①落盘实施计划 `docs/superpowers/plans/2026-10-03-timeline-pyramid.md`（骨架=本文「范围依据」，誊写+按 writing-plans skill 补步骤细节）→ ②交用户过目 → ③subagent-driven 逐任务 → ④文档回扫+整支验证收口。**起点：环节①**（用户已指示「按方案开始实施」，但会话被 OCR 循环打断，计划正文从未落盘——这是开工第一动作）。

## 范围依据

**要读（按序）：**
1. `docs/superpowers/specs/2026-10-02-timeline-pyramid.md` 全文（D1–D5 裁决 + §5 不做清单 + §6 验收五条）。
2. `.superpowers/sdd/2026-10-01-clip-works/ffmpeg-measure-report.md` §B 组 + 「裁决表②」（B1：全片 36 格逐格 seek 10.29s vs 全解码 45–52s；B2：128s 窗 12 格 3.38s；B3：astats 修正链路全片 2.31s/段内 1600 点 0.9s；**B3a 反例：字面 `reset=44100` 全键打印 = 480s 超时 + 334MB 日志，严禁**；B4：60fps 源每格 0.43s）。
3. `server/src/ffmpeg/derived-args.ts` 全文（现有 12 格常量、形状签名机制、fps 公式的注释规约）。
4. `server/src/media/derived-images.ts` 全文（**本 session 大改过**：srcIdentityOf 三 helper、SRC_CHANGED 变局分类器、sourceState 注入点都在 `generateDerivedImage` 内；meta 自愈/inflight/原子落盘是 Spec B 分段缓存的地基，**扩展它，不另起炉灶**）。
5. `server/src/media/media-routes.ts` 的 `serveDerived` 与 `DERIVED_FAIL` 表（鉴权三件套与失败码映射的照抄模板）。
6. `web/src/pages/studio-detail.tsx`：行 ~440–540（dragEdge/startScrub/xToTime 三区分权）+ 行 ~810–880（时间轴渲染：时间尺/画轨/音轨/段区块/播放头）。
7. `web/src/api.ts` 行 189–196（filmstripUrl/waveformUrl 的 query-token 模式）。

**计划骨架（8 任务，参数会话内已定死，落盘时勿自由发挥）：**

| 定死项 | 值 | 依据 |
|---|---|---|
| L0 总览 | 36 格全片一张，**接管 legacy `/filmstrip` 路由**（URL/文件名 `film-<id>.png` 不变），生成从 fps 滤镜整解码改为逐格 seek（45–52s → 10.29s） | B1 |
| L1 中景 | 12 格 / 128s 窗，`film-<id>-L1-<seg>.png`，段内逐格 seek + tile 拼接，终宽 = 格数×160、高 90 | B2 |
| L2 近景 | 12 格 / 24s 窗，同上；**服务端门槛 duration > 300s**（D5），前端档位 duration>128s 才可用 | spec D1/D5 |
| 采样点 | 每格取区间起点（N0 语义），末段不足整窗按实际 span | 沿用 N0 |
| 波形峰值 | astats 修正链路 `-af asetnsamples=<N>,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level -f null -`，解析 **stderr**；L0 全片 N=48000、L1 段 N=3840、L2 段 N=720（每段目标 1600 点）；JSON 自带凭据 `{v,sig,level,seg,t0,stepSec,points}`，-inf→-99，原子落盘 | B3b/B3c |
| 前端波形 | Canvas 自绘（新组件 `web/src/components/TimelineWave.tsx`），L0 峰值兜底绘制，替换 `<img waveform>`；legacy `/waveform` PNG 路由保留不删（混跑兼容） | spec D2 |
| 交互 | 档位离散（L0/L1/L2）；Ctrl+滚轮用 useEffect 原生监听 `{passive:false}`；缩放态空白拖动=平移、单击无位移=seek；**min 档保持 N2-c 拖动定位**；切换规则写死并注释（D3）；段区块/播放头/刻度全部按可视窗口换算；失败段斜纹占位+重试（D5）；相邻段 requestIdleCallback 预取、并发 1 | spec D3/D4 |
| 缓存 | 扩展现有 meta 自愈模式：`FILM_META_V` 2→3（老图自动失效）；分段文件 `film-<id>-L<lv>-<seg>.png`；`invalidateDerived` 改前缀扫描清全级（**注意 importId 前缀碰撞：`film-1-` 会误匹配 `film-11-`，须精确段匹配**） | spec D4 |

任务序：T1 纯函数层（derived-args.ts 扩展+快照测试）→ T2 L0 接管 → T3 L1/L2 分段生成器（derived-pyramid.ts）+ invalidate 全级清扫 → T4 波形峰值生成器 → T5 路由+api.ts → T6 波形 Canvas → T7 缩放/平移/分段画轨 → T8 文档回扫+整支验证。严格串行；每任务「快照 → RED → 实现 → 绿 → 停在此处不 commit」。

**勿重做**：N0/N1 已实现项全部在 `554b4d5` 内；OCR 修复轮全部内容已提交。

## 开放问题

1. L1/L2 档位可用性阈值（duration>128s / >300s）是计划推导值而非实测项：L0 36 格与 L1 12 格/128s 的密度 crossover 在 T≈384s，取 spec 的「5 分钟」（D5）与 128s 窗对齐取整；推断依据见 ffmpeg-measure-report §B1 密度换算。请用户确认（不阻塞开工，异议只需改两个常量）。

## 既定约束（不要重新讨论、不要重新选型）

- 禁止任何 git 写操作（提交授权制，改动留工作树由用户 commit）——用户全局规则。
- 不引入新依赖；**不引 wavesurfer.js**（m2-workspace D6 裁决）；不做无级平滑缩放/多轨/关键帧帧级对齐（spec §5）。
- L0 语义保持「覆盖整段」，末格差一格是采样点约定，接受（spec §5，N0 结论）。
- N2-c 三区分权（拖柄①/定位②/选中③）在缩放态语义保持，切换规则写死并注释（spec D3 原文要求）。
- 失败段明确占位（斜纹+重试），不用邻段冒充（spec D5 诚实原则）。
- Electron 前后端关键步骤/每个请求必须加日志且日志页可见（`.trae/rules/electron-dev-must-log.md`）。
- web 页面沿用内联 style，不建 sc 文件（N1 惯例）。
- server test 基线 516/516 只增不减；OCR 沉淀的代码模式照用：DERIVED_FAIL 表「加新失败码只加一行」、派生图鉴权三件套（query token / 本机 origin / 本机 referer）、身份 helper 单一来源。
- 破坏性操作二次确认、删除接口文件 IO 失败不让接口失败（`.trae/rules/trae-project-rules.md`）。

## 遗留裁决与留观项

- **F9 批**（专项重构 session）：ffmpeg-export.ts 视频/音频 separate 循环抽 helper + separate/音频分支统一 finally 清理 + `ExportJobPayload.format` 联合扩 'mp4' —— 来源：本 session OCR R1-7/R6-1/R7-2/R1-5（对 `554b4d5` 跑 dry-refactor-newadd 的头号候选）；收敛时机：专门重构批。
- **F11**：取消导出不杀 ffmpeg 子进程（需按 jobId 的进程登记表 + kill；实际浪费窗口=当前段编码时长，1h 是 timeout 上限；cancelGuard 注释已如实承认）—— 来源：R3-2；收敛时机：用户拍板后专项。
- **人工目验遗留（累积清单，移交用户）**：4K 全片 merge 拼接点音画同步（人耳人眼）；「导出内容」三选手感与 4K 体积预期（crf23 10s≈32MB）；Electron 出声；键盘删除；只读态；hover 触感。
- Spec B 验收五条（spec §6）在 T8 一并移交人工目验。

## 开工前先做

1. `git status --short` + `git log --oneline -3`：确认 HEAD 在 `554b4d5` 之后且工作树干净；若有新提交先看 `git show --stat` 了解范围。
2. 读「范围依据」第 1、2 项（spec 全文 + 实测报告 §B 组）——参数表已定死，读完直接誊写计划。
3. 读 `server/src/media/derived-images.ts` 全文（本 session 刚大改：身份三 helper、SRC_CHANGED 分类器、sourceState 注入点都在里面，Spec B 的分段生成器要复用这套模式）。
4. 建 `.superpowers/sdd/2026-10-03-timeline-pyramid/`：从 `.superpowers/sdd/2026-10-01-clip-works/` 复制 `pkg.ps1`，新建 `progress.md`（记「Spec B 批次」）。
5. 落盘 `docs/superpowers/plans/2026-10-03-timeline-pyramid.md`（writing-plans skill，骨架=本文「范围依据」）→ 交用户过目 → 批准后 subagent-driven 逐任务。

## 开场话术

读 docs/handoffs/2026-10-03-specb-timeline-pyramid.md，按交接词继续：落盘 Spec B 实施计划并交我过目。

---

# 实施结果（2026-10-03 收口）

**8 个任务（T1–T8）全部完成**，改动留在工作树（**未 commit**，由用户提交）。
- 计划：`docs/superpowers/plans/2026-10-03-timeline-pyramid.md`
- 账本：`.superpowers/sdd/2026-10-03-timeline-pyramid/progress.md`（逐任务记录）
- 各任务 review package：同目录 `task-1..8-review-package.txt`

## 验证（终态实测，命令随数字一并给出）

| 项 | 结果 | 取数命令 |
|---|---|---|
| server 测试 | **595/595 绿，44 文件**（批次起点 516 → +79） | `cd server; npm test` |
| server typecheck | 0 错 | `cd server; npx tsc --noEmit` |
| web typecheck | 0 错 | `cd web; npx tsc --noEmit` |
| web build | EXIT=0 | `cd web; npm run build` |
| desktop typecheck | 0 错 | `cd desktop; npx tsc --noEmit` |
| desktop build | EXIT=0 | `cd desktop; npm run build` |
| 工作树 | 11 个 M + 7 个未跟踪（**无提交**） | `git status --short` |

## 落地内容

1. **L0 总览接管 legacy `/filmstrip`**：36 格逐格 `-ss` seek + tile 拼接（实测 45–52s → **10.29s**）；**URL 与文件名 `film-<id>.png` 不变**。
2. **L1/L2 分段雪碧图**：12 格/128s 窗、12 格/24s 窗 → `film-<id>-L<lv>-<seg>.png`；新路由 `/api/media/:id/filmseg?level=1|2&seg=N`。
3. **波形峰值**：astats 修正链路解析 **stderr** → 七字段 JSON（`wavepeak-<id>-L<lv>[-<seg>].json`）；新路由 `/api/media/:id/wavepeak?level=0|1|2[&seg=N]`。
4. **前端波形自绘**：`web/src/components/TimelineWave.tsx`（Canvas，按档位与窗口重绘、跨段合并、`-99` 画基线、失败斜纹占位 + 真重试）。
5. **交互**：档位按钮（全片/中景/近景）+ Ctrl+滚轮切档（锚点保持）；L0 拖动定位（原样）/ L1L2 拖动平移 + 单击定位。
6. **失效**：`invalidateDerived` 全级前缀精确清扫（防 `film-1-` 误伤 `film-11-`）。

## ⚠️ 人工目验移交（spec §6 五条）

**程序侧已有数字**：L0 出图 10.29s、L1 单段 3.38s、L0 波形 2.31s（来自实测报告 `ffmpeg-measure-report.md`，非本批新测）。

**本批没有人看过的（必须人工）**：
1. 21:30 素材全局观感：总览铺满全片；放大 2 档后拖到任意位置，该段画面**明显变密**、段边界无跳变感。
2. **手势不抢**：缩放/平移 与 拖动定位、拖边微调 互不干扰（N2-c 三区在缩放态仍成立）。
3. 冷启动首屏 < 2s 出总览（对照实测 10.29s 的量级判断）。
4. 波形放大后能看到**局部疏密**（不再是均匀一条）。
5. 失败段有明确占位与重试，日志页可见原因。

> **测试全绿 ≠ 验收通过**：本批测试只覆盖服务端生成逻辑与路由契约，**前端交互一行都没覆盖**（web 无单测）。
> 正因如此，本批真的出过一起「程序侧全绿、真机却全错」的缺陷：切中景/近景时服务器门口那道鉴权守卫
> **漏放行了两个新地址**（`filmseg`/`wavepeak`），请求在进路由前就被 401 掉，段图一张都没生成。
> 根因与护栏见账本 `progress.md` 的「真机 401 事故」段。**这段历史留着，别当噪音删。**

## ✅ 验收结果（2026-10-03/04，取代下面两节）

**人工目验五条用户已全部确认通过**（原话「这个 5 个我看过了，没问题」），代码已提交 `3e95aee`。
本次真机事故后又跑了 5 轮 OCR 循环（server 606 → **607** 用例，三包 typecheck 0 错、两包 build EXIT=0）。

⚠️ **一个必须说清的事实**：五条里第 1/2/4 条**是在 401 事故修复之后才第一次真正看到图** ——
事故期间切中景/近景必然失败，那三条客观上无法验。所以「验过了」指的是「修完之后验过一遍」，不是「验过两遍」。

## 遗留（本批未做，如实记）

- **空闲预取未做**：原 spec D4 提到 `requestIdleCallback` 预取相邻段，T7 只做了「视口优先」。
- **L2 的真机观感未验**：门槛（>300s）是推导值，没在真长素材上看过「近景档是否真有用」。
- `waveformUrl`（legacy 波形 PNG）路由与文件保留（混跑兼容），**前端已无调用方**（波形改 fetch 峰值）。
- 各任务内的取舍与自查问题逐条在 `progress.md` —— 其中 **两次「改完立即 tsc」抓到实质错误**（T5 的 `Record` 键类型、T7 的默认导出/类型窄化），以及 T7 我自己发现并修掉的**一个"假重试按钮"**。

## 下一步建议（本批已收口，以下仅供后续批次参考）

1. ~~用户**人工目验**上面五条~~ → **2026-10-03 已全部通过**。
2. ~~观感 OK 后提交~~ → **已提交 `3e95aae`**。
3. 遗留项（空闲预取 / L2 真机观感）另开专项或并入下一批 —— 两者都**不阻塞**使用。
