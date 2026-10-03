// server/src/media/media-routes.ts
// 媒体素材路由(2026-09-29 spec m1c-video-clip §0.3):列表 / 视频流(带 Range) / 删素材 / 剪音频。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createImportsRepo } from '../db/repo/imports.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import type { DB } from '../db/index.js';
import { isAllowedLocalOrigin, isLocalPageReferer } from '../http/cors.js';
import { sendFileWithRange } from '../http/file-range.js';
import { pushLog } from '../logs.js';
import { deleteVideoFiles } from './media-files.js';
import { startClipJob, type ClipJobPayload } from './clip-job.js';
import { derivedDirFor, ensureDerivedImage, invalidateDerived, type DerivedKind } from './derived-images.js';

export { formatClipTitle } from './clip-job.js';

// Task 9 同款:文件流 Content-Type 按扩展名映射——给 <video> 标签可识别的 MIME,未知格式回退 octet-stream
const MEDIA_MIME: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };

/**
 * 派生图生成失败的「失败码 → HTTP 状态 + 下一步提示」映射（单一来源，路由里不再写 if/三元）。
 * 2026-10-02 审查修复轮 1 minor 4：原来只有 PROBE_FAIL 一种失败被单独分流，其余一律
 * 「到设置页检查 ffmpeg 配置」——把「素材本身的问题」与「环境没配好」混成一句话，把人引去错的地方。
 * 加新失败码只加一行。
 * ⚠️ 不要再往提示里加「素材太短（凑不满 12 帧）」这类说法：复核在 ffmpeg 9.0.2 上实测
 * 0.1/0.2/0.3/0.4/0.5/0.8/1.0/1.5 秒八档**全部正常出 PNG**（tile 在 EOF 会冲刷不满的 tile），
 * 写「不足 1 秒也会失败」是把用户引向一个不存在的病因。
 */
const DERIVED_FAIL: Record<'NO_FFMPEG' | 'FFMPEG_FAIL' | 'PROBE_FAIL' | 'SRC_CHANGED', { status: number; next: string }> = {
  NO_FFMPEG: { status: 500, next: '到设置页检查 ffmpeg 路径（ffprobe 需与 ffmpeg 同目录）' },
  FFMPEG_FAIL: { status: 500, next: '到设置页检查 ffmpeg 配置；素材已损坏或磁盘写入失败也会走到这里，详见日志页' },
  PROBE_FAIL: { status: 422, next: '删除该素材后重新下载完整视频；若重下后仍失败，见日志页排查环境原因' },
  // OCR R4(2026-10-03):生成期间素材被换源(重下/换清晰度)→ 旧内容产物按身份复核丢弃。瞬时冲突,刷新即自愈。
  // OCR R7:替换与删除两种成因都走到这里,出路不同,一句话都要说清
  SRC_CHANGED: { status: 409, next: '素材在生成期间被替换或删除：被替换则重新打开页面自动重画；被删除则需重新下载视频' },
};

export function registerMediaRoutes(
  app: FastifyInstance,
  deps: { db: DB; audioDir: string; tempDir: string; mediaDir: string; token: string },
): void {
  const { db, mediaDir, token } = deps;
  const videosRepo = createSourceVideosRepo(db);

  // —— P4 派生图（波形/胶片条，spec D6/D14/§0.3）——
  const serveDerived = (kind: DerivedKind) => async (req: FastifyRequest, reply: FastifyReply) => {
    const importId = Number((req.params as { importId: string }).importId);
    const q = (req.query ?? {}) as { token?: string };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    // 鉴权口径同 /api/media/:id/file 与 /cover：<img> 不带 Origin、加不了 header → 认 query token / 本机 Origin / 本机 Referer
    if (q.token !== token && !isAllowedLocalOrigin(origin) && !isLocalPageReferer(req.headers.referer)) {
      pushLog('error', 'media', `派生图 401 kind=${kind} import=${importId} origin=${origin || '(none)'} token=${q.token ? 'present' : 'missing'} referer=${req.headers.referer ?? '(none)'}`);
      return reply.code(401).send({ ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效', next: '' } });
    }
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    const row = videosRepo.get(importId);
    if (!row) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (!existsSync(row.file_path)) {
      // 素材行在但文件被外部删了（同 /file 的两种 404 文案）
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
    }
    const r = await ensureDerivedImage({
      kind, importId, videoPath: row.file_path, derivedDir: derivedDirFor(mediaDir), tempDir: deps.tempDir, db,
      // OCR R5/R9:落盘前查 DB 现登记做第二重身份校验。三态:row 没了='gone'(引导重下)、row 换人='replaced'(刷新自愈)
      sourceState: (p) => {
        const cur = videosRepo.get(importId);
        if (cur === null) return 'gone';
        return cur.file_path === p ? 'current' : 'replaced';
      },
    });
    if (!r.ok) {
      // 失败码 → (HTTP 状态, 下一步提示) 映射表（2026-10-02 审查修复轮 1 minor 4）：
      // 加新失败码只加一行，别再让 if/三元把两种原因混成一句话。
      // - PROBE_FAIL = 422：素材本身的问题（文件损坏/没下完），不是服务端故障。语义比 500 贴切
      //   （对前端 <img> 效果一样，都进 onError；差别只在日志/排查时看得出是谁的锅）。
      // - 其余 = 500：ffmpeg 装没装、跑没跑通，是服务端/环境问题。
      // - FFMPEG_FAIL 的提示不再只让人查设置页：素材损坏也会走到这里，
      //   只写「去设置页」会把人引到错误的地方。
      //   ⚠️ 不要再提「素材太短」——复核实测 0.1~1.5 秒八档全部正常出图，那不是真病因。
      const fail = DERIVED_FAIL[r.code];
      pushLog('error', 'media', `派生图接口失败 kind=${kind} import=${importId} code=${r.code} status=${fail.status} msg=${r.message.slice(0, 200)}`);
      return reply.code(fail.status).send({ ok: false, error: { code: r.code, message: r.message, next: fail.next } });
    }
    // 静态派生图走「封面式裸流」，不用 sendFileWithRange（实测 H：<img> 不发 Range，PNG 无 seek 语义）。
    // cache-control no-store：素材一变派生图即作废、URL 不变，长缓存会显示上一集的波形（见计划 C-1）
    reply.header('content-type', 'image/png').header('cache-control', 'no-store');
    return reply.send(createReadStream(r.path));
  };
  app.get('/api/media/:importId/waveform', serveDerived('wave'));
  app.get('/api/media/:importId/filmstrip', serveDerived('film'));

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
      return reply.code(404).send({ ok: false, error: { code: 'FILE_MISSING', message: '素材文件已丢失，请重新下载视频', next: '回到资料库重新下视频' } });
    }
    const stat = statSync(row.file_path);
    const ext = row.file_path.slice(row.file_path.lastIndexOf('.') + 1).toLowerCase();
    // Range 语义与音频同款(http/file-range.ts 共用):拖进度条期待 206,永远 200 会把进度条锁死
    return sendFileWithRange(req, reply, {
      filePath: row.file_path, size: stat.size,
      contentType: MEDIA_MIME[ext] ?? 'application/octet-stream',
    });
  });

  app.delete('/api/media/:importId', async (req, reply) => {
    const importId = Number((req.params as { importId: string }).importId);
    if (!Number.isInteger(importId) || importId <= 0) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    if (videosRepo.get(importId) === null) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '素材不存在', next: '' } });
    // 删文件失败不让接口失败(与 DELETE /api/audio/:id 同款语义:DB 行删了就算"删了")
    const r = deleteVideoFiles(mediaDir, importId);
    videosRepo.delete(importId);
    invalidateDerived(derivedDirFor(mediaDir), importId); // R3-2：素材没了 → 派生图一并作废（失败只记日志）
    pushLog('info', 'media', `素材已删 import=${importId} deleted=${r.deleted.length} failed=${r.failed.length}`);
    return { ok: true, deleted: r.deleted.length };
  });

  // 休眠路由(m1c 遗留;2026-10-01 spec clip-works D20 保留不删):web 侧无调用方(api.ts 的 clipMedia 已休眠)。
  // ⚠️ 它产出的成品只记 source_import_id、**没有作品归属**(source_work_id 为空)——启用前必须先定归属(clip-works D20/backlog)。
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
      // 前缀默认取来源标题;时间段由服务端拼(spec D8,前端 title 只作前缀)
      title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title : (importRow?.title ?? '剪辑音频'),
      sourceUrl: importRow?.url,
    };
    const jobId = createJobsRepo(db).create('ffmpeg_clip', payload);
    pushLog('info', 'clip', `job ${jobId} created import=${importId} ${body.start}-${body.end}s format=${String(body.format)}`);
    // 不 await(R7,2026-09-30):与音频下载的 job 语义一致——POST 立即 201,前端拿到 jobId 先建 SSE 订阅,
    // 异步剪辑完成后事件才有人收;若 await,done 事件会在无订阅者时发出即丢(emit 找不到连接直接丢弃),前端进度条/完成回调全瞎。
    void startClipJob(jobId, payload, { db, audioDir: deps.audioDir, tempDir: deps.tempDir });
    return reply.code(201).send({ ok: true, jobId });
  });
}
