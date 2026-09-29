// server/src/ytdlp/ytdlp-routes.ts(Task 5:download 路由 + 两段式入库;Task 6 续 SSE/cancel/retry)
import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { isAllowedLocalOrigin } from '../http/cors.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { buildDownloadArgs } from './args.js';
import type { DownloadManager } from './download.js';
import { mapYtdlpError } from './errors.js';
import { probeDuration } from './ffprobe.js';
import { ingestDownloadedFile } from './ingest.js';
import { parseMetadata, YtdlpRunError } from './parse.js';

// SSE 事件桥(Task 6):模块级连接表,事件写入后终态(done/error/cancelled)断开,progress/running 保持
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

// Task 7:文件流 Content-Type 按扩展名映射——给 <audio> 标签可识别的 MIME,未知格式回退 octet-stream
const MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };

export interface YtdlpDeps {
  db: DB;
  binProvider: () => Promise<{ path: string | null }>;
  downloadManager: DownloadManager;
  audioDir: string; tempDir: string; token: string;
}

// 模块级辅助(在 registerYtdlpRoutes 外,通过参数注入 deps 更易测;此处为可注入闭包工厂)
function createDownloadHandlers(deps: YtdlpDeps) {
  const { db, binProvider, downloadManager, audioDir, tempDir, token } = deps;
  const jobsRepo = createJobsRepo(db);
  const audioRepo = createAudioItemsRepo(db);
  let ffprobePath: string | null = null; // 首次用时惰性探测
  async function getFfprobe(): Promise<string | null> {
    if (ffprobePath) return ffprobePath;
    const settings = createSettingsRepo(db);
    const ffmpegPath = settings.get(SETTINGS_KEYS.binFfmpeg);
    if (ffmpegPath) ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    return ffprobePath;
  }
  async function finalizeDownload(jobId: number, payload: { url: string; options: Record<string, unknown>; title?: string; durationSec?: number }, producedPath: string): Promise<void> {
    // P1-2:入库全流程包 try/catch——rename 被占/权限/IO 失败不得 unhandled rejection
    let audioId: number | null = null;
    try {
      const format = String(payload.options.format ?? 'mp3') as 'mp3' | 'm4a' | 'wav';
      const section = (payload.options as { section?: { start: number; end: number } }).section;
      // P1-3:片段下载强制 ffprobe 实测(片段时长 ≠ parse 的整条时长),忽略 payload.durationSec
      const needProbe = Boolean(section) || payload.durationSec === undefined;
      const duration = needProbe && (await getFfprobe()) ? await probeDuration((await getFfprobe())!, producedPath) : payload.durationSec ?? null;
      const size = statSync(producedPath).size;
      const result = ingestDownloadedFile({
        tmpPath: producedPath, title: payload.title ?? '下载音频', format,
        durationSec: duration, fileSize: size, sourceUrl: payload.url,
        audioDir, exists: existsSync, audioRepo,
      });
      audioId = result.audioId;
      jobsRepo.finish(jobId);
      emit(jobId, { type: 'done', audioId: result.audioId, filePath: result.finalPath, title: payload.title ?? '下载音频', format });
      // spec §0.3 列了 status done,但 emit('done') 已断开连接并删除订阅表,紧随的 status done 无人可达——
      // 前端 subscribeJob 只监听 progress/done/status(error/cancelled),不消费 status done,故不再单独发(由 done 隐含)
    } catch (err) {
      // 回滚:已 INSERT 的行删除 + job 置 error + SSE error(禁止残留指向 temp 的悬空行)
      if (audioId !== null) audioRepo.delete(audioId);
      const msg = err instanceof Error ? err.message : String(err);
      jobsRepo.fail(jobId, msg);
      emit(jobId, { type: 'status', state: 'error', message: msg });
    }
  }
  async function startDownload(jobId: number, payload: { url: string; options: Record<string, unknown>; title?: string; durationSec?: number }): Promise<void> {
    jobsRepo.update(jobId, { status: 'running' });
    const opt = (payload.options ?? {}) as { entryIndices?: number[]; section?: { start: number; end: number }; format?: string; quality?: string };
    const bin = await binProvider();
    if (!bin.path) {
      const msg = mapYtdlpError({ binPath: null }).message;
      jobsRepo.fail(jobId, msg);
      emit(jobId, { type: 'status', state: 'error', message: msg }); // 补 SSE 终态,否则订阅连接悬挂
      return;
    }
    // Important 修复:每 job 独立子目录——DownloadManager 的 cleanJobOutputs/findLatest 假设"一 job 一 outDir",
    // 并发不同 URL 共享 tempDir 时,取消会误删别的 job 产物、close 会 findLatest 到对方文件(title/content 串库)
    const jobOutDir = join(tempDir, 'job' + jobId);
    mkdirSync(jobOutDir, { recursive: true });
    const args = buildDownloadArgs({
      url: payload.url,
      options: {
        entryIndices: opt.entryIndices,
        section: opt.section,
        format: (opt.format ?? 'mp3') as 'mp3' | 'm4a' | 'wav',
        quality: opt.quality,
      },
      outDir: jobOutDir,
    });
    downloadManager.start({
      jobId, binPath: bin.path, args, outDir: jobOutDir,
      onEvent: (jid, ev) => {
        if (ev.type === 'progress') {
          jobsRepo.update(jid, { progress: ev.percent });
          emit(jid, ev); // Critical 修复:进度事件推给该 job 的所有 SSE 连接(前端进度条依赖;emit 把 type 写进 event 行)
        }
        if (ev.type === 'status' && ev.state === 'done' && ev.producedPath) {
          void finalizeDownload(jid, payload, ev.producedPath);
        }
        if (ev.type === 'status' && ev.state === 'error' && ev.message) {
          jobsRepo.fail(jid, ev.message);
          emit(jid, { type: 'status', state: 'error', message: ev.message });
        }
      },
    });
  }
  return { startDownload, finalizeDownload, getFfprobe };
}

export function registerYtdlpRoutes(app: FastifyInstance, deps: YtdlpDeps): void {
  const { db, binProvider, token, downloadManager } = deps;
  const audioRepo = createAudioItemsRepo(db);
  const { startDownload } = createDownloadHandlers(deps);

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

  app.post('/api/ytdlp/download', async (req, reply) => {
    const body = (req.body ?? {}) as { url?: unknown; options?: Record<string, unknown>; title?: unknown; durationSec?: unknown };
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
    await startDownload(jobId, { url, options: body.options ?? {}, title: typeof body.title === 'string' ? body.title : undefined, durationSec: typeof body.durationSec === 'number' ? body.durationSec : undefined });
    return reply.code(201).send({ ok: true, jobId });
  });

  // Task 6:SSE 事件流——query token(D3,EventSource 无法设 header);终态 job 立即补发并关闭
  app.get('/api/jobs/:id/events', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    // M3:id 非正整数(Number('abc')/0/负数)→ 404,与 audio 文件路由 P2-5 守卫一致
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    const q = (req.query ?? {}) as { token?: string };
    // D3 更新(2026-09-29):localhost 来源(浏览器直连 dev 无 apiToken)豁免 query token;
    // 非 localhost(含 file://)仍需 token——本地请求只能来自本机,不新增攻击面
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token !== token && !isAllowedLocalOrigin(origin)) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    const jobsRepo = createJobsRepo(db);
    const job = jobsRepo.get(id);
    if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    const raw = reply.raw;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    });
    // 立即冲刷响应头:Node 的 writeHead 只排队,首个 write/end 才真正发出头字节;
    // 不冲刷则客户端 fetch 会一直等响应头(心跳 15s 前的空闲连接头也不到客户端)
    raw.flushHeaders();
    // M2:写前判 writableEnded——终态后连接已 end,心跳/补发再写会触发 ERR_STREAM_WRITE_AFTER_END
    const conn: SseConn = { write: (s) => { if (!raw.writableEnded) raw.write(s); }, end: () => raw.end() };
    if (!sseConnections.has(id)) sseConnections.set(id, new Set());
    sseConnections.get(id)!.add(conn);
    // 心跳:15s 一次,保连接不被中间代理掐断(writableEnded 守卫同上)
    const heartbeat = setInterval(() => { if (!raw.writableEnded) raw.write(': ping\n\n'); }, 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      sseConnections.get(id)?.delete(conn);
      if (sseConnections.get(id)?.size === 0) sseConnections.delete(id);
    });
    // 已结束的 job 立即补发终态
    if (['done', 'error', 'cancelled'].includes(job.status)) {
      conn.write(`event: status\ndata: ${JSON.stringify({ state: job.status, message: job.message ?? undefined })}\n\n`);
      conn.end();
      clearInterval(heartbeat); // 终态已发,心跳无意义且可能写已 end 的流(close 事件里再清一次是幂等)
    }
    return reply; // 已 hijack reply.raw,返回 reply 对象防 Fastify 二次响应
  });

  // Task 6:取消——taskkill 杀进程树(cancel)+ job 置 cancelled + SSE 终态
  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    // M3:id 非正整数 → 404,避免 NaN 查询行为未定义
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    const jobsRepo = createJobsRepo(db);
    const job = jobsRepo.get(id);
    if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    await downloadManager.cancel(id);
    jobsRepo.update(id, { status: 'cancelled', message: '用户取消' });
    emit(id, { type: 'status', state: 'cancelled', message: '用户取消' });
    return { ok: true };
  });

  // Task 6:重试——仅 error 可重试(P1-4);建新 job 前同 URL 并发检查;复用 Task 5 的 startDownload
  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    // M3:id 非正整数 → 404,避免 NaN 查询行为未定义
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    const jobsRepo = createJobsRepo(db);
    const old = jobsRepo.get(id);
    if (!old) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    // P1-4:仅 error 可重试——对 running/pending 重试会造出同 URL 并发
    if (old.status !== 'error') {
      return reply.code(409).send({ ok: false, error: { code: 'NOT_RETRYABLE', message: '只有失败的任务可以重试', next: '' } });
    }
    let payload: { url?: string; options?: unknown; title?: unknown; durationSec?: unknown };
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
    // 复用 Task 5 的 startDownload;原 title/durationSec 一并透传(否则重试后标题回落"下载音频")
    await startDownload(newId, {
      url: payload.url,
      options: (payload.options ?? {}) as Record<string, unknown>,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      durationSec: typeof payload.durationSec === 'number' ? payload.durationSec : undefined,
    });
    return reply.code(201).send({ ok: true, jobId: newId });
  });

  // Task 7:音频列表——spec 0.3:返回数组(非 {ok,items});list() 已按 created_at DESC(§0.4)
  app.get('/api/audio', async () => audioRepo.list());

  // Task 7:音频文件流——D3 query token(<audio> 标签无法设 header);P2-5:非正整数 id → 404,避免 NaN 查询行为未定义
  app.get('/api/audio/:id/file', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { token?: string };
    // D3 更新(2026-09-29):同 SSE 路由,localhost 来源豁免 query token
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token !== token && !isAllowedLocalOrigin(origin)) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
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
}
