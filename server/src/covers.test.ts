// server/src/covers.test.ts(2026-09-29:作品封面抓取与落盘)
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coverMime, fetchAndStoreCover, findCoverFile, writeCoverViaYtdlp } from './covers.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sct-covers-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('covers 封面抓取与落盘', () => {
  it('成功:按 content-type 定扩展名落盘,findCoverFile / coverMime 都能认出', async () => {
    let seenInit: RequestInit | undefined;
    const doFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      seenInit = init;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg; charset=binary' } });
    });
    const ok = await fetchAndStoreCover({ url: 'https://i0.hdslb.com/x.jpg', coversDir: dir, importId: 7, doFetch });
    expect(ok).toBe(true);
    const file = findCoverFile(dir, 7);
    expect(file).toBe(join(dir, 'cover-7.jpg'));
    expect(existsSync(file!)).toBe(true);
    expect(coverMime(file!)).toBe('image/jpeg');
    // B 站图床防盗链:必须带 Referer 才下得到
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.referer).toContain('bilibili.com');
  });
  it('HTTP 非 2xx(如防盗链 403)→ false 且不落盘', async () => {
    const doFetch = vi.fn(async () => new Response('nope', { status: 403 }));
    expect(await fetchAndStoreCover({ url: 'https://i0.hdslb.com/x.jpg', coversDir: dir, importId: 8, doFetch })).toBe(false);
    expect(findCoverFile(dir, 8)).toBeNull();
  });
  it('网络异常 → false 且不抛(调用方是 fire-and-forget,不能把解析拖下水)', async () => {
    const doFetch = vi.fn(async () => { throw new Error('ENOTFOUND'); });
    expect(await fetchAndStoreCover({ url: 'https://x/y.jpg', coversDir: dir, importId: 9, doFetch })).toBe(false);
  });
  it('非 http(s) 地址直接拒绝,连请求都不发', async () => {
    const doFetch = vi.fn(async () => new Response(new Uint8Array([1])));
    expect(await fetchAndStoreCover({ url: 'file:///etc/passwd', coversDir: dir, importId: 10, doFetch })).toBe(false);
    expect(doFetch).not.toHaveBeenCalled();
  });
  it('响应体为空 → false(避免落一个 0 字节的破图)', async () => {
    const doFetch = vi.fn(async () => new Response(new Uint8Array([]), { headers: { 'content-type': 'image/png' } }));
    expect(await fetchAndStoreCover({ url: 'https://x/y.png', coversDir: dir, importId: 12, doFetch })).toBe(false);
    expect(findCoverFile(dir, 12)).toBeNull();
  });
  it('换图换格式:旧扩展名的图会被清掉,不出现"随机命中旧图"', async () => {
    writeFileSync(join(dir, 'cover-11.jpg'), 'old');
    const doFetch = vi.fn(async () => new Response(new Uint8Array([9]), { headers: { 'content-type': 'image/png' } }));
    expect(await fetchAndStoreCover({ url: 'https://x/y.png', coversDir: dir, importId: 11, doFetch })).toBe(true);
    expect(existsSync(join(dir, 'cover-11.jpg'))).toBe(false);
    expect(findCoverFile(dir, 11)).toBe(join(dir, 'cover-11.png'));
  });
  it('目录还不存在(一张都没抓过)→ findCoverFile 返回 null,不算错', () => {
    expect(findCoverFile(join(dir, 'nope'), 1)).toBeNull();
  });
});

// 2026-09-29:外网图床(Node fetch 不读系统代理,直连 i.ytimg.com 会 10s 超时)只能让 yt-dlp 自己写
describe('writeCoverViaYtdlp(让 yt-dlp 写封面)', () => {
  it('成功:用 --write-thumbnail + -o 模板;文件出现才算成功', async () => {
    let seenArgs: string[] = [];
    const doExec = ((_b: string, args: string[], _o: unknown, cb: (e: null, stdout: string, stderr: string) => void) => {
      seenArgs = args;
      writeFileSync(join(dir, 'cover-21.webp'), 'WEBPBYTES');
      cb(null, '[info] Writing video thumbnail 41 to: cover-21.webp', '');
    }) as never;
    expect(await writeCoverViaYtdlp({ binPath: 'yt-dlp', url: 'https://www.youtube.com/watch?v=x', coversDir: dir, importId: 21, doExec })).toBe(true);
    expect(seenArgs).toContain('--write-thumbnail');
    expect(seenArgs).toContain('--skip-download');
    expect(seenArgs[seenArgs.indexOf('-o') + 1]).toBe(join(dir, 'cover-21.%(ext)s'));
    expect(findCoverFile(dir, 21)).toBe(join(dir, 'cover-21.webp'));
  });
  it('yt-dlp 报错 → false(且不写文件)', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: NodeJS.ErrnoException, stdout: string, stderr: string) => void) => {
      cb(Object.assign(new Error('boom'), { code: '1' }) as NodeJS.ErrnoException, '', 'ERROR: HTTP Error 412');
    }) as never;
    expect(await writeCoverViaYtdlp({ binPath: 'yt-dlp', url: 'u', coversDir: dir, importId: 22, doExec })).toBe(false);
    expect(findCoverFile(dir, 22)).toBeNull();
  });
  it('退出码 0 但没写出文件(源站没缩略图)→ false,不误报成功', async () => {
    const doExec = ((_b: string, _a: string[], _o: unknown, cb: (e: null, stdout: string, stderr: string) => void) => {
      cb(null, '[info] x: has no thumbnail', '');
    }) as never;
    expect(await writeCoverViaYtdlp({ binPath: 'yt-dlp', url: 'u', coversDir: dir, importId: 23, doExec })).toBe(false);
  });
});
