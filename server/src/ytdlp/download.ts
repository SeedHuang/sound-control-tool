// server/src/ytdlp/download.ts
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mapYtdlpError } from './errors.js';
import { parseProgressLine } from './progress.js';

export type DownloadEvent =
  | { type: 'progress'; percent: number; downloadedBytes?: number; totalBytes?: number }
  | { type: 'status'; state: 'running' | 'done' | 'error' | 'cancelled'; message?: string; producedPath?: string };

export interface StartOpts {
  jobId: number; binPath: string; args: string[]; outDir: string;
  onEvent: (jobId: number, ev: DownloadEvent) => void;
}
export interface DownloadManager {
  start(opts: StartOpts): void;
  cancel(jobId: number): Promise<void>;
  dispose(): Promise<void>;
}
// 默认实现:outDir 下 mtime 最新的音频文件(无则 null)
export function findLatestAudioFile(dir: string): string | null {
  try {
    const audioExt = new Set(['.mp3', '.m4a', '.wav']);
    return (
      readdirSync(dir)
        .map((f) => ({ name: f, p: join(dir, f) }))
        .filter((f) => audioExt.has(f.name.slice(f.name.lastIndexOf('.'))))
        .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs)[0]?.p ?? null
    );
  } catch {
    return null;
  }
}
export function createDownloadManager(deps?: { spawn?: typeof spawn; execFile?: typeof execFile; findLatest?: (dir: string) => string | null }): DownloadManager {
  const doSpawn = deps?.spawn ?? spawn;
  const doExec = deps?.execFile ?? execFile;
  const findLatest = deps?.findLatest ?? findLatestAudioFile;
  const active = new Map<number, ChildProcess>();
  const activeOutDir = new Map<number, string>(); // P2-2:cancel 时清理该 job 的 outDir 半成品
  const cancelledJobs = new Set<number>(); // 取消标记:close 时据此发 cancelled 而非 error
  const cleanJobOutputs = (jobId: number, outDir: string): void => {
    // 删除该 job 刚产出的音频半成品(close 前 findLatest 能定位;cancel 场景下 mtime 最新即本 job 写的)
    const produced = findLatest(outDir);
    if (produced) { try { rmSync(produced, { force: true }); } catch { /* 尽力清理 */ } }
    activeOutDir.delete(jobId);
  };
  return {
    start: (opts) => {
      const { jobId, binPath, args, outDir, onEvent } = opts;
      // D7:detached + windowsHide;taskkill 杀整棵树
      const child = doSpawn(binPath, args, { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      active.set(jobId, child);
      activeOutDir.set(jobId, outDir);
      cancelledJobs.delete(jobId); // 清除可能残留的取消标记(jobId 复用防护)
      let stderrBuf = '';
      const onStdoutData = (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          const info = parseProgressLine(line);
          if (info) onEvent(jobId, { type: 'progress', ...info });
        }
      };
      const onStderrData = (chunk: Buffer) => { stderrBuf += chunk.toString(); };
      // 真实 spawn 的 child.stdout/stderr 是流;测试注入的假 child 无流时,退回 child.on('stdout'/'stderr') 约定
      if (child.stdout) child.stdout.on('data', onStdoutData);
      else child.on('stdout', onStdoutData);
      if (child.stderr) child.stderr.on('data', onStderrData);
      else child.on('stderr', onStderrData);
      child.on('error', (err) => {
        // spawn 失败(如 binPath 缺失):清掉 activeOutDir 作为"终态已发"标记,避免 close 再补发一条 error
        active.delete(jobId);
        activeOutDir.delete(jobId);
        onEvent(jobId, { type: 'status', state: 'error', message: mapYtdlpError({ code: (err as NodeJS.ErrnoException).code, binPath }).message });
      });
      child.on('close', (code) => {
        active.delete(jobId);
        const outDir = activeOutDir.get(jobId);
        if (cancelledJobs.has(jobId)) {
          // 取消:taskkill /F 后 close 必非零,发 cancelled 而非 error
          cancelledJobs.delete(jobId);
          activeOutDir.delete(jobId);
          onEvent(jobId, { type: 'status', state: 'cancelled', message: '用户取消' });
          return;
        }
        // error 处理器已清掉 activeOutDir → 终态 error 已发,跳过避免重复
        if (outDir === undefined) return;
        if (code === 0) {
          const produced = findLatest(outDir);
          activeOutDir.delete(jobId);
          onEvent(jobId, produced
            ? { type: 'status', state: 'done', producedPath: produced }
            : { type: 'status', state: 'error', message: '下载完成但未找到产物文件' });
        } else {
          cleanJobOutputs(jobId, outDir);
          onEvent(jobId, { type: 'status', state: 'error', message: mapYtdlpError({ stderr: stderrBuf, binPath }).message });
        }
      });
    },
    cancel: async (jobId) => {
      const child = active.get(jobId);
      const outDir = activeOutDir.get(jobId);
      // taskkill 杀进程树:yt-dlp 会拉起 ffmpeg,单杀父进程会残留
      if (child?.pid) {
        await new Promise<void>((resolve) => {
          doExec('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      }
      active.delete(jobId);
      if (outDir) {
        // 仅当 activeOutDir 还在(close 未发生、error 未发过)才标记 cancelled,
        // 避免 error 已发后再 cancel 产生第二个终态事件
        cancelledJobs.add(jobId);
        cleanJobOutputs(jobId, outDir); // P2-2:cancel 后清理该 job 的半成品文件
      }
    },
    dispose: async () => {
      const pids = [...active.values()].map((c) => c.pid).filter((p): p is number => typeof p === 'number');
      for (const pid of pids) {
        await new Promise<void>((resolve) => {
          doExec('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      }
      active.clear();
      activeOutDir.clear();
    },
  };
}
