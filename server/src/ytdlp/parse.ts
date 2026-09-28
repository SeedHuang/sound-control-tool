// server/src/ytdlp/parse.ts
import { execFile } from 'node:child_process';
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
export function parseMetadata(binPath: string, url: string, timeoutMs = 20_000, doExec: typeof execFile = execFile): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    doExec(binPath, buildParseArgs(url), { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        reject(new YtdlpRunError(mapYtdlpError({ code: e.code, stderr: e.stderr, binPath })));
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
// 纯归一化导出供单测
export function normalizeParse(raw: unknown): ParseResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(o.entries)
    ? (o.entries as Array<Record<string, unknown>>).map((e, i) => ({ index: i + 1, title: String(e.title ?? `条目 ${i + 1}`) }))
    : undefined;
  return {
    kind: entries ? 'playlist' : 'single',
    title: String(o.title ?? '未命名'),
    durationSec: typeof o.duration === 'number' ? o.duration : undefined,
    thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : undefined,
    entries,
  };
}
