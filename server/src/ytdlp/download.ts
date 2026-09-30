// server/src/ytdlp/download.ts
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mapYtdlpError } from './errors.js';
import { pushLog } from '../logs.js';
import { parseProgressLine } from './progress.js';

export type DownloadEvent =
  | { type: 'progress'; percent: number; downloadedBytes?: number; totalBytes?: number }
  | { type: 'status'; state: 'running' | 'done' | 'error' | 'cancelled'; message?: string; producedPath?: string };

export interface StartOpts {
  jobId: number; binPath: string; args: string[]; outDir: string;
  /** 本 job 的产物扩展名集合(音频/视频不同)——**必填**,逼调用方明确表态(spec D5) */
  exts: string[];
  onEvent: (jobId: number, ev: DownloadEvent) => void;
}
export interface DownloadManager {
  start(opts: StartOpts): void;
  cancel(jobId: number): Promise<void>;
  dispose(): Promise<void>;
}
// 产物扩展名集合按媒体类型分两组:完成定位/取消清理都按「本 job 声明的集合」找文件(spec D5)。
// 视频组多列 .webm/.mkv:实际产物由 --merge-output-format mp4 决定,多列两个防意外。
export const MEDIA_EXTS_AUDIO = ['.mp3', '.m4a', '.wav'];
export const MEDIA_EXTS_VIDEO = ['.mp4', '.webm', '.mkv'];

/** 目录里 mtime 最新的、扩展名在 exts 里的文件(无则 null) */
export function findLatestByExt(dir: string, exts: string[]): string | null {
  try {
    return (
      readdirSync(dir)
        .map((f) => ({ name: f, p: join(dir, f) }))
        .filter((f) => exts.includes(f.name.slice(f.name.lastIndexOf('.')).toLowerCase()))
        .sort((a, b) => statSync(b.p).mtimeMs - statSync(a.p).mtimeMs)[0]?.p ?? null
    );
  } catch {
    return null;
  }
}
export function createDownloadManager(deps?: { spawn?: typeof spawn; execFile?: typeof execFile }): DownloadManager {
  const doSpawn = deps?.spawn ?? spawn;
  const doExec = deps?.execFile ?? execFile;
  const active = new Map<number, ChildProcess>();
  const activeOutDir = new Map<number, string>(); // P2-2:cancel 时清理该 job 的 outDir 半成品
  const activeExts = new Map<number, string[]>(); // spec D5:exts 与 outDir 同生共死,定位/清理产物时按它过滤
  const cancelledJobs = new Set<number>(); // 取消标记:close 时据此发 cancelled 而非 error
  const cleanJobOutputs = (jobId: number, outDir: string): void => {
    // 删除该 job 刚产出的产物(按本 job 的 exts 集合定位;cancel 场景下 mtime 最新即本 job 写的)
    const exts = activeExts.get(jobId) ?? [];
    const produced = findLatestByExt(outDir, exts);
    if (produced) { try { rmSync(produced, { force: true }); } catch { /* 尽力清理 */ } }
    activeOutDir.delete(jobId);
    activeExts.delete(jobId);
  };
  return {
    start: (opts) => {
      const { jobId, binPath, args, outDir, exts, onEvent } = opts;
      // D7:detached + windowsHide;taskkill 杀整棵树
      const child = doSpawn(binPath, args, { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      active.set(jobId, child);
      activeOutDir.set(jobId, outDir);
      activeExts.set(jobId, exts);
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
        // spawn 失败(如 binPath 缺失):清掉 activeOutDir/activeExts 作为"终态已发"标记,避免 close 再补发一条 error
        active.delete(jobId);
        activeOutDir.delete(jobId);
        activeExts.delete(jobId);
        const info = mapYtdlpError({ code: (err as NodeJS.ErrnoException).code, binPath });
        pushLog('error', 'job', `job ${jobId} spawn 失败 code=${(err as NodeJS.ErrnoException).code ?? '?'} message=${err.message.slice(0, 200)}`);
        onEvent(jobId, { type: 'status', state: 'error', message: info.message });
      });
      child.on('close', (code) => {
        active.delete(jobId);
        const outDir = activeOutDir.get(jobId);
        if (cancelledJobs.has(jobId)) {
          // 取消:taskkill /F 后 close 必非零,发 cancelled 而非 error
          cancelledJobs.delete(jobId);
          // 修复(批3审查 round1):被杀子进程的 close 几乎必然先于 taskkill 回调触发,
          // 半成品必须在这里删(cleanJobOutputs 先读 exts 再删 Map+文件),
          // 否则 cancel 随后的 cleanJobOutputs 拿到 exts=[] 永远找不到文件,P2-2 被主流时序架空。
          if (outDir !== undefined) cleanJobOutputs(jobId, outDir);
          onEvent(jobId, { type: 'status', state: 'cancelled', message: '用户取消' });
          return;
        }
        // error 处理器已清掉 activeOutDir → 终态 error 已发,跳过避免重复
        if (outDir === undefined) return;
        if (code === 0) {
          const produced = findLatestByExt(outDir, activeExts.get(jobId) ?? []);
          activeOutDir.delete(jobId);
          activeExts.delete(jobId);
          onEvent(jobId, produced
            ? { type: 'status', state: 'done', producedPath: produced }
            : { type: 'status', state: 'error', message: '下载完成但未找到产物文件' });
        } else {
          // 双保险:taskkill 回调未决时 close 也可能先进 error 分支(通常已被上方 cancelled 分支拦截)
          if (cancelledJobs.has(jobId)) {
            cancelledJobs.delete(jobId);
            cleanJobOutputs(jobId, outDir); // 同上:半成品在这里先删(此时 outDir 必非空,已在上方检查过)
            onEvent(jobId, { type: 'status', state: 'cancelled', message: '用户取消' });
            return;
          }
          cleanJobOutputs(jobId, outDir);
          const info = mapYtdlpError({ stderr: stderrBuf, binPath });
          // 诊断日志(铁律:stderr 永远记下来):发给前端的是 map 后的中文消息,原始 stderr 必须留在日志里。
          // 2026-09-29 踩过:一个 YouTube 下载失败只留下"网络请求失败或资源不可达",原始报错没记 → 事后无从定位。
          pushLog('error', 'job', `job ${jobId} error code=${info.code} exit=${code} stderr=${stderrBuf.trim().slice(0, 300) || '(空)'}`);
          onEvent(jobId, { type: 'status', state: 'error', message: info.message });
        }
      });
    },
    cancel: async (jobId) => {
      const child = active.get(jobId);
      const outDir = activeOutDir.get(jobId);
      // 标记前移(同步):taskkill 是异步的,被杀子进程的 close 几乎必然先于 taskkill 回调触发,
      // 必须先打标记,否则 close 落入 code!==0 分支会误发 error
      if (outDir !== undefined) {
        // 仅当 activeOutDir 还在(close 未发生、error 未发过)才标记 cancelled,
        // 避免 error 已发后再 cancel 产生第二个终态事件
        cancelledJobs.add(jobId);
      }
      // taskkill 杀进程树:yt-dlp 会拉起 ffmpeg,单杀父进程会残留
      if (child?.pid) {
        await new Promise<void>((resolve) => {
          doExec('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      }
      active.delete(jobId);
      if (outDir !== undefined) {
        cleanJobOutputs(jobId, outDir); // P2-2:cancel 后清理该 job 的半成品文件(按本 job 的 exts 集合)
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
      activeExts.clear();
    },
  };
}
