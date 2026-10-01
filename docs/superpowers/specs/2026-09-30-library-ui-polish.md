# Spec: 资料库 UI 精修 + 清晰度按实测列档（library-ui-polish）

> 来源：2026-09-30 用户口述（6 条，原文见 §0.0）｜逐条与用户确认（同日）
> 关系：局部 UI 调整 + 一处接口新增，不改任何既有接口语义
> 状态：**待用户过目** → 过目后进入 writing-plans

---

## 0.0 为什么（用户原话，按点罗列不改写）

1. 「我红框框起来的，应该放到内容区域啊，**这一行根本不该出现**」（截图 = 资料库页，红框 = 来源名 + 档位/下载/删除来源那一整行，横跨在左列表**上方**）
2. 「**Tab 上要有 icon**」
3. 「**下载和删除来源都用 icon 替代，hover 显示 tooltip**」
4. 「你需要可以**从这里使用浏览器打开原视频页**，一个 icon 就可以了，要有 tooltip」
5. 「视频的分辨率你是怎么找到的？**这个是不是有 4k 的分辨率？**」→ 追问后裁定：**改成按视频实测列出可用分辨率**
6. （控制器发现）`PageHeader.tsx` 注释称「设置页用这个简化形态」，**实际设置页并未引用它** → 过时描述需扫正

## 0.1 现状基线（2026-09-30 实核，读码）

1. **资料库布局**：`library.tsx:234` 外层 flex column；第一个子项是 `<PageHeader>`（`flexShrink:0`，**全宽**，横跨在左列表上方）；第二个子项才是 flex row（左 `width:240` 来源列表 + 右 `flex:1` 内容区）。PageHeader 自带 `padding:'10px 16px'` + `background:#fff` + `borderBottom`（`PageHeader.tsx:20-25`）。
2. **PageHeader 全站只有 2 个使用者**：`library.tsx`、`studio-detail.tsx`（首页/剪辑室/设置都没用）。→ `PageHeader.tsx:3` 的「设置页用这个简化形态」是**过时**注释。
3. **导航**在 `layouts/index.tsx:11-16` 的 `NAV_ITEMS`（`{ key, label }`，**无 icon**）；antd `Menu` 的 `items` 支持 `icon` 字段。
4. **清晰度档位是硬编码**：`library.tsx:25` 的 `useState<360|480|720|1080>(480)` + `:258` 的 Radio 选项数组同为硬编码；传后端 `options.videoHeight`（`api.ts:129`）→ `args.ts:59` 拼成 `-f 'bv*[height<=N]+ba/b[height<=N]/b'`（即"不超过该高度的最佳画质"）。`source_videos.height` 记的是**所选档位**，不是实测分辨率。
5. **解析接口拿不到分辨率**：`POST /api/ytdlp/parse` 走 `-J --flat-playlist`（`args.ts:13`）→ **只返回列表，不含 formats**。要拿"可用分辨率"必须另跑一次**非 flat** 的探测。
6. **「下载」「删除来源」是文字按钮**（`library.tsx:263-275`）。
7. **外链已有既成路径**：桌面壳 `main.ts` 的 `setWindowOpenHandler` 把 http(s) 一律 `deny` 并交给 `shell.openExternal` → 前端写 `<a target="_blank">` 即可（浏览器直连模式走原生新标签）。`ImportSource.url` 已在前端类型里。
8. **`videoHeight` 类型是窄联合**：`360|480|720|1080`，出现在 `api.ts:129`、`args.ts:8`、`args.ts:54`。放宽它会连带需要**服务端校验**（现在没有校验）。

## 0.2 决定（不可违反）

| # | 决定 | 理由 |
|---|---|---|
| D1 | 资料库的「标题 + 工具栏」整块**从"页面级"降为"右栏级"**：左列表顶到内容区最上方；右栏顶部依次是标题行（来源 logo + 来源名 + 时长）、其下是控件行。**控件行顺序 = 清晰度 → 下载 → 原视频页 → 删除来源**（下载紧贴档位，两者是一组动作；危险操作放最后防误触）。**左列表不再被压下去**。 | 用户截图 + 箭头指向内容区；标题/控件只属于"右栏那个详情"，不属于整页。顺序见 §0.2 的 Ruling T3-a。 |
| D2 | **PageHeader 组件本身不改样式契约**（它天生就是"某块内容区的头"，`flexShrink:0` + 自身 padding/border 在右栏内也成立），只改**它在 library 里的挂载位置**；剪辑详情页**不动**（它没有侧栏，本来就在内容区顶部）。 | 改组件会影响另一个使用者；只挪挂载点就把问题解决，风险最小。 |
| D3 | 新增**「在浏览器打开原视频页」**图标（`LinkOutlined`），`<a href={detail.url} target="_blank" rel="noreferrer">`；tooltip「在浏览器打开原视频页」。`url` 为空 → **禁用 + tooltip「没有原视频地址」**。 | 桌面壳已有外链统一出口（§0.1 事实 7），零新增 IPC。 |
| D4 | 「下载」→ `DownloadOutlined`、「删除来源」→ `DeleteOutlined`(danger)，**都挂中文 tooltip**；禁用态（playlist 未选集）也用 `<span>` 垫层让 tooltip 能触发。 | 同剪辑详情工具栏 D9 那套（禁用态也必须能悬停出提示）。 |
| D5 | 顶部 4 个导航项加图标：首页 `HomeOutlined` / 资料库 `VideoCameraOutlined` / 剪辑室 `ScissorOutlined` / 设置 `SettingOutlined`。 | 用户要求；antd Menu 原生支持。 |
| D6 | **清晰度档位改为"按当前选中视频实测列出可用分辨率"**：新增探测接口，服务端跑 `yt-dlp -J`（**非 flat**）取 formats，抽 `vcodec != 'none'` 的 `height` → 去重 → 降序 → 剔除 `< 360`。 | 用户裁定。 |
| D6a | **实测值不规整，界面负责归一标签**（2026-09-30 Task 1 真实实测发现，spec 原稿未预料）：B 站的编码高度实测为 `[1056, 704, 470]` 这类**非标准档位**，直接显示会变成「1056p/704p/470p」，看着像坏了。**API 忠实返回实测高度**（不美化、不四舍五入），**界面把标签归一到常见档位、但 Radio 的 value 仍是实测值**（`height<=1056` 才能精确命中那一路流）。归一规则：找 ±15% 内最近的标准档位（`[240,360,480,720,1080,1440,2160,4320]`），找不到就原样显示（如 900 → `900p`）。 | 忠实数据与友好展示分离：服务端不做有损转换，视觉归一放 UI。 |
| D7 | **探测失败必须降级、不得报错**：超时/拿不到 formats/空结果 → 返回 `fallback:true` + 固定四档 `[360,480,720,1080]`，UI 静默沿用固定档并给一句次要说明。 | 探测是"增强"，不能因为它挂了就让整个下载不可用（评审盲点：把增强做成了单点故障）。 |
| D8 | 合集**只探当前选中的那一集**（`--playlist-items <n>`）；**未选集时不请求**，UI 提示「先选一集」。单视频（`kind='single'`）直接探。 | 一个合集 193 集，全探不动；用户下载的就是选中的那一集。 |
| D9 | 单集探测结果**进程内缓存**（key = `url + entry`，TTL 10 分钟）。 | 同一集反复切换不该反复跑 yt-dlp（每次 1–3s + 一次外网请求，也是风控面）。 |
| D10 | `videoHeight` 类型**从窄联合放宽为 `number`**；**服务端补校验**：必须是整数且落在 `144..4320`，否则 400。 | 实测档位可能是 1440/2160 等任意值；放宽类型必须配校验，否则等于把任意值拼进 ffmpeg 参数。 |
| D11 | 顺带扫正 `PageHeader.tsx:3` 关于"设置页"的过时注释。 | 用户规则：落地后回头扫一遍所有声明它的地方。 |

## 0.3 接口契约

### 新增：探测可用分辨率

`GET /api/imports/:id/formats?entry=<n>`
（token 保护，**无守卫豁免**——它是 fetch 调用，能带 header）

- `id`：`imported_sources.id`
- `entry`：合集的第几集（1 起）。**合集缺省 → 400**；单视频传了也接受（忽略）
- 成功 → `200 { ok:true, heights:[2160,1440,1080,720,480,360], fallback:false }`（**降序**，已去重、已剔除 <360）
- 探测失败/超时(15s)/空结果 → `200 { ok:true, heights:[360,480,720,1080], fallback:true }`
- `id` 不存在 → `404 { ok:false, error:{ code:'NOT_FOUND', message:'来源不存在', next:'回资料库刷新列表' } }`
- 合集未传 entry → `400 { ok:false, error:{ code:'BAD_REQUEST', message:'合集需要先选一集', next:'在集数网格里点一集' } }`
- 两条失败路径都要 `pushLog`（探测失败走 `error`，降级走 `info`）

### 既有接口的契约变更

`POST /api/ytdlp/download`（`options.videoHeight`）
- **放宽**：任意整数 `144..4320` 都合法（不再只认 360/480/720/1080）
- **新增校验**：非整数 / 越界 → `400 { ok:false, error:{ code:'BAD_REQUEST', message:'清晰度不合法', next:'在资料库重新选择清晰度' } }`
- 其余语义不变（仍是 `-f 'bv*[height<=N]+...'` 的"上限档"）

### 前端封装

- `web/src/api.ts` 增 `getFormats(importId: number, entry?: number): Promise<{ ok:boolean; heights:number[]; fallback:boolean }>`
- `DownloadPayload.options.videoHeight` 类型 `360|480|720|1080` → `number`

## 0.4 数据流

1. 资料库选中来源（`selectSource`）→ 若 `kind='single'` 直接探测；`kind='playlist'` **等用户在网格里点中一集**再探测。
2. 探测返回 → `heights` 生成 Radio 选项（label `${h}p`）；`fallback:true` → 用固定四档 + 次级说明。
3. 用户选档 → 点下载 → payload `videoHeight` = 选定值 → 服务端校验后拼 `-f height<=N`。
4. 原视频页：点图标 → 新标签/系统浏览器打开 `detail.url`。

## 0.5 错误处理

| 场景 | 行为 |
|---|---|
| 探测超时/失败/空 | **200 + fallback:true**，UI 静默用固定四档 + 次要说明（「未能读取视频信息，已用常用档位」）+ `logFe`。**不弹错** |
| 合集未选集就点下载 | 保持现状（按钮禁用 + tooltip）；探测则不请求 |
| `videoHeight` 非法 | 服务端 400 + `next` 指引 |
| `detail.url` 为空 | 原视频页图标禁用 + tooltip「没有原视频地址」 |
| 探测期间用户换了集 | 后发请求覆盖前发（按 `entry` 序号丢弃过期响应，避免"探的是第 3 集、显示在第 5 集"） |

## 0.6 测试边界

**vitest（server）**
- `formats` 路由：单视频成功（用 formats JSON fixture）→ 去重、降序、剔除 `vcodec='none'`、剔除 `<360`
- `formats` 路由：合集缺 `entry` → 400；带 `entry` → 用 `--playlist-items <n>`
- `formats` 路由：yt-dlp 非零退出 / 超时 / formats 为空 → **200 + fallback:true + 四档**
- `formats` 路由：`id` 不存在 → 404
- `formats` 缓存：同一 `url+entry` 第二次调用**不再执行** yt-dlp（桩计数为 1）
- `args.ts`：`buildProbeFormatsArgs(url, {entry?, cookiePath?})` 参数快照（含/不含 `--playlist-items`、`-J`、cookie 位置）
- `ytdlp-routes`：`videoHeight` 为 `1440` → 200 且 args 含 `height<=1440`；为 `'abc'` / `100` / `5000` → 400

**手工目验**
- 左列表顶到内容区最上；标题+控件在右栏顶部、**不再横跨左列表**
- 4 个 Tab 有图标；下载/删除来源是图标、悬停有中文提示；原视频页图标能在系统浏览器打开
- 选一个视频 → 档位按**实测**列出（例如只有 720/1080 就只显示这两档）；断网再试 → 退回四档且**不弹错**
- 合集：未选集时档位区提示先选一集；选中某集后档位刷新为该集的

## 0.7 验收锚点

1. **[自]** 三包 `typecheck` 0 错 + `pnpm --filter @sct/server test` 全绿 + `pnpm --filter @sct/web build` 成功
2. **[人]** 资料库：那一行不再横跨左列表上方的整宽，而是右栏的头部（D1）
3. **[人]** Tab / 下载 / 删除来源 / 原视频页：图标 + 中文 tooltip 全部可见可懂（D3/D4/D5）
4. **[人]** 档位来自实测（能看出与固定四档不同），且探测失败时**降级不报错**（D6/D7）
5. **[人]** 浏览器直连模式（`?apiPort=` 直开）下原视频页图标仍然可用（走原生新标签）

## 0.8 YAGNI（本轮不做）

- 不做「记住每集各自选的档位」
- 不做下载前的体积/时长预估
- 不做档位的"推荐"标记（如"最高可用"）
- 不合并/不重做剪辑详情页与剪辑室的页面头（D2 只挪资料库这一处）
- 不引入新依赖

## 0.9 回滚

- 布局搬移：把 PageHeader 移回外层第一个子项即回到现状
- 探测：前端在 `getFormats` 失败或 `fallback` 时用的就是固定四档，**退化为今日行为**；服务端探测路由可整体下线而不影响下载
- 图标化：纯展示层

## 0.10 影响面（文件级）

| 文件 | 改动 |
|---|---|
| `server/src/media/formats-routes.ts` | **新建**：`GET /api/imports/:id/formats` + 进程内缓存 |
| `server/src/ytdlp/args.ts` | 新增 `buildProbeFormatsArgs()`；`videoHeight` 类型放宽为 `number` |
| `server/src/ytdlp/ytdlp-routes.ts` | `videoHeight` 校验（整数 144..4320 → 否则 400） |
| `server/src/index.ts` | 注册 formats 路由 |
| `web/src/pages/library.tsx` | 布局搬移（D1）+ 工具栏图标化（D4）+ 原视频页图标（D3）+ 档位探测（D6/D7/D8）+ 过期响应丢弃 |
| `web/src/layouts/index.tsx` | `NAV_ITEMS` 加 icon（D5） |
| `web/src/api.ts` | `getFormats()`；`videoHeight` 类型放宽 |
| `web/src/components/PageHeader.tsx` | 注释扫正（D11） |
| 测试 | formats 路由测试（新）、`args.test.ts`（追加）、`ytdlp-routes.test.ts`（追加校验用例） |

## 0.11 与既有决定的相容性检查

- **m2-workspace D2（统一页面头）**：语义不变——它仍是"某块内容区的头"，只是资料库的"内容区"从"整页"精确到"右栏"。**收尾时需在 D2 处补一句**（资料库的页面头属于右栏）。
- **m2-workspace D3（整页不滚 body）**：不变，右栏内部仍自管滚动。
- **D17（无素材空态）/ D20（集号）/ D19（换集清工程）**：零交集。
- **P2-T7 的 `mediaRev` 版本串**：不动。
- **本切片不碰下载链路本身**（不排队、不节流）——那是另一个 spec（`2026-09-30-download-queue-tray`）。
