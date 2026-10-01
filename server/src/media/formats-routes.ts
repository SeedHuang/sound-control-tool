// server/src/media/formats-routes.ts
// 可用清晰度探测(spec D6/D7/D8/D9)。只读、不下载;任何失败都降级成固定四档,绝不让下载不可用。
// 走普通 fetch(能带 header)→ index.ts 的 onRequest 守卫照常保护它,不加豁免。
import type { FastifyInstance } from 'fastify';
import { createImportsRepo } from '../db/repo/imports.js';
import { pushLog } from '../logs.js';
import type { DB } from '../db/index.js';
import { FALLBACK_TIERS, probeHeights } from '../ytdlp/probe-formats.js';

export interface FormatsDeps {
  db: DB; audioDir: string;
  binProvider: () => Promise<{ path: string | null }>;
  /** B 站 cookie 文件路径(既有 resolveCookiePath 的产物);未配置/物化失败 → undefined(照常探测) */
  cookiePath?: () => string | undefined;
  /** 可注入:单测不打真实外网 */
  probe?: (url: string, entry?: number) => Promise<number[]>;
}

const TTL_MS = 10 * 60 * 1000; // spec D9:单集探测结果缓存 10 分钟(同一集反复切换不该反复跑 yt-dlp)

export function registerFormatsRoutes(app: FastifyInstance, deps: FormatsDeps): void {
  const importsRepo = createImportsRepo(deps.db);
  const cache = new Map<string, { at: number; heights: number[] }>();

  app.get('/api/imports/:id/formats', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const notFound = () => reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '来源不存在', next: '回资料库刷新列表' } });
    if (!Number.isInteger(id) || id <= 0) return notFound();
    const row = importsRepo.get(id);
    if (row === null) return notFound();

    // 合集必须带 entry(spec D8):193 集不可能全探,只探用户选中的那一集
    const rawEntry = (req.query as { entry?: string }).entry;
    const entry = rawEntry !== undefined && rawEntry !== '' ? Number(rawEntry) : undefined;
    if (row.kind === 'playlist' && (entry === undefined || !Number.isInteger(entry) || entry <= 0)) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '合集需要先选一集', next: '在集数网格里点一集' } });
    }

    const key = `${row.url}#${entry ?? ''}`;
    const hit = cache.get(key);
    if (hit !== undefined && Date.now() - hit.at < TTL_MS) {
      return { ok: true, heights: hit.heights, fallback: hit.heights.length === 0 };
    }

    // 降级出口只有一个,避免"某条分支忘了 fallback"
    const degrade = (why: string): { ok: true; heights: number[]; fallback: true } => {
      pushLog('error', 'media', `清晰度探测降级 import=${id} entry=${entry ?? '-'} 原因=${why}`);
      return { ok: true, heights: FALLBACK_TIERS, fallback: true };
    };
    try {
      const bin = await deps.binProvider();
      if (!bin.path) return degrade('yt-dlp 未找到');
      const probe = deps.probe ?? ((url: string, e?: number) => probeHeights(bin.path!, url, e, undefined, deps.cookiePath?.()));
      const heights = await probe(row.url, entry);
      if (heights.length === 0) return degrade('拿不到 formats');
      cache.set(key, { at: Date.now(), heights });
      pushLog('info', 'media', `清晰度探测 import=${id} entry=${entry ?? '-'} → ${heights.join('/')}`);
      return { ok: true, heights, fallback: false };
    } catch (e) {
      return degrade(e instanceof Error ? e.message : String(e));
    }
  });
}
