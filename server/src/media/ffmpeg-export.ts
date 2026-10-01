// 导出任务(spec D9/D15/D8):separate 每段一条音频入库;merge concat 成一条。
// 与 clip-job.ts 同族:产物走 ingestDownloadedFile + sourceType='edit'(D8),标题由后端强制拼(前端传的 label/title 不作前缀)。
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import { runClip, runFfmpegArgs } from '../ffmpeg/clip.js';
import { buildMergeArgs } from '../ffmpeg/export-args.js';
import { pushLog } from '../logs.js';
import { resolveOutputDir } from '../output-dir.js';
import { emit } from '../ytdlp/job-events.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { ingestDownloadedFile } from '../ytdlp/ingest.js';
import { formatClipTitle } from './clip-job.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export interface ExportSegment { start_sec: number; end_sec: number; label?: string | null }
export interface ExportJobPayload {
  importId: number; videoPath: string; mode: 'separate' | 'merge';
  format: 'mp3' | 'm4a' | 'wav'; quality?: string; prefix: string; segments: ExportSegment[];
}
/** merge 的标题:前缀 [共N段](spec §0.3) */
export function formatMergeTitle(prefix: string, count: number): string { return `${prefix} [共${count}段]`; }
// 取 stderr 最后一行截 200 字符:ffmpeg 的报错常在末行,缺则显式标"无 stderr"(仓库铁律:退出码 0 ≠ 有产物,失败要能解释)
const tail = (s: string): string => s.trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(ffmpeg 无 stderr 输出)';
// 由 ffmpeg 路径推 ffprobe 路径(同 fpath 命名:ffmpeg(.exe) → ffprobe(.exe))
const ffprobePathFrom = (ffmpegPath: string): string => ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

export async function startExportJob(jobId: number, payload: ExportJobPayload, deps: { db: DB; audioDir: string; tempDir: string }): Promise<void> {
  const jobsRepo = createJobsRepo(deps.db);
  jobsRepo.update(jobId, { status: 'running' });
  // 失败收敛:置 error + 日志 + SSE 终态(一次写完,避免逐处漂移)——source 用 'job'(导出是 job 语义)
  const fail = (msg: string): void => { jobsRepo.fail(jobId, msg); pushLog('error', 'job', `export job ${jobId} 失败: ${msg}`); emit(jobId, { type: 'status', state: 'error', message: msg }); };
  try {
    // 素材绝对路径已不在 → 明确失败(不静默;retry 路径也据此拦,见 ytdlp-routes)
    if (!existsSync(payload.videoPath)) { fail('素材已不存在，请重新下载视频'); return; }
    if (payload.segments.length === 0) { fail('没有可导出的剪辑段'); return; }
    const ffmpegPath = await resolveFfmpegPath(deps.db);
    if (ffmpegPath === null) { fail('ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径'); return; }
    const ffprobePath = ffprobePathFrom(ffmpegPath);
    // 目标目录**每次运行时现读设置**（spec D1/D3/D11）：payload 是「重试用」的，
    // 用户改了目录再重试就该用新目录——把目录塞进 payload 会把旧目录钉死在任务里。
    const outputDir = resolveOutputDir(deps.db, deps.audioDir);
    try {
      mkdirSync(outputDir, { recursive: true }); // 运行时自愈：手删了文件夹不必回设置页改
    } catch (e) {
      fail(`导出目录不可用：${outputDir}（${e instanceof Error ? e.message : String(e)}）`);
      return;
    }
    pushLog('info', 'job', `export job ${jobId} 目标目录 ${outputDir}`);
    const audioRepo = createAudioItemsRepo(deps.db);
    // 统一的入库入口:sourceType='edit'(D8)——导出产物是「剪辑」而非「下载」
    const ingest = (tmp: string, title: string, durationSec: number | null): number => {
      const audioId = ingestDownloadedFile({
        tmpPath: tmp, title, format: payload.format, durationSec,
        fileSize: statSync(tmp).size, sourceUrl: '', entryIndex: null, collectionTitle: null,
        sourceType: 'edit',
        sourceImportId: payload.importId, // 2026-10-01 spec audio-lineage D3:导出产物同样记血缘(改造前恒为 NULL)
        audioDir: outputDir, exists: existsSync, audioRepo,
      }).audioId;
      pushLog('info', 'job', `export job ${jobId} 入库 audio=${audioId} source_import_id=${payload.importId}`);
      return audioId;
    };

    if (payload.mode === 'separate') {
      const produced: number[] = [];
      for (let i = 0; i < payload.segments.length; i++) {
        const seg = payload.segments[i]!;
        // 临时产物名唯一(spec D14 同族):固定名字会被并发任务互相覆盖
        const tmp = join(deps.tempDir, `export-${jobId}-${i}-${Date.now()}.${payload.format}`);
        const r = await runClip({ ffmpegPath, inputPath: payload.videoPath, outPath: tmp, start: seg.start_sec, end: seg.end_sec, format: payload.format, quality: payload.quality });
        if (!r.ok) { try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ } fail(`导出第 ${i + 1} 段失败：${tail(r.stderr)}`); return; }
        const title = formatClipTitle(payload.prefix, seg.start_sec, seg.end_sec); // 前端传的 label/title 不作前缀（后端强制拼）
        const dur = await probeDuration(ffprobePath, tmp);
        pushLog('info', 'job', `export job ${jobId} 第 ${i + 1}/${payload.segments.length} 段请求 ${seg.start_sec}-${seg.end_sec}s，实测 ${dur ?? '?'}s`);
        produced.push(ingest(tmp, title, dur));
        emit(jobId, { type: 'progress', percent: Math.round(((i + 1) / payload.segments.length) * 100) });
      }
      jobsRepo.finish(jobId);
      pushLog('info', 'job', `export job ${jobId} done mode=separate → ${produced.length} 条音频`);
      // C-2:emit 在 done 后断连,故只发一次终态,用 count 带出总段数(前端提示「已导出 N 段」)
      emit(jobId, { type: 'done', kind: 'audio', audioId: produced[0]!, title: `${payload.prefix}（共 ${produced.length} 段）`, format: payload.format, replaced: false, count: produced.length });
      return;
    }

    // merge
    const tmp = join(deps.tempDir, `export-${jobId}-merge-${Date.now()}.${payload.format}`);
    const args = buildMergeArgs({ inputPath: payload.videoPath, outPath: tmp, format: payload.format, quality: payload.quality, segments: payload.segments });
    const r = await runFfmpegArgs({ ffmpegPath, args, outPath: tmp });
    if (!r.ok) { try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ } fail(`合并导出失败：${tail(r.stderr)}`); return; }
    const title = formatMergeTitle(payload.prefix, payload.segments.length);
    const dur = await probeDuration(ffprobePath, tmp);
    const audioId = ingest(tmp, title, dur);
    jobsRepo.finish(jobId);
    pushLog('info', 'job', `export job ${jobId} done mode=merge → audio ${audioId} @ ${title}`);
    emit(jobId, { type: 'done', kind: 'audio', audioId, title, format: payload.format, replaced: false, count: 1 });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
