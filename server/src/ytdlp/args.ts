// server/src/ytdlp/args.ts
export interface DownloadOptions {
  entryIndices?: number[];
  section?: { start: number; end: number };
  format: 'mp3' | 'm4a' | 'wav';
  quality?: string;
  /** 视频素材的清晰度**上限档**(spec 待实测 A 定表达式;默认 480) */
  videoHeight?: 360 | 480 | 720 | 1080;
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
export function buildDownloadArgs(opts: { url: string; options: DownloadOptions; outDir: string; cookiePath?: string }): string[] {
  const { url, options, outDir, cookiePath } = opts;
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
  url: string; outDir: string; videoHeight: 360 | 480 | 720 | 1080; cookiePath?: string;
}): string[] {
  const args: string[] = ['--newline', '--windows-filenames'];
  if (opts.cookiePath) args.push('--cookies', opts.cookiePath);
  args.push(
    '-f', `bv*[height<=${opts.videoHeight}]+ba/b[height<=${opts.videoHeight}]/b`,
    '-S', 'vcodec:h264,acodec:aac',
    '--merge-output-format', 'mp4',
    '--no-playlist',
  );
  args.push('--progress-template', '%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s');
  args.push('-o', join(opts.outDir, '%(id)s.%(ext)s'), opts.url);
  return args;
}
import { join } from 'node:path';
