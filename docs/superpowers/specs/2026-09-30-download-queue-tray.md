# Spec: 下载队列 + 全局任务抽屉 + 托盘（download-queue-tray）

> 来源：2026-09-30 用户口述 + 逐条确认（同日）
> 关系：**新子系统**——服务端引入队列、前端引入常驻任务面板、桌面壳引入托盘。三层各自的既有接口**语义不变**（只新增）
> 状态：**待用户过目** → 过目后进入 writing-plans

---

## 0.0 为什么（用户原话）

> 同时下载视频的可以在设置中进行设置，默认是1，所有下载，都按照这个来建立队列，另外下载我有一个想法，做成单独的下载器，切换tab，或托盘都能继续下载，托盘上还会显示当前下载进度，以及…下载了几个，建议可以用分数形式进行展现

追问后用户逐条确认（**这 6 条是已定裁决，不再是选项**）：

1. 下载器形态 = **全局抽屉**（应用内、任何 tab 都能拉开；不是独立窗口，不是导航内嵌）
2. 抽屉内容 = **统一任务中心**（下载 + 剪辑 + 导出都在里面）
3. **排队只管下载**；剪辑/导出不排队（设置项就叫「同时下载数」）
4. 托盘显示 = **tooltip 文字 + 任务栏进度条**（不动态画图标）
5. **关窗口 = 最小化到托盘**（下载继续；托盘菜单里才有「退出」）
6. **风控节流并进切片一**（`--sleep-requests` 等）

**真实痛点**：下载进度面板在资料库页**页内**（`subscribeJob` + `Progress`），页面一卸载订阅就断——**下载还在跑，但你再也看不见它**。导出同理（进度在剪辑详情页里）。

## 0.1 现状基线（2026-09-30 实核，读码）

1. **没有队列**：`DownloadManager.start()`（`download.ts:58`）一调用就 `spawn`；`active` 只是个 `Map<jobId, ChildProcess>` 用来 cancel/清理，**零并发上限**。点 5 次下载 = 同时 5 个 yt-dlp。
2. **没有任务列表接口**：只有 `/api/jobs/:id/events`（单任务 SSE）、`/api/jobs/:id/cancel`、`/api/jobs/:id/retry`。**没有** 任何"列出在途任务"的接口。
3. **下载跑在服务端** → 换页/关窗**不会中断下载**；缺的只是"能看见"。
4. **jobs 表**：`status TEXT CHECK (status IN ('pending','running','done','error','cancelled'))`；`pending` 目前是"提交后极短的过渡态"（提交时 create 即 pending，随后立刻 update 成 running）。→ **可以零迁移地复用 `pending` 表达"排队中"**。
5. **没有托盘**：全仓零 `Tray`；关窗口 = 应用退出。
6. **启动清理**：`markAllInterrupted()` 把 `pending`/`running` 一律标 `error`（`jobs.ts:27-34`）。
7. **没有节流**：`args.ts` 全文无 `--sleep-requests` / `--limit-rate` / `--retries`。
8. **标题来源不一**：下载 payload 带 `title?`；`ffmpeg_clip`/`ffmpeg_export` 的 payload 只有 `importId`（要显示标题必须 join `imported_sources`）。
9. **同 URL 去重只看 pending/running**：`jobs.ts:67` 的 `findActiveByUrl` 已含 `('pending','running')` —— 引入队列后语义**正好**是"在途"，无需改（D8 复核项）。

## 0.2 决定（不可违反）

| # | 决定 | 理由 |
|---|---|---|
| D1 | **队列只在服务端**，且**只调 `ytdlp_video` / `ytdlp_download`** 两类；`ffmpeg_clip` / `ffmpeg_export` **不排队**。 | 用户裁决 3。下载本就在服务端（§0.1 事实 3），前端排队会在换页/关窗时丢。ffmpeg 是本地 CPU 任务，用户点一下就走。 |
| D2 | 新增设置键 **`max_concurrent_downloads`**（默认 `"1"`，合法 **1–5**，非法值 PUT → 400）。走既有 `GET/PUT /api/settings`（白名单由 `SETTINGS_KEYS` 自动包含，**不改白名单**）。 | 用户裁决："默认 1，所有下载按这个建队列"。 |
| D3 | **复用 `jobs.status='pending'` 表示"排队中"**，**零 schema 迁移**（不碰 `CHECK` 约束、不新增列）。提交即 `pending`；调度器检测到空槽 → 转 `running` 并 `spawn`。 | SQLite 改 `CHECK` 要重建表，代价与风险都不小；`pending` 的语义本来就是"还没开始跑"，天然吻合。 |
| D4 | **上限变更立即生效**：正在跑的不动；排队中的按新上限**立刻放行**（不是等下一次调度周期）。 | 用户描述"设置里改了就按这个来"；不许出现"改了但得等半天"。 |
| D5 | **取消"排队中"的任务** = 从队列移除 + 置 `cancelled`（**不杀进程**，它还没起）；取消"进行中"沿用既有 `cancel()`（taskkill 整棵树）。 | 两种状态两种正确做法，混用会留下僵尸进程或误杀。 |
| D6 | **一个任务失败不阻塞后续**：任何终态（done/error/cancelled）都必须释放槽位，**含 `spawn` 失败与异常路径**。 | 否则一个坏 URL 会把整条队永久卡住（最典型的队列 bug）。 |
| D7 | **重启**：进行中 + 排队中一律标 `error`（沿用 `markAllInterrupted` 语义）；**不做续传**。 | 与今日行为一致；续传需要 yt-dlp 的续传能力 + 半成品识别，属另一个系统。 |
| D8 | **同 URL 在途判定把 `pending` 算进去**（现状已满足，需**测试固化**：排队中的相同 URL 再提交 → 409 BUSY）。 | 引入队列后 `pending` 窗口从毫秒变成分钟级，这条从"理论"变成"高频路径"。 |
| D9 | 新增 **`GET /api/jobs?active=1`** → 在途任务列表（**不含** done/error/cancelled）+ 下载批次统计（D16）。 | 抽屉与托盘都要"队列全貌"；单任务 SSE 做不到。 |
| D10 | UI 侧一律**轮询**（不引入全局 SSE）：在途非空时 **1s**，空闲时 **5s**。渲染进程与主进程**各自**轮询（两个进程，各自独立，不做跨进程共享）。 | 进度源本身就是秒级；全局 SSE 要多一整套连接生命周期管理（重连/去重/多窗口），收益近零。 |
| D11 | 前端是**全局抽屉**（挂 `layouts/index.tsx`，**不随路由卸载**），导航栏右侧一个图标 + **徽标显示在途总数**。 | 用户裁决 1；挂 layout 才能真正"切 tab 不丢"。 |
| D12 | 抽屉 = **统一任务中心**：下载 / 剪辑 / 导出**同列**，分「进行中 / 排队中」两组；空态 antd `Empty`。每条显示：类型标签、标题、进度条、百分比、取消按钮。 | 用户裁决 2。 |
| D13 | 托盘：**tooltip** = `下载中 <已完成>/<总数> · 当前 <百分比>%`（空闲 = `就绪`）；**任务栏进度条** = `win.setProgressBar(当前在途任务的平均进度/100)`，无在途时清除（`-1`）。 | 用户裁决 4；Windows 托盘图标放不下文字（16×16），tooltip + 任务栏进度条才是"不动鼠标也能瞥见"的正确载体。 |
| D14 | 托盘右键菜单：`打开主窗口` / `显示下载器` / `退出`；**左键单击 = 显示并聚焦主窗口**。**`显示下载器` 需要通过 IPC 通知渲染进程打开抽屉**（新增通道）。 | 用户裁决 5；托盘不能直接操作 DOM，必须一条新 IPC。 |
| D15 | **关窗口 = 收进托盘**（`win.hide()`，应用不退出）；**只有**托盘菜单「退出」或 `before-quit` 才真退出。**首次**收托盘时托盘气泡提示一次（「已最小化到托盘，下载会继续」），用一个 settings 标记只提示一次。 | 用户裁决 5；不提示的话用户会以为应用没关掉（"任务管理器里还有个进程"）。 |
| D16 | **下载批次统计**由**服务端**算（单一事实源，前端与托盘不各算一遍）：`downloads: { total, done, running, queued }`。批次规则：**下载在途数 0→正**时开新批次（`total` 从 0 起、`done` 从 0 起），批次内新增提交累加 `total`，任务终态累加 `done`；在途归 0 后**保留最后一次快照**直到下次开批。 | "3/5"这个分数必须有明确口径：3 = 本批已完成，5 = 本批总数。口径放服务端才不会两处漂移。**只统计下载类**（与 D1/D2 一致，托盘也只关心下载）。 |
| D17 | 设置页新增三项：**同时下载数**（1–5，默认 1）、**下载间隔(秒)**（0–10，默认 0 = 不间隔）、**下载限速**（文本，空 = 不限，形如 `500K`）。 | 用户裁决 6（风控节流并进切片一）。三项都属"保护类"设置，放同一张卡片。 |
| D18 | 节流只作用于**下载**任务，拼进 `buildVideoDownloadArgs` / `buildDownloadArgs`：`--sleep-requests <n>`（n>0 时）、`--limit-rate <rate>`（非空时）。 | 用户裁决 6；剪辑/导出是本地进程，不该被网络参数影响。 |
| D19 | **不改变已有单任务 SSE 链路**：抽屉的存在不替代页内进度（页内该有的照旧），也不删 `subscribeJob`。 | 避免"新面板上线就把旧路径拆了"的大爆炸。 |

## 0.3 接口契约

### 新增：任务列表

`GET /api/jobs?active=1`（token 保护，**无守卫豁免**）

```jsonc
{
  "ok": true,
  "jobs": [
    { "id": 18, "kind": "ytdlp_video", "status": "running", "progress": 42,
      "title": "第一次逛妖城…", "subtitle": "第 3 集",   // subtitle 仅合集有
      "message": null, "createdAt": "2026-09-30 23:50:28" }
  ],
  "downloads": { "total": 5, "done": 2, "running": 1, "queued": 2 }   // D16：只统计下载类
}
```

- `jobs` 只含 `pending` + `running`，按 `id` 升序（= 提交顺序 = 队列顺序）
- `title` 由服务端补全：`payload.title` ?? `payload.url` ?? 按 `payload.importId` join `imported_sources.title` ?? `#<id>`
- `subtitle`：`payload.entryIndex` 有值 → `第 N 集`；否则 `null`
- `status` 原样回 `'pending' | 'running'`
- **不回 payload 全文**（payload 含 cookie 相关等内部字段，且 UI 不需要）

### 设置键（`server/src/settings-keys.ts`）

```ts
maxConcurrentDownloads: 'max_concurrent_downloads',  // 默认 '1'，合法 1..5
downloadSleepSeconds:   'download_sleep_seconds',    // 默认 '0'，合法 0..10
downloadLimitRate:      'download_limit_rate',       // 默认 ''，形如 '500K'；空 = 不限
```

`PUT /api/settings` 对这三个键**新增校验**（越界/非法 → 400 + `next`），且沿用既有"先校验后写库"。

### 桌面壳 IPC（新增一条）

```ts
// preload 暴露
window.sct.onOpenDownloader(cb: () => void): () => void   // 返回取消订阅函数
// main：托盘菜单「显示下载器」→ mainWindow.webContents.send('sct:open-downloader')
//        主进程侧保证窗口可见（show+focus）后再发
// 通道名：'sct:open-downloader'
```

（`revealPath` / `pickDirectory` 已在上一批交付，本清单只列新增。）

## 0.4 数据流

**提交下载** → `POST /api/ytdlp/download` → `jobsRepo.create(kind, payload)`（落 `pending`）→ **不再立刻 `startDownload`**，而是 `queue.enqueue(jobId)`；返回 201 + `jobId`（前端照旧用单任务 SSE 订阅，行为不变）。

**调度**（服务端，进程内）
```
空闲槽位 = max_concurrent - runningDownloads.length
while (空闲槽位 > 0 && 队列非空) {
  jobId = 队首出队；jobsRepo.update(jobId, { status:'running' })；startDownload(jobId, payload)
}
```
触发时机：① 每次 enqueue；② 每次任务进终态（释放槽位）；③ 设置里并发数变更。

**渲染进程**：抽屉/徽标每 1s（或空闲 5s）拉 `GET /api/jobs?active=1`。
**主进程**：托盘同样周期拉一次（它已持有 `apiPort`/`apiToken`），据此更新 tooltip 与 `setProgressBar`。

## 0.5 错误处理

| 场景 | 行为 |
|---|---|
| 并发数非 1–5 / 间隔越界 / 限速格式非法 | `PUT /api/settings` → 400 + `next`，**不落库** |
| `spawn` 失败 | 既有错误路径已发 `error` 终态 → **调度器必须释放槽位并继续下一个**（D6 的核心断言） |
| 任务进程异常退出 | 同上，`close` 回调里释放槽位 |
| 托盘拉取 `/api/jobs` 失败 | 只 `console.error`；**不改 tooltip、不清进度**（避免抖动）；连续失败 3 次才把 tooltip 标成「服务未连接」 |
| 渲染进程轮询失败 | `logFe('error')`，徽标保持上一次值；抽屉内显示一条 `Alert`（不弹全局错误） |
| 用户取消排队中的任务 | 直接置 `cancelled` 并移出队列；未起进程，无需清理产物 |
| 窗口关闭但仍有任务 | 收托盘继续跑（D15）；托盘菜单「退出」= 既有 `before-quit` 流程（会 `dispose()` 杀掉所有下载进程——**这就是现状语义**，不因托盘而改变） |

## 0.6 测试边界

**vitest（server）**
- 队列调度：上限 1 时提交 3 个 → 只有 1 个 `running`、2 个 `pending`；第 1 个终态后第 2 个转 `running`
- **槽位必释放**：第 1 个 `spawn` 失败（注入）→ 第 2 个仍能被放行（防"一个坏 URL 卡死整条队"）
- **上限变更立即放行**：上限 1 → 有 2 个 pending；改成 3 → 立刻有 3 个 running
- **取消排队中**：patching 取消 → 状态 `cancelled`、**不调用** `cancel`/`taskkill`（桩断言零调用）
- **同 URL 去重含 pending**：排队中的 URL 再提交 → 409 BUSY
- `GET /api/jobs?active=1`：只回 pending/running；`title` 三种来源（payload.title / url / importId join）；`subtitle` 按 entryIndex
- `downloads` 批次统计：0→正 开新批、终态累加 done、在途归 0 后快照保留
- 设置校验：三者越界/非法 → 400 且不落库
- `args.ts`：`--sleep-requests` / `--limit-rate` 在**只有**下载参数里出现（剪辑/导出参数不含）

**手工目验**
- 设置「同时下载数」改成 1 → 连续提交 3 个 → 只有 1 个在跑、2 个排队；改成 3 → 立刻都开始
- 换 tab / 最小化 / 关窗口 → 下载继续；抽屉里的进度持续更新
- 托盘 tooltip 显示 `下载中 3/5 · 当前 42%`；任务栏图标下方有进度条；空闲后进度条消失
- 托盘点「显示下载器」→ 主窗口弹出并打开抽屉
- 关窗口 → 应用不退出、托盘还在、下载继续；托盘「退出」→ 真退出
- 浏览器直连模式（无 Electron）→ 抽屉照常工作（只是没有托盘）

## 0.7 验收锚点

1. **[自]** 三包 `typecheck` 0 错 + `pnpm --filter @sct/server test` 全绿 + `pnpm --filter @sct/web build` 成功 + `pnpm --filter @sct/desktop build` 成功
2. **[人]** 并发上限**真的生效**（提交 3 个只跑 1 个），且改上限**当场放行**（D2/D4）
3. **[人]** 切 tab / 最小化 / 关窗口，下载与进度**都不中断**（D11/D15）
4. **[人]** 抽屉是统一任务中心：下载/剪辑/导出都能看到、能取消（D12）
5. **[人]** 托盘 tooltip 的分数口径正确（`已完成/本批总数`）且与抽屉显示一致（D13/D16）
6. **[人]** 关窗口不退出，「退出」只在托盘菜单里（D15）

## 0.8 YAGNI（本轮不做）

- 不做断点续传 / 重启恢复（D7）
- 不做下载历史归档（抽屉只显示在途）
- 不做优先级 / 置顶 / 拖动排序
- 不做定时下载、计划任务
- 不做多窗口（用户已选"全局抽屉"而非独立窗口）
- 不给剪辑/导出排队（D1）
- 不引入全局 SSE（D10）
- 不改 `dispose()` 的既有语义（退出即杀进程）

## 0.9 回滚

- 队列：把 `enqueue` 改回"直接 `startDownload`"即退回今日行为（`pending` 概念自然消失）
- 抽屉：不挂进 layout 即不可见
- 托盘：不创建 Tray；`关窗口=退出` 恢复为默认行为
- 三个设置键留着无害（不读即无效）

## 0.10 影响面（文件级）

| 文件 | 改动 |
|---|---|
| `server/src/ytdlp/download-queue.ts` | **新建**：并发受限队列 + 批次统计（纯逻辑，可注入 `start`/`jobsRepo`） |
| `server/src/ytdlp/ytdlp-routes.ts` | 提交下载走队列（不再直接 start）；`GET /api/jobs?active=1`；retry 也入队 |
| `server/src/db/repo/jobs.ts` | 可能需要 `listActive()`（pending+running 带 payload） |
| `server/src/settings-keys.ts` | 三个新键 |
| `server/src/http/settings-routes.ts` | 三个键的校验 + 默认值 |
| `server/src/ytdlp/args.ts` | `--sleep-requests` / `--limit-rate` 注入（仅下载参数） |
| `server/src/index.ts` | 注册新路由/装配队列；启动时读并发设置 |
| `desktop/src/main.ts` | Tray + tooltip + `setProgressBar` + 菜单 + 关窗收托盘 + 轮询 `/api/jobs` + 首次气泡 |
| `desktop/src/preload.ts` | 新增 `onOpenDownloader`（唯一新 IPC 通道） |
| `web/src/components/TaskDrawer.tsx` | **新建**：全局抽屉（列表/分组/取消/空态）。**注：实际落地文件名是 `TaskDrawer.tsx`**（本表原来写的 `DownloadDrawer.tsx` 是命名草稿，非契约——已修正） |
| `web/src/layouts/index.tsx` | 挂抽屉 + 导航右侧入口 + 徽标 |
| `web/src/api.ts` | `listActiveJobs()` + `ActiveJob`/`DownloadBatch` 类型（**注：`onOpenDownloader` 的桥接不在本文件**，按既有约束它只能落在 `web/src/desktop.ts`——本表已修正） |
| `web/src/pages/settings.tsx` | 新增「下载」卡片（并发数 / 间隔 / 限速） |
| 测试 | `download-queue.test.ts`（新，含槽位释放/上限变更/取消排队）、`jobs` repo 测试、`settings-routes` 校验、`args.test.ts` 追加、`ytdlp-routes.test.ts` 追加 |

## 0.11 交付切片（每片独立可验收、可分别提交）

| 切片 | 内容 | 验收方式 |
|---|---|---|
| **一（服务端）** | `pending` 队列 + 调度器 + 三个设置键与校验 + `GET /api/jobs?active=1` + 节流参数 | 纯后端：vitest 全绿 + 用 curl 改设置/看列表；**改完下载立刻受控** |
| **二（前端）** | 全局抽屉 + 导航徽标 + 任务列表轮询 | 起应用：切 tab / 最小化都能看进度；并发上限肉眼可见 |
| **三（桌面壳）** | 托盘（tooltip + 任务栏进度 + 菜单）+ 关窗收托盘 + `onOpenDownloader` IPC | 起应用：关窗口不退出、托盘显示 `3/5`、点「显示下载器」能叫出抽屉 |

## 0.12 与既有决定的相容性检查

- **m1a D7（kill 树）/ D6（进度模板）**：不变；托盘与抽屉只是新的消费者。
- **m2-workspace D3（整页不滚 body）**：抽屉是 overlay，不影响页面滚动约定。
- **资料库 spec（`2026-09-30-library-ui-polish`）**：它改的是资料库页内布局与档位来源，**不碰下载链路**；两批可并行实现，无文件冲突（唯一的共同文件是 `web/src/api.ts`，需串行编辑）。
- **上一批交付的 `web/src/desktop.ts`**：新增的 `onOpenDownloader` 也放进它（保持"唯一读 `window.sct` 的地方"这条约束不破）。
