// server/src/ytdlp/args.ts
export interface DownloadOptions {
  entryIndices?: number[];
  section?: { start: number; end: number };
  format: 'mp3' | 'm4a' | 'wav';
  quality?: string;
}
export function buildParseArgs(url: string): string[] {
  return ['-J', '--flat-playlist', '--no-warnings', url];
}
export function buildDownloadArgs(opts: { url: string; options: DownloadOptions; outDir: string }): string[] {
  const { url, options, outDir } = opts;
  const args: string[] = ['-x', '--newline', '--windows-filenames'];
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
import { join } from 'node:path';
