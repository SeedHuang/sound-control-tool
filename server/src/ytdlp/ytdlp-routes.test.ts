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
