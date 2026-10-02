// server/src/ytdlp/ffprobe.ts
import { execFile } from 'node:child_process';
export function probeDuration(
  ffprobePath: string, filePath: string, timeoutMs = 10_000, doExec: typeof execFile = execFile,
): Promise<number | null> {
  return new Promise((resolve) => {
    doExec(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const j = JSON.parse(stdout) as { format?: { duration?: string } };
          const d = Number(j.format?.duration);
          resolve(Number.isFinite(d) && d >= 0 ? d : null);
        } catch { resolve(null); }
      },
    );
  });
}

/** 视频宽高(N1 Task 2,入库用):取第一条视频流。包装风格与 probeDuration 同款。
 * 探测失败 / 无视频流 / 超时 / 解析失败 → {width:null,height:null},**不抛错**(调用方按未知处理)。
 */
export function probeVideoMeta(
  ffprobePath: string, filePath: string, timeoutMs = 10_000, doExec: typeof execFile = execFile,
): Promise<{ width: number | null; height: number | null }> {
  const unknown = { width: null, height: null } as const;
  return new Promise((resolve) => {
    doExec(
      ffprobePath,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve({ ...unknown }); return; }
        try {
          const j = JSON.parse(stdout) as { streams?: { width?: number; height?: number }[] };
          const s = j.streams?.[0];
          const w = Number(s?.width);
          const h = Number(s?.height);
          resolve({
            width: Number.isFinite(w) && w > 0 ? w : null,
            height: Number.isFinite(h) && h > 0 ? h : null,
          });
        } catch { resolve({ ...unknown }); }
      },
    );
  });
}
