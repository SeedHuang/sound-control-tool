// server/src/media/clip-job.test.ts
// 回归(spec D8 漏网,2026-09-30):剪辑路径(POST /api/media/:id/clip 走的 startClipJob)的产物必须落 source_type='edit'。
// 上一轮只把导出路径(ffmpeg-export.ts)接上了 sourceType,剪辑路径没接 —— 剪辑产物在库里仍记 'download',
// 会混进首页「最近下载」(GET /api/home 的 recent 只排除 'edit'),直到下次启动 initSchema 的历史纠偏 SQL 才改过来。
// mock 手法仿 ffmpeg-export.test.ts:不真拉 ffmpeg —— runClip 桩真写产物文件,后面 ingest(rename + INSERT)走真实现。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { startClipJob, type ClipJobPayload } from './clip-job.js';

// ffmpeg 路径桩：默认给桩路径（拿不到 ffmpeg 的分支已被 media-routes.test.ts 覆盖，这里只需成功路径）
const ffmpegStub = vi.hoisted(() => ({ path: 'C:/stub/ffmpeg.exe' as string | null }));
vi.mock('./ffmpeg-path.js', () => ({ resolveFfmpegPath: vi.fn(async () => ffmpegStub.path) }));
// ffprobe 桩：时长固定 10 秒
vi.mock('../ytdlp/ffprobe.js', () => ({ probeDuration: vi.fn(async () => 10) }));
// runClip 桩：真写产物文件（后续 statSync/rename 走真实文件系统），返回 ok
vi.mock('../ffmpeg/clip.js', async () => {
  const { writeFileSync } = await import('node:fs');
  return {
    runClip: vi.fn(async (o: { outPath: string }) => { writeFileSync(o.outPath, 'CLIPPED-AUDIO'); return { ok: true, stderr: '' }; }),
  };
});

let root: string; let audioDir: string; let tempDir: string; let db: DB; let videoPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-clip-'));
  audioDir = join(root, 'audio'); tempDir = join(root, 'tmp');
  mkdirSync(audioDir, { recursive: true }); mkdirSync(tempDir, { recursive: true });
  videoPath = join(root, 'v.mp4'); writeFileSync(videoPath, 'VIDEOBYTES');
  db = openDatabase(':memory:'); initSchema(db);
  ffmpegStub.path = 'C:/stub/ffmpeg.exe';
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const basePayload = (over: Partial<ClipJobPayload> = {}): ClipJobPayload => ({
  importId: 1, videoPath, start: 0, end: 10, format: 'mp3', title: '凡人', sourceUrl: 'https://a/pl', ...over,
});

describe('startClipJob', () => {
  // 起一个 job 行（jobId 由 repo 自增）再跑 runner —— 与路由的"先 create 再 startClipJob"同序
  it('剪辑产物入库 → source_type=edit(D8 回归),文件落 audioDir,job done', async () => {
    const payload = basePayload();
    const jobId = createJobsRepo(db).create('clip', payload);
    await startClipJob(jobId, payload, { db, audioDir, tempDir });
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(1);
    // D8:剪辑是真"剪辑"不是"下载" —— 缺这行断言时,产物 source_type 会落成 'download',首页「最近下载」会误列
    expect(items[0]!.source_type).toBe('edit');
    expect(items[0]!.source_url).toBe('https://a/pl');
    expect(items[0]!.file_path.startsWith(audioDir)).toBe(true);
    expect(existsSync(items[0]!.file_path)).toBe(true);
    expect(createJobsRepo(db).get(jobId)!.status).toBe('done');
  });
});
