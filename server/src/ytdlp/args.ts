// server/src/ytdlp/args.ts
export interface DownloadOptions {
  entryIndices?: number[];
  section?: { start: number; end: number };
  format: 'mp3' | 'm4a' | 'wav';
  quality?: string;
  // spec D10(2026-09-30):档位改为「按视频实测」,可能是 1440/2160 甚至 B 站那种 1056/704 的非规整值,
  // 故从窄联合 360|480|720|1080 放宽为整数;合法性(整数且 144..4320)由路由侧 validateVideoHeight 校验
  /** 视频素材的清晰度**上限档**(默认 480) */
  videoHeight?: number;
}
/**
 * 风控节流参数(spec D15/D18,2026-09-30 download-queue-tray)。
 * 只作用于**下载**任务(剪辑/导出是本地进程,不该被网络参数影响);并且只在用户显式设了值时才拼——
 * sleep=0/缺省、limit=''/缺省 → 一律不拼(= yt-dlp 默认「不限」,保持既有行为逐字不变)。
 */
export interface ThrottleOptions {
  /** 合集批量请求间隔(秒);> 0 才拼 --sleep-requests */
  sleepSeconds?: number;
  /** 下载限速(形如 '500K');非空才拼 --limit-rate */
  limitRate?: string;
}
/**
 * 把节流设置拼进 yt-dlp 参数(两个下载 build 函数共用,避免两处各写一遍)。
 * 0/空一律不拼 —— 这是回归保护:改造前没有节流参数,默认设置下必须与改造后逐字一致。
 */
function pushThrottle(args: string[], t?: ThrottleOptions): void {
  if (t?.sleepSeconds !== undefined && t.sleepSeconds > 0) args.push('--sleep-requests', String(t.sleepSeconds));
  if (t?.limitRate !== undefined && t.limitRate.trim() !== '') args.push('--limit-rate', t.limitRate.trim());
}
export function buildParseArgs(url: string, cookiePath?: string): string[] {
  const args: string[] = [];
  if (cookiePath) args.push('--cookies', cookiePath); // B 站 Cookie:非空时在 url 前注入(yt-dlp --cookies 要求 Netscape 文件)
  args.push('-J', '--flat-playlist', '--no-warnings', url);
  return args;
}
/**
 * 让 yt-dlp 自己去**写**封面文件(2026-09-29 实测后改用这条路)。
 * 为什么不用 Node 的 fetch 直接抓:Node 内置 fetch **不读 Windows 系统代理设置**,直连外网图床会被墙到大超时;
 * 而 yt-dlp(Python)会走系统代理 —— 同一张 i.ytimg.com 的图实测:Node fetch 10.7s 失败,yt-dlp 130ms 拿到。
 * --skip-download:只要图不要视频;--playlist-items 1:合集只取第 1 集(否则 193 集会写 193 张图)。
 */
export function buildWriteThumbnailArgs(url: string, outTemplate: string, cookiePath?: string): string[] {
  const args: string[] = [];
  if (cookiePath) args.push('--cookies', cookiePath);
  args.push('--skip-download', '--write-thumbnail', '--playlist-items', '1', '--no-warnings', '-o', outTemplate, url);
  return args;
}
export function buildDownloadArgs(opts: { url: string; options: DownloadOptions; outDir: string; cookiePath?: string; throttle?: ThrottleOptions }): string[] {
  const { url, options, outDir, cookiePath, throttle } = opts;
  const args: string[] = ['-x', '--newline', '--windows-filenames'];
  if (cookiePath) args.push('--cookies', cookiePath); // B 站 Cookie:同 parse,插在 url 之前
  args.push('--audio-format', options.format);
  if (options.quality) args.push('--audio-quality', options.quality);
  if (options.entryIndices && options.entryIndices.length > 0) {
    args.push('--playlist-items', options.entryIndices.join(','));
  } else {
    args.push('--no-playlist');
  }
  if (options.section) args.push('--download-sections', `*${options.section.start}-${options.section.end}`);
  // D6:结构化进度行 percent|downloaded|total
  args.push('--progress-template', '%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s');
  // 节流(spec D18/2026-09-30):只下载;放在 -o/url 收尾之前,与既有参数排布一致
  pushThrottle(args, throttle);
  args.push('-o', join(outDir, '%(id)s.%(ext)s'), url);
  return args;
}
/**
 * 下视频素材(带画面的时间标尺):**不是** -x,而是完整下视频 + 音轨。
 * 三个硬要求(spec D1/D2 + 待实测 D):
 * - `bv*+ba`:必须含音轨 —— 剪辑是从这个文件抽音频,只下视频流等于素材没法剪
 * - `--merge-output-format mp4`:Electron 是 Chromium,mkv 播不了
 * - 编解码偏好:只锁容器不够,B 站之外可能给 VP9/AV1 + Opus 装进 mp4 后"有画面没声音"
 *   (偏好名以 spec §0.1 实测 D 的结论为准;2026-09-30 实测:B 站加 -S vcodec:h264,acodec:aac 后落 h264+aac)
 */
export function buildVideoDownloadArgs(opts: {
  // spec D10:档位放宽为整数(实测值可能是 1440/2160/1056…);表达式一字不动,只放宽类型
  url: string; outDir: string; videoHeight: number; entryIndices?: number[]; cookiePath?: string; throttle?: ThrottleOptions;
}): string[] {
  const args: string[] = ['--newline', '--windows-filenames'];
  if (opts.cookiePath) args.push('--cookies', opts.cookiePath);
  args.push(
    '-f', `bv*[height<=${opts.videoHeight}]+ba/b[height<=${opts.videoHeight}]/b`,
    '-S', 'vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4',
  );
  // P2 方案A(2026-09-30):视频也支持只下合集里的一集——镜像音频侧 entryIndices → --playlist-items 的写法;
  // 不传保持 --no-playlist(单视频素材原形态不变)
  if (opts.entryIndices && opts.entryIndices.length > 0) {
    args.push('--playlist-items', opts.entryIndices.join(','));
  } else {
    args.push('--no-playlist');
  }
  args.push('--progress-template', '%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s');
  // 节流(spec D18/2026-09-30):视频下载同样受节流保护(与音频支同款,只下载)
  pushThrottle(args, opts.throttle);
  args.push('-o', join(opts.outDir, '%(id)s.%(ext)s'), opts.url);
  return args;
}
import { join } from 'node:path';
/** 探测可用清晰度(spec D6):`-J` 拿完整 JSON(非 flat —— flat 没有 formats);合集只探指定的那一集 */
export function buildProbeFormatsArgs(url: string, opts?: { entry?: number; cookiePath?: string }): string[] {
  const args: string[] = [];
  if (opts?.cookiePath) args.push('--cookies', opts.cookiePath); // B 站 Cookie:同 parse,插在 url 之前
  args.push('-J', '--no-warnings');
  if (opts?.entry !== undefined) args.push('--playlist-items', String(opts.entry));
  args.push(url);
  return args;
}
