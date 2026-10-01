// server/src/media/jobs-routes.ts
// GET /api/jobs?active=1（spec D9/D16，2026-09-30 download-queue-tray）——
// 抽屉与托盘都要「队列全貌」，而单任务 SSE（/api/jobs/:id/events）做不到：它只盯一个 job。
// 本接口只回**在途**（pending + running，按 id 升序 = 提交顺序 = 队列顺序）+ 下载批次分数；
// 标题由服务端补全，**不回 payload 全文**（payload 含 options/cookie 去向等内部字段，UI 不需要）。
// 走普通 fetch（能带 header）→ 由 index.ts 的 onRequest 守卫照常保护，不加豁免。
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/index.js';
import { createJobsRepo, type ActiveJobRow } from '../db/repo/jobs.js';
import { createImportsRepo } from '../db/repo/imports.js';

/**
 * 下载批次统计（spec D16）：分数「已完成/本批总数」必须有明确口径，且**只统计下载类**。
 * 批次 = 下载类在途数从 0 变正的那一刻开一批；批内新增提交累加 total；任务终结累加 done；
 * 在途归 0 后**保留快照**（否则托盘上的 3/3 会立刻消失，用户看不到「刚下完几个」）。
 *
 * 修复轮 1（审查 Critical 1/2 + Minor 5）：running/queued **不再由本对象内部计数器维护**——
 * 内部计数器一旦某条终态出口漏打点就会**永久漂移**（例如「排队中被取消」漏打点 → queued 永不回落 →
 * 旧的开新批判据 running+queued===0 永不成立 → 托盘分数永久冻结直到重启）。改为：
 * 在途数由调用方从 **DB 现数**（唯一事实源）后经 snapshot(inFlight) 传入；本对象只留 total/done。
 */
export interface JobBatch {
  /** 打点：只处理「下载类」；pending → total++；终态(done/error/cancelled) → done++；其余(running/未知/非下载类)忽略 */
  note(kind: string, status: string): void;
  /** inFlight = 当前下载类在途条数（由调用方从 DB 现数传入）；内部据此判断 0→正 是否开新批 */
  snapshot(inFlight: number): { total: number; done: number };
}

export function createJobBatch(): JobBatch {
  let total = 0;
  let done = 0;
  // 「上一轮在途数」标记：由 snapshot 从 DB 现数写入、由 note 在开批判定时读取。
  // 只有它归 0（上一批确实跑完/取消完）时，下一笔 pending 才开新批——批次边界来自 DB 事实，
  // 与内部计数器的打点完整性强弱彻底解耦（Minor 5：note('running') 不再参与开批，
  // 修掉「running 打点时 total=0 也开批 → total < done+running」）。
  let lastInFlight = 0;
  return {
    note: (kind, status) => {
      // 只统计下载类（spec D16/D1）：剪辑/导出不排队，也不该污染分数口径
      if (!kind.startsWith('ytdlp_')) return;
      if (status === 'pending') {
        // 开新批判据：上一轮在途已归 0（上一批跑完/取消完）→ total/done 归零重新计数。
        if (lastInFlight === 0) { total = 0; done = 0; }
        total += 1;
        // 这一单让在途 ≥1：抬高标记，避免「同批内连提交但 UI 尚未轮询」时被误判成新批而反复清零。
        if (lastInFlight < 1) lastInFlight = 1;
      } else if (status === 'done' || status === 'error' || status === 'cancelled') {
        // 终态（done/error/cancelled 都算完成，spec D16）→ done+1。'running' 及未知状态一律忽略。
        done += 1;
      }
    },
    snapshot: (inFlight) => {
      // 记录本轮真实在途数，供下一次 pending 判「是否开新批」；running/queued 由路由另行从 DB 现数。
      lastInFlight = inFlight > 0 ? inFlight : 0;
      return { total, done };
    },
  };
}

export interface JobsRoutesDeps {
  db: DB;
  batch: JobBatch;
}

/** payload 里本接口需要的字段（全 unknown，逐个类型守卫后再用——payload 是外部可写列） */
type JobPayloadShape = { title?: unknown; url?: unknown; importId?: unknown; entryIndex?: unknown };

function parsePayload(raw: string): JobPayloadShape {
  try { return JSON.parse(raw) as JobPayloadShape; } catch { return {}; }
}

/**
 * 标题三级回退（spec §0.3）：payload.title ?? payload.url ?? 按 payload.importId join imported_sources.title ?? #<id>。
 * 下载任务的 payload 带 title；剪辑/导出（ffmpeg_*）的 payload 只有 importId，必须回查来源表才有标题。
 */
function resolveTitle(db: DB, row: ActiveJobRow, payload: JobPayloadShape): string {
  if (typeof payload.title === 'string' && payload.title.trim() !== '') return payload.title;
  if (typeof payload.url === 'string' && payload.url.trim() !== '') return payload.url;
  if (typeof payload.importId === 'number' && Number.isInteger(payload.importId) && payload.importId > 0) {
    const src = createImportsRepo(db).get(payload.importId);
    if (src !== null) return src.title;
  }
  return `#${row.id}`;
}

/** 副标题（spec §0.3）：payload.entryIndex 有值 → 「第 N 集」；否则 null（单视频/非合集） */
function resolveSubtitle(payload: JobPayloadShape): string | null {
  if (typeof payload.entryIndex === 'number' && Number.isInteger(payload.entryIndex) && payload.entryIndex > 0) {
    return `第 ${payload.entryIndex} 集`;
  }
  return null;
}

export function registerJobsRoutes(app: FastifyInstance, deps: JobsRoutesDeps): void {
  const jobsRepo = createJobsRepo(deps.db);

  app.get('/api/jobs', async (req, reply) => {
    // 本切片只支持这一种查询（spec D9）：不做半个通用接口——active 不是 '1' 一律 400，
    // 免得日后有人 `GET /api/jobs`（不带参）时拿到一个语义不明的空列表还以为是"没有任务"。
    const active = (req.query as { active?: unknown }).active;
    if (active !== '1') {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'active 只支持 1', next: '本接口只查询在途任务' } });
    }
    const jobs = jobsRepo.listActive();
    // 下载批次分数（修复轮 1）：total/done 来自批次打点；running/queued 一律**从 DB 现数**——
    // DB 是唯一事实源，天然不会因某条终态路径（排队取消 / 队列层兜底置 error）漏打点而永久漂移。
    const dl = jobs.filter((j) => j.kind.startsWith('ytdlp_'));
    const downloads = {
      ...deps.batch.snapshot(dl.length),
      running: dl.filter((j) => j.status === 'running').length,
      queued: dl.filter((j) => j.status === 'pending').length,
    };
    return {
      ok: true,
      jobs: jobs.map((row) => {
        const payload = parsePayload(row.payload);
        return {
          id: row.id,
          kind: row.kind,
          status: row.status,
          progress: row.progress,
          title: resolveTitle(deps.db, row, payload),
          subtitle: resolveSubtitle(payload),
          message: row.message,
          createdAt: row.created_at,
        };
      }),
      downloads,
    };
  });
}
