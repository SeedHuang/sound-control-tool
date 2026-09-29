# Spec: URL 下载管线（m1a-ytdlp-pipeline）

> split from `docs/prds/音频录制与剪辑-PRD初始篇.md`（2026-09-28），对应 PRD §2.1/§3.4/§3.5/§4.1/§6-M1前半/§6.1-S2。
> 依赖：m0-desktop-shell（S1，已交付：三包 workspace、内嵌 server、jobs/audio_items 表、bins 探测、D12 token、CORS 白名单）。

## 0. URL 下载管线

### 0.0 为什么

M1 前半使命：**贴一个网页 URL（B 站课程/YouTube/播客等）→ 用 yt-dlp 把音视频提取成 mp3/m4a/wav → 自动入库 → 能在音频库播放**。S2 只做"来源 A（URL 下载）"，来源 D（系统录音）归 S3，剪辑归 S4/S5。**M1 仅支持单 URL 提交**（FR-1.6 批量粘贴排队下载归 M3）；合集内多 P 勾选下载属 S2 范围。S2 复用了 S1 的全部骨架（jobs 表、bins 探测、token、tempDir），因此主要工作量集中在三块：**yt-dlp 子进程封装**（元数据解析 / 下载 / 进度解析 / 取消）、**长任务入库闭环**（下载完成 → audio_items + 命名 §3.5）、**最小音频库页**（列表 + 播放，支撑验收）。

### 0.1 已实测确认的前提（继承 S1 §0.1 + 补充）

| 项 | 值 | 影响 |
|---|---|---|
| yt-dlp | 2026.08.19（本机已装，S1 probe 实测） | S2 直接可跑，无需安装 |
| ffmpeg | 9.0.2-full_build（S1 实测） | yt-dlp `-x` 音频提取依赖它做转码 |
| node:sqlite / Fastify 5 | S1 已就绪 | repo 层/路由注册沿用 |
| jobs 表 | S1 已建（create/get/markAllInterrupted） | S2 增补更新进度/状态的 repo 方法 |
| audio_items 表 | S1 已建（含 UNIQUE file_path、source_url） | 重复检测 + 入库直接写 |

平台事实（yt-dlp 行为，官方文档约定 + 本机已有实证基础）：

1. **`yt-dlp -J <url>`**：stdout 输出完整 JSON 元数据（`--flat-playlist` 时合集只列条目索引/标题/id，不逐个抓详情，快且够用）；单视频为单 JSON 对象，合集含 `entries` 数组。
2. **`yt-dlp -x --audio-format <fmt> --audio-quality <q>`**：提取音频并转码（依赖 ffmpeg）；`--windows-filenames` 防非法字符。
3. **`--no-playlist`**：合集 URL 只取当前页单条（防误下整个合集）；**`--playlist-items i`** 精确取合集内第 i 条。**`--playlist-items` 可接受多值 `1,3`，但 S2 只用单值**——finalize 是单产物入库模型（D8 约束），多值会一次产出多个文件导致丢条目。
4. **`--download-sections "*start-end"`**：按秒截取片段（FR-1.2）。
5. **进度输出**：默认混在 stderr 的日志流里；`--newline` 让每条消息独占一行，`--progress-template "<fmt>"` 可输出结构化进度行——这是进度解析的稳定入口。
6. **Windows 取消**：`spawn(..., { windowsHide: true, detached: true })` 后 `taskkill /pid <pid> /T /F` 能连子进程树一起杀（yt-dlp 会再拉起 ffmpeg，单杀父进程不干净）。

**前置条件**：yt-dlp/ffmpeg 已安装（S1 probe 已验证）；无新增原生模块。

### 0.2 核心决定（不可违反）

| # | 决定 | 为什么 |
|---|---|---|
| D1 | **元数据解析走同步 POST，不建 job**（`ytdlp_meta` kind 保留在枚举里但不启用）。`POST /api/ytdlp/parse` → await `yt-dlp -J` → 归一化 entries → 同步返回 | `-J --flat-playlist` 通常 1~5 秒完成；建 job + SSE 对短任务是无谓开销。若将来超大合集解析过慢，再升格为 job（kind 已预留） |
| D2 | **下载建 job（kind=`ytdlp_download`）**，`POST /api/ytdlp/download` 建 job 后**立即返回 `{jobId}`**，spawn 异步跑，进度经 SSE 推送 | 下载是真正的长任务（分钟级），必须走 jobs 表（取消/重试/启动恢复），PRD §3.4 |
| D3 | **SSE 端点与音频文件端点用 `?token=` query 校验**（受保护路由仍走 header `x-sct-token`）。**2026-09-29 增补：作品封面路由 `/api/imports/:id/cover` 同属这一类**（`<img>` 也加不了 header），且这三条都必须出现在 `index.ts` 守卫的豁免名单里（漏一条 → 守卫先 401，路由内的判定根本没机会跑；封面就是这么漏的，浏览器实测照到）。**再增补：这三条追加「Referer 是本机页面」判据**（`isLocalPageReferer`）——`<audio>`/`<img>` 由浏览器发起时**既无 Origin 也无 header**，只带 Referer；没有它，本地开发裸开浏览器（URL 无 apiToken）时播放器与封面全 401（实测）。安全论证：Referer 由浏览器按发起页面填、JS 改不了 → 外部站点带的是它自己的地址，仍被拦。**2026-09-29 增补：`Origin` 为 localhost/127.0.0.1/[::1] 来源时豁免 query token 校验**（与 D12 守卫的 localhost 豁免一致）——`EventSource`/`<audio>` 无法设 header，token 只能经 query 送达，而浏览器独立开发（ADR-2）直开 `localhost:8000/?apiPort=7310` 无 token 会 401，进度条/播放不可用。豁免安全论证：localhost 请求只可能来自本机，本机进程本就能读 `.sct/dev-port` 拿到 token，豁免不新增攻击面；file:// 场景 Origin=null 仍强制 token | 见 D12 豁免同理；query 泄露面 = URL 存在于本地请求，localhost/file:// 场景可接受（与 D12 的"防外部站点"目标一致：外部恶意网页即使拿到 URL 也无法读本地文件内容，因为文件端点本身在 127.0.0.1 且校验 token） |
| D4 | **音频库目录 `audioDir = path.dirname(dbPath)/audio`**（dev=`.sct/dev-data/audio`、prod=`%APPDATA%\@sct\desktop\audio`），createServer 内部 mkdir | 与 db 同数据目录，天然继承 S1 的 dev/prod 隔离；不给 createServer 加新参数，避免契约膨胀 |
| D5 | **入库两段式**：下载先落 `tempDir` 临时名 → `INSERT audio_items`（file_path 暂填 temp 绝对路径）拿 id → 计算最终名 `{slug}-{id前8位}.{ext}` → rename 到 audioDir → `UPDATE file_path` | §3.5 文件名含 **id 前 8 位**，而 id 只有 INSERT 之后才知道——"入库时一次性确定"落实到"INSERT 后 rename 前算好最终名"，最终落盘文件名符合 §3.5；`file_path UNIQUE` 因 temp 路径唯一而不触发 |
| D5b | **落盘冲突追加序号**：rename 前若 audioDir 已存在同名文件，追加 `-2`、`-3`…（`{slug}-{id前8位}-2.{ext}`），保证 `file_path UNIQUE` 永不裸异常 | §3.5 "落盘冲突追加序号"逐字落实；重复下载（force）+ 同名 title 是必然触发的场景，必须覆盖 |
| D5c | **入库 title 默认 = yt-dlp 元数据 title**（解析阶段带回），slug(title) 依 §3.5 规则（Windows 非法字符 `\/:*?"<>|`→`_`、去首尾空格、截 80 字符） | §3.5 "默认标题：下载 = yt-dlp 元数据 title"；slug 规则必须是共享纯函数（S3/S4 复用） |
| D6 | **进度解析走 `--newline --progress-template` 结构化输出**，`parseProgressLine` 为纯函数 | 默认日志流混杂 `[download]`/`[Merger]`/警告等，解析脆弱；自定义模板输出 `percent|downloaded|total` 稳定可测 |
| D7 | **取消用 `taskkill /pid <pid> /T /F`**（spawn 时 `detached:true` + `windowsHide:true`），杀整棵进程树 | yt-dlp 会拉起 ffmpeg 子进程，`child.kill()` 只杀父；不杀树则 ffmpeg 残留空转 |
| D8 | **单条下载强制 `--no-playlist`**；合集多选**由前端逐条提交**（每条一个 download 请求 + 一个 job），`entryIndices` 限定为**单元素** `[i]` 服务端换算 `--playlist-items i` | FR-1.1 防误下整个合集；服务端换算避免前端拼 shell 参数。**关键约束（同族扫描发现）**：finalize 是单产物入库模型（findLatest 只取 mtime 最新一个文件），一次 `--playlist-items 1,3` 会下载多个文件到 tempDir，其余成孤儿丢失——故禁止一次多产物，多选必须逐条提交 |
| D9 | **错误映射 `mapYtdlpError`**：spawn ENOENT→"yt-dlp 未找到，请到设置页配置路径"；非零退出→取 stderr 关键行，按已知特征（DRM/需登录/站点不支持/网络）映射中文 message + `next`（可执行下一步）；未知→原样摘要 | FR-1.5 每条错误必须附"下一步"，不得只抛原始 stderr |
| D10 | 下载完成后 **duration 取下载期 parse 传入的 `durationSec`**（download payload 可选带 `durationSec`，前端从 parse 结果带入）；**`section`（片段下载）存在时忽略 `durationSec`，强制 `ffprobe` 实测**——片段产物时长 ≠ 整条时长，用 parse 值会把错误时长持久化（P1-3）；无 section 且无 durationSec 时 ffprobe 兜底（binProvider 已有 ffmpeg 路径，`ffprobe -show_entries format=duration`），仍无则 null | 入库 duration_sec 尽量准确，剪辑 S5 依赖它定位时间轴；避免下载时再跑一次 `-J` 的额外开销 |
| D11 | **B 站 Cookie 由用户在设置页粘贴**（2026-09-29 增补，实测 B 站对无 Cookie 的 yt-dlp 请求全面 412 风控）：设置页 TextArea 粘贴（Netscape cookies.txt 或 cookie-editor JSON，`normalizeCookieContent` 归一化）→ `PUT /api/cookie` 存 settings 表 `bili_cookie` 键（**故意不入 SETTINGS_KEYS 白名单**——GET /api/settings 不回传凭据）→ parse/download spawn 时 `materializeCookieFile` 写数据目录 `cookies-<唯一后缀>.txt` 并注入 `--cookies`。凭据安全：内容不回传 UI（GET /api/cookie 只回 set/length）、日志只记长度、cookie 文件在 gitignore 数据目录。**文件名必须唯一（2026-09-29 实测踩坑）**：yt-dlp 退出时会把 cookie jar **回写**进 `--cookies` 指定的文件，而解析/下载/问封面三处可能并发 → 固定名字会被互相覆盖，实测被回写成 0 字节、下次调用直接报 `does not look like a Netscape format cookies file`。每份带唯一后缀 + 顺手清理 1 小时前的旧副本。过期处理：重新导出粘贴覆盖 | B 站 412 实测（番剧+普通视频均拦）；yt-dlp 官方 Cookie 机制；浏览器插件导出是最稳方案（不受浏览器加密升级影响，用户拍板） |

### 0.3 接口契约

全部前缀 `/api`，受保护路由（除 health、解析）按 D3 校验。错误统一形状：`{ ok:false, error:{ code, message, next } }`。

**POST `/api/ytdlp/parse`**（body: `{ url: string }`）
- 200 `{ ok:true, kind:'single'|'playlist', title:string, duration_sec?:number, thumbnail?:string, entries?: { index:number, title:string }[], existing?: { audioId:number, title:string } }`
  - `existing`：库中已有同 `source_url` 且 `source_type='download'` 的条目。**2026-09-29 变更**：前端不再靠这个字段弹「已存在」，改由 `POST /api/ytdlp/download` 的 409 DUPLICATE（判别粒度更准：条目按 网址+第几集）驱动弹窗；该字段保留为兼容信息
  - `entries`：合集才返回；`index` 从 1 起（yt-dlp 的 playlist-items 从 1 起）
- 失败 4xx/5xx `{ ok:false, error:{...} }`（D9 映射）

**POST `/api/ytdlp/download`**（body: `{ url, options: { entryIndices?: number[], section?: { start:number, end:number }, format:'mp3'|'m4a'|'wav', quality?: string, force?: boolean }, title?: string, durationSec?: number, entryIndex?: number, collectionTitle?: string }`）
- `title?`：前端从 parse 结果带入的显示名，作入库 title 与文件名 slug（D5c）。缺省时 finalize 用 `'下载音频'`
- `entryIndex?` / `collectionTitle?`（**2026-09-29 增补**，用户拍板：音频库要显示「第几集 / 该集自己的名字」）：前端下载合集某集时带入 `entryIndex=条目 index`、`collectionTitle=合集 title`，随 job payload 一起存（retry 复用），入库时写进 `audio_items.entry_index / collection_title`。非法或缺省 → 落 NULL（视为单视频），**不因它拦下载**
- `durationSec?`：前端从 parse 结果带入（D10），作入库 duration；**`section` 存在时忽略此值，强制 ffprobe 实测**（P1-3 修复：片段产物时长 ≠ 整条时长）；缺省则 ffprobe 兜底
- 校验：format 非法 → 400；section 存在且 `start<0 || end<=start` → 400；`entryIndices` 存在时必须是**长度 1 的数组** `[i]` 且 `i` 为正整数（D8：单产物模型，多选由前端逐条提交）→ 违反 400
- 重复 → 409 `{ ok:false, error:{ code:'DUPLICATE', message:'库中已存在第 N 集/《标题》', next:'...' } }`（命中判重时还没 spawn 下载，不耗流量）
  - **2026-09-29 增补（用户拍板：条目也要判重，确认后可覆盖）**：判重粒度从「同 URL」收紧为**同一个视频/同一集**——条目按 `网址 + entry_index` 认，单视频按 `网址 + 标题` 认；老库没记集数的行（`entry_index IS NULL`）按标题兜底（`repo.findSameItem`）。起因：此前条目下载完全不判重，同一集重下会静默留两份（用户实测踩到，手动删过一次）。
  - `force:true` = 用户在前端弹窗里确认过「重新下载并替换」：**新文件成功入库之后**才删掉库里同一集/同一视频的旧行与其磁盘文件（`replaceSameItems`）。顺序不能反——先删旧的话，重下失败会把用户原有文件弄丢。删文件失败不改判结果（同 `DELETE /api/audio/:id` 语义）
- **同 URL 并发**（已有同 URL 且状态 `pending/running` 的 `ytdlp_download` job，无论 force）→ 409 `{ ok:false, error:{ code:'BUSY', message:'该 URL 正在下载中', next:'等待当前下载结束或先取消再重试' } }`（P1-1 修复：防两个进程写同一 `%(id)s.%(ext)s` 输出文件互相覆盖）
- 201 `{ ok:true, jobId:number }`（建 job 后立即返回，异步执行）

**GET `/api/jobs/:id/events`**（query: `token` 必填）→ SSE
- 事件行格式 `event: <type>\ndata: <json>\n\n`：
  - `event: progress` data: `{ percent:number, downloadedBytes?:number, totalBytes?:number }`
  - `event: phase` data: `{ phase:'ingest' }`（**2026-09-29 增补**，用户拍板：进度条分两段 ①下载 ②入库）——下载进程退出、开始入库（ffprobe 测时长 + 改名 + INSERT）前推送，前端据此把进度条从下载段切到入库段。**非终态**，连接保持；若没有这个信号，进度条会停在 100% 而音频库还是空，用户误以为下好了就切走（真实踩坑）
  - `event: status` data: `{ state:'running'|'done'|'error'|'cancelled', message?:string }`
  - `event: done` data: `{ audioId:number, filePath:string, title:string, format:string, replaced?:boolean }`（`replaced:true` = 本次为覆盖下载，库里原来那一份已删——2026-09-29 增补）
- **DownloadManager 内部事件与 SSE 对外的区别**：DownloadManager 的 `{ type:'status', state:'done' }` 内部事件可附带 `producedPath`（下载产物绝对路径，供路由层入库用），**路由层入库后才对外发 SSE 的 `status done` 与 `done`**——SSE 对外事件类型严格如上，不含 `producedPath`
- 已结束的 job：连接后立即补发一次终态事件
- job 不存在 → 404；token 错 → 401
- 心跳：每 15s 发 `: ping` 注释行防超时断开

**POST `/api/jobs/:id/cancel`** → 200 `{ ok:true }`（D7 kill 树；job 置 `cancelled`）

**POST `/api/jobs/:id/retry`** → 201 `{ ok:true, jobId:number }`（读原 payload 建新 job，旧 job 保持原状态）
- **仅限 `error` 状态的 job**（对 `running`/`pending` 重试会造出同 URL 并发——P1-1 同族）；原 job 非 error → 409 `{ ok:false, error:{ code:'NOT_RETRYABLE', message:'只有失败的任务可以重试', next:'' } }`
- 建新 job **前**同样过 `findActiveByUrl` 并发检查（命中即 409 BUSY，同 §0.3 download）——防"旧 job 已 error 但同 URL 另有 running job"的窗口

**GET `/api/audio`** → 200 `[{ id, title, source_type, source_url, entry_index, collection_title, format, duration_sec, file_size, created_at, site }]`（按 created_at DESC）
- **2026-09-29 增补**（用户拍板：音频库要显示平台 logo + 原视频地址 + 第几集）：出参在 repo 行基础上补两个字段——`entry_index / collection_title`（入库时写入，单视频为 `null`）；`site` 由 `source_url` 反查（`detectSite`，`bilibili|youtube|other`），**不新增列**。返回结构仍是数组（非 `{ok,items}`），搜索/分页在前端本地做（库为本地单机、条目量小，输入即响应）
- **2026-09-29 增补（补齐老记录）**：改动前入库的音频没记 `entry_index / collection_title`（当时还没这两列），这两列如今为空 → 出参时拿 `source_url` 反查 `imported_sources`（解析成功时落库的那张表）补齐：合集名直接取该来源的 `title`；集数只在**该来源 kind='playlist' 且分集清单里唯一命中同名条目**时才判定（同名多条一律留空，宁缺勿错）。下载时已记录的值优先，绝不被反查结果覆盖

**GET `/api/audio/:id/file`**（query: `token` 必填）→ 200 流式（`Content-Type` 按扩展名：mp3→`audio/mpeg`、m4a→`audio/mp4`、wav→`audio/wav`；`Content-Disposition: inline`）
- `id` 非正整数（`Number('abc')`/0/负数）→ 404（P2-5）
- 不存在 → 404；token 错 → 401
- **2026-09-29 增补**：<audio> 由浏览器自己发，**既无 Origin 也加不了 header**（只有 Referer）→ 除 query token / 本机 origin 外，**额外认「Referer 是本机页面」**（`isLocalPageReferer`）。实测日志里这条路由大量 401 就是这个坑（本地开发裸开浏览器时播放器拿不到文件）

**GET `/api/imports`** → 200 `{ ok:true, imports:[{ id, url, title, site, kind, entry_count, thumbnail, has_cover, created_at }] }`（新→旧；左列表持久化，2026-09-29）
- `thumbnail`：封面原始地址（作品级，解析时写入；**合集常常拿不到**——见下条 cover 路由的第 ③ 步，那种情况库里一直是 null，但图照样能出）；`has_cover`：封面图是否**已落到本地**——**信息字段**，前端不当开关用：有来源记录就渲染 `<img>`（本地有图秒出、没有则服务端现拿，真拿不到由 `onError` 回退纯色卡片）。若把它当开关，"还没图的来源"就永远没机会去拿图了（2026-09-29 实测踩到）
- `GET /api/imports/:id` 同形状（外加 `duration_sec / entries`，亦带 `has_cover`）；`DELETE /api/imports/:id` 只删来源行，不动已下载音频

**GET `/api/imports/:id/cover`**（query: `token` 必填）→ 200 图片流（`Content-Type` 按落盘扩展名；`Cache-Control: public, max-age=86400`）
- **2026-09-29 增补**（用户拍板：分组视图显示作品封面）：图片本体由服务端抓取后**落盘**在 `<数据目录>/covers/cover-<来源id>.<ext>`，前端不直连外网图床（不受防盗链/断网影响）。取图走统一的 `ensureCover`，**两段式**：① 本地已有图 → 直接给（日常都走这条，实测 2ms）；② 库里存了封面地址 → 自己 fetch 抓（国内图床最快，实测 B 站 156ms）；③ **自己抓不到 / 压根没地址 → 让 yt-dlp 自己写图**（`--skip-download --write-thumbnail --playlist-items 1 -o covers/cover-<id>.%(ext)s`）；④ 都不行 → 404（前端回退纯色卡片）
  - **为什么第 ③ 步必须存在（2026-09-29 实测，两个独立原因）**：
    (a) **外网图床抓不到**——Node 内置 `fetch` **不读 Windows 系统代理设置**，直连 `i.ytimg.com` 每次干等到超时（实测 10.7s `fetch failed`）；而 yt-dlp（Python）走系统代理，同一张图 **130ms** 就下来。用户看到的现象就是"YouTube 视频下载完了却没封面"
    (b) **合集压根没有地址**——解析用的 `-J --flat-playlist` 对 B 站番剧不返回任何封面字段（顶层没有 `thumbnail`/`thumbnails`，分集只有 `ie_key/id/url`），所以"重新导入"也拿不到；yt-dlp 的 `--write-thumbnail` 能自己问出来并写文件
  - 第 ③ 步失败有 **10 分钟冷却**（且在**最前面**判定，见代码注释：不这样每次开卡片墙都要为外网图床白等 10s）；成功则以"文件真出现了"为准（yt-dlp 退出码 0 不代表写出了图）
  - **按域名的直连失败记忆（2026-09-29 追加）**：第 ② 步失败过就把该域名记 10 分钟，期间同域名的封面**直接跳到第 ③ 步**，不再白等那 10s。实测同一图床（i.ytimg.com）：第一个作品 12.8s 出图 → 第二个 **3.5s**。域名又通了（例如代理开了）则清掉记忆
  - 触发时机：**解析成功后台预热一次**（不 await，不拖慢解析）+ **本条路由按需兜底**（自愈：老来源、上次没抓成、或压根没有地址的番剧，打开分组视图就会补上；实测 YouTube 那条首次 12.3s 出图，第二次 2ms）
- 鉴权同 `/api/audio/:id/file`（query token / 本机 origin / **本机页面 Referer**）；**且必须在 index.ts 守卫的豁免名单里**——漏了就是实测踩到的那个 401（守卫先拦、路由根本没跑）
- 本地没图且库里也没封面地址 → 404（前端回退纯色卡片）；来源不存在 → 404

### 0.4 数据模型增量（repo 方法）

沿用 S1 的 `openDatabase`/`DB` 类型与 `node:sqlite` 同步 API。**不新增表**（audio_items/jobs/settings 全部够用）。

`server/src/db/repo/jobs.ts` 增补（在现有 `JobsRepo` 接口上加方法）：
- `update(id, patch: { status?: JobStatus, progress?: number, message?: string|null }): void`——status 变化时写 `finished_at=datetime('now')`
- `finish(id, progress=100): void`（status→done + finished_at）
- `fail(id, message: string): void`（status→error + message + finished_at）
- `findActiveByUrl(url): { id:number } | null`（kind='ytdlp_download' 且 status IN ('pending','running') 且 payload 的 url 匹配——**payload 是 JSON 文本，用 `LIKE` 匹配 `"url":"<escaped>"` 子串**，防同 URL 并发 P1-1）

`server/src/db/repo/audio-items.ts`（新建）：
- `create(item: { title, source_type, source_url, file_path, format, duration_sec, file_size, entry_index?, collection_title? }): number`（返回 lastInsertRowid；后两个可选，不传即落 NULL）
- `list(): AudioItemRow[]`（按 created_at DESC）
- `get(id): AudioItemRow | null`
- `findBySourceUrl(url): AudioItemRow | null`（source_type='download' 且 source_url=?）
- `updateFilePath(id, file_path): void`（D5 入库第二段）
- `delete(id): void`（入库失败回滚用，P1-2）
- `AudioItemRow` 类型：`{ id, title, source_type, source_url, entry_index, collection_title, file_path, format, duration_sec, file_size, created_at }`

`server/src/db/schema.ts` 增补（**2026-09-29**，之前是"不动"）：`audio_items` 加两列 `entry_index INTEGER` / `collection_title TEXT`，并在 `initSchema` 里用 `PRAGMA table_info` + `ALTER TABLE` 幂等补列——`CREATE TABLE IF NOT EXISTS` 只对"表不存在"生效，老库不补列就会在写入时报"no such column"。同日又给 `imported_sources` 加 `thumbnail TEXT`（作品封面原始地址），走同一套幂等补列。

`server/src/db/repo/imports.ts` 同日增补：`upsertByUrl` 存 `thumbnail`，**冲突更新时用 `COALESCE(excluded.thumbnail, imported_sources.thumbnail)`**——本次解析没带封面地址时保留上一次存的那个（否则一次抓不到图就把已有封面地址抹了）；`list()/get()/getByUrl()` 出参带 `thumbnail`（`has_cover` 由路由侧查本地文件得出，repo 不碰文件系统）。

### 0.5 yt-dlp 集成层（`server/src/ytdlp/` 新建目录）

| 文件 | 职责 | 纯函数/IO |
|---|---|---|
| `args.ts` | `buildParseArgs(url)`、`buildDownloadArgs({url, options, outDir})` 返回 yt-dlp 参数数组（含 `--windows-filenames`、`--no-playlist`/`--playlist-items`、`--download-sections`、`-x --audio-format --audio-quality`、`--newline --progress-template`、`-o <outDir>/%(id)s.%(ext)s`） | 纯函数（可单测快照） |
| `slug.ts` | `slugify(title): string`（§3.5 规则）、`resolveUniquePath(dir, filename): string`（D5b 冲突序号） | 纯函数（可单测） |
| `parse.ts` | `parseMetadata(binPath, url, timeoutMs=20000)`：`execFile` 跑 `yt-dlp -J --flat-playlist --no-warnings <url>` → 归一化 `{kind,title,entries,...}`；抛 `YtdlpError`。**2026-09-29 增**：`pickThumbnail(obj)`（`thumbnail` 字符串优先，否则取 `thumbnails` 数组最后一张）。**stdout 缓冲上限 64 MB**（`MAX_JSON_BUFFER`）：实测某 YouTube 视频 `-J` 输出 **11 MB**，当时的 4 MB 上限让用户看到"这个视频下不了"（Node 报 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，`mapYtdlpError` 已映射为「输出过大」人话） | IO |
| `args.ts` | `buildWriteThumbnailArgs(url, outTemplate, cookiePath?)`（2026-09-29）：`--skip-download --write-thumbnail --playlist-items 1 --no-warnings -o <模板>`——让 yt-dlp 自己把封面写下来（外网图床只能走它，见 `/api/imports/:id/cover` 第 ③ 步） | 纯函数 |
| `progress.ts` | `parseProgressLine(line): { percent:number, downloadedBytes?:number, totalBytes?:number } | null`（解析 `--progress-template` 输出的 `percent|downloaded|total` 行） | 纯函数 |
| `errors.ts` | `mapYtdlpError(e: { code?: string, stderr?: string, binPath?: string|null }): { code, message, next }`（D9 特征映射） | 纯函数 |
| `download.ts` | `DownloadManager` 单例：`start(opts: StartOpts)`（opts = `{ jobId, binPath, args, outDir, onEvent }`；spawn，攒 stdout/stderr，进度行→`onEvent`，close→`onEvent` 终态）、`cancel(jobId): Promise<void>`（taskkill + **清理该 job 在 outDir 的半成品文件**，P2-2）、`dispose()` | IO（依赖注入 spawn/execFile/taskkill 以便测试） |

`server/src/index.ts` 注册：`registerYtdlpRoutes(app, { db, binProvider, downloadManager, audioDir, tempDir, token })`。

- `binProvider`：注入函数 `() => Promise<{ path: string|null, explicit?: string|null }>`，读取 settings 的 `bin_ytdlp`（SETTINGS_KEYS.binYtdlp，M0 bins/probe 已写入）优先，否则 `probeBin('yt-dlp')`。测试注入 mock。
- **D12 守卫豁免 D3 端点（2026-09-29）**：`server/src/index.ts` 的 onRequest 守卫对 `GET /api/jobs/:id/events`（SSE）与 `GET /api/audio/:id/file`（音频文件流）**豁免 header token 校验**——两者是 D3 query-token 端点（EventSource/`<audio>` 无法设请求头），token 校验由路由内完成；生产 file:// 加载（Origin=null）下不再被守卫以 401 拦截。豁免按 pathname 精确匹配（`/^\/api\/jobs\/\d+\/events$/`、`/^\/api\/audio\/\d+\/file$/`），不扩散到同族路径。
- **事件桥接**：路由层持有 `Map<jobId, Set<SSE reply>>`；`DownloadManager` 构造时注入 `onEvent(jobId, event)` 回调（`download.ts` 内部 spawn 的进度/结束事件统一经此出口），路由层收到后推给该 job 的所有 SSE 连接，`done/error/cancelled` 终态事件发出后断开连接。下载完成回调（路由层 `finalizeDownload`）：temp 产物 → INSERT → rename → UPDATE → job finish → SSE `done`。
  - **finalize 失败路径（P1-2）**：`finalizeDownload` 全程包 try/catch——`ingestDownloadedFile` 抛错（rename 被占/权限/IO）时：`jobsRepo.fail(jobId, msg)` + **`audioRepo.delete(已INSERT的id)`** 回滚 + emit SSE `status error`。禁止 unhandled rejection（`onEvent` 里的 `void finalizeDownload(...)` 不得裸奔）。
  - **并发检查位置（P1-1）**：`POST /api/ytdlp/download` 在校验段末尾、建 job **之前**调 `jobsRepo.findActiveByUrl(url)`，命中即 409 BUSY（见 §0.3）。
- **关闭清理**：`createServer` 返回的 `close()` 内先 `downloadManager.dispose()`（`taskkill` 全部活跃子进程）再关 Fastify/db——`detached:true` 的子进程不随父进程退出，若不主动杀，应用退出后 yt-dlp/ffmpeg 会残留空转继续写 tempDir（与 S1 的孤儿清理冲突）。
- **`--progress-template` 已验证（P2-7，2026-09-28 Task 1 真实探针）**：`%(progress._percent_str)s`/`%(progress.downloaded_bytes)s`/`%(progress.total_bytes)s` 字段名与"进度行走 stdout"均已实测确认——探针行形如 `  0.1%|1024|788493`（前导空格属 `_percent_str`，`parseProgressLine` 已 trim），stderr 为空。若后续版本字段名或输出流变化，回改 args.ts/`parseProgressLine` 并回写本节。

### 0.6 web（最小音频库页 + 获取页）

`web/src/pages/` 新增两页，`web/src/api.ts` 增补封装：

| 页面 | 路由 | 内容 |
|---|---|---|
| `acquire.tsx` | `/acquire` | Tab1 URL 下载：输入 URL → parse（重复检测提示）→ 合集勾选（默认勾当前页单条）/片段起止/格式+码率选择 → 提交下载 → SSE 进度条（可取消；合集逐条串行）→ 完成后"去音频库"入口。**2026-09-29 用户拍板**：进度条分两段——① 下载（蓝，真实百分比，来自 `event: progress`）② 入库（绿，`event: phase` 后进入，无百分比可用，用 antd active 动画表示"进行中"）；集数网格 `repeat(auto-fit, minmax(160px,1fr))` 自适应列数并铺满整行。**覆盖下载流程**：整批用 `force:false` 先跑一遍，服务端判重命中的条目返回 409（此时未开始下载，不耗流量）→ 被记下来，整批跑完弹**一次**确认窗（列出第几集、说明会删掉库里旧的那份）→ 用户确认后这批带 `force:true` 再跑一遍 |
| `library.tsx` | `/library` | `GET /api/audio` 列表（antd Empty 空态），行内 `<audio controls src="/api/audio/:id/file?token=..." />` 播放。**2026-09-29 用户拍板增补**：每行显示平台 logo（`site` → `SiteLogo` 官方品牌矢量标）+ 名称（合集条目取 `collection_title`）+ `第 N 集`标签（`entry_index`）+ 该集自己的名字（`title`）+ 原视频地址（`source_url`，`target=_blank`，Electron 侧由 `setWindowOpenHandler` 转系统浏览器）+ 删除；顶部搜索框按名字本地过滤，底部分页（默认 10/页，可 10/20/50）；整页三段式（头/列表自滚/页脚），窄窗自动折行。**视图切换（用户拍板，放在搜索栏右侧）**：`平铺`（逐条列表，即上述）/ `剧集分组`（按 `source_url` 聚合成作品卡片墙：封面 + 平台角标 + 作品名 + 「已下 N 集 / 共 M 集」+ 细进度条 + 最近入库；卡片也分页、`auto-fill` 自适应列数、整块限宽居中）。点卡片**同页换层**进该作品自己的音频列表（顶部「← 返回分组」+ 作品信息行，行 UI 与平铺层完全相同，底部同样分页），搜索框随当前层走（分组层搜作品名/任意集名，作品内只搜这一部）。动效（`src/global.css`）：卡片 `:active` 轻缩 + 真鼠标设备才有的悬停上浮（160ms 强 ease-out）、封面透明淡入、切层/进作品一次 150ms 淡入；全部只动 `transform/opacity` 并尊重 `prefers-reduced-motion` |

`web/src/api.ts` 增补：`parseUrl(url)`、`startDownload(payload)`、`subscribeJob(jobId, { onProgress, onStatus, onDone, onError, signal })`（EventSource + query token）、`cancelJob(jobId)`、`retryJob(jobId)`、`listAudio()`、`audioFileUrl(id, token)`。

首页 `/` 加"去获取 / 去音频库"导航（保持 M0 的 health 卡片）。

`web/.umirc.ts` routes 增补 `{ path:'/acquire' }`、`{ path:'/library' }`。

### 0.7 测试边界

**自动化（vitest）**：
- `args.ts` 参数快照断言（含单条/合集单元素/片段/各格式/`--windows-filenames` 恒在；**多元素 entryIndices 不产生多产物**——D8 单产物约束）
- `progress.ts` 多形态行（含异常行→null）
- `errors.ts` 特征映射（DRM/需登录/站点不支持/网络/ENOENT/未知）
- `audio-items.ts` repo CRUD + 重复检测 + updateFilePath + delete
- `jobs.ts` 增补方法（update/finish/fail 的状态与 finished_at + findActiveByUrl：命中/未命中/仅 finished 不命中）
- HTTP：parse（mock binProvider，成功/失败/重复）、download（校验/409 DUPLICATE/**409 BUSY 并发**/201/**确认覆盖后删旧行旧文件**）、SSE（真实 listen + fetch 读流，token 401、补发终态）、cancel、**retry（仅 error 可重试 / 非 error 409 / 建前 BUSY 检查）**、audio 列表/文件流（token 401/404/**非正整数 id 404**/200 + Content-Type）、**封面（`covers.ts`：fetch 抓图落盘 / 失败回退 / 换格式清旧图 + `writeCoverViaYtdlp` 成功与"退出码 0 但没写出文件"不误报；解析预热触发；`has_cover`；cover 路由 200/404/401 + 自己抓不到时兜底让 yt-dlp 写图；createServer 端到端「本机 Referer 过守卫取图」）**
- 下载全链路（mock spawn 回调模拟进度/完成，断言入库 rename 后 file_path 为 `{slug}-{id前8位}.{ext}`；**finalize 抛错时 job→error 且 audio_items 回滚删除**，P1-2；**片段下载忽略 durationSec 强制 ffprobe**，P1-3）

**手工目验**（自动化不可达）：真实 B 站课程 URL 端到端——parse 出合集 → 勾选单条 → 下载 mp3 → 库页播放（含 SSE 进度条动画）。

**不测**：yt-dlp 真实下载（外部网络依赖）、ffmpeg 转码细节（yt-dlp 内部）、AntD 组件纯 UI。

### 0.8 验收锚点（M1 前半）

1. 三包 `typecheck` 0 错、server `test` 全绿、`build` 0 错
2. 单测覆盖 §0.7 全部自动化项
3. 手工：B 站课程 URL → 单条下载出 mp3 → 库页可播放（留用户目验）
4. 重复下载按「同一个视频/同一集」判重（条目=网址+第几集，单视频=网址+标题）：命中 → 弹窗明确告知，确认后重下并删掉库里旧的那份（只留新的）；取消能干净杀掉 ffmpeg 子进程（无残留进程）
5. 文档回写：本 spec + 实施计划 + progress 台账随 Task 推进实时更新

### 0.9 诊断日志（跨进程可观测，2026-09-29 用户指令落地）

用户要求：「关键步骤、每个请求都要加日志，能在日志页里看到」。落地设施（不要再另造）：

- **后端** `server/src/logs.ts`：环形缓冲 500 条 + 按本地时区落盘 `<数据目录>/logs/<YYYY-MM-DD>/<HH>.log`；`GET /api/logs` 取、`POST /api/logs` 收前端日志（`source='web'`）、`DELETE /api/logs[?day=]` 清空（入口在**设置页**，带二次确认）。`registerRequestLogging` 的 `onResponse` 给每个 `/api/*` 请求落一行 `METHOD /path → status (ms)`——**只记 pathname，query 里的 token 不落日志**；`/api/logs` 自身豁免（抽屉开着 1s 轮询，不豁免会把缓冲刷满自反行）
- **前端**：`LogsButton.tsx` 右下角浮动按钮 → 抽屉（开着时 1s 轮询前后端两份日志，故菜单点击/SSE 事件立刻可见）；`api.ts` 的 `logFe()` 是唯一埋点（前端环形缓冲 200 条 + 同步 `POST /api/logs`）
- **级别三档 `debug | info | error`**（2026-09-29 增 `debug`，消除「规则示例写 `pushLog('debug',…)`、类型却只有 info/error」的漂移）：`debug` = 例行但排查时有用（SSE open 的 CORS 摘要、按域名跳过直连的决定、`audioFileUrl` 每个 `<audio>` 元素一行的 token 来源）；`error` 同步打终端，`debug/info` 不打。**面板默认折叠 `debug`**，抽屉顶部「显示调试日志」开关展开（关着时显示「已隐藏 N 条」）
- **`POST /api/logs` 必须原样透传 `debug`**：否则前端 debug 行被降级成 `info`，面板过滤永远筛不出东西（已补单测钉住）

---

### 相关 PRD 段落对照（实施者应通读）

- §2.1 FR-1.1~1.5（功能点）
- §3.4 错误处理原则（stderr 捕获/翻译、临时名原子改名、启动恢复——后两者 S1 bootstrap 已实现，S2 复用）
- §3.5 文件命名与唯一性策略（slug 规则、冲突序号、重复检测）
- §4.1 数据模型（audio_items/jobs 表）

---

## 多透镜评审 Backlog（2026-09-28，第 1 轮）

> 评审结论：3 盲点（P1）+ 7 优化（P2）+ **1 功能缺陷（P0，同族扫描发现）**，无文档矛盾（P0）。P1/P0 全部修复（见下"已修复"）；P2 按三态处置。

### 已修复（P1 全部 + P0 同族 + P2 采纳项）

| 编号 | 问题 | 修复落点 |
|---|---|---|
| P0-同族 | **合集多选丢条目**：`--playlist-items 1,3` 一次下载多个文件，但 finalize 单产物模型（findLatest 只取最新一个入库），其余成孤儿丢失 | D8 修订：`entryIndices` 限定单元素，多选由前端逐条提交（每条一个 job）；§0.3 校验；§0.7 测试项 |
| P1-1 | 同 URL 并发下载无防护（两进程写同一输出文件） | §0.3 download 新增 409 BUSY；§0.4 jobs `findActiveByUrl`；§0.5 并发检查位置 |
| P1-2 | 入库中途失败无定义（INSERT 后 rename 前崩溃 → unhandled rejection + 残留行） | §0.5 finalize 失败路径（try/catch + audioRepo.delete 回滚 + emit error）；§0.4 audio-items `delete`；§0.7 测试项 |
| P1-3 | 片段下载入库错误时长（parse 整条时长 ≠ 片段时长，静默） | D10 规则：section 存在强制 ffprobe；§0.3 download durationSec 说明；§0.7 测试项 |
| P2-1 | spec §0.5 download.ts 表格与计划 StartOpts 不一致 | §0.5 表格同步为 `start(opts: StartOpts)` |
| P2-2 | cancel 后 tempDir 半成品运行中不清理 | §0.5 download.ts `cancel` 增加清理 outDir 半成品 |
| P2-5 | `audio/:id/file` 的 id 未校验正整数 | §0.3 非正整数 → 404；§0.7 测试项 |
| P2-7 | `--progress-template` 字段名/输出流是待验证机制断言 | §0.5 标注"Task 1 必须真实 yt-dlp 实测确认"；**2026-09-28 Task 1 已实测通过**（探针行 `  0.1%|1024|788493` 走 stdout，字段非空） |

### 已关闭（伪需求/被替代）

| 编号 | 问题 | 关闭理由 |
|---|---|---|
| P2-4 | `section` + 多选 `entryIndices` 组合语义未定义 | 前端 UI 不提供"合集多选 + 片段"同时勾选（交互层天然隔离）；API 层约束留待 M2 剪辑时 |

### 候选（记录触发信号，暂不实施）

| 编号 | 问题 | 触发信号 |
|---|---|---|
| P2-3 | `entryIndices` 不校验 ≤ 合集条目数（不与 parse 结果交叉校验） | 超界 entryIndices 实际导致下载错误 ≥ 2 次 |
| P2-6 | 合集条目用 `--flat-playlist` 拿不到每条时长/封面（FR-1.1 对合集条目部分不满足） | 用户实际反馈"合集条目看不出每条多长" ≥ 2 次；加时长需放弃 flat-playlist 逐个抓取，成本显著 |

### 收敛状态

第 1 轮：P1 全修，P2 处置完毕。
**第 2 轮（2026-09-28）：发现 2 新 P1 + 1 新 P2，未收敛**：

| 编号 | 级别 | 问题 | 修复落点 |
|---|---|---|---|
| P1-4 | P1（同族） | retry 建新 job 未做并发检查——对 running/pending job 重试会造出同 URL 并发（P1-1 只挡 download 入口） | §0.3 retry 限定仅 error 可重试 + 建前 findActiveByUrl；§0.7 测试项 |
| P1-5 | P1 | acquire `waitJobEnd` 的 60s 兜底 setTimeout 未清理——多条目串行下载累积定时器 + 可能 setState-on-unmounted | 计划 Task 8：resolve 前 clearTimeout |
| P2-8 | P2 | 合集全不勾选时 onDownload 循环空转无反馈（静默失败） | 计划 Task 8：checked 为空时提示"至少勾选一条" |

**第 3 轮（2026-09-28）：发现 1 新 P2，无新增 P0/P1——P1 已连续 2 轮零新增，收敛达成**：

| 编号 | 级别 | 问题 | 修复落点 |
|---|---|---|---|
| P2-9 | P2 | acquire 页"重试"按钮语义冲突：串行下载中 jobId 指向 running job，点重试必撞 NOT_RETRYABLE；且"重新点下载"天然即重试（error 后库中无条目，不触发 DUPLICATE） | 计划 Task 8：移除 UI 重试按钮（服务端 retry API 保留，供后续 UI/文档；acquire import 同步去掉 retryJob） |

**收敛结论：连续 2 轮（第 2、3 轮）零新增 P0/P1，多透镜评审收敛。**
