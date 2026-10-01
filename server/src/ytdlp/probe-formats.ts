// server/src/ytdlp/probe-formats.ts
// 探测"这个视频实际有哪些清晰度"(spec D6)。纯只读,不下任何字节。
// 与 parse.ts 同族:execFile 三参回调取 stderr(Node 不保证 err.stderr 挂载)、大 maxBuffer
// (踩过 11MB JSON 被 4MB 上限判死的坑——见 parse.ts 的 MAX_JSON_BUFFER 注释)。
import { execFile } from 'node:child_process';
import { buildProbeFormatsArgs } from './args.js';
// 计划 Step 2 的测试从本模块取 buildProbeFormatsArgs(虽然实现落在 args.ts) → 在此再导出,保证公共面一致
export { buildProbeFormatsArgs };

/** spec D7:探测失败时的固定兜底档位(UI 静默沿用) */
export const FALLBACK_TIERS = [360, 480, 720, 1080];

/**
 * 从 yt-dlp JSON 抽可用 height。**两种形状都认**(2026-10-01 真实实测确认):
 * - 单视频:`-J` 的输出 formats 在**根**上(实测 BV1quYm67E14:root.formats=true、无 entries);
 * - 合集某集:带 `--playlist-items` 时 formats 在 **entries[0]** 里(实测 B 站番剧:root.formats=false、entries[0].formats=true)。
 * 认两种形状是为了即使形状判断有误也只是走降级,不会崩(spec D7 的兜底思路)。
 */
export function extractHeights(raw: unknown): number[] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const withEntries = Array.isArray(o.entries) ? (o.entries[0] as Record<string, unknown> | undefined) : undefined;
  const formats = Array.isArray(o.formats) ? o.formats
    : Array.isArray(withEntries?.formats) ? withEntries!.formats
      : [];
  const heights = (formats as Array<Record<string, unknown>>)
    .filter((f) => f.vcodec != null && f.vcodec !== 'none')   // 纯音频格式没有画面,不算档位
    .map((f) => (typeof f.height === 'number' ? f.height : NaN))
    .filter((h) => Number.isFinite(h) && h >= 360)            // <360 的档位对素材没意义
    .map((h) => Math.round(h));
  return [...new Set(heights)].sort((a, b) => b - a);          // 去重 + 降序
}

/**
 * 跑一次 `yt-dlp -J` 拿可用清晰度。失败一律 reject(由上层降级成 FALLBACK_TIERS,绝不让下载不可用)。
 * doExec 可注入:单测不打真实外网;cookiePath 为空则不注入 --cookies(照常探测)。
 */
export function probeHeights(
  binPath: string, url: string, entry: number | undefined,
  doExec: typeof execFile = execFile, cookiePath?: string, timeoutMs = 15_000,
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    doExec(binPath, buildProbeFormatsArgs(url, { entry, cookiePath }), { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // 第三参 stderr 优先——旧实现只读 err.stderr(Node 不保证挂载,B 站 412 的信息会丢)。
        // 注意:不能用 `stderr ?? e.stderr`——execFile 失败回调里的 stderr 常是空串(''),而 `??`
        // 只判 null/undefined,空串会"命中"导致消息变空(如 15s 超时被杀、yt-dlp 无 stderr 输出时,
        // 日志只剩"原因="后半截空着,事后无从排障)。故先取 trim 后的非空串,全空才退到 e.message。
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        const msg = (stderr ?? '').trim() || e.stderr?.trim() || e.message;
        reject(new Error(msg.slice(0, 300)));
        return;
      }
      try {
        resolve(extractHeights(JSON.parse(stdout)));
      } catch {
        reject(new Error('yt-dlp 输出不是合法 JSON'));
      }
    });
  });
}
