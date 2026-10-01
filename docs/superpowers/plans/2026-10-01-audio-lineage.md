# 音频血缘 + 来源/成品信息架构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现；**禁止 commit**（见 Global Constraints）。

**Goal:** 给 `audio_items` 补上"这条音频是从哪个来源剪出来的"这件事（新增 `source_import_id`，三条入库路径全写），并把剪辑室的归并键从 URL 字符串换成它——让同一个视频剪出的 N 个成品回到同一张卡里，卡内再分「素材 / 成品」。

**Architecture:** 服务端加一列 + 一次幂等回填，`ingestDownloadedFile` 透传新字段，三条入库路径（下载/剪辑/导出）各自把来源 id 写进去；`GET /api/audio` 顺带多回一个字段（repo 泛化即得）。前端剪辑室把 `works` 的分组键从 `source_url` 换成 `source_import_id`，并新增两张虚拟卡（「源已删除」「无来源」）。

**Tech Stack:** Fastify 5 + node:sqlite（server，脚本需 `--experimental-sqlite`）｜UmiJS Max 4 + antd 5（web）

**Spec:** `docs/superpowers/specs/2026-10-01-audio-lineage.md`（决定 D1–D14；本计划是它的实施论证）

## Global Constraints

- **禁止 commit**：提交授权制——子代理一律不 commit。每个任务最后一步是「停在此处」。
- **每任务第一步：Read 目标文件的磁盘实况**（不信记忆、不信本计划的行号——行号只是导航）。每次编辑后**读回核对**；同一文件**禁止并行** `SearchReplace`。
- **不引入任何新依赖**；不改 `tsconfig`；不改技术栈。
- `pushLog(level, source, message)` 的 **source 只能用 `server/src/logs.ts:15` 联合类型里的既有值**（本计划用 `'server'` / `'job'` / `'clip'`）；level 只有 `'debug' | 'info' | 'error'`。
- **不加外键约束、不加索引**（库没开外键，本仓一贯靠代码显式维护）。
- **`parent_id` 不写、不删、不迁移**（D10）。
- **不改首页 `GET /api/home`**（D11）；**不改 `source_url` 的写入值**（导出仍写 `''`，D12）。
- **不得改坏**：`server/src/media/home-routes.test.ts:122-134`（首页排除 edit/recording/无来源）、`server/src/db/schema.test.ts` 现有 4 例（D8 历史纠偏）。
- **删除类交互不改**（`Modal.confirm` + `okType:'danger'` 原样保留）。
- 验证基线（实测于 2026-10-01）：`pnpm typecheck` 三包 0 错；`pnpm --filter @sct/server test` **42 文件 / 399 用例**全绿；`pnpm --filter @sct/web build` 成功。
- 中文注释，说明「为什么」；失败路径要有日志，**不得静默 catch**。
- **web 包没有测试设施**（`web/src/**/*.test.*` 零文件）→ 前端任务用 `pnpm typecheck` + `pnpm --filter @sct/web build` + **人工目验清单**作为验收证据，不新建测试框架（不在本 spec 范围内）。

---

## Task 1: 服务端 · 加列 + 幂等回填 + repo/ingest 贯通

**Files:**
- Modify: `server/src/db/schema.ts`（建表语句加列 / `ensureColumns` / `initSchema` 末尾加回填）
- Modify: `server/src/db/repo/audio-items.ts`（`AudioItemRow` / `AudioItemCreate` / INSERT / 两个 SELECT / `normalize`）
- Modify: `server/src/ytdlp/ingest.ts`（入参加 `sourceImportId`）
- Test: `server/src/db/schema.test.ts`（回填 4 例）、`server/src/db/repo/audio-items.test.ts`（字段回读 1 例）、`server/src/ytdlp/ingest.test.ts`（透传 1 例）

**Interfaces:**
- Produces:
  ```ts
  // server/src/ytdlp/ingest.ts —— 新增可选入参（缺省 null，老调用不受影响）
  ingestDownloadedFile(opts: { /* 既有参数不变 */ sourceImportId?: number | null }): { audioId: number; finalPath: string };
  // server/src/db/repo/audio-items.ts —— 两个接口各加一个字段
  interface AudioItemRow { /* … */ source_import_id: number | null }
  interface AudioItemCreate { /* … */ source_import_id?: number | null }
  ```
- 数据库：`audio_items.source_import_id INTEGER`（可为 NULL）

- [ ] **Step 1: 读磁盘实况**

Read `server/src/db/schema.ts` 全文、`server/src/db/repo/audio-items.ts` 全文、`server/src/ytdlp/ingest.ts` 全文、`server/src/db/schema.test.ts` 全文、`server/src/db/repo/audio-items.test.ts:1-45`、`server/src/ytdlp/ingest.test.ts:1-60`。确认：`audio_items` 建表列顺序、`ensureColumns` 的现有条目、`initSchema` 末尾那段 D8 纠偏 UPDATE 的位置、`SELECT_COLS` 与 `const select` 两处列清单。**把这四处行号记进报告**。

- [ ] **Step 2: 写失败测试（三处）**

在 `server/src/db/schema.test.ts` 末尾追加（**保留文件顶部既有 4 例不动**）：

```ts
// 2026-10-01 spec audio-lineage D5：老音频按 source_url 精确匹配补出 source_import_id（幂等回填）
type IdRow = { source_import_id: number | null };
const insertAudioWithUrl = (title: string, sourceType: string, url: string | null, file: string): void => {
  db.prepare('INSERT INTO audio_items (title, source_type, source_url, file_path, format) VALUES (?, ?, ?, ?, ?)')
    .run(title, sourceType, url, file, 'mp3');
};
const importIdOf = (title: string): number | null =>
  (db.prepare('SELECT source_import_id FROM audio_items WHERE title = ?').get(title) as IdRow).source_import_id;

describe('initSchema 血缘回填（spec audio-lineage D5）', () => {
  it('source_url 能匹配上来源 → 补出 source_import_id', () => {
    const importId = createImportsRepo(db).upsertByUrl({
      url: 'https://a/pl', title: '某合集', site: 'bilibili', kind: 'single', duration_sec: null, entries: null,
    });
    insertAudioWithUrl('老下载', 'download', 'https://a/pl', 'bf-1.mp3');
    initSchema(db); // 模拟升级启动
    expect(importIdOf('老下载')).toBe(importId);
  });
  it('source_url 匹配不上任何来源 → 仍为 NULL（不瞎猜）', () => {
    insertAudioWithUrl('野音频', 'download', 'https://nowhere/x', 'bf-2.mp3');
    initSchema(db);
    expect(importIdOf('野音频')).toBeNull();
  });
  it('source_url 为空串 / NULL → 仍为 NULL（dev 库那 8 条导出片段就是这一类）', () => {
    insertAudioWithUrl('空串', 'edit', '', 'bf-3.mp3');
    insertAudioWithUrl('真 NULL', 'recording', null, 'bf-4.wav');
    initSchema(db);
    expect(importIdOf('空串')).toBeNull();
    expect(importIdOf('真 NULL')).toBeNull();
  });
  it('已填过的行不被改写（幂等 + 不覆盖）', () => {
    createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: '某合集', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    db.prepare('INSERT INTO audio_items (title, source_type, source_url, source_import_id, file_path, format) VALUES (?, ?, ?, ?, ?, ?)')
      .run('已填', 'edit', 'https://a/pl', 999, 'bf-5.mp3', 'mp3'); // 999 故意不存在：证明回填不"纠偏"已有值
    initSchema(db);
    initSchema(db); // 再跑一次，仍不应变
    expect(importIdOf('已填')).toBe(999);
  });
});
```

同文件顶部 `import` 区补一行（与 `initSchema` 同一批 import）：

```ts
import { createImportsRepo } from './repo/imports.js';
```

在 `server/src/db/repo/audio-items.test.ts` 末尾追加：

```ts
  // 2026-10-01 spec audio-lineage D1：剪辑血缘列落库/回读，不传即 null
  it('source_import_id 落库并回读;不传 → null', () => {
    const repo = createAudioItemsRepo(db);
    const a = repo.create({ title: '带血缘', source_type: 'edit', source_url: '', source_import_id: 12, file_path: 'C:/tmp/blood.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.get(a)!.source_import_id).toBe(12);
    expect(repo.list()[0]!.source_import_id).toBe(12);
    const b = repo.create({ title: '无血缘', source_type: 'recording', source_url: null, file_path: 'C:/tmp/nb.wav', format: 'wav', duration_sec: null, file_size: 1 });
    expect(repo.get(b)!.source_import_id).toBeNull();
  });
```

在 `server/src/ytdlp/ingest.test.ts` 的 `describe('ingestDownloadedFile')` 内末尾追加：

```ts
  // 2026-10-01 spec audio-lineage D3：sourceImportId 透传到 source_import_id
  it('sourceImportId 透传进 source_import_id(缺省 → null)', () => {
    const audioRepo = createAudioItemsRepo(db);
    const t1 = join(dir, 'blood.mp3'); writeFileSync(t1, 'x');
    const { audioId } = ingestDownloadedFile({
      tmpPath: t1, title: '带血缘', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: 'https://a/pl', sourceImportId: 7, audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioRepo.get(audioId)!.source_import_id).toBe(7);
    const t2 = join(dir, 'noblood.mp3'); writeFileSync(t2, 'y');
    const { audioId: nid } = ingestDownloadedFile({
      tmpPath: t2, title: '无血缘', format: 'mp3', durationSec: null, fileSize: 1,
      sourceUrl: '', audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioRepo.get(nid)!.source_import_id).toBeNull();
  });
```

- [ ] **Step 3: 跑测试确认它们失败**

Run: `pnpm --filter @sct/server test -- src/db/schema.test.ts src/db/repo/audio-items.test.ts src/ytdlp/ingest.test.ts`
Expected: 失败。schema 那组报 `SQLITE_ERROR`（无 `source_import_id` 列）或 `Cannot find module './repo/imports.js'` 之外的类型错；audio-items / ingest 那两例报 `expected undefined to be 12`（字段还没回读）。

- [ ] **Step 4: 实现 —— `schema.ts`**

Read 后在 `SCHEMA_SQL` 的 `audio_items` 建表里，紧挨 `parent_id INTEGER,` 之后插入（**不要动 `parent_id` 这一行本身**）：

```sql
  -- 2026-10-01 spec audio-lineage D1:剪辑血缘 —— 指向 imported_sources.id。
  -- 不用 parent_id:PRD FR-3.7 原话是"关联源音频",但今天的剪辑输入是视频(source_videos),
  -- 系统里没有"源音频"这个对象,parent_id 指不动;它留给未来"从音频剪音频"(列本就在,非新增,D10)
  source_import_id INTEGER,
```

同一文件，`ensureColumns(db, 'audio_items', [...])` 的数组末尾追加一项：

```ts
    { name: 'source_import_id', ddl: 'source_import_id INTEGER' }, // 2026-10-01 spec audio-lineage D1
```

同一文件，`initSchema` **末尾**（D8 纠偏 `db.exec(...)` 之后）追加：

```ts
  // 2026-10-01 spec audio-lineage D5:血缘回填(幂等)。
  // 不做这一步的后果:老的下载音频(有 url、无外键)与新导出的音频(有外键)会各建一张卡——同一个来源两张卡,
  // 比改造前还差。回填让前端只需认外键一条口径。
  // 只认"精确等于"导不进来的行(空串/NULL/来源早已删除)保持 NULL,由前端收进「无来源」卡(D7)。
  const backfilled = Number(
    db.prepare(
      'UPDATE audio_items SET source_import_id = (SELECT id FROM imported_sources WHERE url = audio_items.source_url) ' +
      "WHERE source_import_id IS NULL AND source_url IS NOT NULL AND source_url <> ''",
    ).run().changes,
  );
  pushLog('info', 'server', `血缘回填:audio_items 补 source_import_id ${backfilled} 行`);
```

并在文件顶部加 import：

```ts
import { pushLog } from '../logs.js';
```

- [ ] **Step 5: 实现 —— `audio-items.ts`**

Read 后改四处（**四处必须同一个 `SearchReplace` 里改完，或分次但每次读回核对**）：

1) `AudioItemRow` 加字段（`parent_id` 不在该接口里，放在 `collection_title` 之后即可）：

```ts
  source_import_id: number | null; // 2026-10-01 spec audio-lineage D1:来源 id(无来源/录制/历史遗留 → null)
```

2) `AudioItemCreate` 加字段：

```ts
  source_import_id?: number | null; // 2026-10-01 spec audio-lineage D1;不传即 NULL
```

3) `insert` 与 `const select`、`SELECT_COLS` 三处 SQL 的列清单都加上 `source_import_id`，`create` 的 `insert.run(...)` 参数对应位置加 `item.source_import_id ?? null`。改完后 `insert` 形如：

```ts
  const insert = db.prepare(
    'INSERT INTO audio_items (title, source_type, source_url, entry_index, collection_title, source_import_id, file_path, format, duration_sec, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
```

4) `normalize` 加映射：

```ts
    source_import_id: r.source_import_id === null || r.source_import_id === undefined ? null : Number(r.source_import_id),
```

- [ ] **Step 6: 实现 —— `ingest.ts`**

Read 后，在参数类型里加（紧挨 `sourceUrl` 之后）：

```ts
  /** 2026-10-01 spec audio-lineage D3:剪辑血缘(来源 id);不传/无来源 → NULL */
  sourceImportId?: number | null;
```

并在 `create({ ... })` 里加：

```ts
    source_import_id: opts.sourceImportId ?? null,
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @sct/server test -- src/db/schema.test.ts src/db/repo/audio-items.test.ts src/ytdlp/ingest.test.ts`
Expected: 三文件全绿（含原有 4 例 D8 纠偏 + 原有 ingest/audio-items 各例）。

- [ ] **Step 8: 全量类型检查 + 全量单测**

Run: `pnpm typecheck` → 三包 0 错。
Run: `pnpm --filter @sct/server test` → 42 文件全绿，用例数 = 399 + 本任务新增 **6 例**（schema 4 + audio-items 1 + ingest 1，即预期 405）。**必须把实际数字写进报告**（不要照抄本计划）。

- [ ] **Step 9: 停在此处**

**不 commit。** 报告须含：Step 1 记下的四处行号、三处 SQL 的实际列清单、全量测试的实际文件数/用例数。

---

## Task 2: 服务端 · 三条入库路径写血缘

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（`finalizeDownload` 内反查来源 + 传参 + 日志）
- Modify: `server/src/media/clip-job.ts`（传 `payload.importId` + 日志带血缘）
- Modify: `server/src/media/ffmpeg-export.ts`（`ingest` 闭包传 `payload.importId` + 入库日志）
- Test: `server/src/media/clip-job.test.ts`、`server/src/media/ffmpeg-export.test.ts`、`server/src/ytdlp/ytdlp-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ingestDownloadedFile({ sourceImportId })`、`AudioItemRow.source_import_id`
- Produces: 三条路径写入的血缘值约定 —— 下载 = 按 `payload.url` 反查出的来源 id（查不到则 `null`）；剪辑/导出 = `payload.importId`（原样写，不做存在性检查）

- [ ] **Step 1: 读磁盘实况**

Read `server/src/ytdlp/ytdlp-routes.ts:126-175`（`createDownloadHandlers` 与 `finalizeDownload`）与 `:175-230`（`finalizeVideoDownload`，看它怎么用 `importsRepo.getByUrl`）；Read `server/src/media/clip-job.ts:70-95`；Read `server/src/media/ffmpeg-export.ts:50-95`；Read 三个测试文件的头 60 行（mock 手法）。确认 `ytdlp-routes.ts` 顶部是否已 import `createImportsRepo`（若只在 `finalizeVideoDownload` 里首次 import，注意那是文件级 import，可直接复用）。

- [ ] **Step 2: 写失败测试**

`server/src/media/clip-job.test.ts`：在既有 `describe('startClipJob')` 的用例里加两行断言（紧跟 `expect(items[0]!.source_url).toBe('https://a/pl');` 之后）：

```ts
    // 2026-10-01 spec audio-lineage D3:剪辑产物必须记住"从哪个来源剪的"(payload.importId=1)
    expect(items[0]!.source_import_id).toBe(1);
```

`server/src/media/ffmpeg-export.test.ts`：第一个用例（separate 2 段）里，紧跟 `expect(items.every((i) => i.source_type === 'edit')).toBe(true); // D8` 之后加：

```ts
    // 2026-10-01 spec audio-lineage D3:导出产物带血缘(payload.importId=1)——改造前这里恒为 NULL,
    // 正是 dev 库那 8 条导出片段在剪辑室散成 8 张碎卡的根因
    expect(items.every((i) => i.source_import_id === 1)).toBe(true);
```

第二个用例（merge）里，紧跟 `expect(items[0]!.source_type).toBe('edit');` 之后加：

```ts
    expect(items[0]!.source_import_id).toBe(1);
```

`server/src/ytdlp/ytdlp-routes.test.ts`：在既有「确认覆盖(force)」用例（约 `:154`）之后新增一例（**照抄它的假 downloadManager + `fire()` 手法**）：

```ts
  // 2026-10-01 spec audio-lineage D3:音频下载入库也要写血缘(按 URL 反查来源 id)
  it('下载音频入库 → source_import_id = 该 URL 对应来源', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const importId = createImportsRepo(db).upsertByUrl({
      url: 'https://a/pl', title: '条目 1', site: 'bilibili', kind: 'single', duration_sec: null, entries: null,
    });
    const producedPath = join(tempDir, 'blood-1.mp3'); writeFileSync(producedPath, 'new');
    let fire: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        fire = () => opts.onEvent(opts.jobId, { type: 'status', state: 'done', producedPath });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/pl', title: '条目 1', options: { format: 'mp3', entryIndices: [1] } } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    fire!();
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const rows = audioRepo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_import_id).toBe(importId);
  });
```

（该文件顶部已 import `createImportsRepo`——读取时确认；若没有，补上。）

- [ ] **Step 3: 跑测试确认它们失败**

Run: `pnpm --filter @sct/server test -- src/media/clip-job.test.ts src/media/ffmpeg-export.test.ts src/ytdlp/ytdlp-routes.test.ts`
Expected: 三文件里新加的那几条断言 FAIL（`expected null to be 1` / `expected undefined to be 1`），其余用例仍 PASS。

- [ ] **Step 4: 实现 —— `ytdlp-routes.ts`（下载路径）**

Read 后在 `finalizeDownload` 里，把 `const result = ingestDownloadedFile({` 之前插入反查（**注意作用域：`jobId`、`payload` 都在闭包内可用**）：

```ts
      // 2026-10-01 spec audio-lineage D3/D4:音频的血缘 —— 按 URL 反查来源 id。
      // 反查不到(理论不可达:parse 必先 upsert 来源)不阻断入库,只记 null + 一行日志:
      // 入库是用户等很久的产物,辅助字段查不到不该毁掉主流程
      const sourceImport = createImportsRepo(db).getByUrl(payload.url);
      if (sourceImport === null) {
        pushLog('error', 'job', `job ${jobId} 血缘反查失败:url=${payload.url} → source_import_id 记 null`);
      }
```

并在 `ingestDownloadedFile({ ... })` 的实参里加一行（放在 `collectionTitle` 之后）：

```ts
        sourceImportId: sourceImport?.id ?? null,
```

- [ ] **Step 5: 实现 —— `clip-job.ts`（剪辑路径）**

Read 后在该 `ingestDownloadedFile({...})` 实参里，紧跟 `sourceType: 'edit',` 之后加：

```ts
      // 2026-10-01 spec audio-lineage D3:血缘 —— payload 里本来就有 importId,原样写(不做存在性检查:D4)
      sourceImportId: payload.importId,
```

并把该文件的 done 日志行改成带上血缘：

```ts
    pushLog('info', 'clip', `job ${jobId} done → audio ${result.audioId} @ ${result.finalPath} source_import_id=${payload.importId}`);
```

- [ ] **Step 6: 实现 —— `ffmpeg-export.ts`（导出路径）**

Read 后把 `ingest` 闭包改成（**只加两行**：实参 `sourceImportId` 与一条入库日志）：

```ts
    const ingest = (tmp: string, title: string, durationSec: number | null): number => {
      const audioId = ingestDownloadedFile({
        tmpPath: tmp, title, format: payload.format, durationSec,
        fileSize: statSync(tmp).size, sourceUrl: '', entryIndex: null, collectionTitle: null,
        sourceType: 'edit',
        sourceImportId: payload.importId, // 2026-10-01 spec audio-lineage D3:导出产物同样记血缘(改造前恒为 NULL)
        audioDir: outputDir, exists: existsSync, audioRepo,
      }).audioId;
      pushLog('info', 'job', `export job ${jobId} 入库 audio=${audioId} source_import_id=${payload.importId}`);
      return audioId;
    };
```

（`sourceUrl: ''` 保持不动——D12：不往 `source_url` 再写一份来源。）

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter @sct/server test -- src/media/clip-job.test.ts src/media/ffmpeg-export.test.ts src/ytdlp/ytdlp-routes.test.ts src/media/home-routes.test.ts`
Expected: 全绿（含 `home-routes.test.ts` 的固化用例，证明首页口径未被改坏）。

- [ ] **Step 8: 全量验证**

Run: `pnpm typecheck` → 0 错。
Run: `pnpm --filter @sct/server test` → 全绿；把实际「文件数 / 用例数」写进报告（基线 405 + 本任务新增 1 例，即预期 406）。
Run: `pnpm --filter @sct/web build` → `Compiled successfully`（前端此刻还没改，这一步只是确认服务端改动没波及 web）。

- [ ] **Step 9: 停在此处**

**不 commit。** 报告须含：三条路径各自的实参行、三条日志行的实际文案、全量测试实际数字。

---

## Task 3: 前端 · 归并键换外键 + 卡片墙口径（含「源已删除」「无来源」卡）

**Files:**
- Modify: `web/src/api.ts`（`AudioRow` 加字段）
- Modify: `web/src/pages/studio.tsx`（`WorkGroup` / `stripClipSuffix` / `workCountText` / `WorkCard` / `works` 分组器 / 一条分组日志）

**Interfaces:**
- Consumes: `GET /api/audio` 新字段 `source_import_id: number | null`（Task 1 的 repo 泛化已让它自动回）
- Produces:
  ```ts
  interface WorkGroup {
    key: string;                       // 'src:<importId>' | 'none'
    title: string; site: string; items: AudioRow[];
    importRow: ImportSource | null;    // 悬空/无来源 → null
    latest: string;
    orphan: 'deleted' | 'none' | null; // null=正常来源卡；'deleted'=来源行已删；'none'=从来没有来源
    noLogo: boolean;                   // 无来源卡且组内平台不唯一 → 不画平台 logo
  }
  ```

- [ ] **Step 1: 读磁盘实况**

Read `web/src/api.ts:266-272`（`AudioRow`）；Read `web/src/pages/studio.tsx:1-62`（imports / `mainTitle` / `WorkGroup` / `workCountText`）、`:62-147`（`WorkCard`）、`:222-260`（`works` 分组器与派生量）。确认 `logFe` 是否已 import（`studio.tsx:182` 用过 → 已 import）。

- [ ] **Step 2: 实现 —— `api.ts` 加字段**

在 `interface AudioRow` 的 `collection_title` 之后加：

```ts
  source_import_id: number | null; // 2026-10-01 spec audio-lineage D1:来源 id(无来源 → null);剪辑室按它归并
```

- [ ] **Step 3: 实现 —— `studio.tsx`：helper 与 `WorkGroup`**

Read 后，把 `WorkGroup` 接口整段替换为：

```tsx
/** 一个「作品」= 同一来源下的全部入库音频(番剧/课程/合集)。没有来源的(录制 + 历史遗留)收进一张「无来源」卡 */
interface WorkGroup {
  key: string;                 // 来源外键 'src:<importId>';无来源卡固定 'none'
  title: string;               // 作品名;孤儿卡取首条主名去掉时间码后缀
  site: string;                // 平台(算 logo 与品牌色)
  items: AudioRow[];           // 该组音频(来源卡可能为空:有视频素材但还没导出成品)
  importRow: ImportSource | null; // 来源行;来源已删(悬空)/无来源 → null
  latest: string;              // 最近入库时间(该组音频最大 created_at;无音频时退来源创建的 created_at)
  orphan: 'deleted' | 'none' | null; // null=正常来源卡;'deleted'=来源行已删(PRD FR-3.7「源已删除」);'none'=从来没有来源
  noLogo: boolean;             // 无来源卡且组内平台不唯一 → 不画平台 logo(画了就是瞎指一个平台)
}
```

在 `mainTitle` 函数之后加：

```tsx
/** 摘掉服务端强制拼的尾部时间码后缀(…… [00:08-00:34] → ……)。
 *  用途:孤儿卡(源已删除/无来源)没有来源标题可挂,只能从条目名推作品名——带时间码的名字不是作品名。
 *  分钟可到三位(如 [120:00-121:30]),故 \d{2,};(格式来源:server/src/media/clip-job.ts 的 formatClipTitle) */
const CLIP_SUFFIX = / \[\d{2,}:\d{2}-\d{2,}:\d{2}\]$/;
function stripClipSuffix(s: string): string { return s.replace(CLIP_SUFFIX, '').trim(); }
```

- [ ] **Step 4: 实现 —— `studio.tsx`：`workCountText`**

整段替换为：

```tsx
/** 卡片计数(spec audio-lineage D9):成品(source_type=edit)/ 素材(下载/录制原料)分开数。
 *  来源卡额外保留「已下 N 集 / 共 M 集」(沿用改造前口径:N 取该来源下的音频条数,本 spec 不改它的语义)。 */
function workCountText(w: WorkGroup): string {
  const products = w.items.filter((i) => i.source_type === 'edit').length;
  const materials = w.items.length - products;
  const parts: string[] = [];
  if (materials > 0) parts.push(`素材 ${materials} 条`);
  parts.push(`成品 ${products} 条`);
  if (w.importRow !== null && w.importRow.kind === 'playlist') {
    parts.push(`已下 ${w.items.length} 集 / 共 ${w.importRow.entry_count} 集`);
  }
  return parts.join(' · ');
}
```

- [ ] **Step 5: 实现 —— `studio.tsx`：`works` 分组器**

把现有 `const works: WorkGroup[] = (() => { ... })();`（约 `:223-248`，含它上面那段注释）整段替换为：

```tsx
  // 剪辑室(P3-T2 → 2026-10-01 血缘改造):列表**由来源驱动** ∪ 孤儿音频。
  // 归并键换成 source_import_id(spec audio-lineage D6)——旧的"按 source_url 字符串相等"不构成血缘:
  // 导出产物从不写 source_url(恒为空串),于是同一个视频剪出的 8 个片段在 dev 库里散成 8 张碎卡(实测)。
  // 三类卡:① 来源卡(来源行在) ② 「源已删除」卡(有外键但来源行已删,按 id 各自成卡,D8)
  //        ③ 一张「无来源」卡(外键为 null:录制 + 历史遗留,D7)
  const works: WorkGroup[] = (() => {
    const map = new Map<string, WorkGroup>();
    // ① 来源先建卡:latest 先用来源创建时间兜底(该来源还没音频时,排序键就是它)
    for (const imp of imports) {
      map.set(`src:${imp.id}`, {
        key: `src:${imp.id}`, title: imp.title, site: imp.site, items: [], importRow: imp,
        latest: imp.created_at, orphan: null, noLogo: false,
      });
    }
    // ② 音频按外键挂到对应来源卡下;外键为空 → 汇总到一张「无来源」卡
    for (const it of items) {
      const key = it.source_import_id === null ? 'none' : `src:${it.source_import_id}`;
      const cur = map.get(key);
      if (cur !== undefined) {
        // 该组首条音频接管排序键(覆盖来源创建时间),之后取最大 —— 即「该组音频最大 created_at」
        if (cur.items.length === 0 || it.created_at > cur.latest) cur.latest = it.created_at;
        cur.items.push(it);
      } else if (key === 'none') {
        map.set('none', {
          key: 'none', title: '无来源', site: it.site, items: [it], importRow: null,
          latest: it.created_at, orphan: 'none', noLogo: false,
        });
      } else {
        // 有外键但来源行不在 map 里 = 来源已删(悬空)→ 按该 id 单独成卡,不并进「无来源」
        map.set(key, {
          key, title: '源已删除', site: it.site, items: [it], importRow: null,
          latest: it.created_at, orphan: 'deleted', noLogo: false,
        });
      }
    }
    // ③ 收口:孤儿卡的标题取首条主名去时间码后缀(带时间码的名字不是作品名);
    //    无来源卡的平台 logo 只在组内平台唯一时才画(录制与历史遗留混在一起时指不准)
    for (const w of map.values()) {
      if (w.orphan === null) continue;
      w.title = stripClipSuffix(mainTitle(w.items[0]!)) || (w.orphan === 'deleted' ? '源已删除' : '无来源');
    }
    const none = map.get('none');
    if (none !== undefined) {
      none.site = none.items[0]!.site;
      none.noLogo = new Set(none.items.map((i) => i.site)).size > 1;
    }
    return [...map.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1)); // 最近入库在前
  })();
```

（`openKey` 现在存的是 `w.key`，`openCard(key)` / `works.find((w) => w.key === openKey)` 两处**不用改**。）

- [ ] **Step 6: 实现 —— `studio.tsx`：`WorkCard` 三处**

1) 封面占位（`showCover === false` 那一支）里，把 `<SiteLogo site={work.site} size={44} />` 换为：

```tsx
            {/* 无来源卡且组内平台不唯一 → 不画 logo(画了就是瞎指一个平台) */}
            {!work.noLogo && <SiteLogo site={work.site} size={44} />}
```

2) 封面左上角平台角标那一段（`<span style={{ position: 'absolute', left: 8, top: 8 ...`）用条件包起来：

```tsx
        {!work.noLogo && (
          <span style={{ position: 'absolute', left: 8, top: 8, display: 'flex', background: 'rgba(0, 0, 0, 0.45)', borderRadius: 6, padding: 3 }}>
            <SiteLogo site={work.site} size={14} />
          </span>
        )}
```

3) 计数行那一行里，紧跟 `{materialText !== null && <Tag color="green" ...>{materialText}</Tag>}` 之后加：

```tsx
          {/* PRD FR-3.7:来源被删后产物仍在,这里明确告诉用户"源没了" */}
          {work.orphan === 'deleted' && <Tag color="red" style={{ marginInlineEnd: 0 }}>源已删除</Tag>}
```

- [ ] **Step 7: 实现 —— `studio.tsx`：分组结果日志（D13）**

在 `useEffect` 的 `load()` **之后**（同文件内，与既有 `useEffect` 平级）新增一个 effect：

```tsx
  // 诊断日志(spec audio-lineage D13):分组结果留痕 —— "几张来源卡 / 几张孤儿卡"是这次改造最容易出错的地方
  useEffect(() => {
    if (items.length === 0 && imports.length === 0) return;
    const live = new Set(imports.map((i) => i.id));
    const dangling = new Set(items.map((i) => i.source_import_id).filter((v): v is number => v !== null && !live.has(v)));
    const noSource = items.filter((i) => i.source_import_id === null).length;
    logFe('info', `剪辑室分组:来源卡 ${imports.length} 张、源已删除 ${dangling.size} 张、无来源 ${noSource} 条`);
  }, [items, imports]);
```

- [ ] **Step 8: 验证**

Run: `pnpm typecheck` → web 包 0 错（尤其确认没有 `Property 'source_import_id' does not exist` 与 `useEffect` 未 import 的错）。
Run: `pnpm --filter @sct/web build` → `Compiled successfully`。
**人工目验清单**（写进报告，标「未执行，交用户目验」）：
1. 剪辑室卡片墙：dev 库应显示 **2 张来源卡 + 1 张「无来源」卡**（8 条导出片段收在一张里，标题是去掉 `[mm:ss-mm:ss]` 的公共前缀），不再有 8 张碎卡。
2. 两张来源卡上不再出现「8 条」这类数字（它们的 items 为空 → `成品 0 条`）。
3. 无来源卡：无封面、纯色底、不画平台 logo。
4. 点进无来源卡：8 条音频都能播、都能删（删除仍弹 `Modal.confirm`，确认按钮为 danger 红）。
5. 日志抽屉里能看到分组那行：`剪辑室分组:来源卡 2 张、源已删除 0 张、无来源 8 条`。
6. **删来源的路径**（对应 spec §0.7 验收 8）：先给某个来源导出一条成品（或在 dev 库里手动 `UPDATE audio_items SET source_import_id = 12 WHERE id = 15`），再去资料库删掉该来源 → 剪辑室出现一张**「源已删除」卡**（红色标签 + 那几条成品），且**没有**并进「无来源」卡。

- [ ] **Step 9: 停在此处**

**不 commit。**

---

## Task 4: 前端 · 卡内「素材 / 成品」分组 + 空态 + 原视频链接回退

**Files:**
- Modify: `web/src/pages/studio.tsx`（`GroupHeader` 新组件 / 卡内分组渲染 / 零音频空态 / `renderRow` 的原视频回退）

**Interfaces:**
- Consumes: Task 3 的 `WorkGroup.importRow`、`AudioRow.source_type`
- Produces: 无新导出符号（纯页面渲染）

- [ ] **Step 1: 读磁盘实况**

Read `web/src/pages/studio.tsx` 的 `renderRow`（约 `:283-322`）与正文四态 `let body`（约 `:324-350`），确认 `pageRows` 的定义位置（约 `:264`）与 `Empty` / `Button` / `navigate` 都在作用域内。

- [ ] **Step 2: 实现 —— 新增 `GroupHeader` 组件**

在 `WorkCard` 之后（`type ViewKind` 那一行之前）加：

```tsx
/** 卡内分组标题(spec audio-lineage D9):素材(下载/录制的原料)在前、成品(剪辑/导出)在后 */
function GroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', margin: '4px 0 8px' }}>
      {label} {count}
    </Typography.Text>
  );
}
```

- [ ] **Step 3: 实现 —— 卡内分组（页面级派生量）**

在 `pageRows` 定义（约 `:264`）之后加：

```tsx
  // 卡内按「素材 / 成品」分组(spec audio-lineage D9):只对"进入某个来源后"的那一层生效;平铺视图不分。
  // 口径用 source_type 而非标题后缀:source_type 是入库时定死的事实,标题是可变文本(能重命名)。
  const openMaterial: AudioRow[] = openWork === null ? [] : pageRows.filter((r) => r.source_type !== 'edit');
  const openProduct: AudioRow[] = openWork === null ? [] : pageRows.filter((r) => r.source_type === 'edit');
```

- [ ] **Step 4: 实现 —— 正文渲染**

把正文最后那一支（`else { body = pageRows.length === 0 ? ... : (<div ...>{pageRows.map(renderRow)}</div>); }`）里的行渲染改为：

```tsx
        <div style={{ width: '100%', maxWidth: CARDS_MAX_WIDTH, minWidth: 0, margin: '0 auto' }}>
          {openWork === null ? (
            pageRows.map(renderRow) // 平铺视图:不分组的原样列表
          ) : (
            <>
              {openMaterial.length > 0 && <GroupHeader label="素材" count={openMaterial.length} />}
              {openMaterial.map(renderRow)}
              {openProduct.length > 0 && <GroupHeader label="成品" count={openProduct.length} />}
              {openProduct.map(renderRow)}
            </>
          )}
        </div>
```

（分页**不变**：仍是那一处 `Pagination` 对卡内全部行分页，页内再分组 → 某页只含一种组时只出现该组标题。）

- [ ] **Step 5: 实现 —— 零音频空态**

把 `openWork !== null && openWork.items.length === 0` 那一支替换为：

```tsx
  } else if (openWork !== null && openWork.items.length === 0) {
    // 文案 2026-10-01 spec audio-lineage §0.5:音频一律从剪辑获得——原句「还没有下载音频」会把人误导回去重下
    const imp = openWork.importRow;
    body = (
      <Empty description="该来源还没有音频；到剪辑详情导出成品" style={{ marginTop: 64 }}>
        {imp !== null && <Button type="primary" onClick={() => navigate(`/studio/${imp.id}`)}>去剪辑详情</Button>}
      </Empty>
    );
  } else {
```

（注意：这一步把原来的 `} else {` 一起吞进来，替换后仍是 if/else 链，**不要多出一个 `}`**。）

- [ ] **Step 6: 实现 —— 原视频链接回退（D12）**

在 `renderRow` 内部（`return (` 之前）加一行：

```tsx
    // D12:导出产物 source_url 恒为空串(不写第二份来源) → 进了来源卡就用该卡的来源网址回退显示"原视频"
    const sourceHref = (it.source_url !== null && it.source_url !== '') ? it.source_url : (openWork?.importRow?.url ?? null);
```

并把行内那一整块 `{it.source_url !== null && it.source_url !== '' && (<a href={it.source_url} ...>原视频:{it.source_url}</a>)}` 的**三处 `it.source_url` 全部换成 `sourceHref`**，条件改成 `{sourceHref !== null && (...)}`（`title`、`href`、显示文案都要换）。

- [ ] **Step 7: 验证**

Run: `pnpm typecheck` → web 0 错。
Run: `pnpm --filter @sct/web build` → `Compiled successfully`。
**人工目验清单**（写进报告，标「未执行，交用户目验」）：
1. 进有来源的卡：能看到 `素材 N` / `成品 N` 两个组标题；某组为空时**不出现**该组标题。
2. 无来源卡（8 条导出片段）里只出现 `成品 8` 一个组标题（它们 `source_type='edit'`）。
3. 每条导出产物的行内「原视频」链接现在**能显示**（回退到该卡的来源网址）——但无来源卡里仍不显示（那张卡本就没有网址）。
4. 来源卡零音频时显示「该来源还没有音频；到剪辑详情导出成品」+「去剪辑详情」按钮，点击进 `/studio/:importId`。
5. 搜索、删除、播放器行为与改造前一致；平铺视图看不到组标题。

- [ ] **Step 8: 停在此处**

**不 commit。**

---

## Task 5: 文档回扫 + 整支最终验证

**Files:**
- Modify: `server/src/db/schema.ts`（`parent_id` 注释指向本 spec）
- Modify: `web/src/pages/studio.tsx`（归并键注释——Task 3 已重写，本任务只做**复查**）
- Modify: `docs/superpowers/specs/m2-workspace.md`（`:38` 事实 6、`:299` backlog B4）
- Modify: `docs/prds/音频录制与剪辑-PRD初始篇.md`（`:80` FR-3.7、`:195` 表注释）
- Modify: `server/src/db/repo/home.ts`（`:45-46` 注释里"audio_items 没有 import_id 列"这句已不成立）

**Interfaces:** 无代码接口变化（纯文档/注释）

- [ ] **Step 1: 按关键词全仓扫一遍（用户全局规则：落地后回扫所有声明它的地方）**

Run（PowerShell）:
```powershell
Get-ChildItem d:\Seed\sound-control-tool\docs,d:\Seed\sound-control-tool\server\src,d:\Seed\sound-control-tool\web\src -Recurse -File -Include *.md,*.ts,*.tsx | Select-String -Pattern 'parent_id|血缘|source_url 归并|按来源网址|尚未落地|没有 import_id 列'
```
把命中行**逐条对照现状**，判断哪些已经过时。

- [ ] **Step 2: 逐处改**

1. `server/src/db/schema.ts` —— `parent_id INTEGER,` 那行的注释（若没有注释就补一句）：写清"它是 PRD FR-3.7 的原方案，但今天剪辑输入是视频、没有「源音频」对象，实际血缘走 `source_import_id`（spec audio-lineage D10）"。
2. `docs/superpowers/specs/m2-workspace.md:38` —— 事实 6 的"`parent_id` 有列但从未被写入…FR-3.7 血缘设计尚未落地"改为"**已落地（2026-10-01，spec `2026-10-01-audio-lineage.md`）**：血缘走新增列 `source_import_id`（指向 `imported_sources.id`），`parent_id` 仍未使用"。
3. `docs/superpowers/specs/m2-workspace.md:299` —— backlog B4 标为**已落地**，注明触发条件（"需要从剪辑产物反查源音频时"）已达成，且方案与原设想的 `parent_id` 不同（指向来源而非源音频）。
4. `docs/prds/音频录制与剪辑-PRD初始篇.md:80` 与 `:195` —— 加一行注记（`>` 引用块）：血缘列实际为 `source_import_id → imported_sources.id`；`parent_id` 保留未用。**PRD 正文不改写**（它是历史文档，改法用注记）。
5. `server/src/db/repo/home.ts:45-46` —— 注释里"`audio_items` 没有 import_id 列 → 只能靠 url 反查"改为"该列已存在（`source_import_id`，2026-10-01），但本查询**刻意仍按 `s.url = a.source_url` 关联**：对 `source_type='download'` 的旧行两者等价，换过来零收益、却要动一条已被 8 个用例固化的 SQL（spec audio-lineage D11）"。
6. `web/src/pages/studio.tsx` —— **复查** Task 3 重写的那段注释里不再出现"代价是同一作品被两种网址变体下载过会分成两张卡"，且新注释说清了"归并键 = 外键"。
7. `docs/handoffs/*.md` 与 `docs/superpowers/specs/2026-09-30-*.md` —— 若 Step 1 的扫描命中"血缘 / 归并键 / source_url"的表述，**只加一行注记**指向本 spec（不改历史文档的正文：它们是过程记录）。

- [ ] **Step 3: 整支最终验证（实跑，数字取终态）**

Run:
```powershell
pnpm typecheck
pnpm --filter @sct/server test
pnpm --filter @sct/web build
pnpm --filter @sct/desktop build
```
Expected: typecheck 三包 Done exit 0；server test 全绿（把**实际**文件数/用例数写进报告）；web `Compiled successfully`；desktop exit 0。

- [ ] **Step 4: 交付物核对**

Run: `git status --short`
Expected: 只有本 spec 涉及的源码/测试/文档改动 + 新文件（`docs/superpowers/specs/2026-10-01-audio-lineage.md`、`docs/superpowers/plans/2026-10-01-audio-lineage.md`）。**不得**出现 `derived/`、`.sct/`、PNG 等产物。

- [ ] **Step 5: 停在此处**

**不 commit。** 报告须含：回扫命中的每一处（改前/改后原文）、四项验证的实际输出数字、`git status --short` 的实际条数。

---

## 附：任务依赖与串行约束

- Task 1 → Task 2 → Task 3 → Task 4 → Task 5，**严格串行**：Task 2 依赖 Task 1 的新入参；Task 3 依赖 Task 1/2 写入的字段真有值；Task 4 依赖 Task 3 的 `WorkGroup.importRow`；Task 5 是收口。
- Task 3 与 Task 4 **都在改 `web/src/pages/studio.tsx`**，且 Task 3 改注释、Task 4 改渲染 —— 必须顺序做，**禁止并行子代理**（同文件并行 `SearchReplace` 会互相覆盖）。
- 每个任务开工第一步是 Read 磁盘实况；改完读回核对；`pnpm typecheck` 单文件级验证在每次编辑后跑。

## 附：交付切片建议（供用户提交时切分，子代理不 commit）

| 切片 | 内容 | 独立可验证 |
|---|---|---|
| ① 数据层 | Task 1（列 + 回填 + repo/ingest + 3 个测试文件） | server test 全绿 |
| ② 写入路径 | Task 2（三条路径 + 3 个测试文件改动） | server test 全绿 |
| ③ 剪辑室归并 | Task 3（api.ts + studio 分组器/卡片墙） | typecheck + build + 目验 1–5 |
| ④ 卡内分组 | Task 4（素材/成品 + 空态 + 链接回退） | typecheck + build + 目验 1–5 |
| ⑤ 文档回扫 | Task 5 | 四项验证 + git status 核对 |
