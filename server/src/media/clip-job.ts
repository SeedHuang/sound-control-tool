// server/src/media/clip-job.ts
// 剪辑任务(2026-09-29 spec m1c-video-clip D6/D7/D8):从视频素材抽一段音频 → 走既有 ingest 入库为普通音频行。
// 两条触发路径共用:POST /api/media/:id/clip 与"重试剪辑任务"(ytdlp-routes 的 retry 分支经 clipStarter 进来)。
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createAudioItemsRepo } from '../db/repo/audio-items.js';
import { createJobsRepo } from '../db/repo/jobs.js';
import type { DB } from '../db/index.js';
import { runClip } from '../ffmpeg/clip.js';
import { pushLog } from '../logs.js';
import { emit } from '../ytdlp/job-events.js';
import { ingestDownloadedFile } from '../ytdlp/ingest.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export interface ClipJobPayload {
  importId: number; videoPath: string; start: number; end: number;
  format: 'mp3' | 'm4a' | 'wav'; quality?: string; title?: string; sourceUrl?: string;
}

/** 时间码:分:秒(秒补齐两位);用于标题自带时间段(spec D8) */
function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 剪辑产物标题 = 前缀 + 时间段。**由服务端强制拼** —— 前端传的 title 只作前缀(spec D8) */
export function formatClipTitle(prefix: string, start: number, end: number): string {
  return `${prefix} [${mmss(start)}-${mmss(end)}]`;
}

function ffprobePathFrom(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

export async function startClipJob(
  jobId: number, payload: ClipJobPayload, deps: { db: DB; audioDir: string; tempDir: string },
): Promise<void> {
  const jobsRepo = createJobsRepo(deps.db);
  jobsRepo.update(jobId, { status: 'running' });
  // 临时产物名唯一(spec D14):同族于 cookies.txt 被并发写坏那次——固定名字会被并发任务互相覆盖
  const tmpOut = join(deps.tempDir, `clip-${jobId}-${Date.now()}.${payload.format}`);
  const fail = (msg: string): void => {
    try { rmSync(tmpOut, { force: true }); } catch { /* 尽力清理:失败不留半成品 */ }
    jobsRepo.fail(jobId, msg);
    pushLog('error', 'clip', `job ${jobId} 失败: ${msg}`);
    emit(jobId, { type: 'status', state: 'error', message: msg });
  };
  try {
    if (!existsSync(payload.videoPath)) { fail('素材已不存在，请重新下载视频'); return; }
    // ffmpeg 路径拿不到 → 明确失败,不得静默(spec D16/D10:静默最坏——用户以为剪好了,库里什么都没有)
    const ffmpegPath = await resolveFfmpegPath(deps.db);
    if (ffmpegPath === null) { fail('ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径'); return; }
    emit(jobId, { type: 'phase', phase: 'ingest' });
    const r = await runClip({
      ffmpegPath, inputPath: payload.videoPath, outPath: tmpOut,
      start: payload.start, end: payload.end, format: payload.format, quality: payload.quality,
    });
    // 失败必须带 stderr 摘要(仓库铁律:永远不要只信 err.message;这里取 stderr 最后一行,截 200 字符)
    if (!r.ok) { fail(`剪辑失败：${r.stderr.trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(ffmpeg 无 stderr 输出)'}`); return; }
    // R8(spec §0.8 验收 4,2026-09-30):runClip 成功后、入库前查一次任务状态——用户在剪辑期间点了取消
    // → 丢掉产物:删临时文件、留一行日志、直接 return。不 finish 不 fail 不 emit(job 行保持 cancelled):
    // 否则"取消"后音频照样入库,库里多出一条用户明确不要的行,temp 里也留下本该清掉的半成品
    if (jobsRepo.get(jobId)?.status === 'cancelled') {
      try { rmSync(tmpOut, { force: true }); } catch { /* 尽力清理:与 fail 同款,清不动不阻断 */ }
      pushLog('info', 'clip', `job ${jobId} 剪辑完成但已被用户取消 → 丢弃产物,保持 cancelled`);
      return;
    }
    // 时长以 ffprobe 实测为准(spec §0.3:end 超素材长度时允许,但必须留痕)
    const ffprobePath = ffprobePathFrom(ffmpegPath);
    const realDuration = await probeDuration(ffprobePath, tmpOut);
    pushLog('info', 'clip', `job ${jobId} 请求区间 ${payload.start}-${payload.end}s,实测产出 ${realDuration ?? '?'}s`);
    const audioRepo = createAudioItemsRepo(deps.db);
    const finalTitle = formatClipTitle(payload.title ?? '剪辑音频', payload.start, payload.end);
    // 批4 裁定 R3:ingest 的 sourceUrl 是 string 非可空 → 空值归一为空串(不落 null 撞签名);
    // 记原视频地址 → 剪辑室的分组/封面/外链自动复用(spec D7);sourceUrl 未带/空串 → 空串
    const result = ingestDownloadedFile({
      tmpPath: tmpOut,
      title: finalTitle,
      format: payload.format, durationSec: realDuration,
      fileSize: statSync(tmpOut).size,
      sourceUrl: payload.sourceUrl !== undefined && payload.sourceUrl !== '' ? payload.sourceUrl : '',
      entryIndex: null, collectionTitle: null,
      // D8:剪辑产物记 'edit' 而非缺省 'download'——否则会混进首页「最近下载」(GET /api/home 的 recent 只排除 'edit'),
      // 直到下次启动 initSchema 的历史纠偏 SQL 才被改过来。导出路径(ffmpeg-export.ts)已接,这里补齐。
      sourceType: 'edit',
      audioDir: deps.audioDir, exists: existsSync, audioRepo,
    });
    jobsRepo.finish(jobId);
    pushLog('info', 'clip', `job ${jobId} done → audio ${result.audioId} @ ${result.finalPath}`);
    emit(jobId, { type: 'done', kind: 'audio', audioId: result.audioId, title: finalTitle, format: payload.format, filePath: result.finalPath, replaced: false });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
