import type { FastifyInstance } from 'fastify';
import { probeBin } from '../bins.js';
import type { DB } from '../db/index.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';

const ALLOWED_KEYS = new Set<string>(Object.values(SETTINGS_KEYS));

export function registerSettingsRoutes(app: FastifyInstance, db: DB): void {
  const repo = createSettingsRepo(db);

  // 只返回白名单键:repo.all() 含内部键 health_stamp(不进 SETTINGS_KEYS),直接返回会泄露
  app.get('/api/settings', async () =>
    Object.fromEntries(Object.entries(repo.all()).filter(([k]) => ALLOWED_KEYS.has(k))),
  );

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
    for (const [k, v] of Object.entries(body)) repo.set(k, v as string);
    return { ok: true };
  });

  app.get('/api/bins/probe', async (_req, reply) => {
    // 探测响应不缓存(状态变更型 GET)
    reply.header('cache-control', 'no-store');
    // 两个探测相互独立,各自 8s 超时;并行避免串行最坏 ~16s
    const [ytdlp, ffmpeg] = await Promise.all([
      probeBin('yt-dlp', repo.get(SETTINGS_KEYS.binYtdlp) ?? undefined),
      probeBin('ffmpeg', repo.get(SETTINGS_KEYS.binFfmpeg) ?? undefined),
    ]);
    repo.set(SETTINGS_KEYS.binsProbedAt, new Date().toISOString());
    if (ytdlp.version) repo.set(SETTINGS_KEYS.binYtdlp, ytdlp.path!);
    if (ffmpeg.version) repo.set(SETTINGS_KEYS.binFfmpeg, ffmpeg.path!);
    return { ytdlp, ffmpeg };
  });
}
