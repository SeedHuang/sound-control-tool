// server/src/ytdlp/probe-formats.test.ts
// 可用清晰度探测(spec D6/D7):fixture 来自 2026-10-01 真实 yt-dlp 输出裁剪(见 task-1 报告)。
// 单视频 formats 在根上;合集条目在 entries[0].formats —— 两种形状各有一份真实 fixture。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProbeFormatsArgs, extractHeights, probeHeights, FALLBACK_TIERS } from './probe-formats.js';

// 用 import.meta.url 定位 fixture 目录(ESM 下比 __dirname 可靠;同 dev.ts 的写法)
const FIXTURE_DIR = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const fixture = (n: string): unknown => JSON.parse(readFileSync(join(FIXTURE_DIR, n), 'utf8'));

describe('extractHeights', () => {
  it('单视频:抽 height、去重(三编码同高合一)、降序、剔除 vcodec=none、剔除 <360(352 被丢)', () => {
    // 真实 fixture:352（vcodec≠none）应被 <360 丢掉;470/704/1056 各有 avc/hvc/av1 三份,去重后各留一个
    expect(extractHeights(fixture('formats-single.json'))).toEqual([1056, 704, 470]);
  });
  it('合集:从 entries[0] 抽(根上没有 formats)', () => {
    // 真实 fixture:360/480 各三份编码;去重降序 → [480,360]
    expect(extractHeights(fixture('formats-playlist-item.json'))).toEqual([480, 360]);
  });
  it('没有 formats → 空数组(交给调用方降级)', () => {
    expect(extractHeights({ title: 'x' })).toEqual([]);
  });
});

describe('buildProbeFormatsArgs', () => {
  it('单视频:含 -J、不含 --playlist-items', () => {
    const a = buildProbeFormatsArgs('https://a/v');
    expect(a).toContain('-J');
    expect(a).not.toContain('--playlist-items');
  });
  it('合集某集:含 --playlist-items <n>', () => {
    const a = buildProbeFormatsArgs('https://a/p', { entry: 3 });
    expect(a[a.indexOf('--playlist-items') + 1]).toBe('3');
  });
  it('带 cookie:--cookies 在 url 之前', () => {
    const a = buildProbeFormatsArgs('https://a/v', { cookiePath: 'C:/tmp/ck.txt' });
    expect(a.indexOf('--cookies')).toBeLessThan(a.indexOf('https://a/v'));
  });
});

describe('probeHeights', () => {
  it('doExec 成功 → 返回 heights', async () => {
    const out = JSON.stringify(fixture('formats-single.json'));
    const h = await probeHeights('yt-dlp', 'https://a/v', undefined,
      ((_b: string, _a: readonly string[], _o: unknown, cb: (e: Error | null, o: string, s: string) => void) => cb(null, out, '')) as never);
    expect(h).toEqual([1056, 704, 470]);
  });
  it('doExec 失败 → 抛错(由上层降级),错误信息含 stderr', async () => {
    await expect(probeHeights('yt-dlp', 'https://a/v', undefined,
      ((_b: string, _a: readonly string[], _o: unknown, cb: (e: Error | null, o: string, s: string) => void) => cb(Object.assign(new Error('boom'), { code: '1' }), '', 'ERROR: HTTP Error 412')) as never,
    )).rejects.toThrow(/412/);
  });
  it('FALLBACK_TIERS 是固定四档', () => {
    expect(FALLBACK_TIERS).toEqual([360, 480, 720, 1080]);
  });
});
