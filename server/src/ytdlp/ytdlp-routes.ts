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
