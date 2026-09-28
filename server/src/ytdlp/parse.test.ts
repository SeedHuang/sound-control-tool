import { describe, expect, it } from 'vitest';
import { normalizeParse, parseMetadata } from './parse.js';
describe('normalizeParse', () => {
  it('单视频', () => {
    const r = normalizeParse({ title: '课 01', duration: 61.5, thumbnail: 'http://t' });
    expect(r.kind).toBe('single'); expect(r.title).toBe('课 01'); expect(r.durationSec).toBe(61.5);
    expect(r.entries).toBeUndefined();
  });
  it('合集 entries index 从 1 起', () => {
    const r = normalizeParse({ title: '合集', entries: [{ title: 'A' }, { title: 'B' }] });
    expect(r.kind).toBe('playlist');
    expect(r.entries).toEqual([{ index: 1, title: 'A' }, { index: 2, title: 'B' }]);
  });
});
describe('parseMetadata', () => {
  it('execFile 失败 → YtdlpRunError(info)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException) => void) => {
      cb(Object.assign(new Error('x'), { code: 'ENOENT' }) as NodeJS.ErrnoException);
    }) as never;
    await expect(parseMetadata('yt-dlp', 'u', 20000, doExec)).rejects.toMatchObject({ info: { code: 'YTDLP_NOT_FOUND' } });
  });
});
