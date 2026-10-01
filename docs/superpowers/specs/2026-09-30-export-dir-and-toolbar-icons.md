# Spec: 导出目录可配置 + 工具栏图标化（export-dir-toolbar）

> 来源：2026-09-30 用户口述（原文见 §0.0）｜方案与用户确认（同日，"先写成spec"；同日追补一条：导出成功的提示里要有「打开导出目录」入口，**行内绿条方案**）
> 依赖：m2 剩余阶段（已落地，未提交）——`/api/projects/:id/export`、剪辑详情页工具栏、设置页
> 关系：本切片是 M2 收口后的**体验补丁**，不改任何既有接口语义，只新增一个生效点与几个入口
> 状态：**待用户过目** → 过目后进入 writing-plans

---

## 0.0 为什么

用户 2026-09-30 原话（按原文分点，不改写）：

> 设置里面可以设置导出目录，然后在，工具栏上添加打开导出文件所在目录的按钮，工具栏上所有的按钮都用icon替代，然后使用 [pick-ui-library] 制作点击后loading的加载状态

> （追补）导出成功的弹窗中，要有显示打开导出目录，点击就打开导出目录

**真痛点（本次真实触发）**：用户导出完 3 段音频后问「导出在哪里，没看到导出的文件」。根因不是 bug——导出**确实成功**了（日志 `export job 18 done mode=separate → 3 条音频`），产物落在应用数据目录 `<数据目录>/audio/` 里。问题是：

1. 这个目录**藏在应用的私有数据目录**里，用户在自己的文件系统里找不到；
2. 界面上**没有"打开所在目录"的入口**，也没有"导出到哪"的设置；
3. 工具栏是 5 个中文文字按钮，占宽度且视觉杂。

## 0.1 现状基线（2026-09-30 实核，读码 + 实测）

1. **`output_dir` 设置键早已定义、但全仓零使用**：`server/src/settings-keys.ts:2` 有 `outputDir: 'output_dir'`，全仓 grep 只命中该定义与 M0 计划文档——**从来没有代码读写它**。
2. **设置接口已就位且天生支持它**：`GET/PUT /api/settings`（`server/src/http/settings-routes.ts`）；PUT 的白名单正是 `new Set(Object.values(SETTINGS_KEYS))` → **`output_dir` 自动可写，不必改白名单**；既有约束：未知键 400、值必须是字符串。`registerSettingsRoutes(app, db)` 有两个调用点：`server/src/index.ts:54`（生产）与 `server/src/ytdlp/ytdlp-routes.test.ts:66`（测试）。
3. **导出产物今天落在 `audioDir`**：`server/src/media/ffmpeg-export.ts` 里 `ingest(...)` 传 `audioDir: deps.audioDir`；而 `audioDir = path.join(path.dirname(dbPath), 'audio')`（`index.ts:67`），dev 下即 `.sct/dev-data/audio/`。
4. **落盘用 `renameSync`**：`server/src/ytdlp/ingest.ts:22-30` = `resolveUniquePath(audioDir, slug-id8.ext)` → `renameSync(tmpPath, finalPath)`；失败则**删掉已 INSERT 的 DB 行并抛出**。→ 目标目录与临时目录**不同卷**时，Windows 必抛 `EXDEV`，导出直接失败。
5. **桌面壳的 preload 是空的**：`desktop/src/preload.ts` 目前只有 `export {}`（规格 D7 的"S1 无任何 IPC"）。`webPreferences = { preload: <__dirname>/preload.js, contextIsolation: true }`（`desktop/src/main.ts:94-98`）；`desktop/tsconfig.build.json` 只排除 `*.test.ts` → **`preload.ts` 已在构建产物里**，往里加内容即可被加载。`main.ts` 已经 `import { app, BrowserWindow, dialog, shell } from 'electron'`。
6. **剪辑详情页工具栏是 5 个文字按钮**：保存 / 导出 / 在当前播放头打点 / 清空所有剪辑点 / 返回剪辑室（`web/src/pages/studio-detail.tsx:304-313`）。`@ant-design/icons` 已是既有依赖（`studio.tsx`、`layouts/index.tsx` 都在用）。
7. **导出结果今天用行内 `Alert` 呈现**（不是弹窗）：`studio-detail.tsx:417-425` —— `{exporting && <Progress/>}`、`saveMsg`/`exportMsg` 两个 `Alert`。导出进度/终态链路已完整（`subscribeJob` 的 `progress`/`done`/`status` + `exporting` state），导出按钮**已经**带 `loading={exporting}`。

## 0.2 决定（不可违反）

| # | 决定 | 理由 |
|---|---|---|
| D1 | **导出目录直接决定导出产物的落盘位置**（不是"原处存一份、再复制一份"）：`audio_items.file_path` 就指向该目录，剪辑室照旧能试听/删除。 | 不产生重复文件；"设置导出目录"最自然的解释。附带好处：删除音频时按 `file_path` 删，天然正确，无需额外联动。 |
| D2 | **复用既有 `output_dir` 键**，不新建键；**留空 = 与今天完全一致**（`<数据目录>/audio/`）。 | 键已在白名单里 → 零接口改造；向后兼容，老用户升级后行为不变。 |
| D3 | **只对导出 job（`ffmpeg_export`）生效**。下载（`ytdlp_*`）与剪辑（`ffmpeg_clip`，UI 已休眠）仍写 `audioDir`。 | 用户要的就是"**导出**目录"；不扩大改动面。 |
| D4 | **`output_dir` 必须是绝对路径**；非空且相对 → 400 拒绝。 | 相对路径会按服务端 cwd 解析，位置随启动方式漂移，用户不可能预期。 |
| D5 | **保存设置时就校验**：非空时 `mkdirSync(recursive)` + 试写一个临时文件再删；失败 → 400 + `error.next` 写清怎么办。**校验通过才落库**。 | 评审盲点：不能让用户等到点"导出"那一刻才发现目录不可写——那是最不该失败的地方（何况导出还要跑 ffmpeg）。 |
| D6 | **跨盘兜底**：`rename` 抛 `EXDEV` 时退化为 `copyFileSync(tmp, dest)` + `unlinkSync(tmp)`；**其它错误保持原样**（删 DB 行 + 抛出）。 | §0.1 事实 4：Windows 不同卷不能 rename；不修则"导出目录设到别的盘"必然失败。其它错误（占用/权限）仍应让用户看见并保持原有回滚语义。 |
| D7 | 「打开导出目录」用 **Electron `shell.openPath`**，经**最小 IPC**：preload 用 `contextBridge` 暴露 `sct.revealPath(p)` 与 `sct.pickDirectory()`；main 里 `ipcMain.handle` 两个通道（`sct:reveal-path` / `sct:pick-directory`）。 | "打开文件夹"是 shell/UI 关注点，归桌面壳；main 已 import `shell`/`dialog`。`revealPath` 在**主进程侧**校验"存在且是目录"，不允许把任意字符串丢给系统。 |
| D8 | **非 Electron 环境降级**：`window.sct` 不存在（浏览器直连模式）→ 「打开导出目录」与「浏览…」**禁用 + Tooltip**「仅桌面应用内可用」。 | 该模式没有 shell；静默无反应比禁用更糟（用户会以为坏了）。 |
| D9 | 工具栏按钮**全部换纯图标**，且**每个都挂 `Tooltip`**（中文）。 | 没了文字，图标含义必须可查；禁用态说明本来就依赖 Tooltip（见仓库既有 D17 做法）。 |
| D10 | 点击后的 loading 一律用 **antd `Button` 的 `loading`**，**不引入任何新依赖**。 | `pick-ui-library` 的策展清单**不覆盖"loading 态"**这件事（最接近的 base-ui 是无样式组件原语、Sonner 是 toast，都不是它）；antd 已就位，`loading` 自带"转圈 + 自动禁用"防连点。 |
| D11 | **单一解析点** `resolveOutputDir(db, fallbackDir)`（新文件 `server/src/output-dir.ts`）：返回 `output_dir` 非空 ? 该值 : fallback。设置路由与导出 job **都调它**，不在两处各写一份公式。`GET /api/settings` 用它算出**计算字段** `output_dir_resolved` 一并返回；PUT 不接受该键（不在白名单，天然 400）。 | 前端要显示"留空时默认存到哪"、工具栏与成功绿条都要知道打开哪个目录；而前端**不知道数据目录**，不能自己拼。单一来源也避免"两处公式漂移"（同族：P4-T7-7 的 SQL 去重）。 |
| D12 | 新链路留日志（仓库铁律）：设置保存（含校验失败原因）、导出 job 的目标目录、打开目录的成功/失败。 | `.trae/rules/electron-dev-must-log.md`。 |
| D13 | **导出成功保留行内绿条（`Alert` success），并在绿条里加一个「打开导出目录」按钮**（antd `Alert` 的 `action` 插槽）。绿条文案 = `已导出 N 段`（用 SSE `done` 事件已有的 `count`）+ **目标目录绝对路径** + 一句"文件已同时登记到剪辑室"。**不做成功弹窗**——不打断操作流（用户常连着导好几段），可反复导出。导出失败仍用同一条 `Alert` 的 **error** 态（失败要能持久看原因）。 | 用户要的是"成功提示里能直接打开目录"；行内绿条不打断、改动面最小（今天已经是 `Alert`，只加一个 `action` 按钮），且与 §0.5 的失败态同处一条组件、语义统一。 |

## 0.3 接口契约

### 设置（`server/src/http/settings-routes.ts`）

签名变更：`registerSettingsRoutes(app, db)` → `registerSettingsRoutes(app, db, defaultOutputDir: string)`
（`defaultOutputDir` = `<数据目录>/audio` 的绝对路径；`index.ts` 与 `ytdlp-routes.test.ts` 两个调用点同步更新。）

- `GET /api/settings` → 既有白名单键 + `output_dir_resolved: string`（绝对路径，见 D11）
- `PUT /api/settings` body `{ output_dir?: string, ...其它既有键 }`
  - 既有约束不变：未知键 400、值非字符串 400
  - `output_dir` 非空且**非绝对路径** → 400 `{ ok:false, error:{ code:'BAD_REQUEST', message:'导出目录必须是绝对路径', next:'例如 D:\\Music\\sct' } }`
  - `output_dir` 非空且建目录/试写失败 → 400 `{ ok:false, error:{ code:'BAD_REQUEST', message:'导出目录不可写：<原因>', next:'换一个可写目录，或留空用默认目录' } }`
  - 成功 → `{ ok: true }`（形状不变）
  - **先校验、后写库**：校验失败不得把值落库（否则下次启动会拿着一个坏路径）

### 桌面壳 IPC（`desktop/src/preload.ts` + `desktop/src/main.ts`）

```ts
// preload 暴露（contextBridge.exposeInMainWorld('sct', ...)）
window.sct.revealPath(absolutePath: string): Promise<{ ok: boolean; message?: string }>
window.sct.pickDirectory(): Promise<string | null>   // 取消 → null
```

- `sct:reveal-path`：主进程先 `statSync(p).isDirectory()` 校验；不存在/非目录 → `{ ok:false, message:'目录不存在或不是文件夹' }`；否则 `shell.openPath(p)` → 返回空串 = 成功，非空串 = 失败（把该串作为 `message` 带回）
- `sct:pick-directory`：`dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })`；取消/无选中 → `null`；否则回单选路径
- 两端都用 `try/catch` 兜底，异常 → `logFe`/`console.error` 并返回失败对象（不把异常原样抛给渲染进程）

### 前端封装

- `web/src/api.ts` 增：`getSettings(): Promise<Record<string, string>>`、`putSettings(patch: Record<string, string>): Promise<{ ok: boolean }>`（复用 `apiGet` / `apiPut`）
- 新增 `web/src/desktop.ts`：**唯一**读 `window.sct` 的地方
  ```ts
  export function hasDesktopBridge(): boolean
  export function revealPath(p: string): Promise<{ ok: boolean; message?: string }>
  export function pickDirectory(): Promise<string | null>
  ```
  并在该文件里声明 `declare global { interface Window { sct?: SctBridge } }` 类型（不再散落 `any`）
- 新增 `web/src/export-dir.ts`：**唯一**的「打开导出目录」动作，工具栏按钮与成功绿条里的按钮**共用**它
  ```ts
  export async function openExportDir(): Promise<{ ok: boolean; dir: string; message?: string }>
  // 内部：GET /api/settings → output_dir_resolved → revealPath(dir)
  // 无 Electron 桥 → { ok:false, message:'仅桌面应用内可用' }
  ```

## 0.4 数据流

1. **设置页**：`GET /api/settings` → 输入框回填 `output_dir`；输入框下给一行说明「留空 = 默认：`<output_dir_resolved>`」；「浏览…」→ `pickDirectory()` → 回填输入框（**不自动保存**，用户点「保存」才落库）；「保存」→ `PUT` → 成功后重新 `GET` 刷新 `output_dir_resolved`。
2. **导出**：`POST /api/projects/:id/export` → job 的 `payload` **不变**（仍只存素材绝对路径、段、模式等）；**目标目录由 `startExportJob` 每次运行时现读设置**（`resolveOutputDir(db, deps.audioDir)`）。
   - 为什么把目录放在"运行时读"而不是塞进 payload：payload 是**重试用**的；用户改了目录再重试，应该用新目录（放进 payload 会把旧目录钉死在任务里）。
   - **运行时自愈**：目标目录不存在时先 `mkdirSync(recursive)` 再落盘——用户手动把文件夹删了，不必回设置页改一遍；删不掉（如盘符已拔）→ 走 §0.5 的失败提示。
3. **打开导出目录（工具栏 📂）**：`openExportDir()` → 取 `output_dir_resolved` → `revealPath(dir)`；失败 → `message.error` + `logFe`。
4. **导出成功绿条（D13）**：SSE `done` / `status{done}` 到达 → 关闭进度条，把 `exportMsg` 置为成功文案：`已导出 N 段` + **目标目录绝对路径**（`output_dir_resolved`）+ "文件已同时登记到剪辑室"；绿条右侧渲染「打开导出目录」按钮（`Alert` 的 `action`），点击调 `openExportDir()`（无 Electron 桥时**禁用 + Tooltip**，与 D8 一致）。

## 0.5 错误处理

| 场景 | 行为 |
|---|---|
| 导出时目标目录不可写/被删 | 导出 job `fail()`，文案含**目标目录**与原因 → 绿条转 **error** 态可见（既有 job error 链路） |
| 设置里填了不可写目录 | PUT 当场 400 + `next` 指引（D5）；**不落库** |
| 填了相对路径 | PUT 400（D4） |
| 「打开目录」目标不存在/被删 | `{ ok:false, message }` → 前端 `message.error` + `logFe`（不静默）；从绿条里那颗按钮点也一样 |
| 浏览器直连模式 | 按钮禁用 + Tooltip「仅桌面应用内可用」（D8）；绿条里那颗按钮同样禁用 |
| 跨盘 rename | EXDEV → 复制 + 删源（D6）；其它错误保持原回滚语义 |

## 0.6 测试边界

**vitest（server）**

- `PUT /api/settings` `output_dir` 为相对路径（如 `'exports'`）→ **400**，且库里没落该值（D4）
- `PUT` 合法绝对路径（用测试临时目录）→ 200；随后 `GET` 的 `output_dir_resolved === 该路径`（D11）
- `PUT` 不可写目录 → **400 且未落库**；构造方式：把一个**已存在的文件**路径当目录传进去（`mkdirSync` 必失败）
- `GET /api/settings` **未配置** `output_dir` 时 `output_dir_resolved` === 传入的 `defaultOutputDir`（绝对路径）
- 导出到自定义目录：设置 `output_dir = <temp>/my-exports` → 跑 `startExportJob` → 断言 `audio_items.file_path` 的 `dirname` === 该目录，且该文件存在、`source_type === 'edit'`（D1/D3）
- `resolveOutputDir` 单测：空串/未设 → fallback；非空 → 原值（D11 单一来源）
- 跨盘兜底（D6）：注入一个 `rename` 抛 `EXDEV` 的桩 → 断言走 `copyFile` 分支后**目标文件存在**、DB `file_path` 正确、临时文件已清理；再补一例：`rename` 抛**非 EXDEV** 错误 → 保持原语义（DB 行被删 + 抛出）

**手工目验**

- 设置页填 `D:\sct-exports` → 保存 → 进剪辑详情页 → 导出 → **文件出现在 `D:\sct-exports`**，且剪辑室能看到/试听
- 把设置**清空**保存 → 导出 → 文件回到 `<数据目录>/audio`（行为与今天一致）
- **导出成功后绿条出现**：文案写明段数与目标目录，右侧有「打开导出目录」按钮；点它 → 资源管理器打开到该目录，且绿条不消失（可再点）
- 工具栏 `📂` → 资源管理器打开到该目录；把目录删掉再点 → 有失败提示（不是静默）
- 5 个图标按钮**悬停都有中文提示**；保存 / 导出 / 打开目录点击后**都有 loading**
- 浏览器直连模式（带 `?apiPort=` 直开页面）→ 📂、「浏览…」、以及**绿条里的那颗按钮**都禁用 + 提示

## 0.7 验收锚点

1. **[自]** 三包 `typecheck` 0 错 + `pnpm --filter @sct/server test` 全绿 + `pnpm --filter @sct/web build` 成功
2. **[人]** 设了导出目录后，导出产物确实落在该目录，且**剪辑室照样能看到、能试听**（D1 的关键推论）
3. **[人]** 留空时，行为与改造前**完全一致**（D2 的向后兼容）
4. **[人]** 工具栏按钮全是图标、悬停有中文提示、点击有 loading（D9/D10）
5. **[人]** 「打开导出目录」能打开到正确目录；失败有可见提示（D7/D8）
6. **[人]** **导出成功绿条**写明段数与目标目录，且绿条里的「打开导出目录」真能打开（D13）
7. **[人]** 应用界面文案无新增错别字；无与导航 Tab 重名的标题

## 0.8 YAGNI（本轮不做）

- 不做「导出时弹保存对话框、每次现选目录」——那是另一套语义（每次问一次），与"设置里固定一个目录"互斥
- 不做导出历史 / 最近用过的目录下拉
- 不做按来源/按日期分子目录
- 不做"改目录后把旧文件搬过去"（老产物留在原处，`file_path` 是绝对路径，天然正确）
- 不做导出成功弹窗（D13 明确选行内绿条）；也不做"导出完成后自动打开目录"（只在绿条里给按钮，不替用户做主）
- 不引入任何新前端依赖（D10）

## 0.9 回滚

只新增一个设置项的**生效点**、一条 IPC 通道、若干按钮样式/图标，以及绿条里的一个按钮。`output_dir` 留空即回到现状；IPC 通道未被调用时零副作用；去掉绿条里那颗按钮即回到今天的样子（一处局部改动）。

## 0.10 影响面（文件级）

| 文件 | 改动 |
|---|---|
| `server/src/output-dir.ts` | **新建**：`resolveOutputDir(db, fallbackDir)`（D11 单一解析点） |
| `server/src/http/settings-routes.ts` | 签名加 `defaultOutputDir`；GET 回 `output_dir_resolved`；PUT 加绝对路径校验（D4）+ 可写校验（D5）+ 日志 |
| `server/src/media/ffmpeg-export.ts` | 目标目录改 `resolveOutputDir(db, deps.audioDir)` 现读（D1/D3）+ 运行时 `mkdirSync` 自愈 + 日志 |
| `server/src/ytdlp/ingest.ts` | `renameSync` 外包 EXDEV 兜底（D6） |
| `server/src/index.ts` | `registerSettingsRoutes` 调用点补 `defaultOutputDir`（≈把 `audioDir` 的计算提前） |
| `desktop/src/preload.ts` | 从 `export {}` 改为 `contextBridge` 暴露 `sct`（D7） |
| `desktop/src/main.ts` | 两个 `ipcMain.handle`（D7） |
| `web/src/api.ts` | `getSettings` / `putSettings` |
| `web/src/desktop.ts` | **新建**：桥接封装 + 全局类型（D8） |
| `web/src/export-dir.ts` | **新建**：`openExportDir()` 共用动作（工具栏与成功绿条都用它） |
| `web/src/pages/settings.tsx` | 新增「导出目录」卡片（输入框 + 浏览… + 保存，均带 loading） |
| `web/src/pages/studio-detail.tsx` | 工具栏 5 个图标按钮 + Tooltip + loading + 新增「打开导出目录」；**导出成功绿条的 `action` 里加「打开导出目录」按钮（D13）** |
| 测试 | `server/src/output-dir.test.ts`（新）、`server/src/http/settings-routes.test.ts`（若无则建）、`server/src/media/ffmpeg-export.test.ts`（追加）、`server/src/ytdlp/ingest.test.ts`（追加）、`server/src/ytdlp/ytdlp-routes.test.ts`（调用点同步） |

## 0.11 与既有决定的相容性检查

- **不影响 D8（剪辑产物 `source_type='edit'`）**：导出仍走 `ingestDownloadedFile({ sourceType:'edit' })`，产物仍不进首页「最近下载」。仅落盘目录可变。
- **不影响 D15（导出以请求体为准）**：段仍来自请求体；目录是**服务端设置**，与"哪几段"无关。
- **不影响 D14（派生图固定尺寸 + 原子落盘）**：派生图仍落 `<数据目录>/derived/`，与导出目录无关（它是缓存，不是用户产物）。
- **D19（换集清工程）/D17（无素材空态）**：与本切片零交集。
- **C-2（导出 SSE 终态）**：`done` 事件带 `count`（Ruling P4-2）——D13 的绿条文案正好用它显示"已导出 N 段"，不改协议。
