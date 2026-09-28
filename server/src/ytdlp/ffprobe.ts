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
