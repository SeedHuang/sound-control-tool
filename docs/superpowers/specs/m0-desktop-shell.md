# Spec: 桌面壳与内嵌 server（m0-desktop-shell）

> split from `docs/prds/音频录制与剪辑-PRD初始篇.md`（2026-09-26），对应 PRD §3.2/§6-M0/§7-R7/§6.1-S1。
> 2026-09-26 设计定稿（desktop 走 TS→CJS；spike 前置）；同日多透镜评审第 1 轮收敛（P0-1 方案 A 拍板，见 §0.7）。
> **同日 Task 1 spike 修订：D9 双副本证伪，按 §0.7 预授权切换方案 C（node:sqlite），用户拍板 C1。本版为切换后的现行版。**

## 0. 桌面壳与内嵌 server

### 0.0 为什么

三包 workspace + Electron 内嵌 server 方案（ADR-3）最初的两大风险——better-sqlite3 的 Electron ABI 适配（PRD R7）与"一份安装服务两个运行时"的冲突——已在 Task 1 spike 中以**换驱动**方式终结：SQLite 驱动改为 Node 内置的 `node:sqlite`（零原生模块、零 rebuild），两个运行时实测可用（见 0.1/0.2-D2）。spike 同时留下一条已证伪记录：原 D9"双副本"在 pnpm 12 下结构性不成立（实证见 0.7）。

S1 其余使命不变：**用最小代价证明内嵌链路走得通（已达成一半），并把三进程开发态骨架一次立起来**，后续 spec 只做增量，不再碰脚手架。

### 0.1 已实测确认的前提（2026-09-26）

本机环境（已探测/实测）：

| 项 | 值 | 影响 |
|---|---|---|
| Node | v22.12.0 | `node:sqlite` 需 flag：`NODE_OPTIONS=--experimental-sqlite`（实测 PASS）；**升级 Node 24 LTS 可去 flag（可选优化，非依赖）** |
| Electron | **44.4.5**（内置 Node 24.21.0） | `node:sqlite` 无 flag 实测 PASS；Electron-ABI=149 |
| pnpm | 12.6.0 | **npm 别名与原版去重为同一物理实例**（junction+lockfile 实证）——一切"别名副本"方案在此布局下不可行 |
| ffmpeg | 9.0.2-full_build (gyan.dev) | probe:bins 预期来源 |
| yt-dlp | 2026.08.19 | 同上 |

平台事实（官方文档+本机探针实证，2026-09-26）：

1. **node:sqlite 可用性矩阵**：Electron 44 主进程**无 flag PASS**；Node 22.12 经 `--experimental-sqlite` **PASS**（可加 `--disable-warning=ExperimentalWarning` 消音）。`DatabaseSync` 的 `exec/prepare/run/get/all` 在两侧行为一致——驱动切换对 repo 层透明
2. **better-sqlite3 原生路线在 Electron 44 不可行**：预编译最高发布到 electron-v146 < 所需 149，本机无 MSVC 无法源码编译；且 pnpm 12 别名去重使"双副本"前提失效。两者叠加 → 排除
3. **Umi Max 4 + file://**：`history: { type: 'hash' }` + 生产态 `publicPath: './'` 是标准解；备选 `electron-serve`（需 Electron 37+，本版满足）仅在上线路径失败时启用
4. **CJS 主进程加载 ESM server**：`require()` 不行，`await import()` 合法。~~TS 会把 import() 转译成 require，必须经 `new Function` 包装~~ **（2026-09-26 OCR 修复后修订）**：`module`/`moduleResolution` 设为 `node16` 时 TS **保留**原生 dynamic import（不降级为 require），故直接 `await import('@sct/server')` 即可，`new Function` 包装已废弃删除（编译产物实测：静态导入降级为 `require`、动态导入保留 `import()`）

**前置条件**：无编译工具链需求（零原生模块）。

### 0.2 核心决定（不可违反）

| # | 决定 | 为什么 |
|---|---|---|
| D1 | desktop 包 TS→CJS（tsc 编译到 `dist/`）；`module`/`moduleResolution` = `node16`（使 TS 保留原生 dynamic import）；主进程直接 `await import('@sct/server')` 加载 ESM server | CJS 不能 require() ESM 但真实 dynamic import 合法。**（2026-09-26 OCR 修复）**：原方案用 `new Function` 包装绕过 TS 的 import→require 降级，属 eval 家族构造（`dynamic-import.ts` 已删除）；改 node16 后 TS 保留 `import()`，无需包装且无该代码异味 |
| D2 | **spike 已闭环（2026-09-26）**：①pnpm 别名副本不可 rebuild（证伪）②Electron 主进程内 node:sqlite 往返 PASS ③Node 22.12 flag 路线 PASS。探针保留为 `probe:sqlite`/`probe:sqlite:node` 供复跑 | R7 与双运行时冲突已归零；结论与实证记录在案，后续复验有基线 |
| D3 | 端口**运行时经 URL query 注入**：electron 加载 `…/?apiPort=X`；web 的 api.ts 运行时读 `location.search`，缺省回退 7310。dev 态读 portFile 后必须 health 验证，失败走回退链（0.3） | 浏览器无 process.env，端口运行时才确定；portFile 内容可能脏/缺失/过期 |
| D3b | 端到端验证时若实测发现 Umi hash 路由丢弃 `location.search` → 退化为 preload contextBridge 注入，并回写本节。**【现状 2026-09-27 Task 7】自动化已证：7310 全程收到 0 个连接（与"页面未回落 7310"一致，但不等于已证渲染链路生效）（7310 被带连接计数的占位进程占住时，内嵌 server 递增 7311 且占位进程 0 连接）；hash 与 search 是否共存（`#/settings` 实际显示 apiPort=7311）待目验，退化触发条件尚未证实，contextBridge 备选继续冻结** | hash 与 search 共存行为以实测为准，不猜 |
| D4 | server 唯一出口：`createServer(opts) => Promise<{ port, close }>`；**port/dbPath/tempDir 必传**，端口约定 dev 7310、占用自动递增（findFreePort 纯函数） | 端口冲突是常态；"默认 userData"在 dev tsx 进程无法解析——数据目录归属由调用方声明，顺带实现 dev/prod 数据隔离 |
| D5 | S1 建齐 PRD §4.1 **全部五张表** + settings/jobs repo 骨架 + `bootstrap()` 启动恢复（running→error）与孤儿临时文件清理 | 启动序列只有一个作者；DDL 已在 PRD 定稿；五表齐建是 S2/S3 真并行的前提 |
| D6 | S1 只建 `/`（调 health 的空壳）与 `/settings`；`/settings` 显示实际 API 端口与二进制探测结果 | 投机建页面 = 面向猜测编码；满足 PRD"实际端口在 UI 可见" |
| D7 | preload 只留空骨架（contextIsolation 开启），S1 不注册任何 IPC | S3 才需要 setDisplayMediaRequestHandler |
| D8 | `requestSingleInstanceLock`，第二实例激活已有窗口即退出；根 dev 脚本用 `concurrently -k` | 双开 = 双 server 抢端口抢 SQLite 文件；-k 收割第二套孤儿进程 |
| D9 | **SQLite 驱动 = node:sqlite 内置模块（零原生模块）**：db 层唯一入口 `db/index.ts openDatabase(dbPath): DB`（同步，包装 `DatabaseSync`）；**Node 22.12 侧所有运行时入口（dev/test/probe:sqlite:node）以 `cross-env NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning"` 注入**；Electron 侧无 flag。**禁止引入 better-sqlite3 / @electron/rebuild** | 双副本证伪后的唯一不动点（D2 实证）；flag 管道只存在于 Node 22 侧；换驱动后 R7 整个消失 |
| D10 | **失败必须可诊断，禁止裸崩**：主进程动态 import 失败 → `dialog.showErrorBox` 给出可执行指引；dev 态端口回退链耗尽 → dialog 指引"先启动 server" | 裸崩 `ERR_DLOPEN_FAILED` 类错误用户无法自助；未来驱动/环境问题同样适用 |
| D11 | web 对 **API 不可达**有统一行为：api.ts 统一错误封装；页面 catch → antd Alert 显示"无法连接本地服务(apiPort=X)"与指引 | dev 日常会发生；白屏或控制台裸异常不可接受 |
| D12 | **API token（2026-09-26 OCR 评审后新增）**：`createServer` 启动生成随机 token 并随返回值/portFile 下发；**受保护路由**（`GET/PUT /api/settings`、`GET /api/bins/probe`）要求请求头 `x-sct-token` 匹配；**豁免条件**=`Origin` 属白名单 localhost 来源（保住 ADR-2 浏览器独立开发零额外步骤）；`/api/health` 不设 token（只读、回退链需要） | 仅靠 CORS 白名单挡不住 `Origin: null`——sandboxed iframe/data:/blob: 页面同样发 null，可跨站 `PUT /api/settings` 改写 `bin_ffmpeg` → 后续 `execFile` 执行（RCE 升级路径）。自定义头强制 preflight 且 no-cors 无法设置，配合 token 真正闭合该面 |

### 0.3 机制

**createServer 工厂**（`server/src/index.ts` 唯一出口）：

```ts
export interface CreateServerOpts {
  port: number;      // 必传,约定 dev 7310;占用自动递增(findFreePort)
  dbPath: string;    // 必传:electron→userData/sct.db;dev→.sct/dev-data/sct.db;测试→:memory:
  tempDir: string;   // 必传,分运行时同 dbPath
  portFile?: string; // 仅 dev:写入 {port, pid, token}(JSON),供 electron 握手
}
export async function createServer(opts: CreateServerOpts): Promise<{
  port: number;
  token: string;     // D12:随机 API token,受保护路由要求 x-sct-token 匹配
  close: () => Promise<void>;
}>;
export async function bootstrap(opts: Pick<CreateServerOpts, 'dbPath' | 'tempDir'>): Promise<void>;
// 前置:dbPath 父目录与 tempDir 不存在则 recursive mkdir
// 启动恢复:jobs 表 pending/running → error("应用中断,可重试")
// 孤儿清理:扫描 tempDir,删除无活跃任务对应的残留
```

**db 层（D9，唯一驱动入口）**：

```ts
import { DatabaseSync } from 'node:sqlite';
export type DB = DatabaseSync;
/** 同步 API;两运行时行为一致(D2 实证) */
export function openDatabase(dbPath: string): DB {
  return new DatabaseSync(dbPath);
}
```

`StatementSync` 的 `run()` 返回 `{ changes, lastInsertRowid }`、`get()/all()` 返回值需显式收窄类型——repo 层统一在此收窄，业务代码不见裸 unknown。

**端口协调（dev 态三进程）**：`pnpm dev`（`concurrently -k`）同时起 tsx server、max web（:8000）、electron。

- dev：tsx server 监听成功后写 `{port, pid, token}` 进 portFile（`.sct/dev-port`，gitignore）；electron 轮询读取（≤10s）→ **对读到的端口发 `/api/health` 短超时验证** → 通过才拼 URL（带 `?apiPort=X&apiToken=Y`）
- **回退链**：portFile 缺失/超时/health 不通（含双跑竞态脏端口）→ 回退 7310 再验 → 仍失败 → dialog 指引并退出（D10）
- 生产：主进程 `createServer()` 内嵌启动直接拿返回值；浏览器独立开发：api.ts 缺省 7310
- **web dev 端口固定 8000**：显式传参，被占即失败——electron 拼 URL 依赖此约定；**loadURL 前先轮询等待 8000 有 HTTP 响应（≤60s，waitForWebReady）**——三进程并发下 electron 启动快于 webpack 冷启动，直接加载会 ERR_CONNECTION_REFUSED 弹"启动失败"（2026-09-28 实测复现后补）
- **CORS**：server 对 `/api/*` 仅放行 **origin 白名单**——`null`(file://) / `localhost` / `127.0.0.1`（含任意端口）；非白名单**不下发** `access-control-allow-origin`，`vary: Origin` 恒下发（无论是否反射）。理由：server 监听 127.0.0.1 且含 execFile 二进制探测链路，无条件反射任意站点 origin 会允许恶意网页读取/改写本地设置，故收紧为白名单
- **API token（D12）**：受保护路由（settings GET/PUT、bins/probe）校验请求头 `x-sct-token`；**Origin 属上述白名单 localhost 来源时豁免**（dev 浏览器直开零额外步骤，ADR-2 不受影响）；`/api/health` 不校验（只读 + 回退链需要）。token 流转：createServer 生成 → portFile/返回值 → desktop 注入 URL query → web api.ts 作为请求头发送；浏览器独立开发时从 `.sct/dev-port` 读取后手填 `?apiToken=`。CORS 的 `allow-headers` 需含 `x-sct-token`

**主进程启动序列**（`desktop/src/main.ts`，顺序固定）：

1. `requestSingleInstanceLock` 检查（失败即退出）
2. （仅生产态）动态 import server——try/catch 包裹，失败 → `showErrorBox` 指引并退出（D10）；**dev 态跳过 2-3**：electron 不加载 server，server 由 tsx 进程负责
3. （仅生产态）`bootstrap()`（mkdir → 启动恢复 → 孤儿清理）；dev 态由 server 的 dev.ts 调用
4. 获取端口：生产态拿返回值；dev 态轮询 portFile + health 验证 + 回退链
5. 创建 BrowserWindow，按 dev/prod 选加载 URL（带 `?apiPort=`）
6. app quit：生产态调 `close()`；dev 态不碰 server 进程

### 0.4 测试与探针

| 测什么 | 为什么 |
|---|---|
| openDatabase 内存库读写往返 | 驱动入口的最小可信验证（node:sqlite 语法收窄点） |
| findFreePort（纯函数） | 端口逻辑写错 = 偶发"连不上"，难排查 |
| portFile 内容解析（纯函数：合法 JSON/垃圾/缺字段） | 双跑与脏文件是真实场景，解析是回退链第一环 |
| settings repo（内存库，真 SQL 不 mock） | DDL 与约束本身就是被测对象 |
| bootstrap 启动恢复（构造 running 行 → 断言变 error） | 崩溃后的状态是合法输入，不是异常输入 |
| 孤儿清理（构造残留文件 → 断言删留判定） | 同上 |

**探针**（手工跑，结论必须回写本节）：

- `pnpm probe:sqlite` —— 最小 Electron 主进程脚本：动态 import server 完整入口 → node:sqlite 建表/写入/读出。D2 验证②的固化形态；升级 Electron 后复跑
- `pnpm probe:sqlite:node` —— Node 22 侧 flag 路线验证（D2 验证③固化）
- `GET /api/bins/probe`（probe:bins）—— 探测 yt-dlp / ffmpeg 的路径与版本（缺失时 `version=null`，归 UI 标红）
- 端到端探针 —— dev 态 + 生产构建态各一遍：窗口加载、hash 路由可达、health 返回 SQLite 读写结果、`?apiPort=` 贯通

**probe:bins 结论（2026-09-27 Task 8，本机实测）**：

- 后台 `pnpm dev` 起服务（`7310`）→ `Invoke-WebRequest http://127.0.0.1:7310/api/bins/probe` → `200`：`ytdlp={path:"D:\devtools\Python312\Scripts\yt-dlp.exe", version:"2026.08.19"}`、`ffmpeg={path:"…Gyan.FFmpeg…\ffmpeg-9.0.2-full_build\bin\ffmpeg.exe", version:"ffmpeg version 9.0.2-full_build-www.gyan.dev …"}`——与 0.1 预期来源一致
- **关键实测发现（版本旗标因二进制而异）**：yt-dlp 认 `--version`；ffmpeg 只认 `-version`——传 `--version` 会 `Unrecognized option` 并非零退出，使 ffmpeg 被误报为缺失。`bins.ts` 以 `VERSION_FLAG` 映射区分
- 探测策略：`candidatesFromPath(pathVar,name)` 为纯函数（仅 PATH 切分+拼可执行名，无 IO）；存在性判定与选取首个存在候选在 `probeBin` 内完成——PATH 顺序不可信，候选须逐个验存在
- 路由落点：`registerSettingsRoutes(app, db)`（`createServer` 内 `registerCors` 之后注册），提供 `GET /api/settings`、`PUT /api/settings`（键白名单+字符串校验，非法返回 400）、`GET /api/bins/probe`；探测结果回写 `bin_ytdlp`/`bin_ffmpeg`/`bins_probed_at`

**端到端探针结论 —— 生产态（2026-09-27 Task 7，自动化已证项）**：

- `pnpm build` 三包（server/web/desktop）退出码 0；`pnpm start:file` 生产态启动：electron 进程存活，`http://127.0.0.1:7310/api/health` → `200 {ok:true, sqlite:<毫秒时间戳>, port:7310}`。**已证**：electron 主进程内嵌 server 起在 7310 + `node:sqlite` 读写真通（health 200 含 sqlite 时间戳）。**未证**：file:// 窗口是否成功加载、hash 路由是否可达——归待目验（health 为测试者用 `Invoke-WebRequest` 直打，`run()` 中 createServer 先于 openWindow，窗口加载与之无关）
- 数据目录隔离实证：生产态 userData = `%APPDATA%\@sct\desktop`（未打包态取包名 `@sct/desktop`），`sct.db` 与 `tmp/` 生成其中，与 dev 的 `.sct/dev-data` 分离
- 端口递增 + D3b 自动化部分：带连接计数的占位进程占住 7310 → 内嵌 server 递增 **7311**（health `200 {ok:true, sqlite:<时间戳>, port:7311}`）；占位进程累计连接数**恒为 0**——自动化已证：7310 全程收到 0 个连接（与"页面未回落 7310"一致，但不等于已证渲染链路生效）
- **D10 分支可达（2026-09-28 已精确锁定）**：将 `server/dist` 改名 `server/dist.bak` 后原样运行（`pnpm start:file` 或 `electron . --load=file`）→ electron 弹 error 模态窗（进程级观测 `MainWindowTitle=Error`、未裸崩、未建主窗）。**2026-09-28 补证**：按 HWND 用 `PrintWindow` 抓取窗口位图，正文读出 **"加载本地服务失败 / 常见原因:server 构建产物缺失(dist/)或运行时模块加载失败。请运行: pnpm --filter @sct/server build 然后重新启动。Error [ERR_MODULE_NOT_FOUND]..."**——标题为 `加载本地服务失败`（D10 分支），**非**外层 catch 的 `启动失败`，**D10 分支已唯一锁定**（原先"两个 dialog title 均非 [Error]、无法精确区分"的悬念解除：原生 MessageBox 的窗体 caption 恒为 `Error`，业务标题是正文的大字标题）；点掉后进程退出（`app.exit(1)`）。`dist.bak` 恢复为 `dist` 后重跑 health 200、窗口标题复归 `@sct/desktop`——**还原已功能验证**
- 方法注记（**2026-09-26 OCR 修复后修订**）：desktop 主进程对 `@sct/server` **无静态类型依赖**（main.ts 经 `await import('@sct/server')` 加载——node16 模块设置下编译产物保留原生 `import()`；server 包 exports 仅指向 dist），实测 `server/dist` 缺失时 `pnpm start:file` 的 `tsc -p tsconfig.json` 前置**退出码 0**、不阻断 electron——即 **`pnpm start:file` 本身就是 D10 的有效复现命令**；`pnpm --filter @sct/desktop exec electron . --load=file`（已构建产物直启）为等价手段
- **目验状态（2026-09-28 全部确认，7/7）**：
  - dev 态（`pnpm dev`）：窗口渲染首页"后端 OK"、`#/settings` 可达、设置页两卡片正常、无黑色控制台窗（用户目验）。
  - 生产态 file://（CDP `Runtime.evaluate` / `PrintWindow` 客观证据）：①窗口渲染出 `音频库(骨架) / 后端 OK · SQLite 读写成功 · API 端口 7311`；②占住 7310 时 server 递增 7311、页面 URL 注入 `?apiPort=7311&apiToken=...`、`#/settings` 正文 `设置 / API 端口:7311 / 重新探测 / yt-dlp / ffmpeg`（D3b 最终判定：hash 保留 search 成立）；③D10 dialog 文案 `加载本地服务失败`+ 构建指引、点掉后进程退出（见上条）。
  - 补充 4 项（2026-09-28 CDP/PrintWindow 补验）：④无 query 打开 `index.html` → 默认 7310 → `后端 OK · SQLite 读写成功 · API 端口 7310`（ADR-2 缺省路径）；⑤指向死端口 `?apiPort=7999` → 首页 `无法连接本地服务(apiPort=7999)。请确认 server 进程已启动(pnpm dev:server)。`，设置页同 Alert + 两卡片"暂无数据 / 探测未成功"（非永久 loading）；⑥双开第二实例 143ms 内退出码 0、窗口数恒为 1（单实例锁）；⑦`dev:electron` 无 server 时 dialog 正文 `本地服务未启动 / 10 秒内未检测到本地 API 服务。请先运行: pnpm dev:server`。
  - **M0 待目验清零。**

**只手动验证**：窗口加载与双开拦截（✅ 2026-09-28 已验）、API 不可达 Alert（✅ 2026-09-28 已验）、file:// 路由可达（✅ 2026-09-28 已验）、双跑 `-k` 收割（✅ 2026-09-28 已验：杀 server 后 concurrently 输出 `--> Sending SIGTERM to other processes..`，web(8000) 与 electron 6s 内归零，`pnpm dev` 整体退出码 1，deferred ⑬ 闭环）。

**不测**：Electron 生命周期（太薄）、max dev 本身、AntD 组件（无逻辑）。

### 0.5 不在这一轮

- **electron-builder 打包与签名** —— PRD R5 推迟到 M3 后
- **自动更新** —— 依赖打包形态，更后
- **preload 实际 IPC** —— S3 才需要（D7）
- **多窗口** —— 单窗口足够，双开已被 D8 拦截
- **electron-serve 自定义协议** —— hash + `./` 失败时的备选（D3b），默认不引入
- **logger 模块** —— S1 用 console + showErrorBox 顶替，S2 随 jobs 引入
- **better-sqlite3 / @electron/rebuild** —— 已证伪排除（0.1 事实 2）；未来若需高级 SQLite 特性（如 FTS5 扩展加载）须重立 spike

### 0.6 与 PRD/其他 spec 的关系

- 实现范围 = PRD §6.1 S1 大纲全项；验收锚点 = PRD §6 M0 验收
- 建表范围 = PRD §4.1 全部五表（引用不抄写）；启动恢复与孤儿清理 = PRD §3.4；**入库契约（§3.5）S1 不实现，S2 生效时引用**
- S2-S6 的 spec 开工时引用本文件的 createServer 签名、启动序列、端口协调与 D9 驱动决定，不重复定义

### 0.7 评审与 spike 记录

**第 1 轮多透镜评审（2026-09-26）**：P0-1 双运行时 ABI 互斥 → 当时的方案 A（双副本）拍板；P1×5 + P2×8 采纳落点见旧版记录。

**Task 1 spike（2026-09-26，方案 A 证伪 → 方案 C 生效）**：

| 处置 | 项 | 说明 |
|---|---|---|
| 证伪 | 双副本（原 D9） | pnpm 12 别名去重 + electron-rebuild 别名匹配失效 + ABI 149 无预编译 + 无 MSVC，四重实证 |
| 生效 | 方案 C + C1（用户拍板） | node:sqlite 内置驱动；Node 22 侧 flag 注入；D9/D2/0.1/0.4 全部改写 |
| 保留 | probe:sqlite / probe:sqlite:node | 原 probe:abi 固化为驱动探针，升级 Electron 后复跑 |
| 关闭 | 方案 B（ELECTRON_RUN_AS_NODE 统一运行时） | node:sqlite 使其失去必要性 |
| 候选 | Node 升级 24 LTS 去 flag | 触发信号：flag 管道造成实际故障，或用户主动升级 |
