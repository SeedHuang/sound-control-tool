// server/src/media/ffmpeg-export.test.ts
// P4 T4：导出任务（spec D9/D15/D8）；2026-10-01 spec clip-works 增 D4/D19/D22。
// mock 手法仿 media-routes.test.ts——不真拉 ffmpeg：runClip / runFfmpegArgs 桩**真写产物文件**，
// 后面 ingest（rename + INSERT）走真实现，整条「导出 → 入库」链路都被测到，只有 ffmpeg 进程本身是假的。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { runClip, runFfmpegArgs } from '../ffmpeg/clip.js'; // H2 fail 守卫用例要对这个被 mock 的 fn 做 mockImplementationOnce;视频分支逐段/concat 也走 runFfmpegArgs 桩
import { addSseConnection, type SseConn } from '../ytdlp/job-events.js'; // N1 Task 3:视频 done 事件形状断言用(真实 SSE 桥,不 mock)
import { formatMergeTitle, startExportJob, type ExportJobPayload } from './ffmpeg-export.js';

// ffmpeg 路径桩：默认给桩路径；置 null 验证「拿不到 ffmpeg 不得静默」（spec D16/D10）
const ffmpegStub = vi.hoisted(() => ({ path: 'C:/stub/ffmpeg.exe' as string | null }));
vi.mock('./ffmpeg-path.js', () => ({ resolveFfmpegPath: vi.fn(async () => ffmpegStub.path) }));
// ffprobe 桩：时长固定 10 秒；probeVideoMeta(视频分支入库宽高来源,N1 Task 3)固定 3840×2160(素材实况 4K,见实测报告)
vi.mock('../ytdlp/ffprobe.js', () => ({
  probeDuration: vi.fn(async () => 10),
  probeVideoMeta: vi.fn(async () => ({ width: 3840, height: 2160 })),
}));
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
// S2(2026-10-02 deferred 批):clipHook.onClip 的清理收进 afterEach——设置 onClip 的用例若中途抛错,
// 原先写在用例尾部的行内 `clipHook.onClip = null` 会被跳过,钩子带着已 close 的上一份 db 泄漏进后续用例
// (runClip 桩每次写完产物都会回调它)。收进 afterEach 后任何失败路径都保证复位;各用例行内的手工清空一并删除。
afterEach(() => { clipHook.onClip = null; db.close(); rmSync(root, { recursive: true, force: true }); });

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
    const job = createJobsRepo(db).get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.message).toContain('作品已被删除');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0); // 没写出成品行
    expect(readdirSync(tempDir)).toHaveLength(0);            // 临时产物已清掉，没白占文件
  });

  // H2(2026-10-01 OCR 审查):导出任务被取消时被静默吞掉。机制:取消路由对导出 job 杀不了正在跑的 ffmpeg
  // (DownloadManager 里没登记),只做 jobsRepo.update(cancelled)+emit;ffmpeg 跑完后 startExportJob 照旧
  // 入库 + finish() → cancelled 被覆写成 done,用户不要的产物还进了库。以下用例用「runClip 桩跑完的瞬间
  // 做一次与取消路由同款的 DB 写入」模拟这个真实中间态,锁住「维持 cancelled + 丢弃产物」。
  it('H2:separate 导出中途被取消 → 维持 cancelled,产物丢弃,不得覆写成 done', async () => {
    const payload = basePayload({ segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    clipHook.onClip = () => { jobsRepo.update(jobId, { status: 'cancelled', message: '用户取消' }); }; // 第 1 段 ffmpeg 刚跑完就取消
    await startExportJob(jobId, payload, deps());
    const job = jobsRepo.get(jobId)!;
    expect(job.status).toBe('cancelled');                    // 不得被 finish() 覆写成 done
    expect(job.message).toBe('用户取消');                     // 取消原因必须留在记录里
    expect(createAudioItemsRepo(db).list()).toHaveLength(0); // 取消后的产物不得入库
    expect(readdirSync(tempDir)).toHaveLength(0);            // 临时产物已清掉
  });
  it('H2:merge 导出中途被取消 → 维持 cancelled,产物丢弃,不得覆写成 done', async () => {
    const payload = basePayload({ mode: 'merge', segments: [{ start_sec: 0, end_sec: 10 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    clipHook.onClip = () => { jobsRepo.update(jobId, { status: 'cancelled', message: '用户取消' }); };
    await startExportJob(jobId, payload, deps());
    const job = jobsRepo.get(jobId)!;
    expect(job.status).toBe('cancelled');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
    expect(readdirSync(tempDir)).toHaveLength(0);
  });
  // fail 路径同款守卫:取消落在 await 中途(真实时序:用户取消杀不了 ffmpeg),在跑的那段 ffmpeg 自己失败
  // → fail() 只留日志,不得把 cancelled 覆写成 error(否则记录里「取消」变「失败」,误导排障)。
  // 注:不能造「先取消再启动」的用例——startExportJob 入口先置 running,且经路由根本不存在该时序。
  it('H2:取消后在跑的段 ffmpeg 失败 → 维持 cancelled(fail 只留痕,不覆写)', async () => {
    const payload = basePayload({ segments: [{ start_sec: 0, end_sec: 10 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    // 覆写一次 runClip:先做与取消路由同款的 DB 写入(用户在 ffmpeg 跑的时候点了取消),再返回失败;
    // Once 实现消费一次后自动回落到模块级默认桩,不影响后续用例
    vi.mocked(runClip).mockImplementationOnce(async (o) => {
      jobsRepo.update(jobId, { status: 'cancelled', message: '用户取消' });
      try { rmSync(o.outPath, { force: true }); } catch { /* 尽力清理 */ }
      return { ok: false, stderr: 'seg-1 boom' };
    });
    await startExportJob(jobId, payload, deps());
    const job = jobsRepo.get(jobId)!;
    expect(job.status).toBe('cancelled');
    expect(job.message).toBe('用户取消');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
  });

  // 修复轮 1（2026-10-02 独立审查 Important）:separate 逐段 ingest——取消落在第 k 段时,前 k-1 段
  // 已成品入库且 cancelled 不可重试,这些段永久保留。行为取「保留 + 诚实」:不回滚,但 job message
  // 必须写明保留事实(任务抽屉轮询读 DB 能看到)。旧用例是 2 段、取消落在第 1 段(此刻 produced 为空),
  // 恰好绕开该行为——本用例按审查要求用 3 段、取消落在第 2 段跑完瞬间(第 1 段已入库)。
  it('修复轮1:separate 3 段取消落在第 2 段 → 前 1 段成品保留,message 写明保留段数', async () => {
    const payload = basePayload({ segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }, { start_sec: 40, end_sec: 50 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    let clipCount = 0;
    // 第 2 段 ffmpeg 刚跑完就取消(与取消路由同款 DB 写入:cancelled + message=用户取消)
    clipHook.onClip = () => { clipCount += 1; if (clipCount === 2) jobsRepo.update(jobId, { status: 'cancelled', message: '用户取消' }); };
    await startExportJob(jobId, payload, deps());
    const job = jobsRepo.get(jobId)!;
    expect(job.status).toBe('cancelled');                       // 终态维持 cancelled
    expect(job.message).toContain('已保留');                     // 保留事实必须可见
    expect(job.message).toContain('前 1 段');                    // 保留段数正确(仅第 1 段已入库)
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(1);                              // 第 2/3 段不得入库
    expect(items[0]!.title).toBe(formatClipTitle('凡人', 0, 10)); // 且入库的恰是第 1 段
    expect(existsSync(items[0]!.file_path)).toBe(true);         // 磁盘上第 1 段成品文件存在
    expect(readdirSync(tempDir)).toHaveLength(0);               // 第 2 段临时产物已清掉
  });
  // merge 模式没有逐段入库,取消时没有任何已入库产物 → message 维持「用户取消」,
  // 不得打出「已保留 0 段」这种没信息量的话(修复轮 1 审查明确要求)。
  it('修复轮1:merge 取消 → message 不含「已保留」', async () => {
    const payload = basePayload({ mode: 'merge', segments: [{ start_sec: 0, end_sec: 10 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    clipHook.onClip = () => { jobsRepo.update(jobId, { status: 'cancelled', message: '用户取消' }); };
    await startExportJob(jobId, payload, deps());
    const job = jobsRepo.get(jobId)!;
    expect(job.status).toBe('cancelled');
    expect(job.message).not.toContain('已保留');
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
  });
});

// ===== 2026-10-02 N1 Task 3:视频导出分支(spec video-export D2/D3,plan Task 3 行为规格)=====
// 桩复用同款「真写产物文件」:runFfmpegArgs 桩写 'EXPORTED-AUDIO' + clipHook 回调,ingest 走真实现,
// 视频分支整条「编码 → 探测 → cancelGuard → 入库」链路都被测到,只有 ffmpeg 进程本身是假的。
describe('视频导出(N1 Task 3)', () => {
  // kind=video 的 payload。format 语义是 mp4(kind=video 时实现固定按 mp4 处理,不读该值);
  // ExportJobPayload.format 类型尚未含 'mp4'(T4 路由层扩),单测直接构造 payload 绕过路由,此处断言换语义。
  const videoPayload = (over: Partial<ExportJobPayload> = {}): ExportJobPayload => ({
    ...basePayload(over),
    mediaKind: 'video',
    format: 'mp4' as unknown as ExportJobPayload['format'],
  });
  // 注册一个假 SSE 连接收集事件:走真实 emit 桥(job-events),不 mock 模块,done 事件形状连桥一起测
  const sseCollector = (sink: unknown[]): SseConn => ({
    write: (s) => { const m = /data: (.+)/.exec(s); if (m) sink.push(JSON.parse(m[1]!) as unknown); },
    end: () => {},
  });

  it('视频 separate 2 段 → 两行入库 media_kind=video、宽高来自 probe 桩、done emit kind=video', async () => {
    const payload = videoPayload({ segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    const events: unknown[] = [];
    addSseConnection(jobId, sseCollector(events));
    await startExportJob(jobId, payload, deps());
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.media_kind === 'video')).toBe(true);
    expect(items.every((i) => i.width === 3840 && i.height === 2160)).toBe(true); // probeVideoMeta 桩透传
    expect(items.every((i) => i.format === 'mp4')).toBe(true);                    // kind=video → format 固定 mp4
    expect(items.every((i) => existsSync(i.file_path) && i.file_path.startsWith(audioDir))).toBe(true);
    expect(jobsRepo.get(jobId)!.status).toBe('done');
    const done = events.find((e) => (e as { type?: string }).type === 'done') as { kind: string; audioId: number; count: number; format: string };
    expect(done).toBeDefined();
    expect(done.kind).toBe('video');                          // done 事件 kind 扩为 video
    expect(items.map((i) => i.id)).toContain(done.audioId);   // 字段名 audioId 保留 = 成品行 id
    expect(done.count).toBe(2);
    expect(done.format).toBe('mp4');
    expect(readdirSync(tempDir)).toHaveLength(0);             // 临时产物已 rename 走
  });

  it('视频 separate 取消落在第 2 段 → 第 1 段保留(media_kind=video)、status=cancelled、message 含「已保留」', async () => {
    const payload = videoPayload({ segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }] });
    const jobsRepo = createJobsRepo(db);
    const jobId = jobsRepo.create('ffmpeg_export', payload);
    let clipCount = 0;
    // 第 2 段编码跑完瞬间取消(与取消路由同款 DB 写入);此时第 1 段已入库 → kept=1 保留语义
    clipHook.onClip = () => { clipCount += 1; if (clipCount === 2) jobsRepo.update(jobId, { status: 'cancelled', message: '用户取消' }); };
    await startExportJob(jobId, payload, deps());
    const job = jobsRepo.get(jobId)!;
    expect(job.status).toBe('cancelled');                       // 终态维持 cancelled
    expect(job.message).toContain('已保留');                     // 保留事实可见
    expect(job.message).toContain('前 1 段');
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(1);
    expect(items[0]!.media_kind).toBe('video');
    expect(existsSync(items[0]!.file_path)).toBe(true);         // 磁盘上保留段成品存在
    expect(readdirSync(tempDir)).toHaveLength(0);               // 第 2 段临时产物已清
  });

  it('视频 merge 3 段 → concat 被调(args 含 -f concat 与 -safe 0)、最终产物 1 行、标题含 [共3段]、中间段与列表文件清理', async () => {
    vi.mocked(runFfmpegArgs).mockClear(); // vitest 无 clearMocks:mock.calls 跨用例累积,先清只清记录不动实现
    // F4(OCR 43c032a 复审):onClip 桩每次写完产物都会收到完整 opts(args 在内)——借它把 concat 调用
    // 时还**活着的列表文件**内容抓下来(跑完即被 finally 清理),验证条目形状:单引号包裹 + 正斜杠
    let concatListContent: string | null = null;
    clipHook.onClip = (o): void => {
      const opts = o as unknown as { args?: string[] };
      if (opts.args !== undefined && opts.args.includes('concat')) {
        concatListContent = readFileSync(opts.args[opts.args.indexOf('-i') + 1]!, 'utf8');
      }
    };
    const payload = videoPayload({ mode: 'merge', segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }, { start_sec: 40, end_sec: 50 }] });
    const jobId = await runJob(payload);
    const calls = vi.mocked(runFfmpegArgs).mock.calls;
    expect(calls.length).toBe(4); // 逐段编码 3 次 + concat 1 次(两阶段)
    for (let i = 0; i < 3; i++) {
      expect(calls[i]![0].args).toContain('libx264');   // 逐段视频编码(实测 A1-A4 参数族)
      expect(calls[i]![0].timeoutMs).toBe(3_600_000);   // 4K 编码超时(plan 实测定死,默认 120s 不够)
    }
    const concat = calls[3]![0].args;
    expect(concat).toContain('-f');
    expect(concat).toContain('concat');
    expect(concat).toContain('-safe');
    expect(concat).toContain('0');
    expect(calls[3]![0].timeoutMs).toBe(3_600_000); // F5:concat -c copy 同样 1h(整段体量读写,慢盘 120s 不够)
    expect(concat).toContain('-movflags');          // F2:最终成品(被预览服务的那份)moov 前移
    expect(concat).toContain('+faststart');
    // F4:列表条目 = file '正斜杠路径' × 3;单引号包裹、无反斜杠残留
    expect(concatListContent).not.toBeNull();
    expect(concatListContent!.split('\n').filter((l) => l.trim() !== '')).toHaveLength(3);
    expect(concatListContent!).toContain("file '");
    expect(concatListContent!).not.toContain('\\');
    const items = createAudioItemsRepo(db).list();
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(formatMergeTitle('凡人', 3)); // 标题含 [共3段]
    expect(items[0]!.media_kind).toBe('video');
    expect(items[0]!.width === 3840 && items[0]!.height === 2160).toBe(true);
    expect(createJobsRepo(db).get(jobId)!.status).toBe('done');
    expect(readdirSync(tempDir)).toHaveLength(0); // 中间段 + concat 列表文件全清,最终产物是 concat 输出那份
  });

  it('视频 merge 第 2 段编码失败 → fail、无入库、无残留临时段', async () => {
    vi.mocked(runFfmpegArgs).mockClear();
    // 两次 Once 排队:第 1 次调用(第 1 段)真写文件成功,第 2 次(第 2 段)返回失败;之后回落模块级默认桩
    vi.mocked(runFfmpegArgs).mockImplementationOnce(async (o) => { writeFileSync(o.outPath, 'SEG1'); return { ok: true, stderr: '' }; });
    vi.mocked(runFfmpegArgs).mockImplementationOnce(async () => ({ ok: false, stderr: 'seg-2 boom' }));
    const payload = videoPayload({ mode: 'merge', segments: [{ start_sec: 0, end_sec: 10 }, { start_sec: 20, end_sec: 30 }, { start_sec: 40, end_sec: 50 }] });
    const jobId = await runJob(payload);
    const job = createJobsRepo(db).get(jobId)!;
    expect(job.status).toBe('error');
    expect(job.message).toContain('导出第 2 段失败');
    expect(job.message).toContain('seg-2 boom'); // stderr 尾行诚实入账(仓库铁律:失败要能解释)
    expect(createAudioItemsRepo(db).list()).toHaveLength(0);
    expect(readdirSync(tempDir)).toHaveLength(0); // 第 1 段临时产物被清,无残留
  });
});
