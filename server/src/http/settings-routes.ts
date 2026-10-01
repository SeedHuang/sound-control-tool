import type { FastifyInstance } from 'fastify';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { probeBin } from '../bins.js';
import type { DB } from '../db/index.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { pushLog } from '../logs.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { resolveOutputDir } from '../output-dir.js';

const ALLOWED_KEYS = new Set<string>(Object.values(SETTINGS_KEYS));

/** D5：非空输出目录必须**当场可写**——不能让用户等到点导出那一刻才发现（那时还要跑 ffmpeg）。
 *  做法：建目录（已存在则忽略）+ 写一个临时文件再删。返回 null 表示通过，否则返回失败原因。 */
function probeWritableDir(dir: string): string | null {
  const probe = join(dir, `.sct-write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok');
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* 清理失败不影响判定 */ }
  }
  return null;
}

// 第四个参数可选：三参调用（既有测试/调用方）行为完全不变。
// 传了它时，只有「本次确实写了 max_concurrent_downloads」且写入成功才回调一次——由 index.ts 接成 `() => queue.pump()`（D4）。
export function registerSettingsRoutes(
  app: FastifyInstance,
  db: DB,
  defaultOutputDir: string,
  onDownloadsConcurrencyChanged?: () => void,
): void {
  const repo = createSettingsRepo(db);

  // 只返回白名单键 + 一个**计算字段** output_dir_resolved（spec D11）：
  // 白名单过滤是因为 repo.all() 含内部键 health_stamp(不进 SETTINGS_KEYS)，直接返回会泄露；
  // 计算字段则是因为前端要知道「留空时默认存到哪」与「打开哪个目录」，而它不知道数据目录，不能自己拼。
  app.get('/api/settings', async () => ({
    ...Object.fromEntries(Object.entries(repo.all()).filter(([k]) => ALLOWED_KEYS.has(k))),
    output_dir_resolved: resolveOutputDir(db, defaultOutputDir),
  }));

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
    // D4+D5：**先校验、后写库**——校验不过绝不能落库，否则下次启动会拿着一个坏路径
    const rawOut = body[SETTINGS_KEYS.outputDir];
    if (typeof rawOut === 'string' && rawOut.trim() !== '') {
      if (!isAbsolute(rawOut)) {
        pushLog('error', 'server', `设置导出目录被拒(非绝对路径): ${rawOut}`);
        // spec §0.3：错误响应形状为 { ok:false, error:{...} }，与全仓其它路由一致
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '导出目录必须是绝对路径', next: '例如 D:\\Music\\sct' } });
      }
      const why = probeWritableDir(rawOut);
      if (why !== null) {
        pushLog('error', 'server', `设置导出目录被拒(不可写): ${rawOut} — ${why}`);
        // spec §0.3：同上，补 ok:false 使形状统一
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: `导出目录不可写：${why}`, next: '换一个可写目录，或留空用默认目录' } });
      }
      pushLog('info', 'server', `导出目录已设为 ${rawOut}`);
    }
    // 下载保护类三项校验（spec D2/D17）：同样「先校验、后写库」——非法值绝不落库。
    // 若让坏值落库，队列下次调度会拿着它起任务（例如上限 0 会让队列永远不起任何任务）。
    const rawConcurrency = body[SETTINGS_KEYS.maxConcurrentDownloads];
    if (typeof rawConcurrency === 'string') {
      // 只认纯数字串（拒 '1.5' / 'abc' / '-1' 这类 Number() 能部分解析或为 NaN 的输入）
      const n = Number(rawConcurrency);
      if (!/^\d+$/.test(rawConcurrency) || !Number.isInteger(n) || n < 1 || n > 5) {
        pushLog('error', 'server', `同时下载数被拒(越界/非法): ${rawConcurrency}`);
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '同时下载数必须是 1–5 的整数', next: '1–5 之间的整数，例如 1' } });
      }
    }
    const rawSleep = body[SETTINGS_KEYS.downloadSleepSeconds];
    if (typeof rawSleep === 'string') {
      const n = Number(rawSleep);
      if (!/^\d+$/.test(rawSleep) || !Number.isInteger(n) || n < 0 || n > 10) {
        pushLog('error', 'server', `下载间隔被拒(越界/非法): ${rawSleep}`);
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '下载间隔必须是 0–10 的整数（秒）', next: '0–10 之间的整数，例如 0' } });
      }
    }
    const rawRate = body[SETTINGS_KEYS.downloadLimitRate];
    if (typeof rawRate === 'string' && rawRate.trim() !== '') {
      // 空串 = 不限（合法）；非空须形如 500K / 1.5M / 2G —— 只在格式对时才落库，给 yt-dlp 一个能认的 --limit-rate
      if (!/^\d+(\.\d+)?[KMG]?$/i.test(rawRate.trim())) {
        pushLog('error', 'server', `下载限速被拒(格式非法): ${rawRate}`);
        return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST', message: '限速格式不合法（形如 500K / 1.5M）', next: '留空表示不限，或填写形如 500K / 1.5M / 2G 的值' } });
      }
    }
    for (const [k, v] of Object.entries(body)) repo.set(k, v as string);
    // D4：并发数改了要**立刻**催队列重新调度——只让 limit() 现读是不够的：
    // 若此刻「N 个在排队 + 1 个在跑」，把上限改大后没有任何事件会触发重新放行，得等那个在跑的结束才算数，那就不是“立刻”。
    // 只在本次确实提交了 max_concurrent_downloads（且已通过上面的校验、落库成功）时才回调，避免改无关键也白催一次。
    if (Object.prototype.hasOwnProperty.call(body, SETTINGS_KEYS.maxConcurrentDownloads)) {
      onDownloadsConcurrencyChanged?.();
    }
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
