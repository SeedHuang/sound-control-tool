// F11(2026-10-04):导出 ffmpeg 子进程登记表单测——mock node:child_process.execFile,
// 断言 killExportProcess 按 jobId 找到进程并 taskkill /T /F(不真起进程、不真杀)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null)),
}));
import { execFile } from 'node:child_process';
import { killExportProcess, registerExportProcess, unregisterExportProcess } from './export-processes.js';

const child = (pid?: number): ChildProcess => ({ pid } as ChildProcess);

beforeEach(() => { vi.mocked(execFile).mockClear(); });

describe('export-processes(F11 取消导出杀 ffmpeg)', () => {
  it('登记后 kill → taskkill 杀进程树,返回 true', async () => {
    registerExportProcess(7, child(1234));
    expect(await killExportProcess(7)).toBe(true);
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/T', '/F'], { windowsHide: true }, expect.any(Function));
  });

  it('未登记的 job → 不杀、返回 false', async () => {
    expect(await killExportProcess(999)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('子进程还没 pid → 不杀、返回 false', async () => {
    registerExportProcess(8, child(undefined));
    expect(await killExportProcess(8)).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('kill 后已注销:同一 job 第二次 kill 返回 false', async () => {
    registerExportProcess(9, child(42));
    expect(await killExportProcess(9)).toBe(true);
    expect(await killExportProcess(9)).toBe(false);
  });

  it('注销只删自己登记的那个进程(旧进程退出不得误删新进程)', async () => {
    const oldC = child(1); const newC = child(2);
    registerExportProcess(10, oldC);
    registerExportProcess(10, newC);   // 逐段下一个 ffmpeg 覆盖登记
    unregisterExportProcess(10, oldC); // 旧进程回调注销,不得删掉新进程的登记
    expect(await killExportProcess(10)).toBe(true);
    expect(execFile).toHaveBeenCalledWith('taskkill', ['/pid', '2', '/T', '/F'], { windowsHide: true }, expect.any(Function));
  });

  it('taskkill 失败不抛(尽力而为),仍返回 true', async () => {
    vi.mocked(execFile).mockImplementationOnce(((_f: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => cb(new Error('no such process'))) as never);
    registerExportProcess(11, child(5));
    await expect(killExportProcess(11)).resolves.toBe(true);
  });
});
