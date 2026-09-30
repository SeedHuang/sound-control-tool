import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { pushLog } from '../logs.js';
import { buildClipArgs, type ClipArgsOpts } from './clip-args.js';

export type ExecLike = typeof execFile;

export interface RunClipOpts extends ClipArgsOpts {
  ffmpegPath: string;
  timeoutMs?: number;
  doExec?: ExecLike;
  /** 成功判定用;单测注入桩,避免为造"文件存在"真写磁盘 */
  fileSize?: (p: string) => number | null;
}

/**
 * 跑一次抽音轨。
 * 成功判定以"目标文件真出现且体积 > 0"为准 —— **不信退出码**
 * (同 covers.ts 的 writeCoverViaYtdlp:那边踩过"退出码 0 但没写出文件")。
 * 失败必须带 stderr(仓库铁律:永远不信 err.message 就够用 -> execFile 三参回调)。
 * 日志 source 用 'media'(logs.ts 批4 起已有 'clip';runClip 本身不带 job 上下文,失败详情由 clip-job.ts 以 'clip' 记账,这里保持 'media')。
 */
export function runClip(o: RunClipOpts): Promise<{ ok: boolean; stderr: string }> {
  const doExec = o.doExec ?? execFile;
  const sizeOf = o.fileSize ?? ((p: string) => {
    try { return statSync(p).size; } catch { return null; }
  });
  return new Promise((resolve) => {
    doExec(o.ffmpegPath, buildClipArgs(o), {
      timeout: o.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      const out = stderr ?? '';
      if (err) {
        const e = err as NodeJS.ErrnoException;
        // signal(批4 Minor 补):超时被杀时 err.signal=SIGTERM,只有 code 看不出"是超时还是真失败";缺则占位 -
        pushLog('error', 'media', `ffmpeg 失败 code=${e.code ?? '?'} signal=${(e as { signal?: string }).signal ?? '-'} stderr=${out.trim().slice(0, 300) || '(空)'}`);
        resolve({ ok: false, stderr: out });
        return;
      }
      const size = sizeOf(o.outPath);
      if (size === null || size <= 0) {
        pushLog('error', 'media', `ffmpeg 退出码 0 但没写出产物 out=${o.outPath} stderr=${out.trim().slice(0, 300) || '(空)'}`);
        resolve({ ok: false, stderr: out });
        return;
      }
      resolve({ ok: true, stderr: out });
    });
  });
}
