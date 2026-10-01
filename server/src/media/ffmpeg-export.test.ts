// server/src/media/ffmpeg-export.test.ts
// P4 T4：导出任务（spec D9/D15/D8）；2026-10-01 spec clip-works 增 D4/D19/D22。
// mock 手法仿 media-routes.test.ts——不真拉 ffmpeg：runClip / runFfmpegArgs 桩**真写产物文件**，
// 后面 ingest（rename + INSERT）走真实现，整条「导出 → 入库」链路都被测到，只有 ffmpeg 进程本身是假的。
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createClipProjectsRepo } from '../db/repo/clip-projects.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { formatClipTitle } from './clip-job.js';
import { formatMergeTitle, startExportJob, type ExportJobPayload } from './ffmpeg-export.js';

// ffmpeg 路径桩：默认给桩路径；置 null 验证「拿不到 ffmpeg 不得静默」（spec D16/D10）
const ffmpegStub = vi.hoisted(() => ({ path: 'C:/stub/ffmpeg.exe' as string | null }));
vi.mock('./ffmpeg-path.js', () => ({ resolveFfmpegPath: vi.fn(async () => ffmpegStub.path) }));
// ffprobe 桩：时长固定 10 秒
vi.mock('../ytdlp/ffprobe.js', () => ({ probeDuration: vi.fn(async () => 10) }));
// 剪辑调用钩子：D22 用例要在「ffmpeg 跑完、入库之前」把作品删掉，模拟导出途中作品被删。
const clipHook = vi.hoisted(() => ({ onClip: null as null | ((o: { outPath: string }) => void) }));
// runClip / runFfmpegArgs 桩：真写产物文件（后续 statSync/rename 走真实文件系统），返回 ok
vi.mock('../ffmpeg/clip.js', async () => {
  const { writeFileSync } = await import('node:fs');
  const write = (o: { outPath: string }) => { writeFileSync(o.outPath, 'EXPORTED-AUDIO'); clipHook.onClip?.(o); return { ok: true, stderr: '' }; };
  return { runClip: vi.fn(async (o: { outPath: string }) => write(o)), runFfmpegArgs: vi.fn(async (o: { outPath: string }) => write(o)) };
});

let root: string; let audioDir: string; let tempDir: string; let db: DB; let videoPath: string; let workId: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sct-vexp-'));
  audioDir = join(root, 'audio'); tempDir = join(root, 'tmp');
  mkdirSync(audioDir, { recursive: true }); mkdirSync(tempDir, { recursive: true });
  videoPath = join(root, 'v.mp4'); writeFileSync(videoPath, 'VIDEOBYTES');
  db = openDatabase(':memory:'); initSchema(db);
  ffmpegStub.path = 'C:/stub/ffmpeg.exe';
  // D22：入库前会校验作品存在，故每个用例都得先有一件作品（id=1）；payload 默认挂它
  workId = createClipProjectsRepo(db).create(1, '作品甲').id;
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const deps = () => ({ db, audioDir, tempDir });
const basePayload = (over: Partial<ExportJobPayload> = {}): ExportJobPayload => ({
  importId: 1, videoPath, mode: 'separate', format: 'mp3', prefix: '凡人', segments: [],
  projectId: workId, workName: '作品甲', ...over,
});
// 起一个 job 行（jobId 由 repo 自增）再跑 runner——与路由的"先 create 再 startExportJob"同序
const runJob = async (payload: ExportJobPayload): Promise<number> => {
  const jobId = createJobsRepo(db).create('ffmpeg_export', payload);
  await startExportJob(jobId, payload, deps());
  return jobId;
};

describe('startExportJob', () => {
  it('separate 2 段 → audio_items 两行，标题=formatClipTitle，source_type=edit，job done', async () => {
    const payload = basePayload({ segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] });
    const jobId = await runJob(payload);
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(2);
    const titles = items.map((i) => i.title).sort();
    expect(titles).toEqual([formatClipTitle('凡人', 0, 10), formatClipTitle('凡人', 20, 30)].sort());
    expect(items.every((i) => i.source_type === 'edit')).toBe(true); // D8
    // 2026-10-01 spec audio-lineage D3:导出产物带血缘(payload.importId=1)——改造前这里恒为 NULL,
    // 正是 dev 库那 8 条导出片段在剪辑室散成 8 张碎卡的根因
    expect(items.every((i) => i.source_import_id === 1)).toBe(true);
    // 2026-10-01 spec clip-works D4：成品挂作品（source_work_id = payload.projectId）
    expect(items.every((i) => i.source_work_id === workId)).toBe(true);
    expect(items.every((i) => i.duration_sec === 10)).toBe(true);    // ffprobe 实测（桩）
    expect(items.every((i) => existsSync(i.file_path) && i.file_path.startsWith(audioDir))).toBe(true);
    expect(createJobsRepo(db).get(jobId)!.status).toBe('done');
  });
  it('merge 2 段 → audio_items 一行，标题=formatMergeTitle，source_type=edit', async () => {
    const payload = basePayload({ mode: 'merge', segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] });
    const jobId = await runJob(payload);
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(formatMergeTitle('凡人', 2));
    expect(items[0]!.source_type).toBe('edit');
    expect(items[0]!.source_import_id).toBe(1);
    expect(items[0]!.source_work_id).toBe(workId);
    expect(createJobsRepo(db).get(jobId)!.status).toBe('done');
  });
  it('素材路径不存在 → job error（message 含「素材已不存在」），audio_items 无行', async () => {
    const payload = basePayload({ videoPath: join(root, 'nope.mp4'), segments: [{ start_sec: 0, end_sec: 10 }] });
    const jobId = await runJob(payload);
    const job = createJobsRepo(db).get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.message).toContain('素材已不存在');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
  });
  it('ffmpeg 解析不到 → job error（message 含 ffmpeg），audio_items 无行', async () => {
    ffmpegStub.path = null;
    const payload = basePayload({ segments: [{ start_sec: 0, end_sec: 10 }] });
    const jobId = await runJob(payload);
    const job = createJobsRepo(db).get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.message).toContain('ffmpeg');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
  });
  it('formatMergeTitle：前缀 [共N段]', () => {
    expect(formatMergeTitle('x', 3)).toBe('x [共3段]');
  });

  // Task 2（spec D1/D3/D11）：设置里配了导出目录 → 产物落该目录（不再固定落 audioDir）
  it('设置里配了导出目录 → 产物落该目录', async () => {
    const custom = join(root, 'my-exports');
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, custom);
    await runJob(basePayload({ segments: [{ start_sec: 0, end_sec: 10 }] }));
    const row = createAudioItemsRepo(db).list()[0]!;
    expect(dirname(row.file_path)).toBe(custom);
    expect(existsSync(row.file_path)).toBe(true);
    expect(row.source_type).toBe('edit');
  });

  // Task 2（spec §0.4 运行时自愈）：目录被手删 → 下次导出前 mkdirSync 重建，无需回设置页改
  it('导出目录被手删 → 运行时自愈重建', async () => {
    const custom = join(root, 'auto-heal');
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, custom);
    await runJob(basePayload({ segments: [{ start_sec: 0, end_sec: 10 }] }));
    expect(existsSync(custom)).toBe(true);
    rmSync(custom, { recursive: true, force: true });
    expect(existsSync(custom)).toBe(false);
    await runJob(basePayload({ segments: [{ start_sec: 0, end_sec: 10 }] }));
    expect(existsSync(custom)).toBe(true);
  });

  // D22：导出是异步长任务，用户可能中途删掉作品 → 入库前必须重查，否则写出指向已删作品的悬空成品行 + 白占文件
  it('D22：导出途中作品被删 → 丢弃产物(临时文件删掉),job error,无成品行', async () => {
    const doomed = createClipProjectsRepo(db).create(1, '待删作品').id;
    clipHook.onClip = () => { createClipProjectsRepo(db).delete(doomed); }; // 第一段 ffmpeg 刚跑完就删作品
    const jobId = await runJob(basePayload({ projectId: doomed, workName: '待删作品', segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] }));
    clipHook.onClip = null;
    const job = createJobsRepo(db).get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.message).toContain('作品已被删除');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0); // 没写出成品行
    expect(readdirSync(tempDir)).toHaveLength(0);            // 临时产物已清掉，没白占文件
  });
});
