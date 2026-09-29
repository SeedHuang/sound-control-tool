// server/src/ytdlp/ytdlp-routes.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerYtdlpRoutes } from './ytdlp-routes.js';
import { createDownloadManager } from './download.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { registerRequestLogging } from '../logs.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { BILI_COOKIE_KEY, SETTINGS_KEYS } from '../settings-keys.js';
import { registerSettingsRoutes } from '../http/settings-routes.js';

// parse success 用例:mock parseMetadata 返回成功,避免真实 execFile 拉 yt-dlp;
// YtdlpRunError 保留真身(importOriginal 展开),不影响既有 400/409 用例(它们不触达 parseMetadata)
vi.mock('./parse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./parse.js')>();
  return {
    ...actual,
    parseMetadata: vi.fn(async () => ({ kind: 'single', title: '课', durationSec: 61.5, thumbnail: 'https://t/1.jpg' })),
  };
});

let db: DB;
let app: FastifyInstance;
let tempDir: string; // 每用例独立真实 tempDir(startDownload 会 mkdirSync 子目录;用 'C:/tmp' 会在机器上留残余)
beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  app = Fastify({ logger: false });
  tempDir = mkdtempSync(join(tmpdir(), 'sct-ytdlp-tmp-'));
});
afterEach(async () => {
  app.server.closeAllConnections?.(); // 强制关闭残留 SSE/keep-alive 连接,防 app.close() 悬挂
  await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true });
});

function makeApp(binPath: string | null, token = 'tok', dm?: ReturnType<typeof createDownloadManager>) {
  // audioDir 用临时子目录:Cookie 注入会把 cookies.txt 物化到 dirname(audioDir),不能写真机 C:/ 根
  const audioDir = join(tempDir, 'audio');
  mkdirSync(audioDir, { recursive: true });
  registerSettingsRoutes(app, db); // /api/settings 白名单用例需要真实 settings 路由
  return registerYtdlpRoutes(app, {
    db,
    binProvider: async () => ({ path: binPath }),
    downloadManager: dm ?? createDownloadManager(),
    audioDir, tempDir, token,
  });
}

describe('POST /api/ytdlp/parse', () => {
  it('url 缺失 → 400', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: {} });
    expect(res.statusCode).toBe(400);
  });
  it('bin 缺失 → 409 YTDLP_NOT_FOUND', async () => {
    makeApp(null);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('YTDLP_NOT_FOUND');
  });
  it('parse 成功 → ok:true 且 duration_sec 下划线契约(评审 Minor 补)', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(200);
    const j = res.json();
    expect(j.ok).toBe(true);
    expect(j.kind).toBe('single');
    expect(j.title).toBe('课');
    expect(j.duration_sec).toBe(61.5);
    expect(j.thumbnail).toBe('https://t/1.jpg');
  });
});

describe('POST /api/ytdlp/download', () => {
  it('download format 非法 → 400', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'u', options: { format: 'flac' } } });
    expect(res.statusCode).toBe(400);
  });
  it('download 已有同 URL 条目且非 force → 409 DUPLICATE', async () => {
    createAudioItemsRepo(db).create({ title: '已有', source_type: 'download', source_url: 'https://a/1', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE');
  });
  it('download 同 URL 已有 running job → 409 BUSY(P1-1)', async () => {
    // 预置一个 running 的同 URL job
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.update(jid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3', force: true } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUSY');
  });
  it('download 合法 → 201 返回 jobId', async () => {
    // 注:注入假 DownloadManager(只记录 start,不真 spawn)——brief 原用 createDownloadManager(),
    // 会真实拉起本机 yt-dlp 访问 https://a/1 并写 C:/tmp,测试不封闭(本机 yt-dlp 在 PATH、C:/tmp 不存在);
    // 路由契约(201/jobId/running)与 start 接线不依赖真实子进程,故注入假件,偏离已记 plan 注记
    const dm = {
      start: vi.fn(),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' }, title: '课' } });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().jobId).toBe('number');
    // job 已建且 running
    const job = createJobsRepo(db).get(res.json().jobId)!;
    expect(job.status).toBe('running');
    // startDownload 正确接线:jobId/outDir 传给 downloadManager.start(per-job 子目录)
    expect(dm.start).toHaveBeenCalledTimes(1);
    const startOpts = dm.start.mock.calls[0]?.[0] as { jobId: number; outDir: string } | undefined;
    expect(startOpts?.jobId).toBe(res.json().jobId);
    expect(startOpts?.outDir).toBe(join(tempDir, 'job' + res.json().jobId));
  });
});

// Task 6:SSE 实时流(真实 listen + fetch 读流)留作 Task 9 端到端手工验证;单测覆盖 401/404 静态分支 + cancel/retry
describe('GET /api/jobs/:id/events', () => {
  it('events token 错误 → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/1/events?token=bad' });
    expect(res.statusCode).toBe(401);
  });
  // D3 更新(2026-09-29):localhost 来源豁免 query token——浏览器直连 dev(无 apiToken)SSE 可连
  it('events localhost origin + 无 token → 守卫放行(不存在 job → 404,证明未 401)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events', headers: { origin: 'http://localhost:8000' } });
    expect(res.statusCode).toBe(404);
  });
  it('events localhost origin + token 错误 → 守卫放行(404)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events?token=bad', headers: { origin: 'http://127.0.0.1:8000' } });
    expect(res.statusCode).toBe(404);
  });
  it('events 非 localhost origin + 无 token → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/1/events', headers: { origin: 'http://evil.example' } });
    expect(res.statusCode).toBe(401);
  });
  it('events job 不存在 → 404', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events?token=tok2' });
    expect(res.statusCode).toBe(404);
  });
  it('events id 非正整数 → 404(M3)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/abc/events?token=tok2' });
    expect(res.statusCode).toBe(404);
  });
  // Critical 修复:progress 事件必须推送到 SSE 连接(此前只写 jobsRepo 不 emit,前端进度条恒 0%)
  // app.inject 会缓冲整个响应,SSE 永不断开无法用 inject 测 → 真实 listen + fetch 读流
  it('SSE 连接收到 progress 事件(emit 接线)', async () => {
    let fireProgress: (() => void) | undefined;
    let fireEnd: (() => void) | undefined;
    const dm = {
      start: vi.fn((opts: { jobId: number; onEvent: (jid: number, ev: unknown) => void }) => {
        // 捕获 onEvent,等 SSE 连接建立后再触发,模拟下载中途的进度行
        fireProgress = () => opts.onEvent(opts.jobId, { type: 'progress', percent: 42, downloadedBytes: 1024, totalBytes: 2048 });
        // 断言读完后触发终态,让服务端主动 end 连接——否则 app.close() 会等这条 SSE 连接悬挂
        fireEnd = () => opts.onEvent(opts.jobId, { type: 'status', state: 'cancelled', message: '测试收尾' });
      }),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const ac = new AbortController();
    const sse = await fetch(`http://127.0.0.1:${port}/api/jobs/${jobId}/events?token=tok2`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      // SSE 路由 handler 同步写完 writeHead/注册连接后 fetch 才 resolve,此时触发进度事件必达连接
      fireProgress!();
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !buf.includes('event: progress')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      fireEnd!(); // 服务端 end 连接(终态事件),app.close() 不再悬挂
    } finally {
      await reader.cancel().catch(() => {});
      ac.abort();
    }
    expect(buf).toContain('event: progress');
    expect(buf).toContain('"percent":42');
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('cancel 不存在 job → 404', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/999/cancel' });
    expect(res.statusCode).toBe(404);
  });
  it('cancel id 非正整数 → 404(M3)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/abc/cancel' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('retry id 非正整数 → 404(M3)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/abc/retry' });
    expect(res.statusCode).toBe(404);
  });
  it('retry 非 error job → 409 NOT_RETRYABLE(P1-4)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.update(jid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${jid}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_RETRYABLE');
  });
  it('retry error job 但同 URL 有 running → 409 BUSY(P1-4)', async () => {
    const jobsRepo = createJobsRepo(db);
    const errJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.fail(errJid, '网络失败');
    const runJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.update(runJid, { status: 'running' });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${errJid}/retry` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BUSY');
  });
  it('retry error job 且无并发 → 201 新 jobId', async () => {
    const jobsRepo = createJobsRepo(db);
    const errJid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.fail(errJid, '网络失败');
    // 注:偏离 brief 的 createDownloadManager()——同 Task 5,真 dm 会真实拉起本机 yt-dlp
    // 访问 https://a/1 并写 C:/tmp,测试不封闭;路由契约(201/新 jobId)不依赖真实子进程,故注入假件
    const dm = {
      start: vi.fn(),
      cancel: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${errJid}/retry` });
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().jobId).toBe('number');
    expect(res.json().jobId).not.toBe(errJid);
  });
});

// Task 7:audio 列表与文件流路由——文件流用真实临时文件(注入 mkdtemp 写真实 mp3),
// 断言 token 401/不存在 404/非正整数 id 404(P2-5)/200 + Content-Type + body
describe('GET /api/audio 与 GET /api/audio/:id/file', () => {
  it('audio 文件 token 错 → 401;不存在 → 404;非正整数 id → 404;存在 → 200 + Content-Type', async () => {
    const audioRepo = createAudioItemsRepo(db);
    const audioDir = mkdtempSync(join(tmpdir(), 'sct-audio-'));
    const id = audioRepo.create({ title: 't', source_type: 'download', source_url: 'u', file_path: join(audioDir, 't.mp3'), format: 'mp3', duration_sec: null, file_size: 3 });
    writeFileSync(join(audioDir, 't.mp3'), 'abc');
    makeApp('yt-dlp', 'tok2');
    expect((await app.inject({ method: 'GET', url: `/api/audio/${id}/file?token=bad` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/audio/999/file?token=tok2' })).statusCode).toBe(404);
    // P2-5:非正整数 id → 404
    expect((await app.inject({ method: 'GET', url: '/api/audio/abc/file?token=tok2' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/audio/0/file?token=tok2' })).statusCode).toBe(404);
    const ok = await app.inject({ method: 'GET', url: `/api/audio/${id}/file?token=tok2` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('audio/mpeg');
    expect(ok.body).toBe('abc');
  });
  // D3 更新(2026-09-29):localhost 来源豁免 query token——<audio> 标签无法设 header,浏览器直连 dev 需免 token
  it('audio 文件 localhost origin + 无 token → 守卫放行(不存在 id → 404,证明未 401)', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio/999/file', headers: { origin: 'http://localhost:8000' } });
    expect(res.statusCode).toBe(404);
  });
  it('audio 文件非 localhost origin + 无 token → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio/999/file', headers: { origin: 'http://evil.example' } });
    expect(res.statusCode).toBe(401);
  });
  it('audio 列表返回全部', async () => {
    createAudioItemsRepo(db).create({ title: 'a', source_type: 'download', source_url: 'u', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio' });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].title).toBe('a');
  });
});

// CORS 修复(2026-09-29 用户反馈):SSE 路由 hijack reply 后,Fastify 的 onSend 钩子不会运行,
// cors.ts 依赖 onSend 下发的 access-control-allow-origin 因此缺失 → 浏览器拦截跨源 EventSource,进度事件全丢。
// 修复后 hijack 的 writeHead 必须自带同款 CORS 头;用终态 job 让路由走 hijack 分支并立即 end(inject 可返回)。
describe('GET /api/jobs/:id/events SSE CORS 头(hijack 路径)', () => {
  it('白名单 origin → 反射 access-control-allow-origin + vary: Origin,终态补发不受影响', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.finish(jid); // done:路由走 hijack + 终态补发 + end
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${jid}/events?token=tok2`,
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8000');
    expect(res.headers['vary']).toBe('Origin');
    expect(res.body).toContain('event: status'); // 终态补发仍在(CORS 头不改变 SSE 行为)
  });
  it('file:// origin(null) → 反射 access-control-allow-origin: null(isAllowedOrigin 放行 file://)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.finish(jid);
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${jid}/events?token=tok2`,
      headers: { origin: 'null' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('null');
  });
  it('非白名单 origin → 不下发 access-control-allow-origin(vary: Origin 仍在)', async () => {
    const jobsRepo = createJobsRepo(db);
    const jid = jobsRepo.create('ytdlp_download', { url: 'https://a/1', options: { format: 'mp3' } });
    jobsRepo.finish(jid);
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({
      method: 'GET', url: `/api/jobs/${jid}/events?token=tok2`,
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toBe('Origin');
  });
});

// 诊断日志(2026-09-29 用户反馈):GET /api/logs 返回环形缓冲;/api/* 请求留痕(http 行)+ job 生命周期留痕
describe('GET /api/logs', () => {
  it('返回 ok:true + logs 数组;400 parse 请求留下一行 http 日志(路径剥离 query,不泄 token)', async () => {
    makeApp('yt-dlp');
    registerRequestLogging(app); // 与 index.ts createServer 同款请求日志钩子
    await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: {} }); // 400
    const res = await app.inject({ method: 'GET', url: '/api/logs?token=tok2' });
    expect(res.statusCode).toBe(200);
    const j = res.json() as { ok: boolean; logs: { level: string; source: string; message: string }[] };
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.logs)).toBe(true);
    const httpLine = j.logs.find((l) => l.source === 'http' && l.message.includes('POST /api/ytdlp/parse'));
    expect(httpLine).toBeDefined();
    expect(httpLine?.message).toContain('400');
    expect(httpLine?.level).toBe('info'); // 4xx 不算 server 错误(≥500 才 error)
  });
  it('download 成功 → job created/spawn 两行 job 日志可在 /api/logs 查到', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/9', options: { format: 'mp3' }, title: '课' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    const logsRes = await app.inject({ method: 'GET', url: '/api/logs' });
    const logs = (logsRes.json() as { logs: { source: string; message: string }[] }).logs;
    expect(logs.some((l) => l.source === 'job' && l.message === `job ${jobId} created url=https://a/9 format=mp3`)).toBe(true);
    expect(logs.some((l) => l.source === 'job' && l.message.includes(`job ${jobId} spawn yt-dlp bin=`))).toBe(true);
  });
});

// B 站 Cookie(2026-09-29 用户拍板):/api/cookie 元数据读写 + parse/download 的 --cookies 注入
describe('GET/PUT /api/cookie', () => {
  it('GET 未设置 → ok:true set:false length:0', async () => {
    makeApp('yt-dlp');
    const res = await app.inject({ method: 'GET', url: '/api/cookie' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, set: false, length: 0 });
  });
  it('PUT content 缺失/空白/非字符串 → 400', async () => {
    makeApp('yt-dlp');
    for (const payload of [{}, { content: '' }, { content: '   ' }, { content: 123 }]) {
      const res = await app.inject({ method: 'PUT', url: '/api/cookie', payload });
      expect(res.statusCode).toBe(400);
    }
  });
  it('PUT 成功 → ok:true;GET set:true length 一致;凭据不出 /api/settings 白名单', async () => {
    makeApp('yt-dlp');
    const content = '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx';
    const put = await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content } });
    expect(put.statusCode).toBe(200);
    expect(put.json().ok).toBe(true);
    const j = (await app.inject({ method: 'GET', url: '/api/cookie' })).json() as { set: boolean; length: number };
    expect(j.set).toBe(true);
    expect(j.length).toBe(content.length);
    // 凭据不出白名单:GET /api/settings 只回 SETTINGS_KEYS 内的键,绝无 bili_cookie
    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json() as Record<string, string>;
    expect(Object.keys(settings)).not.toContain('bili_cookie');
    // 通用 settings PUT 对白名单外键拒绝(凭据无法经该通道写入)
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { bili_cookie: 'x' } })).statusCode).toBe(400);
    // 键常量本身也不在白名单数组里(双保险)
    expect(Object.values(SETTINGS_KEYS)).not.toContain(BILI_COOKIE_KEY);
  });
});

describe('Cookie 注入(parse/download)', () => {
  it('已存 Cookie → parse 物化 cookies.txt 于 dirname(audioDir)', async () => {
    makeApp('yt-dlp');
    await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content: '.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx' } });
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://www.bilibili.com/x' } });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(tempDir, 'cookies.txt'))).toBe(true); // audioDir=join(tempDir,'audio') → dirname=tempDir
  });
  it('settings 存的是空白 Cookie → 不物化、parse 照常成功', async () => {
    makeApp('yt-dlp');
    createSettingsRepo(db).set(BILI_COOKIE_KEY, '   ');
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/parse', payload: { url: 'https://a' } });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(tempDir, 'cookies.txt'))).toBe(false);
  });
  it('download 已存 Cookie → spawn args 含 --cookies + cookies.txt 路径', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    await app.inject({ method: 'PUT', url: '/api/cookie', payload: { content: '.bilibili.com\tTRUE\t/\tTRUE\t1790000000\tSESSDATA\tx' } });
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://www.bilibili.com/x', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(201);
    const startOpts = dm.start.mock.calls[0]?.[0] as { args: string[] };
    expect(startOpts.args).toContain('--cookies');
    expect(startOpts.args).toContain(join(tempDir, 'cookies.txt'));
  });
  it('download 未存 Cookie → args 不含 --cookies(原形态不变)', async () => {
    const dm = { start: vi.fn(), cancel: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    makeApp('yt-dlp', 'tok2', dm as unknown as ReturnType<typeof createDownloadManager>);
    const res = await app.inject({ method: 'POST', url: '/api/ytdlp/download', payload: { url: 'https://a/1', options: { format: 'mp3' } } });
    expect(res.statusCode).toBe(201);
    const startOpts = dm.start.mock.calls[0]?.[0] as { args: string[] };
    expect(startOpts.args).not.toContain('--cookies');
  });
});
