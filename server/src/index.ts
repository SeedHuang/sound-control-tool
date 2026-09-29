import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from './db/index.js';
import { createSettingsRepo } from './db/repo/settings.js';
import { initSchema } from './db/schema.js';
import { isAllowedLocalOrigin, registerCors } from './http/cors.js';
import { registerSettingsRoutes } from './http/settings-routes.js';
import { findFreePort } from './net/find-free-port.js';
import { probeBin } from './bins.js';
import { SETTINGS_KEYS } from './settings-keys.js';
import { createDownloadManager } from './ytdlp/download.js';
import { registerYtdlpRoutes } from './ytdlp/ytdlp-routes.js';

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
    initSchema(db);

    // health 写副作用收口:启动时一次性写入内部键 health_stamp(不进 SETTINGS_KEYS 白名单,不暴露给 PUT /api/settings),
    // 请求时只读——避免每请求建表/写入(产生第六张表、无界增长)与存活判定耦合 DB 写(SQLITE_BUSY 会误判 server 未启动)
    const settingsRepo = createSettingsRepo(db);
    const healthStamp = String(Date.now());
    settingsRepo.set('health_stamp', healthStamp);

    app = Fastify({ logger: false });
    registerCors(app);
    registerSettingsRoutes(app, db);

    let port = opts.port;

    app.get('/api/health', async () => {
      const row = settingsRepo.get('health_stamp');
      return { ok: true, sqlite: row, port };
    });

    // D12:随机 API token
    const token = randomBytes(16).toString('hex');

    // D4:audioDir 与 db 同目录
    const audioDir = path.join(path.dirname(opts.dbPath), 'audio');
    mkdirSync(audioDir, { recursive: true });

    const downloadManager = createDownloadManager();
    registerYtdlpRoutes(app, {
      db,
      binProvider: async () => {
        const explicit = settingsRepo.get(SETTINGS_KEYS.binYtdlp);
        const p = await probeBin('yt-dlp', explicit ?? undefined);
        return { path: p.path };
      },
      downloadManager, audioDir, tempDir: opts.tempDir, token,
    });

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
