# m1a-ytdlp-pipeline 实施计划（URL 下载管线）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git 红线:** 本计划包含 commit 步骤。执行开始前用户须明确同意按计划提交;未获同意则跳过所有 commit 步骤,仅保留工作区变更(遵守全局 Git 写操作禁令)。

**Goal:** 贴一个网页 URL → yt-dlp 提取音频（单条/合集多 P/片段，mp3|m4a|wav）→ 自动入库 → 音频库页可播放。

**Architecture:** 复用 M0 的三包骨架。server 新增 `src/ytdlp/`（纯函数 args/progress/errors/slug + IO 层 parse/download），下载走 jobs 表 + SSE（D2/D6），产物两段式入库（D5/D5b/D5c），音频经 server 流式端点回放（D3）。web 新增获取页 + 最小音频库页。

**Tech Stack:** Node 22.12（`--experimental-sqlite`）/ TypeScript 5.9 / Fastify 5 / node:sqlite / vitest 3 / yt-dlp 2026.08.19（外部二进制，spawn 调用）/ React 18 / antd 5 / Umi Max 4.7.17。**零新增 npm 依赖。**

**Spec:** `docs/superpowers/specs/m1a-ytdlp-pipeline.md`（决定 D1-D10+D5b/D5c、接口契约 §0.3、repo 增量 §0.4、集成层 §0.5、测试边界 §0.7——本计划的一切接口签名以 spec 为准，计划不重复定义 spec 已定的决策，只落实施细节）。

## Global Constraints

- server 为 ESM（`"type":"module"`）：**源码相互 import 必须带 `.js` 后缀**；web/desktop 不受此限
- **SQLite 唯一驱动 node:sqlite 同步 API**（`DatabaseSync`）；`.get()/.run()` 必须显式传绑定参数（M0 教训）
- **Node 侧一切入口**（dev/test）须经 `cross-env NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning"`（server 的 test/dev 脚本已带）
- strict TS + `noUncheckedIndexedAccess`；代码注释与 commit message 用中文
- 禁止新增 npm 依赖（yt-dlp/ffmpeg 是外部二进制，经 spawn/execFile 调用）
- Windows 子进程：spawn 一律 `windowsHide: true`；下载 spawn 加 `detached: true`（D7 取消杀树用）
- 错误统一形状 `{ ok:false, error:{ code, message, next } }`（D9）
- SSE 与音频文件端点用 `?token=` query 校验（D3）；其余受保护路由走 `x-sct-token` header（D12，M0 已实现，勿动）
- 每 Task 末尾 typecheck/单测通过才进下一 Task；commit 按 Git 红线执行

---

### Task 1: ytdlp 纯函数层（slug / args / progress / errors）

**Files:**
- Create: `server/src/ytdlp/slug.ts`
- Create: `server/src/ytdlp/args.ts`
- Create: `server/src/ytdlp/progress.ts`
- Create: `server/src/ytdlp/errors.ts`
- Test: `server/src/ytdlp/slug.test.ts`
- Test: `server/src/ytdlp/args.test.ts`
- Test: `server/src/ytdlp/progress.test.ts`
- Test: `server/src/ytdlp/errors.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，零 IO）
- Produces:
  - `slug.ts`：`slugify(title: string): string`；`resolveUniquePath(dir: string, filename: string, exists: (p: string) => boolean): string`
  - `args.ts`：`buildParseArgs(url: string): string[]`；`buildDownloadArgs(opts: { url: string; options: DownloadOptions; outDir: string }): string[]`；`export interface DownloadOptions { entryIndices?: number[]; section?: { start: number; end: number }; format: 'mp3'|'m4a'|'wav'; quality?: string; }`
  - `progress.ts`：`export interface ProgressInfo { percent: number; downloadedBytes?: number; totalBytes?: number }`；`parseProgressLine(line: string): ProgressInfo | null`
  - `errors.ts`：`export interface YtdlpErrorInfo { code: string; message: string; next: string }`；`mapYtdlpError(e: { code?: string; stderr?: string; binPath?: string | null }): YtdlpErrorInfo`

- [x] **Step 1: 写 `slug.ts` 与失败测试**

```ts
// server/src/ytdlp/slug.ts
const ILLEGAL = /[\\/:*?"<>|]/g;
export function slugify(title: string): string {
  return title.replace(ILLEGAL, '_').trim().slice(0, 80);
}
export function resolveUniquePath(dir: string, filename: string, exists: (p: string) => boolean): string {
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
  const base = ext ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  let candidate = filename;
  for (let n = 2; exists(join(dir, candidate)); n++) candidate = `${base}-${n}${ext}`;
  return join(dir, candidate);
}
import { join } from 'node:path';
```

```ts
// server/src/ytdlp/slug.test.ts
import { describe, expect, it } from 'vitest';
import { slugify, resolveUniquePath } from './slug.js';
describe('slugify', () => {
  it('替换 Windows 非法字符为下划线', () => {
    expect(slugify('a/b:c*?"<>|')).toBe('a_b_c______');
  });
  it('去首尾空格并截断至 80 字符', () => {
    expect(slugify('  x  ')).toBe('x');
    expect(slugify('a'.repeat(100)).length).toBe(80);
  });
});
describe('resolveUniquePath', () => {
  it('目标不存在时原样返回', () => {
    expect(resolveUniquePath('C:/dir', 'song-12345678.mp3', () => false)).toBe('C:/dir/song-12345678.mp3');
  });
  it('存在时追加 -2 -3 序号', () => {
    const taken = new Set(['C:/dir/song-12345678.mp3', 'C:/dir/song-12345678-2.mp3']);
    expect(resolveUniquePath('C:/dir', 'song-12345678.mp3', (p) => taken.has(p))).toBe('C:/dir/song-12345678-3.mp3');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd server && pnpm test -- slug.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 写 `args.ts` 与失败测试**

```ts
// server/src/ytdlp/args.ts
export interface DownloadOptions {
  entryIndices?: number[];
  section?: { start: number; end: number };
  format: 'mp3' | 'm4a' | 'wav';
  quality?: string;
}
export function buildParseArgs(url: string): string[] {
  return ['-J', '--flat-playlist', '--no-warnings', url];
}
export function buildDownloadArgs(opts: { url: string; options: DownloadOptions; outDir: string }): string[] {
  const { url, options, outDir } = opts;
  const args: string[] = ['-x', '--newline', '--windows-filenames'];
  args.push('--audio-format', options.format);
  if (options.quality) args.push('--audio-quality', options.quality);
  if (options.entryIndices && options.entryIndices.length > 0) {
    args.push('--playlist-items', options.entryIndices.join(','));
  } else {
    args.push('--no-playlist');
  }
  if (options.section) args.push('--download-sections', `*${options.section.start}-${options.section.end}`);
  // D6:结构化进度行 percent|downloaded|total
  args.push('--progress-template', '%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s');
  args.push('-o', join(outDir, '%(id)s.%(ext)s'), url);
  return args;
}
import { join } from 'node:path';
```

```ts
// server/src/ytdlp/args.test.ts
import { describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildParseArgs } from './args.js';
describe('buildParseArgs', () => {
  it('固定 -J --flat-playlist --no-warnings', () => {
    expect(buildParseArgs('https://b23.tv/abc')).toEqual(['-J', '--flat-playlist', '--no-warnings', 'https://b23.tv/abc']);
  });
});
describe('buildDownloadArgs', () => {
  it('单条强制 --no-playlist + 含 --windows-filenames', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).toContain('--no-playlist');
    expect(a).toContain('--windows-filenames');
    expect(a).toContain('-o');
  });
  it('合集单元素换算 --playlist-items(D8:单产物模型,多选由前端逐条提交)', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'm4a', entryIndices: [3] }, outDir: 'D:/tmp' });
    expect(a).toContain('--playlist-items');
    expect(a[a.indexOf('--playlist-items') + 1]).toBe('3');
  });
  it('无 entryIndices 时强制 --no-playlist', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).toContain('--no-playlist');
    expect(a).not.toContain('--playlist-items');
  });
  it('片段下载带 --download-sections', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'wav', section: { start: 61, end: 184.5 } }, outDir: 'D:/tmp' });
    expect(a).toContain('--download-sections');
    expect(a[a.indexOf('--download-sections') + 1]).toBe('*61-184.5');
  });
  it('quality 缺省时不出现 --audio-quality', () => {
    const a = buildDownloadArgs({ url: 'u', options: { format: 'mp3' }, outDir: 'D:/tmp' });
    expect(a).not.toContain('--audio-quality');
  });
});
```

- [x] **Step 4: 跑测试确认失败**

Run: `cd server && pnpm test -- args.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 5: 写 `progress.ts` 与失败测试**

```ts
// server/src/ytdlp/progress.ts
export interface ProgressInfo { percent: number; downloadedBytes?: number; totalBytes?: number }
// 输入行来自 --progress-template: "42.3%|12345|67890";下载中无 total 时 total 为空串
export function parseProgressLine(line: string): ProgressInfo | null {
  const parts = line.trim().split('|');
  if (parts.length < 1 || !parts[0]!.endsWith('%')) return null;
  const p = Number.parseFloat(parts[0]!.replace('%', ''));
  if (Number.isNaN(p)) return null;
  const num = (s: string | undefined): number | undefined => (s && s.length > 0 && Number(s) >= 0 ? Number(s) : undefined);
  return { percent: p, downloadedBytes: num(parts[1]), totalBytes: num(parts[2]) };
}
```

```ts
// server/src/ytdlp/progress.test.ts
import { describe, expect, it } from 'vitest';
import { parseProgressLine } from './progress.js';
describe('parseProgressLine', () => {
  it('解析 percent|downloaded|total', () => {
    expect(parseProgressLine('42.3%|12345|67890')).toEqual({ percent: 42.3, downloadedBytes: 12345, totalBytes: 67890 });
  });
  it('total 缺失(下载中未知大小)', () => {
    expect(parseProgressLine('12.5%|999|')).toEqual({ percent: 12.5, downloadedBytes: 999, totalBytes: undefined });
  });
  it('非进度行返回 null', () => {
    expect(parseProgressLine('[download] Destination: x.mp3')).toBeNull();
    expect(parseProgressLine('')).toBeNull();
  });
});
```

- [x] **Step 6: 跑测试确认失败**

Run: `cd server && pnpm test -- progress.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 7: 写 `errors.ts` 与失败测试**

```ts
// server/src/ytdlp/errors.ts
export interface YtdlpErrorInfo { code: string; message: string; next: string }
// D9:stderr 特征 → 中文 message + 可执行 next。特征匹配按优先级(DRM > 登录 > 站点 > 网络)
export function mapYtdlpError(e: { code?: string; stderr?: string; binPath?: string | null }): YtdlpErrorInfo {
  if (e.code === 'ENOENT' || !e.binPath) {
    return { code: 'YTDLP_NOT_FOUND', message: 'yt-dlp 未找到或路径无效', next: '请到设置页配置 yt-dlp 路径后重试' };
  }
  const s = e.stderr ?? '';
  if (/DRM|inaccessible|playright/i.test(s)) return { code: 'DRM', message: '该内容受 DRM 保护，无法下载音频', next: '换用可下载的源，或录制系统声音' };
  if (/sign in|login|authentication|会员|登录/i.test(s)) return { code: 'AUTH_REQUIRED', message: '该内容需要登录/会员才能下载', next: '登录对应网站后重试（yt-dlp 不支持网页登录态时，需另想办法）' };
  if (/unsupported URL|no such extractor|不支持/i.test(s)) return { code: 'UNSUPPORTED_SITE', message: '该站点 yt-dlp 暂不支持', next: '换用支持的站点，或录制系统声音' };
  if (/timed out|connection|network|无法解析|403|404/i.test(s)) return { code: 'NETWORK', message: '网络请求失败或资源不可达', next: '检查网络后重试' };
  return { code: 'YTDLP_ERROR', message: s.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 200), next: '重试；若反复失败，换用录制系统声音' };
}
```

```ts
// server/src/ytdlp/errors.test.ts
import { describe, expect, it } from 'vitest';
import { mapYtdlpError } from './errors.js';
describe('mapYtdlpError', () => {
  it('ENOENT → YTDLP_NOT_FOUND + 设置页指引', () => {
    const r = mapYtdlpError({ code: 'ENOENT' });
    expect(r.code).toBe('YTDLP_NOT_FOUND');
    expect(r.next).toContain('设置页');
  });
  it('binPath 为 null → YTDLP_NOT_FOUND', () => {
    expect(mapYtdlpError({ binPath: null }).code).toBe('YTDLP_NOT_FOUND');
  });
  it('DRM 特征', () => {
    expect(mapYtdlpError({ stderr: 'ERROR: This video is DRM protected' }).code).toBe('DRM');
  });
  it('需登录特征', () => {
    expect(mapYtdlpError({ stderr: 'Please sign in to view this content' }).code).toBe('AUTH_REQUIRED');
  });
  it('未知错误摘要截断 + 重试指引', () => {
    const r = mapYtdlpError({ stderr: 'ERROR: Something weird happened' });
    expect(r.code).toBe('YTDLP_ERROR');
    expect(r.next).toContain('重试');
  });
});
```

- [x] **Step 8: 跑测试确认失败**

Run: `cd server && pnpm test -- errors.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 9: 全绿 + typecheck**

Run: `cd server && pnpm test -- slug.test.ts args.test.ts progress.test.ts errors.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck exit 0

- [x] **Step 10: 真实 yt-dlp 实测 progress-template（P2-7 机制断言验证）**

本步验证 spec §0.5 标注的机制断言：`--progress-template` 的字段名与"进度行走 stdout"是否符合预期。**若不符，回改 args.ts/parseProgressLine 并回写 spec §0.5。**

Run:
```bash
# 用本机已装的 yt-dlp 跑一个小下载,观察 --newline --progress-template 的输出流与字段
yt-dlp -x --newline --windows-filenames --audio-format mp3 --progress-template "%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s" -o "C:/Users/<user>/AppData/Local/Temp/sct-probe/%(id)s.%(ext)s" <一个 10 秒内的短视频 URL>
```
Expected:
1. stdout 出现形如 `  42.3%|12345|67890` 的行（前导空格属 `_percent_str`，`parseProgressLine` 已 trim）
2. 若输出在 stderr 而非 stdout → `download.ts` 改为同时监听 stderr 的进度行解析，回写 spec
3. 若字段输出为空 → 换用 `%(progress._downloaded_bytes_str)s`/`%(progress._total_bytes_str)s`，回改 args.ts
4. 探针产物文件删除（临时目录，不入库）

- [x] **Step 11: Commit**

```bash
git add server/src/ytdlp/slug.ts server/src/ytdlp/args.ts server/src/ytdlp/progress.ts server/src/ytdlp/errors.ts server/src/ytdlp/*.test.ts
git commit -m "feat(server): yt-dlp 纯函数层(slug/args/progress/errors)"
```

---

### Task 2: repo 层——audio-items 新建 + jobs 增补

> **实施注记（2026-09-28 Task 2 落地）**：brief 三处缺陷已按最小偏离修正，后续 Task 复抄时注意——①audio-items.test 的 beforeEach **必须补 `initSchema(db)`**（brief 漏建表会 `no such table`）；②jobs `update` 的 `vals` 类型用 `(string | number | null)[]`（`unknown[]` 在 strict 下展开进 `run(...)` 无法编译）；③`findActiveByUrl` 断言用 `?.id`（接口返回 `{id:number}|null`，非裸数字）。

**Files:**
- Create: `server/src/db/repo/audio-items.ts`
- Create: `server/src/db/repo/audio-items.test.ts`
- Modify: `server/src/db/repo/jobs.ts`（增补 update/finish/fail）
- Modify: `server/src/db/repo/jobs.test.ts`（增补用例）

**Interfaces:**
- Consumes: `DB`（`../index.js`）、现有 `JobsRepo`（`./jobs.js`）
- Produces:
  - `audio-items.ts`：
    - `export interface AudioItemRow { id: number; title: string; source_type: string; source_url: string | null; file_path: string; format: string; duration_sec: number | null; file_size: number | null; created_at: string }`
    - `export interface AudioItemsRepo { create(item: Omit<AudioItemRow,'id'|'created_at'>): number; list(): AudioItemRow[]; get(id: number): AudioItemRow | null; findBySourceUrl(url: string): AudioItemRow | null; updateFilePath(id: number, file_path: string): void }`
    - `export function createAudioItemsRepo(db: DB): AudioItemsRepo`
  - `jobs.ts` 增补：`update(id, patch: { status?: JobStatus; progress?: number; message?: string | null }): void`、`finish(id, progress = 100): void`、`fail(id, message: string): void`；`export type JobStatus = 'pending'|'running'|'done'|'error'|'cancelled'`

- [x] **Step 1: 写 audio-items repo 测试（TDD）**

```ts
// server/src/db/repo/audio-items.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../index.js';
import { createAudioItemsRepo, type AudioItemRow } from './audio-items.js';

let db: DB;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { db.close(); });

describe('audio-items repo', () => {
  it('create 返回 lastInsertRowid 且可 list 回读', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: '课 01', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/tmp/x.mp3', format: 'mp3', duration_sec: 61.5, file_size: 1024 });
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.title).toBe('课 01');
  });
  it('findBySourceUrl 只匹配 download 且同 URL', () => {
    const repo = createAudioItemsRepo(db);
    repo.create({ title: 'r', source_type: 'recording', source_url: 'https://a/1', file_path: 'C:/tmp/r.wav', format: 'wav', duration_sec: null, file_size: 1 });
    expect(repo.findBySourceUrl('https://a/1')).toBeNull();
    repo.create({ title: 'd', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/tmp/d.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    expect(repo.findBySourceUrl('https://a/1')?.title).toBe('d');
  });
  it('updateFilePath 生效且 get 回读', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: 'C:/tmp/t.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    repo.updateFilePath(id, 'C:/audio/t-1a2b3c4d.mp3');
    expect(repo.get(id)?.file_path).toBe('C:/audio/t-1a2b3c4d.mp3');
    expect(repo.get(999)).toBeNull();
  });
  it('delete 移除行(P1-2 回滚)', () => {
    const repo = createAudioItemsRepo(db);
    const id = repo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: 'C:/tmp/t.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    repo.delete(id);
    expect(repo.get(id)).toBeNull();
    expect(repo.list()).toHaveLength(0);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd server && pnpm test -- audio-items.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现 audio-items repo**

```ts
// server/src/db/repo/audio-items.ts
import type { DB } from '../index.js';

export interface AudioItemRow {
  id: number; title: string; source_type: string; source_url: string | null;
  file_path: string; format: string; duration_sec: number | null;
  file_size: number | null; created_at: string;
}
export interface AudioItemsRepo {
  create(item: Omit<AudioItemRow, 'id' | 'created_at'>): number;
  list(): AudioItemRow[];
  get(id: number): AudioItemRow | null;
  findBySourceUrl(url: string): AudioItemRow | null;
  updateFilePath(id: number, file_path: string): void;
  delete(id: number): void; // P1-2:入库失败回滚
}
export function createAudioItemsRepo(db: DB): AudioItemsRepo {
  const insert = db.prepare(
    'INSERT INTO audio_items (title, source_type, source_url, file_path, format, duration_sec, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const select = db.prepare(
    'SELECT id, title, source_type, source_url, file_path, format, duration_sec, file_size, created_at FROM audio_items',
  );
  return {
    create: (item) =>
      Number(
        insert.run(item.title, item.source_type, item.source_url, item.file_path, item.format, item.duration_sec, item.file_size).lastInsertRowid,
      ),
    list: () => select.all().filter(isRow).map(normalize),
    get: (id) => {
      const row = db.prepare(`${SELECT_COLS} WHERE id = ?`).get(id);
      return row && isRow(row) ? normalize(row) : null;
    },
    findBySourceUrl: (url) => {
      const row = db.prepare(`${SELECT_COLS} WHERE source_type = 'download' AND source_url = ?`).get(url);
      return row && isRow(row) ? normalize(row) : null;
    },
    updateFilePath: (id, file_path) => db.prepare('UPDATE audio_items SET file_path = ? WHERE id = ?').run(file_path, id),
    delete: (id) => db.prepare('DELETE FROM audio_items WHERE id = ?').run(id),
  };
}
const SELECT_COLS =
  'SELECT id, title, source_type, source_url, file_path, format, duration_sec, file_size, created_at FROM audio_items';
function isRow(r: unknown): r is Record<string, unknown> { return typeof r === 'object' && r !== null; }
function normalize(r: Record<string, unknown>): AudioItemRow {
  return {
    id: Number(r.id), title: String(r.title), source_type: String(r.source_type),
    source_url: r.source_url === null ? null : String(r.source_url),
    file_path: String(r.file_path), format: String(r.format),
    duration_sec: r.duration_sec === null ? null : Number(r.duration_sec),
    file_size: r.file_size === null ? null : Number(r.file_size),
    created_at: String(r.created_at),
  };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd server && pnpm test -- audio-items.test.ts`
Expected: PASS

- [x] **Step 5: jobs.ts 增补 update/finish/fail + 测试**

```ts
// jobs.ts 增补(在 JobsRepo 接口与实现上)
export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
export interface JobsRepo {
  // ...原有
  update(id: number, patch: { status?: JobStatus; progress?: number; message?: string | null }): void;
  finish(id: number, progress?: number): void;
  fail(id: number, message: string): void;
  findActiveByUrl(url: string): { id: number } | null; // P1-1:防同 URL 并发下载
}
// 实现追加:
update: (id, patch) => {
  const status = patch.status ?? null;
  const finished = status === 'done' || status === 'error' || status === 'cancelled' ? `, finished_at=datetime('now')` : '';
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.status !== undefined) { cols.push('status=?'); vals.push(patch.status); }
  if (patch.progress !== undefined) { cols.push('progress=?'); vals.push(patch.progress); }
  if (patch.message !== undefined) { cols.push('message=?'); vals.push(patch.message); }
  if (cols.length === 0) return;
  db.prepare(`UPDATE jobs SET ${cols.join(',')}${finished} WHERE id=?`).run(...vals, id);
},
finish: (id, progress = 100) =>
  db.prepare("UPDATE jobs SET status='done', progress=?, finished_at=datetime('now') WHERE id=?").run(progress, id),
fail: (id, message) =>
  db.prepare("UPDATE jobs SET status='error', message=?, finished_at=datetime('now') WHERE id=?").run(message, id),
findActiveByUrl: (url) => {
  // payload 是 JSON 文本;LIKE 匹配 "url":"<escaped>" 子串,避免误配 URL 前缀相同者。
  // LIKE 通配符 %/_ 需转义(URL 可能含 %20、下划线),配合 ESCAPE '\'
  const needle = JSON.stringify({ url }).slice(1, -1); // "url":"<escaped>"
  const esc = needle.replace(/[\\%_]/g, (c) => `\\${c}`);
  const row = db
    .prepare("SELECT id FROM jobs WHERE kind='ytdlp_download' AND status IN ('pending','running') AND payload LIKE ? ESCAPE '\\'")
    .get(`%${esc}%`);
  return row && typeof (row as { id: unknown }).id === 'number' ? { id: (row as { id: number }).id } : null;
},
```

```ts
// jobs.test.ts 追加
it('update/finish/fail 联动状态与 finished_at', () => {
  const repo = createJobsRepo(db);
  const id = repo.create('ytdlp_download', { url: 'u' });
  repo.update(id, { status: 'running', progress: 10 });
  let j = repo.get(id)!;
  expect(j.status).toBe('running'); expect(j.progress).toBe(10); expect(j.finished_at).toBeNull();
  repo.finish(id);
  j = repo.get(id)!;
  expect(j.status).toBe('done'); expect(j.progress).toBe(100); expect(j.finished_at).not.toBeNull();
});
it('fail 置 error + message', () => {
  const repo = createJobsRepo(db);
  const id = repo.create('ytdlp_download', { url: 'u' });
  repo.fail(id, '网络失败');
  const j = repo.get(id)!;
  expect(j.status).toBe('error'); expect(j.message).toBe('网络失败');
});
it('findActiveByUrl 命中 running/pending 的同 URL job,finished 不命中', () => {
  const repo = createJobsRepo(db);
  const id = repo.create('ytdlp_download', { url: 'https://a/1' });
  repo.update(id, { status: 'running' });
  expect(repo.findActiveByUrl('https://a/1')?.id).toBe(id);
  // 不同 URL 不命中
  expect(repo.findActiveByUrl('https://b/2')).toBeNull();
  // URL 前缀相同不误配("https://a/1x" 不应命中 "https://a/1")
  repo.create('ytdlp_download', { url: 'https://a/1x' });
  expect(repo.findActiveByUrl('https://a/1')).toBe(id);
  // 含 LIKE 通配符的 URL(%20/下划线)不被误配
  repo.create('ytdlp_download', { url: 'https://a/under_score%20x' });
  expect(repo.findActiveByUrl('https://a/1')).toBe(id);
  expect(repo.findActiveByUrl('https://a/under_score%20x')?.id).not.toBeUndefined();
  // finish 后不再命中
  repo.finish(id);
  expect(repo.findActiveByUrl('https://a/1')).toBeNull();
});
```
（`JobRow` 需加 `finished_at: string | null` 字段，get 的 SELECT 增补该列）

- [x] **Step 6: 全绿 + typecheck**

Run: `cd server && pnpm test -- audio-items.test.ts jobs.test.ts && pnpm typecheck`
Expected: 全部 PASS；typecheck exit 0

- [x] **Step 7: Commit**

```bash
git add server/src/db/repo/audio-items.ts server/src/db/repo/audio-items.test.ts server/src/db/repo/jobs.ts server/src/db/repo/jobs.test.ts
git commit -m "feat(server): audio-items repo 与 jobs update/finish/fail"
```

---

### Task 3: DownloadManager（依赖注入 spawn/taskkill）

**Files:**
- Create: `server/src/ytdlp/download.ts`
- Create: `server/src/ytdlp/download.test.ts`

**Interfaces:**
- Consumes: `buildDownloadArgs`（Task 1）、`mapYtdlpError`（Task 1）、`parseProgressLine`（Task 1）
- Produces:
  - `export type DownloadEvent = { type: 'progress'; percent: number; downloadedBytes?: number; totalBytes?: number } | { type: 'status'; state: 'running'|'done'|'error'|'cancelled'; message?: string; producedPath?: string }`
  - `export interface StartOpts { jobId: number; binPath: string; args: string[]; outDir: string; onEvent: (jobId: number, ev: DownloadEvent) => void }`
  - `export interface DownloadManager { start(opts: StartOpts): void; cancel(jobId: number): Promise<void>; dispose(): Promise<void> }`
  - `export function createDownloadManager(deps?: { spawn?: typeof spawn; execFile?: typeof execFile; findLatest?: (dir: string) => string | null }): DownloadManager`
  - `producedPath`：仅 `state:'done'` 时可能携带（下载产物绝对路径，`close(0)` 时用 `findLatest(outDir)` 解析），供路由层入库

- [x] **Step 1: 写测试（mock spawn 模拟进度/完成/失败/取消）**

```ts
// server/src/ytdlp/download.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { createDownloadManager, type DownloadEvent } from './download.js';

function fakeChild(over: Partial<ChildProcess> = {}): ChildProcess {
  return { pid: 1234, on: vi.fn(), kill: vi.fn(), ...over } as unknown as ChildProcess;
}
describe('DownloadManager', () => {
  it('start 后按进度行发 progress, 完成后发 status done(带 producedPath)', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
      findLatest: () => 'D:/tmp/abc123.mp3',
    });
    m.start({ jobId: 7, binPath: 'yt-dlp', args: ['-x'], outDir: 'D:/tmp', onEvent: (_, ev) => events.push(ev) });
    const onStdout = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'stdout')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onStdout('42.3%|123|456');
    onClose(0, null);
    expect(events.some((e) => e.type === 'progress' && e.percent === 42.3)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'status', state: 'done', producedPath: 'D:/tmp/abc123.mp3' });
  });
  it('非零退出发 status error + 错误映射', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
      findLatest: () => null,
    });
    m.start({ jobId: 1, binPath: 'yt-dlp', args: [], outDir: 'D:/tmp', onEvent: (_, ev) => events.push(ev) });
    const onErr = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'stderr')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onErr('ERROR: DRM protected');
    onClose(1, null);
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'error' });
  });
  it('cancel 走 taskkill /T /F', async () => {
    const tasks: Array<{ cmd: string; args: string[] }> = [];
    const child = fakeChild();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((cmd: string, args: string[], _o: unknown, cb: () => void) => { tasks.push({ cmd, args }); cb(); }) as never,
      findLatest: () => null,
    });
    m.start({ jobId: 2, binPath: 'yt-dlp', args: [], outDir: 'D:/tmp', onEvent: () => {} });
    await m.cancel(2);
    expect(tasks.at(-1)).toMatchObject({ cmd: 'taskkill', args: ['/pid', '1234', '/T', '/F'] });
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd server && pnpm test -- download.test.ts`
Expected: FAIL（模块不存在）

- [x] **Step 3: 实现 download.ts**

```ts
// server/src/ytdlp/download.ts
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mapYtdlpError } from './errors.js';
import { parseProgressLine } from './progress.js';

export type DownloadEvent =
  | { type: 'progress'; percent: number; downloadedBytes?: number; totalBytes?: number }
  | { type: 'status'; state: 'running' | 'done' | 'error' | 'cancelled'; message?: string; producedPath?: string };

export interface StartOpts {
  jobId: number; binPath: string; args: string[]; outDir: string;
  onEvent: (jobId: number, ev: DownloadEvent) => void;
}
export interface DownloadManager {
  start(opts: StartOpts): void;
  cancel(jobId: number): Promise<void>;
  dispose(): Promise<void>;
}
// 默认实现:outDir 下 mtime 最新的音频文件(无则 null)
export function findLatestAudioFile(dir: string): string | null {
  try {
    const audioExt = new Set(['.mp3', '.m4a', '.wav']);
    return (
      readdirSync(dir)
        .map((f) => ({ name: f, p: join(dir, f) }))
        .filter((f) => audioExt.has(f.name.slice(f.name.lastIndexOf('.'))))
        .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs)[0]?.p ?? null
    );
  } catch {
    return null;
  }
}
export function createDownloadManager(deps?: { spawn?: typeof spawn; execFile?: typeof execFile; findLatest?: (dir: string) => string | null }): DownloadManager {
  const doSpawn = deps?.spawn ?? spawn;
  const doExec = deps?.execFile ?? execFile;
  const findLatest = deps?.findLatest ?? findLatestAudioFile;
  const active = new Map<number, ChildProcess>();
  const activeOutDir = new Map<number, string>(); // P2-2:cancel 时清理该 job 的 outDir 半成品
  const cleanJobOutputs = (jobId: number, outDir: string): void => {
    // 删除该 job 刚产出的音频半成品(close 前 findLatest 能定位;cancel 场景下 mtime 最新即本 job 写的)
    const produced = findLatest(outDir);
    if (produced) { try { rmSync(produced, { force: true }); } catch { /* 尽力清理 */ } }
    activeOutDir.delete(jobId);
  };
  return {
    start: (opts) => {
      const { jobId, binPath, args, outDir, onEvent } = opts;
      // D7:detached + windowsHide;taskkill 杀整棵树
      const child = doSpawn(binPath, args, { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      active.set(jobId, child);
      activeOutDir.set(jobId, outDir);
      let stderrBuf = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          const info = parseProgressLine(line);
          if (info) onEvent(jobId, { type: 'progress', ...info });
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      child.on('error', (err) => {
        active.delete(jobId);
        activeOutDir.delete(jobId);
        onEvent(jobId, { type: 'status', state: 'error', message: mapYtdlpError({ code: (err as NodeJS.ErrnoException).code, binPath }).message });
      });
      child.on('close', (code) => {
        active.delete(jobId);
        const outDir2 = activeOutDir.get(jobId);
        if (code === 0) {
          const produced = outDir2 ? findLatest(outDir2) : null;
          activeOutDir.delete(jobId);
          onEvent(jobId, produced
            ? { type: 'status', state: 'done', producedPath: produced }
            : { type: 'status', state: 'error', message: '下载完成但未找到产物文件' });
        } else {
          if (outDir2) cleanJobOutputs(jobId, outDir2);
          onEvent(jobId, { type: 'status', state: 'error', message: mapYtdlpError({ stderr: stderrBuf, binPath }).message });
        }
      });
    },
    cancel: async (jobId) => {
      const child = active.get(jobId);
      const outDir = activeOutDir.get(jobId);
      // taskkill 杀进程树:yt-dlp 会拉起 ffmpeg,单杀父进程会残留
      if (child?.pid) {
        await new Promise<void>((resolve) => {
          doExec('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      }
      active.delete(jobId);
      if (outDir) cleanJobOutputs(jobId, outDir); // P2-2:cancel 后清理该 job 的半成品文件
    },
    dispose: async () => {
      const pids = [...active.values()].map((c) => c.pid).filter((p): p is number => typeof p === 'number');
      for (const pid of pids) {
        await new Promise<void>((resolve) => {
          doExec('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      }
      active.clear();
      activeOutDir.clear();
    },
  };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd server && pnpm test -- download.test.ts`
Expected: PASS

- [x] **Step 5: typecheck**

Run: `cd server && pnpm typecheck`
Expected: exit 0

- [x] **Step 6: Commit**

```bash
git add server/src/ytdlp/download.ts server/src/ytdlp/download.test.ts
git commit -m "feat(server): DownloadManager(spawn 进度解析 + taskkill 取消)"
```

---

### Task 4: parse 集成 + `POST /api/ytdlp/parse`

> **实施注记（2026-09-28 Task 4 落地）**：代码块逐字转录、零偏离（parse 3 测试 + 路由 2 测试全绿，58 用例全量回归绿，typecheck 0 错）。两处观察供后续 Task 留意——①`ytdlp-routes.test.ts` 顶部 import（mkdtempSync/writeFileSync/join/tmpdir/createJobsRepo/createAudioItemsRepo）在 Task 4 仅 2 个用例下未使用，属 brief 为 Task 5/7 预置（tsconfig 未开 noUnusedLocals，不报错），勿删；②`audioDir = path.join(path.dirname(opts.dbPath), 'audio')` 对测试的 `:memory:` dbPath 会在 CWD 产生空 `audio/` 目录（git 不跟踪空目录、无碍提交），生产路径（dev/electron 的 dbPath 为真实文件）行为正确。

**Files:**
- Create: `server/src/ytdlp/parse.ts`
- Create: `server/src/ytdlp/ytdlp-routes.ts`
- Create: `server/src/ytdlp/ytdlp-routes.test.ts`
- Modify: `server/src/index.ts`（注册 ytdlp 路由 + audioDir mkdir + close 时 dispose）

**Interfaces:**
- Consumes: `buildParseArgs`（Task 1）、`mapYtdlpError`（Task 1）、`createAudioItemsRepo`（Task 2）、`createSettingsRepo`（现有）、`probeBin`（现有 bins.js）、`createDownloadManager`（Task 3）、`createJobsRepo`（现有）
- Produces:
  - `parse.ts`：`export interface ParseResult { kind: 'single'|'playlist'; title: string; durationSec?: number; thumbnail?: string; entries?: { index: number; title: string }[] }`；`export function parseMetadata(binPath: string, url: string, timeoutMs?: number): Promise<ParseResult>`（失败抛 `YtdlpRunError extends Error`，带 `info: YtdlpErrorInfo`）
  - `ytdlp-routes.ts`：`export function registerYtdlpRoutes(app: FastifyInstance, deps: { db: DB; binProvider: () => Promise<{ path: string | null }>; downloadManager: DownloadManager; audioDir: string; tempDir: string; token: string }): void`

- [x] **Step 1: 写 parse.ts + 测试（mock execFile）**

```ts
// server/src/ytdlp/parse.ts
import { execFile } from 'node:child_process';
import { buildParseArgs } from './args.js';
import { mapYtdlpError, type YtdlpErrorInfo } from './errors.js';

export interface ParseEntry { index: number; title: string }
export interface ParseResult {
  kind: 'single' | 'playlist'; title: string; durationSec?: number;
  thumbnail?: string; entries?: ParseEntry[];
}
export class YtdlpRunError extends Error {
  constructor(public info: YtdlpErrorInfo) { super(info.message); }
}
export function parseMetadata(binPath: string, url: string, timeoutMs = 20_000, doExec: typeof execFile = execFile): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    doExec(binPath, buildParseArgs(url), { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        reject(new YtdlpRunError(mapYtdlpError({ code: e.code, stderr: e.stderr, binPath })));
        return;
      }
      try {
        resolve(normalizeParse(JSON.parse(stdout)));
      } catch {
        reject(new YtdlpRunError({ code: 'PARSE_FAILED', message: 'yt-dlp 元数据解析失败', next: '重试；若反复失败，换用录制系统声音' }));
      }
    });
  });
}
// 纯归一化导出供单测
export function normalizeParse(raw: unknown): ParseResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(o.entries)
    ? (o.entries as Array<Record<string, unknown>>).map((e, i) => ({ index: i + 1, title: String(e.title ?? `条目 ${i + 1}`) }))
    : undefined;
  return {
    kind: entries ? 'playlist' : 'single',
    title: String(o.title ?? '未命名'),
    durationSec: typeof o.duration === 'number' ? o.duration : undefined,
    thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : undefined,
    entries,
  };
}
```

```ts
// server/src/ytdlp/parse.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeParse, parseMetadata } from './parse.js';
describe('normalizeParse', () => {
  it('单视频', () => {
    const r = normalizeParse({ title: '课 01', duration: 61.5, thumbnail: 'http://t' });
    expect(r.kind).toBe('single'); expect(r.title).toBe('课 01'); expect(r.durationSec).toBe(61.5);
    expect(r.entries).toBeUndefined();
  });
  it('合集 entries index 从 1 起', () => {
    const r = normalizeParse({ title: '合集', entries: [{ title: 'A' }, { title: 'B' }] });
    expect(r.kind).toBe('playlist');
    expect(r.entries).toEqual([{ index: 1, title: 'A' }, { index: 2, title: 'B' }]);
  });
});
describe('parseMetadata', () => {
  it('execFile 失败 → YtdlpRunError(info)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException) => void) => {
      cb(Object.assign(new Error('x'), { code: 'ENOENT' }) as NodeJS.ErrnoException);
    }) as never;
    await expect(parseMetadata('yt-dlp', 'u', 20000, doExec)).rejects.toMatchObject({ info: { code: 'YTDLP_NOT_FOUND' } });
  });
});
```

- [x] **Step 2: 跑测试确认失败→通过**

Run: `cd server && pnpm test -- parse.test.ts`
Expected: 先 FAIL（模块不存在），实现后 PASS

- [x] **Step 3: 写 ytdlp-routes + HTTP 测试（parse 部分）**

```ts
// server/src/ytdlp/ytdlp-routes.ts(本步先落 parse 路由 + 共享辅助,download/SSE 路由 Task 5/6 续)
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { parseMetadata, YtdlpRunError } from './parse.js';
import type { DownloadManager } from './download.js';

export interface YtdlpDeps {
  db: DB;
  binProvider: () => Promise<{ path: string | null }>;
  downloadManager: DownloadManager;
  audioDir: string; tempDir: string; token: string;
}
export function registerYtdlpRoutes(app: FastifyInstance, deps: YtdlpDeps): void {
  const { db, binProvider } = deps;
  const audioRepo = createAudioItemsRepo(db);

  app.post('/api/ytdlp/parse', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: unknown };
    if (typeof body.url !== 'string' || body.url.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'url 必填', next: '粘贴一个网页 URL' } });
    }
    const url = body.url.trim();
    const bin = await binProvider();
    if (!bin.path) {
      return reply.code(409).send({ ok: false, error: { code: 'YTDLP_NOT_FOUND', message: 'yt-dlp 未找到或路径无效', next: '请到设置页配置 yt-dlp 路径后重试' } });
    }
    try {
      const parsed = await parseMetadata(bin.path, url);
      const existing = audioRepo.findBySourceUrl(url);
      // 注意:parse 内部用 durationSec(驼峰),对外契约 spec 0.3 是 duration_sec(下划线,与 audio_items 键风格一致)
      return {
        ok: true,
        kind: parsed.kind,
        title: parsed.title,
        duration_sec: parsed.durationSec,
        thumbnail: parsed.thumbnail,
        entries: parsed.entries,
        existing: existing ? { audioId: existing.id, title: existing.title } : undefined,
      };
    } catch (e) {
      if (e instanceof YtdlpRunError) return reply.code(502).send({ ok: false, error: e.info });
      throw e;
    }
  });
}
```

```ts
// server/src/ytdlp/ytdlp-routes.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerYtdlpRoutes } from './ytdlp-routes.js';
import { createDownloadManager } from './download.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';

let db: DB;
let app: FastifyInstance;
beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  app = Fastify({ logger: false });
});
afterEach(async () => { await app.close(); db.close(); });

function makeApp(binPath: string | null, token = 'tok', dm?: ReturnType<typeof createDownloadManager>) {
  return registerYtdlpRoutes(app, {
    db,
    binProvider: async () => ({ path: binPath }),
    downloadManager: dm ?? createDownloadManager(),
    audioDir: 'C:/audio', tempDir: 'C:/tmp', token,
  });
}

describe('POST /api/ytdlp/parse', () => {
  it('url 缺失 → 400', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('bin 缺失 → 409 YTDLP_NOT_FOUND', async () => {
    makeApp(null);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('YTDLP_NOT_FOUND');
  });
});
```

- [x] **Step 4: 跑测试确认通过**

Run: `cd server && pnpm test -- ytdlp-routes.test.ts`
Expected: PASS

- [x] **Step 5: index.ts 注册 ytdlp 路由 + audioDir + close dispose**

```ts
// index.ts 内 createServer:
import { registerYtdlpRoutes } from './ytdlp/ytdlp-routes.js';
import { createDownloadManager } from './ytdlp/download.js';
import { probeBin } from './bins.js';

// D4:audioDir 与 db 同目录
const audioDir = path.join(path.dirname(opts.dbPath), 'audio');
mkdirSync(audioDir, { recursive: true });

const downloadManager = createDownloadManager();
registerYtdlpRoutes(app, {
  db,
  binProvider: async () => {
    const explicit = settingsRepo.get(SETTINGS_KEYS.binYtdlp);
    const p = await probeBin('yt-dlp', explicit ?? undefined);
    return { path: p.path };
  },
  downloadManager, audioDir, tempDir: opts.tempDir, token,
});

// close() 内先 dispose 下载进程再关 server/db:
close: async () => {
  if (closed) return; closed = true;
  try {
    await downloadManager.dispose();
    await instance.close();
  } finally { db.close(); }
},
```

- [x] **Step 6: typecheck + 全量单测**

Run: `cd server && pnpm test && pnpm typecheck`
Expected: 全绿（含既有 M0 用例）；typecheck exit 0

- [x] **Step 7: Commit**

```bash
git add server/src/ytdlp/parse.ts server/src/ytdlp/parse.test.ts server/src/ytdlp/ytdlp-routes.ts server/src/ytdlp/ytdlp-routes.test.ts server/src/index.ts
git commit -m "feat(server): yt-dlp 元数据解析路由 + audioDir 与关闭清理"
```

---

### Task 5: 下载闭环——POST download + 入库

> **实施注记（2026-09-28 Task 5 落地）**：实现主体逐字转录 brief；3 处最小偏离（均已在代码注释标注）——①**ingest.test 冲突用例修正**：brief 原测试"两个同标题条目"实际不会触发 `resolveUniquePath`（文件名含 id8，两条 id 不同→文件名天然不同），实测 FAIL，改为"预置第二个条目默认文件名的磁盘占位文件"再断言 `-2` 后缀；②**download 201 用例注入假 DownloadManager**：brief 原用 `createDownloadManager()` 会真实拉起本机 yt-dlp 访问 `https://a/1` 并写 `C:/tmp`（本机 yt-dlp 在 PATH、`C:/tmp` 不存在），测试不封闭；路由契约（201/jobId/running + start 接线）不依赖真实子进程，故注入假件；③**类型修正两处**：`body` 类型放宽容 `title?/durationSec?`、`startDownload` 调用处 `options: body.options ?? {}`（brief 原样两处均编译不过）。评审 Minor 的 parse success HTTP 用例已补（`vi.mock('./parse.js')` 展开保 `YtdlpRunError` 真身、仅 mock `parseMetadata`，`duration_sec` 下划线契约断言通过）。

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（补 download 路由 + 完成回调）
- Modify: `server/src/ytdlp/ytdlp-routes.test.ts`（补 download 用例）
- Create: `server/src/ytdlp/ingest.ts`（下载产物入库纯流程，便于单测）
- Create: `server/src/ytdlp/ffprobe.ts`（D10 duration 兜底：`ffprobe -show_entries format=duration`）
- Create: `server/src/ytdlp/ffprobe.test.ts`

**Interfaces:**
- Consumes: `buildDownloadArgs`（Task 1）、`slugify/resolveUniquePath`（Task 1）、`createJobsRepo`（现有 + Task 2 增补）、`createAudioItemsRepo`（Task 2）、`DownloadManager.start`（Task 3）、`DownloadEvent`（Task 3）
- Produces:
  - `ingest.ts`：`export function ingestDownloadedFile(opts: { tmpPath: string; title: string; format: string; durationSec: number | null; fileSize: number; sourceUrl: string; audioDir: string; exists: (p: string) => boolean; audioRepo: AudioItemsRepo }): { audioId: number; finalPath: string }`——D5 两段式：INSERT(temp 路径) → 计算 `{slug(title)}-{id前8位}.{ext}` → resolveUniquePath → rename → updateFilePath
  - `ffprobe.ts`：`export function probeDuration(ffprobePath: string, filePath: string, timeoutMs?: number, doExec?: typeof execFile): Promise<number | null>`——`ffprobe -v error -show_entries format=duration -of json <file>` 解析 `format.duration`，失败/缺失返回 null

- [x] **Step 1: 写 ingest.ts + 测试（真实临时文件）**

```ts
// server/src/ytdlp/ingest.ts
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioItemsRepo } from '../db/repo/audio-items.js';
import { resolveUniquePath, slugify } from './slug.js';

export function ingestDownloadedFile(opts: {
  tmpPath: string; title: string; format: string; durationSec: number | null;
  fileSize: number; sourceUrl: string; audioDir: string;
  exists: (p: string) => boolean; audioRepo: AudioItemsRepo;
}): { audioId: number; finalPath: string } {
  const audioId = opts.audioRepo.create({
    title: opts.title, source_type: 'download', source_url: opts.sourceUrl,
    file_path: opts.tmpPath, format: opts.format, duration_sec: opts.durationSec, file_size: opts.fileSize,
  });
  const id8 = String(audioId).padStart(8, '0').slice(-8);
  const finalName = `${slugify(opts.title)}-${id8}.${opts.format}`;
  const finalPath = resolveUniquePath(opts.audioDir, finalName, opts.exists);
  renameSync(opts.tmpPath, finalPath);
  opts.audioRepo.updateFilePath(audioId, finalPath);
  return { audioId, finalPath };
}
```

```ts
// server/src/ytdlp/ingest.test.ts
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { ingestDownloadedFile } from './ingest.js';

let dir: string; let db: DB;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sct-ingest-'));
  db = openDatabase(':memory:'); initSchema(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('ingestDownloadedFile', () => {
  it('两段式入库:最终文件名为 slug-id8.ext', () => {
    const audioRepo = createAudioItemsRepo(db);
    const tmpPath = join(dir, 'tmp.mp3'); writeFileSync(tmpPath, 'fake');
    const { audioId, finalPath } = ingestDownloadedFile({
      tmpPath, title: '课/01: 导入', format: 'mp3', durationSec: 61.5, fileSize: 4,
      sourceUrl: 'https://a', audioDir: dir, exists: existsSync, audioRepo,
    });
    expect(audioId).toBeGreaterThan(0);
    expect(finalPath).toBe(join(dir, `课_01_ 导入-${String(audioId).padStart(8, '0').slice(-8)}.mp3`));
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
    expect(audioRepo.get(audioId)?.file_path).toBe(finalPath);
  });
  it('同名冲突追加 -2', () => {
    const audioRepo = createAudioItemsRepo(db);
    const t1 = join(dir, 'a.mp3'); writeFileSync(t1, '1');
    const { audioId: id1 } = ingestDownloadedFile({ tmpPath: t1, title: '同', format: 'mp3', durationSec: null, fileSize: 1, sourceUrl: 'u1', audioDir: dir, exists: existsSync, audioRepo });
    const t2 = join(dir, 'b.mp3'); writeFileSync(t2, '2');
    const { finalPath: p2 } = ingestDownloadedFile({ tmpPath: t2, title: '同', format: 'mp3', durationSec: null, fileSize: 1, sourceUrl: 'u2', audioDir: dir, exists: existsSync, audioRepo });
    expect(p2.endsWith('-2.mp3')).toBe(true);
    expect(id1).not.toBe(p2);
  });
});
```

- [x] **Step 2: 跑测试确认失败→通过**

Run: `cd server && pnpm test -- ingest.test.ts`
Expected: 先 FAIL，实现后 PASS

- [x] **Step 3: 写 ffprobe.ts + 测试（D10 duration 兜底）**

```ts
// server/src/ytdlp/ffprobe.ts
import { execFile } from 'node:child_process';
export function probeDuration(
  ffprobePath: string, filePath: string, timeoutMs = 10_000, doExec: typeof execFile = execFile,
): Promise<number | null> {
  return new Promise((resolve) => {
    doExec(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const j = JSON.parse(stdout) as { format?: { duration?: string } };
          const d = Number(j.format?.duration);
          resolve(Number.isFinite(d) && d >= 0 ? d : null);
        } catch { resolve(null); }
      },
    );
  });
}
```

```ts
// server/src/ytdlp/ffprobe.test.ts
import { describe, expect, it } from 'vitest';
import { probeDuration } from './ffprobe.js';
describe('probeDuration', () => {
  it('解析 format.duration 为秒', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, '{"format":{"duration":"61.500000"}}');
    }) as never;
    await expect(probeDuration('ffprobe', 'x.mp3', 10000, doExec)).resolves.toBe(61.5);
  });
  it('执行失败返回 null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: Error) => void) => {
      cb(new Error('boom'));
    }) as never;
    await expect(probeDuration('ffprobe', 'x.mp3', 10000, doExec)).resolves.toBeNull();
  });
  it('JSON 缺 duration 返回 null', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      cb(null, '{"format":{}}');
    }) as never;
    await expect(probeDuration('ffprobe', 'x.mp3', 10000, doExec)).resolves.toBeNull();
  });
});
```

- [x] **Step 4: 跑测试确认失败→通过**

Run: `cd server && pnpm test -- ffprobe.test.ts`
Expected: 先 FAIL，实现后 PASS

- [x] **Step 5: ytdlp-routes 补 download 路由**

> **前置（本步先落，供 Task 6 扩展）**：在 `ytdlp-routes.ts` 顶部声明 SSE 桥接的骨架——`emit` 先做空实现（只落 jobs 表），Task 6 补 SSE 推送：
> ```ts
> // 模块级(本步先空实现,Task 6 落真实 SSE 推送)
> function emit(_jobId: number, _ev: unknown): void { /* Task 6 实现 */ }
> ```

```ts
// ytdlp-routes.ts 内追加(registerYtdlpRoutes 函数体):
app.post('/api/ytdlp/download', async (req, reply) => {
  const body = (req.body ?? {}) as { url?: unknown; options?: Record<string, unknown> };
  if (typeof body.url !== 'string' || body.url.trim().length === 0) {
    return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'url 必填', next: '粘贴一个网页 URL' } });
  }
  const url = body.url.trim();
  const opt = (body.options ?? {}) as {
    entryIndices?: unknown; section?: unknown; format?: unknown; quality?: unknown; force?: unknown;
  };
  if (!['mp3', 'm4a', 'wav'].includes(String(opt.format))) {
    return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'format 必须是 mp3|m4a|wav', next: '选择输出格式' } });
  }
  if (opt.section !== undefined) {
    const s = opt.section as { start?: unknown; end?: unknown };
    if (typeof s.start !== 'number' || typeof s.end !== 'number' || s.start < 0 || s.end <= s.start) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '片段起止无效', next: '起止时间需满足 0 ≤ start < end' } });
    }
  }
  if (opt.entryIndices !== undefined) {
    const idx = Array.isArray(opt.entryIndices) ? opt.entryIndices : [];
    // D8:单产物模型——entryIndices 必须恰好一个正整数元素,多选由前端逐条提交
    if (idx.length !== 1 || typeof idx[0] !== 'number' || idx[0] <= 0) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'entryIndices 必须为单个正整数条目,多选请逐条提交', next: '重新勾选合集条目(逐条下载)' } });
    }
  }
  const existing = audioRepo.findBySourceUrl(url);
  if (existing && opt.force !== true) {
    return reply.code(409).send({ ok: false, error: { code: 'DUPLICATE', message: `库中已存在《${existing.title}》`, next: '若确认重复下载请勾选"仍下载"' } });
  }
  // P1-1:同 URL 并发——已有 running/pending 的 ytdlp_download job 时拒绝(无论 force,防两进程写同一输出文件)
  const activeJob = createJobsRepo(db).findActiveByUrl(url);
  if (activeJob) {
    return reply.code(409).send({ ok: false, error: { code: 'BUSY', message: '该 URL 正在下载中', next: '等待当前下载结束或先取消再重试' } });
  }
  const bin = await binProvider();
  if (!bin.path) {
    return reply.code(409).send({ ok: false, error: { code: 'YTDLP_NOT_FOUND', message: 'yt-dlp 未找到或路径无效', next: '请到设置页配置 yt-dlp 路径后重试' } });
  }
  const jobsRepo = createJobsRepo(db);
  const jobId = jobsRepo.create('ytdlp_download', { url, options: body.options, title: body.title ?? null, durationSec: body.durationSec ?? null });
  await startDownload(jobId, { url, options: body.options, title: typeof body.title === 'string' ? body.title : undefined, durationSec: typeof body.durationSec === 'number' ? body.durationSec : undefined });
  return reply.code(201).send({ ok: true, jobId });
});
```

> **Task 5→6 接口约定（务必遵守）**：`startDownload(jobId, payload)` 是本文件内的异步辅助函数——建 job 后调用：`jobsRepo.update(jobId,{status:'running'})` → 解析 payload 的 `options` → `buildDownloadArgs` → `downloadManager.start({ jobId, binPath, args, outDir: tempDir, onEvent })` → onEvent 内：progress→`jobsRepo.update(jobId,{progress})`；status done→调用 `finalizeDownload(jobId, payload)`（入库：title 用 `payload.title ?? '下载音频'`、duration 用 `payload.durationSec ?? await probeDuration(ffprobePath, producedPath)`、format 用 payload.options.format；`ffprobePath` 取自 binProvider 的 ffmpeg 同级目录 `ffprobe` 或 settings `bin_ffmpeg` 的同名推导，探测失败返回 null）；status error→`jobsRepo.fail(jobId, msg)`。**下载产物路径由 download.ts 在 close 前从输出文件解析并附在 done 事件的 `producedPath` 上**。

> **startDownload / finalizeDownload 实际代码（本步写入 ytdlp-routes.ts 模块级，Task 5 落、Task 6 复用）**：
> ```ts
> // 模块级辅助(在 registerYtdlpRoutes 外,通过参数注入 deps 更易测;此处为可注入闭包工厂)
> function createDownloadHandlers(deps: YtdlpDeps) {
>   const { db, binProvider, downloadManager, audioDir, tempDir, token } = deps;
>   const jobsRepo = createJobsRepo(db);
>   const audioRepo = createAudioItemsRepo(db);
>   let ffprobePath: string | null = null; // 首次用时惰性探测
>   async function getFfprobe(): Promise<string | null> {
>     if (ffprobePath) return ffprobePath;
>     const settings = createSettingsRepo(db);
>     const ffmpegPath = settings.get(SETTINGS_KEYS.binFfmpeg);
>     if (ffmpegPath) ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
>     return ffprobePath;
>   }
>   async function finalizeDownload(jobId: number, payload: { url: string; options: Record<string, unknown>; title?: string; durationSec?: number }, producedPath: string): Promise<void> {
>     // P1-2:入库全流程包 try/catch——rename 被占/权限/IO 失败不得 unhandled rejection
>     let audioId: number | null = null;
>     try {
>       const format = String(payload.options.format ?? 'mp3') as 'mp3' | 'm4a' | 'wav';
>       const section = (payload.options as { section?: { start: number; end: number } }).section;
>       // P1-3:片段下载强制 ffprobe 实测(片段时长 ≠ parse 的整条时长),忽略 payload.durationSec
>       const needProbe = Boolean(section) || payload.durationSec === undefined;
>       const duration = needProbe && (await getFfprobe()) ? await probeDuration((await getFfprobe())!, producedPath) : payload.durationSec ?? null;
>       const size = statSync(producedPath).size;
>       const result = ingestDownloadedFile({
>         tmpPath: producedPath, title: payload.title ?? '下载音频', format,
>         durationSec: duration, fileSize: size, sourceUrl: payload.url,
>         audioDir, exists: existsSync, audioRepo,
>       });
>       audioId = result.audioId;
>       jobsRepo.finish(jobId);
>       emit(jobId, { type: 'done', audioId: result.audioId, filePath: result.finalPath, title: payload.title ?? '下载音频', format });
>       emit(jobId, { type: 'status', state: 'done' });
>     } catch (err) {
>       // 回滚:已 INSERT 的行删除 + job 置 error + SSE error(禁止残留指向 temp 的悬空行)
>       if (audioId !== null) audioRepo.delete(audioId);
>       const msg = err instanceof Error ? err.message : String(err);
>       jobsRepo.fail(jobId, msg);
>       emit(jobId, { type: 'status', state: 'error', message: msg });
>     }
>   }
>   async function startDownload(jobId: number, payload: { url: string; options: Record<string, unknown>; title?: string; durationSec?: number }): Promise<void> {
>     jobsRepo.update(jobId, { status: 'running' });
>     const opt = (payload.options ?? {}) as { entryIndices?: number[]; section?: { start: number; end: number }; format?: string; quality?: string };
>     const bin = await binProvider();
>     if (!bin.path) { jobsRepo.fail(jobId, mapYtdlpError({ binPath: null }).message); return; }
>     const args = buildDownloadArgs({
>       url: payload.url,
>       options: {
>         entryIndices: opt.entryIndices,
>         section: opt.section,
>         format: (opt.format ?? 'mp3') as 'mp3' | 'm4a' | 'wav',
>         quality: opt.quality,
>       },
>       outDir: tempDir,
>     });
>     downloadManager.start({
>       jobId, binPath: bin.path, args, outDir: tempDir,
>       onEvent: (jid, ev) => {
>         if (ev.type === 'progress') jobsRepo.update(jid, { progress: ev.percent });
>         if (ev.type === 'status' && ev.state === 'done' && ev.producedPath) {
>           void finalizeDownload(jid, payload, ev.producedPath);
>         }
>         if (ev.type === 'status' && ev.state === 'error' && ev.message) {
>           jobsRepo.fail(jid, ev.message);
>           emit(jid, { type: 'status', state: 'error', message: ev.message });
>         }
>       },
>     });
>   }
>   return { startDownload, finalizeDownload, getFfprobe };
> }
> ```
> `YtdlpDeps` 需导出（供测试构造）；`registerYtdlpRoutes` 内改为 `const { startDownload } = createDownloadHandlers({ db, binProvider, downloadManager, audioDir, tempDir, token });`，download/retry 路由复用 `startDownload`。
>
> **ytdlp-routes.ts 模块级 import 清单（本文件随各步累计）**：`createJobsRepo`/`createAudioItemsRepo`/`createSettingsRepo`（`../db/repo/…`）、`SETTINGS_KEYS`（`../settings-keys.js`）、`buildDownloadArgs`（`./args.js`）、`ingestDownloadedFile`（`./ingest.js`）、`probeDuration`（`./ffprobe.js`）、`mapYtdlpError`（`./errors.js`）、`statSync`/`existsSync`（`node:fs`）、`parseMetadata`/`YtdlpRunError`（`./parse.js`）、`createJobsRepo` 的 `JobRow` 类型（如需）。

> **download.ts 的 producedPath 逻辑已在 Task 3 实现**（`close(0)` 分支用 `findLatest(activeOutDir.get(jobId))` 解析产物路径附进内部 done 事件；`cancel` 清理半成品 P2-2）。Task 5 不再改动 download.ts，仅消费其 `producedPath`——`DownloadEvent` 内部 `{ type:'status'; state:'done'; producedPath?: string }` 只在 DownloadManager→路由层内部流转，**SSE 对外 `status done` 与 `done` 由路由层在 `finalizeDownload` 入库后另发（spec 0.3 类型）**，两处不冲突（见 Task 6）。

> **Task 5 的最终断言点**：`finalizeDownload` 完成两段式入库（`ingestDownloadedFile`）后 `jobsRepo.finish(jobId)` 且 `audio_items` 新增一行、`file_path` 为 `{slug}-{id前8位}.{ext}`。SSE 推送 gap 由 Task 6 闭合。

- [x] **Step 6: 补 download 单测（校验/DUPLICATE/BUSY/201）**

```ts
// ytdlp-routes.test.ts 追加
it('download format 非法 → 400', async () => {
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'u', options: { format: 'flac' } } });
  expect(res.statusCode).toBe(400);
});
it('download 已有同 URL 条目且非 force → 409 DUPLICATE', async () => {
  createAudioItemsRepo(db).create({ title: '已有', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' } } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('DUPLICATE');
});
it('download 同 URL 已有 running job → 409 BUSY(P1-1)', async () => {
  // 预置一个 running 的同 URL job
  const jobsRepo = createJobsRepo(db);
  const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
  jobsRepo.update(jid, { status: 'running' });
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3', force: true } } });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('BUSY');
});
it('download 合法 → 201 返回 jobId', async () => {
  makeApp('yt-dlp', 'tok2', createDownloadManager());
  const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' }, title: '课' } });
  expect(res.statusCode).toBe(201);
  expect(typeof res.json().jobId).toBe('number');
  // job 已建且 running
  const job = createJobsRepo(db).get(res.json().jobId)!;
  expect(job.status).toBe('running');
});
```
（入库链路由 ingest.test.ts 保证；finalize 全链路留 Task 9 端到端）

- [x] **Step 7: typecheck + 全量单测**

Run: `cd server && pnpm test && pnpm typecheck`
Expected: 全绿；typecheck exit 0

- [x] **Step 8: Commit**

```bash
git add server/src/ytdlp/ingest.ts server/src/ytdlp/ingest.test.ts server/src/ytdlp/ffprobe.ts server/src/ytdlp/ffprobe.test.ts server/src/ytdlp/ytdlp-routes.ts server/src/ytdlp/ytdlp-routes.test.ts
git commit -m "feat(server): 下载闭环——job 创建、子进程、两段式入库"
```

---

### Task 6: SSE 事件桥 + cancel + retry

> **实施注记（2026-09-28 Task 6 落地）**：实现主体逐字转录 brief；3 处最小偏离（均已在代码注释标注）——①**retry 成功用例注入假 DownloadManager**：brief 原用 `createDownloadManager()` 会真实拉起本机 yt-dlp 访问 `https://a/1` 并写 `C:/tmp`（同 Task 5 ② 同一问题），测试不封闭，注入假件仅断言路由契约（201/新 jobId）；②**retry 透传 title/durationSec**：brief 只透 url/options，若照抄，重试后的下载会丢标题回落"下载音频"（`finalizeDownload` 用 `payload.title ?? '下载音频'`），故将原任务 payload 的 title/durationSec 一并传入 `startDownload`；③**startDownload 的 bin 缺失分支补 emit error**：progress.md Minor deferred ⑯ 明确"Task 6 落 SSE 时补"——否则该分支只 fail 不 emit，已订阅的 SSE 连接永不收到终态而悬挂。SSE 实时流（真实 listen + fetch 读流）按 brief 留 Task 9 端到端手工验证；单测覆盖 401/404 静态分支。

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（SSE 订阅表、`GET /api/jobs/:id/events`、`POST /api/jobs/:id/cancel`、`POST /api/jobs/:id/retry`）
- Modify: `server/src/ytdlp/ytdlp-routes.test.ts`（SSE/cancel/retry 用例）

**Interfaces:**
- Consumes: Task 5 的 `emit` 占位、`createJobsRepo`、`DownloadManager.cancel`
- Produces: 完整 SSE（D3 query token + 心跳 + 终态补发）

- [x] **Step 1: 实现 SSE 订阅表 + events 路由**

```ts
// ytdlp-routes.ts 顶部(模块级):
import { createJobsRepo } from '../db/repo/jobs.js';
type SseConn = { write: (s: string) => void; end: () => void };
const sseConnections = new Map<number, Set<SseConn>>();
// 终态:done/error/cancelled 事件后断开连接(progress/running 不断开)
const TERMINAL_STATES = new Set(['done', 'error', 'cancelled']);
function emit(jobId: number, ev: unknown): void {
  const set = sseConnections.get(jobId);
  if (!set) return;
  const type = (ev as { type: string }).type;
  const state = type === 'status' ? (ev as { state?: string }).state : type;
  for (const conn of set) conn.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
  if (type === 'done' || (type === 'status' && state && TERMINAL_STATES.has(state))) {
    for (const conn of set) conn.end();
    sseConnections.delete(jobId);
  }
}
```
> 注：上述 `emit` 与模块级 `sseConnections` 需与 Task 5 的 `emit` 占位合并（替换占位）。SSE 连接持有 Fastify `reply.raw` 的写/结束引用。

```ts
// 路由内:
app.get('/api/jobs/:id/events', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const q = (req.query ?? {}) as { token?: string };
  if (q.token !== token) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
  const jobsRepo = createJobsRepo(db);
  const job = jobsRepo.get(id);
  if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
  const raw = reply.raw;
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
  });
  const conn: SseConn = { write: (s) => raw.write(s), end: () => raw.end() };
  if (!sseConnections.has(id)) sseConnections.set(id, new Set());
  sseConnections.get(id)!.add(conn);
  const heartbeat = setInterval(() => { raw.write(': ping\n\n'); }, 15_000);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    sseConnections.get(id)?.delete(conn);
    if (sseConnections.get(id)?.size === 0) sseConnections.delete(id);
  });
  // 已结束的 job 立即补发终态
  if (['done', 'error', 'cancelled'].includes(job.status)) {
    conn.write(`event: status\ndata: ${JSON.stringify({ state: job.status, message: job.message ?? undefined })}\n\n`);
    conn.end();
  }
  return reply; // 已 hijack reply.raw,返回 reply 对象防 Fastify 二次响应
});
```
> **Fastify SSE 约定**：`reply.raw` 直接写流后，handler 返回 `reply`（不返回 payload）且必须确保未被 Fastify 自动结束——本实现用 `reply.raw.writeHead` 先行锁定头。

- [x] **Step 2: cancel / retry 路由**

```ts
app.post('/api/jobs/:id/cancel', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const jobsRepo = createJobsRepo(db);
  const job = jobsRepo.get(id);
  if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
  await downloadManager.cancel(id);
  jobsRepo.update(id, { status: 'cancelled', message: '用户取消' });
  emit(id, { type: 'status', state: 'cancelled', message: '用户取消' });
  return { ok: true };
});

app.post('/api/jobs/:id/retry', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const jobsRepo = createJobsRepo(db);
  const old = jobsRepo.get(id);
  if (!old) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
  // P1-4:仅 error 可重试——对 running/pending 重试会造出同 URL 并发
  if (old.status !== 'error') {
    return reply.code(409).send({ ok: false, error: { code: 'NOT_RETRYABLE', message: '只有失败的任务可以重试', next: '' } });
  }
  let payload: { url?: string; options?: unknown };
  try { payload = JSON.parse(old.payload) as typeof payload; } catch {
    return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '原任务参数损坏，无法重试', next: '重新提交下载' } });
  }
  if (typeof payload.url !== 'string') {
    return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '原任务缺少 url，无法重试', next: '重新提交下载' } });
  }
  // P1-4:建新 job 前同样过并发检查——防"旧 job 已 error 但同 URL 另有 running job"的窗口
  const activeJob = jobsRepo.findActiveByUrl(payload.url);
  if (activeJob) {
    return reply.code(409).send({ ok: false, error: { code: 'BUSY', message: '该 URL 正在下载中', next: '等待当前下载结束或先取消再重试' } });
  }
  const newId = jobsRepo.create('ytdlp_download', payload);
  jobsRepo.update(newId, { status: 'running' });
  // 复用 Task 5 的下载启动逻辑:提取为 startDownload(jobId, payload) 辅助函数,本处与 Task5 共用
  await startDownload(newId, payload as { url: string; options?: Record<string, unknown> });
  return reply.code(201).send({ ok: true, jobId: newId });
});
```
> **重构点**：把 Task 5 download 路由里"解析 payload → buildDownloadArgs → downloadManager.start"抽成 `startDownload(jobId, payload, deps)`，download 路由与 retry 共用，避免重复（DRY）。

- [x] **Step 3: SSE/cancel/retry 单测**

```ts
// ytdlp-routes.test.ts 追加
it('events token 错误 → 401', async () => {
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'GET', url: '/api/jobs/1/events?token=bad' });
  expect(res.statusCode).toBe(401);
});
it('events job 不存在 → 404', async () => {
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events?token=tok2' });
  expect(res.statusCode).toBe(404);
});
it('cancel 不存在 job → 404', async () => {
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'POST', url: '/api/jobs/999/cancel' });
  expect(res.statusCode).toBe(404);
});
it('retry 非 error job → 409 NOT_RETRYABLE(P1-4)', async () => {
  const jobsRepo = createJobsRepo(db);
  const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
  jobsRepo.update(jid, { status: 'running' });
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('NOT_RETRYABLE');
});
it('retry error job 但同 URL 有 running → 409 BUSY(P1-4)', async () => {
  const jobsRepo = createJobsRepo(db);
  const errJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
  jobsRepo.fail(errJid, '网络失败');
  const runJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
  jobsRepo.update(runJid, { status: 'running' });
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'POST', url: `/api/jobs/${errJid}/retry` });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('BUSY');
});
it('retry error job 且无并发 → 201 新 jobId', async () => {
  const jobsRepo = createJobsRepo(db);
  const errJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
  jobsRepo.fail(errJid, '网络失败');
  makeApp('yt-dlp', 'tok2', createDownloadManager());
  const res = await app.inject({ method: 'POST', url: `/api/jobs/${errJid}/retry` });
  expect(res.statusCode).toBe(201);
  expect(typeof res.json().jobId).toBe('number');
  expect(res.json().jobId).not.toBe(errJid);
});
```
> SSE 实时流（真实 listen + fetch 读流）留作 Task 9 端到端手工验证；单测覆盖 401/404 静态分支。

- [x] **Step 4: typecheck + 全量单测**

Run: `cd server && pnpm test && pnpm typecheck`
Expected: 全绿；typecheck exit 0

- [x] **Step 5: Commit**

```bash
git add server/src/ytdlp/ytdlp-routes.ts server/src/ytdlp/ytdlp-routes.test.ts
git commit -m "feat(server): SSE 事件桥 + cancel/retry"
```

---

### Task 7: audio 列表与文件流路由

> **实施注记（2026-09-28 Task 7 落地）**：实现主体逐字转录 brief；2 处偏离——①**`list()` 补 `ORDER BY created_at DESC, id DESC`（`server/src/db/repo/audio-items.ts`）**：spec §0.4 明确 `list(): AudioItemRow[]`（按 created_at DESC），但 Task 2 落地时漏了 ORDER BY（brief 的 `app.get('/api/audio', async () => audioRepo.list())` 假定 repo 已排好序）；Task 7 首次消费该接口，为满足 spec「GET /api/audio 按 created_at DESC」补齐，`id DESC` 作同秒并列的稳定 tiebreaker。文件不在本 Task 的 Files 清单内，但它是 spec 契约的一部分，已并入本 Task 提交；②**`import { createReadStream } from 'node:fs'` 合入顶部 import**（brief 代码块把 import 写在路由下方，ESM 非法位置）——语义不变。其余逐字转录：`GET /api/audio` 返回数组（非 `{ok,items}`）、`GET /api/audio/:id/file` 走 D3 query token（`<audio>` 标签无法设 header）+ P2-5 非正整数 id → 404 + MIME 映射 + `content-disposition: inline` + `accept-ranges: bytes` + 流式响应。

**Files:**
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（`GET /api/audio`、`GET /api/audio/:id/file`）
- Modify: `server/src/ytdlp/ytdlp-routes.test.ts`（补用例）

**Interfaces:**
- Consumes: `createAudioItemsRepo`（Task 2）
- Produces: `GET /api/audio`（列表）、`GET /api/audio/:id/file`（流 + Content-Type 映射 + D3 query token）

- [x] **Step 1: 实现路由**

```ts
const MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };

// spec 0.3:GET /api/audio 返回数组(非 {ok,items})
app.get('/api/audio', async () => audioRepo.list());

app.get('/api/audio/:id/file', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const q = (req.query ?? {}) as { token?: string };
  if (q.token !== token) return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
  // P2-5:id 非正整数(Number('abc')/0/负数)→ 404,避免 NaN 查询行为未定义
  if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
  const item = audioRepo.get(id);
  if (!item) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
  if (!existsSync(item.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '文件已丢失', next: '' } });
  reply
    .header('content-type', MIME[item.format] ?? 'application/octet-stream')
    .header('content-disposition', 'inline')
    .header('accept-ranges', 'bytes');
  return reply.send(createReadStream(item.file_path));
});
import { createReadStream } from 'node:fs';
```

- [x] **Step 2: 补单测**

```ts
it('audio 文件 token 错 → 401;不存在 → 404;非正整数 id → 404;存在 → 200 + Content-Type', async () => {
  const audioRepo = createAudioItemsRepo(db);
  const audioDir = mkdtempSync(join(tmpdir(), 'sct-audio-'));
  const id = audioRepo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: join(audioDir, 't.mp3'), format: 'mp3', duration_sec: null, file_size: 3 });
  writeFileSync(join(audioDir, 't.mp3'), 'abc');
  makeApp('yt-dlp', 'tok2');
  expect((await app.inject({ method: 'GET', url: `/api/audio/${id}/file?token=bad` })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/audio/999/file?token=tok2' })).statusCode).toBe(404);
  // P2-5:非正整数 id → 404
  expect((await app.inject({ method: 'GET', url: '/api/audio/abc/file?token=tok2' })).statusCode).toBe(404);
  expect((await app.inject({ method: 'GET', url: '/api/audio/0/file?token=tok2' })).statusCode).toBe(404);
  const ok = await app.inject({ method: 'GET', url: `/api/audio/${id}/file?token=tok2` });
  expect(ok.statusCode).toBe(200);
  expect(ok.headers['content-type']).toBe('audio/mpeg');
  expect(ok.body).toBe('abc');
});
it('audio 列表返回全部', async () => {
  createAudioItemsRepo(db).create({ title: 'a', source_type: 'download', source_url: 'u', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
  makeApp('yt-dlp', 'tok2');
  const res = await app.inject({ method: 'GET', url: '/api/audio' });
  expect(res.json()).toHaveLength(1);
  expect(res.json()[0].title).toBe('a');
});
```

- [x] **Step 3: typecheck + 全量单测**

Run: `cd server && pnpm test && pnpm typecheck`
Expected: 全绿；typecheck exit 0

- [x] **Step 4: Commit**

```bash
git add server/src/ytdlp/ytdlp-routes.ts server/src/ytdlp/ytdlp-routes.test.ts
git commit -m "feat(server): 音频列表与文件流路由(query token)"
```

---

### Task 8: web——获取页 + 音频库页 + api 增补

> **实施注记（2026-09-29 Task 8 落地）**：Step 4 的导航片段是"Card 下插入"的 JSX 片段而非完整文件——按片段直接插入后 `index.tsx` 出现两个顶层兄弟节点，`tsc` 报 TS2657（JSX 表达式必须单一父节点）。最小修正：把 Card 与导航 Space 包进 `<>...</>` 空 Fragment（typecheck/build 均 exit 0）。其余 4 个文件逐字转录 brief；commit `f5c377d`。另注：acquire.tsx 的 `List` import 实际未使用（brief 原文自带，`noUnusedLocals` 未开故 tsc 不报，留待后续清理）。

**Files:**
- Modify: `web/src/api.ts`（增补封装）
- Create: `web/src/pages/acquire.tsx`
- Create: `web/src/pages/library.tsx`
- Modify: `web/src/pages/index.tsx`（导航）
- Modify: `web/.umirc.ts`（routes）

**Interfaces:**
- Consumes: `apiGet`（现有）、`apiToken`（现有）、server 接口契约（spec §0.3）
- Produces: `parseUrl`、`startDownload`、`subscribeJob`、`cancelJob`、`retryJob`、`listAudio`、`audioFileUrl`

- [x] **Step 1: api.ts 增补**

```ts
// web/src/api.ts 追加
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string; next?: string } } | null;
      throw new ApiError(j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`);
    }
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

// spec §0.3 接口契约:parse 返回 kind/title/duration_sec/entries/existing
export interface ParseResponse {
  ok: boolean; kind: 'single' | 'playlist'; title: string; duration_sec?: number;
  entries?: { index: number; title: string }[];
  existing?: { audioId: number; title: string };
}
export interface DownloadPayload {
  url: string;
  title?: string;
  durationSec?: number;
  options: { entryIndices?: number[]; section?: { start: number; end: number }; format: 'mp3' | 'm4a' | 'wav'; quality?: string; force?: boolean };
}

export function parseUrl(url: string): Promise<ParseResponse> {
  return apiPost<ParseResponse>('/api/ytdlp/parse', { url });
}
export function startDownload(payload: DownloadPayload): Promise<{ ok: boolean; jobId: number }> {
  return apiPost<{ ok: boolean; jobId: number }>('/api/ytdlp/download', payload);
}
export function cancelJob(jobId: number): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {});
}
export function retryJob(jobId: number): Promise<{ ok: boolean; jobId: number }> {
  return apiPost<{ ok: boolean; jobId: number }>(`/api/jobs/${jobId}/retry`, {});
}
export async function listAudio(): Promise<AudioRow[]> {
  return apiGet<AudioRow[]>('/api/audio');
}
export interface AudioRow { id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string }

export function audioFileUrl(id: number): string {
  const token = apiToken();
  return `${API_BASE}/api/audio/${id}/file?token=${encodeURIComponent(token ?? '')}`;
}

export function subscribeJob(jobId: number, handlers: {
  onProgress?: (p: { percent: number }) => void;
  onDone?: (d: { audioId: number; title: string; format: string }) => void;
  onStatus?: (s: { state: string; message?: string }) => void;
  onError?: (msg: string) => void;
}): () => void {
  const token = apiToken();
  const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/events?token=${encodeURIComponent(token ?? '')}`);
  es.addEventListener('progress', (e) => handlers.onProgress?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('done', (e) => handlers.onDone?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as { state: string; message?: string };
    handlers.onStatus?.(s);
    if (s.state === 'error' || s.state === 'cancelled') { handlers.onError?.(s.message ?? s.state); es.close(); }
    if (s.state === 'done') es.close();
  });
  es.onerror = () => { handlers.onError?.('连接中断'); es.close(); };
  return () => es.close();
}
```

- [x] **Step 2: 写 library.tsx**

```tsx
// web/src/pages/library.tsx
import { Empty, List, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { apiGet, audioFileUrl } from '@/api';

interface AudioRow { id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string }
export default function LibraryPage() {
  const [items, setItems] = useState<AudioRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<AudioRow[]>('/api/audio').then(setItems).catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <Typography.Text type="danger">{error}</Typography.Text>;
  if (items.length === 0) return <Empty description="暂无音频，先去获取页下载吧" style={{ marginTop: 64 }} />;
  return (
    <List
      style={{ margin: 16 }}
      dataSource={items}
      renderItem={(it) => (
        <List.Item>
          <List.Item.Meta title={it.title} description={`${it.format} · ${it.duration_sec ? `${it.duration_sec.toFixed(1)}s` : '时长未知'} · ${it.created_at}`} />
          <audio controls src={audioFileUrl(it.id)} style={{ width: 320 }} />
        </List.Item>
      )}
    />
  );
}
```

- [x] **Step 3: 写 acquire.tsx（URL 输入 → parse → 勾选/格式 → 下载 → 进度）**

```tsx
// web/src/pages/acquire.tsx
import { Alert, Button, Card, Checkbox, Input, List, Progress, Radio, Space, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { cancelJob, parseUrl, startDownload, subscribeJob, type ParseResponse } from '@/api';

export default function AcquirePage() {
  const [url, setUrl] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<number[]>([1]);
  const [format, setFormat] = useState<'mp3' | 'm4a' | 'wav'>('mp3');
  const [jobId, setJobId] = useState<number | null>(null);
  const [percent, setPercent] = useState(0);
  const [done, setDone] = useState<{ audioId: number; title: string } | null>(null);
  const [busy, setBusy] = useState(false); // P1-1:提交 in-flight 守卫 + 逐条串行中

  // jobId 变化时建立 EventSource 订阅;done/error 后关闭
  useEffect(() => {
    if (jobId === null) return;
    return subscribeJob(jobId, {
      onProgress: (p) => setPercent(Math.round(p.percent)),
      onDone: (d) => setDone({ audioId: d.audioId, title: d.title }),
      onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') setError(s.message ?? s.state); },
    });
  }, [jobId]);

  // 等待单个 job 终结的 Promise(供逐条串行用);resolve 前必清定时器(P1-5)
  const waitJobEnd = (jid: number): Promise<'done' | 'error' | 'cancelled'> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => { close(); resolve('error'); }, 60_000); // 兜底:60s 无事件也放行
      const close = subscribeJob(jid, {
        onDone: () => { clearTimeout(timer); close(); resolve('done'); },
        onStatus: (s) => { if (s.state === 'error' || s.state === 'cancelled') { clearTimeout(timer); close(); resolve(s.state); } },
      });
    });

  const onParse = async () => {
    setParsing(true); setError(null); setParsed(null);
    try {
      const r = await parseUrl(url);
      setParsed(r);
      if (r.kind === 'playlist' && r.entries) setChecked([1]);
    } catch (e) { setError((e as Error).message); }
    finally { setParsing(false); }
  };

  // D8:合集多选逐条提交——每条一个 job,串行下载(单产物入库模型)
  const onDownload = async (force = false) => {
    if (!parsed || busy) return;
    // P2-8:合集全不勾选 → 直接提示,不空转
    if (parsed.kind === 'playlist' && parsed.entries && checked.length === 0) {
      setError('请至少勾选一个条目');
      return;
    }
    setBusy(true); setError(null); setDone(null); setPercent(0);
    try {
      const entries = parsed.kind === 'playlist' && parsed.entries ? checked : [0]; // [0] 表示非合集(不带 entryIndices)
      let lastDone: { audioId: number; title: string } | null = null;
      for (const entryIndex of entries) {
        const { jobId: jid } = await startDownload({
          url,
          title: entryIndex === 0 ? parsed.title : parsed.entries!.find((e) => e.index === entryIndex)?.title ?? parsed.title,
          durationSec: entryIndex === 0 ? parsed.duration_sec : undefined, // 合集条目 parse 无时长 → ffprobe 兜底
          options: {
            entryIndices: entryIndex === 0 ? undefined : [entryIndex],
            format,
            force,
          },
        });
        setJobId(jid);
        const end = await waitJobEnd(jid);
        if (end !== 'done') break; // 失败/取消:停止后续条目
        lastDone = { audioId: 0, title: entries.length === 1 ? '' : `条目 ${entryIndex} 完成` };
      }
      if (entries.length > 1 && lastDone) setDone({ audioId: 0, title: '全部条目下载完成' });
    } catch (e) { setError((e as Error).message); }
     finally { setBusy(false); setJobId(null); }
  };
  return (
    <Card title="URL 下载" style={{ margin: 16 }}>
      <Space.Compact style={{ width: '100%' }}>
        <Input value={url} placeholder="粘贴 B 站/YouTube/播客 URL" onChange={(e) => setUrl(e.target.value)} />
        <Button type="primary" onClick={onParse} loading={parsing}>解析</Button>
      </Space.Compact>
      {error && <Alert type="error" showIcon message="下载失败" description={error} style={{ marginTop: 12 }} />}
      {parsed && (
        <div style={{ marginTop: 16 }}>
          <Typography.Title level={5}>{parsed.title}</Typography.Title>
          {parsed.existing && !done && (
            <Alert type="warning" showIcon message={`库中已有《${parsed.existing.title}》`} action={<Button size="small" onClick={() => onDownload(true)}>仍下载</Button>} style={{ marginBottom: 8 }} />
          )}
          {parsed.kind === 'playlist' && parsed.entries && (
            <Checkbox.Group value={checked} onChange={(v) => setChecked(v as number[])}>
              <Space direction="vertical">
                {parsed.entries.map((e) => <Checkbox key={e.index} value={e.index}>{e.title}</Checkbox>)}
              </Space>
            </Checkbox.Group>
          )}
          <Radio.Group value={format} onChange={(e) => setFormat(e.target.value)} style={{ marginTop: 12 }}>
            <Radio value="mp3">mp3</Radio><Radio value="m4a">m4a</Radio><Radio value="wav">wav</Radio>
          </Radio.Group>
          <br />
          <Button type="primary" onClick={() => onDownload(false)} loading={busy} disabled={busy} style={{ marginTop: 12 }}>下载</Button>
        </div>
      )}
      {jobId !== null && !done && (
        <div style={{ marginTop: 16 }}>
          <Progress percent={percent} status={percent >= 100 ? 'success' : 'active'} />
          <Space>
            <Button size="small" onClick={() => cancelJob(jobId)}>取消</Button>
          </Space>
        </div>
      )}
      {done && <Alert type="success" showIcon message={`完成：《${done.title}》已入库`} style={{ marginTop: 16 }} />}
      {parsing && <Spin style={{ marginTop: 16 }} />}
    </Card>
  );
}
```
> **subscribeJob 接入已完整**：acquire 页的 `useEffect`（依赖 `jobId`）已在 Step 3 组件代码中给出，订阅 progress/done/error/cancelled 事件。

- [x] **Step 4: index.tsx 加导航 + umirc routes**

```tsx
// index.tsx 内 Card 下加:
<Space style={{ marginTop: 16 }}>
  <Button type="primary" onClick={() => (window.location.hash = '#/acquire')}>去获取</Button>
  <Button onClick={() => (window.location.hash = '#/library')}>去音频库</Button>
</Space>
```

```ts
// web/.umirc.ts routes:
routes: [
  { path: '/', component: 'index' },
  { path: '/settings', component: 'settings' },
  { path: '/acquire', component: 'acquire' },
  { path: '/library', component: 'library' },
],
```

- [x] **Step 5: typecheck + build**

Run: `cd web && pnpm typecheck && pnpm build`
Expected: 均 exit 0（build 产物 `web/dist` 就绪，供 Task 9 file:// 验证）

- [x] **Step 6: Commit**

```bash
git add web/src/api.ts web/src/pages/acquire.tsx web/src/pages/library.tsx web/src/pages/index.tsx web/.umirc.ts
git commit -m "feat(web): 获取页(URL 下载 + SSE 进度)与音频库页(列表播放)"
```

---

### Task 9: 端到端 + 收尾

**Files:**
- 无新增（验证为主）

- [x] **Step 1: 全量验证（三包）**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: 三包 typecheck 0 错；`pnpm test` server 全绿（含既有 M0 + 新增 S2 用例）；build 三包 exit 0

- [x] **Step 2: 手工端到端（用户目验）**

1. `pnpm dev` 三进程起
2. 浏览器/electron 打开 `#/acquire`：粘贴 B 站课程 URL → 解析出合集列表（默认勾第 1 条）→ 选 mp3 → 下载 → SSE 进度条到 100% → 提示入库
3. `#/library`：列表出现该条，点击播放有声音
4. 再次解析同一 URL → 顶部出现"已存在"警告 + "仍下载"按钮
5. 下载中点"取消"→ 进度消失，无残留 yt-dlp/ffmpeg 进程（`Get-Process | Where-Object {$_.ProcessName -match 'yt-dlp|ffmpeg'}`）；且 `.sct/dev-data/tmp` 下无残留半成品（P2-2）
6. 下载进行中再次点"下载"（同 URL）→ 收到 `BUSY` 提示"该 URL 正在下载中"（P1-1）
7. 片段下载（输起止时间）→ 完成后库中条目时长 ≈ 片段时长而非整条（P1-3）
8. 设置页把 yt-dlp 路径清空 → 解析报 `YTDLP_NOT_FOUND` + 设置页指引

- [x] **Step 3: 文档回写（落地扫描）**

- `docs/superpowers/specs/m1a-ytdlp-pipeline.md`：按实测修订（进度模板格式、SSE 细节、任何偏差）
- `.superpowers/sdd/2026-09-28-m1a-ytdlp-pipeline/progress.md`：逐 Task 台账
- **落地扫描**（用户规则）：用 `Get-ChildItem docs -Recurse -Include *.md | Select-String -Pattern '未做|未验证|待建|TODO'` 检查所有"声明 S2 状态"的地方，含 PRD §6.1-S2（若标记为待开发）——确保无过时描述

- [x] **Step 4: Commit（若 Step 2 有代码修正）**

```bash
git add -A
git commit -m "fix(m1a): 端到端修正与文档回写"
```

---

## Self-Review（写作时已自查）

1. **Spec 覆盖**：FR-1.1（parse/合集勾选/D8）✅ Task 4+8｜FR-1.2（片段）✅ Task 1 args｜FR-1.3（音频提取）✅ Task 1 args｜FR-1.4（SSE 进度 + 完成入口）✅ Task 5/6/8｜FR-1.5（错误映射/重试）✅ Task 1 errors + Task 6 retry｜§3.4（stderr 翻译/原子改名/启动恢复复用）✅｜§3.5（slug/冲突/重复）✅ Task 1 slug + Task 5 ingest｜§4.1（无新表）✅ Task 2。
2. **占位符扫描**：无 TBD/TODO；`parse.ts` 的 `normalizeParse` 已导出供单测（非占位）。acquire.tsx 已含完整 `useEffect` 订阅（subscribeJob 接口在 api.ts 定义）。
3. **类型一致**：`DownloadOptions`（Task 1）→ `buildDownloadArgs`（Task 1）→ Task 5 使用；`DownloadEvent`（Task 3）→ emit（Task 5/6）；`AudioItemRow`（Task 2）→ ingest/list/file（Task 5/7）；`YtdlpErrorInfo`（Task 1）→ parse/errors（Task 1/4）。
