import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from './db/index.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { initSchema } from './db/schema.js';
import { isAllowedLocalOrigin, registerCors } from './http/cors.js';
import { registerSettingsRoutes } from './http/settings-routes.js';
import { initFileLogging, pushLog, registerRequestLogging } from './logs.js';
import { findFreePort } from './net/find-free-port.js';
import { probeBin } from './bins.js';
import { SETTINGS_KEYS } from './settings-keys.js';
import { createDownloadManager } from './ytdlp/download.js';
import { createDownloadQueue } from './ytdlp/download-queue.js';
import { registerYtdlpRoutes, resolveCookiePath, type DownloadJobPayload } from './ytdlp/ytdlp-routes.js';
import { createJobsRepo } from './db/repo/jobs.js';
import { startClipJob, type ClipJobPayload } from './media/clip-job.js';
import { registerMediaRoutes } from './media/media-routes.js';
import { registerFormatsRoutes } from './media/formats-routes.js';
import { derivedDirFor } from './media/derived-images.js';
import { registerProjectRoutes } from './media/project-routes.js';
import { registerHomeRoutes } from './media/home-routes.js';
import { createJobBatch, registerJobsRoutes } from './media/jobs-routes.js';
import { startExportJob, type ExportJobPayload } from './media/ffmpeg-export.js';

export { bootstrap } from './bootstrap.js';

export interface CreateServerOpts {
  port: number;      // 必传,约定 dev 7310;占用自动递增(findFreePort)
  dbPath: string;    // 必传:electron→userData/sct.db;dev→.sct/dev-data/sct.db;测试→:memory:
  tempDir: string;   // 必传,分运行时同 dbPath
  portFile?: string; // 仅 dev:写入 {port, pid, token}(JSON),供 electron 握手
}

export async function createServer(opts: CreateServerOpts): Promise<{
  port: number;
  token: string; // D12:随机 API token;受保护路由要求请求头 x-sct-token 匹配
  close: () => Promise<void>;
}> {
  mkdirSync(opts.tempDir, { recursive: true });
  const db = openDatabase(opts.dbPath);
  let app: FastifyInstance | null = null;
  let listening = false;
  let closed = false;
  try {
    // 传 dbPath:迁移要在"真要重建"时先备份(备份的是同一文件);:memory: 会自行跳过
    initSchema(db, { dbPath: opts.dbPath });

    // health 写副作用收口:启动时一次性写入内部键 health_stamp(不进 SETTINGS_KEYS 白名单,不暴露给 PUT /api/settings),
    // 请求时只读——避免每请求建表/写入(产生第六张表、无界增长)与存活判定耦合 DB 写(SQLITE_BUSY 会误判 server 未启动)
    const settingsRepo = createSettingsRepo(db);
    const healthStamp = String(Date.now());
    settingsRepo.set('health_stamp', healthStamp);

    app = Fastify({ logger: false });
    registerCors(app);
    registerRequestLogging(app); // 诊断日志:/api/* 每请求一行(2026-09-29 用户反馈)

    // D4:audioDir 与 db 同目录（registerSettingsRoutes / mediaDir 等都拿它当基准路径）
    const audioDir = path.join(path.dirname(opts.dbPath), 'audio');
    mkdirSync(audioDir, { recursive: true });

    let port = opts.port;

    app.get('/api/health', async () => {
      const row = settingsRepo.get('health_stamp');
      return { ok: true, sqlite: row, port };
    });

    // D12:随机 API token
    const token = randomBytes(16).toString('hex');

    // 视频素材目录(2026-09-29 spec m1c-video-clip):与 db 同级 media/,produce=video 下载落这里
    const mediaDir = path.join(path.dirname(opts.dbPath), 'media');
    mkdirSync(mediaDir, { recursive: true });
    // 派生图目录（spec §0.10）：与 media/、covers/ 同数据目录；启动时确保存在
    mkdirSync(derivedDirFor(mediaDir), { recursive: true });
    // 日志文件落盘根目录(2026-09-29 用户拍板:日志按 天/小时 落文件,与 db 同级 logs/)。
    // :memory: 是测试库 → 不落盘,避免测试运行往仓库 cwd 写 logs/
    if (!opts.dbPath.includes(':memory:')) initFileLogging(path.join(path.dirname(opts.dbPath), 'logs'));

    const downloadManager = createDownloadManager();
    // 取 yt-dlp 路径的**唯一**来源(原本内联在 registerYtdlpRoutes 的 deps 里;探测路由也要用 → 提出来共用)
    const ytdlpBinProvider = async (): Promise<{ path: string | null }> => {
      const explicit = settingsRepo.get(SETTINGS_KEYS.binYtdlp);
      const p = await probeBin('yt-dlp', explicit ?? undefined);
      return { path: p.path };
    };
    // 并发受限下载队列(spec D1/D3/D4/D5/D6):只在服务端排队,只调 ytdlp_* 两类(ffmpeg 不排队)。
    // 队列的 start 需要「按 jobId 起任务、并在任务进终态时 resolve」——真正的启动器 startDownload 在
    // registerYtdlpRoutes 的闭包里,这里先用变量占位,注册时由 onDownloadHandlers 把引用接上。
    let downloadHandlers: {
      startDownload: (jobId: number, payload: DownloadJobPayload, onSettled?: () => void) => Promise<void>;
    } | null = null;
    const jobsRepoForQueue = createJobsRepo(db);
    // 下载批次统计(Task 4,spec D16):GET /api/jobs 出「已完成/本批总数」的单一事实源。
    // 必须与 ytdlp-routes 里打点用的是**同一个实例**——故从这里建好,一头喂给路由打点,一头喂给 GET /api/jobs 出快照。
    // 修复轮 1（审查 Critical 1/2）：声明必须**先于** createDownloadQueue——其 start/markCancelled 回调要在兜底终态处
    // 补打点(batch.note)，否则 TDZ（常量在初始化前被访问）。
    const batch = createJobBatch();
    const downloadQueue = createDownloadQueue({
      // 并发上限:每次调度**现读**设置键 max_concurrent_downloads(spec D2/D4);
      // 非法/缺失一律回落 1——与 PUT 校验范围(1..5)保持一致,坏值绝不进队列。
      limit: () => {
        const n = Number(settingsRepo.get(SETTINGS_KEYS.maxConcurrentDownloads) ?? '1');
        return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
      },
      start: (jobId) =>
        new Promise<void>((resolve) => {
          const job = jobsRepoForQueue.get(jobId);
          if (job === null || downloadHandlers === null) {
            // 兜底:job 已不存在 / 启动器未接线 → 立即放行槽位,避免整条队被一个坏 job 卡死(D6)
            pushLog('error', 'job', `queue 无法启动 job ${jobId}（任务不存在或下载处理器未接线）`);
            resolve();
            return;
          }
          // 队列要求「任务进终态才 resolve」:把 resolve 当 onSettled 交给 startDownload。
          // 若 startDownload 在进终态前就 reject(binProvider 抛错 / mkdirSync·buildArgs 抛错 / spawn 同步抛错),
          // onSettled 不会触发 → 必须在这里兜底:置 error 终态 + 留日志。否则 job 会永久停在 running,
          // 前端 subscribeJob 等不到终态、进度条永久转圈,且事后无从排障(撞仓库「失败路径必须留痕」铁律)。
          void downloadHandlers
            .startDownload(jobId, JSON.parse(job.payload) as DownloadJobPayload, resolve)
            .catch((e: unknown) => {
              const msg = e instanceof Error ? e.message : String(e);
              pushLog('error', 'job', `job ${jobId} 启动失败(队列层兜底): ${msg}`);
              jobsRepoForQueue.fail(jobId, msg);
              // 修复轮 1（审查 Critical 2）：该 job 创建时已 note('pending')（total+1），此处兜底置 error 是它的终态——
              // 必须补终态打点，否则 done 不涨、批次分数与现实对不上（旧写法漏这一步）。
              batch.note(job.kind, 'error');
              resolve(); // 无论如何都要放行槽位,绝不泄漏(D6)
            });
        }),
      markCancelled: (jobId) => {
        // 取消排队中的任务:置 cancelled 即可(它没起进程,无需清产物);message 与运行中取消同款——
        // 补发分支和历史列表里的取消原因保持一致,不该是空(H1,2026-10-01)
        jobsRepoForQueue.update(jobId, { status: 'cancelled', message: '用户取消' });
        // 修复轮 1（审查 Critical 1）：该 job 创建时已 note('pending')（total+1），取消是它的终态——
        // 必须补终态打点，否则 done 永不 +1；旧内部计数器还会让 queued 永不回落 → 后续再也不开新批、托盘分数永久冻结。
        const job = jobsRepoForQueue.get(jobId);
        if (job) batch.note(job.kind, 'cancelled');
        pushLog('info', 'job', `job ${jobId} 排队中被取消`);
      },
    });
    // 设置路由放在队列建好之后注册,好把第四参回调接成 queue.pump():
    // PUT /api/settings 改「同时下载数」成功后立刻催一次——否则「N 个排队 + 1 个在跑」时改大上限,
    // 没有任何事件触发重新放行,得等那个在跑的结束才算数,那就不是 D4 要求的“立刻”。
    registerSettingsRoutes(app, db, audioDir, () => downloadQueue.pump());
    registerYtdlpRoutes(app, {
      db,
      binProvider: ytdlpBinProvider,
      downloadManager, audioDir, mediaDir, tempDir: opts.tempDir, token,
      queue: downloadQueue,
      batch, // Task 4:下载批次打点(创建/转运行/终态)——与 GET /api/jobs 出的是同一实例
      onDownloadHandlers: (h) => { downloadHandlers = h; },
      // 剪辑启动器注入(批4 Task 10):ytdlp-routes 的 retry 分支遇到 ffmpeg_clip 任务时把新任务交给它 ——
      // 两条触发路径(POST /api/media/:id/clip 与重试)共用同一个 startClipJob,不会各写一份
      clipStarter: async (jobId, payload) => {
        await startClipJob(jobId, payload as ClipJobPayload, { db, audioDir, tempDir: opts.tempDir });
      },
      // 导出启动器注入(P4 T4):retry 遇到 ffmpeg_export 任务时交给它 —— 与 POST /api/projects/:id/export 共用同一个 startExportJob
      exportStarter: async (jobId, payload) => {
        await startExportJob(jobId, payload as ExportJobPayload, { db, audioDir, tempDir: opts.tempDir });
      },
    });
    // 媒体素材路由(批4 Task 10):列表 / 视频流(Range) / 删素材 / 剪音频(放在 ytdlp 之后)
    registerMediaRoutes(app, { db, audioDir, tempDir: opts.tempDir, mediaDir, token });
    // 可用清晰度探测(spec D6):只读、失败降级;走 fetch(带 header)→ 无守卫豁免(token 由 onRequest 钩子保护)
    registerFormatsRoutes(app, {
      db, audioDir, binProvider: ytdlpBinProvider,
      cookiePath: () => resolveCookiePath(db, audioDir),
    });
    // 剪辑作品 CRUD（P4，spec §0.3；旧称"剪辑工程"，2026-10-01 spec clip-works D3 统一叫作品）：放在媒体路由之后，onRequest 守卫统一保护（无豁免——它只被 fetch 调用，能带 header）
    registerProjectRoutes(app, { db, audioDir, tempDir: opts.tempDir, token });
    // 首页仪表盘(P5-T1,spec §0.3「其它」):GET /api/home 两块 Top3(正在编辑 / 最近下载)。
    // 放 project 路由之后;走普通 fetch(带 header)→ 无守卫豁免。HTTP 摘要由 onResponse 钩子自动落。
    registerHomeRoutes(app, { db });
    // 任务列表(Task 4,spec D9):GET /api/jobs?active=1 = 在途任务 + 下载批次分数。
    // 放 home 之后;走普通 fetch(带 header)→ 无守卫豁免。HTTP 摘要由 onResponse 钩子自动落。
    registerJobsRoutes(app, { db, batch });

    // onRequest 守卫(路由注册之后、listen 之前);OPTIONS 必须跳过——预检交 cors 通配路由,否则被 401
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return;
      if (!req.url.startsWith('/api/')) return;
      // 精确匹配 pathname(去 query),避免顺带豁免 /api/health-check 之类的未来路由
      const pathname = req.url.split('?')[0] ?? '';
      if (pathname === '/api/health') return; // 只读 + 回退链需要
      // D3:SSE 与音频文件端点无法设 header(EventSource/<audio>),token 走 query——豁免 header 校验,由路由内 query 校验接管
      if (/^\/api\/jobs\/\d+\/events$/.test(pathname)) return;
      if (/^\/api\/audio\/\d+\/file$/.test(pathname)) return;
      // 视频素材文件(批4 Task 10):<video> 与 <audio> 同款——带不了 header,守卫豁免后由路由内 query token / Referer 判定接管
      if (/^\/api\/media\/\d+\/file$/.test(pathname)) return;
      // 作品封面同属这一类(<img> 也加不了 header):2026-09-29 浏览器实测漏网——守卫没豁免它,
      // 于是封面一律 401、卡片全退成纯色(路由内的 query token / Referer 判定根本没机会跑)
      if (/^\/api\/imports\/\d+\/cover$/.test(pathname)) return;
      // 派生图同属这一类(<img> 加不了 header)：与 /cover 同款豁免，由路由内 query token/Referer 判定接管（spec D14）
      // ⚠️ 新增派生图地址时**必须同步加进这条正则**（2026-10-03 用户实测「切中景/近景时胶片带生成失败」）：
      //   Spec B 的 filmseg / wavepeak 漏加 → 守卫在路由之前就把 <img> 请求 401 掉，路由内那套
      //   query token / Origin / Referer 三件套判定**根本没机会跑**，症状是「一直失败 + 磁盘零产物」。
      //   判据：凡是用 <img>/<video> 直接取 URL 的地址，都要在这名单里；走 fetch 的（能带 header）不受此限。
      if (/^\/api\/media\/\d+\/(waveform|filmstrip|filmseg|wavepeak)$/.test(pathname)) return;
      const origin = req.headers.origin;
      if (typeof origin === 'string' && isAllowedLocalOrigin(origin)) return; // dev 浏览器豁免(D12)
      if (req.headers['x-sct-token'] !== token) {
        return reply.code(401).send({ error: '缺少或无效的 API token' });
      }
    });

    // TOCTOU:findFreePort 释放探针与 listen 绑定之间存在窗口,遇 EADDRINUSE 重试(重新 findFreePort),最多 3 次
    let free = await findFreePort(opts.port);
    for (let attempt = 0; ; attempt++) {
      try {
        await app.listen({ port: free, host: '127.0.0.1' });
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== 'EADDRINUSE' || attempt >= 2) throw e;
        free = await findFreePort(free + 1);
      }
    }
    listening = true;
    const addr = app.server.address();
    if (typeof addr === 'object' && addr !== null) port = addr.port;
    pushLog('info', 'server', `listening on 127.0.0.1:${port}`); // 诊断日志:启动即有一行,面板打开不至于空白

    if (opts.portFile) {
      writeFileSync(opts.portFile, JSON.stringify({ port, pid: process.pid, token }));
    }

    const instance = app;
    return {
      port,
      token,
      // Low:close 幂等 + try/finally 保证 db 句柄一定释放;先 dispose 下载进程(杀残留 yt-dlp/ffmpeg)再关 server/db
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await downloadManager.dispose();
          await instance.close();
        } finally {
          db.close();
        }
      },
    };
  } catch (e) {
    // M5:setup 任一步失败(findFreePort 耗尽 / listen 失败 / writeFileSync)都要释放句柄,不能把 db 泄漏给调用方
    if (listening && app) {
      try {
        await app.close();
      } catch {
        /* 尽力清理 */
      }
    }
    db.close();
    throw e;
  }
}
