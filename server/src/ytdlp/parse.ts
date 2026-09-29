// server/src/ytdlp/parse.ts
import { execFile } from 'node:child_process';
import { pushLog } from '../logs.js';
import { buildParseArgs } from './args.js';
import { mapYtdlpError, type YtdlpErrorInfo } from './errors.js';

export interface ParseEntry { index: number; title: string }
export interface ParseResult {
  kind: 'single' | 'playlist'; title: string; durationSec?: number;
  thumbnail?: string; entries?: ParseEntry[];
}
export class YtdlpRunError extends Error {
  constructor(public info: YtdlpErrorInfo) { super(info.message); }
}
/**
 * 子进程 stdout 的缓冲上限。**2026-09-29 实测踩坑**:某 YouTube 视频 `-J` 的输出是 **11 MB**
 * (带 storyboard 分片图那类超长字段),当时的 4 MB 上限让 yt-dlp 被判成
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`——用户看到的就是"这个视频下不了"(其实解析这步就死了)。
 * 64 MB 对单视频/合集都够用;真超了会由 mapYtdlpError 给出人话提示,而不是那串包名。
 */
const MAX_JSON_BUFFER = 64 * 1024 * 1024;
export function parseMetadata(binPath: string, url: string, timeoutMs = 20_000, doExec: typeof execFile = execFile, cookiePath?: string): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    // 修复(2026-09-29):execFile 回调第三参才是 stderr——旧实现只读 err.stderr(Node 不保证挂载,实测为空,
    // B 站 412 的报错信息全丢)。第三参优先,err.stderr 兜底(测试桩可能只传两参)。
    doExec(binPath, buildParseArgs(url, cookiePath), { timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_JSON_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        reject(new YtdlpRunError(mapYtdlpError({ code: e.code, stderr: stderr ?? e.stderr, binPath })));
        return;
      }
      try {
        resolve(normalizeParse(JSON.parse(stdout)));
      } catch {
        reject(new YtdlpRunError({ code: 'PARSE_FAILED', message: 'yt-dlp 元数据解析失败', next: '重试；若反复失败，换用录制系统声音' }));
      }
    });
  });
}
/**
 * 封面地址归一化:yt-dlp 新版给 `thumbnails` 数组、老版/部分提取器给 `thumbnail` 字符串——两种都认。
 * 数组从后往前取(yt-dlp 的顺序通常由低清到高清,最后一张最清晰)。
 * 注:合集(播放列表)的 `-J --flat-playlist` 输出里**没有封面字段**(实测 B 站番剧),那种情况交给
 * covers.ts 的 yt-dlp 写图路径去解决,不在这里编地址。
 */
export function pickThumbnail(o: Record<string, unknown>): string | undefined {
  if (typeof o.thumbnail === 'string' && o.thumbnail.length > 0) return o.thumbnail;
  const arr = Array.isArray(o.thumbnails) ? (o.thumbnails as Array<Record<string, unknown>>) : [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    const u = arr[i]?.url;
    if (typeof u === 'string' && u.length > 0) return u;
  }
  return undefined;
}

/** 纯归一化导出供单测 */
export function normalizeParse(raw: unknown): ParseResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(o.entries)
    ? (o.entries as Array<Record<string, unknown>>).map((e, i) => ({ index: i + 1, title: String(e.title ?? `条目 ${i + 1}`) }))
    : undefined;
  return {
    kind: entries ? 'playlist' : 'single',
    title: String(o.title ?? '未命名'),
    durationSec: typeof o.duration === 'number' ? o.duration : undefined,
    thumbnail: pickThumbnail(o),
    entries,
  };
}

