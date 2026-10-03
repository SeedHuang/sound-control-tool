// F11(2026-10-04):正在跑的 ffmpeg 导出子进程登记表(jobId → ChildProcess)。
// 取消路由靠它杀掉正在编码的 ffmpeg——导出的 ffmpeg 不走 DownloadManager(那里只登记 yt-dlp 子进程),
// 不登记就只剩 cancelGuard 的事后收敛:跑完当前段才丢产物,CPU 白烧(4K 段可达数分钟)。
// 与 download.ts 的 active Map + taskkill /T /F 同款:yt-dlp 会拉起 ffmpeg,单杀父进程会残留。
import { execFile, type ChildProcess } from 'node:child_process';
import { pushLog } from '../logs.js';

const active = new Map<number, ChildProcess>();

export function registerExportProcess(jobId: number, child: ChildProcess): void {
  active.set(jobId, child);
}

/** 注销:只删自己登记的那个进程(separate 逐段会先后起多个 ffmpeg,防止旧进程的 finally 误删新进程的登记) */
export function unregisterExportProcess(jobId: number, child: ChildProcess): void {
  if (active.get(jobId) === child) active.delete(jobId);
}

/** 杀该 job 正在跑的 ffmpeg 进程树;返回是否真的发起了杀(未登记/无 pid → false)。taskkill 失败只留痕、不抛。 */
export async function killExportProcess(jobId: number): Promise<boolean> {
  const child = active.get(jobId);
  if (child?.pid === undefined) return false;
  const pid = child.pid;
  pushLog('info', 'job', `取消导出 job=${jobId} → taskkill ffmpeg pid=${pid}`);
  await new Promise<void>((resolve) => {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
      // 铁律:失败路径必须留痕(否则排障时看不出杀没杀动)
      if (err) pushLog('info', 'job', `taskkill ffmpeg pid=${pid} 失败: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
      resolve();
    });
  });
  unregisterExportProcess(jobId, child); // 身份匹配注销(不裸删):await 期间若换了新进程,不得误删
  return true;
}
