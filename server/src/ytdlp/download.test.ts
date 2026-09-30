// server/src/ytdlp/download.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDownloadManager, findLatestByExt, MEDIA_EXTS_AUDIO, MEDIA_EXTS_VIDEO, type DownloadEvent } from './download.js';

function fakeChild(over: Partial<ChildProcess> = {}): ChildProcess {
  return { pid: 1234, on: vi.fn(), kill: vi.fn(), ...over } as unknown as ChildProcess;
}
// R1(批3):findLatest 依赖从 createDownloadManager 里移除,原 6 处 findLatest 桩改为"真实临时目录里写/不写带目标扩展名的真文件"——
// 意图不变(控制产物存在/不存在),手段从"注桩"换成"造真文件",顺带覆盖 findLatestByExt 的真实路径逻辑。
const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sct-dl-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe('DownloadManager', () => {
  it('start 后按进度行发 progress, 完成后发 status done(带 producedPath)', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const dir = makeTempDir();
    writeFileSync(join(dir, 'abc123.mp3'), 'x'); // 产物存在 → done 事件带它的真实路径
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
    });
    m.start({ jobId: 7, binPath: 'yt-dlp', args: ['-x'], outDir: dir, exts: MEDIA_EXTS_AUDIO, onEvent: (_, ev) => events.push(ev) });
    const onStdout = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'stdout')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onStdout('42.3%|123|456');
    onClose(0, null);
    expect(events.some((e) => e.type === 'progress' && e.percent === 42.3)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'status', state: 'done', producedPath: join(dir, 'abc123.mp3') });
  });
  it('非零退出发 status error + 错误映射', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const dir = makeTempDir(); // 不写产物文件 → 走"产物缺失"的错误路径
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
    });
    m.start({ jobId: 1, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_AUDIO, onEvent: (_, ev) => events.push(ev) });
    const onErr = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'stderr')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onErr('ERROR: DRM protected');
    onClose(1, null);
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'error' });
  });
  it('cancel 走 taskkill /T /F', async () => {
    const tasks: Array<{ cmd: string; args: string[] }> = [];
    const child = fakeChild();
    const dir = makeTempDir();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((cmd: string, args: string[], _o: unknown, cb: () => void) => { tasks.push({ cmd, args }); cb(); }) as never,
    });
    m.start({ jobId: 2, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_AUDIO, onEvent: () => {} });
    await m.cancel(2);
    expect(tasks.at(-1)).toMatchObject({ cmd: 'taskkill', args: ['/pid', '1234', '/T', '/F'] });
  });
  it('spawn 失败:error + close 只发一次终态 error', () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const dir = makeTempDir();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: (() => {}) as never,
    });
    m.start({ jobId: 3, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_AUDIO, onEvent: (_, ev) => events.push(ev) });
    const onErr = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'error')![1];
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    onErr(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    onClose(null, null); // spawn 失败后 Node 必发 close(code 为 null)
    const terminals = events.filter((e) => e.type === 'status');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: 'status', state: 'error' });
  });
  it('cancel 后 close 发 status cancelled 而非 error', async () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    const dir = makeTempDir();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((_cmd: string, _args: string[], _o: unknown, cb: () => void) => { cb(); }) as never,
    });
    m.start({ jobId: 4, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_AUDIO, onEvent: (_, ev) => events.push(ev) });
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    await m.cancel(4);
    onClose(1, null); // taskkill /F 后 close 以非零 code 触发
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'cancelled' });
    expect(events.filter((e) => e.type === 'status')).toHaveLength(1);
  });
  it('真实时序:cancel 未完成(taskkill 回调未决)时 close 先触发,仍只发一个 cancelled 终态', async () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    let resolveTaskkill: (() => void) | undefined;
    const dir = makeTempDir();
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((_cmd: string, _args: string[], _o: unknown, cb: () => void) => { resolveTaskkill = cb; }) as never,
    });
    m.start({ jobId: 5, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_AUDIO, onEvent: (_, ev) => events.push(ev) });
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    // 不 await cancel:把 taskkill 回调挂起到 deferred,模拟"被杀的 yt-dlp 子进程 close 先于 taskkill 回调"的真实事件顺序
    const cancelPromise = m.cancel(5);
    expect(resolveTaskkill).toBeDefined();
    onClose(1, null); // taskkill /F 杀掉后子进程以非零 code close
    resolveTaskkill!(); // 之后才放行 taskkill 回调
    await cancelPromise;
    const terminals = events.filter((e) => e.type === 'status');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ type: 'status', state: 'cancelled' });
  });
  it('真实取消时序(先 close 后 taskkill 回调) + .mp4 半成品 → cancel 后文件被删', async () => {
    const events: DownloadEvent[] = [];
    const child = fakeChild();
    let resolveTaskkill: (() => void) | undefined;
    const dir = makeTempDir();
    writeFileSync(join(dir, 'x.mp4'), 'HALF'); // cancel 前先落一个 .mp4 半成品
    const m = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((_cmd: string, _args: string[], _o: unknown, cb: () => void) => { resolveTaskkill = cb; }) as never,
    });
    m.start({ jobId: 6, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_VIDEO, onEvent: (_, ev) => events.push(ev) });
    const onClose = (child.on as ReturnType<typeof vi.fn>).mock.calls.find(([e]) => e === 'close')![1];
    // 不 await cancel:taskkill 回调挂起,模拟真实时序——被杀子进程的 close 先于 taskkill 回调触发
    const cancelPromise = m.cancel(6);
    expect(resolveTaskkill).toBeDefined();
    onClose(1, null); // close 先走 cancelled 分支(修复后应在此删掉半成品)
    resolveTaskkill!(); // 之后才放行 taskkill 回调
    await cancelPromise;
    expect(existsSync(join(dir, 'x.mp4'))).toBe(false); // cancel 收尾的 cleanJobOutputs 幂等,半成品已被删
    expect(events.filter((e) => e.type === 'status')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'status', state: 'cancelled' });
  });
});
describe('DownloadManager 按 job 传扩展名集合(spec D5)', () => {
  it('findLatestByExt:只认传入的扩展名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-dl-'));
    tempDirs.push(dir); // 断言失败也不留垃圾(afterEach 兜底)
    writeFileSync(join(dir, 'a.mp3'), 'x');
    writeFileSync(join(dir, 'b.mp4'), 'y');
    expect(findLatestByExt(dir, MEDIA_EXTS_VIDEO)?.endsWith('b.mp4')).toBe(true);
    expect(findLatestByExt(dir, MEDIA_EXTS_AUDIO)?.endsWith('a.mp3')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it('取消时按传入扩展名清掉 .mp4 半成品(不是只看音频扩展名)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sct-dl-'));
    tempDirs.push(dir); // 断言失败也不留垃圾(afterEach 兜底)
    const child = fakeChild();
    const dm = createDownloadManager({
      spawn: (() => child) as never,
      execFile: ((_b: string, _a: string[], _o: unknown, cb: () => void) => cb()) as never,
    });
    dm.start({ jobId: 1, binPath: 'yt-dlp', args: [], outDir: dir, exts: MEDIA_EXTS_VIDEO, onEvent: () => {} });
    writeFileSync(join(dir, 'x.mp4'), 'HALF');
    await dm.cancel(1);
    expect(existsSync(join(dir, 'x.mp4'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
