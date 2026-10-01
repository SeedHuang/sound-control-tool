# Spec: 视频预览剪音频（m1c-video-clip）

> split from `docs/prds/音频录制与剪辑-PRD初始篇.md`（2026-09-29），对应 PRD §2.1 FR-1.2 与 §2.3 的**最小切片**。
> 依赖：m1a-ytdlp-pipeline（S2，已交付：下载管线 / jobs / SSE / 入库 / 判重 / 封面）。
> 路线图位置：**新增切片 S2.5**——原 PRD §6.1 的 S1–S6 里没有它；它依赖 S2，是 S5（剪辑工作台）的最小前置。
> 状态：设计已与用户逐节确认（2026-09-29）；同日完成**第 1 轮多透镜评审**（1 P0 + 10 P1 已全部修，P2 处置见 §0.11）；开工前有 **5 项必须先实测**，见 §0.1 末尾。

---

## 0.0 为什么

用户的真实痛点（2026-09-29 原话）：

> "我想通过剪辑把音频提取出来，但是只听音频，感觉很难，所以用视频确定开始和结束时间，然后再把音频剪出来"

拆开就是：**音频定位对人不友好**（要反复试听才知道哪一秒是想要的），而**画面一眼就能认**。所以本切片做的事是——

视频在这里是**带画面的时间标尺**，不是要新增"视频能力"。最终产物仍然是音频。由这一句话直接推出三个决定（§0.2 的 D1/D2/D3）：素材不进音频库、不用高清、不剪视频。

## 0.1 已实测确认的前提

1. **现在只产音频是一行代码决定的**：`args.ts:28` 写死 `-x --audio-format`。`-x` 是"提取音频"，yt-dlp 下完视频流后调 ffmpeg 抽音轨、把视频流丢掉。去掉它并给出格式选择器即可下载视频——yt-dlp 本身是视频下载器。
2. **ffmpeg 已在位**：设置页已有路径检测，`bins.ts` 能探测（注意 ffmpeg 的版本旗标是 `-version` 单横线）。`--merge-output-format mp4` 与后续抽音轨都依赖它。
3. **容器必须是 mp4**：Electron 是 Chromium 内核，mp4/webm 能播，**mkv 多半播不了**。所以不能交给 yt-dlp 自选容器。
4. **音频文件路由已实现 Range**（`ytdlp-routes.ts:700-720`，206 + `content-range`）。视频播放**必须同样支持 Range**，否则进度条拖不动、甚至直接播不出来。
5. **`DownloadManager` 的"找产物"写死了音频扩展名**（`findLatestAudioFile`，且 `cancel` 的清理也用它）。视频分支不动这里 → close 时会报"下载完成但未找到产物文件"，取消后还会在 temp 留半成品。
6. **数据库没开 `PRAGMA foreign_keys`**（`db/index.ts` 里没有这条设置）→ schema 中 `REFERENCES ... ON DELETE CASCADE` 只是**声明**，不会真的级联。删来源不会自动删素材行，必须显式删。
7. **`imported_sources` 已经是"我处理过的那个 URL"的持久化**（`upsertByUrl` / `list` / `get` / `delete` 都在，且音频库的分组卡片已经用它取封面与"共 N 集"）。素材与它一对一即可，不必另起一套来源体系。

**开工前必须实测的五件事（2026-09-30 已全部实测，Task 4/6 的参数以本表结论为准）**

| # | 待实测 | 实测结论（2026-09-30，B 站 BV1GJ411x7h7，ffmpeg 9.0.2 / yt-dlp 当前版 / Electron desktop 依赖自带 Chromium） |
|---|---|---|
| A | 清晰度选择用上限式 `-f "bv*[height<=N]+ba/b[height<=N]"` 还是就近式 `-S res:N` | 两者在 B 站多档位视频上**都精确落到 480**（B 站档位本身就是 360/480/720/1080，就近式没有"就近到更大"的空间）。真正的分野在**编解码**：不加偏好两者都挑 `av01`（AV1）；加 `-S vcodec:h264,acodec:aac` 后落到 `avc1`。**定案：保留上限式**（对任意站点都有"≤N"的硬保证）**+ `-S vcodec:h264,acodec:aac`**（表达式见 Task 6，即实测 A3 组合：`-f "bv*[height<=N]+ba/b[height<=N]/b" -S "vcodec:h264,acodec:aac" --merge-output-format mp4`） |
| B | 抽音轨时 `-ss/-to` 放输入前（快）还是输出后（精确） | **输入侧起点不准**：`-ss 30 -to 40 -i` 实际产出源时间轴 **[29s,39s]**（提前约 1s，落在前一个视频关键帧；本例 25fps、关键帧间隔恰 1s）。**输出侧逐样本精确**：`-i … -ss 30 -to 40` 与整轨解码基准做逐样本比对残差 **0.0**；时长两者都恰 10.000s。**定案：`buildClipArgs` 用输出侧**（`-i` 在前，`-ss/-to` 在后）——起点错了"画面上打的点"就全错，快那几秒没有意义 |
| C | Electron 里 `<video>` 播真实产出 mp4，且能拖动进度条 | 通过。Electron 窗口 + 本地 HTTP（带 Range）播 A1.mp4：readyState=4、duration=212.31s、videoWidth=853/videoHeight=480、`webkitAudioDecodedByteCount>0`（有声音）；程序化 seek 到 15s 成功（等价拖进度条），服务端侧只收到 **1 个 Range 206 请求**（Range 生效、无全量回退） |
| D | **选到的编解码能否装进 mp4 且 Chromium 能播**（不只是容器对不对） | B 站：加 `-S vcodec:h264,acodec:aac` 后落盘文件 ffprobe 实测 `h264 + aac`，实测 C 在 Electron 里播放正常（有画面有声音）。360/480/720/1080 四档在 B 站都有 avc1 变体（-F 列表核实）。**YouTube 未实测：本机网络连不上 youtube.com（连接超时）**；风险低——YouTube ≤480p 恒有 h264 格式，且 `-S` 偏好在 YouTube 同样生效，真机手验时顺带核对（Task 13） |
| E | Windows 上 `rename` 覆盖"正被占用的文件"的真实行为 | 目标被 `[IO.File]::Open(..., 'Read', 'None')` 独占时，node `renameSync` 抛 **`EPERM`**；释放句柄后同名 rename 立即成功。Task 3 的 `placeVideo` 按 `EPERM/EBUSY/EACCES` → `reason:'busy'` 判定（计划代码已是这么写的），文案引导"先关闭预览再重试" |

## 0.2 核心决定（不可违反）

| # | 决定 | 理由 |
|---|---|---|
| D1 | **视频素材必须含音轨**（下 `bv*+ba`，不能只下视频流） | 剪辑动作是"从这个文件抽音频"。只下视频流等于素材没法剪，还得再下一次 |
| D2 | **强制 `--merge-output-format mp4`，并同时偏好编解码**（`-S` 里加 `vcodec:h264,acodec:aac` 之类） | 见 §0.1 事实 3 与实测 D。**评审补**：只锁容器不够——VP9/AV1 + Opus 装进 mp4 后 Chromium 可能"有画面没声音"。**实测已定（2026-09-30）**：不加偏好时 B 站默认给 AV1，加 `-S vcodec:h264,acodec:aac` 后落盘 `h264+aac` 且 Electron 播放正常 |
| D3 | 视频素材**不进 `audio_items`**，落 `<数据目录>/media/`，元数据记 `source_videos` | 产物定位仍是音频。混进音频库会让「音频库」这个页面和 `/audio` 这个目录都被视频污染 |
| D4 | 复用**同一套下载 job 机制**（同一个 `startDownload` → `finalizeDownload` 流程），payload 加 `produce: 'audio' \| 'video'`，finalize 分两支；job kind 分开记（`ytdlp_video` / `ytdlp_download`） | 进度解析、SSE、取消、重试、启动恢复、封面抓取、cookie 注入全部白拿（另两个方案的对比见 §0.9） |
| D5 | `DownloadManager` 的"找产物"改为**按 job 传扩展名集合**；该集合是**新的 job 级状态**，必须与现有三张 job 级表（`active` / `activeOutDir` / `cancelledJobs`）**在每一处增删点同步增删** | 见 §0.1 事实 5。**评审补**：`cancel` 的 `cleanJobOutputs` 也走这条查找——只在 `start` 路径传集合，取消后就找不到产物、半成品留在 temp（§0.8 验收 4 会挂）。同族扫描：同文件已有三张"按 jobId 记状态"的表，新增第四张时漏删任一处就会出现"常量增长"或"读到上个 job 的值" |
| D6 | 剪辑单独一个 job kind `ffmpeg_clip`，走 jobs + SSE | 与"长任务一律走 jobs + SSE + 可取消"的既有约定一致；抽音轨虽多在秒级，长视频仍可能十几秒 |
| D7 | 剪辑产物进 `audio_items`，`source_url` 记**原视频地址** | 音频库的分组卡片 / 封面 / 原视频外链 / 判重全部自动复用，零额外工作 |
| D8 | 剪辑产物标题**自带时间段**：`标题 [mm:ss-mm:ss]`，**由后端强制拼**（前端传的 title 只作前缀，时间段一律由服务端追加） | 现有判重键是「网址 + 标题」（单视频）。同一视频剪多段时 url 相同，标题若也相同 → 第二段会被判"已存在"并**把第一段覆盖删掉**。**评审补**：若交给前端拼，用户手改输入框把时间段删掉，这个机制立刻失效——所以必须后端拼 |
| D9 | 素材每个来源**一份，重下覆盖**。细节语义见 §0.4：**写本体失败（目标被占用）→ 报错**；**删旧附属失败 → 只记日志** | 换清晰度重下应替换而不是堆积。**评审补**：原稿只写"覆盖失败只记日志、不阻断"，与本切片要区分的两种失败混为一谈——静默失败会让用户以为换了清晰度其实没换（§0.4 第 2/4 条给了分界） |
| D10 | ffmpeg 路径：设置页的值优先，**空则扫 PATH**；仍拿不到 → 明确报错引导去设置页 | 现有 `getFfprobe` 在设置为空时**静默跳过**探测。抽音轨没有 ffmpeg 就是做不了，不能静默 |
| D11 | 视频播放路由必须支持 **Range**（206） | 见 §0.1 事实 4 |
| D12 | **把音频路由里那段 Range 逻辑抽成共享函数**，音频与视频两条路由共用 | 不复制第二份——复制的那份必然漂移（本仓库已有过同类教训） |
| D13 | **剪辑产物走既有的 `ingestDownloadedFile`**，不手写 rename | **评审补**：§0.4 说"剪辑产物就是一条普通音频行"，那么落盘就该复用它——slug 文件名、冲突加序号、rename 失败回滚（P1-2 那套）都是现成的。手写 rename 会把这些保护全丢掉，且与 §0.5 自相矛盾 |
| D14 | 剪辑的**临时输出文件名必须唯一**（带 jobId 或时间戳） | **评审补**：同族于 cookies.txt 被并发写坏那次。两个 clip job 并发时若共用固定临时名（如 `clip.tmp.mp3`）会互相覆盖 |
| D15 | **落盘前校验目标位置上"有没有不该覆盖的东西"**：若 `media/media-<importId>.<ext>` 已存在、而 `source_videos` 里没有该 import_id 的行 → 视为**用户手工放进来的文件**，改用加序号的新名（`resolveUniquePath` 现成）而不是静默覆盖 | **评审补**（手法 5 接管时刻）：用户完全可以自己往数据目录里放文件。静默覆盖是**不可逆**的数据丢失。这一点和"重下覆盖自己上一份"是两回事，必须区分 |
| D16 | **ffmpeg 从本切片起是硬前置**，要写进文档的前置条件，不只是"报错时提示去设置页" | **评审补**（交付/运维 #1）：音频链路里 ffmpeg 缺失只是"转码这一步失败"；剪辑没有它**整个功能不可用**。前置条件必须显式声明 |

## 0.3 接口契约

沿用现有错误形状 `{ ok:false, error:{ code, message, next } }`；受保护路由按**现有 token 口径**鉴权（query token / 本机 origin / 本机页面 Referer，见 m1a spec 的 D12——注意那条编号属于 m1a，不是本文档的 D12）。

**`POST /api/ytdlp/download`（扩展）**

- body 新增两个可选字段：
  - `produce?: 'audio' | 'video'`（`undefined` / `null` / `''` 一律按 `'audio'`；**其它非二者之一的值 → 400**，评审补：把空串归到 audio 而不是报错，否则前端"没选"会被当成非法）
  - `options.videoHeight?: number`（仅 `produce='video'` 有意义）。**缺省 = 480**（评审补：与 UI 默认一致，直接打 API 的人不必猜）。**2026-09-30 变更（library-ui-polish D10）**：档位改为按视频实测，类型由窄联合 `360|480|720|1080` 放宽为整数；校验改为「整数且落在 144..4320」，越界/非整数 → 400（不再只认四档）。详见 `2026-09-30-library-ui-polish.md` §0.3。
- 校验新增：如上两条；其余校验（format / section / entryIndices 长度 1）沿用现状
- job kind：`produce='video'` → 新建 **`ytdlp_video`**；否则仍是 `ytdlp_download`（kind 分开是为了让并发检查与任务列表各自语义清楚）
- 产物落点：`produce='video'` → `<数据目录>/media/media-<importId>.<ext>`（ext 由实际产物决定，见 §0.4）
  - **落盘前先过 D15 的"该不该覆盖"校验**；并按 §0.4 的覆盖语义执行（先清旧扩展名、占用失败要有明确回退）
- **`importId` 怎么来（自查补）**：现有的 download body **不带 importId**。视频分支需要它（文件名与 `source_videos` 行的主键）。取法是**后端反查**：`importsRepo.getByUrl(payload.url)`（该方法已存在）。正常 UI 流程里 parse 一定先跑过、必命中；但直接打 API 可能没 parse 过 → 查不到时用 `upsertByUrl` **兜底建一条**（title 取 `payload.title ?? '未命名'`，site 用 `detectSite(url)`），不在下载中途报错
- 并发检查：**`findActiveByUrl` 现在是按 `kind='ytdlp_download'` 过滤的**（写计划时核实 `jobs.ts:66`），所以必须把它**参数化**成 `findActiveByUrl(url, kind)`，两个调用点（download 路由、retry 路由）同步更新；视频分支用 `kind='ytdlp_video'`（各自只跟自己同类互斥）
- **视频分支不参与音频那套判重**：音频的 409 DUPLICATE（网址+第几集 / 网址+标题）对视频没有意义——重复下视频只是"覆盖素材"，语义已在 §0.4 定义。视频分支必须**跳过**判重检查，否则用户想换清晰度重下会被 409 拦住
- 终态事件 `done` 增加 `kind` 字段：
  - 音频支形状**不变**（`{ type:'done', audioId, title, format, filePath, replaced }`）——现有前端零改动
  - 视频支为 `{ type:'done', kind:'video', importId, title, filePath, height, fileSize }`
- `POST /api/jobs/:id/retry`：现有实现把新 job 硬编码成 `ytdlp_download`（`ytdlp-routes.ts:621`）→ 必须按旧 job 的 kind 建新 job，否则视频任务重试会走错分支
  - **评审补**：`ffmpeg_clip` 的 payload 里存的是**素材绝对路径**。重试时素材可能已被删或换（重下会覆盖同一路径，删素材则路径没了）→ spec 明确：重试前**校验素材文件仍在**，不在则直接失败并给明确文案（"素材已不存在，请重新下载视频"），不要交给 ffmpeg 去报一个用户看不懂的错

**`GET /api/media`** → `{ ok:true, media:[{ import_id, url, title, site, height, file_size, created_at }] }`
- 只列**本地确实有视频**的来源（join `source_videos`）；新→旧

**`GET /api/media/:importId/file`**（query `token`）→ 视频流
- 鉴权与 `/api/audio/:id/file` 完全同口径（query token / 本机 origin / 本机页面 Referer）
- **支持 Range**（206 + `content-range`）；`content-type: video/mp4`
- 非正整数 id → 404（沿用既有口径，评审补：原稿漏写）；素材不存在 → 404；**素材行在但文件不在盘上 → 404 `FILE_MISSING`**
  - 评审补：`FILE_MISSING` 的文案要区分两种成因——"文件被外部删除"与"来源已被删除（素材一并清了）"，前者提示"重新下载视频"，后者提示"该来源已删除"。否则用户按提示去"重新下载"会发现来源也不见了

**`DELETE /api/media/:importId`** → 删素材文件 + `source_videos` 行
- **不动** `imported_sources`，也**不动**已剪出的音频条目
- 文件 IO 失败不让接口失败（与 `DELETE /api/audio/:id` 同款语义：DB 行删了就算"删了"）
- 非正整数 id → 404；素材不存在 → 404

**`POST /api/media/:importId/clip`**

- body `{ start: number, end: number, format: 'mp3'|'m4a'|'wav', quality?: string, title?: string }`
  - `title` 只作**前缀**：最终标题由**服务端**拼上时间段（D8），前端传什么都不影响这一点
- 校验：`format` 白名单 → 400；`start`/`end` 必须是 number 且 `start >= 0 && end > start`，否则 400（复用现有片段校验口径）；非正整数 importId → 404；素材不存在 → 404；素材行在但文件不在盘上 → 404 `FILE_MISSING`
  - **`end` 超过视频实际时长（评审补，原稿未定义）**：**允许**。ffmpeg 会自然截到片尾。这是真实会发生的操作（用户在末尾附近打点，手改数值改过头），报 400 反而烦人。但**必须留痕**：finalize 用 ffprobe 实测产出时长，并 `pushLog` 记"请求区间 X–Y，实际产出 Z 秒"，便于事后对账
- 201 `{ ok:true, jobId }`；job kind `ffmpeg_clip`；payload 存 `{ importId, videoPath, start, end, format, quality, title }`（retry 直接复用）
- 终态 `done` 事件形状与现有**音频下载完全一致**（`{ type:'done', kind:'audio', audioId, title, format, filePath, replaced:false }`）→ 前端 `subscribeJob` 可直接复用
- 判重：产物标题带时间段（D8），与已有音频天然不冲突；若用户传的前缀恰好撞上同 url+title，仍走现有 409 / force 逻辑，**不为此新增判重规则**
- **并发连点两次「剪出音频」是安全的**（评审补）：两个 job 读同一素材、各自写唯一临时名（D14）、各自入库拿到不同的 id → 输出文件名也不同。不需要并发锁

## 0.4 数据模型增量

```sql
-- 视频素材:与 imported_sources 一对一。刻意不写 REFERENCES —— 级联不生效(见 §0.1 事实 6),靠显式删
CREATE TABLE IF NOT EXISTS source_videos (
  import_id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  height INTEGER,          -- 下载时选的上限档(360/480/720/1080);实际分辨率以落盘文件为准
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `initSchema` 里 `CREATE TABLE IF NOT EXISTS` 即可（新表，无需补列）
- **`DELETE /api/imports/:id` 必须显式删 `source_videos` 行与素材文件**（现在只删来源行）
- **`audio_items` 不需要加列**：剪辑产物就是一条普通音频行（`source_type='download'`、`source_url`=原视频地址）

**素材落盘的覆盖语义（评审补：D9 的展开，原稿只写了"覆盖"两个字）**

1. **写新文件前先清掉该 import_id 名下的其它扩展名素材**（`media-<importId>.*`）。否则 webm → mp4 时会新旧并存，`source_videos.file_path` 指向新的、旧的水远留在盘上没人清——这与 `covers.ts` 踩过的"旧扩展名残留导致 `findCoverFile` 随机命中旧图"是**同一个坑**。
2. **rename 到最终位置失败（文件被占用）→ 这是本体失败，必须报错**，不能只记日志。典型场景：用户一边用 `<video>` 看着这个素材、一边点"重新下视频"，Windows 上目标文件被占用会让 rename 失败。**静默失败最坏**——用户以为换了清晰度，其实还是旧的。文案：先关掉预览再重试。
3. **D15：目标位置上已有文件、但 `source_videos` 里没有该 import_id 的行** → 视为用户手工放进来的文件，用 `resolveUniquePath` 加序号落盘，**绝不静默覆盖**。
4. 与之相对，**清旧文件失败（占用/权限）只记日志、不阻断**——因为那是附属动作，本体（新文件）已经写成了。与删除接口的既有语义一致。
   - 第 2 条与第 4 条不矛盾，区别是**失败的是"写本体"还是"删附属"**：前者报错，后者记日志。
5. 素材文件名：`media-<importId>.<ext>`，配合第 1 条 `media-<importId>.*` 的清理实现"一份"语义（**D15 触发时例外**，那时是带序号的名字，见第 3 条）

## 0.5 ffmpeg 抽音轨层（新建 `server/src/ffmpeg/`）

这是 PRD §3.2 早就规划、至今没建的目录的第一块。**分成纯函数与执行两层**，便于单测：

- `clip-args.ts`：纯函数 `buildClipArgs({ inputPath, outPath, start, end, format, quality })` → `string[]`。不碰 IO，参数快照断言。
- `clip.ts`：`runClip({ ffmpegPath, inputPath, outPath, start, end, format, quality, timeoutMs, doExec })` → `Promise<{ ok: boolean; stderr: string }>`
  - **成功判定以"目标文件真出现且体积 > 0"为准，不信退出码**（与 `covers.ts` 的 `writeCoverViaYtdlp` 同一口径——那边踩过"退出码 0 但没写出文件"）
  - 失败必须带 **stderr 关键行**（仓库铁律：永远不信 `err.message` 就够用；`execFile` 用三参回调，stderr 恒记）
  - `doExec` 可注入，单测不真拉进程
- **临时输出名唯一**（D14）：`clip-<jobId>-<时间戳>.<format>` 之类。绝不共用固定名——同族于 cookies.txt 被并发写坏那次
- **产物交给 `ingestDownloadedFile` 入库（D13），本层不手写 rename**：slug 文件名、冲突加序号、rename 失败回滚那套保护都是现成的，手写等于全丢
  - 因此本层的输出目录 = 既有 `tempDir`；finalize 里 `ingestDownloadedFile({ tmpPath: 临时产物, ... })` 一步到位

## 0.6 web（获取页新增一个模式）

> ⚠️ **已废弃（2026-09-30，M2 工作台重构 `m2-workspace`）**：本节描述的「获取页新增一个模式（视频预览剪音频）」**已作废**。「获取」页已改名为**资料库**（仅下载视频素材，不再有模式切换器），原"下视频 → 画面上打点 → 剪出音频"的交互**迁至剪辑室 / 剪辑详情**：剪辑室 `/studio` 是媒体列表（含"编辑"入口），剪辑详情 `/studio/:importId` 是同屏时间轴（画轨胶片条 + 音轨波形）打点编辑。下文保留为当时的历史设计。新落点见 `docs/superpowers/specs/m2-workspace.md`（§0.2 D4/D6/D17/D20、§0.3 接口、§0.5 P3/P4）。

获取页现在是"左列表 + 主区"，模式切换器放在页面顶部：

- 模式一「下载音频」：**现状完全不动**
- 模式二「视频预览剪音频」（新）：
  1. 选来源（复用左列表）→ 选清晰度（360/480/720/1080，默认 480）→「下视频」
  2. 进度条复用现有两段式；完成后出现打点界面：
     - `<video controls src={mediaFileUrl(importId)}>`（走 Range 路由）
     - **打点交互（自查定型，避免歧义）**：第一版**只用按钮**——播放到位置后点「设为起点 / 设为终点」，当前播放时间即打点值；两个输入框可手改到 0.1s。**可拖动的时间轴标记不在本轮**（拖拽在视频控件上是另一个交互实现，且按钮已能达成目的，属于 YAGNI）
     - 两个按秒微调的输入框（显示 `mm:ss.s`）
     - 格式 / 码率控件复用现有
     - 「剪出音频」→ job 进度 → 完成提示复用现有 `onDone` 文案
  3. **素材列表**：列出已下过的素材（标题 + 平台 logo + **下载时选的档位**如 `480p` + 文件大小 + 时间），点一条直接回到打点界面
     - 列表里的清晰度显示的是"当初选的档位"，不是 ffprobe 实测分辨率——文案上要写成"档位"，别让用户以为是文件的真实分辨率
     - 「删除素材」必须走 antd `Modal.confirm` 二次确认（仓库规则：凡丢数据的按钮都要确认，写清"删什么 + 不会连带删什么"）
      - **连既有文案一起改（评审 P0）**：`acquire.tsx` 里「删除来源」的确认文案现在写的是"只移除左列表条目，**不影响已下载到音频库的文件**"。本切片落地后这句话就是**错的**——删来源会连素材文件一起删（几百 MB、不可恢复）。必须改成说清"会一并删除该来源的视频素材文件（已剪出的音频不受影响）"。这是 P0 的理由：用户是**照着这句"不影响文件"的承诺**点的确认，然后丢掉素材
  4. 素材文件被外部删除 → 打开时校验存在，明确提示"素材文件已丢失，请重新下载"，不抛裸异常

`api.ts` 增补：`mediaFileUrl(importId)`、`listMedia()`、`deleteMedia(importId)`、`clipMedia(importId, payload)`；`startDownload` 的 payload 类型加 `produce` / `options.videoHeight`；`subscribeJob.onDone` 的入参改成 audio/video 两支的联合类型。

## 0.7 测试边界

**自动化（vitest）**

- `clip-args.ts`：参数快照（各格式 / 有无码率 / 起止值）
- `args.ts`：`buildVideoDownloadArgs` —— `-f` 表达式、`--merge-output-format mp4`、清晰度档位、cookie 与 section 透传
- `clip.ts`：成功（文件出现）/ 退出码 0 但无产物 → **判失败不误报** / 非零退出 → 失败且 stderr 带出
- `download.ts`：传视频扩展名集合时能找到 `.mp4` 产物；**取消时也用同一集合**清理 `.mp4` 半成品。这两条必须补——现有测试只覆盖音频，D5 漏了不会有任何测试变红
- **素材覆盖语义（评审补，对应 §0.4）**：
  - webm → mp4 重下后，旧的 `media-<id>.webm` 被清掉（不残留）
  - 目标文件被占用（注入 rename 桩抛占用错误）→ job **error** 且文案指向"先关闭预览"，**不是**静默成功
  - 目标位置有手工放置的同名文件、DB 却无对应行 → 落盘改用序号名，原文件**没被动过**（D15）
- **剪辑的边界（评审补）**：`end` 超过素材时长 → 允许，产出时长 = 素材实际长度且日志留痕；`ffmpeg_clip` 的 retry 在素材已被删时 → 明确失败（不是 ffmpeg 的裸报错）
- **并发（评审补）**：两个 clip job 并发 → 各自临时名不冲突、两条产物都入库
- HTTP：`produce` 非法 400 / `produce` 空串按 audio 处理 / `videoHeight` 非法 400 / `videoHeight` 缺省 = 480 / clip 起止非法 400 / 素材不存在 404 / 素材文件丢失 404 / clip 全链路（mock execFile）→ 产物入库为音频且**标题由后端拼上时间段**（前端传的 title 去掉时间段也不影响结果）/ 视频 job 的 retry 走对 kind
- 素材路由：Range 206 与全量 200 两种断言（与音频路由同款）
- `DELETE /api/imports/:id` → 素材行与文件一并清理

**手工目验（自动化不可达）**

真实短视频 → 下 480p → 在画面里定位 → 剪 10s → 音频库里是同一段内容（**听起点是否对得上**）；Electron 里 `<video>` 能播且能拖进度条；**一边播放一边点"重新下视频"** 能看到明确的占用提示而不是静默没换。

## 0.8 验收锚点

标注：**[自]** = 自动化可验证；**[人]** = 必须人工验证。

1. **[自]** 三包 `typecheck` 0 错、server `test` 全绿、web `build` 0 错
2. **[人]** 闭环：粘 URL → 下 480p 视频 → 在画面上定位 → 剪出音频 → 音频库出现该条并可播放
3. **[自]** 同一视频连剪两段 → 库里两条并存（不互相覆盖），标题各自带时间段
4. **[自]** 取消剪辑 / 取消视频下载 → temp 目录无残留
5. **[人]** 重启应用 → 素材列表仍在、点开仍能播；素材被手动删除时给明确提示而非裸异常
6. **[人]** **删来源时用户看到的是真实影响**（确认文案已说清会连素材一起删）——P0 的验收点

## 0.9 本轮明确不做（YAGNI）

- **不做波形**（不引入 wavesurfer）：痛点是"有没有画面"，不是"有没有波形"
- 不做多段拼接、淡入淡出、增益、响度标准化、变速、降噪 —— 那是 PRD 的 S4/S5
- 不做视频剪辑、不做视频转码、不把视频当"媒体条目"收进音频库
- 不做素材自动清理（用户明确选择"留着，方便再剪"）
- 不做批量 URL（一次一个）

**附：为什么不用另外两个方案**

| 方案 | 否决理由 |
|---|---|
| 视频下载独立成一套（新 job kind + 新表 + 新路由，不与音频管线共享代码） | 要把进度解析、SSE、取消（`taskkill` 杀进程树）、重试、启动恢复、cookie 注入**抄一遍**。这些逻辑是本仓库踩过坑才长成现在这样的，抄一份等于把坑再踩一次 |
| 不下载视频，用网站的嵌入播放器在线预览打点 | 三个硬伤：很多视频禁止站外嵌入；跨域拿不到精确播放时间；断网/代理一变就废 |

## 0.10 前置条件（评审补，交付/运维）

- **ffmpeg 必须可用**（D16）：设置页配过就用它，没配则扫 PATH；两处都拿不到 → **剪辑功能整体不可用**，报错直接引导去设置页配置。这是本切片起新增的**硬前置**——注意与既有音频链路不同：那边 ffmpeg 缺失只让"转码这一步"失败，下载仍可能成功。
- 磁盘：素材按用户选择长期保留、**无自动清理**（§0.9）。列表逐条显示大小，但**不做总占用合计**（见 §0.11 候选）。
- 回滚：本切片只新增表 / 路由 / 页面模式，停用只需关掉前端入口；留一张空表与一个空目录不影响既有功能。

## 0.11 Backlog（P2 处置记录）

### 已采纳（本轮已并入正文）

| # | 优化项 | 落点 |
|---|---|---|
| P2-a | `source_videos.file_path` 与"文件名可由 import_id 推出"构成第二份真相 | §0.4 覆盖语义第 1/5 条：写前清旧扩展名，读点只有 `file_path` |
| P2-b | clip job 重试时素材可能已失效 | §0.3 retry 条：重试前校验素材仍在，不在则给明确文案 |
| P2-c | 验收锚点未标"自动/人工" | §0.8：已加 `[自]` / `[人]` 标注 |
| P2-d | 非正整数 id 的 404 口径未写明 | §0.3 三条 media 路由均已补 |
| P2-e | `produce: ''` 空串归哪边未写明 | §0.3：空串归 audio，只有其它非法值才 400 |
| P2-f | 删来源后前端提示措辞不准（说"文件已丢失"而实际是来源没了） | §0.3 `FILE_MISSING` 文案区分两种成因 |

### 已关闭

| # | 优化项 | 关闭理由 |
|---|---|---|
| P2-g | 重下视频覆盖旧素材是否要二次确认 | 伪需求：覆盖的是"同一素材的旧版本"，是用户主动换清晰度的必然结果，且随时能重新下载（不像删来源会连来源记录一起消失）。不加确认，避免每次都弹窗 |
| P2-h | 剪辑产物标题含 Windows 非法字符/超长 | 已有等价覆盖：`ingestDownloadedFile` 走既有的 slug 规则（替换非法字符 + 截断 80），无需新增 |
| P2-n | **同族扫描发现**：`covers/` 也有"用户手工放的同名图会被静默覆盖"的问题（`cover-<id>.jpg` 固定名） | 关闭：封面是本工具自己抓的**可再生缓存**，覆盖或丢失都能重新抓，与"用户手工放进来的视频被覆盖"性质完全不同（那个不可再生）。不修 |

### 候选（记录触发信号，暂不实施）

| # | 优化项 | 触发信号 |
|---|---|---|
| P2-i | 孤儿素材文件清理（rename 成功但 DB 行未写就崩溃 → 盘上有文件、界面看不到） | 该场景真实发生 ≥ 2 次。与 PRD §9.3 的 P2-9（孤儿文件重扫描）同族，可合并评估 |
| P2-j | 素材总占用体积显示 | 用户反馈磁盘空间压力 |
| P2-k | 视频 finalize 逻辑拆独立模块 | `ytdlp-routes.ts` 超过约 900 行（2026-09-30 落地后实测 769 行——本切片把视频 finalize 写在了同文件，尚未触发；继续观察） |
| P2-l | 统一给 yt-dlp 传 `--ffmpeg-location` | 出现"yt-dlp 内部用的 ffmpeg 与设置页配的不是同一个"导致的怪异失败 ≥ 1 次（既有问题，非本切片引入） |
| P2-m | clip job 的精细化进度（ffmpeg `-progress`） | 长视频剪辑（> 30s）被用户抱怨"点了没反应" |

## 相关 PRD 段落对照（实施者应通读）

- §2.1 FR-1.2（片段下载 `--download-sections`）——本切片的"时间区间"概念来源
- §2.3 FR-3.2 / FR-3.5 / FR-3.7（裁剪、格式导出、`parent_id` 血缘）——本切片只做前两项的最小版，血缘留到 S5
- §3.4 错误处理原则（stderr 捕获、临时名原子改名）
- §3.5 文件命名与唯一性策略（slug、冲突序号）
- §6.1 S2 / S5（本切片在路线图中的前后关系）

## 文档回写（2026-09-30 已完成）

1. ✅ **PRD §6.1 路线图**：已插入 S2.5（依赖 S2，是 S5 的最小前置），并注明它不在原 S1–S6 内
2. ✅ **PRD §6 里程碑表**：已在依赖顺序段补 S2.5 位置与前置条件声明
3. ✅ **PRD 前置条件（D16）**：已在 §6 声明"剪辑类功能要求 ffmpeg 可用"
4. ✅ **m1a spec §0.6 的漂移修正**：已改实情（片段起止 UI 未实现，2026-09-30 核实）
5. ✅ **m1a spec §0.3 的 download 契约**：已补 `produce` / `options.videoHeight` 两个可选字段
6. ✅ **`acquire.tsx` 的「删除来源」确认文案**：已改为"会一并删除该来源的视频素材文件（已剪出的音频不受影响）。"（与素材删除同批上线，浏览器实测确认）
