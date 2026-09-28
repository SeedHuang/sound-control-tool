// server/src/ytdlp/ytdlp-routes.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerYtdlpRoutes } from './ytdlp-routes.js';
import { createDownloadManager } from './download.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';

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
beforeEach(async () => {
  db = openDatabase(':memory:'); initSchema(db);
  app = Fastify({ logger: false });
});
afterEach(async () => { await app.close(); db.close(); });

function makeApp(binPath: string | null, token = 'tok', dm?: ReturnType<typeof createDownloadManager>) {
  return registerYtdlpRoutes(app, {
    db,
    binProvider: async () => ({ path: binPath }),
    downloadManager: dm ?? createDownloadManager(),
    audioDir: 'C:/audio', tempDir: 'C:/tmp', token,
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
    // startDownload 正确接线:jobId/outDir 传给 downloadManager.start
    expect(dm.start).toHaveBeenCalledTimes(1);
    const startOpts = dm.start.mock.calls[0]?.[0] as { jobId: number; outDir: string } | undefined;
    expect(startOpts?.jobId).toBe(res.json().jobId);
    expect(startOpts?.outDir).toBe('C:/tmp');
  });
});

// Task 6:SSE 实时流(真实 listen + fetch 读流)留作 Task 9 端到端手工验证;单测覆盖 401/404 静态分支 + cancel/retry
describe('GET /api/jobs/:id/events', () => {
  it('events token 错误 → 401', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/1/events?token=bad' });
    expect(res.statusCode).toBe(401);
  });
  it('events job 不存在 → 404', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/999/events?token=tok2' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/cancel', () => {
  it('cancel 不存在 job → 404', async () => {
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'POST', url: '/api/jobs/999/cancel' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:id/retry', () => {
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
  it('audio 列表返回全部', async () => {
    createAudioItemsRepo(db).create({ title: 'a', source_type: 'download', source_url: 'u', file_path: 'C:/x/a.mp3', format: 'mp3', duration_sec: null, file_size: 1 });
    makeApp('yt-dlp', 'tok2');
    const res = await app.inject({ method: 'GET', url: '/api/audio' });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].title).toBe('a');
  });
});
