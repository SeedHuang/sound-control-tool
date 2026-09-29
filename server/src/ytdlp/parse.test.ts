import { describe, expect, it } from 'vitest';
import { normalizeParse, parseMetadata, pickThumbnail } from './parse.js';
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
  it('封面地址两种形状都认:thumbnail 字符串优先,只有 thumbnails 数组时从后往前取', () => {
    expect(pickThumbnail({ thumbnail: 'http://a.jpg', thumbnails: [{ url: 'http://b.jpg' }] })).toBe('http://a.jpg');
    expect(pickThumbnail({ thumbnails: [{ url: 'http://lo.jpg' }, { url: 'http://hi.jpg' }] })).toBe('http://hi.jpg');
    expect(pickThumbnail({})).toBeUndefined();
    expect(pickThumbnail({ thumbnail: '' })).toBeUndefined(); // 空串不算
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
// 回归(2026-09-29):B 站 412 报错信息为空——execFile 回调第三参才是 stderr,旧实现只读 err.stderr(Node 不保证挂载,实测为空)
describe('parseMetadata stderr 捕获(execFile 回调第三参)', () => {
  it('第三参 stderr 参与映射:412 → RISK_CONTROL', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException, stdout: string, stderr: string) => void) => {
      cb(Object.assign(new Error('failed'), { code: '1' }) as NodeJS.ErrnoException, '', 'ERROR: HTTP Error 412: Precondition Failed');
    }) as never;
    await expect(parseMetadata('yt-dlp', 'u', 20000, doExec)).rejects.toMatchObject({ info: { code: 'RISK_CONTROL' } });
  });
  it('第三参缺省时 err.stderr 兜底', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException) => void) => {
      cb(Object.assign(new Error('failed'), { code: '1', stderr: 'HTTP Error 412: Precondition Failed' }) as NodeJS.ErrnoException);
    }) as never;
    await expect(parseMetadata('yt-dlp', 'u', 20000, doExec)).rejects.toMatchObject({ info: { code: 'RISK_CONTROL' } });
  });
});
