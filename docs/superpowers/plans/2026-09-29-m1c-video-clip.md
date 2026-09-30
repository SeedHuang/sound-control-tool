# 视频预览剪音频（m1c-video-clip）实施计划

> **给执行者**：本计划必须配合 `subagent-driven-development`（推荐）或 `executing-plans` 逐任务执行。步骤用 `- [ ]` 勾选跟踪。

**Goal:** 让用户把视频下到本地当"带画面的时间标尺"，在画面上点出起止，然后把这段音频抽出来进音频库。

**Architecture:** 复用同一条下载 job 管线（payload 加 `produce: 'audio' | 'video'`，finalize 分两支）；视频素材落 `<数据目录>/media/` 并记 `source_videos` 表，**不进** `audio_items`；剪辑是一条独立 job（`ffmpeg_clip`），产物经既有 `ingestDownloadedFile` 入库为普通音频行。

**Tech Stack:** Fastify 5 + node:sqlite（server）／Umi Max 4 + antd 5（web）／yt-dlp + ffmpeg（外部二进制）／vitest（server 单测）

**Spec:** `docs/superpowers/specs/m1c-video-clip.md`（计划从 spec 推导而来，执行时两份一起读）

## Global Constraints

- **node:sqlite 需要 flag**：所有 server 命令都走 `NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning"`（`npm test` 里已带）。
- **ffmpeg 是硬前置**（spec D16）：剪辑整条链路没有 ffmpeg 就不可用；拿不到路径必须报错引导去设置页，不许静默跳过。
- **成功判定不信退出码**：凡外部进程产物，一律以"目标文件真出现且体积 > 0"为准（spec §0.5）。
- **stderr 永远记下来**：`execFile` 用三参回调，失败路径必须把 stderr 关键行写进日志（仓库铁律）。
- **失败语义分两档**（spec §0.4）：失败的是「写本体」→ 接口/job 报错；失败的是「删附属」→ 只记日志、不阻断。
- **凡丢数据的按钮都必须二次确认**（antd `Modal.confirm`，确认按钮 `okType: 'danger'`，写清"删什么 + 连带删什么"）。
- **删除接口的 IO 失败不让接口失败**（DB 行删了即算"删了"）。
- **key 名不写裸串**：settings 键从 `SETTINGS_KEYS` 取。
- **前端无测试框架**（web 只有 typecheck + 手工目验），所以 web 任务的"测试"= `npx tsc --noEmit` + 浏览器实测，不要编造单测。
- **⚠️ git 纪律**：本仓库规则是"未经用户明确要求不得执行 git 写操作"。计划里的 `commit` 步骤**默认不执行**——把每个任务的产物攒着，向用户申请后再提交（可一次提交多个任务）。

---

### Task 0: 开工前五项实测（不写代码，但必须最先做）

spec §0.1 列了 5 件"不实测不写死"的事。结论要回写 spec §0.1，后续任务的参数以实测为准。

**Files:**
- Modify: `docs/superpowers/specs/m1c-video-clip.md`（把每项的结论写进 §0.1 的事实里）

- [ ] **Step 1: 建一个临时工作目录**

```powershell
mkdir D:\tmp\m1c-probe -Force
```

- [ ] **Step 2: 实测 A —— 清晰度用上限式还是就近式**

拿一个**多清晰度**的视频（B 站或 YouTube 都行），跑两遍，对比实际分辨率：

```powershell
yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" --merge-output-format mp4 -o "D:\tmp\m1c-probe\A1.%(ext)s" "<URL>"
yt-dlp -S "res:480" --merge-output-format mp4 -o "D:\tmp\m1c-probe\A2.%(ext)s" "<URL>"
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 D:\tmp\m1c-probe\A1.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 D:\tmp\m1c-probe\A2.mp4
```

**记录**：哪条表达式真的落在我选的档位以下。预期（待验证）：就近式可能挑到比 480 更大的一档。

- [ ] **Step 3: 实测 B —— `-ss/-to` 摆在哪一侧**

```powershell
ffmpeg -ss 30 -to 40 -i D:\tmp\m1c-probe\A1.mp4 -vn -c:a libmp3lame -b:a 192k -y D:\tmp\m1c-probe\B1.mp3
ffmpeg -i D:\tmp\m1c-probe\A1.mp4 -ss 30 -to 40 -vn -c:a libmp3lame -b:a 192k -y D:\tmp\m1c-probe\B2.mp3
ffprobe -v error -show_entries format=duration -of csv=p=0 D:\tmp\m1c-probe\B1.mp3
ffprobe -v error -show_entries format=duration -of csv=p=0 D:\tmp\m1c-probe\B2.mp3
```

**记录**：两条的时长是否都≈10s、**起点是否都对得上**（拿一段有明显人声起点的地方，用播放器听第 30 秒应该出现的内容）。若输入侧的起点不准，`buildClipArgs`（Task 4）就改用输出侧。

- [ ] **Step 4: 实测 C —— Electron 里真能播吗**

先把一个 mp4 放进当前数据目录的 `media/`（手动建目录即可），再用一个最小 HTML 页在 Electron 窗口里打开它、点播放、拖进度条。**必须拖得动**（拖不动就是 Range 没生效）。

**记录**：能否播、能否拖。截图或一句话结论都行。

- [ ] **Step 5: 实测 D —— 编解码组合**

B 站与 YouTube **各一个**视频，都跑一遍 Step 2 的第一条命令，然后用下面的命令看有没有音轨、编解码是什么：

```powershell
ffprobe -v error -show_entries stream=index,codec_name,codec_type -of csv=p=0 D:\tmp\m1c-probe\A1.mp4
```

**记录**：视频流/音频流的 codec 名。若出现 `vp9`/`av1` + `opus`，就要在 Task 6 的参数里加编解码偏好（spec D2）。

- [ ] **Step 6: 实测 E —— Windows 上 rename 覆盖"被占用的文件"**

```powershell
$f = "D:\tmp\m1c-probe\lock.mp4"; [IO.File]::WriteAllText($f, "x")
$s = [IO.File]::Open($f, 'Open', 'Read', 'None')      # 保持占用
node -e "require('fs').renameSync('D:/tmp/m1c-probe/A1.mp4','D:/tmp/m1c-probe/lock.mp4')"   # 预期抛错
$s.Close()
```

**记录**：抛出的错误码（预期 `EPERM` 或 `EBUSY`）。这个码要写进 Task 3 的 `placeVideo` 判定。

- [ ] **Step 7: 把五项结论回写 spec §0.1**

在 `docs/superpowers/specs/m1c-video-clip.md` 的 §0.1 里，把每条"待实测"改成实测结论（保留原表，后面加一列结论或改写成事实）。**这一步不做完不许进 Task 1**——后面所有任务都依赖这些参数。

---

### Task 1: 把 SSE 事件桥抽成独立模块

**为什么**：剪辑 job 要往同一个 job 推 SSE 事件，而事件桥现在埋在 `ytdlp-routes.ts` 里。纯搬迁，行为不变。

**Files:**
- Create: `server/src/ytdlp/job-events.ts`
- Modify: `server/src/ytdlp/ytdlp-routes.ts:25-43`（删掉本地实现，改为 import）、`:561-572`（连接登记/注销改用新函数）、`:186-190`（进度节流改用新函数）
- Test: `server/src/ytdlp/ytdlp-routes.test.ts`（**不改**，必须继续全绿）

**Interfaces:**
- Consumes: 无
- Produces:
  - `type SseConn = { write: (s: string) => void; end: () => void }`
  - `addSseConnection(jobId: number, conn: SseConn): void`
  - `removeSseConnection(jobId: number, conn: SseConn): number`（返回剩余连接数）
  - `emit(jobId: number, ev: unknown): void`
  - `progressBucketChanged(jobId: number, percent: number): boolean`

- [ ] **Step 1: 建新模块（把现有实现原样搬过来 + 加两个登记函数和进度节流）**

```ts
// server/src/ytdlp/job-events.ts
// 2026-09-29 抽出:下载路由与媒体剪辑路由都要往同一个 job 推 SSE 事件,事件桥不能只活在 ytdlp-routes.ts。
// 所有"按 jobId 记的临时状态"都收在这里,避免同一份状态散在多个文件里各删一半。
import { pushLog } from '../logs.js';

export type SseConn = { write: (s: string) => void; end: () => void };

const sseConnections = new Map<number, Set<SseConn>>();
// 终态:done/error/cancelled 事件后断开连接(progress/running 不断开)
const TERMINAL_STATES = new Set(['done', 'error', 'cancelled']);
// 诊断日志:每个 job 只在 25/50/75/100 档位变化时记一行进度(逐条进度行会把日志面板刷成噪声)
const lastProgressBucket = new Map<number, number>();

export function addSseConnection(jobId: number, conn: SseConn): void {
  if (!sseConnections.has(jobId)) sseConnections.set(jobId, new Set());
  sseConnections.get(jobId)!.add(conn);
}

/** 注销连接并返回剩余数(调用方用它决定是否打印 close 日志) */
export function removeSseConnection(jobId: number, conn: SseConn): number {
  const set = sseConnections.get(jobId);
  if (!set) return 0;
  set.delete(conn);
  if (set.size === 0) sseConnections.delete(jobId);
  return set.size;
}

/** 进度日志节流:同一 job 只在跨 25% 档位时返回 true(档位状态在终态由 emit 清掉) */
export function progressBucketChanged(jobId: number, percent: number): boolean {
  const bucket = Math.floor(percent / 25);
  if (lastProgressBucket.get(jobId) === bucket) return false;
  lastProgressBucket.set(jobId, bucket);
  return true;
}

export function emit(jobId: number, ev: unknown): void {
  const set = sseConnections.get(jobId);
  if (!set) return;
  const type = (ev as { type: string }).type;
  const state = type === 'status' ? (ev as { state?: string }).state : type;
  for (const conn of set) conn.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
  if (type === 'done' || (type === 'status' && state && TERMINAL_STATES.has(state))) {
    for (const conn of set) conn.end();
    sseConnections.delete(jobId);
    lastProgressBucket.delete(jobId); // 终态清理,防 Map 无界增长
  }
}

/** 只是给路由层复用的一句话日志(避免路由直接 import pushLog 两次写同一句式) */
export function logSseClose(jobId: number, remaining: number): void {
  pushLog('info', 'job', `SSE close job=${jobId} remaining=${remaining}`);
}
```

- [ ] **Step 2: 跑测试确认还是绿的（搬迁不该改变任何行为）**

Run: `cd server; npm test`
Expected: 186 passed（与搬迁前一致）

- [ ] **Step 3: 改造 ytdlp-routes.ts 使用新模块**

删掉 `ytdlp-routes.ts` 里的 `SseConn` / `sseConnections` / `TERMINAL_STATES` / `lastProgressBucket` / `emit` 定义，改为：

```ts
import { addSseConnection, emit, logSseClose, progressBucketChanged, removeSseConnection, type SseConn } from './job-events.js';
```

进度日志那三行（原 `186-190`）改成：

```ts
          if (progressBucketChanged(jid, ev.percent)) {
            pushLog('info', 'job', `job ${jid} 进度 ${Math.round(ev.percent)}%`);
          }
```

SSE 路由里的登记（原 `562-563`）：

```ts
    addSseConnection(id, conn);
```

断开清理（原 `566-572`）：

```ts
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      logSseClose(id, removeSseConnection(id, conn));
    });
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd server; npx tsc --noEmit --pretty false; npm test`
Expected: typecheck 0 错、186 passed

- [ ] **Step 5: 提交**（按 Global Constraints，先向用户申请）

```bash
git add server/src/ytdlp/job-events.ts server/src/ytdlp/ytdlp-routes.ts
git commit -m "refactor(ytdlp): 抽出 SSE 事件桥 job-events.ts 供媒体剪辑复用"
```

---

### Task 2: `source_videos` 表与 repo

**Files:**
- Modify: `server/src/db/schema.ts:53`（在 `SCHEMA_SQL` 末尾追加建表）
- Create: `server/src/db/repo/source-videos.ts`
- Test: `server/src/db/repo/source-videos.test.ts`

**Interfaces:**
- Consumes: `DB`（`../index.js`）
- Produces:
  - `createSourceVideosRepo(db)` → `{ upsert, list, get, delete }`
  - `upsert(v: { importId: number; filePath: string; height: number | null; fileSize: number | null }): void`
  - `list(): Array<SourceVideoRow & { url: string; title: string; site: string }>`
  - `get(importId: number): SourceVideoRow | null`
  - `delete(importId: number): boolean`

- [ ] **Step 1: 写失败的测试**

```ts
// server/src/db/repo/source-videos.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { initSchema } from '../schema.js';
import { createImportsRepo } from './imports.js';
import { createSourceVideosRepo } from './source-videos.js';

let db: DB;
let importId: number;
beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  importId = createImportsRepo(db).upsertByUrl({
    url: 'https://a/pl', title: '凡人修仙传', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null,
  });
});

describe('source_videos repo', () => {
  it('upsert 后能读回;同一来源再 upsert 是覆盖(不新增行)', () => {
    const repo = createSourceVideosRepo(db);
    repo.upsert({ importId, filePath: 'C:/m/media-1.webm', height: 480, fileSize: 100 });
    expect(repo.get(importId)?.file_path).toBe('C:/m/media-1.webm');
    repo.upsert({ importId, filePath: 'C:/m/media-1.mp4', height: 720, fileSize: 200 });
    expect(repo.get(importId)?.file_path).toBe('C:/m/media-1.mp4');
    expect(repo.get(importId)?.height).toBe(720);
    expect(repo.list()).toHaveLength(1);
  });
  it('list 带出来源的 url/title/site(前端素材列表要显示)', () => {
    createSourceVideosRepo(db).upsert({ importId, filePath: 'C:/m/media-1.mp4', height: 480, fileSize: 1 });
    expect(createSourceVideosRepo(db).list()[0]).toMatchObject({ url: 'https://a/pl', title: '凡人修仙传', site: 'bilibili' });
  });
  it('delete 删行;不存在返回 false', () => {
    const repo = createSourceVideosRepo(db);
    repo.upsert({ importId, filePath: 'C:/m/media-1.mp4', height: 480, fileSize: 1 });
    expect(repo.delete(importId)).toBe(true);
    expect(repo.get(importId)).toBeNull();
    expect(repo.delete(importId)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/db/repo/source-videos.test.ts`
Expected: FAIL —— 找不到模块 `./source-videos.js`

- [ ] **Step 3: 加表**

在 `server/src/db/schema.ts` 的 `SCHEMA_SQL` 模板串里、`imported_sources` 之后追加（**不要**写 `REFERENCES`：库没开外键，级联不生效，靠显式删 —— spec §0.1 事实 6）：

```sql
CREATE TABLE IF NOT EXISTS source_videos (
  import_id INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  height INTEGER,
  file_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: 写 repo**

```ts
// server/src/db/repo/source-videos.ts
// 视频素材(2026-09-29,spec m1c-video-clip):与 imported_sources 一对一。只管"我下过哪个视频素材在哪"。
import type { DB } from '../index.js';

export interface SourceVideoRow {
  import_id: number;
  file_path: string;
  height: number | null;
  file_size: number | null;
  created_at: string;
}

export function createSourceVideosRepo(db: DB) {
  /** 一个来源一份素材 → 冲突即覆盖(换清晰度重下就是这条路径) */
  const upsert = (v: { importId: number; filePath: string; height: number | null; fileSize: number | null }): void => {
    db.prepare(
      'INSERT INTO source_videos (import_id, file_path, height, file_size) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(import_id) DO UPDATE SET file_path=excluded.file_path, height=excluded.height, file_size=excluded.file_size',
    ).run(v.importId, v.filePath, v.height, v.fileSize);
  };
  /** 素材列表(join 来源取标题/网址/站点);新→旧 */
  const list = (): Array<SourceVideoRow & { url: string; title: string; site: string }> =>
    (db.prepare(
      'SELECT v.import_id, v.file_path, v.height, v.file_size, v.created_at, s.url, s.title, s.site ' +
      'FROM source_videos v JOIN imported_sources s ON s.id = v.import_id ' +
      'ORDER BY v.created_at DESC, v.import_id DESC',
    ).all() as Array<Record<string, unknown>>).map((r) => ({
      import_id: r.import_id as number,
      file_path: r.file_path as string,
      height: r.height === null || r.height === undefined ? null : Number(r.height),
      file_size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
      created_at: r.created_at as string,
      url: r.url as string,
      title: r.title as string,
      site: r.site as string,
    }));
  const get = (importId: number): SourceVideoRow | null => {
    const r = db.prepare('SELECT import_id, file_path, height, file_size, created_at FROM source_videos WHERE import_id = ?')
      .get(importId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      import_id: r.import_id as number,
      file_path: r.file_path as string,
      height: r.height === null || r.height === undefined ? null : Number(r.height),
      file_size: r.file_size === null || r.file_size === undefined ? null : Number(r.file_size),
      created_at: r.created_at as string,
    };
  };
  const del = (importId: number): boolean =>
    db.prepare('DELETE FROM source_videos WHERE import_id = ?').run(importId).changes > 0;
  return { upsert, list, get, delete: del };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server; npx vitest run src/db/repo/source-videos.test.ts; npm test`
Expected: 新文件 3 passed；全量 189 passed（186 + 3）

- [ ] **Step 6: 提交**（先申请）

```bash
git add server/src/db/schema.ts server/src/db/repo/source-videos.ts server/src/db/repo/source-videos.test.ts
git commit -m "feat(db): source_videos 表与 repo(视频素材与来源一对一)"
```

---

### Task 3: 素材落盘的覆盖语义（`media-files.ts`）

这是 spec §0.4 那五条的落地：**写新前清旧扩展名 / 目标被占用要报错 / 不覆盖用户手工放的文件 / 删旧失败只记日志**。

**Files:**
- Create: `server/src/media/media-files.ts`
- Test: `server/src/media/media-files.test.ts`

**Interfaces:**
- Consumes: 无（只有 node:fs 与 logs）
- Produces:
  - `findVideoFile(mediaDir: string, importId: number): string | null`
  - `findVideoFiles(mediaDir: string, importId: number): string[]`
  - `placeVideo(opts: { tmpPath: string; mediaDir: string; importId: number; ext: string; knownImports: Set<number>; exists?: (p: string) => boolean }): PlaceResult`
  - `type PlaceResult = { ok: true; path: string } | { ok: false; reason: 'busy' | 'io'; message: string }`
  - `deleteVideoFiles(mediaDir: string, importId: number): { deleted: string[]; failed: string[] }`

- [ ] **Step 1: 写失败的测试**

```ts
// server/src/media/media-files.test.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteVideoFiles, findVideoFile, placeVideo } from './media-files.js';

let dir: string;
let tmpPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sct-media-'));
  tmpPath = join(dir, 'incoming.mp4');
  writeFileSync(tmpPath, 'VIDEOBYTES');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('placeVideo 覆盖语义(spec §0.4)', () => {
  it('首次落盘:改成 media-<id>.mp4', () => {
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', knownImports: new Set() });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.mp4') });
    expect(findVideoFile(dir, 7)).toBe(join(dir, 'media-7.mp4'));
  });
  it('换扩展名重下:旧扩展名被清掉,只留新的', () => {
    writeFileSync(join(dir, 'media-7.webm'), 'OLD');
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', knownImports: new Set([7]) });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'media-7.webm'))).toBe(false);
    expect(existsSync(join(dir, 'media-7.mp4'))).toBe(true);
  });
  it('目标已被我们登记过 → 直接覆盖,不加序号', () => {
    writeFileSync(join(dir, 'media-7.mp4'), 'OLD');
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', knownImports: new Set([7]) });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.mp4') });
    expect(readdirSync(dir).filter((f) => f.startsWith('media-7'))).toEqual(['media-7.mp4']);
  });
  it('目标已存在但 DB 没登记(D15:用户手工放的文件)→ 改用序号名,原文件不动', () => {
    writeFileSync(join(dir, 'media-7.mp4'), 'USERFILE');
    const r = placeVideo({ tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', knownImports: new Set() });
    expect(r).toEqual({ ok: true, path: join(dir, 'media-7.2.mp4') });
    expect(readdirSync(dir).find((f) => f === 'media-7.mp4')).toBe('media-7.mp4');
  });
  it('目标被占用(rename 抛 EPERM)→ ok:false reason:busy,不误报成功', () => {
    const r = placeVideo({
      tmpPath, mediaDir: dir, importId: 7, ext: 'mp4', knownImports: new Set(),
      // 注入:模拟 Windows 上"文件被占用"的 rename 失败
      rename: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
    } as never);
    expect(r).toEqual({ ok: false, reason: 'busy', message: '该视频正在被播放/处理，请先关闭预览再重试' });
    expect(findVideoFile(dir, 7)).toBeNull();
  });
  it('deleteVideoFiles:删掉该来源全部素材;不存在算空成功', () => {
    writeFileSync(join(dir, 'media-8.jpg'), 'x');
    expect(deleteVideoFiles(dir, 8).deleted).toEqual([join(dir, 'media-8.jpg')]);
    expect(deleteVideoFiles(dir, 8)).toEqual({ deleted: [], failed: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/media/media-files.test.ts`
Expected: FAIL —— 找不到模块 `./media-files.js`

- [ ] **Step 3: 写实现**

```ts
// server/src/media/media-files.ts
// 视频素材在磁盘上的落盘/删除(spec m1c-video-clip §0.4)。
// 覆盖语义集中在这里,路由层与 finalize 都只调它 —— 散开写必然出现"这里清了旧图、那里忘了"。
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pushLog } from '../logs.js';

/** 素材文件名前缀:一个来源一份,重下即覆盖 */
function prefixOf(importId: number): string { return `media-${importId}.`; }

/** 该来源名下现有的素材文件(可能多个扩展名) */
export function findVideoFiles(mediaDir: string, importId: number): string[] {
  try {
    return readdirSync(mediaDir).filter((f) => f.startsWith(prefixOf(importId))).sort().map((f) => join(mediaDir, f));
  } catch {
    return []; // 目录还没建过 → 没有素材,不算错
  }
}

/** 单份素材路径(取排序第一个);没有 → null */
export function findVideoFile(mediaDir: string, importId: number): string | null {
  return findVideoFiles(mediaDir, importId)[0] ?? null;
}

/** 清掉该来源名下除 keep 之外的素材文件。失败只记日志 —— 这是"删附属",不影响本体(spec §0.4 第 4 条) */
export function removeOtherVideos(mediaDir: string, importId: number, keep: string): void {
  for (const full of findVideoFiles(mediaDir, importId)) {
    if (full === keep) continue;
    try {
      unlinkSync(full);
      pushLog('info', 'media', `清掉旧素材 import=${importId} path=${full}`);
    } catch (e) {
      pushLog('error', 'media', `清旧素材失败 import=${importId} path=${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export type PlaceResult = { ok: true; path: string } | { ok: false; reason: 'busy' | 'io'; message: string };

/**
 * 把刚下好的临时视频搬进素材目录(固定名,重下覆盖)。
 * 关键点(spec §0.4):
 * 1. 目标位置已存在、但 DB 没登记过这个来源 → 那是**用户手工放的文件**,改用序号名,绝不覆盖(D15)
 * 2. rename 失败(Windows 上文件被 <video>/ffmpeg 占用 → EPERM/EBUSY/EACCES)= **本体失败**,必须报错。
 *    静默失败最坏:用户以为换了清晰度,其实还是旧的
 * 3. 落盘成功后再清同来源的其它扩展名(webm→mp4 时不留残骸)
 */
export function placeVideo(opts: {
  tmpPath: string; mediaDir: string; importId: number; ext: string;
  knownImports: Set<number>; exists?: (p: string) => boolean; rename?: (from: string, to: string) => void;
}): PlaceResult {
  const exists = opts.exists ?? existsSync;
  const doRename = opts.rename ?? renameSync;
  const prefix = prefixOf(opts.importId);
  try {
    mkdirSync(opts.mediaDir, { recursive: true });
  } catch { /* 建不出来让下面的 rename 自己报错 */ }
  let dest = join(opts.mediaDir, `${prefix}${opts.ext}`);
  if (exists(dest) && !opts.knownImports.has(opts.importId)) {
    let n = 2;
    while (exists(join(opts.mediaDir, `${prefix}${n}.${opts.ext}`))) n += 1;
    dest = join(opts.mediaDir, `${prefix}${n}.${opts.ext}`);
    pushLog('info', 'media', `目标已存在且非本工具产物,改用序号名 import=${opts.importId} dest=${dest}`);
  }
  try {
    doRename(opts.tmpPath, dest);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const busy = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
    pushLog('error', 'media', `素材落盘失败 import=${opts.importId} code=${err.code ?? '?'} dest=${dest} kind=${busy ? 'busy' : 'io'}`);
    return busy
      ? { ok: false, reason: 'busy', message: '该视频正在被播放/处理，请先关闭预览再重试' }
      : { ok: false, reason: 'io', message: `素材落盘失败（${err.code ?? '未知错误'}）` };
  }
  removeOtherVideos(opts.mediaDir, opts.importId, dest); // 换过扩展名时清掉旧的
  return { ok: true, path: dest };
}

/** 删该来源的素材文件。删不掉只记日志(与 DELETE /api/audio/:id 同款语义:DB 行删了就算"删了") */
export function deleteVideoFiles(mediaDir: string, importId: number): { deleted: string[]; failed: string[] } {
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const full of findVideoFiles(mediaDir, importId)) {
    try {
      unlinkSync(full);
      deleted.push(full);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') continue; // 已经不在了 → 等价于删掉了
      failed.push(full);
      pushLog('error', 'media', `删素材失败 import=${importId} path=${full} code=${err.code ?? '?'}`);
    }
  }
  return { deleted, failed };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/media/media-files.test.ts; npm test`
Expected: 新文件 6 passed；全量 195 passed

- [ ] **Step 5: 提交**（先申请）

```bash
git add server/src/media/media-files.ts server/src/media/media-files.test.ts
git commit -m "feat(media): 素材落盘覆盖语义(占用报错/清旧扩展名/不覆盖手工文件)"
```

---

### Task 4: ffmpeg 路径解析 + 抽音轨参数（纯函数）

**Files:**
- Create: `server/src/media/ffmpeg-path.ts`
- Create: `server/src/ffmpeg/clip-args.ts`
- Test: `server/src/ffmpeg/clip-args.test.ts`

**Interfaces:**
- Consumes: `probeBin`（`../bins.js`）、`createSettingsRepo`、`SETTINGS_KEYS`
- Produces:
  - `resolveFfmpegPath(db: DB): Promise<string | null>`
  - `buildClipArgs(o: ClipArgsOpts): string[]`；`type ClipArgsOpts = { inputPath: string; outPath: string; start: number; end: number; format: 'mp3'|'m4a'|'wav'; quality?: string }`

- [ ] **Step 1: 写失败的测试**

```ts
// server/src/ffmpeg/clip-args.test.ts
import { describe, expect, it } from 'vitest';
import { buildClipArgs } from './clip-args.js';

describe('buildClipArgs(抽音轨参数)', () => {
  it('mp3 + 码率:输出侧定位(实测 B:输入侧 -ss 会提前到前一个关键帧,起点不准)、-vn 丢视频、libmp3lame、带 -y', () => {
    expect(buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp3', start: 90, end: 210, format: 'mp3', quality: '192k' }))
      .toEqual(['-i', 'v.mp4', '-ss', '90', '-to', '210', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-y', 'o.mp3']);
  });
  it('wav:码率被忽略(wav 无损,码率无意义)、编码器用 pcm', () => {
    expect(buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.wav', start: 0, end: 5, format: 'wav', quality: '320k' }))
      .toEqual(['-i', 'v.mp4', '-ss', '0', '-to', '5', '-vn', '-c:a', 'pcm_s16le', '-y', 'o.wav']);
  });
  it('m4a + 无码率:不带 -b:a', () => {
    expect(buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.m4a', start: 1, end: 2, format: 'm4a' }))
      .toEqual(['-i', 'v.mp4', '-ss', '1', '-to', '2', '-vn', '-c:a', 'aac', '-y', 'o.m4a']);
  });
  it('小数秒原样透传(前端精度到 0.1s)', () => {
    const args = buildClipArgs({ inputPath: 'v.mp4', outPath: 'o.mp3', start: 12.5, end: 30.25, format: 'mp3' });
    expect(args.slice(2, 4)).toEqual(['-ss', '12.5', '-to', '30.25']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/ffmpeg/clip-args.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 写两个实现**

```ts
// server/src/media/ffmpeg-path.ts
// 为什么单独一个模块:剪辑路由与"重试剪辑任务"两条路径都要解析 ffmpeg,不能各写一份(spec D10)。
import { probeBin } from '../bins.js';
import type { DB } from '../db/index.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { pushLog } from '../logs.js';

/**
 * ffmpeg 路径:设置页配了就用它,空则扫 PATH。
 * 与既有 getFfprobe 的关键区别:那里拿不到就**静默跳过**(探测可选),这里拿不到剪辑整个不可用 → 返回 null 让上层报错。
 */
export async function resolveFfmpegPath(db: DB): Promise<string | null> {
  const configured = createSettingsRepo(db).get(SETTINGS_KEYS.binFfmpeg);
  if (configured !== null && configured.trim() !== '') return configured;
  const probed = await probeBin('ffmpeg');
  if (probed.path === null) pushLog('error', 'clip', 'ffmpeg 既未配置也不在 PATH —— 剪辑不可用');
  return probed.path;
}
```

```ts
// server/src/ffmpeg/clip-args.ts
// 纯函数:剪辑规格的极小版(只做"抽一段" + 格式/码率)。不碰 IO,便于参数快照断言。
// 未来 S4 的 EditSpec 编译器可以长在这旁边,共享"格式 → 编码器"这张表。
export interface ClipArgsOpts {
  inputPath: string; outPath: string; start: number; end: number;
  format: 'mp3' | 'm4a' | 'wav'; quality?: string;
}

const CODEC_BY_FORMAT: Record<ClipArgsOpts['format'], string[]> = {
  mp3: ['-c:a', 'libmp3lame'],
  m4a: ['-c:a', 'aac'],
  wav: ['-c:a', 'pcm_s16le'],
};

/**
 * 从视频里抽一段音频。
 * -ss/-to 放 `-i` **之后**(输出侧定位):实测 B(2026-09-30)证实输入侧 `-ss` 起点会提前落到前一个视频关键帧(约 1s 误差),
 * 输出侧逐样本精确(与整轨解码基准逐样本比对残差 0.0)。"画面上打的点"必须准,快那几秒没有意义。
 */
export function buildClipArgs(o: ClipArgsOpts): string[] {
  const args: string[] = ['-i', o.inputPath, '-ss', String(o.start), '-to', String(o.end), '-vn'];
  args.push(...CODEC_BY_FORMAT[o.format]);
  if (o.quality !== undefined && o.format !== 'wav') args.push('-b:a', o.quality);
  args.push('-y', o.outPath);
  return args;
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd server; npx vitest run src/ffmpeg/clip-args.test.ts; npx tsc --noEmit --pretty false`
Expected: 4 passed；typecheck 0 错

- [ ] **Step 5: 提交**（先申请）

```bash
git add server/src/media/ffmpeg-path.ts server/src/ffmpeg/clip-args.ts server/src/ffmpeg/clip-args.test.ts
git commit -m "feat(ffmpeg): 抽音轨参数纯函数 + ffmpeg 路径解析"
```

---

### Task 5: 抽音轨执行层（`clip.ts`）

**Files:**
- Create: `server/src/ffmpeg/clip.ts`
- Test: `server/src/ffmpeg/clip.test.ts`

**Interfaces:**
- Consumes: `buildClipArgs`、`ClipArgsOpts`（Task 4）
- Produces: `runClip(o: RunClipOpts): Promise<{ ok: boolean; stderr: string }>`
  - `RunClipOpts = ClipArgsOpts & { ffmpegPath: string; timeoutMs?: number; doExec?: ExecLike; fileSize?: (p: string) => number | null }`

- [ ] **Step 1: 写失败的测试**

```ts
// server/src/ffmpeg/clip.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runClip } from './clip.js';

const base = { ffmpegPath: 'ffmpeg', inputPath: 'v.mp4', outPath: 'o.mp3', start: 0, end: 10, format: 'mp3' as const };

describe('runClip', () => {
  it('成功:exit 0 且产物非空 → ok', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => cb(null, '', '')) as never;
    const r = await runClip({ ...base, doExec, fileSize: () => 1024 });
    expect(r.ok).toBe(true);
  });
  it('退出码 0 但没写出文件 → 失败,不误报(同 covers 的 writeCoverViaYtdlp 口径)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => cb(null, '', '')) as never;
    const r = await runClip({ ...base, doExec, fileSize: () => null });
    expect(r.ok).toBe(false);
  });
  it('产物 0 字节 → 失败', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => cb(null, '', '')) as never;
    expect((await runClip({ ...base, doExec, fileSize: () => 0 })).ok).toBe(false);
  });
  it('非零退出 → 失败且把 stderr 带回来(仓库铁律:不信 err.message 就够用)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException, so: string, se: string) => void) =>
      cb(Object.assign(new Error('boom'), { code: '1' }), '', 'Invalid data found when processing input')) as never;
    const r = await runClip({ ...base, doExec, fileSize: () => null });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('Invalid data found');
  });
  it('把参数原样交给 ffmpeg(binPath 是第一个参数、含 -vn)', async () => {
    const seen: { bin?: string; args?: string[] } = {};
    const doExec = ((b: string, a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => {
      seen.bin = b; seen.args = a; cb(null, '', '');
    }) as never;
    await runClip({ ...base, doExec, fileSize: () => 1 });
    expect(seen.bin).toBe('ffmpeg');
    expect(seen.args).toContain('-vn');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/ffmpeg/clip.test.ts`
Expected: FAIL —— 找不到模块

- [ ] **Step 3: 写实现**

```ts
// server/src/ffmpeg/clip.ts
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { pushLog } from '../logs.js';
import { buildClipArgs, type ClipArgsOpts } from './clip-args.js';

export type ExecLike = typeof execFile;

export interface RunClipOpts extends ClipArgsOpts {
  ffmpegPath: string;
  timeoutMs?: number;
  doExec?: ExecLike;
  /** 成功判定用;单测注入桩,避免为造"文件存在"真写磁盘 */
  fileSize?: (p: string) => number | null;
}

/**
 * 跑一次抽音轨。
 * 成功判定以"目标文件真出现且体积 > 0"为准 —— **不信退出码**
 * (同 covers.ts 的 writeCoverViaYtdlp:那边踩过"退出码 0 但没写出文件")。
 * 失败必须带 stderr(仓库铁律:永远不信 err.message 就够用 -> execFile 三参回调)。
 */
export function runClip(o: RunClipOpts): Promise<{ ok: boolean; stderr: string }> {
  const doExec = o.doExec ?? execFile;
  const sizeOf = o.fileSize ?? ((p: string) => {
    try { return statSync(p).size; } catch { return null; }
  });
  return new Promise((resolve) => {
    doExec(o.ffmpegPath, buildClipArgs(o), {
      timeout: o.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      const out = stderr ?? '';
      if (err) {
        const e = err as NodeJS.ErrnoException;
        pushLog('error', 'clip', `ffmpeg 失败 code=${e.code ?? '?'} stderr=${out.trim().slice(0, 300) || '(空)'}`);
        resolve({ ok: false, stderr: out });
        return;
      }
      const size = sizeOf(o.outPath);
      if (size === null || size <= 0) {
        pushLog('error', 'clip', `ffmpeg 退出码 0 但没写出产物 out=${o.outPath} stderr=${out.trim().slice(0, 300) || '(空)'}`);
        resolve({ ok: false, stderr: out });
        return;
      }
      resolve({ ok: true, stderr: out });
    });
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server; npx vitest run src/ffmpeg/clip.test.ts; npm test`
Expected: 新文件 5 passed；全量 204 passed

- [ ] **Step 5: 提交**（先申请）

```bash
git add server/src/ffmpeg/clip.ts server/src/ffmpeg/clip.test.ts
git commit -m "feat(ffmpeg): 抽音轨执行层(产物出现才判成功/失败带 stderr)"
```

---

### Task 6: 视频下载参数 + `findActiveByUrl` 参数化

**Files:**
- Modify: `server/src/ytdlp/args.ts`（`DownloadOptions` 加 `videoHeight`；新增 `buildVideoDownloadArgs`）
- Modify: `server/src/db/repo/jobs.ts:22,60-69`（`findActiveByUrl(url, kind)`）
- Modify: `server/src/ytdlp/ytdlp-routes.ts:325,617`（两处调用点补 kind）
- Test: `server/src/ytdlp/args.test.ts`、`server/src/db/repo/jobs.test.ts`（都追加用例）

**Interfaces:**
- Consumes: 无
- Produces:
  - `buildVideoDownloadArgs(opts: { url: string; outDir: string; videoHeight: 360|480|720|1080; cookiePath?: string }): string[]`
  - `findActiveByUrl(url: string, kind: string): { id: number } | null`

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/ytdlp/args.test.ts`：

```ts
describe('buildVideoDownloadArgs(下视频做定位素材)', () => {
  const base = { url: 'https://a/v', outDir: 'C:/tmp/job1', videoHeight: 480 as const };
  it('不含 -x(那是抽音频,会把视频流丢掉);强制 mp4 合流;要音轨(剪辑从它抽音)', () => {
    const args = buildVideoDownloadArgs(base);
    expect(args).not.toContain('-x');
    expect(args).toContain('--merge-output-format');
    expect(args[args.indexOf('--merge-output-format') + 1]).toBe('mp4');
    expect(args.join(' ')).toContain('height<=480');
  });
  it('带 cookie 时 --cookies 在 url 之前;输出模板在 outDir 下', () => {
    const args = buildVideoDownloadArgs({ ...base, cookiePath: 'C:/tmp/ck.txt' });
    expect(args.indexOf('--cookies')).toBeLessThan(args.indexOf('https://a/v'));
    expect(args[args.indexOf('-o') + 1]).toBe(join('C:/tmp/job1', '%(id)s.%(ext)s'));
  });
  it('进度模板与音频那条一致(前端进度条复用)', () => {
    expect(buildVideoDownloadArgs(base).join(' ')).toContain('--progress-template');
  });
});
```

追加到 `server/src/db/repo/jobs.test.ts`：

```ts
  it('findActiveByUrl 按 kind 区分:音频任务不挡视频任务', () => {
    const repo = createJobsRepo(db);
    const audioId = repo.create('ytdlp_download', { url: 'https://a/x' });
    expect(repo.findActiveByUrl('https://a/x', 'ytdlp_download')).toEqual({ id: audioId });
    expect(repo.findActiveByUrl('https://a/x', 'ytdlp_video')).toBeNull();
    void audioId;
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/ytdlp/args.test.ts src/db/repo/jobs.test.ts`
Expected: FAIL —— `buildVideoDownloadArgs` 未定义；`findActiveByUrl` 只接受 1 个参数

- [ ] **Step 3: 实现**

`args.ts` —— `DownloadOptions` 加一个可选字段 + 新函数：

```ts
export interface DownloadOptions {
  entryIndices?: number[];
  section?: { start: number; end: number };
  format: 'mp3' | 'm4a' | 'wav';
  quality?: string;
  /** 视频素材的清晰度**上限档**(spec 待实测 A 定表达式;默认 480) */
  videoHeight?: 360 | 480 | 720 | 1080;
}

/**
 * 下视频素材(带画面的时间标尺):**不是** -x,而是完整下视频 + 音轨。
 * 三个硬要求(spec D1/D2 + 待实测 D):
 * - `bv*+ba`:必须含音轨 —— 剪辑是从这个文件抽音频,只下视频流等于素材没法剪
 * - `--merge-output-format mp4`:Electron 是 Chromium,mkv 播不了
 * - 编解码偏好:只锁容器不够,B 站之外可能给 VP9/AV1 + Opus 装进 mp4 后"有画面没声音"
 *   (偏好名以 spec §0.1 实测 D 的结论为准)
 */
export function buildVideoDownloadArgs(opts: {
  url: string; outDir: string; videoHeight: 360 | 480 | 720 | 1080; cookiePath?: string;
}): string[] {
  const args: string[] = ['--newline', '--windows-filenames'];
  if (opts.cookiePath) args.push('--cookies', opts.cookiePath);
  args.push(
    '-f', `bv*[height<=${opts.videoHeight}]+ba/b[height<=${opts.videoHeight}]/b`,
    '-S', 'vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4',
    '--no-playlist',
  );
  args.push('--progress-template', '%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s');
  args.push('-o', join(opts.outDir, '%(id)s.%(ext)s'), opts.url);
  return args;
}
```

`jobs.ts` —— 签名与查询参数化：

```ts
  findActiveByUrl(url: string, kind: string): { id: number } | null;
```

```ts
    findActiveByUrl: (url, kind) => {
      const needle = JSON.stringify({ url }).slice(1, -1);
      const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
      const row = db
        .prepare("SELECT id FROM jobs WHERE kind=? AND status IN ('pending','running') AND payload LIKE ? ESCAPE '\\'")
        .get(kind, `%${esc}%`);
      return row && typeof (row as { id: unknown }).id === 'number' ? { id: (row as { id: number }).id } : null;
    },
```

`ytdlp-routes.ts` 两处调用点补 kind：`findActiveByUrl(url)` → `findActiveByUrl(url, 'ytdlp_download')`。

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `cd server; npx tsc --noEmit --pretty false; npm test`
Expected: typecheck 0 错；全量 208 passed

- [ ] **Step 5: 提交**（先申请）

```bash
git add server/src/ytdlp/args.ts server/src/ytdlp/args.test.ts server/src/db/repo/jobs.ts server/src/db/repo/jobs.test.ts server/src/ytdlp/ytdlp-routes.ts
git commit -m "feat(ytdlp): 视频下载参数 + findActiveByUrl 按 kind 区分"
```

---

### Task 7: `DownloadManager` 按 job 传扩展名集合

**没有这一步，视频下载会报"下载完成但未找到产物文件"，取消后还会在 temp 留半成品**（spec D5 + §0.1 事实 5）。

**Files:**
- Modify: `server/src/ytdlp/download.ts:13-19`（`StartOpts` 加 `exts`）、`:22-35`（`findLatestAudioFile` → `findLatestByExt`）、`:40-48`（`cleanJobOutputs`）、`:50-56`、`:78-95`、`:113-133`
- Test: `server/src/ytdlp/download.test.ts`（追加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `MEDIA_EXTS_AUDIO: string[]`（`['.mp3','.m4a','.wav']`）
  - `MEDIA_EXTS_VIDEO: string[]`（`['.mp4','.webm','.mkv']`）
  - `findLatestByExt(dir: string, exts: string[]): string | null`
  - `StartOpts` 新增 `exts: string[]`（**必填**，逼调用方明确表态）

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/ytdlp/download.test.ts`：

```ts
describe('DownloadManager 按 job 传扩展名集合(spec D5)', () => {
  it('findLatestByExt:只认传入的扩展名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-dl-'));
    writeFileSync(join(dir, 'a.mp3'), 'x');
    writeFileSync(join(dir, 'b.mp4'), 'y');
    expect(findLatestByExt(dir, MEDIA_EXTS_VIDEO)?.endsWith('b.mp4')).toBe(true);
    expect(findLatestByExt(dir, MEDIA_EXTS_AUDIO)?.endsWith('a.mp3')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it('取消时按传入扩展名清掉 .mp4 半成品(不是只看音频扩展名)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-dl-'));
    const dm = createDownloadManager({
      spawn: fakeSpawn as never,
      execFile: ((_b: string, _a: string[], _o: unknown, cb: () => void) => cb()) as never,
    });
    dm.start({ jobId: 1, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_VIDEO, onEvent: () => {} });
    writeFileSync(join(dir, 'x.mp4'), 'HALF');
    await dm.cancel(1);
    expect(existsSync(join(dir, 'x.mp4'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

> 说明：上面用到的 `fakeSpawn` 是现有测试文件里已有的桩；若名字不同，用文件里既有的那个（写这一步时先看一眼 `download.test.ts` 顶部，别新造一个）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/ytdlp/download.test.ts`
Expected: FAIL —— `findLatestByExt` / `MEDIA_EXTS_VIDEO` 未定义；`exts` 不被接受

- [ ] **Step 3: 实现（关键：扩展名集合必须与 outDir 同生共死）**

```ts
export const MEDIA_EXTS_AUDIO = ['.mp3', '.m4a', '.wav'];
export const MEDIA_EXTS_VIDEO = ['.mp4', '.webm', '.mkv']; // 实际产物由 --merge-output-format mp4 决定,多列两个防意外

/** 目录里 mtime 最新的、扩展名在 exts 里的文件(无则 null) */
export function findLatestByExt(dir: string, exts: string[]): string | null {
  try {
    return (
      readdirSync(dir)
        .map((f) => ({ name: f, p: join(dir, f) }))
        .filter((f) => exts.includes(f.name.slice(f.name.lastIndexOf('.')).toLowerCase()))
        .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs)[0]?.p ?? null
    );
  } catch {
    return null;
  }
}
```

`StartOpts`：

```ts
export interface StartOpts {
  jobId: number; binPath: string; args: string[]; outDir: string;
  /** 本 job 的产物扩展名集合(音频/视频不同)——**必填**,逼调用方明确表态(spec D5) */
  exts: string[];
  onEvent: (jobId: number, ev: DownloadEvent) => void;
}
```

管理器内部：把原来的 `activeOutDir` 保留，**新增 `activeExts`**，并在**每一处** `activeOutDir.delete/ set` 旁边同步处理 `activeExts`（`start` / `error` / `close` 的每个分支 / `cancel`）。`cleanJobOutputs` 改为：

```ts
  const cleanJobOutputs = (jobId: number, outDir: string): void => {
    const exts = activeExts.get(jobId) ?? [];
    const produced = findLatestByExt(outDir, exts);
    if (produced) { try { rmSync(produced, { force: true }); } catch { /* 尽力清理 */ } }
    activeOutDir.delete(jobId);
    activeExts.delete(jobId);
  };
```

并把 `findLatest` 依赖从 `createDownloadManager` 的 deps 里去掉（改为每个 job 用 `findLatestByExt(outDir, exts)`），`close` 分支同理。

- [ ] **Step 4: 跑测试 + 全量**

Run: `cd server; npx tsc --noEmit --pretty false; npm test`
Expected: typecheck 0 错；全量 210 passed（注意：`startDownload` 现在必须传 `exts`，Task 9 补上；如果此步 tsc 报 `ytdlp-routes.ts` 缺 `exts`，先在该调用处传 `MEDIA_EXTS_AUDIO` 让编译通过——这正是 Task 9 要按 produce 分支的地方）

- [ ] **Step 5: 提交**（先申请）

```bash
git add server/src/ytdlp/download.ts server/src/ytdlp/download.test.ts server/src/ytdlp/ytdlp-routes.ts
git commit -m "feat(ytdlp): DownloadManager 按 job 传产物扩展名集合(含取消清理)"
```

---

### Task 8: 抽出共享的 Range 文件发送

**为什么**：视频播放与音频播放必须同一套 Range 逻辑（spec D11/D12）——复制第二份必然漂移。

**Files:**
- Create: `server/src/http/file-range.ts`
- Modify: `server/src/ytdlp/ytdlp-routes.ts:684-723`（音频路由改用它）
- Test: `server/src/ytdlp/ytdlp-routes.test.ts`（**不改**，音频 Range 用例必须继续绿）

**Interfaces:**
- Consumes: `FastifyReply` / `FastifyRequest`
- Produces: `sendFileWithRange(req, reply, opts: { filePath: string; size: number; contentType: string })`

- [ ] **Step 1: 建模块（把音频路由里那段 Range 逻辑原样搬过来）**

```ts
// server/src/http/file-range.ts
// 2026-09-29 抽出:音频与视频两条路由共用一套 Range 语义。
// 为什么必须共用:浏览器拖进度条发 Range 期待 206,声明了 accept-ranges 却永远回 200 全量会把进度条锁死
// (音频那边实测踩过)。复制第二份 = 下次只改一处。
import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

export function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { filePath: string; size: number; contentType: string },
): FastifyReply {
  reply
    .header('content-type', opts.contentType)
    .header('content-disposition', 'inline')
    .header('accept-ranges', 'bytes');
  const range = req.headers.range;
  const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m !== null && ((m[1] ?? '') !== '' || (m[2] ?? '') !== '')) {
    const size = opts.size;
    const startRaw = m[1] ?? '';
    const endRaw = m[2] ?? '';
    const start = startRaw !== '' ? parseInt(startRaw, 10) : 0;
    const end = endRaw !== '' ? Math.min(parseInt(endRaw, 10), size - 1) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      reply.header('content-range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
    return reply.send(createReadStream(opts.filePath, { start, end }));
  }
  reply.header('content-length', opts.size);
  return reply.send(createReadStream(opts.filePath));
}
```

- [ ] **Step 2: 音频路由改用它**

`ytdlp-routes.ts:700-722` 那一段（从 `const range = req.headers.range;` 到最后的 `return reply.send(createReadStream(item.file_path));`）整段替换为：

```ts
    return sendFileWithRange(req, reply, {
      filePath: item.file_path,
      size: stat.size,
      contentType: MIME[item.format] ?? 'application/octet-stream',
    });
```

（`const stat = statSync(item.file_path);` 保留在上面；`createReadStream` 若本文件不再使用，从 import 里去掉）

- [ ] **Step 3: 跑测试确认音频 Range 行为不变**

Run: `cd server; npx tsc --noEmit --pretty false; npm test`
Expected: typecheck 0 错；全量 210 passed（音频 Range 的 206/416/200 用例必须仍绿）

- [ ] **Step 4: 提交**（先申请）

```bash
git add server/src/http/file-range.ts server/src/ytdlp/ytdlp-routes.ts
git commit -m "refactor(http): 抽出共享 Range 文件发送,音频路由改用"
```

---

### Task 9: 下载路由的 `produce` 分支 + 视频 finalize

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`
  - `DownloadJobPayload`（`:65-72` 加 `produce` / `options.videoHeight` 已在 options 里）
  - `createDownloadHandlers`（`:104-211`）：`startDownload` 按 produce 选参数与扩展名；`onEvent` 的 done 分支分流；新增 `finalizeVideoDownload`
  - download 路由（`:285-347`）：produce/videoHeight 校验、视频分支跳过判重、kind 选择
  - retry 路由（`:598-631`）：按旧 job 的 kind 建新 job + 分支到 clip
- Modify: `server/src/index.ts:75`（`registerYtdlpRoutes` 的 deps 补 `mediaDir`）
- Test: `server/src/ytdlp/ytdlp-routes.test.ts`（追加）

**Interfaces:**
- Consumes: `placeVideo`/`deleteVideoFiles`（Task 3）、`createSourceVideosRepo`（Task 2）、`buildVideoDownloadArgs`（Task 6）、`MEDIA_EXTS_VIDEO`（Task 7）、`startClipJob`（Task 10 —— 本任务先用「未接线时返回 501」的占位分支，Task 10 接上）
- Produces:
  - `YtdlpDeps` 新增 `mediaDir: string`
  - `DownloadJobPayload` 新增 `produce?: 'audio' | 'video'`
  - `done` 事件视频支：`{ type:'done', kind:'video', importId:number, title:string, filePath:string, height:number|null, fileSize:number }`
  - `clipStarter?: (jobId: number, payload: unknown) => Promise<void>`（Task 10 通过 index.ts 注入）

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/ytdlp/ytdlp-routes.test.ts`：

```ts
// 视频素材(2026-09-29 spec m1c-video-clip):下载进 <数据>/media/,不进 audio_items
describe('下载视频素材(produce=video)', () => {
  it('校验:produce 非法 → 400;videoHeight 非法 → 400;缺省 videoHeight 走 480', async () => {
    makeApp('yt-dlp');
    expect((await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'movie' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', videoHeight: 999 } })).statusCode).toBe(400);
  });
  it('produce 空串按 audio 处理(前端"没选"不是非法)', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as never);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: '', title: 't' } });
    expect(res.statusCode).toBe(201);
  });
  it('视频下载不参与音频判重(换清晰度重下不该被 409 拦住)', async () => {
    const audioRepo = createAudioItemsRepo(db);
    audioRepo.create({ title: 't', source_type: 'download', source_url: 'https://a/v', file_path: 'C:/x.mp3', format: 'mp3', duration_sec: 1, file_size: 1 });
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as never);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/v', options: { format: 'mp3' }, produce: 'video', title: 't' } });
    expect(res.statusCode).toBe(201);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/ytdlp/ytdlp-routes.test.ts -t "下载视频素材"`
Expected: FAIL —— 非法 produce 返回 201（没校验）

- [ ] **Step 3: 实现校验与分支**

download 路由（`createDownloadHandlers` 之外的注册处）加（**照抄同文件 `format` 校验那一处的 400 写法**）：

```ts
    // produce(2026-09-29 spec m1c-video-clip):空串/null/undefined 都按 audio(前端"没选"不是非法)
    const rawProduce = (body as { produce?: unknown }).produce;
    const blankProduce = rawProduce === undefined || rawProduce === null || rawProduce === '';
    if (!blankProduce && rawProduce !== 'audio' && rawProduce !== 'video') {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'produce 只能是 audio 或 video', next: '选择产物类型' } });
    }
    const produce: 'audio' | 'video' = rawProduce === 'video' ? 'video' : 'audio';

    const videoHeightRaw = (opt as { videoHeight?: unknown }).videoHeight;
    const videoHeight = Number(videoHeightRaw ?? 480);
    if (produce === 'video' && ![360, 480, 720, 1080].includes(videoHeight)) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'videoHeight 只能是 360|480|720|1080', next: '选择清晰度' } });
    }
```

**判重与并发检查按支分开**（spec §0.3）：

- **判重（409 DUPLICATE）只在 `produce === 'audio'` 支做**：视频重复下就是"覆盖素材"，被 409 拦住就没法换清晰度了。
- **BUSY 检查两支都做，但各用自己的 kind**：音频 `findActiveByUrl(url, 'ytdlp_download')`，视频 `findActiveByUrl(url, 'ytdlp_video')`。两个视频任务并发写同一个 `media-<id>.<ext>` 会让后一个覆盖前一个，必须挡。

kind 选择：

```ts
    // 其余字段与现有实现一致(照抄现在那几行的写法),只多一个 produce
    const payload: DownloadJobPayload = {
      url, options: body.options ?? {}, produce,
      title: typeof body.title === 'string' ? body.title : undefined,
      durationSec: typeof body.durationSec === 'number' ? body.durationSec : undefined,
      entryIndex, collectionTitle,
    };
    const jobId = jobsRepo.create(produce === 'video' ? 'ytdlp_video' : 'ytdlp_download', payload);
```

- [ ] **Step 4: 实现 `startDownload` 的两支与视频 finalize**

`startDownload` 里参数构造改为：

```ts
    const produce = payload.produce === 'video' ? 'video' : 'audio';
    const videoHeight = (Number((opt as { videoHeight?: unknown }).videoHeight ?? 480) as 360 | 480 | 720 | 1080);
    const args = produce === 'video'
      ? buildVideoDownloadArgs({ url: payload.url, outDir: jobOutDir, videoHeight, cookiePath: resolveCookiePath(db, audioDir) })
      : buildDownloadArgs({ url: payload.url, options: { entryIndices: opt.entryIndices, section: opt.section, format: (opt.format ?? 'mp3') as 'mp3'|'m4a'|'wav', quality: opt.quality }, outDir: jobOutDir, cookiePath: resolveCookiePath(db, audioDir) });
```

`downloadManager.start` 加 `exts: produce === 'video' ? MEDIA_EXTS_VIDEO : MEDIA_EXTS_AUDIO`；
`onEvent` 的 done 分支：

```ts
        if (ev.type === 'status' && ev.state === 'done' && ev.producedPath) {
          pushLog('info', 'job', `job ${jid} 下载完成 → 进入入库`);
          emit(jid, { type: 'phase', phase: 'ingest' });
          if (produce === 'video') void finalizeVideoDownload(jid, payload, ev.producedPath, videoHeight);
          else void finalizeDownload(jid, payload, ev.producedPath);
        }
```

新增（放在 `finalizeDownload` 旁边）：

```ts
  /**
   * 视频素材 finalize(spec §0.3/§0.4):落 <数据>/media/,记 source_videos,**不进 audio_items**。
   * 失败语义与音频一致:回滚/置 error/推 SSE;但"目标被占用"是**本体失败**,必须报错(spec §0.4 第 2 条)。
   */
  async function finalizeVideoDownload(jobId: number, payload: DownloadJobPayload, producedPath: string, videoHeight: number): Promise<void> {
    try {
      const importsRepo = createImportsRepo(db);
      // importId 反查(spec §0.3):UI 流程 parse 必先跑过;直接打 API 可能没有 → 兜底 upsert,不在下载中途报错
      let row = importsRepo.getByUrl(payload.url);
      if (row === null) {
        const id = importsRepo.upsertByUrl({
          url: payload.url, title: payload.title ?? '未命名', site: detectSite(payload.url),
          kind: 'single', duration_sec: null, entries: null,
        });
        row = importsRepo.get(id);
      }
      if (row === null) throw new Error('导入来源反查失败');
      const ext = producedPath.slice(producedPath.lastIndexOf('.') + 1).toLowerCase();
      const videosRepo = createSourceVideosRepo(db);
      const known = new Set(videosRepo.list().map((v) => v.import_id));
      const placed = placeVideo({ tmpPath: producedPath, mediaDir, importId: row.id, ext, knownImports: known });
      if (!placed.ok) throw new Error(placed.message);
      const size = statSync(placed.path).size;
      videosRepo.upsert({ importId: row.id, filePath: placed.path, height: videoHeight, fileSize: size });
      jobsRepo.finish(jobId);
      pushLog('info', 'job', `job ${jobId} done → video import=${row.id} @ ${placed.path} height=${videoHeight} bytes=${size}`);
      emit(jobId, { type: 'done', kind: 'video', importId: row.id, title: row.title, filePath: placed.path, height: videoHeight, fileSize: size });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      jobsRepo.fail(jobId, msg);
      pushLog('error', 'job', `job ${jobId} 视频入库失败: ${msg}`);
      emit(jobId, { type: 'status', state: 'error', message: msg });
    }
  }
```

并在 `createDownloadHandlers` 的返回里加 `finalizeVideoDownload`；`const { db, binProvider, downloadManager, audioDir, tempDir, token } = deps;` 那行加 `mediaDir`。

- [ ] **Step 5: 实现 retry 按 kind 分支**

retry 路由里把 `jobsRepo.create('ytdlp_download', payload)` 那处改成：

```ts
    // 视频任务重试:沿用 ytdlp_video;剪辑任务重试:交给剪辑启动器(Task 10 注入)
    const kind = old.kind === 'ytdlp_video' ? 'ytdlp_video' : old.kind === 'ffmpeg_clip' ? 'ffmpeg_clip' : 'ytdlp_download';
    if (kind === 'ffmpeg_clip') {
      const payload = JSON.parse(old.payload) as { videoPath?: string };
      if (typeof payload.videoPath !== 'string' || !existsSync(payload.videoPath)) {
        return reply.code(409).send({ ok: false, error: { code: 'MEDIA_GONE', message: '素材已不存在，请重新下载视频', next: '回到获取页重新下视频' } });
      }
      if (deps.clipStarter === undefined) return reply.code(500).send({ ok: false, error: { code: 'NOT_WIRED', message: '剪辑重试未接线', next: '' } });
      const newId = jobsRepo.create('ffmpeg_clip', JSON.parse(old.payload));
      await deps.clipStarter(newId, JSON.parse(old.payload));
      return { ok: true, jobId: newId };
    }
    const newId = jobsRepo.create(kind, payload);
```

- [ ] **Step 6: 跑测试 + 全量**

Run: `cd server; npx tsc --noEmit --pretty false; npm test`
Expected: typecheck 0 错；全量 ≥ 213 passed

- [ ] **Step 7: 提交**（先申请）

```bash
git add server/src/ytdlp/ytdlp-routes.ts server/src/ytdlp/ytdlp-routes.test.ts server/src/index.ts
git commit -m "feat(ytdlp): produce=video 分支与视频 finalize(落 media/ 记 source_videos)"
```

---

### Task 10: 剪辑 job + 媒体路由 + 接线

**Files:**
- Create: `server/src/media/clip-job.ts`
- Create: `server/src/media/media-routes.ts`
- Modify: `server/src/index.ts`（建 `mediaDir`、注册 media 路由、注入 `clipStarter`、守卫豁免视频文件路由）
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（`DELETE /api/imports/:id` 里清素材）
- Test: `server/src/media/media-routes.test.ts`

**Interfaces:**
- Consumes: `resolveFfmpegPath`（T4）、`runClip`（T5）、`createSourceVideosRepo`（T2）、`findVideoFile`/`deleteVideoFiles`（T3）、`sendFileWithRange`（T8）、`emit`/`addSseConnection`（T1）、`ingestDownloadedFile`、`probeDuration`
- Produces:
  - `type ClipJobPayload = { importId: number; videoPath: string; start: number; end: number; format: 'mp3'|'m4a'|'wav'; quality?: string; title?: string }`
  - `startClipJob(jobId: number, payload: ClipJobPayload, deps: { db: DB; audioDir: string; tempDir: string }): Promise<void>`
  - `registerMediaRoutes(app: FastifyInstance, deps: { db: DB; audioDir: string; tempDir: string; mediaDir: string; token: string }): void`
  - 剪辑产物标题拼法：`formatClipTitle(prefix: string, start: number, end: number): string`

- [ ] **Step 1: 写失败的测试**

```ts
// server/src/media/media-routes.test.ts
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import { formatClipTitle, registerMediaRoutes } from './media-routes.js';

let app: ReturnType<typeof Fastify>;
let db: DB;
let root: string;
let audioDir: string;
let mediaDir: string;
let tempDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-mr-'));
  audioDir = join(root, 'audio'); mediaDir = join(root, 'media'); tempDir = join(root, 'tmp');
  mkdirSync(audioDir, { recursive: true }); mkdirSync(mediaDir, { recursive: true }); mkdirSync(tempDir, { recursive: true });
  db = openDatabase(':memory:');
  initSchema(db);
  app = Fastify({ logger: false });
  registerMediaRoutes(app, { db, audioDir, tempDir, mediaDir, token: 'tok' });
});
afterEach(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

describe('媒体素材路由', () => {
  it('GET /api/media 只列有素材的来源(带 url/title/site/height)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: '凡人', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null });
    createImportsRepo(db).upsertByUrl({ url: 'https://a/other', title: '无素材', site: 'other', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${importId}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId, filePath: join(mediaDir, `media-${importId}.mp4`), height: 480, fileSize: 1 });
    const res = await app.inject({ method: 'GET', url: '/api/media?token=tok' });
    const body = res.json() as { media: Array<{ import_id: number; url: string; height: number }> };
    expect(body.media).toHaveLength(1);
    expect(body.media[0]).toMatchObject({ import_id: importId, url: 'https://a/pl', height: 480 });
  });
  it('GET /api/media/:id/file:Range 206 与全量 200;非正整数 404;文件丢了给 FILE_MISSING', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, '0123456789');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
    expect((await app.inject({ method: 'GET', url: `/api/media/0/file?token=tok` })).statusCode).toBe(404);
    const full = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    const part = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok`, headers: { range: 'bytes=2-5' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    rmSync(p, { force: true });
    const gone = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok` });
    expect(gone.statusCode).toBe(404);
    expect((gone.json() as { error: { code: string } }).error.code).toBe('FILE_MISSING');
  });
  it('DELETE /api/media/:id 只删素材行(来源行还在)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${importId}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId, filePath: join(mediaDir, `media-${importId}.mp4`), height: 480, fileSize: 1 });
    expect((await app.inject({ method: 'DELETE', url: `/api/media/${importId}?token=tok` })).statusCode).toBe(200);
    expect(createSourceVideosRepo(db).get(importId)).toBeNull();
    expect(createImportsRepo(db).get(importId)).not.toBeNull();
  });
  it('POST /api/media/:id/clip 校验:起止非法 400 / 没素材 404', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${importId}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId, filePath: join(mediaDir, `media-${importId}.mp4`), height: 480, fileSize: 1 });
    expect((await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 10, end: 5, format: 'mp3' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 0, end: 5, format: 'ogg' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/media/999/clip?token=tok`, payload: { start: 0, end: 5, format: 'mp3' } })).statusCode).toBe(404);
  });
  it('formatClipTitle:标题自带时间段(m:ss,补齐两位)', () => {
    expect(formatClipTitle('凡人修仙传 第 94 集', 90, 210)).toBe('凡人修仙传 第 94 集 [01:30-03:30]');
    expect(formatClipTitle('x', 5, 65)).toBe('x [00:05-01:05]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server; npx vitest run src/media/media-routes.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写 `clip-job.ts`**

```ts
// server/src/media/clip-job.ts
// 剪辑任务(spec D6/D7/D8):从视频素材抽一段音频 → 走既有 ingest 入库为普通音频行。
// 两条触发路径共用:POST /api/media/:id/clip 与"重试剪辑任务"。
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import type { DB } from '../db/index.js';
import { runClip } from '../ffmpeg/clip.js';
import { pushLog } from '../logs.js';
import { emit } from '../ytdlp/job-events.js';
import { ingestDownloadedFile } from '../ytdlp/ingest.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export interface ClipJobPayload {
  importId: number; videoPath: string; start: number; end: number;
  format: 'mp3' | 'm4a' | 'wav'; quality?: string; title?: string; sourceUrl?: string;
}

/** 时间码:分:秒(秒补齐两位);用于标题自带时间段(spec D8) */
function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 剪辑产物标题 = 前缀 + 时间段。**由服务端强制拼** —— 前端传的 title 只作前缀(spec D8) */
export function formatClipTitle(prefix: string, start: number, end: number): string {
  return `${prefix} [${mmss(start)}-${mmss(end)}]`;
}
```

```ts
function ffprobePathFrom(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

export async function startClipJob(
  jobId: number, payload: ClipJobPayload, deps: { db: DB; audioDir: string; tempDir: string },
): Promise<void> {
  const jobsRepo = createJobsRepo(deps.db);
  jobsRepo.update(jobId, { status: 'running' });
  // 临时产物名唯一(spec D14):同族于 cookies.txt 被并发写坏那次
  const tmpOut = join(deps.tempDir, `clip-${jobId}-${Date.now()}.${payload.format}`);
  const fail = (msg: string): void => {
    try { rmSync(tmpOut, { force: true }); } catch { /* 尽力清理:失败不留半成品 */ }
    jobsRepo.fail(jobId, msg);
    pushLog('error', 'clip', `job ${jobId} 失败: ${msg}`);
    emit(jobId, { type: 'status', state: 'error', message: msg });
  };
  try {
    if (!existsSync(payload.videoPath)) { fail('素材已不存在，请重新下载视频'); return; }
    const ffmpegPath = await resolveFfmpegPath(deps.db);
    if (ffmpegPath === null) { fail('ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径'); return; }
    emit(jobId, { type: 'phase', phase: 'ingest' });
    const r = await runClip({
      ffmpegPath, inputPath: payload.videoPath, outPath: tmpOut,
      start: payload.start, end: payload.end, format: payload.format, quality: payload.quality,
    });
    if (!r.ok) { fail(`剪辑失败：${r.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(ffmpeg 无 stderr 输出)'}`); return; }
    // 时长以 ffprobe 实测为准(spec §0.3:end 超素材长度时允许,但必须留痕)
    const ffprobePath = ffprobePathFrom(ffmpegPath);
    const realDuration = await probeDuration(ffprobePath, tmpOut);
    pushLog('info', 'clip', `job ${jobId} 请求区间 ${payload.start}-${payload.end}s,实测产出 ${realDuration ?? '?'}s`);
    const audioRepo = createAudioItemsRepo(deps.db);
    const result = ingestDownloadedFile({
      tmpPath: tmpOut,
      title: formatClipTitle(payload.title ?? '剪辑音频', payload.start, payload.end),
      format: payload.format, durationSec: realDuration,
      fileSize: statSync(tmpOut).size,
      sourceUrl: payload.sourceUrl !== undefined && payload.sourceUrl !== '' ? payload.sourceUrl : null, // 记原视频地址 → 音频库的分组/封面/外链自动复用(spec D7);空串统一转 null
      entryIndex: null, collectionTitle: null,
      audioDir: deps.audioDir, exists: existsSync, audioRepo,
    });
    jobsRepo.finish(jobId);
    pushLog('info', 'clip', `job ${jobId} done → audio ${result.audioId} @ ${result.finalPath}`);
    emit(jobId, { type: 'done', kind: 'audio', audioId: result.audioId, title: formatClipTitle(payload.title ?? '剪辑音频', payload.start, payload.end), format: payload.format, filePath: result.finalPath, replaced: false });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 4: 写 `media-routes.ts`**

```ts
// server/src/media/media-routes.ts
// 媒体素材路由(spec §0.3):列表 / 视频流(带 Range) / 删素材 / 剪音频。
import type { FastifyInstance } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { createImportsRepo } from '../db/repo/imports.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import type { DB } from '../db/index.js';
import { isAllowedLocalOrigin, isLocalPageReferer } from '../http/cors.js';
import { sendFileWithRange } from '../http/file-range.js';
import { pushLog } from '../logs.js';
import { deleteVideoFiles } from './media-files.js';
import { startClipJob, type ClipJobPayload } from './clip-job.js';

export { formatClipTitle } from './clip-job.js';

const MEDIA_MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };

export function registerMediaRoutes(
  app: FastifyInstance,
  deps: { db: DB; audioDir: string; tempDir: string; mediaDir: string; token: string },
): void {
  const { db, mediaDir, token } = deps;
  const videosRepo = createSourceVideosRepo(db);

  app.get('/api/media', async () => ({ ok: true, media: videosRepo.list() }));

  app.get('/api/media/:importId/file', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    // 鉴权口径与 /api/audio/:id/file 完全一致:<video> 不带 Origin、页面加不了 header → 认本机 Referer
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      pushLog('error', 'media', `media file 401 import=${importId} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} referer=${req.headers.referer ?? '(none)'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const row = videosRepo.get(importId);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (!existsSync(row.file_path)) {
      // 两种成因文案不同(spec §0.3):来源已删 → 素材行也会被清,能走到这里说明是文件被外部删了
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到获取页重新下视频' } });
    }
    const stat = statSync(row.file_path);
    const ext = row.file_path.slice(row.file_path.lastIndexOf('.') + 1).toLowerCase();
    return sendFileWithRange(req, reply, {
      filePath: row.file_path, size: stat.size,
      contentType: MEDIA_MIME[ext] ?? 'application/octet-stream',
    });
  });

  app.delete('/api/media/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (videosRepo.get(importId) === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const r = deleteVideoFiles(mediaDir, importId); // 删文件失败不让接口失败(与 DELETE /api/audio/:id 同款语义)
    videosRepo.delete(importId);
    pushLog('info', 'media', `素材已删 import=${importId} deleted=${r.deleted.length} failed=${r.failed.length}`);
    return { ok: true, deleted: r.deleted.length };
  });

  app.post('/api/media/:importId/clip', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const body = (req.body ?? {}) as { start?: unknown; end?: unknown; format?: unknown; quality?: unknown; title?: unknown };
    if (!['mp3', 'm4a', 'wav'].includes(String(body.format))) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'format 必须是 mp3|m4a|wav', next: '选择输出格式' } });
    }
    if (typeof body.start !== 'number' || typeof body.end !== 'number' || body.start < 0 || body.end <= body.start) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '起止时间无效', next: '需满足 0 ≤ start < end' } });
    }
    const video = videosRepo.get(importId);
    if (!video) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '先下载视频' } });
    if (!existsSync(video.file_path)) {
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '' } });
    }
    const importRow = createImportsRepo(db).get(importId);
    const payload: ClipJobPayload = {
      importId, videoPath: video.file_path, start: body.start, end: body.end,
      format: body.format as 'mp3' | 'm4a' | 'wav',
      quality: typeof body.quality === 'string' ? body.quality : undefined,
      // 前缀默认取来源标题;时间段由服务端拼(spec D8)
      title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title : (importRow?.title ?? '剪辑音频'),
      sourceUrl: importRow?.url,
    };
    const jobId = createJobsRepo(db).create('ffmpeg_clip', payload);
    pushLog('info', 'clip', `job ${jobId} created import=${importId} ${body.start}-${body.end}s format=${String(body.format)}`);
    await startClipJob(jobId, payload, { db, audioDir: deps.audioDir, tempDir: deps.tempDir });
    return reply.code(201).send({ ok: true, jobId });
  });
}
```

- [ ] **Step 5: `index.ts` 接线**

```ts
    const audioDir = path.join(path.dirname(opts.dbPath), 'audio');
    mkdirSync(audioDir, { recursive: true });
    const mediaDir = path.join(path.dirname(opts.dbPath), 'media');   // 视频素材(spec D3)
    mkdirSync(mediaDir, { recursive: true });
```

`registerYtdlpRoutes` 的 deps 加 `mediaDir` 与：

```ts
      clipStarter: async (jobId, payload) => {
        await startClipJob(jobId, payload as ClipJobPayload, { db, audioDir, tempDir: opts.tempDir });
      },
```

注册 media 路由（放在 ytdlp 之后）：

```ts
    registerMediaRoutes(app, { db, audioDir, tempDir: opts.tempDir, mediaDir, token });
```

守卫豁免加一行（与 audio file 同款，`<video>` 也带不了 header）：

```ts
      if (/^\/api\/media\/\d+\/file$/.test(pathname)) return;
```

- [ ] **Step 6: `DELETE /api/imports/:id` 清素材**

在既有 `DELETE /api/imports/:id` 里，删来源行之后补（外键不生效，必须显式删 —— spec §0.1 事实 6）：

```ts
    // 素材一并清(spec §0.4):外键没开,级联不会发生
    const v = createSourceVideosRepo(db).get(id);
    if (v !== null) {
      const r = deleteVideoFiles(mediaDir, id);
      createSourceVideosRepo(db).delete(id);
      pushLog('info', 'media', `来源 ${id} 删除 → 连带删素材 deleted=${r.deleted.length} failed=${r.failed.length}`);
    }
```

- [ ] **Step 7: 跑测试 + 全量 + 端到端（用真 ffmpeg 跑一次剪辑）**

Run: `cd server; npx tsc --noEmit --pretty false; npm test`
Expected: typecheck 0 错；全量 ≥ 218 passed

- [ ] **Step 8: 提交**（先申请）

```bash
git add server/src/media/clip-job.ts server/src/media/media-routes.ts server/src/media/media-routes.test.ts server/src/index.ts server/src/ytdlp/ytdlp-routes.ts
git commit -m "feat(media): 素材路由 + 剪辑 job(ffmpeg 抽音轨后走 ingest 入库)"
```

---

### Task 11: web 契约增补（`api.ts`）

**Files:**
- Modify: `web/src/api.ts`（新增 4 个函数与类型；`startDownload` payload 加字段；`subscribeJob.onDone` 改成联合类型）

**Interfaces:**
- Consumes: 既有 `apiGet` / `apiPost` / `apiDelete` / `apiToken` / `API_BASE`
- Produces:
  - `interface MediaItem { import_id: number; url: string; title: string; site: string; height: number | null; file_size: number | null; created_at: string }`
  - `listMedia(): Promise<MediaItem[]>`
  - `mediaFileUrl(importId: number): string`
  - `deleteMedia(importId: number): Promise<{ ok: boolean; deleted: number }>`
  - `clipMedia(importId: number, payload: { start: number; end: number; format: 'mp3'|'m4a'|'wav'; quality?: string; title?: string }): Promise<{ ok: boolean; jobId: number }>`
  - `startDownload` payload 增 `produce?: 'audio'|'video'`、`options.videoHeight?: 360|480|720|1080`
  - `subscribeJob` 的 `onDone` 改为 `(d: DoneEvent) => void`，`type DoneEvent = { kind?: 'audio'; audioId: number; title: string; format: string; replaced?: boolean } | { kind: 'video'; importId: number; title: string; filePath: string; height: number | null; fileSize: number }`

- [ ] **Step 1: 加类型与四个函数**

```ts
// ---- 视频素材(2026-09-29 spec m1c-video-clip:视频当"带画面的时间标尺",只用于定位,不进音频库) ----
export interface MediaItem {
  import_id: number; url: string; title: string; site: string;
  height: number | null;          // 下载时选的档位(不是实测分辨率)
  file_size: number | null;
  created_at: string;
}

export async function listMedia(): Promise<MediaItem[]> {
  const r = await apiGet<{ ok: boolean; media: MediaItem[] }>('/api/media');
  return r.media;
}

/** 素材视频流地址:<video> 走 Range 请求,和 audioFileUrl 同款(query token) */
export function mediaFileUrl(importId: number): string {
  const token = apiToken();
  logFe('debug', `mediaFileUrl import=${importId} token=${token ? 'query' : 'none'}`);
  return `${API_BASE}/api/media/${importId}/file?token=${encodeURIComponent(token ?? '')}`;
}

export async function deleteMedia(importId: number): Promise<{ ok: boolean; deleted: number }> {
  logFe('info', `deleteMedia import=${importId}`);
  return apiDelete<{ ok: boolean; deleted: number }>(`/api/media/${importId}`);
}

export async function clipMedia(
  importId: number,
  payload: { start: number; end: number; format: 'mp3' | 'm4a' | 'wav'; quality?: string; title?: string },
): Promise<{ ok: boolean; jobId: number }> {
  logFe('info', `clipMedia import=${importId} ${payload.start}-${payload.end}s format=${payload.format}`);
  return apiPost<{ ok: boolean; jobId: number }>(`/api/media/${importId}/clip`, payload);
}
```

`startDownload` 的入参类型加：

```ts
  options: { entryIndices?: number[]; section?: { start: number; end: number }; videoHeight?: 360 | 480 | 720 | 1080; format: 'mp3' | 'm4a' | 'wav'; quality?: string; force?: boolean };
  produce?: 'audio' | 'video';
```

`subscribeJob`：

```ts
export type DoneEvent =
  | { kind?: 'audio'; audioId: number; title: string; format: string; replaced?: boolean }
  | { kind: 'video'; importId: number; title: string; filePath: string; height: number | null; fileSize: number };

export function subscribeJob(jobId: number, handlers: {
  onProgress?: (p: { percent: number }) => void;
  onPhase?: (p: { phase: 'ingest' }) => void;
  onDone?: (d: DoneEvent) => void;
  onStatus?: (s: { state: string; message?: string }) => void;
  onError?: (msg: string) => void;
}): () => void {
```

> `onDone` 收了窄类型后，既有调用点（`acquire.tsx`）要加类型守卫：`if (d.kind === 'video') { ... } else { d.title }`。这一步会引出 `tsc` 报错，**Task 13 一并修**；本任务先跑 tsc 看清单，把报错位置记下来。

- [ ] **Step 2: 跑类型检查**

Run: `cd web; npx tsc --noEmit --pretty false`
Expected: 只剩 `acquire.tsx` 里 `onDone` 相关的 1–2 处报错（其余 0）。若出现别的错，说明改到了不该改的地方，回退。

- [ ] **Step 3: 提交**（先申请）

```bash
git add web/src/api.ts
git commit -m "feat(web): media 接口契约(listMedia/mediaFileUrl/deleteMedia/clipMedia)"
```

---

### Task 12: 新模式组件（`VideoClipPanel.tsx`）

**Files:**
- Create: `web/src/components/VideoClipPanel.tsx`

**Interfaces:**
- Consumes: Task 11 的四个函数 + `startDownload` / `subscribeJob` / `logger`；`SiteLogo` 组件；antd
- Produces: `export default function VideoClipPanel(props: { source: ImportSource | null }): JSX.Element`

**前端无测试框架** → 本任务的验证 = `tsc` + Task 13 之后的浏览器实测。

- [ ] **Step 1: 写组件（下视频 → 打点 → 剪）**

```tsx
// web/src/components/VideoClipPanel.tsx
// 获取页「视频预览剪音频」模式(2026-09-29 spec m1c-video-clip)。
// 为什么单独一个文件:acquire.tsx 已经很长,这个模式的交互(下视频/打点/剪)是自成一体的。
import { Alert, Button, Empty, InputNumber, Modal, Progress, Radio, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  clipMedia, deleteMedia, listMedia, mediaFileUrl, startDownload, subscribeJob,
  type DoneEvent, type ImportSource, type MediaItem,
} from '@/api';
import SiteLogo from '@/components/SiteLogo';

const HEIGHTS = [360, 480, 720, 1080] as const;
type Height = (typeof HEIGHTS)[number];

/** 秒 → mm:ss.s(打点输入框显示用) */
function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
/** 字节 → 人类可读 */
function humanSize(bytes: number | null): string {
  if (bytes === null) return '大小未知';
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function VideoClipPanel({ source }: { source: ImportSource | null }) {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [height, setHeight] = useState<Height>(480);
  const [current, setCurrent] = useState<MediaItem | null>(null);
  const [start, setStart] = useState<number>(0);
  const [end, setEnd] = useState<number>(0);
  const [now, setNow] = useState<number>(0);
  const [format, setFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [jobId, setJobId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const refresh = (): void => {
    listMedia().then((list) => {
      setMedia(list);
      // 当前选中的素材可能已被删/被换 → 重新对齐
      setCurrent((cur) => (cur === null ? null : list.find((m) => m.import_id === cur.import_id) ?? null));
    }).catch((e: Error) => setError(e.message));
  };
  useEffect(refresh, []);
  // 切来源时自动选中它的素材(有就进打点,没有就等下载)
  useEffect(() => {
    if (source === null) return;
    setCurrent(media.find((m) => m.import_id === source.id) ?? null);
    setStart(0); setEnd(0); setMsg(null); setError(null);
  }, [source, media]);

  // job 生命周期:完成提示 + 素材列表刷新
  useEffect(() => {
    if (jobId === null) return undefined;
    return subscribeJob(jobId, {
      onDone: (d: DoneEvent) => {
        setMsg(d.kind === 'video' ? `已下好视频素材（${d.height ?? '?'}p）` : `《${d.title}》已入库`);
        refresh();
      },
      onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') setError(s.message ?? s.state); },
    });
  }, [jobId]);

  const onDownloadVideo = async (): Promise<void> => {
    if (source === null || busy) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await startDownload({
        url: source.url, title: source.title,
        produce: 'video', options: { videoHeight: height, format: 'mp3' },
      });
      setJobId(r.jobId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onClip = async (): Promise<void> => {
    if (current === null || busy) return;
    if (!(end > start)) { setError('结束时间必须大于开始时间'); return; }
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await clipMedia(current.import_id, { start, end, format });
      setJobId(r.jobId);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const onDeleteMedia = (m: MediaItem): void => {
    // 破坏性操作必须二次确认(仓库规则),写清"删什么 / 不连带删什么"
    Modal.confirm({
      title: `删除素材《${m.title}》?`,
      content: '只删除本地的视频素材文件，已剪出的音频不受影响。下次想再剪需要重新下载视频。',
      okText: '删除', okType: 'danger', cancelText: '取消',
      onOk: async () => { await deleteMedia(m.import_id); if (current?.import_id === m.import_id) setCurrent(null); refresh(); },
    });
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {error && <Alert type="error" showIcon message={error} />}
      {msg && <Alert type="success" showIcon message={msg} />}

      <Space wrap>
        <Typography.Text type="secondary">{source === null ? '先在左侧选一个来源' : `来源：${source.title}`}</Typography.Text>
        <Radio.Group size="small" value={height} onChange={(e) => setHeight(e.target.value as Height)} disabled={busy}>
          {HEIGHTS.map((h) => <Radio.Button key={h} value={h}>{h}p</Radio.Button>)}
        </Radio.Group>
        <Button type="primary" onClick={() => void onDownloadVideo()} loading={busy} disabled={source === null}>
          {current === null ? '下视频' : '重新下视频（覆盖当前素材）'}
        </Button>
      </Space>

      {jobId !== null && busy && <Progress percent={100} status="active" showInfo={false} />}

      {current === null ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有这个来源的视频素材——先点「下视频」" />
      ) : (
        <>
          <video
            ref={videoRef}
            controls
            src={mediaFileUrl(current.import_id)}
            style={{ width: '100%', maxHeight: 420, background: '#000' }}
            onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
            onError={() => setError('素材文件已丢失，请重新下载视频')}
          />
          <Space wrap>
            <Typography.Text>当前 {fmt(now)}</Typography.Text>
            <Button size="small" onClick={() => setStart(Math.round(now * 10) / 10)}>设为起点</Button>
            <Button size="small" onClick={() => setEnd(Math.round(now * 10) / 10)}>设为终点</Button>
            <Typography.Text type="secondary">起点</Typography.Text>
            <InputNumber size="small" min={0} step={0.1} value={start} onChange={(v) => setStart(Number(v ?? 0))} />
            <Typography.Text type="secondary">终点</Typography.Text>
            <InputNumber size="small" min={0} step={0.1} value={end} onChange={(v) => setEnd(Number(v ?? 0))} />
            <Radio.Group size="small" value={format} onChange={(e) => setFormat(e.target.value as 'mp3' | 'm4a' | 'wav')}>
              <Radio.Button value="mp3">mp3</Radio.Button>
              <Radio.Button value="m4a">m4a</Radio.Button>
              <Radio.Button value="wav">wav</Radio.Button>
            </Radio.Group>
            <Button type="primary" onClick={() => void onClip()} loading={busy}>剪出音频</Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            区间 {fmt(start)} – {fmt(end)}（{Math.max(0, Math.round((end - start) * 10) / 10)} 秒）
          </Typography.Text>
        </>
      )}

      <div>
        <Typography.Text strong>已下过的素材</Typography.Text>
        {media.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无素材" />
        ) : (
          media.map((m) => (
            <div key={m.import_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f0f0f0' }}>
              <SiteLogo site={m.site} size={18} />
              <Typography.Text ellipsis style={{ minWidth: 0, flex: 1 }}>{m.title}</Typography.Text>
              {/* 显示"当初选的档位",不是实测分辨率 —— 文案写"档位"别让用户误解 */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>档位 {m.height ?? '?'}p</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{humanSize(m.file_size)}</Typography.Text>
              <Button size="small" onClick={() => { setCurrent(m); setStart(0); setEnd(0); setMsg(null); }}>打开</Button>
              <Button size="small" danger onClick={() => onDeleteMedia(m)}>删除</Button>
            </div>
          ))
        )}
      </div>
    </Space>
  );
}
```

- [ ] **Step 2: 跑类型检查**

Run: `cd web; npx tsc --noEmit --pretty false`
Expected: 本文件 0 错（`acquire.tsx` 的报错留到 Task 13）

- [ ] **Step 3: 提交**（先申请）

```bash
git add web/src/components/VideoClipPanel.tsx
git commit -m "feat(web): 视频预览剪音频面板(下视频/画面上打点/剪出音频/素材列表)"
```

---

### Task 13: 接入获取页 + 修既有文案 + 浏览器实测

**Files:**
- Modify: `web/src/pages/acquire.tsx`（顶部加模式切换；新模式渲染 `VideoClipPanel`；修 `onDone` 类型守卫；**改「删除来源」确认文案**）

**Interfaces:**
- Consumes: `VideoClipPanel`（Task 12）
- Produces: 无（终点是 UI 行为）

- [ ] **Step 1: 修 `onDone` 类型守卫（Task 11 留下的 tsc 报错）**

```tsx
      onDone: (d) => {
        if (d.kind === 'video') { setDone(`《${d.title}》视频素材已下好`); return; }
        setDone(d.replaced ? `《${d.title}》已入库(库里原来那一份已替换)` : `《${d.title}》已入库`);
      },
```

- [ ] **Step 2: 改「删除来源」确认文案（P0，spec §0.6）**

`acquire.tsx:185` 现在是：

```tsx
      content: '只移除左列表条目,不影响已下载到音频库的文件。',
```

改成（**必须和素材删除同时上线**，否则就是反向撒谎）：

```tsx
      content: '会一并删除该来源的视频素材文件（已剪出的音频不受影响）。',
```

- [ ] **Step 3: 顶部加模式切换**

在页面最外层容器内、左列表之上加（同时给 `acquire.tsx` 顶部 import 补 `Segmented` 与 `VideoClipPanel`）：

```tsx
  const [mode, setMode] = useState<'audio' | 'video'>('audio');
```

```tsx
      <Segmented
        value={mode}
        onChange={(v) => { setMode(v as 'audio' | 'video'); setError(null); setDone(null); }}
        options={[{ value: 'audio', label: '下载音频' }, { value: 'video', label: '视频预览剪音频' }]}
      />
```

`mode === 'video'` 时，主区渲染：

```tsx
        <VideoClipPanel source={detail} />
```

（`detail` 就是当前左列表选中的来源；`mode === 'audio'` 时保持现有主区不动）

- [ ] **Step 4: 类型检查 + 启动真实环境**

Run: `cd web; npx tsc --noEmit --pretty false`
Expected: 0 错

启动（用独立实例，不碰用户正在跑的进程与数据）：

```powershell
# 数据库副本 + 独立端口,测完删
Copy-Item .sct\dev-data\sct.db .sct\verify\sct.db -Force
```

用临时脚本 `server/verify-start.mts` 起 server（端口 7311），浏览器开 `http://localhost:8000/?v=20&apiPort=7311#/acquire`。

- [ ] **Step 5: 浏览器逐项目验（对照 spec §0.8）**

- [ ] 切到「视频预览剪音频」模式
- [ ] 选来源 → 选 480p → 下视频 → 进度条走完出现 `<video>`
- [ ] **视频能播、能拖进度条**（拖不动 = Range 没生效，回 Task 8）
- [ ] 播到某处点「设为起点」，再往后点「设为终点」→ 两个输入框数值正确
- [ ] 点「剪出音频」→ 完成提示 → 去音频库看到新条目，**标题带 `[mm:ss-mm:ss]`**
- [ ] 播放这条音频，**听起点是否对得上**（这是 spec 待实测 B 的最终验收）
- [ ] 同一素材再剪第二段 → 库里**两条并存**，不互相覆盖
- [ ] 一边播放一边点「重新下视频」→ 看到"请先关闭预览"之类明确提示（不是静默没换）
- [ ] 素材列表点「删除」→ 出现二次确认 → 确认后列表里消失、`media/` 下文件消失
- [ ] 切回「下载音频」模式 → 原流程照常能下 mp3
- [ ] 删除某个来源 → **确认框文案说清会连素材一起删**，确认后素材文件真的没了

- [ ] **Step 6: 清理临时验证环境**

```powershell
# 停掉 7311 的 server,删掉 .sct\verify 与 verify-start.mts
```

- [ ] **Step 7: 提交**（先申请）

```bash
git add web/src/pages/acquire.tsx
git commit -m "feat(web): 获取页接入视频预览剪音频模式;删除来源文案对齐新行为"
```

---

### Task 14: 文档回写 + 全量回归收口

**Files:**
- Modify: `docs/prds/音频录制与剪辑-PRD初始篇.md`（§6.1 路线图 + §6 里程碑 + 前置条件）
- Modify: `docs/superpowers/specs/m1a-ytdlp-pipeline.md`（§0.6 漂移修正 + §0.3 契约补字段）
- Modify: `docs/superpowers/specs/m1c-video-clip.md`（§0.11 里已落地的候选/已采纳项状态）

- [ ] **Step 1: PRD 回写**

- §6.1 路线图：在 S2 与 S5 之间插入 `S2.5 · m1c-video-clip`，写明"依赖 S2，是 S5 的最小前置"，并注明它不在原 S1–S6 内
- §6 里程碑表：M1 行后补一句本切片的位置
- 前置条件：声明"剪辑功能要求 ffmpeg 可用"（spec D16）

- [ ] **Step 2: m1a spec 回写**

- §0.6：把获取页描述里"片段起止"那半句改成实情（**该 UI 并未实现**，2026-09-29 核实）
- §0.3：`POST /api/ytdlp/download` 的 body 补 `produce` / `options.videoHeight` 两个可选字段

- [ ] **Step 3: 按仓库规矩全仓扫一遍过时声明**

```powershell
Get-ChildItem d:\Seed\sound-control-tool -Recurse -File -Include *.md,*.ts,*.tsx |
  Select-String -Pattern '片段起止|待实测|未做|未实现|TODO' |
  Where-Object { $_.Path -notmatch 'node_modules' }
```

逐条对照现状改掉。特别检查：`m1c-video-clip.md` 里 Task 0 的实测结论是否都已从"待实测"改成实情。

- [ ] **Step 4: 全量回归**

Run:
```powershell
cd server; npx tsc --noEmit --pretty false; npm test
cd ..\web; npx tsc --noEmit --pretty false; npm run build
```
Expected: server typecheck 0 错、全部测试绿、web typecheck 0 错、web build 成功

- [ ] **Step 5: 提交**（先申请）

```bash
git add docs/
git commit -m "docs: 回写 m1c-video-clip 落地结果(PRD 路线图/前置条件/m1a 契约与漂移)"
```

---

## 自审记录（写完计划后按 spec 逐条对）

**覆盖检查**：spec §0.2 的 D1–D16 → D1/D2 落 Task 6；D3 落 Task 2/9；D4 落 Task 9；D5 落 Task 7；D6/D7/D8 落 Task 10；D9 落 Task 3；D10 落 Task 4；D11/D12 落 Task 8；D13/D14 落 Task 10；D15 落 Task 3；D16 落 Task 4/14。
spec §0.3 五组接口 → Task 6/9（download）、Task 10（四条 media 路由）。§0.4 → Task 2/3。§0.5 → Task 4/5。§0.6 → Task 12/13。§0.7 → 各任务自己的测试步骤 + Task 13 目验。§0.8 → Task 13/14。§0.10 → Task 4/14。§0.11 → Task 14。

**已知的取舍**：Task 9 Step 3 里那个"用立即执行的箭头函数抛错"的写法**不要照抄**——按该文件既有的 `return reply.code(400).send(...)` 写法改，计划里已注明。
