# Spec: 音频血缘 + 来源/成品信息架构（audio-lineage）

> 来源：2026-10-01 上一 session 讨论定稿；本 session 四个开放问题由用户逐条裁决（1 采纳 / 2 先 A 后 B / 3 指向来源 / 4 归一不做）
> 关系：**改既有链路**——`audio_items` 加一列、三条入库路径写它、剪辑室（`/studio`）归并键从 URL 字符串换成它
> 状态：**待用户过目** → 过目后进入 writing-plans

---

## 0.0 要解决的问题（dev 库实测证据）

这不是"设计上的隐忧"，是**现在就摆在剪辑室里的现象**。2026-10-01 对 dev 库 `sct.db` 实跑取数（命令见 §0.1 末）：

```
sources = 2      （id 12 单视频 / id 13 番剧单集）
videos  = 2      （import 12、13 各一份素材）
audios  = 8      ← 全部 source_type='edit'、source_url=''（空串）、collection_title=NULL
```

这 8 条是同一个视频剪出来的 8 个成品片段（文件名如 `第一次逛妖城…【AI全民制作人】 [00_08-00_34]-00000015.mp3`），但它们在库里**不带任何身份**：

1. **`source_url` 是空串**——因为导出路径（`server/src/media/ffmpeg-export.ts:57`）入库时写的是 `sourceUrl: ''`。剪辑路径（`server/src/media/clip-job.ts:83`）反而写了来源 URL，于是"同一件事的两条路径，一条留了线索一条没留"。
2. **`parent_id` 列存在但从未被写入**（`server/src/db/schema.ts:11`；`server/src/db/repo/audio-items.ts:27` 的 INSERT 里根本没有这一列）→ PRD FR-3.7 的血缘设计**零落地**。
3. 剪辑室按 `source_url` 归并（`web/src/pages/studio.tsx:226-248`），空串被判成"没有网址" → **8 条各自成一张孤儿卡**（key = `#item-<id>`）。

**用户实际看到的是**：剪辑室卡片墙上有 **2 张有封面但"0 条"的来源卡** + **8 张只有一行音频的碎卡**。想找"我从这个视频剪出来的东西"，得在 10 张卡里翻。这正是本 spec 要消掉的东西。

## 0.1 现状基线（2026-10-01 读码 + dev 库实核）

1. **三张表的连接现状**：`imported_sources`（来源，`id` 为 PK，`url` UNIQUE）→ `source_videos`（素材，`import_id` 即来源 id，一对一）→ `audio_items`（音频，**没有任何指向来源的列**，只有 `source_url` 字符串 + 未使用的 `parent_id`）。schema 见 `server/src/db/schema.ts:4-17 / 42-61`。
2. **三条入库路径**，目前都只带 `source_url`：
   - 下载音频：`server/src/ytdlp/ytdlp-routes.ts:148`（`finalizeDownload`，此处**已经能拿到 `payload.url`**，同文件的 `finalizeVideoDownload`（行 183）已在用 `importsRepo.getByUrl` 反查来源）
   - 剪辑：`server/src/media/clip-job.ts:78`（payload 里**有 `importId`**）
   - 导出：`server/src/media/ffmpeg-export.ts:55`（payload 里**有 `importId`**，却写 `sourceUrl: ''`）
3. **`ingestDownloadedFile` 是唯一入库口**（`server/src/ytdlp/ingest.ts:24`），新增列只需改这一处签名 + 三处调用。
4. **`/api/audio` 是剪辑室的数据源**（`server/src/ytdlp/ytdlp-routes.ts:837-839`）：`audioRepo.list()` 全字段 + 反查出的 `site`。
5. **删除来源不删音频**：`DELETE /api/imports/:id`（`ytdlp-routes.ts:661-684`）显式级联删素材、派生图、剪辑工程，**但不动 `audio_items`** → 删来源后音频会**悬空**，这是 PRD FR-3.7 要求的"源已删除"场景的真实触发路径。
6. **首页 `recent` 用 URL 关联**（`server/src/db/repo/home.ts:62`：`JOIN imported_sources s ON s.url = a.source_url`）且只取 `source_type='download'`；`editing` 用 `JOIN ... ON s.id = p.import_id`（行 34）。→ 首页**已经是**"按来源 id 归并"，剪辑室是唯一还用 URL 字符串的地方。
7. **同 URL 变体仍是两张来源卡**：`imported_sources.url` 是完整 URL + UNIQUE，B 站链接带追踪参数（dev 库 id 12 的 url 含 `?trackid=…&vd_source=…`）→ 同一视频从不同链接进来会落两行。**本条已知、本轮不修**（见 §0.6）。
8. **既有测试里有一条固化用例**：`server/src/media/home-routes.test.ts:122-134` 断言 `edit`/`recording`/无来源条目不进首页 `recent`——**本 spec 不得改坏它**（回归保护）。

**取数命令**（dev 库音频/来源/素材现状，终态实测）：

```powershell
node --experimental-sqlite -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("d:/Seed/sound-control-tool/.sct/dev-data/sct.db");console.log(db.prepare("select source_type,count(*) c from audio_items group by source_type").all());console.log(db.prepare("select count(*) c from imported_sources").all());'
```

## 0.2 决定（不可违反）

| # | 决定 | 理由 |
|---|---|---|
| D1 | `audio_items` **新增列 `source_import_id INTEGER`**，指向 `imported_sources.id`。**不加 REFERENCES、不加索引**（与 `source_videos.import_id` / `clip_projects.import_id` 同款：库没开外键，靠代码显式维护，见 `schema.ts:53-54` 注释）。 | 立血缘的最小改动；与既有三张表处理风格一致，不引入新机制。 |
| D2 | 用**幂等补列**（`ensureColumns(db, 'audio_items', [...])`，`schema.ts:99-102` 同款）落地，**不改 `SCHEMA_SQL` 里的建表语句之外的任何 CHECK 约束**。 | 老库（表已存在）靠 ALTER 才能拿到新列——这是本仓既有做法，`CREATE TABLE IF NOT EXISTS` 对老库不生效。 |
| D3 | **三条入库路径全部写它**：① 下载音频 → 用 `payload.url` 经 `importsRepo.getByUrl()` 反查出 id；② 剪辑 → 直接用 `payload.importId`；③ 导出 → 直接用 `payload.importId`。 | 血缘的价值在于"两条路径都写"——只写一条等于没写（这正是 `parent_id` 至今为空的教训）。 |
| D4 | **反查行为两条约定**：① 下载路径反查不到来源（理论不可达，parse 必先 upsert）→ **写 NULL + 一行 warn 日志**，**不阻断入库**；② 剪辑/导出路径**不做存在性检查，原样写 `payload.importId`**——若任务跑到一半来源被删，产物带上一个悬空 id 恰好是**如实**的（它会显示为"源已删除"，见 D8）。 | 入库是用户等了很久的产物，不能因为一个辅助字段查不到就整条失败（仓库既有语义：辅助信息失败不毁主流程）。 |
| D5 | **启动时做一次幂等回填**：`source_import_id IS NULL AND source_url 非空` → 按 `source_url` **精确等于** `imported_sources.url` 匹配。 | 否则"老的下载音频（有 url、无外键）"与"新导出的音频（有外键）"会**各建一张卡**（同一来源两张卡）——比现状更糟。回填让前端只需认外键一条口径。**注意回填只对 `source_url` 非空的行生效**：`source_url` 为空串的行（典型：导出产物）匹配不上任何来源、**救不回**，只能进「无来源」卡（见 D7）——所以这条"否则…"的收益仅覆盖"曾被下载、留有 URL"的那部分老行。写法与 `schema.ts:116-121` 的 D8 历史纠偏同款（幂等 UPDATE）。 |
| D6 | **剪辑室的归并键 = `source_import_id`**；`source_url` 退为纯展示字段（"原视频"链接用）。 | PRD FR-3.7 要求的正是"可反查"，字符串相等不构成血缘。 |
| D7 | **无来源（`source_import_id IS NULL`）收成一张「无来源」卡**，承载录制产物与历史遗留（含 dev 库那 8 条导出片段）。 | 上一 session 已裁决；不再是"每条一张碎卡"。 |
| D8 | **悬空（有 id 但来源行已删）单独成「源已删除」卡**（按 id 各自成卡，条上带「源已删除」标签）。 | PRD FR-3.7 原话"parent 悬空时列表中显示'源已删除'"。**不**并进「无来源」卡——那会把两个不同来源的产物糊在一起，且丢掉了 D6 的血缘语义。 |
| D9 | **来源卡内分「素材 / 成品」两组**：`source_type = 'edit'` → **成品**；其余（`download` / `recording`）→ **素材**。空组不渲染组标题。 | 上一 session 已裁决。口径选 `source_type` 而非标题后缀：`source_type` 是入库时定死的事实，标题是可变文本（可重命名）。 |
| D10 | **`parent_id` 保留原样：不写、不删、不迁移**。 | 上一 session 裁决（开放问题 3）。它留给未来的"从音频剪音频"（那时才有"源音频"这个对象）；现在没有这个对象，`parent_id` 指不动。 |
| D11 | **首页 `GET /api/home` 不动**（`recent` 继续按 URL 关联 `source_type='download'`）。 | 结果与"按外键关联"**等价**（回填后每种情况都命中同一行），却要动一条已被 8 个用例固化的 SQL。零收益、有回归风险——不做。 |
| D12 | **不顺手给导出产物补 `source_url`**（保持 `''`）。行内的"原视频"链接在来源卡内**回退用该卡的 `importRow.url`**。 | 外键已经表达了来源；再往 `source_url` 写一份等于两个事实源，将来必然漂移。 |
| D13 | **日志（仓库铁律）**：三条写入点各记一行（含解析出的 `source_import_id`）、回填记一行（**改了几行**）、前端分组结果记一行（几个来源卡 / 几张孤儿卡；**音频与来源两个请求都 settle 后才打**——否则来源先到时 `items` 还是 `[]`，会先打一行错的"源已删除 0 张、无来源 0 条"，而这行正是用户验收时要照抄核对的）。均走 `pushLog`，前端在日志抽屉可见。 | `d:\Seed\sound-control-tool\.trae\rules\electron-dev-must-log.md` 铁律；尤其是"回填改了几行"——不记就永远不知道迁移有没有生效。 |
| D14 | **不新增依赖、不动技术栈**（Electron + Fastify 5 + `node:sqlite` + UmiJS Max 4 + antd 5）。 | 全局约束。 |

## 0.3 接口契约

### `GET /api/audio`（既有端点，**只增字段**）

```jsonc
{
  "id": 15, "title": "第一次逛妖城… [00:08-00:34]",
  "source_type": "edit", "format": "mp3", "duration_sec": 26.0, "created_at": "2026-10-01 09:12:03",
  "source_url": "",              // 原样保留：导出路径写的空串；下载路径写的完整 URL
  "site": "bilibili",            // 不变（仍由 source_url 反查）
  "entry_index": null, "collection_title": null,
  "source_import_id": 12         // ★ 新增：指向 imported_sources.id；无来源 → null
}
```

- 前端 `AudioRow` 类型同步加 `source_import_id: number | null`（`web/src/api.ts:266-272`）。
- 其余端点（`/api/audio/:id/file`、`DELETE /api/audio/:id`、`/api/media/*`、`/api/projects/*`、`/api/home`、`/api/imports*`）**签名一律不变**。

## 0.4 数据与迁移

```sql
-- 补列（幂等，走 ensureColumns；老库 ALTER、新库建表已含）
ALTER TABLE audio_items ADD COLUMN source_import_id INTEGER;

-- 回填（幂等，initSchema 内执行一次；D5）
UPDATE audio_items
   SET source_import_id = (SELECT id FROM imported_sources WHERE url = audio_items.source_url)
 WHERE source_import_id IS NULL
   AND source_url IS NOT NULL
   AND source_url <> '';
```

- 回填**只认精确 URL 相等**，不做任何规整（§0.6 第 1 条）。
- 回填是**幂等**的：已写过的行不再命中 `IS NULL` 条件；跑几次结果一样。
- 回填后仍有 NULL 的行 = 录制产物 + 历史遗留（`source_url` 为空串，dev 库那 8 条就在此列）+ 来源早已被删的老行 → 全部进「无来源」卡。
- 回填后残留的 `NULL` 分**两类**，都进「无来源」卡：(i) `source_import_id IS NULL` 且 `source_url` 为空串 / NULL（录制 + 历史遗留）；(ii) `source_url` **非空**但**精确匹配不上**任何来源（URL 变体、来源被删后重建）。第二类是可诊断的异常信号，其数量现在由回填日志的"仍有 N 行 source_url 非空但查不到来源"单独暴露出来（`schema.ts` 的 D5 回填末尾）。
- **`source_videos` / `imported_sources` / `clip_projects` 一行都不动**。

## 0.5 UI 规格（剪辑室 `/studio`）

### 卡片墙（`WorkCard`）

- 归并口径换成外键后，卡片集合 = **有来源的卡**（来源行在）+ **「源已删除」卡**（悬空 id 各一张）+ **一张「无来源」卡**（如非空）。
- 卡片计数行（`workCountText`，`studio.tsx:57-61`）改为按组计：`成品 N 条`，`素材 M 条`（M=0 时省略）。原有的「已下 N 集 / 共 M 集」`importRow` 口径**保留给来源卡**（来源卡上仍显示集数信息）；「源已删除」卡与「无来源」卡只显示条数。
- 「源已删除」卡：无封面（沿用 `WorkCard` 的 `onError` 纯色底兜底）、平台 logo 用该组首条的 `site`、卡片上打 `源已删除` 标签；点击仍可进入（能听、能删）。
- 「无来源」卡：标题取**该组首条** `mainTitle(it)` **去掉尾部 ` [mm:ss-mm:ss]` 后缀**（该后缀由服务端强制拼，`formatClipTitle`，`clip-job.ts:29-31`）；去掉后为空则用「无来源」。平台 logo：若组内 `site` 唯一则用该 site，否则不画 logo。

### 来源详情（进入某张卡后）

- 行列表按 **素材 / 成品** 两组渲染（D9），组标题形如 `素材 3` / `成品 8`；**空组不渲染**。
- **分页保持现状**（一处 `Pagination` 对卡内全部行分页，`studio.tsx:405-413` 不改），页内先按组划分再渲染 → 某页只含一种组时只出现该组标题。组内顺序沿用服务端返回的 `created_at DESC`。
- 搜索、删除二次确认（`Modal.confirm` + `okType:'danger'`）、播放器、行内"原视频"链接**行为一律不变**；仅"原视频"链接在 `source_url` 为空时**回退显示该卡的来源 URL**（D12）。
- 来源零行的空态文案改为「该来源还没有音频；到剪辑详情导出成品」+ 按钮进 `/studio/:importId`（现在是「这个来源还没有下载音频」，与"音频只从剪辑来"的现状不符）。

### 平铺视图（`Segmented` 的「平铺」）

**不改**。它本就是"所有音频按时间平铺"，与分组无关。

## 0.6 不做（YAGNI）与 backlog 触发条件

| 不做的事 | 触发条件（写进 backlog，不是现在） |
|---|---|
| 按平台 id 归一 URL（B 站 BV 号 / 剥追踪参数） | 真出现「同一作品两张来源卡」≥1 次 |
| 血缘反向查询 UI（"这个成品来自哪一段剪辑"） | 用户提出要看"这段是从第几分钟剪的" |
| 把 `home.recent` 也换成外键关联 | 归属 URL 归一那件事一起做（现在等价，无收益） |
| 给 `parent_id` 填值（音频剪音频） | 出现"从已入库的音频再剪一段"的需求 |
| 跨来源合并（同一作品的多条来源合成一张卡） | 同"平台 id 归一" |
| 来源卡内"素材"组改为展示视频素材本体（而非原始音频） | 用户反馈"素材"这个组名看不懂或想看视频 |

## 0.7 验收清单

1. 老库（含 dev 库）启动后 `PRAGMA table_info(audio_items)` 出现 `source_import_id`；`initSchema` 跑两次结果一致（幂等）。
2. 老库中一条 `source_url` 能匹配上来源的下载音频，启动后 `source_import_id` 被填上（回填生效）；匹配不上的行仍为 NULL。
3. 新下载一条音频 → 该行 `source_import_id` = 该 URL 对应的来源 id。
4. 新剪辑一条音频 → 同上。
5. 新导出一条音频 → `source_import_id` = 该来源 id（**不再是 NULL**）。
6. `GET /api/audio` 每条都带 `source_import_id` 字段（有值或 null）。
7. 剪辑室卡片墙：dev 库那 8 条导出片段**只出现 1 张「无来源」卡**（标题为去掉时间码后缀的公共前缀），不再是 8 张碎卡。
8. 删掉一个来源后，其成品在新的一张「源已删除」卡里（不是并进「无来源」），条上带标签。
9. 进入有来源的卡：素材/成品两组标题与条数正确；空组不显示。
10. `server/src/media/home-routes.test.ts` 全绿（首页口径未被改坏）；全仓 `pnpm typecheck` 三包 0 错、`pnpm --filter @sct/server test` 全绿、`pnpm --filter @sct/web build` 成功。
11. 日志抽屉里能看到：三条入库路径的写入日志（含 id）、回填行数日志、前端分组结果日志。

**dev 库的预期观察（目验时会看到什么，免得误判成失败）**：dev 库当前 `sources = 2`、`videos = 2`、`audios = 8`（全部 `source_type='edit'`、`source_url=''`，见 §0.0）。启动后进剪辑室应看到—

- 卡片墙上 **2 张来源卡**（id 12、13），且两张都显示 **"素材 0 条 · 成品 0 条"**——那 8 条导出成品没有外键，不会挂到来源卡上；
- **1 张「无来源」卡**，收着那 8 条导出成品（标题取公共前缀、去掉 ` [mm:ss-mm:ss]` 后缀）；
- 想**当场看到「素材 / 成品」两组**，需先给某个来源**新导出一条成品**：只有新产物才会带 `source_import_id` 外键；老产物 `source_url` 为空串、回填救不回（§0.4）。看到"两组为空"是预期结果，不是失败。

## 0.8 全局约束（沿用，不在本 spec 重开讨论）

- **提交授权制**：子代理不 commit，由用户按逻辑块自行提交。
- **每份 spec 走完整流程**：spec → 用户过目 → `writing-plans` → `subagent-driven-development`（逐任务 + 独立审查 + 台账）。
- **技术栈既定、不引入新依赖**（Electron + Fastify 5 + `node:sqlite`（脚本需 `--experimental-sqlite`）+ UmiJS Max 4 + antd 5）。
- **首页"最近下载"排除 `source_type='edit'`**（固化用例 `home-routes.test.ts:123`）。
- **"零 schema 迁移"只约束下载队列切片**；本 spec **明确要加列**，不受该约束。
- **删除类操作必须二次确认**（`Modal.confirm` + `okType:'danger'`）——本 spec 不改删除交互，但回归时不得改坏。
- **危险操作/删除的文件 IO 语义**：删磁盘文件失败不让接口失败（本 spec 不改删除链路）。

## 0.9 落地后必须回扫的文档（用户全局规则：一件事落地后回头扫一遍所有声明它的地方）

| 位置 | 要改什么 |
|---|---|
| `server/src/db/schema.ts:11` 附近 | `parent_id` 的注释仍暗示"剪辑血缘"；落地后应指向本 spec |
| `web/src/pages/studio.tsx:223-225` 的注释 | "刻意按来源网址聚合…代价是同一作品被两种网址变体下载过会分成两张卡"——归并键已换，注释必须重写 |
| `docs/superpowers/specs/m2-workspace.md:38`（事实 6） | "`parent_id` 有列但从未被写入…FR-3.7 血缘设计尚未落地" → 落地后改 |
| `docs/superpowers/specs/m2-workspace.md:299`（backlog B4） | "`parent_id` 血缘落地" 已达触发条件（"需要从剪辑产物反查源音频时"）→ 标为已落地，并记录与 `parent_id` 方案的分歧 |
| `docs/prds/音频录制与剪辑-PRD初始篇.md:80`（FR-3.7）与 `:195` | 血缘列名与指向对象已变（`source_import_id → imported_sources.id`），PRD 需注记 |
| `server/src/db/repo/home.ts:45-46` 的注释 | 仍写"audio_items 没有 import_id 列" → 落地后该句不再成立（虽然 SQL 刻意不改，注释必须说明为什么） |
| `docs/superpowers/specs/2026-09-30-download-queue-tray.md` 等交接词 | 交接词「遗留裁决与留观项」中凡提到血缘/归并键的条目 |
