# 资料库 UI 精修 + 清晰度按实测列档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现；**禁止 commit**（见 Global Constraints）。

**Goal:** 把资料库的「来源名 + 档位/下载/删除来源」从横跨全宽的页面头降为右栏头部，工具栏与导航项图标化并补齐 tooltip，新增「在浏览器打开原视频页」，并把清晰度档位从硬编码四档改成**按当前视频实测列出可用分辨率**（探测失败自动降级）。

**Architecture:** 服务端新增一个只读探测接口（跑 `yt-dlp -J` 取 formats → 抽 height → 去重降序），进程内缓存，失败一律降级返回固定四档；前端资料库把页面头挪进右栏、档位改为按探测结果渲染；`videoHeight` 类型放宽为整数并补服务端校验（否则等于把任意值拼进 ffmpeg 参数）。

**Tech Stack:** Fastify 5 + node:sqlite（server）｜UmiJS Max 4 + antd 5 + @ant-design/icons（web）

**Spec:** `docs/superpowers/specs/2026-09-30-library-ui-polish.md`（决定 D1–D11；本计划是它的实施论证）

## Global Constraints

- **禁止 commit**：本仓提交授权制——子代理一律不 commit，任务完成即停，由用户按逻辑块自行提交。每个任务的最后一步是「停在此处」，**不是** commit。
- **每任务第一步 Read 目标文件磁盘实况**；每次编辑后**读回核对**；同一文件**禁止并行** `SearchReplace`。
- **不引入任何新依赖**（`@ant-design/icons` 已是既有依赖）。
- `pushLog` 的 source 只能用 `server/src/logs.ts` 联合类型里的**既有值**（本计划用到 `'server'` / `'job'` / `'media'`，**不新增联合成员**）。
- **`execFile` 三参回调取 stderr**；**退出码 0 ≠ 有产物**（既有铁律）。
- 验证基线：`pnpm typecheck`（三包 0 错）+ `pnpm --filter @sct/server test`（当前 **38 文件 / 321 用例**，逐任务增量）+ `pnpm --filter @sct/web build`。
- 中文注释，说明「为什么」。
- **探测是增强，不许变成单点故障**：任何探测异常都必须降级成固定四档 `[360,480,720,1080]` 并回 `fallback:true`，**不得**让下载不可用。
- 失败路径要有 `logFe`/`pushLog`，不得静默 catch。

---

## Task 1: 服务端 —— 可用分辨率探测（模块 + 路由 + 缓存 + 降级）

**Files:**
- Create: `server/src/ytdlp/probe-formats.ts`
- Create: `server/src/ytdlp/probe-formats.test.ts`
- Create: `server/src/media/formats-routes.ts`
- Create: `server/src/media/formats-routes.test.ts`
- Modify: `server/src/ytdlp/args.ts`（加 `buildProbeFormatsArgs`）
- Modify: `server/src/index.ts`（注册路由）
- Create: `server/src/ytdlp/__fixtures__/formats-single.json`、`formats-playlist-item.json`

**Interfaces:**
- Consumes: `binProvider: () => Promise<{ path: string | null }>`（既有，见 `ytdlp-routes.ts:37`）、`resolveCookiePath(db, audioDir)`（既有）、`mapYtdlpError`（既有）
- Produces:
  - `buildProbeFormatsArgs(url: string, opts?: { entry?: number; cookiePath?: string }): string[]`
  - `extractHeights(raw: unknown): number[]` —— 纯函数，从 yt-dlp JSON 抽 height
  - `probeHeights(binPath: string, url: string, entry: number | undefined, doExec?, cookiePath?): Promise<number[]>`
  - `registerFormatsRoutes(app, { db, binProvider, audioDir })` → `GET /api/imports/:id/formats`
  - 导出常量 `FALLBACK_TIERS = [360, 480, 720, 1080]`

- [ ] **Step 1: 用真实 yt-dlp 摸清 JSON 形状（这一步不能省）**

> spec 已把"拿不到就回退"写死，所以**最坏情况只是退回四档**；但你**必须确认到底哪种形状**，否则 fixture 是编的、测试等于自证。

用资料库里已有的一条真实来源跑（先取 URL）：

```powershell
# 取一条真实来源 URL（dev 库）
node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.sct/dev-data/sct.db');console.log(db.prepare('SELECT id,url,kind FROM imported_sources LIMIT 3').all())"

# ① 单视频：非 flat 的 -J
yt-dlp -J --no-warnings "<单视频 url>" > .sct/probe-single.json

# ② 合集第 N 集：带 --playlist-items
yt-dlp -J --no-warnings --playlist-items 1 "<合集 url>" > .sct/probe-playlist.json
```

用 Node 看关键路径（**不要**整文件粘进报告，文件可能几 MB）：

```powershell
node -e "for (const f of ['single','playlist']) { const j=JSON.parse(require('node:fs').readFileSync('.sct/probe-'+f+'.json','utf8')); const e=j.entries?.[0]; console.log(f, 'root.formats=', Array.isArray(j.formats), 'entries[0].formats=', Array.isArray(e?.formats), 'root.height=', j.height, 'entries[0].height=', e?.height); }"
```

把这四个布尔/数值记进报告。**然后**把这两份 JSON **裁剪**成 fixture（只留 `{ formats:[{height,vcodec,...}], entries:[{...}] }` 的形状，删掉 storyboard/缩略图等大字段），存到 `server/src/ytdlp/__fixtures__/`。

- [ ] **Step 2: 写失败测试（`server/src/ytdlp/probe-formats.test.ts`）**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProbeFormatsArgs, extractHeights, probeHeights, FALLBACK_TIERS } from './probe-formats.js';

const fixture = (n: string) => JSON.parse(readFileSync(join(__dirname, '__fixtures__', n), 'utf8'));

describe('extractHeights', () => {
  it('单视频：抽 height、去重、降序、剔除 vcodec=none、剔除 <360', () => {
    expect(extractHeights(fixture('formats-single.json'))).toEqual([1080, 720, 480, 360]);
  });
  it('合集：从 entries[0] 抽', () => {
    expect(extractHeights(fixture('formats-playlist-item.json'))).toEqual([720, 360]);
  });
  it('没有 formats → 空数组（交给调用方降级）', () => {
    expect(extractHeights({ title: 'x' })).toEqual([]);
  });
});

describe('buildProbeFormatsArgs', () => {
  it('单视频：不含 --playlist-items', () => {
    const a = buildProbeFormatsArgs('https://a/v');
    expect(a).toContain('-J');
    expect(a).not.toContain('--playlist-items');
  });
  it('合集某集：含 --playlist-items <n>', () => {
    const a = buildProbeFormatsArgs('https://a/p', { entry: 3 });
    expect(a[a.indexOf('--playlist-items') + 1]).toBe('3');
  });
  it('带 cookie：--cookies 在 url 之前', () => {
    const a = buildProbeFormatsArgs('https://a/v', { cookiePath: 'C:/tmp/ck.txt' });
    expect(a.indexOf('--cookies')).toBeLessThan(a.indexOf('https://a/v'));
  });
});

describe('probeHeights', () => {
  it('doExec 成功 → 返回 heights', async () => {
    const out = JSON.stringify(fixture('formats-single.json'));
    const h = await probeHeights('yt-dlp', 'https://a/v', undefined,
      ((_b, _a, _o, cb) => cb(null, out, '')) as never);
    expect(h).toEqual([1080, 720, 480, 360]);
  });
  it('doExec 失败 → 抛错（由上层降级）', async () => {
    await expect(probeHeights('yt-dlp', 'https://a/v', undefined,
      ((_b, _a, _o, cb) => cb(Object.assign(new Error('boom'), { code: '1' }), '', 'ERROR: HTTP Error 412')) as never,
    )).rejects.toThrow();
  });
  it('FALLBACK_TIERS 是固定四档', () => {
    expect(FALLBACK_TIERS).toEqual([360, 480, 720, 1080]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/ytdlp/probe-formats.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 实现 `probe-formats.ts`**

```ts
// 探测"这个视频实际有哪些清晰度"（spec D6）。纯读取，不下任何字节。
// 与 parse.ts 同族：三参回调取 stderr（Node 不保证 err.stderr 挂载）、大 maxBuffer。
import { execFile } from 'node:child_process';
import { buildProbeFormatsArgs } from './args.js';

/** spec D7：探测失败时的固定兜底档位（UI 静默沿用） */
export const FALLBACK_TIERS = [360, 480, 720, 1080];

/** 单视频的 formats 在根上；合集条目在 entries[].formats —— 两种形状都认（实测见报告） */
export function extractHeights(raw: unknown): number[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const withEntries = Array.isArray(o.entries) ? (o.entries[0] as Record<string, unknown> | undefined) : undefined;
  const formats = Array.isArray(o.formats) ? o.formats
    : Array.isArray(withEntries?.formats) ? withEntries!.formats
      : [];
  const heights = (formats as Array<Record<string, unknown>>)
    .filter((f) => f.vcodec != null && f.vcodec !== 'none')   // 纯音频格式没有画面，不算档位
    .map((f) => (typeof f.height === 'number' ? f.height : NaN))
    .filter((h) => Number.isFinite(h) && h >= 360)            // <360 的档位对素材没意义
    .map((h) => Math.round(h));
  return [...new Set(heights)].sort((a, b) => b - a);          // 去重 + 降序
}

export function probeHeights(
  binPath: string, url: string, entry: number | undefined,
  doExec: typeof execFile = execFile, cookiePath?: string, timeoutMs = 15_000,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    doExec(binPath, buildProbeFormatsArgs(url, { entry, cookiePath }), { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        reject(new Error(String(stderr ?? e.stderr ?? e.message).slice(0, 300)));
        return;
      }
      try {
        resolve(extractHeights(JSON.parse(stdout)));
      } catch {
        reject(new Error('yt-dlp 输出不是合法 JSON'));
      }
    });
  });
}
```

`args.ts` 追加（**放在文件末尾**，注意 `args.ts` 的 `import { join }` 在文件最后一行之后——按磁盘实况放好）：

```ts
/** 探测可用清晰度(spec D6):-J 拿完整 JSON(非 flat,flat 没有 formats);合集只探指定的一集 */
export function buildProbeFormatsArgs(url: string, opts?: { entry?: number; cookiePath?: string }): string[] {
  const args: string[] = [];
  if (opts?.cookiePath) args.push('--cookies', opts.cookiePath);
  args.push('-J', '--no-warnings');
  if (opts?.entry !== undefined) args.push('--playlist-items', String(opts.entry));
  args.push(url);
  return args;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @sct/server test src/ytdlp/probe-formats.test.ts`
Expected: PASS

- [ ] **Step 6: 写失败测试（`server/src/media/formats-routes.test.ts`）**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerFormatsRoutes } from './formats-routes.js';
import { FALLBACK_TIERS } from '../ytdlp/probe-formats.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;

function makeApp(probe: (url: string, entry?: number) => Promise<number[]>): FastifyInstance {
  const a = Fastify();
  registerFormatsRoutes(a, {
    db, audioDir: join(mkdtempSync(join(tmpdir(), 'sct-fmt-')), 'audio'),
    binProvider: async () => ({ path: 'yt-dlp' }),
    probe,           // 注入：本路由单测不打真实外网
  });
  return a;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  db.prepare("INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)").run('https://a/v', 't', 'bilibili', 'single');
  db.prepare("INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)").run('https://a/p', 'p', 'bilibili', 'playlist');
});

describe('GET /api/imports/:id/formats', () => {
  it('单视频成功 → heights 降序、fallback:false', async () => {
    app = makeApp(async () => [2160, 1080, 720]);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, heights: [2160, 1080, 720], fallback: false });
  });
  it('合集缺 entry → 400', async () => {
    app = makeApp(async () => [720]);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/2/formats' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_REQUEST');
  });
  it('探测失败 → 200 + fallback 四档（不报错，spec D7）', async () => {
    app = makeApp(async () => { throw new Error('timeout'); });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, heights: FALLBACK_TIERS, fallback: true });
  });
  it('探测结果为空 → 也算降级', async () => {
    app = makeApp(async () => []);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(r.json()).toMatchObject({ fallback: true, heights: FALLBACK_TIERS });
  });
  it('id 不存在 → 404', async () => {
    app = makeApp(async () => [720]);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/999/formats' });
    expect(r.statusCode).toBe(404);
  });
  it('缓存：同 url+entry 第二次不再探测（D9）', async () => {
    let calls = 0;
    app = makeApp(async () => { calls += 1; return [720]; });
    await app.ready();
    await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 7: 跑测试确认失败 → 实现 `formats-routes.ts` → 再跑通**

```ts
// 可用清晰度探测(spec D6/D7/D9)。只读、不下载；任何失败都降级成固定四档，绝不让下载不可用。
import type { FastifyInstance } from 'fastify';
import { createImportsRepo } from '../db/repo/imports.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { pushLog } from '../logs.js';
import type { DB } from '../db/index.js';
import { FALLBACK_TIERS, probeHeights } from '../ytdlp/probe-formats.js';

export interface FormatsDeps {
  db: DB; audioDir: string;
  binProvider: () => Promise<{ path: string | null }>;
  /** B 站 cookie 文件路径（既有 resolveCookiePath 的产物）；未配置/物化失败 → undefined（照常探测） */
  cookiePath?: () => string | undefined;
  /** 可注入：单测不打真实外网 */
  probe?: (url: string, entry?: number) => Promise<number[]>;
}

const TTL_MS = 10 * 60 * 1000; // spec D9

export function registerFormatsRoutes(app: FastifyInstance, deps: FormatsDeps): void {
  const importsRepo = createImportsRepo(deps.db);
  const cache = new Map<string, { at: number; heights: number[] }>();

  app.get('/api/imports/:id/formats', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '回资料库刷新列表' } });
    }
    const row = importsRepo.get(id);
    if (row === null) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '回资料库刷新列表' } });
    }
    // 合集必须带 entry（spec D8）：193 集不可能全探，只探用户选中的那一集
    const rawEntry = (req.query as { entry?: string }).entry;
    const entry = rawEntry !== undefined && rawEntry !== '' ? Number(rawEntry) : undefined;
    if (row.kind === 'playlist' && (entry === undefined || !Number.isInteger(entry) || entry <= 0)) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '合集需要先选一集', next: '在集数网格里点一集' } });
    }

    const key = `${row.url}#${entry ?? ''}`;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < TTL_MS) {
      return { ok: true, heights: hit.heights, fallback: hit.heights.length === 0 };
    }

    // 降级出口只有一个，避免"某条分支忘了 fallback"
    const degrade = (why: string) => {
      pushLog('error', 'media', `清晰度探测降级 import=${id} entry=${entry ?? '-'} 原因=${why}`);
      return { ok: true, heights: FALLBACK_TIERS, fallback: true };
    };
    try {
      const bin = await deps.binProvider();
      if (!bin.path) return degrade('yt-dlp 未找到');
      const probe = deps.probe ?? ((url, e) => probeHeights(bin.path!, url, e, undefined, deps.cookiePath?.()));
      const heights = await probe(row.url, entry);
      if (heights.length === 0) return degrade('拿不到 formats');
      cache.set(key, { at: Date.now(), heights });
      pushLog('info', 'media', `清晰度探测 import=${id} entry=${entry ?? '-'} → ${heights.join('/')}`);
      return { ok: true, heights, fallback: false };
    } catch (e) {
      return degrade(e instanceof Error ? e.message : String(e));
    }
  });
}
```

- [ ] **Step 8: 注册路由（`server/src/index.ts`）**

磁盘实况（已核，2026-09-30）：`index.ts:80-86` 的 `binProvider` 是**内联在 `registerYtdlpRoutes` 的 deps 里的闭包**（没有独立函数）；`resolveCookiePath` 是 `ytdlp-routes.ts:72` 的**模块私有函数**（未导出）。所以要动三处：

1. 把那个闭包**提出来**成局部常量（放在 `registerYtdlpRoutes` 调用之前），两处共用——避免出现第二条"取 bin"的路径（同族教训：两处各写一份公式迟早漂移）：

```ts
    // 取 yt-dlp 路径的**唯一**来源（原本内联在 registerYtdlpRoutes 的 deps 里；探测路由也要用 → 提出来共用）
    const ytdlpBinProvider = async (): Promise<{ path: string | null }> => {
      const explicit = settingsRepo.get(SETTINGS_KEYS.binYtdlp);
      const p = await probeBin('yt-dlp', explicit ?? undefined);
      return { path: p.path };
    };
    registerYtdlpRoutes(app, { db, binProvider: ytdlpBinProvider /* ...其余 deps 一字不动... */ });
```

2. 把 `ytdlp-routes.ts:72` 的 `function resolveCookiePath(...)` 改成 **`export function`**，并在 `index.ts` 里 import 它。

3. 注册探测路由（放在 `registerMediaRoutes` 之后、`registerProjectRoutes` 之前）：

```ts
    // 可用清晰度探测（spec D6）：只读、失败降级；走 fetch（带 header）→ 无守卫豁免
    registerFormatsRoutes(app, {
      db, audioDir, binProvider: ytdlpBinProvider,
      cookiePath: () => resolveCookiePath(db, audioDir),
    });
```

- [ ] **Step 9: 全量验证**

Run: `pnpm --filter @sct/server test`（基线 321 + 本任务新增 ≥12）
Run: `pnpm --filter @sct/server typecheck`
Expected: 全绿 / 0 错

- [ ] **Step 10: 停在此处**（不 commit）

---

## Task 2: 服务端 —— `videoHeight` 放宽 + 校验

**Files:**
- Modify: `server/src/ytdlp/args.ts`（`DownloadOptions.videoHeight`、`buildVideoDownloadArgs` 的形参类型）
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（提交下载时校验；`:206` 的窄断言）
- Modify: `server/src/ytdlp/args.test.ts`、`server/src/ytdlp/ytdlp-routes.test.ts`

**Interfaces:**
- Produces: `validateVideoHeight(v: unknown): number | null`（放在 `ytdlp-routes.ts` 内的模块级函数即可）

- [ ] **Step 1: 写失败测试（追加到 `ytdlp-routes.test.ts`）**

```ts
it('videoHeight 任意合法整数（1440）→ 200 且 args 含 height<=1440', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download',
    payload: { url: 'https://a/v', options: { format: 'mp3', videoHeight: 1440 }, produce: 'video', title: 't' } });
  expect(res.statusCode).toBe(201);
  const startOpts = dm.start.mock.calls.at(-1)?.[0] as { args: string[] };
  expect(startOpts.args.join(' ')).toContain('height<=1440');
});
it.each([[100], [5000], ['abc'], [720.5], [null]])('videoHeight 非法 %s → 400', async (bad) => {
  const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download',
    payload: { url: 'https://a/v', options: { format: 'mp3', videoHeight: bad }, produce: 'video', title: 't' } });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('BAD_REQUEST');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/ytdlp/ytdlp-routes.test.ts`
Expected: FAIL（1440 那条现在会被窄类型/缺省逻辑吃掉或校验缺失）

- [ ] **Step 3: 改 `args.ts`**：把 `videoHeight?: 360 | 480 | 720 | 1080` 与 `buildVideoDownloadArgs` 的形参改成 `videoHeight?: number`（**只改类型**，表达式一字不动）。

- [ ] **Step 4: 改 `ytdlp-routes.ts`**：在提交下载分支（`startDownload` 之前、`createJobsRepo` 附近）加校验：

```ts
/** spec D10：档位来自前端实测，可能是任意值 → 必须挡住非法值（否则等于把任意值拼进 ffmpeg 参数） */
function validateVideoHeight(v: unknown): number | null {
  if (v === undefined || v === null) return 480;             // 缺省沿用既有 480
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  return v >= 144 && v <= 4320 ? v : null;
}
```
调用处：`produce === 'video'` 时 `const h = validateVideoHeight(opt.videoHeight); if (h === null) return reply.code(400).send({ ok:false, error:{ code:'BAD_REQUEST', message:'清晰度不合法', next:'在资料库重新选择清晰度' } });`
并把 `:206` 的 `as 360 | 480 | 720 | 1080` 窄断言去掉（直接用 `h`）。

- [ ] **Step 5: 全量验证 + 停在此处**

Run: `pnpm --filter @sct/server test` / `pnpm --filter @sct/server typecheck`

---

## Task 3: 前端 —— 资料库布局搬移 + 工具栏图标化 + 原视频页

**Files:**
- Modify: `web/src/pages/library.tsx`

**Interfaces:**
- Consumes: `detail.url`（`ImportDetail` 已有）、`ImportSource.url`
- Produces: 无（叶子任务）

- [ ] **Step 1: 布局搬移（spec D1/D2）**

把 `<PageHeader>` 从外层 flex column 的**第一个子项**位置上摘掉，改为挂在**右栏容器内部的最上面**。目标结构：

```tsx
<div style={{ display: 'flex', height: '100%', minHeight: 0, overflow: 'hidden' }}>
  {/* 左：来源列表 —— 顶到内容区最上（不再被页面头压下去） */}
  <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column' }}>
    {/* ...既有「+ 新导入」与列表一字不动... */}
  </div>

  {/* 右：详情 —— 页面头降为这一栏的头部（spec D1）。
      传 Fragment 让 PageHeader 的工具栏行直接排布控件 */}
  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
    {detail !== null && <PageHeader ... />}   {/* 原样搬过来，props 一字不改 */}
    <div style={{ flex: 1, minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* ...既有错误 Alert / 空态 / Card 一字不动... */}
    </div>
  </div>
</div>
```

> 外层容器从 `flexDirection:'column'` 改成默认 row（左列表 + 右栏）。右栏由「PageHeader（flexShrink:0）+ 内容（flex:1 可滚）」两段组成——**这正是 PageHeader 设计时假定的用法**，组件本身不用改。

- [ ] **Step 2: 工具栏图标化 + 原视频页（spec D3/D4）**

import 补：`Tooltip`（antd）、`DeleteOutlined, DownloadOutlined, LinkOutlined`（`@ant-design/icons`）。把工具栏里三个按钮换掉：

```tsx
{/* D3：在浏览器打开原视频页（桌面壳已有外链出口，见 main.ts setWindowOpenHandler）；
    没有 url 时禁用并说明原因，而不是点了没反应 */}
<Tooltip title={detail.url ? '在浏览器打开原视频页' : '没有原视频地址'}>
  <span>
    <Button icon={<LinkOutlined />} disabled={!detail.url}
      href={detail.url || undefined} target="_blank" rel="noreferrer" />
  </span>
</Tooltip>
{/* D4：图标 + tooltip（禁用态用 span 垫层，否则 antd Tooltip 收不到鼠标事件） */}
<Tooltip title="下载视频素材">
  <span>
    <Button type="primary" icon={<DownloadOutlined />} onClick={onDownloadVideo}
      loading={busy} disabled={busy || (detail.kind === 'playlist' && videoSelectedIndex === null)} />
  </span>
</Tooltip>
<Tooltip title="删除这个来源">
  <Button danger icon={<DeleteOutlined />} onClick={() => onDeleteSource(detail.id)} />
</Tooltip>
```
（档位 `Radio.Group` 保持在本行最前，本任务不动它。）

- [ ] **Step 3: 验证**

Run: `pnpm --filter @sct/web typecheck` / `pnpm --filter @sct/web build`
手工：左列表顶到最上；标题+控件在右栏顶部；三个按钮有图标 + 悬停中文提示；原视频页能打开系统浏览器。

- [ ] **Step 4: 停在此处**（不 commit）

---

## Task 4: 前端 —— 档位按实测渲染 + 探测接线

**Files:**
- Modify: `web/src/api.ts`（`getFormats()`；`videoHeight` 类型放宽）
- Modify: `web/src/pages/library.tsx`（探测 + 档位渲染 + 过期响应丢弃）

**Interfaces:**
- Consumes: `GET /api/imports/:id/formats?entry=<n>`（Task 1）
- Produces: `getFormats(importId: number, entry?: number): Promise<{ ok: boolean; heights: number[]; fallback: boolean }>`

- [ ] **Step 1: `api.ts`**

```ts
/** 可用清晰度探测（spec D6）：服务端保证不报错，探测失败会回固定四档 + fallback:true */
export function getFormats(importId: number, entry?: number): Promise<{ ok: boolean; heights: number[]; fallback: boolean }> {
  const q = entry !== undefined ? `?entry=${entry}` : '';
  return apiGet(`/api/imports/${importId}/formats${q}`);
}
```
并把 `DownloadPayload.options.videoHeight` 的类型 `360 | 480 | 720 | 1080` → `number`（**只改类型**）。

- [ ] **Step 2: `library.tsx` 接线**

**⚠️ Ruling（2026-09-30，Task 1 实测发现，spec 未预料）**：B 站实测档位**不是规整档位**——真实值形如 `[1056, 704, 470]`（编码高度本来就这样）。直接显示会变成「1056p / 704p / 470p」，看着像坏了。
**所以**：API **忠实返回实测高度**（Task 1 已如此实现，不再改动服务端）；**界面负责把标签归一到常见档位，但下载仍传实测值**（`height<=1056` 才能精确命中那一路流；传 1080 虽也能命中，但传实测值语义最准）。
归一规则（放在本任务里，纯前端）：
```ts
const STD_TIERS = [240, 360, 480, 720, 1080, 1440, 2160, 4320];
/** 实测高度 → 展示标签：找 ±15% 内最近的标准档位；找不到就原样显示（如 900 → 900p） */
function tierLabel(h: number): string {
  const near = STD_TIERS.find((s) => Math.abs(s - h) / h <= 0.15);
  return `${near ?? h}p`;
}
```
Radio 选项因此是 `options={tiers.map((h) => ({ label: tierLabel(h), value: h }))}`（**value 是实测值**，不是标签）。

**先改既有 state 的类型**（否则 `setVideoHeight` 收不下实测出来的 1440/2160）：把
`const [videoHeight, setVideoHeight] = useState<360 | 480 | 720 | 1080>(480);`
改成
`const [videoHeight, setVideoHeight] = useState<number>(480);`

然后加探测状态与 effect：

```tsx
const [tiers, setTiers] = useState<number[]>([360, 480, 720, 1080]);  // 初值就是兜底四档
const [tiersFallback, setTiersFallback] = useState(false);
const [probing, setProbing] = useState(false);
const probeSeq = useRef(0);   // 过期响应丢弃（spec §0.5）：换集后回来的旧响应不许覆盖新结果

useEffect(() => {
  if (detail === null) return;
  const entry = detail.kind === 'playlist' ? (videoSelectedIndex ?? undefined) : undefined;
  if (detail.kind === 'playlist' && entry === undefined) return;   // spec D8：未选集不请求
  const seq = ++probeSeq.current;
  setProbing(true);
  getFormats(detail.id, entry)
    .then((r) => {
      if (seq !== probeSeq.current) return;                        // 旧响应，丢弃
      setTiers(r.heights.length > 0 ? r.heights : [360, 480, 720, 1080]);
      setTiersFallback(r.fallback);
      // 当前选中的档位若不在新列表里 → 落到最高可用档（否则 Radio 会显示出"无选中"）
      setVideoHeight((cur) => (r.heights.includes(cur) ? cur : (r.heights[0] ?? 480)));
    })
    .catch((e: unknown) => {
      if (seq !== probeSeq.current) return;
      setTiers([360, 480, 720, 1080]); setTiersFallback(true);      // 兜底：探测不到就退四档
      logFe('error', `清晰度探测失败 import=${detail.id}: ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => { if (seq === probeSeq.current) setProbing(false); });
}, [detail, videoSelectedIndex]);
```

档位渲染（替换原硬编码 options）：

```tsx
<Tooltip title={tiersFallback ? '未能读取视频信息，已用常用档位' : '清晰度（来自该视频的可用档位）'}>
  <span>
    <Radio.Group
      value={videoHeight}
      optionType="button"
      disabled={probing || (detail.kind === 'playlist' && videoSelectedIndex === null)}
      options={tiers.map((h) => ({ label: `${h}p`, value: h }))}
      onChange={(e) => setVideoHeight(e.target.value as number)}
    />
  </span>
</Tooltip>
{tiersFallback && !probing && (
  <Typography.Text type="secondary" style={{ fontSize: 12 }}>未能读取视频信息，已用常用档位</Typography.Text>
)}
{detail.kind === 'playlist' && videoSelectedIndex === null && (
  <Typography.Text type="secondary" style={{ fontSize: 12 }}>先选一集再看清晰度</Typography.Text>
)}
```

- [ ] **Step 3: 验证**

Run: `pnpm --filter @sct/web typecheck` / `pnpm --filter @sct/web build`
手工：选单视频 → 档位按实测变；断网再试 → 退回四档 + 小字说明、**不弹错**；合集未选集 → 档位禁用 + 提示；选集后 → 刷新为该集的档位；快速切换集 → 不会出现"显示的是上一集档位"。

- [ ] **Step 4: 停在此处**（不 commit）

---

## Task 5: 导航 Tab 图标 + PageHeader 注释扫正

**Files:**
- Modify: `web/src/layouts/index.tsx`
- Modify: `web/src/components/PageHeader.tsx`

- [ ] **Step 1: `NAV_ITEMS` 加图标（spec D5）**

```tsx
import { HomeOutlined, ScissorOutlined, SettingOutlined, VideoCameraOutlined } from '@ant-design/icons';

const NAV_ITEMS = [
  { key: '/', label: '首页', icon: <HomeOutlined /> },
  { key: '/library', label: '资料库', icon: <VideoCameraOutlined /> },
  { key: '/studio', label: '剪辑室', icon: <ScissorOutlined /> },
  { key: '/settings', label: '设置', icon: <SettingOutlined /> },
];
```
（antd `Menu` 的 `items` 原生支持 `icon`，`selectedKeys`/`onClick` 逻辑一字不动。）

- [ ] **Step 2: `PageHeader.tsx` 注释扫正（spec D11）**

把第 3 行的「设置页用这个简化形态」改成实况描述，例如：
```ts
// toolbar 不传 → 不渲染第二行（当前无调用方这样用；曾误记为"设置页用简化形态"，实际设置页是一摞 Card）。
```

- [ ] **Step 3: 验证 + 停在此处**

Run: `pnpm --filter @sct/web typecheck` / `pnpm --filter @sct/web build`
手工：4 个 Tab 都有图标，切换高亮正常（含 `/studio/12` 让"剪辑室"高亮这条既有行为）。

---

## 附：任务依赖与串行约束

| 共享文件 | 涉及任务 | 约束 |
|---|---|---|
| `server/src/ytdlp/args.ts` | T1（加函数）、T2（改类型） | **串行** T1 → T2 |
| `server/src/ytdlp/ytdlp-routes.ts` | T2 | 独占 |
| `server/src/index.ts` | T1（注册） | 独占 |
| `web/src/pages/library.tsx` | T3（布局+图标）、T4（探测接线） | **串行** T3 → T4（同文件） |
| `web/src/api.ts` | T4 | 独占 |
| `web/src/layouts/index.tsx`、`PageHeader.tsx` | T5 | 独占 |

**顺序**：T1 → T2 → T3 → T4 → T5。T5 与 T1/T2 无交集，但为审查清晰仍按序推进。
