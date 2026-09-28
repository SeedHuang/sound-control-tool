// server/src/ytdlp/download.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { createDownloadManager, type DownloadEvent } from './download.js';

function fakeChild(over: Partial<ChildProcess> = {}): ChildProcess {
  return { pid: 1234, on: vi.fn(), kill: vi.fn(), ...over } as unknown as ChildProcess;
}
describe('DownloadManager', () => {
  it('start 后按进度行发 progress, 完成后发 status done(带 producedPath)', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
      findLatest: () => 'D:/tmp/abc123.mp3',
    });
    m.start({ jobId: 7, binPath: 'yt-dlp', args: ['-x'], outDir: 'D:/tmp', onEvent: (_, ev) => events.push(ev) });
    const onStdout = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'stdout')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onStdout('42.3%|123|456');
    onClose(0, null);
    expect(events.some((e) => e.type === 'progress' && e.percent === 42.3)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'status', state: 'done', producedPath: 'D:/tmp/abc123.mp3' });
  });
  it('非零退出发 status error + 错误映射', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
      findLatest: () => null,
    });
    m.start({ jobId: 1, binPath: 'yt-dlp', args: [], outDir: 'D:/tmp', onEvent: (_, ev) => events.push(ev) });
    const onErr = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'stderr')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onErr('ERROR: DRM protected');
    onClose(1, null);
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'error' });
  });
  it('cancel 走 taskkill /T /F', async () => {
    const tasks: Array<{ cmd: string; args: string[] }> = [];
    const child = fakeChild();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((cmd: string, args: string[], _o: unknown, cb: () => void) => { tasks.push({ cmd, args }); cb(); }) as never,
      findLatest: () => null,
    });
    m.start({ jobId: 2, binPath: 'yt-dlp', args: [], outDir: 'D:/tmp', onEvent: () => {} });
    await m.cancel(2);
    expect(tasks.at(-1)).toMatchObject({ cmd: 'taskkill', args: ['/pid', '1234', '/T', '/F'] });
  });
});
