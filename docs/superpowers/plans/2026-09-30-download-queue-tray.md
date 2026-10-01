# 下载队列 + 全局任务抽屉 + 托盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现；**禁止 commit**（见 Global Constraints）。

**Goal:** 让下载按「同时下载数」排队（默认 1），把下载进度从"页内一次性"变成**全局常驻可见**（切 tab / 最小化 / 关窗口都不丢），并让托盘显示分数进度、关窗口收托盘。

**Architecture:** 服务端引入并发受限队列（**复用 `jobs.status='pending'` 表达"排队中"，零 schema 迁移**），只调 `ytdlp_*` 两类；新增 `GET /api/jobs?active=1` 提供"队列全貌"（含只统计下载的批次分数）；前端在 layout 挂一个全局抽屉 + 导航徽标（轮询）；桌面壳加托盘（tooltip + 任务栏进度 + 菜单 + 关窗收托盘）与一条新 IPC。

**Tech Stack:** Fastify 5 + node:sqlite（server）｜UmiJS Max 4 + antd 5（web）｜Electron 44（desktop）

**Spec:** `docs/superpowers/specs/2026-09-30-download-queue-tray.md`（决定 D1–D19；本计划是它的实施论证）

## Global Constraints

- **禁止 commit**：提交授权制——子代理一律不 commit。每个任务最后一步是「停在此处」。
- **每任务第一步 Read 目标文件磁盘实况**；每次编辑后**读回核对**；同一文件**禁止并行** `SearchReplace`。
- **不引入任何新依赖**。
- `pushLog` 的 source 只能用 `server/src/logs.ts` 联合类型里的**既有值**（本计划用 `'job'` / `'server'`）。
- **零 schema 迁移**：不得改 `jobs` 表的 `CHECK` 约束、不得加列（"排队中"复用 `pending`）。
- **只在服务端排队，且只调 `ytdlp_video` / `ytdlp_download`**；`ffmpeg_clip` / `ffmpeg_export` **不排队**（D1）。
- **槽位必须释放**：任何终态（done/error/cancelled）、含 `spawn` 失败与异常路径（D6）。
- **不改变已有单任务 SSE 链路**：`subscribeJob` 与页内进度照旧，抽屉是新增（D19）。
- 验证基线：`pnpm typecheck`（三包 0 错）+ `pnpm --filter @sct/server test`（当前 **40 文件 / 348 用例**）+ `pnpm --filter @sct/web build` + `pnpm --filter @sct/desktop build`。
- 中文注释，说明「为什么」；失败路径要有日志，**不得静默 catch**。

---

## Task 1: 服务端 —— 并发受限队列（核心）

**Files:**
- Create: `server/src/ytdlp/download-queue.ts`
- Create: `server/src/ytdlp/download-queue.test.ts`
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（提交下载走队列；retry 的下载支也走队列）
- Modify: `server/src/index.ts`（装配队列，把并发上限接到设置）

**Interfaces:**
- Produces:
  ```ts
  export interface DownloadQueue {
    /** 入队并尽力启动（有空槽就立刻起） */
    enqueue(jobId: number): void;
    /** 取消"排队中"的任务：移出队列并置 cancelled（不杀进程）；返回是否命中队列 */
    cancelQueued(jobId: number): boolean;
    /** 当前运行中的 jobId（测试与 UI 都不该依赖它，仅供断言） */
    runningIds(): number[];
    /** 队列中的 jobId（按入队顺序） */
    queuedIds(): number[];
  }
  export interface QueueDeps {
    /** 每次调度都现读——这样"设置里改了上限"能立刻生效（D4） */
    limit: () => number;
    /** 真正启动一个任务；**必须在任务进入终态时 resolve**（队列据此释放槽位，D6） */
    start: (jobId: number) => Promise<void>;
    /** 终态兜底：把 job 置 cancelled（取消排队中的任务用） */
    markCancelled: (jobId: number) => void;
  }
  export function createDownloadQueue(deps: QueueDeps): DownloadQueue;
  ```

- [ ] **Step 1: 读 `startDownload` 的所有终态出口（这一步不能省）**

Read `server/src/ytdlp/ytdlp-routes.ts` 的 `startDownload`（约 `:201-265`），**逐个列出**它进入终态的分支（预期至少：① `binProvider` 拿不到 path → `fail`；② `downloadManager.start` 的 `onEvent` 收到 `done`/`error`/`cancelled`；③ 可能还有 `spawn` 失败的 error 路径）。把这串清单写进报告 —— **队列的槽位释放要挂在"start 的 Promise resolve"上，所以 `startDownload` 必须保证在所有出口都 resolve 一次**。

- [ ] **Step 2: 写失败测试（`server/src/ytdlp/download-queue.test.ts`）**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDownloadQueue } from './download-queue.js';

/** 造一个"手动终结"的 start：返回 Promise + 暴露 resolve，模拟任务跑到终态 */
function manualStarter() {
  const pending = new Map<number, () => void>();
  const started: number[] = [];
  const start = (jobId: number): Promise<void> => {
    started.push(jobId);
    return new Promise<void>((resolve) => pending.set(jobId, resolve));
  };
  const finish = (jobId: number): void => { pending.get(jobId)?.(); pending.delete(jobId); };
  return { start, finish, started };
}

const noopCancel = (): void => {};

describe('createDownloadQueue（并发受限队列）', () => {
  it('上限 1：提交 3 个只跑 1 个，其余排队', async () => {
    const s = manualStarter();
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2); q.enqueue(3);
    await Promise.resolve();
    expect(s.started).toEqual([1]);
    expect(q.runningIds()).toEqual([1]);
    expect(q.queuedIds()).toEqual([2, 3]);
  });

  it('前一个进终态 → 下一个立刻被放行（槽位释放）', async () => {
    const s = manualStarter();
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2);
    await Promise.resolve();
    s.finish(1);
    await Promise.resolve(); await Promise.resolve();
    expect(s.started).toEqual([1, 2]);
    expect(q.runningIds()).toEqual([2]);
  });

  it('start 抛错也必须释放槽位（否则一个坏任务卡死整条队，D6）', async () => {
    const started: number[] = [];
    const s = manualStarter();
    const q = createDownloadQueue({
      limit: () => 1,
      start: (jobId) => { started.push(jobId); return jobId === 1 ? Promise.reject(new Error('boom')) : s.start(jobId); },
      markCancelled: noopCancel,
    });
    q.enqueue(1); q.enqueue(2);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([1, 2]);      // 2 没被 1 的失败卡住
    expect(q.runningIds()).toEqual([2]);
  });

  it('上限变更立即放行排队中的任务（D4）', async () => {
    const s = manualStarter();
    let limit = 1;
    const q = createDownloadQueue({ limit: () => limit, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2); q.enqueue(3);
    await Promise.resolve();
    expect(s.started).toEqual([1]);
    limit = 3;
    q.pump();                              // 设置变更后由调用方显式催一次
    await Promise.resolve();
    expect(s.started).toEqual([1, 2, 3]);
  });

  it('取消排队中的任务：移出队列 + 置 cancelled，且**不**调用 start', () => {
    const s = manualStarter();
    const cancelled: number[] = [];
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled: (id) => cancelled.push(id) });
    q.enqueue(1); q.enqueue(2);
    expect(q.cancelQueued(2)).toBe(true);
    expect(cancelled).toEqual([2]);
    expect(q.queuedIds()).toEqual([]);
    expect(q.cancelQueued(2)).toBe(false); // 已经不在队列里
  });
});
```

> 注意：测试里用了 `q.pump()` —— 把它加进 `DownloadQueue` 接口（**公开**），语义 = "现在重新算一次空槽并尽量放行"。它由三个时机调用：入队时、任务终态时、**设置里并发数变更时**（D4）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @sct/server test src/ytdlp/download-queue.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 实现 `download-queue.ts`**

```ts
// 并发受限的下载队列（spec D1/D3/D4/D5/D6）。
// 只服务 ytdlp_* 两类任务（ffmpeg 任务不排队）；"排队中"复用 jobs.status='pending'，零 schema 迁移。
export interface DownloadQueue {
  enqueue(jobId: number): void;
  cancelQueued(jobId: number): boolean;
  /** 设置里并发数变了要显式催一次（D4：在跑的不动，排队的按新上限立刻放行） */
  pump(): void;
  runningIds(): number[];
  queuedIds(): number[];
}
export interface QueueDeps {
  limit: () => number;
  /** **必须在任务进入终态时 resolve**（done/error/cancelled 都要），队列据此释放槽位 */
  start: (jobId: number) => Promise<void>;
  /** 把 job 置 cancelled（取消排队中的任务用，不杀进程） */
  markCancelled: (jobId: number) => void;
}

export function createDownloadQueue(deps: QueueDeps): DownloadQueue {
  const queued: number[] = [];
  const running = new Set<number>();

  const pump = (): void => {
    // 每次现读 limit：改设置后不用重建队列就能生效（D4）
    while (running.size < Math.max(1, deps.limit()) && queued.length > 0) {
      const jobId = queued.shift()!;
      running.add(jobId);
      // 不在 pump 里 await：一个任务的耗时不能挡住同一轮里其它槽位的放行。
      // 槽位释放挂在 finally —— **这是唯一释放点**，任何终态/异常都覆盖（D6）。
      void deps.start(jobId).catch(() => { /* reject 由装配层兜底（置 error 终态 + 留日志）；这里只保证不冒泡 */ })
        .finally(() => { running.delete(jobId); pump(); });
    }
  };

  return {
    enqueue: (jobId) => { queued.push(jobId); pump(); },
    cancelQueued: (jobId) => {
      const i = queued.indexOf(jobId);
      if (i === -1) return false;          // 不在队列里（可能已在跑或已结束）→ 交给调用方走既有 cancel
      queued.splice(i, 1);
      deps.markCancelled(jobId);
      return true;
    },
    pump,
    runningIds: () => [...running],
    queuedIds: () => [...queued],
  };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @sct/server test src/ytdlp/download-queue.test.ts`
Expected: PASS（5 例）

- [ ] **Step 6: 让 `startDownload` 保证"终态必 resolve 且只 resolve 一次"**

在 `ytdlp-routes.ts` 的 `startDownload` 上**加一个可选参数** `onSettled?: () => void`，并在**它列出的每一个终态出口**调用一次（用幂等守卫，防重复）：

```ts
  async function startDownload(jobId: number, payload: DownloadJobPayload, onSettled?: () => void): Promise<void> {
    jobsRepo.update(jobId, { status: 'running' });
    // 队列靠这个回调释放槽位：**任何终态都必须恰好调一次**（done/error/cancelled/提前 fail），
    // 否则槽位泄漏 → 后面排队的任务永远起不来（D6）。
    let settled = false;
    const settle = (): void => { if (!settled) { settled = true; onSettled?.(); } };
    ...
    // ① bin 拿不到 → 现有 fail 分支末尾加 settle() 后 return
    // ② downloadManager.start 的 onEvent 里，收到 done/error/cancelled 三种终态时各 settle() 一次
    // ③ 任何 catch / 提前 return 出口同样 settle()
  }
```

> **不要**只在 `done` 上 settle —— 失败与取消同样要释放槽位。改完请在报告里逐个列出你加了 settle 的行号，便于审查者对齐 Step 1 的清单。

- [ ] **Step 7: 提交路径改走队列；并改「取消」路由先试队列（D5）**

`POST /api/ytdlp/download`（约 `:416-419`）：把 `await startDownload(jobId, payload)` 换成
```ts
    queue.enqueue(jobId);   // 进队列；有空槽就立刻起（不再直接 await startDownload）
```
`POST /api/jobs/:id/retry` 的**下载支**（约 `:735-739`）同样改成 `queue.enqueue(newId)`（**不要再手动把 status 置 running** —— 由 `startDownload` 自己置，避免"排队中却显示 running"）。

**`POST /api/jobs/:id/cancel`（约 `:667`）必须先试队列**（spec D5：排队中的还没起进程，直接移出队列即可，**不该 taskkill**）：
```ts
  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok:false, error:{ code:'NOT_FOUND', message:'任务不存在', next:'' } });
    // 排队中的任务还没起进程：从队列移除并置 cancelled 就够，**不要**走 taskkill（否则会去杀一个不存在的 pid）
    if (queue.cancelQueued(id)) return { ok: true };
    await downloadManager.cancel(id);   // 既有路径（进行中的任务，kill 树）
    jobsRepo.update(id, { status: 'cancelled' });   // ← 沿用该路由原有的收尾写法，别改语义
    return { ok: true };
  });
```
> 既有那段 cancel 实现**先读再改**，只**插入**队列分支，其余（404 兜底、update status、SSE 补发）保持原样。

另外**补一条测试固化 D8**（追加到 `ytdlp-routes.test.ts` 或 `jobs` repo 测试里）：
```ts
it('同 URL 去重把「排队中」也算在途（D8）：排队中的 URL 再提交 → 409 BUSY', async () => {
  // 让并发上限=1：先提交 1 个并让它停在 running（不 finish），再提交同 URL → 期望 409 BUSY
  // 关键点：第二个请求进来时第一个若仍是 pending（排队中），也必须被挡
});
```

`registerYtdlpRoutes` 的 deps 里新增 `queue: DownloadQueue`；`createDownloadHandlers` 也把 queue 透传进去（`startDownload` 的 onSettled 在 Step 6 已加）。

- [ ] **Step 8: `index.ts` 装配**

```ts
    const queue = createDownloadQueue({
      limit: () => {
        // D2/D4：每次现读；非法/缺失回落 1
        const n = Number(createSettingsRepo(db).get(SETTINGS_KEYS.maxConcurrentDownloads) ?? '1');
        return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
      },
      start: (jobId) => startDownloadById(jobId),   // 见下
      markCancelled: (jobId) => {
        createJobsRepo(db).update(jobId, { status: 'cancelled' });
        pushLog('info', 'job', `job ${jobId} 排队中被取消`);
      },
    });
```
> `startDownload` 现在只在 `createDownloadHandlers` 闭包里。最小改法：把 `createDownloadHandlers(deps)` 的返回值（已含 `startDownload`）在 `registerYtdlpRoutes` 里取出后**暴露给调用方**——即在 `YtdlpDeps` 增一个可选 `onDownloadHandlers?: (h: { startDownload: (jobId: number, payload: unknown, onSettled?: () => void) => Promise<void> }) => void`，由 `index.ts` 在注册时接住，再把它喂给队列的 `start`。**照这个思路实现**（不要为此大改 `registerYtdlpRoutes` 的结构）。

- [ ] **Step 9: 全量验证 + 停在此处**

Run: `pnpm --filter @sct/server test`（基线 348 + 本任务新增 ≥8）
Run: `pnpm --filter @sct/server typecheck`

---

## Task 2: 服务端 —— 三个设置键 + 校验

**Files:**
- Modify: `server/src/settings-keys.ts`
- Modify: `server/src/http/settings-routes.ts`
- Modify: `server/src/http/settings-routes.test.ts`

**Interfaces:**
- Produces: 设置键 `max_concurrent_downloads`（默认 `'1'`，1–5）、`download_sleep_seconds`（默认 `'0'`，0–10）、`download_limit_rate`（默认 `''`，空 = 不限，否则须匹配 `/^\d+(\.\d+)?[KMG]?$/i`）

- [ ] **Step 1: 写失败测试**（追加到 `settings-routes.test.ts`）

```ts
it.each([['0'], ['6'], ['abc'], ['1.5']])('并发数非法 %s → 400 且不落库', async (v) => {
  const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { max_concurrent_downloads: v } });
  expect(r.statusCode).toBe(400);
  expect(createSettingsRepo(db).get(SETTINGS_KEYS.maxConcurrentDownloads)).toBeNull();
});
it.each([['1'], ['5']])('并发数合法 %s → 200', async (v) => {
  const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { max_concurrent_downloads: v } });
  expect(r.statusCode).toBe(200);
});
it.each([['0'], ['10']])('间隔合法（闭区间端点）%s → 200', async (v) => {
  expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_sleep_seconds: v } })).statusCode).toBe(200);
});
it.each([['-1'], ['11'], ['x']])('间隔非法 %s → 400', async (v) => {
  expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_sleep_seconds: v } })).statusCode).toBe(400);
});
it.each([['500K'], ['1.5M'], ['']])('限速合法 %s → 200', async (v) => {
  expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_limit_rate: v } })).statusCode).toBe(200);
});
it.each([['500 KB'], ['abc'], ['-1']])('限速非法 %s → 400', async (v) => {
  expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_limit_rate: v } })).statusCode).toBe(400);
});
```

- [ ] **Step 2: 跑测试确认失败 → 加三个键 → 加校验 → 再跑通**

`settings-keys.ts` 追加三个键（**不改既有键**）。`settings-routes.ts` 的 PUT 里，沿用既有"先校验后写库"的顺序，为三个键各加一段校验（非法 → `400 { ok:false, error:{ code:'BAD_REQUEST', message, next } }`，`next` 写清合法范围）。

**并把「并发数变更」接给队列（D4：必须立刻生效）**——只让 `limit()` 现读是不够的：若此刻"2 个在排队 + 1 个在跑"，把上限从 1 改成 3 之后**没有任何事件会触发重新调度**，得等到那个在跑的结束才放行，那就不是"立刻"。
`registerSettingsRoutes` 加可选第三参（**不传时行为不变**，既有测试不受影响）：
```ts
export function registerSettingsRoutes(app: FastifyInstance, db: DB, defaultOutputDir: string, onDownloadsConcurrencyChanged?: () => void): void
```
PUT 成功后、且本次**确实写了 `max_concurrent_downloads`** 时调一次 `onDownloadsConcurrencyChanged?.()`。
`index.ts` 注册处传 `() => queue.pump()`。
补测试：**PUT 并发数成功后回调被调用一次；只改其它键时不调用**（给 `registerSettingsRoutes` 传一个 `vi.fn()` 断言）。

- [ ] **Step 3: 全量验证 + 停在此处**

---

## Task 3: 服务端 —— 风控节流（参数注入）

**Files:**
- Modify: `server/src/ytdlp/args.ts`
- Modify: `server/src/ytdlp/args.test.ts`
- Modify: `server/src/ytdlp/ytdlp-routes.ts`（把设置读出来传进 args）

**Interfaces:**
- Consumes: `buildDownloadArgs` / `buildVideoDownloadArgs`（既有）
- Produces: 两个 build 函数各加**可选**参数 `throttle?: { sleepSeconds?: number; limitRate?: string }`

- [ ] **Step 1: 写失败测试**（`args.test.ts`）

```ts
describe('风控节流参数（spec D15/D18）', () => {
  it('sleepSeconds>0 → 下载参数含 --sleep-requests <n>', () => {
    const a = buildVideoDownloadArgs({ ...base, throttle: { sleepSeconds: 2 } });
    expect(a[a.indexOf('--sleep-requests') + 1]).toBe('2');
  });
  it('sleepSeconds=0/缺省 → 不含 --sleep-requests', () => {
    expect(buildVideoDownloadArgs({ ...base, throttle: { sleepSeconds: 0 } })).not.toContain('--sleep-requests');
    expect(buildVideoDownloadArgs(base)).not.toContain('--sleep-requests');
  });
  it('limitRate 非空 → 含 --limit-rate；空串 → 不含', () => {
    expect(buildDownloadArgs({ ...baseAudio, throttle: { limitRate: '500K' } })).toContain('--limit-rate');
    expect(buildDownloadArgs({ ...baseAudio, throttle: { limitRate: '' } })).not.toContain('--limit-rate');
  });
  it('节流只进下载参数——探测/解析参数不含（拿 buildProbeFormatsArgs / buildParseArgs 断言）', () => {
    expect(buildProbeFormatsArgs('https://a/v')).not.toContain('--sleep-requests');
    expect(buildParseArgs('https://a/v')).not.toContain('--limit-rate');
  });
});
```

- [ ] **Step 2: 跑测试确认失败 → 实现 → 再跑通**

在 `args.ts` 里加一个**私有小工具**（两个 build 函数共用，避免两处各写一遍）：
```ts
/** 风控节流（spec D15/D18）：只作用于下载；0/空 一律不拼参数（默认即"不限"，保持既有行为） */
function pushThrottle(args: string[], t?: { sleepSeconds?: number; limitRate?: string }): void {
  if (t?.sleepSeconds !== undefined && t.sleepSeconds > 0) args.push('--sleep-requests', String(t.sleepSeconds));
  if (t?.limitRate !== undefined && t.limitRate.trim() !== '') args.push('--limit-rate', t.limitRate.trim());
}
```
在两个 build 函数的 `args.push('-o', ...)` **之前**调用它。

`ytdlp-routes.ts` 的 `startDownload` 里，读设置并传进去：
```ts
    const settings = createSettingsRepo(db);
    const throttle = {
      sleepSeconds: Number(settings.get(SETTINGS_KEYS.downloadSleepSeconds) ?? '0'),
      limitRate: settings.get(SETTINGS_KEYS.downloadLimitRate) ?? '',
    };
    ... buildVideoDownloadArgs({ ..., throttle }) / buildDownloadArgs({ ..., throttle })
```

- [ ] **Step 3: 全量验证 + 停在此处**

---

## Task 4: 服务端 —— `GET /api/jobs?active=1` + 下载批次分数

**Files:**
- Modify: `server/src/db/repo/jobs.ts`（加 `listActive()`）
- Modify: `server/src/db/repo/jobs.test.ts`（若无则建）
- Create: `server/src/media/jobs-routes.ts`
- Create: `server/src/media/jobs-routes.test.ts`
- Modify: `server/src/index.ts`（注册 + 批次状态装配）

**Interfaces:**
- Produces:
  ```ts
  // jobsRepo
  listActive(): Array<{ id: number; kind: string; payload: string; status: string; progress: number; message: string | null; created_at: string }>
  // 新路由
  export function createJobBatch(): JobBatch            // 批次统计器
  export function registerJobsRoutes(app, { db, batch }): void   // GET /api/jobs
  ```

- [ ] **Step 1: 写失败测试（`jobs-routes.test.ts`）**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createJobBatch, registerJobsRoutes } from './jobs-routes.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;
let batch: ReturnType<typeof createJobBatch>;

const addJob = (kind: string, status: string, payload: unknown): number =>
  Number(db.prepare('INSERT INTO jobs (kind, payload, status) VALUES (?,?,?)').run(kind, JSON.stringify(payload), status).lastInsertRowid);

beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  batch = createJobBatch();
  app = Fastify(); registerJobsRoutes(app, { db, batch }); await app.ready();
});

describe('GET /api/jobs（spec D9/D16）', () => {
  it('active 不是 1 → 400（本切片只支持这一种查询）', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/jobs?active=0' })).statusCode).toBe(400);
  });
  it('只回在途（pending/running），按 id 升序；done/error 不出现', async () => {
    addJob('ytdlp_video', 'done', { url: 'https://a/1' });
    const p = addJob('ytdlp_video', 'pending', { url: 'https://a/2' });
    const r = addJob('ffmpeg_export', 'running', { importId: 1 });
    addJob('ytdlp_download', 'error', { url: 'https://a/3' });
    const body = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json();
    expect(body.jobs.map((j: { id: number }) => j.id)).toEqual([p, r]); // 升序
  });
  it('title 三种来源：payload.title / payload.url / 按 importId join imported_sources', async () => {
    db.prepare('INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)').run('https://a/s', '来源标题', 'bilibili', 'single');
    addJob('ytdlp_video', 'running', { url: 'https://a/u', title: '有标题' });
    addJob('ytdlp_video', 'running', { url: 'https://a/only-url' });
    addJob('ffmpeg_export', 'running', { importId: 1 });
    const titles = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().jobs.map((j: { title: string }) => j.title);
    expect(titles).toEqual(['有标题', 'https://a/only-url', '来源标题']);
  });
  it('subtitle：payload.entryIndex 有值 → 「第 N 集」，否则 null', async () => {
    addJob('ytdlp_video', 'running', { url: 'https://a/e', entryIndex: 3 });
    addJob('ytdlp_video', 'running', { url: 'https://a/n' });
    const subs = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().jobs.map((j: { subtitle: string | null }) => j.subtitle);
    expect(subs).toEqual(['第 3 集', null]);
  });
  it('downloads 只统计下载类：ffmpeg_export 不计入 total', async () => {
    batch.note('ytdlp_video', 'pending');
    batch.note('ffmpeg_export', 'pending');   // 非下载类，不该进批次
    const d = (await app.inject({ method: 'GET', url: '/api/jobs?active=1' })).json().downloads;
    expect(d.total).toBe(1);
  });
});

describe('createJobBatch（D16 批次语义）', () => {
  it('在途 0→1 开新批，total 从 0 起；同批内再次提交累加 total', () => {
    batch.note('ytdlp_video', 'pending');           // 0→1：开批，total=1
    batch.note('ytdlp_video', 'pending');           // 同批：total=2
    expect(batch.snapshot().total).toBe(2);
    expect(batch.snapshot().done).toBe(0);
  });
  it('任务终结 → done+1；在途归 0 后再提交 → 开新批（total/done 归零）', () => {
    batch.note('ytdlp_video', 'pending');
    batch.note('ytdlp_video', 'done');               // 终态：done=1，在途归 0
    expect(batch.snapshot()).toMatchObject({ total: 1, done: 1 });
    batch.note('ytdlp_video', 'pending');            // 在途 0→1：新批
    expect(batch.snapshot()).toMatchObject({ total: 1, done: 0 });
  });
  it('在途归 0 后快照保留（托盘还能显示 3/3 一会儿）', () => {
    batch.note('ytdlp_video', 'pending');
    batch.note('ytdlp_video', 'done');
    expect(batch.snapshot()).toMatchObject({ total: 1, done: 1, running: 0, queued: 0 });
  });
  it('running/queued 分别按 status 计数', () => {
    batch.note('ytdlp_video', 'running');
    batch.note('ytdlp_video', 'pending');
    expect(batch.snapshot()).toMatchObject({ running: 1, queued: 1 });
  });
});
```

- [ ] **Step 2: 实现 `createJobBatch()`**（纯逻辑，放 `jobs-routes.ts` 里导出，便于单测）

```ts
/** 下载批次统计（spec D16）：分数「已完成/本批总数」必须有明确口径，且**只统计下载类**。
 *  批次 = 在途下载数从 0 变正的那一刻开一批；批内新增提交累加 total，任务终结累加 done；
 *  在途归 0 后**保留快照**（否则托盘上的 3/3 会立刻消失，用户看不到"刚下完几个"）。 */
export interface JobBatch { note(kind: string, status: string): void; snapshot(): { total: number; done: number; running: number; queued: number } }
export function createJobBatch(): JobBatch { /* 按上面语义实现；只认 kind.startsWith('ytdlp_') */ }
```

- [ ] **Step 3: `jobsRepo.listActive()` + 路由**

`listActive()`：`SELECT id, kind, payload, status, progress, message, created_at FROM jobs WHERE status IN ('pending','running') ORDER BY id ASC`。

路由 `GET /api/jobs?active=1`：`active` 不是 `'1'` → 400（本切片只支持这一种查询，避免做成半个通用接口）；否则组响应：`jobs`（title/subtitle 由服务端补，**不回 payload 全文**）+ `downloads: batch.snapshot()`。**无守卫豁免**（走 fetch 带 header）。

- [ ] **Step 4: 装配 + 全量验证 + 停在此处**

`index.ts`：`const batch = createJobBatch()`；在**任务创建处与终态处**调 `batch.note(kind, status)`（下载提交/重试、以及 `startDownload` 的终态出口——与 Task 1 的 `settle()` 同处，正好一处打点覆盖两个用途）。

---

## Task 5: 前端 —— 设置页「下载」卡片 + 全局任务抽屉 + 导航徽标

**Files:**
- Modify: `web/src/pages/settings.tsx`（新增「下载」卡片：并发数 / 间隔 / 限速 —— spec D17）
- Create: `web/src/components/TaskDrawer.tsx`
- Modify: `web/src/layouts/index.tsx`（挂抽屉 + 导航右侧入口 + 徽标）
- Modify: `web/src/api.ts`（`listActiveJobs()`）

**Interfaces:**
- Consumes: `GET /api/jobs?active=1`（Task 4）
- Produces: `listActiveJobs(): Promise<{ ok: boolean; jobs: ActiveJob[]; downloads: Batch }>`

- [ ] **Step 1: `api.ts` 封装 + 类型**

```ts
export interface ActiveJob { id: number; kind: string; status: 'pending' | 'running'; progress: number; title: string; subtitle: string | null; message: string | null; createdAt: string }
export interface DownloadBatch { total: number; done: number; running: number; queued: number }
/** 在途任务（下载/剪辑/导出）+ 下载批次分数（spec D9/D16） */
export function listActiveJobs(): Promise<{ ok: boolean; jobs: ActiveJob[]; downloads: DownloadBatch }> {
  return apiGet('/api/jobs?active=1');
}
```

- [ ] **Step 2: `TaskDrawer.tsx`**

要求（spec D11/D12）：
- props：`open: boolean; onClose: () => void; onCountChange: (n: number) => void`
- **轮询**：在途非空 → `1s`；空闲 → `5s`（用 `setTimeout` 自调度，**不要** `setInterval` 以免重入）；组件卸载清定时器
- 失败 → `logFe('error')` + 抽屉内一条 `Alert`；**不弹全局错误**；徽标保持上一次值
- 列表分两组：**进行中**（`status==='running'`）/ **排队中**（`status==='pending'`）；每条 = 类型标签（下载/剪辑/导出，按 `kind` 映射）+ `title`（有 `subtitle` 就附上）+ `Progress` + 百分比 + **取消按钮**
- 取消：下载 → `cancelJob(id)`（既有）；排队中的下载 → 也走 `cancelJob`（服务端 Task 1 的 cancel 分支会先尝试移出队列）
- 空态：antd `Empty`，文案「没有正在进行的任务」
- 顶部一行小字：`下载中 <done>/<total>`（用 `downloads`），让用户与托盘看到同一口径

- [ ] **Step 3: 挂进 layout**

`layouts/index.tsx`：加状态 `drawerOpen`/`activeCount`；把 `<TaskDrawer …/>` 放在 `<div style={{ flex: 1, … }}>` **之后**（overlay，不参与 flex）；顶栏 `<LogsButton />` **左侧**加一个 `<Badge count={activeCount} size="small"><Button type="text" icon={<DownloadOutlined />} onClick={() => setDrawerOpen(true)} /></Badge>`。
**抽屉的开合状态不随路由变化**（它挂在 layout，天然满足 D11）。

- [ ] **Step 4: 设置页新增「下载」卡片（spec D17）**

在 `settings.tsx` 的 `<HealthCard />` 之后插一张卡片，与既有的「导出目录」卡片同款结构（输入 + 保存 + loading + 失败提示）：

```tsx
/** 下载保护设置（spec D17）：并发数 / 请求间隔 / 限速。
 *  三项都是"保护类"，放同一张卡；只影响**下载**任务（剪辑/导出不受影响，spec D18）。 */
function DownloadCard() {
  const [limit, setLimit] = useState('1');
  const [sleep, setSleep] = useState('0');
  const [rate, setRate] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = (): Promise<void> => {
    setLoading(true);
    return getSettings()
      .then((s) => {
        setLimit(s.max_concurrent_downloads ?? '1');
        setSleep(s.download_sleep_seconds ?? '0');
        setRate(s.download_limit_rate ?? '');
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);
  const save = (): void => {
    setSaving(true);
    void putSettings({ max_concurrent_downloads: limit, download_sleep_seconds: sleep, download_limit_rate: rate })
      .then(() => { message.success('已保存'); return load(); })
      .catch((e: unknown) => message.error(e instanceof Error ? e.message : String(e)))  // 后端 400 的 next 由 apiPut 拼进来
      .finally(() => setSaving(false));
  };
  return (
    <Card title="下载" style={{ marginBottom: 16 }} loading={loading}>
      {err !== null && <Alert type="error" showIcon message="读取设置失败" description={err} style={{ marginBottom: 12 }} />}
      <Space direction="vertical" style={{ width: '100%' }}>
        <div>
          <Typography.Text>同时下载数（1–5）</Typography.Text>
          <Input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 120 }} />
        </div>
        <div>
          <Typography.Text>请求间隔秒数（0–10，0 = 不间隔；对合集批量最有效）</Typography.Text>
          <Input value={sleep} onChange={(e) => setSleep(e.target.value)} style={{ width: 120 }} />
        </div>
        <div>
          <Typography.Text>限速（留空 = 不限；如 500K / 1.5M）</Typography.Text>
          <Input value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 160 }} placeholder="留空 = 不限" />
        </div>
        <Button type="primary" loading={saving} onClick={save}>保存</Button>
      </Space>
    </Card>
  );
}
```
（`Space` / 其它 antd 组件按该文件既有 import 情况补齐；把 `<DownloadCard />` 渲染进 `SettingsPage`。**不改**既有卡片。）

> 为什么三项都在同一张卡：它们同属"下载保护"，且一起改完一次 PUT 更省事；拆分会让用户改一个跑一次。

- [ ] **Step 5: 验证 + 停在此处**

Run: `pnpm --filter @sct/web typecheck` / `pnpm --filter @sct/web build`
手工：设置页「下载」卡片能读写三项、非法值有后端提示；起应用 → 连续提交 2 个下载 → 顶栏徽标出现数字 → 切 tab 徽标仍在、抽屉内容持续更新 → 「同时下载数」改成 1 时能看到「排队中」分组。

---

## Task 6: 桌面壳 —— 托盘 + 关窗收托盘 + 打开抽屉的 IPC

**Files:**
- Modify: `desktop/src/preload.ts`（新增 `onOpenDownloader`）
- Modify: `desktop/src/main.ts`（Tray + tooltip + `setProgressBar` + 菜单 + 关窗收托盘 + 轮询 + 首次气泡）
- Modify: `web/src/desktop.ts`（桥接 `onOpenDownloader`）
- Modify: `web/src/layouts/index.tsx`（订阅该事件 → 打开抽屉）

**Interfaces:**
- Produces: `window.sct.onOpenDownloader(cb: () => void): () => void`（通道 `sct:open-downloader`）

- [ ] **Step 1: `preload.ts` 增一条**

```ts
  onOpenDownloader: (cb: () => void): (() => void) => {
    const h = (): void => cb();
    ipcRenderer.on('sct:open-downloader', h);
    return () => ipcRenderer.removeListener('sct:open-downloader', h);
  },
```

- [ ] **Step 2: `main.ts` 托盘**

要求（spec D13/D14）：
- **模块级**保存 `apiPort` / `apiToken`（`openWindow` 已拿到，存下来给轮询用）；**没有端口就完全不建托盘**（不能拿空 token 去轮询）
- `new Tray(icon)`：图标**不在 `main.ts` 里就地解析**，统一走 `desktop/src/tray-icon.ts` 的 `loadTrayIcon()`。解析链：① `__dirname/assets/tray.png`（`build` 会把 `assets/` 拷进 `dist/`，这是「打包只带 dist/」时的命中点）→ ② `__dirname/../assets/tray.png`（dev 形态）→ ③ **源码内嵌的 base64 副本**（与文件逐字节同源）→ ④ `createEmpty()` + 留痕（理论到不了）。
  为什么要有 ③：原方案"只读 `__dirname/../assets`"**在打包形态下不可靠**——electron-builder 推迟到 M3 后（M0 spec / PRD R5），打包器的文件包含规则无从验证，而**空白托盘图标在真机上极难排查**（用户只看到"托盘点不到"）。内嵌副本让图标**不依赖任何运行时路径**。图标本体仍由 `desktop/scripts/make-tray-icon.mjs` 用 `node:zlib` 生成（脚本会打印可直接粘回 `tray-icon.ts` 的 base64，可追溯、非二进制黑盒）
- 轮询 `GET /api/jobs?active=1`（1s/5s 自适应，同 Task 5 的自调度写法），据此更新：
  - `tray.setToolTip(...)`：有下载在途 → `下载中 <done>/<total> · 当前 <p>%`（`p` = **运行中的下载任务**（`kind.startsWith('ytdlp_')`）的平均进度，四舍五入；无运行中则 0；剪辑/导出不计入——托盘是下载器，分数与 `downloads` 批次同口径）；否则 `就绪`
  - `mainWindow.setProgressBar(p / 100)`；无在途 → `setProgressBar(-1)`（清除）
  - 连续 3 次拉取失败 → tooltip 改为 `本地服务未连接`（不要闪断就改，避免抖动）
- 右键菜单：`打开主窗口`（`show()+focus()`）/ `显示下载器`（先 `show()+focus()`，再 `webContents.send('sct:open-downloader')`）/ `退出`（`app.quit()`）
- 左键单击 → `show()+focus()`
- **关窗收托盘**：`mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } })`；`app.on('before-quit', () => { isQuitting = true; })`（**必须**与既有的 `before-quit`（`FILE_LOAD` 分支里那个 await close）共存——先读现状再改，别把既有退出流程打断）
- **首次收托盘**气泡提示一次：用 settings 或 `app.getPath('userData')` 下的小标记文件；**读不到标记时也给提示**（宁多一次）

- [ ] **Step 3: `web/src/desktop.ts` + layout 订阅**

`desktop.ts` 增 `onOpenDownloader(cb): () => void`（无桥 → 返回空函数，**不抛**；仍保持"`window.sct` 只在这里出现"）。
`layouts/index.tsx`：`useEffect(() => onOpenDownloader(() => setDrawerOpen(true)), [])`（返回的取消订阅函数直接作为 cleanup）。

- [ ] **Step 4: 验证 + 停在此处**

Run: `pnpm --filter @sct/desktop typecheck` / `pnpm --filter @sct/desktop build` / `pnpm --filter @sct/web typecheck` / `pnpm --filter @sct/web build`
手工（**必须真机**，子代理做不了就写"未执行，交用户目验"）：关窗口不退出、托盘 tooltip 显示分数、任务栏有进度条、点「显示下载器」能叫出抽屉、托盘「退出」才真退出。

---

## 附：任务依赖与串行约束

| 共享文件 | 涉及任务 | 约束 |
|---|---|---|
| `server/src/ytdlp/ytdlp-routes.ts` | T1、T3 | **串行** T1 → T3 |
| `server/src/ytdlp/args.ts` | T1（不改）、T3 | T3 独占 args 改动 |
| `server/src/settings-keys.ts` / `settings-routes.ts` | T2 | 独占 |
| `server/src/index.ts` | T1、T4 | **串行** T1 → T4 |
| `web/src/layouts/index.tsx` | T5、T6 | **串行** T5 → T6 |
| `web/src/api.ts` | T5 | 独占 |
| `web/src/desktop.ts` | T6 | 独占 |
| `server/src/db/repo/jobs.ts` | T4 | 独占 |

**顺序**：T1 → T2 → T3 → T4 → T5 → T6（T2 与 T1/T3 无文件交集，但 T3 要读 T2 的键，故串行）。

## 附：交付切片（与 spec §0.11 对齐）

- **切片一（服务端）= T1–T4**：队列 + 设置 + 节流 + 任务列表接口。验收：vitest 全绿 + curl 改设置/看列表；**改完下载立刻受控**。
- **切片二（前端）= T5**：全局抽屉 + 徽标。验收：切 tab / 最小化都能看进度。
- **切片三（桌面壳）= T6**：托盘 + 关窗收托盘 + IPC。验收：真机目验（关窗不退出、托盘分数、任务栏进度、叫出抽屉）。
