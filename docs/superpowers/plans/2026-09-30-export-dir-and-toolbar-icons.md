# 导出目录可配置 + 工具栏图标化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现；**禁止 commit**（本仓提交授权制，见 Global Constraints）。

**Goal:** 让用户能在设置页指定导出产物的落盘目录，并把「打开导出目录」做成一键动作（工具栏与导出成功绿条各一个入口），同时把剪辑详情页工具栏的 5 个文字按钮换成图标 + 悬停提示 + 点击 loading。

**Architecture:** 服务端新增单一解析点 `resolveOutputDir(db, fallback)`（复用早已存在但从未使用的 `output_dir` 设置键）；导出 job 运行时现读该设置决定落盘目录，并补 Windows 跨盘 `EXDEV` 兜底；桌面壳新增一条最小 IPC（`revealPath` / `pickDirectory`），前端在唯一的桥接模块里封装，工具栏与绿条共用同一个 `openExportDir()`。

**Tech Stack:** Fastify 5 + node:sqlite（server）｜Electron 44 + contextBridge（desktop）｜UmiJS Max 4 + antd 5 + @ant-design/icons（web）

**Spec:** `docs/superpowers/specs/2026-09-30-export-dir-and-toolbar-icons.md`（决定 D1–D13；本计划是它的实施论证）

## Global Constraints

- **禁止 commit**：本仓提交授权制——子代理一律不 commit，任务完成即停，由用户按逻辑块自行提交。计划里每个任务的最后一步是「停在此处待用户授权」，**不是** commit。
- **每任务第一步 Read 目标文件磁盘实况**；每次编辑后**读回核对**；同一文件**禁止并行** `SearchReplace`。
- **不引入任何新依赖**（spec D10；`@ant-design/icons` 已是既有依赖）。
- **pushLog 的 source 只能用 `server/src/logs.ts:14` 联合类型里的既有值**（本计划用到 `'server'` / `'media'` / `'job'`，不新增）。
- **执行器三参回调取 stderr**；**退出码 0 ≠ 有产物**（沿用仓库既有铁律）。
- 验证基线：`pnpm typecheck`（三包 0 错）+ `pnpm --filter @sct/server test`（基线 **308** 用例，逐任务增量）+ `pnpm --filter @sct/web build`。
- 中文注释；注释说明「为什么」。
- **不改变任何既有接口的语义**：`output_dir` 留空时行为必须与今天逐字一致（spec D2）。

---

## Task 1: 服务端 —— 输出目录单一解析点 + 设置路由校验

**Files:**
- Create: `server/src/output-dir.ts`
- Create: `server/src/output-dir.test.ts`
- Create: `server/src/http/settings-routes.test.ts`
- Modify: `server/src/http/settings-routes.ts`
- Modify: `server/src/index.ts`（调用点补第三参）
- Modify: `server/src/ytdlp/ytdlp-routes.test.ts`（第 66 行调用点同步）

**Interfaces:**
- Consumes: `createSettingsRepo(db).get(key: string): string | null`（既有）、`SETTINGS_KEYS.outputDir === 'output_dir'`（既有）
- Produces:
  - `resolveOutputDir(db: DB, fallbackDir: string): string` —— 供 Task 2 的导出 job 与设置路由共用
  - `registerSettingsRoutes(app: FastifyInstance, db: DB, defaultOutputDir: string): void` —— 第三参为新加
  - `GET /api/settings` 响应新增 `output_dir_resolved: string`

- [ ] **Step 1: 写失败测试（`server/src/output-dir.test.ts`）**

```ts
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { SETTINGS_KEYS } from './settings-keys.js';
import { resolveOutputDir } from './output-dir.js';

const freshDb = () => { const db = openDatabase(':memory:'); initSchema(db); return db; };

describe('resolveOutputDir(输出目录单一解析点)', () => {
  it('未配置 / 空串 → 回退到 fallback', () => {
    const db = freshDb();
    const fallback = join(tmpdir(), 'sct-fallback');
    expect(resolveOutputDir(db, fallback)).toBe(fallback);
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, '');
    expect(resolveOutputDir(db, fallback)).toBe(fallback);
  });
  it('配了绝对路径 → 用配置值', () => {
    const db = freshDb();
    const custom = mkdtempSync(join(tmpdir(), 'sct-out-'));
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, custom);
    expect(resolveOutputDir(db, join(tmpdir(), 'ignored'))).toBe(custom);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/output-dir.test.ts`
Expected: FAIL —— `Failed to resolve import "./output-dir.js"`

- [ ] **Step 3: 实现 `server/src/output-dir.ts`**

```ts
// 输出目录的**唯一解析点**（spec D11）：设置里配了就用它，留空回退到传入的默认目录。
// 为什么要单一来源：设置路由（要回 output_dir_resolved 给前端）与导出 job（要决定落盘位置）
// 必须给出同一个答案；两处各写一份公式，迟早漂移（同族教训：P4-T7-7 的派生列 SQL 去重）。
import type { DB } from './db/index.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { SETTINGS_KEYS } from './settings-keys.js';

export function resolveOutputDir(db: DB, fallbackDir: string): string {
  const configured = createSettingsRepo(db).get(SETTINGS_KEYS.outputDir);
  return configured !== null && configured.trim() !== '' ? configured : fallbackDir;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @sct/server test src/output-dir.test.ts`
Expected: PASS（2 用例）

- [ ] **Step 5: 写失败测试（`server/src/http/settings-routes.test.ts`）**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { registerSettingsRoutes } from './settings-routes.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;
let defaultDir: string;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'sct-settings-'));
  defaultDir = join(root, 'audio');
  mkdirSync(defaultDir, { recursive: true });
  db = openDatabase(':memory:');
  initSchema(db);
  app = Fastify();
  registerSettingsRoutes(app, db, defaultDir);
  await app.ready();
});

describe('PUT /api/settings 的 output_dir 校验(spec D4/D5/D11)', () => {
  it('未配置时 GET 回 output_dir_resolved === defaultOutputDir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().output_dir_resolved).toBe(defaultDir);
  });
  it('相对路径 → 400 且不落库', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: 'exports' } });
    expect(res.statusCode).toBe(400);
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.outputDir)).toBeNull();
  });
  it('合法绝对路径 → 200,GET 能读回', async () => {
    const custom = join(root, 'my-exports');
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: custom } });
    expect(res.statusCode).toBe(200);
    const g = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().output_dir_resolved).toBe(custom);
    expect(existsSync(custom)).toBe(true); // D5：保存时就建目录
  });
  it('不可写(拿已存在的文件当目录) → 400 且不落库', async () => {
    const fileAsDir = join(root, 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: fileAsDir } });
    expect(res.statusCode).toBe(400);
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.outputDir)).toBeNull();
  });
  it('留空 → 200 且 output_dir_resolved 回到 defaultOutputDir', async () => {
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, join(root, 'x'));
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: '' } });
    expect(res.statusCode).toBe(200);
    const g = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().output_dir_resolved).toBe(defaultDir);
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/http/settings-routes.test.ts`
Expected: FAIL —— `output_dir_resolved` 为 `undefined`；相对路径那条返回 200（未被拒）

- [ ] **Step 7: 改 `server/src/http/settings-routes.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { probeBin } from '../bins.js';
import type { DB } from '../db/index.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { pushLog } from '../logs.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { resolveOutputDir } from '../output-dir.js';

const ALLOWED_KEYS = new Set<string>(Object.values(SETTINGS_KEYS));

/** D5：非空输出目录必须**当场可写**——不能让用户等到点导出那一刻才发现（那时还要跑 ffmpeg）。
 *  做法：建目录（已存在则忽略）+ 写一个临时文件再删。返回 null 表示通过，否则返回失败原因。 */
function probeWritableDir(dir: string): string | null {
  const probe = join(dir, `.sct-write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* 清理失败不影响判定 */ }
  }
  return null;
}

export function registerSettingsRoutes(app: FastifyInstance, db: DB, defaultOutputDir: string): void {
  const repo = createSettingsRepo(db);

  // 只返回白名单键 + 一个**计算字段** output_dir_resolved（spec D11）：
  // 前端要知道「留空时默认存到哪」与「打开哪个目录」，而它不知道数据目录，不能自己拼。
  app.get('/api/settings', async () => ({
    ...Object.fromEntries(Object.entries(repo.all()).filter(([k]) => ALLOWED_KEYS.has(k))),
    output_dir_resolved: resolveOutputDir(db, defaultOutputDir),
  }));

  app.put('/api/settings', async (req, reply) => {
    const raw = req.body;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return reply.code(400).send({ error: '请求体必须是对象' });
    }
    const body = raw as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(k)) return reply.code(400).send({ error: `未知设置键:${k}` });
      if (typeof v !== 'string') return reply.code(400).send({ error: `设置值必须是字符串:${k}` });
    }
    // D4+D5：**先校验、后写库**——校验不过绝不能落库，否则下次启动会拿着一个坏路径
    const rawOut = body[SETTINGS_KEYS.outputDir];
    if (typeof rawOut === 'string' && rawOut.trim() !== '') {
      if (!isAbsolute(rawOut)) {
        pushLog('error', 'server', `设置导出目录被拒(非绝对路径): ${rawOut}`);
        return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: '导出目录必须是绝对路径', next: '例如 D:\\Music\\sct' } });
      }
      const why = probeWritableDir(rawOut);
      if (why !== null) {
        pushLog('error', 'server', `设置导出目录被拒(不可写): ${rawOut} — ${why}`);
        return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: `导出目录不可写：${why}`, next: '换一个可写目录，或留空用默认目录' } });
      }
      pushLog('info', 'server', `导出目录已设为 ${rawOut}`);
    }
    for (const [k, v] of Object.entries(body)) repo.set(k, v as string);
    return { ok: true };
  });

  app.get('/api/bins/probe', async (_req, reply) => {
    /* ...既有实现一字不动... */
  });
}
```

> 注意：`/api/bins/probe` 那段保持原样，只改 import、加 `probeWritableDir`、改 GET/PUT。

- [ ] **Step 8: 同步两个调用点**

`server/src/index.ts`：把 `const audioDir = path.join(path.dirname(opts.dbPath), 'audio');`（第 67 行附近）**提前**到 `registerSettingsRoutes(app, db);`（第 54 行）之前，然后改成

```ts
    // D4:audioDir 与 db 同目录（计算提前：设置路由要拿它当"导出目录留空时的默认值"）
    const audioDir = path.join(path.dirname(opts.dbPath), 'audio');
    mkdirSync(audioDir, { recursive: true });
    registerSettingsRoutes(app, db, audioDir);
```
（原来的 `const audioDir` / `mkdirSync(audioDir, ...)` 两行删掉，避免重复声明。）

`server/src/ytdlp/ytdlp-routes.test.ts:66`：
```ts
  registerSettingsRoutes(app, db, audioDir); // 第三参=导出目录默认值（留空时用它）
```
（该文件第 62 行已有 `const audioDir = join(tempDir, 'audio')`。）

- [ ] **Step 9: 跑测试与类型检查**

Run: `pnpm --filter @sct/server test`
Expected: 全绿（基线 308 + 本任务新增 7）

Run: `pnpm --filter @sct/server typecheck`
Expected: 0 错

- [ ] **Step 10: 停在此处**

不 commit（提交授权制）。记台账后进入 Task 2。

---

## Task 2: 服务端 —— 导出落到自定义目录 + 跨盘兜底

**Files:**
- Modify: `server/src/media/ffmpeg-export.ts`
- Modify: `server/src/ytdlp/ingest.ts`
- Modify: `server/src/media/ffmpeg-export.test.ts`
- Modify: `server/src/ytdlp/ingest.test.ts`

**Interfaces:**
- Consumes: `resolveOutputDir(db, fallbackDir)`（Task 1）
- Produces: `moveIntoPlace(from: string, to: string, io?: { rename?; copyFile?; unlink? }): void`（`ingest.ts` 导出，供单测注入）

- [ ] **Step 1: 写失败测试（追加到 `server/src/ytdlp/ingest.test.ts`）**

```ts
describe('moveIntoPlace(跨盘兜底, spec D6)', () => {
  it('同盘 rename 成功 → 只调 rename', () => {
    const calls: string[] = [];
    moveIntoPlace('a', 'b', {
      rename: (() => { calls.push('rename'); }) as never,
      copyFile: (() => { calls.push('copyFile'); }) as never,
      unlink: (() => { calls.push('unlink'); }) as never,
    });
    expect(calls).toEqual(['rename']);
  });
  it('rename 抛 EXDEV → 退化为 copyFile + unlink', () => {
    const calls: string[] = [];
    moveIntoPlace('a', 'b', {
      rename: (() => { const e = new Error('cross-device') as NodeJS.ErrnoException; e.code = 'EXDEV'; throw e; }) as never,
      copyFile: (() => { calls.push('copyFile'); }) as never,
      unlink: (() => { calls.push('unlink'); }) as never,
    });
    expect(calls).toEqual(['copyFile', 'unlink']);
  });
  it('rename 抛非 EXDEV（如 EBUSY）→ 原样抛出，不做复制', () => {
    const calls: string[] = [];
    expect(() => moveIntoPlace('a', 'b', {
      rename: (() => { const e = new Error('busy') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e; }) as never,
      copyFile: (() => { calls.push('copyFile'); }) as never,
      unlink: (() => { calls.push('unlink'); }) as never,
    })).toThrow('busy');
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/ytdlp/ingest.test.ts`
Expected: FAIL —— `moveIntoPlace is not a function`

- [ ] **Step 3: 改 `server/src/ytdlp/ingest.ts`**

把 `import { renameSync } from 'node:fs';` 改为 `import { copyFileSync, renameSync, unlinkSync } from 'node:fs';`，新增：

```ts
/** 把临时产物搬到最终位置。默认同盘 `renameSync`（原子、最快）；
 *  **跨盘时会抛 EXDEV**（Windows 不同卷，spec D6）——那时退化为复制 + 删源。
 *  其它错误（EBUSY/EPERM 等）原样抛出，保持"删 DB 行 + 抛"的既有回滚语义。
 *  io 参数可注入，便于单测覆盖 EXDEV 分支（不必真造跨盘环境）。 */
export function moveIntoPlace(
  from: string, to: string,
  io?: { rename?: typeof renameSync; copyFile?: typeof copyFileSync; unlink?: typeof unlinkSync },
): void {
  const rename = io?.rename ?? renameSync;
  try { rename(from, to); return; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    (io?.copyFile ?? copyFileSync)(from, to);
    (io?.unlink ?? unlinkSync)(from);
  }
}
```

并把 `ingestDownloadedFile` 里那句 `renameSync(opts.tmpPath, finalPath);` 换成 `moveIntoPlace(opts.tmpPath, finalPath);`（try/catch 与注释一字不动）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @sct/server test src/ytdlp/ingest.test.ts`
Expected: PASS（既有用例 + 新增 3）

- [ ] **Step 5: 写失败测试（追加到 `server/src/media/ffmpeg-export.test.ts`）**

```ts
it('设置里配了导出目录 → 产物落该目录（spec D1/D3/D11）', async () => {
  const custom = join(root, 'my-exports');
  createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, custom);
  // ...沿用本文件既有的 startExportJob 调用套路（separate 1 段）...
  await startExportJob(jobId, payload, { db, audioDir, tempDir });
  const row = createAudioItemsRepo(db).list()[0]!;
  expect(dirname(row.file_path)).toBe(custom);
  expect(existsSync(row.file_path)).toBe(true);
  expect(row.source_type).toBe('edit');
});

it('导出目录被手删 → 运行时自愈重建（spec §0.4）', async () => {
  const custom = join(root, 'auto-heal');
  createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, custom);
  // ...跑完一次导出后 rmSync(custom, {recursive:true})，再跑一次...
  expect(existsSync(custom)).toBe(true);
});
```
（用本文件既有的 `db/audioDir/tempDir/jobId/payload` 变量与桩法；**不要**新建一套。）

- [ ] **Step 6: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/media/ffmpeg-export.test.ts`
Expected: FAIL —— `file_path` 的目录仍是 `audioDir`

- [ ] **Step 7: 改 `server/src/media/ffmpeg-export.ts`**

在 `startExportJob` 里、`const audioRepo = ...` 之前插入目标目录解析与自愈：

```ts
    // 目标目录**每次运行时现读设置**（spec D1/D3/D11）：payload 是"重试用"的，
    // 用户改了目录再重试就该用新目录——把目录塞进 payload 会把旧目录钉死在任务里。
    const outputDir = resolveOutputDir(deps.db, deps.audioDir);
    try {
      mkdirSync(outputDir, { recursive: true }); // 运行时自愈：手删了文件夹不必回设置页改
    } catch (e) {
      fail(`导出目录不可用：${outputDir}（${e instanceof Error ? e.message : String(e)}）`);
      return;
    }
    pushLog('info', 'job', `export job ${jobId} 目标目录 ${outputDir}`);
```

并把 `ingest = (tmp, title, durationSec)` 里传给 `ingestDownloadedFile` 的 `audioDir: deps.audioDir` 改为 `audioDir: outputDir`。
顶部 import 补：`mkdirSync`（`node:fs`）、`resolveOutputDir`（`../output-dir.js`）。

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter @sct/server test`
Expected: 全绿（基线 + 本任务新增 5）

Run: `pnpm --filter @sct/server typecheck`
Expected: 0 错

- [ ] **Step 9: 停在此处**（不 commit）

---

## Task 3: 桌面壳 —— 最小 IPC（打开目录 / 选目录）

**Files:**
- Modify: `desktop/src/preload.ts`（从 `export {}` 改成 contextBridge）
- Modify: `desktop/src/main.ts`（两个 `ipcMain.handle`）

**Interfaces:**
- Produces（渲染进程可见的全局）：
  - `window.sct.revealPath(absolutePath: string): Promise<{ ok: boolean; message?: string }>`
  - `window.sct.pickDirectory(): Promise<string | null>`
- 通道名：`sct:reveal-path` / `sct:pick-directory`

- [ ] **Step 1: 改 `desktop/src/preload.ts`**

```ts
// S1 无任何 IPC（spec D7）；本切片新增第一条：导出目录相关（spec D7）。
// 只暴露两个**能力**，不暴露任意路径执行——渲染进程给的是"要打开的目录"，校验在主进程做。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sct', {
  revealPath: (absolutePath: string): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('sct:reveal-path', absolutePath),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('sct:pick-directory'),
});
```

- [ ] **Step 2: 改 `desktop/src/main.ts`**

顶部 import 补 `ipcMain` 与 `statSync`：
```ts
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, readFileSync, statSync } from 'node:fs';
```

在 `openWindow` 之前（模块级，只注册一次）加：

```ts
/** 导出目录相关的最小 IPC（spec D7）：主进程先校验"确实是个存在的目录"，
 *  再把字符串交给系统——不允许渲染进程把任意路径丢给 shell。 */
function registerExportDirIpc(): void {
  ipcMain.handle('sct:reveal-path', (_e, p: unknown) => {
    try {
      if (typeof p !== 'string' || p.trim() === '') return { ok: false, message: '路径为空' };
      if (!existsSync(p) || !statSync(p).isDirectory()) return { ok: false, message: '目录不存在或不是文件夹' };
      // shell.openPath 返回空串 = 成功；非空串是系统给的错误描述
      return shell.openPath(p).then((msg) => (msg === '' ? { ok: true } : { ok: false, message: msg }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[electron] reveal-path 失败: ${message}`); // 仓库规则：关键步骤留痕
      return { ok: false, message };
    }
  });

  ipcMain.handle('sct:pick-directory', async () => {
    try {
      const r = await dialog.showOpenDialog(mainWindow ?? undefined, { properties: ['openDirectory'] });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]!;
    } catch (e) {
      console.error(`[electron] pick-directory 失败: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
}
```

在 `run()` 里、`app.whenReady().then(run)` 进入后**第一步**调用它（早于任何窗口创建，保证渲染进程一加载就能用）：

```ts
async function run(): Promise<void> {
  registerExportDirIpc(); // 必须在建窗口之前：渲染进程加载后可能立刻调用
  if (FILE_LOAD) { /* ...既有... */ } else { /* ...既有... */ }
}
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm --filter @sct/desktop typecheck`
Expected: 0 错

Run: `pnpm --filter @sct/desktop build`
Expected: 成功产出 `dist/main.js` 与 `dist/preload.js`

- [ ] **Step 4: 手工冒烟（可选但推荐）**

`pnpm dev` 起应用 → 在窗口里打开 DevTools 控制台，执行 `await window.sct.pickDirectory()` → 应弹出系统目录选择器；`await window.sct.revealPath('D:\\')` → 应打开资源管理器。

- [ ] **Step 5: 停在此处**（不 commit）

---

## Task 4: 前端 —— 桥接封装 + 设置页「导出目录」卡片

**Files:**
- Create: `web/src/desktop.ts`
- Create: `web/src/export-dir.ts`
- Modify: `web/src/api.ts`（`getSettings` / `putSettings`）
- Modify: `web/src/pages/settings.tsx`（新增卡片）

**Interfaces:**
- Consumes: `window.sct.revealPath` / `window.sct.pickDirectory`（Task 3）；`GET/PUT /api/settings`（Task 1）
- Produces（供 Task 5 用）：
  - `hasDesktopBridge(): boolean`、`pickDirectory(): Promise<string | null>`
  - `openExportDir(): Promise<{ ok: boolean; dir: string; message?: string }>`
  - `getSettings(): Promise<Record<string, string>>`、`putSettings(patch: Record<string, string>): Promise<{ ok: boolean }>`

- [ ] **Step 1: 建 `web/src/desktop.ts`**

```ts
// 桌面壳桥接的**唯一**出入口（spec D7/D8）：别处不许直接摸 window.sct——
// 这样"没有 Electron 时怎么办"只在一处回答（浏览器直连模式下 window.sct 为 undefined）。
import { logFe } from '@/api';

interface SctBridge {
  revealPath(absolutePath: string): Promise<{ ok: boolean; message?: string }>;
  pickDirectory(): Promise<string | null>;
}
declare global {
  interface Window { sct?: SctBridge }
}

export function hasDesktopBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.sct?.pickDirectory === 'function';
}

export async function pickDirectory(): Promise<string | null> {
  if (!hasDesktopBridge()) return null;
  try {
    return await window.sct!.pickDirectory();
  } catch (e) {
    logFe('error', `pickDirectory 失败: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function revealPath(p: string): Promise<{ ok: boolean; message?: string }> {
  if (!hasDesktopBridge()) return { ok: false, message: '仅桌面应用内可用' };
  try {
    return await window.sct!.revealPath(p);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFe('error', `revealPath 失败: ${message}`);
    return { ok: false, message };
  }
}
```

- [ ] **Step 2: 建 `web/src/export-dir.ts`**

```ts
// 「打开导出目录」的**唯一**动作（spec D7/D8/D11）：工具栏按钮与导出成功绿条里的按钮共用它，
// 避免两处各写一份"取目录 + 调桥 + 报错"。
import { getSettings, logFe } from '@/api';
import { hasDesktopBridge, revealPath } from './desktop';

export async function openExportDir(): Promise<{ ok: boolean; dir: string; message?: string }> {
  if (!hasDesktopBridge()) return { ok: false, dir: '', message: '仅桌面应用内可用' };
  let dir = '';
  try {
    const s = await getSettings();
    dir = s.output_dir_resolved ?? '';
    if (dir === '') return { ok: false, dir, message: '拿不到导出目录' };
    const r = await revealPath(dir);
    logFe(r.ok ? 'info' : 'error', `打开导出目录 ${dir} → ${r.ok ? 'ok' : (r.message ?? '失败')}`);
    return { ok: r.ok, dir, message: r.message };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logFe('error', `打开导出目录失败: ${message}`);
    return { ok: false, dir, message };
  }
}
```

- [ ] **Step 3: 在 `web/src/api.ts` 加设置读写（放在 `getCookieStatus` 附近）**

```ts
/** GET /api/settings：白名单键 + 计算字段 output_dir_resolved（导出目录实际生效值，spec D11） */
export function getSettings(): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>('/api/settings');
}

/** PUT /api/settings：值必须是字符串（服务端约束）；失败时 apiPut 已带后端 error.next */
export function putSettings(patch: Record<string, string>): Promise<{ ok: boolean }> {
  logFe('info', `putSettings ${Object.keys(patch).join(',')}`);
  return apiPut<{ ok: boolean }>('/api/settings', patch);
}
```

- [ ] **Step 4: 在 `web/src/pages/settings.tsx` 加「导出目录」卡片**

顶部 import 补：`hasDesktopBridge, pickDirectory`（`@/desktop`）、`getSettings, putSettings`（`@/api`）。新增组件并在 `SettingsPage` 的 `<HealthCard />` 之后渲染 `<ExportDirCard />`。

```tsx
/** 导出目录卡片（spec D1/D2/D4/D5/D8）：留空 = 用应用数据目录（与改造前一致）。
 *  两种"没 Electron"的情况都禁用「浏览…」并给提示，而不是点了没反应。 */
function ExportDirCard() {
  const [value, setValue] = useState('');
  const [resolved, setResolved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bridge = hasDesktopBridge();

  const load = (): Promise<void> => {
    setLoading(true);
    return getSettings()
      .then((s) => { setValue(s.output_dir ?? ''); setResolved(s.output_dir_resolved ?? ''); setErr(null); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);

  const browse = async (): Promise<void> => {
    setPicking(true);
    try {
      const p = await pickDirectory();
      if (p !== null) setValue(p); // 只回填，落库靠「保存」——避免选一下就偷偷改
    } finally { setPicking(false); }
  };

  const save = (): void => {
    setSaving(true);
    void putSettings({ output_dir: value.trim() })
      .then(() => { message.success('已保存'); return load(); })
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <Card title="导出目录" style={{ marginBottom: 16 }} loading={loading}>
      {err !== null && <Alert type="error" showIcon message="读取设置失败" description={err} style={{ marginBottom: 12 }} />}
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={value}
          placeholder="留空 = 用应用数据目录"
          onChange={(e) => setValue(e.target.value)}
        />
        <Tooltip title={bridge ? '选择文件夹' : '仅桌面应用内可用'}>
          <span><Button loading={picking} disabled={!bridge} onClick={() => void browse()}>浏览…</Button></span>
        </Tooltip>
        <Button type="primary" loading={saving} onClick={save}>保存</Button>
      </Space.Compact>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        导出产物会直接写入这个目录（剪辑室里照样能看到、能试听）。留空时默认：{resolved || '（读取中）'}
      </Typography.Paragraph>
    </Card>
  );
}
```

顶部 import 需补 `Space`、`Tooltip`（`antd`）。

- [ ] **Step 5: 类型检查 + 构建**

Run: `pnpm --filter @sct/web typecheck`
Expected: 0 错

Run: `pnpm --filter @sct/web build`
Expected: 成功

- [ ] **Step 6: 手工冒烟**

起应用 → 设置页 → 「浏览…」能选目录并回填 → 「保存」→ 提示已保存、下方"默认"文案随之更新；填相对路径保存 → 红字报错且值不被接受；清空保存 → 恢复默认。

- [ ] **Step 7: 停在此处**（不 commit）

---

## Task 5: 前端 —— 剪辑详情页工具栏图标化 + 导出成功绿条按钮

**Files:**
- Modify: `web/src/pages/studio-detail.tsx`

**Interfaces:**
- Consumes: `openExportDir()`、`hasDesktopBridge()`（Task 4）；`getSettings()`（Task 4）
- Produces: 无（叶子任务）

- [ ] **Step 1: 工具栏 5 个按钮改图标 + 提示**

import 补：`Tooltip`（antd）、`ArrowLeftOutlined, DeleteOutlined, ExportOutlined, FolderOpenOutlined, PlusOutlined, SaveOutlined`（`@ant-design/icons`）、`openExportDir, hasDesktopBridge`（`@/export-dir` / `@/desktop`）。

把 `toolbar={(...)}` 整块换成（**保留既有 onClick/disabled/loading，只把文字换成图标 + 包 Tooltip**）：

```tsx
        toolbar={(
          <>
            <Tooltip title={saveMsg !== null && saveMsg.startsWith('保存失败') ? saveMsg : '保存剪辑点'}>
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void doSave()} />
            </Tooltip>
            <Tooltip title="导出音频（以当前界面上的段为准）">
              <Button icon={<ExportOutlined />} loading={exporting} onClick={() => void doExport()} />
            </Tooltip>
            <Tooltip title="在当前播放头打点">
              <Button icon={<PlusOutlined />} disabled={duration <= 0 || segments.length >= MAX_SEGMENTS} onClick={addSegment} />
            </Tooltip>
            <Tooltip title="打开导出目录">
              <span>
                <Button
                  icon={<FolderOpenOutlined />}
                  loading={openingDir}
                  disabled={!hasDesktopBridge()}
                  onClick={() => void onOpenExportDir()}
                />
              </span>
            </Tooltip>
            <Tooltip title="清空所有剪辑点">
              <Button danger icon={<DeleteOutlined />} disabled={segments.length === 0} onClick={clearAll} />
            </Tooltip>
            <Tooltip title="返回剪辑室">
              <Button icon={<ArrowLeftOutlined />} onClick={goBack} />
            </Tooltip>
          </>
        )}
```

> **只加图标 + Tooltip + loading，不改任何 disabled/onClick 语义**：保存与导出按钮的禁用条件维持原样（导出本来就是在 `doExport` 里早退提示"先添加至少一个剪辑段"，不要改成 disabled——那是行为变更，不在本切片范围）。

配套新增状态与动作（放在 `goBack` 附近）：

```tsx
  const [saving, setSaving] = useState(false);      // 「保存」按钮的 loading（避免连点重复 PUT）
  const [openingDir, setOpeningDir] = useState(false);
  /** 打开导出目录：工具栏与成功绿条共用同一个动作（spec D7/D8） */
  const onOpenExportDir = async (): Promise<void> => {
    setOpeningDir(true);
    try {
      const r = await openExportDir();
      if (r.ok) message.success(`已打开 ${r.dir}`);
      else message.error(r.message ?? '打开导出目录失败');
    } finally { setOpeningDir(false); }
  };
```

`doSave` 改为包住 loading（函数体与错误处理不变）：

```tsx
  const doSave = async (): Promise<void> => {
    if (saving) return;                 // 连点守卫：第二次进来直接返回
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await putProject(importId, { name: info?.title ?? null, segments });
      setSegments(r.project.segments.map((s) => ({ start_sec: s.start_sec, end_sec: s.end_sec, label: s.label ?? null })));
      setDirty(false);
      setSaveMsg('已保存');
    } catch (e) {
      setSaveMsg(`保存失败：${(e as Error).message}`);
    } finally { setSaving(false); }
  };
```

import 补 `message`（antd）。

- [ ] **Step 2: 导出成功绿条加「打开导出目录」按钮（D13）**

新增状态（与 `exportMsg` 并排）：（另：`getSettings` 要加进 `@/api` 的 import）

```tsx
  const [exportCount, setExportCount] = useState<number | null>(null); // done 事件带的段数（C-2）
  const [exportDir, setExportDir] = useState('');                      // output_dir_resolved
  // 挂载时取一次导出目录，供绿条展示"导到哪了"（用户改了设置在别处，导出完成时再刷一次）
  useEffect(() => {
    if (!validId) return;
    getSettings().then((s) => setExportDir(s.output_dir_resolved ?? ''))
      .catch((e: unknown) => logFe('error', `读取导出目录失败: ${e instanceof Error ? e.message : String(e)}`));
  }, [importId, validId]);
```

`onDone` 里记录段数并刷新目录：

```tsx
        onDone: (d) => {
          off(); setExporting(false);
          const n = d.kind === 'audio' && typeof d.count === 'number' ? d.count : null;
          setExportCount(n);
          setExportMsg(n !== null && n > 1 ? `已导出 ${n} 段` : '已导出到剪辑室');
          void getSettings().then((s) => setExportDir(s.output_dir_resolved ?? '')).catch(() => { /* 失败保留旧值，不打扰 */ });
        },
```

把 `exportMsg` 那条 `Alert` 换成带 `action` 的版本：

```tsx
          {exportMsg !== null && (
            <Alert
              type={exportMsg.startsWith('导出失败') ? 'error' : (exportMsg.startsWith('已导出') ? 'success' : 'warning')}
              showIcon
              message={(
                <span>
                  {exportMsg}
                  {exportMsg.startsWith('已导出') && exportDir !== '' && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>（{exportDir}）</Typography.Text>
                  )}
                </span>
              )}
              action={exportMsg.startsWith('已导出') ? (
                <Tooltip title={hasDesktopBridge() ? '在资源管理器中打开' : '仅桌面应用内可用'}>
                  <span>
                    <Button size="small" loading={openingDir} disabled={!hasDesktopBridge()} onClick={() => void onOpenExportDir()}>
                      打开导出目录
                    </Button>
                  </span>
                </Tooltip>
              ) : undefined}
            />
          )}
```

- [ ] **Step 3: 类型检查 + 构建**

Run: `pnpm --filter @sct/web typecheck`
Expected: 0 错

Run: `pnpm --filter @sct/web build`
Expected: 成功

- [ ] **Step 4: 手工冒烟清单**

- [ ] 5 个图标按钮**悬停都有中文提示**（保存未改动时禁用、清空无段时禁用、都仍能悬停出提示）
- [ ] 保存：改动后按钮亮起，点击有 loading；保存成功后提示"已保存"
- [ ] 导出：点击有 loading + 进度条；成功后绿条出现，文案含段数与导出目录，右侧「打开导出目录」可点、点了打开资源管理器
- [ ] 工具栏 📂 也能打开同一目录
- [ ] 把设置里的导出目录清空 → 导出 → 绿条里的目录变回默认数据目录
- [ ] 浏览器直连模式（带 `?apiPort=` 直开）→ 📂 与绿条按钮均禁用 + 提示

- [ ] **Step 5: 停在此处**（不 commit）

---

## Task 6: 收尾验证

**Files:** 无（纯验证 + 清单汇编）

- [ ] **Step 1: 全量验证**

Run: `pnpm typecheck`
Expected: 三包 0 错

Run: `pnpm --filter @sct/server test`
Expected: 全绿（基线 308 + 本切片增量 ≈ 320）

Run: `pnpm --filter @sct/web build`
Expected: 成功

Run: `git status --short`
Expected: 只含本切片涉及文件 + 前序未提交改动；**无** `.sct/` 产物、无临时探针文件进仓库

- [ ] **Step 2: 汇编手工目验清单**

按 spec §0.6「手工目验」6 条 + 本计划 Task 5 Step 4 的 6 条，汇总成一份清单写进报告。

---

## 附：任务依赖与串行约束

| 共享文件 | 涉及任务 | 约束 |
|---|---|---|
| `server/src/index.ts` | T1（唯一） | 独占 |
| `server/src/ytdlp/ytdlp-routes.test.ts` | T1（调用点） | 独占 |
| `server/src/ytdlp/ingest.ts` | T2 | 独占 |
| `server/src/media/ffmpeg-export.ts` | T2 | 独占 |
| `desktop/src/{preload,main}.ts` | T3 | 独占 |
| `web/src/pages/settings.tsx` | T4 | 独占 |
| `web/src/{desktop,export-dir}.ts`·`web/src/api.ts` | T4 | 独占 |
| `web/src/pages/studio-detail.tsx` | T5 | 独占（T6 不动代码） |

**顺序**：T1 → T2（同属服务端，串行）→ T3 → T4（依赖 T3 的桥 + T1 的接口）→ T5（依赖 T4 的 `openExportDir`）→ T6。
T3 与 T1/T2 无文件交集，但为审查清晰仍按序推进。
