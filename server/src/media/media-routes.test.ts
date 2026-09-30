// server/src/media/media-routes.test.ts
// 媒体素材路由(批4 Task 10,spec m1c-video-clip §0.3):列表 / 视频流(Range) / 删素材 / 剪音频。
// clip 全链路按批4裁定 R2 的 mock 方案:不真拉 ffmpeg/ffprobe —— runClip 桩**真写产物文件**,
// 后面的 ingest(rename + INSERT)走真实现,整条「剪辑 → 入库」链路都被测到,只有 ffmpeg 进程本身是假的。
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createImportsRepo } from '../db/repo/imports.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSourceVideosRepo } from '../db/repo/source-videos.js';
import { getLogs } from '../logs.js';
import { formatClipTitle, registerMediaRoutes } from './media-routes.js';

// ffmpeg 路径桩:R2-d 返回桩路径;R2-e 置 null 验证「拿不到 ffmpeg 不得静默」(spec D16/D10)
const ffmpegStub = vi.hoisted(() => ({ path: 'C:/stub/ffmpeg.exe' as string | null }));
// R8 测试钩子:runClip 桩返回 ok 前的回调(用例往里塞"剪辑期间把 job 置 cancelled"的副作用;不用例保持 null)
const runClipHook = vi.hoisted(() => ({ beforeResolve: null as null | ((outPath: string) => void) }));
vi.mock('./ffmpeg-path.js', () => ({ resolveFfmpegPath: vi.fn(async () => ffmpegStub.path) }));
// runClip 桩:真写产物文件(后续 statSync/rename 走真实文件系统),返回 ok
vi.mock('../ffmpeg/clip.js', async () => {
  const { writeFileSync } = await import('node:fs');
  return {
    runClip: vi.fn(async (o: { outPath: string }) => {
      runClipHook.beforeResolve?.(o.outPath); // R8:让单测能在"runClip 成功返回"前注入取消
      writeFileSync(o.outPath, 'CLIPPED-AUDIO');
      return { ok: true, stderr: '' };
    }),
  };
});
// ffprobe 桩:时长固定 10 秒
vi.mock('../ytdlp/ffprobe.js', () => ({ probeDuration: vi.fn(async () => 10) }));

let app: FastifyInstance;
let db: DB;
let root: string;
let audioDir: string;
let mediaDir: string;
let tempDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-mr-'));
  audioDir = join(root, 'audio'); mediaDir = join(root, 'media'); tempDir = join(root, 'tmp');
  mkdirSync(audioDir, { recursive: true }); mkdirSync(mediaDir, { recursive: true }); mkdirSync(tempDir, { recursive: true });
  db = openDatabase(':memory:');
  initSchema(db);
  app = Fastify({ logger: false });
  registerMediaRoutes(app, { db, audioDir, tempDir, mediaDir, token: 'tok' });
});
afterEach(async () => {
  runClipHook.beforeResolve = null; // R8 钩子只在设置它的用例内生效,防泄漏进后续用例
  await app.close(); rmSync(root, { recursive: true, force: true });
});

describe('媒体素材路由', () => {
  it('GET /api/media 只列有素材的来源(带 url/title/site/height)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: '凡人', site: 'bilibili', kind: 'playlist', duration_sec: null, entries: null });
    createImportsRepo(db).upsertByUrl({ url: 'https://a/other', title: '无素材', site: 'other', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${importId}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId, filePath: join(mediaDir, `media-${importId}.mp4`), height: 480, fileSize: 1 });
    const res = await app.inject({ method: 'GET', url: '/api/media?token=tok' });
    const body = res.json() as { media: Array<{ import_id: number; url: string; height: number }> };
    expect(body.media).toHaveLength(1);
    expect(body.media[0]).toMatchObject({ import_id: importId, url: 'https://a/pl', height: 480 });
  });
  it('GET /api/media/:id/file:Range 206 与全量 200;非法 Range 416(R2-f);非正整数 404;文件丢了给 FILE_MISSING', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, '0123456789');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
    expect((await app.inject({ method: 'GET', url: '/api/media/0/file?token=tok' })).statusCode).toBe(404);
    const full = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    const part = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok`, headers: { range: 'bytes=2-5' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('2345');
    // R2-f:起点越界 → 416 + content-range bytes */<size>(206/200 之外的第三种 Range 形态,spec D11/D12)
    const r416 = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok`, headers: { range: 'bytes=999999-' } });
    expect(r416.statusCode).toBe(416);
    expect(r416.headers['content-range']).toBe('bytes */10');
    rmSync(p, { force: true });
    const gone = await app.inject({ method: 'GET', url: `/api/media/${importId}/file?token=tok` });
    expect(gone.statusCode).toBe(404);
    expect((gone.json() as { error: { code: string } }).error.code).toBe('FILE_MISSING');
  });
  it('DELETE /api/media/:id 只删素材行(来源行还在)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    writeFileSync(join(mediaDir, `media-${importId}.mp4`), 'V');
    createSourceVideosRepo(db).upsert({ importId, filePath: join(mediaDir, `media-${importId}.mp4`), height: 480, fileSize: 1 });
    expect((await app.inject({ method: 'DELETE', url: `/api/media/${importId}?token=tok` })).statusCode).toBe(200);
    expect(createSourceVideosRepo(db).get(importId)).toBeNull();
    expect(createImportsRepo(db).get(importId)).not.toBeNull();
  });
  it('POST /api/media/:id/clip 校验:起止非法 400 / 没素材 404 / 素材文件丢了 404 FILE_MISSING', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, 'V');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 1 });
    expect((await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 10, end: 5, format: 'mp3' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 0, end: 5, format: 'ogg' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/media/999/clip?token=tok`, payload: { start: 0, end: 5, format: 'mp3' } })).statusCode).toBe(404);
    // 素材行在但文件被外部删了 → 404 FILE_MISSING(spec §0.3:两种 404 文案不同)
    rmSync(p, { force: true });
    const gone = await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 0, end: 5, format: 'mp3' } });
    expect(gone.statusCode).toBe(404);
    expect((gone.json() as { error: { code: string } }).error.code).toBe('FILE_MISSING');
  });
  it('formatClipTitle:标题自带时间段(m:ss,补齐两位)', () => {
    expect(formatClipTitle('凡人修仙传 第 94 集', 90, 210)).toBe('凡人修仙传 第 94 集 [01:30-03:30]');
    expect(formatClipTitle('x', 5, 65)).toBe('x [00:05-01:05]');
  });
  // R2-d:clip 全链路(mock ffmpeg,不真拉)——POST 201 后任务应已 done,audio_items 真出现一行
  it('clip 全链路 → audio_items 一行:标题=前缀+服务端拼时间段、source_url=来源、文件在 audioDir(R2-d)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: '凡人修仙传 第 94 集', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, 'VIDEOBYTES');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
    const res = await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 90, end: 210, format: 'mp3', quality: '192k', title: '我的前缀' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    // POST 已不 await startClipJob(R7)→ 201 先回、异步剪辑随后完成;轮询等终态再断言
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(formatClipTitle('我的前缀', 90, 210)); // = '我的前缀 [01:30-03:30]'(后端拼的时间段)
    expect(items[0]!.source_url).toBe('https://a/pl'); // 记原视频地址 → 剪辑室分组/封面/外链自动复用(spec D7)
    expect(items[0]!.file_path.startsWith(audioDir)).toBe(true);
    expect(existsSync(items[0]!.file_path)).toBe(true);
    expect(items[0]!.duration_sec).toBe(10); // ffprobe 实测(桩)
    expect(items[0]!.format).toBe('mp3');
    expect(createJobsRepo(db).get(jobId)!.status).toBe('done');
  });
  it('clip payload.title 传空 → 前缀用来源标题拼(R2-d 补)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: '凡人修仙传 第 94 集', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, 'VIDEOBYTES');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
    const res = await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 0, end: 5, format: 'mp3', title: '' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'done') await new Promise((r) => setTimeout(r, 20));
    const items = createAudioItemsRepo(db).list();
    expect(items[0]!.title).toBe(formatClipTitle('凡人修仙传 第 94 集', 0, 5));
  });
  // R2-e:ffmpeg 解析不到 → 不得静默(spec D16/D10):POST 仍 201,但 job 必须置 error 且 message 含 ffmpeg
  it('resolveFfmpegPath null → POST 仍 201,但 job 置 error,message 含 ffmpeg(R2-e)', async () => {
    ffmpegStub.path = null;
    try {
      const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
      const p = join(mediaDir, `media-${importId}.mp4`);
      writeFileSync(p, 'VIDEOBYTES');
      createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
      const res = await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 0, end: 5, format: 'mp3' } });
      expect(res.statusCode).toBe(201);
      // POST 已不 await startClipJob(R7)→ 201 返回时 job 可能还在跑;照 R2-d 轮询等 error 终态再断言(I1)
      const jobId = res.json().jobId as number;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && createJobsRepo(db).get(jobId)!.status !== 'error') await new Promise((r) => setTimeout(r, 20));
      const job = createJobsRepo(db).get(jobId)!;
      expect(job.status).toBe('error');
      expect(job.message).toContain('ffmpeg');
    } finally {
      ffmpegStub.path = 'C:/stub/ffmpeg.exe';
    }
  });
  // R8(spec §0.8 验收 4,修复轮 1):剪辑期间用户点了取消 → runClip 成功也不入库。
  // 桩在返回 ok 前先把 job 置 cancelled,模拟"ffmpeg 跑完的瞬间任务已被取消";断言三件事:
  // audio_items 无行、job 行保持 cancelled(不 finish 不 fail 不 emit)、temp 里的临时产物被清掉(无残留)
  it('剪辑期间取消 → runClip 成功也丢弃产物:audio_items 无行、job 仍 cancelled、tmpOut 无残留(R8)', async () => {
    const importId = createImportsRepo(db).upsertByUrl({ url: 'https://a/pl', title: 't', site: 'bilibili', kind: 'single', duration_sec: null, entries: null });
    const p = join(mediaDir, `media-${importId}.mp4`);
    writeFileSync(p, 'VIDEOBYTES');
    createSourceVideosRepo(db).upsert({ importId, filePath: p, height: 480, fileSize: 10 });
    let tmpOutPath: string | undefined;
    runClipHook.beforeResolve = (outPath) => {
      tmpOutPath = outPath; // 临时产物路径(<tempDir>/clip-<jobId>-<ts>.mp3),稍后断言它被清掉
      const m = /clip-(\d+)-/.exec(outPath);
      if (m) createJobsRepo(db).update(Number(m[1]), { status: 'cancelled', message: '用户取消' }); // 模拟剪辑期间用户点取消
    };
    const res = await app.inject({ method: 'POST', url: `/api/media/${importId}/clip?token=tok`, payload: { start: 0, end: 5, format: 'mp3' } });
    expect(res.statusCode).toBe(201);
    const jobId = res.json().jobId as number;
    // job 已在桩里置 cancelled(状态不会再变),轮询等「丢弃产物」日志出现,确认取消分支真的跑完
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !getLogs().some((l) => l.source === 'clip' && l.message.includes(`job ${jobId}`) && l.message.includes('丢弃产物'))) await new Promise((r) => setTimeout(r, 20));
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
    expect(createJobsRepo(db).get(jobId)!.status).toBe('cancelled');
    expect(tmpOutPath).toBeDefined();
    expect(existsSync(tmpOutPath!)).toBe(false); // temp 无残留
  });
});
