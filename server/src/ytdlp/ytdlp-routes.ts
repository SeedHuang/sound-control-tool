// server/src/ytdlp/ytdlp-routes.ts(Task 5:download 路由 + 两段式入库;Task 6 续 SSE/cancel/retry)
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db/index.js';
import { isAllowedOrigin, isAllowedLocalOrigin, isLocalPageReferer } from '../http/cors.js';
import { clearLogs, getLogs, pushLog } from '../logs.js';
import { createAudioItemsRepo, type AudioItemRow, type AudioItemsRepo } from '../db/repo/audio-items.js';
import { deleteAudioFile } from '../audio-files.js';
import { coverMime, fetchAndStoreCover, findCoverFile, writeCoverViaYtdlp } from '../covers.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { BILI_COOKIE_KEY, SETTINGS_KEYS } from '../settings-keys.js';
import { buildDownloadArgs } from './args.js';
import { countCookies, getSessdataExpiry, materializeCookieFile, normalizeCookieContent, toCookieHeader } from './cookies.js';
import { validateBiliLogin } from './bili-login.js';
import { createImportsRepo, detectSite } from '../db/repo/imports.js';
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
// 诊断日志:每个 job 只在 25/50/75/100 档位变化时记一行进度(逐条进度行会把日志面板刷成噪声)
const lastProgressBucket = new Map<number, number>();
function emit(jobId: number, ev: unknown): void {
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

// Task 7:文件流 Content-Type 按扩展名映射——给 <audio> 标签可识别的 MIME,未知格式回退 octet-stream
const MIME: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };

export interface YtdlpDeps {
  db: DB;
  binProvider: () => Promise<{ path: string | null }>;
  downloadManager: DownloadManager;
  audioDir: string; tempDir: string; token: string;
  /** 封面抓取(2026-09-29):默认走 covers.ts 的真实实现(带 Referer 抓 B 站图床);单测注入桩,避免真发网络 */
  coverFetcher?: CoverFetcher;
  /** 封面兜底抓法:让 yt-dlp 自己写图(--write-thumbnail)。外网图床只能走它(Node fetch 不走系统代理) */
  coverWriter?: CoverWriter;
}

/** 抓一张作品封面并落盘;返回是否成功(失败只记日志,不抛) */
export type CoverFetcher = (opts: { url: string; coversDir: string; importId: number }) => Promise<boolean>;
/** 让 yt-dlp 直接把封面写到 coversDir;返回是否成功 */
export type CoverWriter = (opts: { url: string; coversDir: string; importId: number }) => Promise<boolean>;

/** 下载任务载荷(jobs.payload 存的就是它,retry 直接复用):剧集两字段随行,入库时才写进 audio_items */
export interface DownloadJobPayload {
  url: string;
  options: Record<string, unknown>;
  title?: string;
  durationSec?: number;
  entryIndex?: number | null;      // 合集第几集(1 起);单视频不传
  collectionTitle?: string | null; // 所属合集标题;单视频不传
}

// B 站 Cookie 注入(parse/download 两处共用):settings 里存了 Cookie → 物化 cookies.txt 到数据目录
// (dirname(audioDir),与 db 同级,不进仓库);未设置/全空白/物化失败 → 返回 undefined 并留痕,不阻断下载
// (Cookie 只是增强,不能因为它让无 Cookie 场景挂掉)。
function resolveCookiePath(db: DB, audioDir: string): string | undefined {
  const content = createSettingsRepo(db).get(BILI_COOKIE_KEY);
  if (!content || content.trim().length === 0) return undefined;
  try {
    return materializeCookieFile(content, dirname(audioDir));
  } catch (e) {
    pushLog('error', 'job', `cookie 文件物化失败，跳过 --cookies 注入: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** 覆盖下载(2026-09-29 用户拍板:同一集/同一视频重下 → 删掉库里原来那一份,只留新的)。
 *  调用时机必须是**新文件已成功入库之后**——顺序反过来,一旦重下失败,用户原来那份就白丢了。
 *  删磁盘文件失败不改判结果(与 DELETE /api/audio/:id 同款语义:DB 行删了就算「删了」)。返回删掉的行数。 */
function replaceSameItems(audioRepo: AudioItemsRepo, opts: { url: string; entryIndex: number | null; title: string; keepId: number }): number {
  let removed = 0;
  for (const old of audioRepo.findSameItem(opts.url, opts.entryIndex, opts.title)) {
    if (old.id === opts.keepId) continue;
    const fileResult = deleteAudioFile(old.id, audioRepo);
    audioRepo.delete(old.id);
    removed += 1;
    pushLog('info', 'audio.replace', `id=${old.id} 被新 id=${opts.keepId} 覆盖 file=${old.file_path} deleted=${fileResult.deleted}`);
  }
  return removed;
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
  async function finalizeDownload(jobId: number, payload: DownloadJobPayload, producedPath: string): Promise<void> {
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
        entryIndex: payload.entryIndex ?? null, collectionTitle: payload.collectionTitle ?? null,
        audioDir, exists: existsSync, audioRepo,
      });
      audioId = result.audioId;
      // 覆盖下载(2026-09-29 用户拍板):用户在前端弹窗里确认过覆盖(force)→ 新文件已安全入库,现在才删库里旧的那一份
      const replaced = (payload.options as { force?: unknown }).force === true
        ? replaceSameItems(audioRepo, {
            url: payload.url, entryIndex: payload.entryIndex ?? null,
            title: payload.title ?? '下载音频', keepId: result.audioId,
          })
        : 0;
      jobsRepo.finish(jobId);
      pushLog('info', 'job', `job ${jobId} done → audio ${result.audioId} @ ${result.finalPath}${replaced > 0 ? `(覆盖并删掉旧条目 ${replaced} 条)` : ''}`); // 诊断日志:入库成败都要可见
      emit(jobId, { type: 'done', audioId: result.audioId, filePath: result.finalPath, title: payload.title ?? '下载音频', format, replaced: replaced > 0 });
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
  async function startDownload(jobId: number, payload: DownloadJobPayload): Promise<void> {
    jobsRepo.update(jobId, { status: 'running' });
    const opt = (payload.options ?? {}) as { entryIndices?: number[]; section?: { start: number; end: number }; format?: string; quality?: string };
    const bin = await binProvider();
    if (!bin.path) {
      const msg = mapYtdlpError({ binPath: null }).message;
      jobsRepo.fail(jobId, msg);
      pushLog('error', 'job', `job ${jobId} error: ${msg}`); // 诊断日志:bin 缺失也要在面板可见
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
      cookiePath: resolveCookiePath(db, audioDir), // B 站 Cookie:设置里有就注入 --cookies(未设置/物化失败 → undefined,照常下载)
    });
    pushLog('info', 'job', `job ${jobId} spawn yt-dlp bin=${bin.path}`); // 诊断日志:记录实际用的二进制路径
    downloadManager.start({
      jobId, binPath: bin.path, args, outDir: jobOutDir,
      onEvent: (jid, ev) => {
        if (ev.type === 'progress') {
          jobsRepo.update(jid, { progress: ev.percent });
          // 诊断日志只记 25/50/75/100 档位变化(逐条进度行会把日志面板刷成噪声)
          const bucket = Math.floor(ev.percent / 25);
          if (lastProgressBucket.get(jid) !== bucket) {
            lastProgressBucket.set(jid, bucket);
            pushLog('info', 'job', `job ${jid} 进度 ${Math.round(ev.percent)}%`);
          }
          emit(jid, ev); // Critical 修复:进度事件推给该 job 的所有 SSE 连接(前端进度条依赖;emit 把 type 写进 event 行)
        }
        if (ev.type === 'status' && ev.state === 'done' && ev.producedPath) {
          // 阶段信号(2026-09-29 用户拍板:进度条分两段——① 下载 ② 入库):
          // 下载进程结束了,但东西还没进音频库——后面还有 ffprobe 测时长、改名、写库三步(实测约 4 秒)。
          // 先把「进入入库」推给前端,进度条才能从下载段切到入库段;
          // 否则进度条停在 100% 而库里还是空,用户会以为下好了跑去看列表(就是这次踩的坑)。
          pushLog('info', 'job', `job ${jid} 下载完成 → 进入入库(ffprobe + rename + INSERT)`);
          emit(jid, { type: 'phase', phase: 'ingest' });
          void finalizeDownload(jid, payload, ev.producedPath);
        }
        if (ev.type === 'status' && ev.state === 'error' && ev.message) {
          jobsRepo.fail(jid, ev.message);
          pushLog('error', 'job', `job ${jid} error: ${ev.message}`); // 诊断日志:下载进程报错留痕
          emit(jid, { type: 'status', state: 'error', message: ev.message });
        }
      },
    });
  }
  return { startDownload, finalizeDownload, getFfprobe };
}

export function registerYtdlpRoutes(app: FastifyInstance, deps: YtdlpDeps): void {
  const { db, binProvider, token, downloadManager, audioDir } = deps;
  const audioRepo = createAudioItemsRepo(db);
  const importsRepo = createImportsRepo(db);
  // 封面目录:与音频同级(audioDir = <数据目录>/audio → <数据目录>/covers),沿用 D4「与 db 同数据目录」的约定
  const coversDir = join(dirname(audioDir), 'covers');
  const coverFetcher: CoverFetcher = deps.coverFetcher ?? fetchAndStoreCover;
  // 兜底抓法:让 yt-dlp 自己写图(bin 在调用时才解析,和 parse/download 一致)
  const coverWriter: CoverWriter = deps.coverWriter ?? (async (o) => {
    const bin = await binProvider();
    if (bin.path === null) return false;
    return writeCoverViaYtdlp({ ...o, binPath: bin.path, cookiePath: resolveCookiePath(db, audioDir) });
  });
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
      const parsed = await parseMetadata(bin.path, url, 20_000, execFile, resolveCookiePath(db, audioDir));
      // 诊断日志:解析成功一行(kind + 条目数),面板里能看到"解析了什么"
      pushLog('info', 'job', `parse ${url} → ${parsed.kind} (${parsed.entries?.length ?? 0} entries)`);
      // 导入来源自动落库(2026-09-29 用户拍板):同 URL 重复解析更新缓存,前端左列表据此持久化
      const importId = importsRepo.upsertByUrl({
        url,
        title: parsed.title,
        site: detectSite(url),
        kind: parsed.kind,
        duration_sec: parsed.durationSec ?? null,
        entries: parsed.entries ?? null,
        thumbnail: parsed.thumbnail ?? null, // 封面原始地址(图片本体另落盘 covers/,见下)
      });
      // 封面预热(2026-09-29 用户拍板「解析时抓 + 看图兜底」):后台跑,**不 await**——
      // 解析接口该 1~5 秒返回还是 1~5 秒返回。ensureCover 内部还会处理"flat 解析根本没给封面地址"的情况
      // (B 站番剧就是如此,它会单独问一次 yt-dlp 拿封面再抓),失败只记日志,卡片回退纯色。
      void ensureCover({ id: importId, url, kind: parsed.kind, thumbnail: parsed.thumbnail ?? null });
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
        import_id: importId,
      };
    } catch (e) {
      if (e instanceof YtdlpRunError) {
        pushLog('error', 'job', `parse ${url} 失败: ${e.info.message}`); // 诊断日志:解析失败要能看到原因
        return reply.code(502).send({ ok: false, error: e.info });
      }
      throw e;
    }
  });

  app.post('/api/ytdlp/download', async (req, reply) => {
    const body = (req.body ?? {}) as {
      url?: unknown; options?: Record<string, unknown>; title?: unknown; durationSec?: unknown;
      entryIndex?: unknown; collectionTitle?: unknown;
    };
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
    // 判重(2026-09-29 用户拍板:条目也要判重,确认后可覆盖):
    // 历史上只对「单视频整条」按网址判重——因为合集里每集共用同一个番剧网址,按网址一刀切会把第 2 集起全拦死,
    // 于是当时干脆关掉了条目判重;后果是同一集重下会静默留下两份(用户实测踩到,手动删过一次)。
    // 现在库里已记「第几集」,可按 网址 + 第几集 精确判重(老库没记集数的行按标题兜底,见 repo.findSameItem)。
    // 命中且未确认覆盖 → 409(此时还没 spawn 下载,不浪费流量):前端弹窗问过用户后带 force 重发。
    // 本请求的「第几集」:以真正驱动下载的 options.entryIndices 为准(前面已校验为单个正整数),兼容只带 body.entryIndex 的写法
    const entryIndex = Array.isArray(opt.entryIndices) && typeof opt.entryIndices[0] === 'number'
      ? opt.entryIndices[0]
      : (typeof body.entryIndex === 'number' && Number.isInteger(body.entryIndex) && body.entryIndex > 0 ? body.entryIndex : null);
    const existing = audioRepo.findSameItem(url, entryIndex, typeof body.title === 'string' ? body.title : '');
    if (existing.length > 0 && opt.force !== true) {
      const first = existing[0]!;
      const what = entryIndex !== null ? `第 ${entryIndex} 集` : `《${first.title}》`;
      return reply.code(409).send({
        ok: false,
        error: { code: 'DUPLICATE', message: `库中已存在${what}`, next: '确认重新下载会删掉库里原来那一份(文件也删),只保留新下的' },
      });
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
    // 剧集元数据随任务存档(entryIndex 上面已算出):入库时写进 audio_items,retry 也据此复用
    const collectionTitle =
      typeof body.collectionTitle === 'string' && body.collectionTitle.trim().length > 0 ? body.collectionTitle.trim() : null;
    const payload: DownloadJobPayload = {
      url, options: body.options ?? {},
      title: typeof body.title === 'string' ? body.title : undefined,
      durationSec: typeof body.durationSec === 'number' ? body.durationSec : undefined,
      entryIndex, collectionTitle,
    };
    const jobId = jobsRepo.create('ytdlp_download', payload);
    pushLog('info', 'job', `job ${jobId} created url=${url} format=${String(opt.format)}`); // 诊断日志:任务创建留痕
    await startDownload(jobId, payload);
    return reply.code(201).send({ ok: true, jobId });
  });

  // B 站 Cookie(2026-09-29 用户拍板:设置页粘贴 → server 保存 → yt-dlp --cookies 注入):
  // GET 只回元数据(set/length/count/有效期),内容永不回传(键不在 SETTINGS_KEYS 白名单,GET /api/settings 也拿不到)
  app.get('/api/cookie', async () => {
    const content = createSettingsRepo(db).get(BILI_COOKIE_KEY);
    const set = content !== null && content.trim().length > 0;
    const count = set ? countCookies(content) : 0;
    const expiry = set ? getSessdataExpiry(content) : null; // SESSDATA 过期 unix 秒;无登录凭据 → null
    return { ok: true, set, length: content?.length ?? 0, count, sessdataExpiry: expiry, expired: expiry === null ? null : expiry * 1000 <= Date.now() };
  });

  // PUT 流程(用户 2026-09-29 拍板「要做有效性校验;未过期提示已有登录信息」):
  // ① 结构校验(必须带 SESSDATA 登录凭据)→ ② 已有未过期登录信息 → 409 弹确认(force 放行)→ ③ B 站 nav 在线验登录态 → 保存
  app.put('/api/cookie', async (req, reply) => {
    const body = (req.body ?? {}) as { content?: unknown; force?: unknown };
    if (typeof body.content !== 'string' || body.content.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'content 必填(非空字符串)', next: '粘贴 B 站 Cookie 内容后保存' } });
    }
    const force = body.force === true;
    let netscape: string;
    try {
      netscape = normalizeCookieContent(body.content); // cURL 里没 Cookie 会在这里抛人话报错
    } catch (e) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: e instanceof Error ? e.message : 'Cookie 内容解析失败', next: '按设置页说明重新复制(F12 → Copy as cURL,选带登录 Cookie 的请求)' } });
    }
    const hasSessdata = netscape.split('\n').some((l) => { const c = l.split('\t'); return c.length >= 7 && c[5] === 'SESSDATA'; });
    if (!hasSessdata) {
      return reply.code(400).send({ ok: false, error: { code: 'NO_LOGIN_COOKIE', message: '解析不到登录凭据(SESSDATA)——这份 Cookie 只是游客设备指纹,过不了 B 站风控', next: '在已登录的浏览器:F12 → 网络面板 → 刷新 → 任选 www.bilibili.com 的请求 → 右键 Copy → Copy as cURL (bash) 重新粘贴' } });
    }
    const settingsRepo = createSettingsRepo(db);
    const existing = settingsRepo.get(BILI_COOKIE_KEY);
    if (existing !== null && !force) {
      const existingExpiry = getSessdataExpiry(existing);
      if (existingExpiry !== null && existingExpiry * 1000 > Date.now()) {
        const until = new Date(existingExpiry * 1000).toISOString().slice(0, 10);
        return reply.code(409).send({ ok: false, error: { code: 'CONFLICT', message: `已有一份有效的登录信息(有效期至 ${until})`, next: '确认要覆盖的话,在弹窗里点「仍然覆盖」' } });
      }
    }
    // 在线校验:B 站官方 nav 接口验登录态;网络类失败(requestOk=false)不拦保存——Cookie 可能仍可用于 yt-dlp
    const header = toCookieHeader(netscape);
    let verified = false;
    let uname: string | undefined;
    if (header !== null) {
      const v = await validateBiliLogin(header);
      if (v.requestOk && !v.isLogin) {
        return reply.code(400).send({ ok: false, error: { code: 'INVALID_COOKIE', message: `登录校验失败:${v.reason ?? '未登录'}`, next: 'Cookie 已过期或无效——请在浏览器重新登录后重新导出' } });
      }
      verified = v.requestOk ? v.isLogin : false;
      uname = v.uname;
    }
    settingsRepo.set(BILI_COOKIE_KEY, body.content);
    // 日志只记条数与校验结果,不记内容(凭据不进诊断日志)
    const count = countCookies(netscape);
    pushLog('info', 'job', `cookie saved (count=${count}, verified=${verified}${force ? ', force' : ''})`);
    return { ok: true, count, verified, uname: uname ?? null };
  });

  // ---- 导入来源(2026-09-29 用户拍板:左列表持久化;parse 成功已自动落库) ----
  // has_cover:封面图**是否已落到本地**(信息字段)。前端不靠它当开关——见 library.tsx:
  // 有来源记录就渲染 <img>,取不到图由 onError 回退纯色卡片(否则"没有本地图"的来源永远没机会去拿图)
  // ---- 封面:统一获取入口(2026-09-29,两段式) ----
  //   ① 本地已有图 → 直接给路径(日常都走这条)
  //   ② 库里存了封面地址 → 自己 fetch 抓(国内图床最快,实测 0.3s)
  //   ③ 自己抓不到 / 压根没地址 → **让 yt-dlp 自己写图**(--write-thumbnail)。
  //      两个理由:外网图床(Node 的 fetch 不读 Windows 系统代理,直连 i.ytimg.com 10s 超时;yt-dlp 走代理 130ms),
  //      以及合集(flat 解析对 B 站番剧不返回封面字段,库里没地址,只能让 yt-dlp 去问)
  //   ④ 都不行 → null(前端回退纯色卡片)
  // ③ 失败带 10 分钟冷却:避免每次开卡片墙都白跑一次几秒的 yt-dlp
  // 另加一层**按域名**的记忆(2026-09-29):外网图床(Node fetch 不读系统代理,直连必超时)每张图都要白等 10s,
  // 同一个域名失败过一次,10 分钟内直接跳到 yt-dlp——第二个 YouTube 作品从"12 秒出图"变成"2 秒出图"。
  const coverFailedAt = new Map<number, number>();
  const fetchHostFailedAt = new Map<string, number>();
  const COVER_COOLDOWN_MS = 10 * 60_000;
  const hostOf = (url: string): string => {
    try { return new URL(url).host; } catch { return ''; }
  };
  async function ensureCover(row: { id: number; url: string; kind: 'single' | 'playlist'; thumbnail: string | null }): Promise<string | null> {
    const local = findCoverFile(coversDir, row.id);
    if (local !== null) return local;
    // 冷却检查放在最前:失败过的来源连"自己 fetch"这一步也别重试——外网图床那一步要干等 10s,
    // 不做冷却的话每次开卡片墙都白等一次(用户看到的就是"图迟迟不出来")
    const failedAt = coverFailedAt.get(row.id);
    if (failedAt !== undefined && Date.now() - failedAt < COVER_COOLDOWN_MS) return null;
    if (row.thumbnail !== null) {
      const host = hostOf(row.thumbnail);
      const hostFailedAt = host === '' ? undefined : fetchHostFailedAt.get(host);
      const hostCooling = hostFailedAt !== undefined && Date.now() - hostFailedAt < COVER_COOLDOWN_MS;
      if (hostCooling) {
        pushLog('debug', 'cover', `域名 ${host} 刚直连失败过,跳过自己抓,直接让 yt-dlp 写 id=${row.id}`);
      } else if (await coverFetcher({ url: row.thumbnail, coversDir, importId: row.id })) {
        const fetched = findCoverFile(coversDir, row.id);
        if (fetched !== null) {
          if (host !== '') fetchHostFailedAt.delete(host); // 这个域名又通了(比如代理开了)→ 清掉记忆
          return fetched;
        }
      } else if (host !== '') {
        fetchHostFailedAt.set(host, Date.now());
      }
    }
    pushLog('info', 'cover', `让 yt-dlp 直接写封面 id=${row.id} url=${row.url}`);
    if (!(await coverWriter({ url: row.url, coversDir, importId: row.id }))) {
      coverFailedAt.set(row.id, Date.now());
      return null;
    }
    return findCoverFile(coversDir, row.id);
  }

  app.get('/api/imports', async () => ({
    ok: true,
    imports: importsRepo.list().map((it) => ({ ...it, has_cover: findCoverFile(coversDir, it.id) !== null })),
  }));

  app.get('/api/imports/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    const row = importsRepo.get(id);
    if (row === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    return { ok: true, import: { ...row, has_cover: findCoverFile(coversDir, id) !== null } };
  });

  // 作品封面图(2026-09-29 用户拍板:分组视图要显示作品封面;图片本体落盘 covers/,不依赖外网、不怕防盗链)。
  // token 规则与音频文件路由一致(query token 或本机来源);媒体元素(<img>)天生不带 Origin、页面也加不了 header,
  // 故额外认「Referer 是本机页面」——否则本地开发裸开浏览器(URL 无 apiToken)时封面会 401、卡片全退成纯色
  app.get('/api/imports/:id/cover', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      // 诊断日志(规则:失败路径必须有日志):这条以前只在 http 摘要里留个 401,看不出原因——
      // 是 token 错、还是既没 Origin 也没带本机 Referer(本地开发裸开浏览器时就是这种,播不出来)
      pushLog('error', 'audio.file', `audio file 401 id=${id} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} referer=${req.headers.referer ?? '(none)'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    const row = importsRepo.get(id);
    if (row === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    // 兜底自愈(用户拍板「解析时抓 + 看图兜底」):本地没有就现拿——可能是解析那次没抓成(断网/风控),
    // 也可能压根没封面地址(B 站番剧的 flat 解析不返回封面字段,这里会单独问一次 yt-dlp,首次几秒后出图)
    const file = await ensureCover(row);
    if (file === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '没有封面', next: '' } });
    reply.header('content-type', coverMime(file)).header('cache-control', 'public, max-age=86400');
    return reply.send(createReadStream(file));
  });

  app.delete('/api/imports/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '' } });
    return { ok: importsRepo.delete(id) };
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
      // 诊断日志:401 要看清是 token 错还是 origin 不在白名单——查 SSE 断连必备
      pushLog('error', 'job', `SSE 401 job=${id} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} localOrigin=${isAllowedLocalOrigin(origin)}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    const jobsRepo = createJobsRepo(db);
    const job = jobsRepo.get(id);
    if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: 'job 不存在', next: '' } });
    const raw = reply.raw;
    // CORS 修复(2026-09-29 用户反馈):hijack reply 后 Fastify 的 onSend 钩子不会运行,
    // cors.ts 里依赖 onSend 下发的 access-control-allow-origin 因此缺失 → 浏览器拦截跨源 EventSource,进度事件全丢。
    // 此处在 writeHead 复刻 cors.ts onSend 的同款语义:origin 存在 → vary: Origin;白名单内(含 file:// 的 null)→ 反射 ACAO。
    const allowOrigin = origin !== '' && isAllowedOrigin(origin) ? origin : null;
    const sseHeaders: Record<string, string> = {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    };
    if (origin !== '') sseHeaders.vary = 'Origin';
    if (allowOrigin !== null) sseHeaders['access-control-allow-origin'] = allowOrigin;
    // 诊断日志(规则正例,2026-09-29 起改为 debug 级):hijacked 端点必须留 CORS 摘要——curl 不查 CORS,
    // 只有这行能解释「为什么浏览器没收到事件」。每建一条 SSE 连接就一行,所以归 debug、面板默认折叠
    pushLog('debug', 'job', `SSE open job=${id} origin=${origin || '(none)'} acao=${allowOrigin ?? '(none)'} local=${isAllowedLocalOrigin(origin)}`);
    reply.raw.writeHead(200, sseHeaders);
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
      // 诊断日志:客户端断开要留痕——浏览器关 tab / 心跳超时 / 浏览器 cancel,排查 SSE 异常中断必备
      pushLog('info', 'job', `SSE close job=${id} remaining=${sseConnections.get(id)?.size ?? 0}`);
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
    pushLog('info', 'job', `job ${id} cancelled by user`); // 诊断日志:取消也要留痕(用户反馈"取消没反应"要能查日志)
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
    let payload: Partial<DownloadJobPayload>;
    try { payload = JSON.parse(old.payload) as Partial<DownloadJobPayload>; } catch {
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
    // 复用 Task 5 的 startDownload;原 title/durationSec/剧集字段一并透传(否则重试后标题回落"下载音频"、第几集丢失)
    await startDownload(newId, {
      url: payload.url,
      options: (payload.options ?? {}) as Record<string, unknown>,
      title: typeof payload.title === 'string' ? payload.title : undefined,
      durationSec: typeof payload.durationSec === 'number' ? payload.durationSec : undefined,
      entryIndex: typeof payload.entryIndex === 'number' ? payload.entryIndex : null,
      collectionTitle: typeof payload.collectionTitle === 'string' ? payload.collectionTitle : null,
    });
    return reply.code(201).send({ ok: true, jobId: newId });
  });

  // Task 7:音频列表——spec 0.3:返回数组(非 {ok,items});list() 已按 created_at DESC(§0.4)
  // 2026-09-29 用户拍板:每行带 site(由 source_url 反查平台)→ 前端音频库显示平台 logo
  // 2026-09-29 用户拍板(补齐老记录):改动前入库的音频没记「所属合集 / 第几集」,但来源网址还在——
  // 拿它反查 imported_sources(解析时落库的那张表)就能把番剧名补回来;集数只在分集清单里
  // **唯一命中同名条目**时才判定(同名多条一律不猜:宁可不显示,也不显示错的集数)。已记录的值优先,不覆盖。
  const fillEpisodeFromImport = (row: AudioItemRow): { collection_title?: string; entry_index?: number } => {
    if (row.collection_title !== null && row.entry_index !== null) return {}; // 下载时已记全,不必反查
    if (row.source_url === null) return {};
    const src = importsRepo.getByUrl(row.source_url);
    if (src === null || src.kind !== 'playlist') return {}; // 单视频没有「第几集」可言,不补
    const out: { collection_title?: string; entry_index?: number } = {};
    if (row.collection_title === null) out.collection_title = src.title;
    if (row.entry_index === null) {
      const hits = (src.entries ?? []).filter((e) => e.title === row.title);
      if (hits.length === 1) out.entry_index = hits[0]!.index;
    }
    return out;
  };
  app.get('/api/audio', async () =>
    audioRepo.list().map((row) => ({ ...row, ...fillEpisodeFromImport(row), site: detectSite(row.source_url ?? '') })),
  );

  // 诊断日志(2026-09-29 用户反馈):环形缓冲最近 500 条,前端"日志"按钮拉取。
  // 守卫不需要改——index.ts 的 onRequest 对 /api/* 校验 token(localhost 来源豁免),
  // 浏览器直连(localhost)与 Electron(file:// + x-sct-token 头)都可达。
  app.get('/api/logs', async () => ({ ok: true, logs: getLogs() }));

  // 前端操作日志汇入(2026-09-29 用户拍板:前端做什么操作都发给后端,统一系统里看"当时发生了什么")
  app.post('/api/logs', async (req, reply) => {
    const body = (req.body ?? {}) as { level?: unknown; message?: unknown };
    if (typeof body.message !== 'string' || body.message.trim().length === 0) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: 'message 必填(非空字符串)', next: '' } });
    }
    // debug 也要透传(2026-09-29 加级别时补):否则前端的 debug 行会被降级成 info,面板过滤就白配了
    const level = body.level === 'error' ? 'error' : body.level === 'debug' ? 'debug' : 'info';
    pushLog(level, 'web', body.message);
    return { ok: true };
  });

  // 清空日志(2026-09-29 用户拍板:日志要可删除):?day=YYYY-MM-DD 只清该天,缺省清全部(内存缓冲 + 落盘文件)
  app.delete('/api/logs', async (req) => {
    const q = (req.query ?? {}) as { day?: string };
    const day = typeof q.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.day) ? q.day : undefined;
    const r = clearLogs(day);
    pushLog('info', 'server', `logs cleared day=${day ?? '(all)'} entries=${r.clearedEntries} files=${r.deletedFiles.length} failed=${r.failedFiles.length}`); // 清完留一行,面板不至于空白
    return { ok: true, ...r };
  });

  // Task 7:音频文件流——D3 query token(<audio> 标签无法设 header);P2-5:非正整数 id → 404,避免 NaN 查询行为未定义
  app.get('/api/audio/:id/file', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { token?: string };
    // D3 更新(2026-09-29):同 SSE 路由,localhost 来源豁免 query token
    // 又补(2026-09-29):<audio> 也不带 Origin、页面加不了 header → 额外认「Referer 是本机页面」。
    // 实测日志里 /api/audio/:id/file 大量 401 就是这个坑:本地开发裸开浏览器时播放器根本拿不到文件。
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    // P2-5:id 非正整数(Number('abc')/0/负数)→ 404,避免 NaN 查询行为未定义
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
    const item = audioRepo.get(id);
    if (!item) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
    if (!existsSync(item.file_path)) return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '文件已丢失', next: '' } });
    const stat = statSync(item.file_path);
    // Range 支持(2026-09-29 用户反馈:音频进度条拉不动)——浏览器拖动进度条发 Range 头期待 206 部分内容;
    // 之前声明 accept-ranges 却永远回 200 全量,浏览器锁死进度条。现在真正处理 Range:
    const range = req.headers.range;
    reply
      .header('content-type', MIME[item.format] ?? 'application/octet-stream')
      .header('content-disposition', 'inline')
      .header('accept-ranges', 'bytes');
    const m = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (m !== null && ((m[1] ?? '') !== '' || (m[2] ?? '') !== '')) {
      const size = stat.size;
      const startRaw = m[1] ?? '';
      const endRaw = m[2] ?? '';
      const start = startRaw !== '' ? parseInt(startRaw, 10) : 0;
      const end = endRaw !== '' ? Math.min(parseInt(endRaw, 10), size - 1) : size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        reply.header('content-range', `bytes */${size}`);
        return reply.code(416).send();
      }
      reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
      return reply.send(createReadStream(item.file_path, { start, end }));
    }
    reply.header('content-length', stat.size);
    return reply.send(createReadStream(item.file_path));
  });

  // 2026-09-29 新增:DELETE /api/audio/:id —— 同时删 DB 行 + 磁盘文件
  // 设计:删文件失败(ENOENT/权限)不让接口失败,只 log——DB 行已删就达到用户"删了"的语义
  // (audio-files.ts 内部 try/catch 兜住,这里只看 DB 行删除结果)
  app.delete('/api/audio/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    // P2-5:同 /file 路由,非正整数 id → 404(避免 NaN 查询行为未定义)
    if (!Number.isInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
    const before = audioRepo.get(id);
    if (!before) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '音频不存在', next: '' } });
    const fileResult = deleteAudioFile(id, audioRepo); // 先删文件(DB 行还在时按 file_path 读得到路径)
    audioRepo.delete(id); // 再删 DB 行
    pushLog('info', 'audio.delete', `id=${id} deleted=${fileResult.deleted} path=${fileResult.path ?? '(none)'}`);
    return { ok: true, deleted: fileResult.deleted };
  });
}
