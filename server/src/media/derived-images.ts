// 派生图（波形/胶片条，spec D6/D14/§0.3）：服务端 ffmpeg 生成固定尺寸 PNG → <数据目录>/derived/，
// 命中判定 = 文件存在且 size>0（零字节残留不算命中）；生成走「临时名 → rename」原子落盘。
import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db/index.js';
import { pushLog } from '../logs.js';
import { probeDuration } from '../ytdlp/ffprobe.js';
import { buildFilmstripArgs, buildWaveformArgs } from '../ffmpeg/derived-args.js';
import { resolveFfmpegPath } from './ffmpeg-path.js';

export type DerivedKind = 'wave' | 'film';
export type ExecLike = typeof execFile;

/**
 * 派生图目录 = <数据目录>/derived（与 media/、covers/ 同父目录）。单一来源：mediaDir=<数据>/media，
 * 父目录即数据目录 —— 路径拼法只此一处，别再各处各写一份。
 */
export function derivedDirFor(mediaDir: string): string {
  return join(dirname(mediaDir), 'derived');
}

/** 命中判定：存在且 size>0（D14：中断残留的零字节不算命中） */
export function cachedDerivedPath(derivedDir: string, kind: DerivedKind, importId: number): string | null {
  const p = join(derivedDir, `${kind}-${importId}.png`);
  try { return statSync(p).size > 0 ? p : null; } catch { return null; }
}

export type DerivedResult =
  | { ok: true; path: string; cached: boolean }
  | { ok: false; code: 'NO_FFMPEG' | 'FFMPEG_FAIL'; message: string };

const tail = (s: string | undefined): string => (s ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 200) || '(无 stderr 输出)';
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function ensureDerivedImage(o: {
  kind: DerivedKind; importId: number; videoPath: string;
  derivedDir: string; tempDir: string; db: DB;
  doExec?: ExecLike; probe?: typeof probeDuration; resolveFfmpeg?: (db: DB) => Promise<string | null>;
}): Promise<DerivedResult> {
  const dest = join(o.derivedDir, `${o.kind}-${o.importId}.png`);
  const hit = cachedDerivedPath(o.derivedDir, o.kind, o.importId);
  if (hit !== null) {
    pushLog('debug', 'media', `派生图命中缓存 kind=${o.kind} import=${o.importId}`);
    return { ok: true, path: hit, cached: true };
  }
  const resolve = o.resolveFfmpeg ?? resolveFfmpegPath;
  const ffmpegPath = await resolve(o.db);
  if (ffmpegPath === null) {
    // 与 clip-job 同款：拿不到 ffmpeg 必须明确失败，不得静默（spec D16）
    pushLog('error', 'media', `派生图失败：ffmpeg 未找到 kind=${o.kind} import=${o.importId}`);
    return { ok: false, code: 'NO_FFMPEG', message: 'ffmpeg 未找到或未配置：请到设置页配置 ffmpeg 路径' };
  }
  // 唯一临时名（同 clip-job 的 clip-<jobId>-<ts> 家族）：并发/重入不会互相写坏，前端也不会读到写了一半的图
  const tmp = join(o.tempDir, `${o.kind}-${o.importId}-${Date.now()}.png`);
  let args: string[];
  if (o.kind === 'wave') {
    args = buildWaveformArgs(o.videoPath, tmp);
  } else {
    const probe = o.probe ?? probeDuration;
    const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'); // 同 clip-job.ts 的 ffprobePathFrom 一行口径
    const durationSec = await probe(ffprobePath, o.videoPath);
    args = buildFilmstripArgs(o.videoPath, tmp, durationSec);
  }
  pushLog('info', 'media', `派生图生成开始 kind=${o.kind} import=${o.importId} bin=${ffmpegPath}`);
  const doExec = o.doExec ?? execFile;
  const run = await new Promise<{ ok: boolean; reason: string }>((resolveRun) => {
    doExec(ffmpegPath, args, { timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException;
        const t = tail(stderr);
        pushLog('error', 'media', `派生图 ffmpeg 失败 kind=${o.kind} import=${o.importId} code=${e.code ?? '?'} signal=${(e as { signal?: string }).signal ?? '-'} stderr=${t}`);
        resolveRun({ ok: false, reason: `ffmpeg 失败（${e.code ?? '?'}）：${t}` });
        return;
      }
      resolveRun({ ok: true, reason: '' });
    });
  });
  if (!run.ok) { try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ } return { ok: false, code: 'FFMPEG_FAIL', message: run.reason }; }
  // 退出码 0 ≠ 有产物（实测 G9）：必须再查文件存在且 size>0
  let size = 0;
  try { size = statSync(tmp).size; } catch { size = 0; }
  if (size <= 0) {
    pushLog('error', 'media', `派生图退出码 0 但无产物 kind=${o.kind} import=${o.importId} out=${tmp}`);
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    return { ok: false, code: 'FFMPEG_FAIL', message: 'ffmpeg 退出码 0 但未写出产物' };
  }
  try {
    mkdirSync(o.derivedDir, { recursive: true });
    renameSync(tmp, dest); // 同盘 rename 原子
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 尽力清理 */ }
    pushLog('error', 'media', `派生图落盘失败 kind=${o.kind} import=${o.importId}: ${msgOf(e)}`);
    return { ok: false, code: 'FFMPEG_FAIL', message: `派生图落盘失败：${msgOf(e)}` };
  }
  pushLog('info', 'media', `派生图生成完成 kind=${o.kind} import=${o.importId} path=${dest} bytes=${size}`);
  return { ok: true, path: dest, cached: false };
}

/** 素材一变（换集/换清晰度重下、删素材/删来源）→ 派生图作废（R3-2）。删失败只记日志，不阻断主流程。 */
export function invalidateDerived(derivedDir: string, importId: number): void {
  for (const kind of ['wave', 'film'] as const) {
    try { rmSync(join(derivedDir, `${kind}-${importId}.png`), { force: true }); }
    catch (e) { pushLog('info', 'media', `清派生图失败(忽略) kind=${kind} import=${importId}: ${msgOf(e)}`); }
  }
}
