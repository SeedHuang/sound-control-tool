import { describe, expect, it } from 'vitest';
import { runClip } from './clip.js';

const base = { ffmpegPath: 'ffmpeg', inputPath: 'v.mp4', outPath: 'o.mp3', start: 0, end: 10, format: 'mp3' as const };

describe('runClip', () => {
  it('成功:exit 0 且产物非空 → ok', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => cb(null, '', '')) as never;
    const r = await runClip({ ...base, doExec, fileSize: () => 1024 });
    expect(r.ok).toBe(true);
  });
  it('退出码 0 但没写出文件 → 失败,不误报(同 covers 的 writeCoverViaYtdlp 口径)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => cb(null, '', '')) as never;
    const r = await runClip({ ...base, doExec, fileSize: () => null });
    expect(r.ok).toBe(false);
  });
  it('产物 0 字节 → 失败', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => cb(null, '', '')) as never;
    expect((await runClip({ ...base, doExec, fileSize: () => 0 })).ok).toBe(false);
  });
  it('非零退出 → 失败且把 stderr 带回来(仓库铁律:不信 err.message 就够用)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException, so: string, se: string) => void) =>
      cb(Object.assign(new Error('boom'), { code: '1' }), '', 'Invalid data found when processing input')) as never;
    const r = await runClip({ ...base, doExec, fileSize: () => null });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain('Invalid data found');
  });
  it('把参数原样交给 ffmpeg(binPath 是第一个参数、含 -vn)', async () => {
    const seen: { bin?: string; args?: string[] } = {};
    const doExec = ((b: string, a: string[], _o: unknown, cb: (e: null, so: string, se: string) => void) => {
      seen.bin = b; seen.args = a; cb(null, '', '');
    }) as never;
    await runClip({ ...base, doExec, fileSize: () => 1 });
    expect(seen.bin).toBe('ffmpeg');
    expect(seen.args).toContain('-vn');
  });
});
