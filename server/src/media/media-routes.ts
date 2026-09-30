// server/src/media/media-routes.ts
// 媒体素材路由(2026-09-29 spec m1c-video-clip §0.3):列表 / 视频流(带 Range) / 删素材 / 剪音频。
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

// Task 9 同款:文件流 Content-Type 按扩展名映射——给 <video> 标签可识别的 MIME,未知格式回退 octet-stream
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
