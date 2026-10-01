// server/src/ytdlp/download-queue.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createDownloadQueue } from './download-queue.js';

/** 造一个“手动终结”的 start：返回 Promise + 暴露 resolve，模拟任务跑到终态 */
function manualStarter() {
  const pending = new Map<number, () => void>();
  const started: number[] = [];
  const start = (jobId: number): Promise<void> => {
    started.push(jobId);
    return new Promise<void>((resolve) => pending.set(jobId, resolve));
  };
  const finish = (jobId: number): void => {
    pending.get(jobId)?.();
    pending.delete(jobId);
  };
  return { start, finish, started };
}

const noopCancel = (): void => {};

describe('createDownloadQueue（并发受限队列）', () => {
  it('上限 1：提交 3 个只跑 1 个，其余排队', async () => {
    const s = manualStarter();
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2); q.enqueue(3);
    await Promise.resolve();
    expect(s.started).toEqual([1]);
    expect(q.runningIds()).toEqual([1]);
    expect(q.queuedIds()).toEqual([2, 3]);
  });

  it('前一个进终态 → 下一个立刻被放行（槽位释放）', async () => {
    const s = manualStarter();
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2);
    await Promise.resolve();
    s.finish(1);
    await Promise.resolve(); await Promise.resolve();
    expect(s.started).toEqual([1, 2]);
    expect(q.runningIds()).toEqual([2]);
  });

  it('start 抛错也必须释放槽位（否则一个坏任务卡死整条队，D6）', async () => {
    const started: number[] = [];
    const s = manualStarter();
    const q = createDownloadQueue({
      limit: () => 1,
      start: (jobId) => { started.push(jobId); return jobId === 1 ? Promise.reject(new Error('boom')) : s.start(jobId); },
      markCancelled: noopCancel,
    });
    q.enqueue(1); q.enqueue(2);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([1, 2]);      // 2 没被 1 的失败卡住
    expect(q.runningIds()).toEqual([2]);
  });

  it('上限变更立即放行排队中的任务（D4）', async () => {
    const s = manualStarter();
    let limit = 1;
    const q = createDownloadQueue({ limit: () => limit, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2); q.enqueue(3);
    await Promise.resolve();
    expect(s.started).toEqual([1]);
    limit = 3;
    q.pump();                              // 设置变更后由调用方显式催一次
    await Promise.resolve();
    expect(s.started).toEqual([1, 2, 3]);
  });

  it('取消排队中的任务：移出队列 + 置 cancelled，且**不**调用 start', () => {
    const s = manualStarter();
    const cancelled: number[] = [];
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled: (id) => cancelled.push(id) });
    q.enqueue(1); q.enqueue(2);
    expect(q.cancelQueued(2)).toBe(true);
    expect(cancelled).toEqual([2]);
    expect(q.queuedIds()).toEqual([]);
    expect(s.started).toEqual([1]);        // 被取消的 2 从未被 start（它没有进程，也就不该 taskkill）
    expect(q.cancelQueued(2)).toBe(false); // 已经不在队列里
  });

  it('上限 2：同时跑 2 个，其余仍排队', async () => {
    const s = manualStarter();
    const q = createDownloadQueue({ limit: () => 2, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2); q.enqueue(3); q.enqueue(4);
    await Promise.resolve();
    expect(s.started).toEqual([1, 2]);
    expect(q.runningIds()).toEqual([1, 2]);
    expect(q.queuedIds()).toEqual([3, 4]);
  });

  it('取消“正在跑”的任务（不在队列里）→ 返回 false 且不动 running（交调用方走 taskkill）', () => {
    const s = manualStarter();
    const markCancelled = vi.fn();
    const q = createDownloadQueue({ limit: () => 1, start: s.start, markCancelled });
    q.enqueue(1); q.enqueue(2);
    expect(q.cancelQueued(1)).toBe(false);  // 1 已在跑 → 不在队列
    expect(markCancelled).not.toHaveBeenCalled();
    expect(q.runningIds()).toEqual([1]);    // running 不受影响
    expect(q.queuedIds()).toEqual([2]);
  });

  it.each([[Number.NaN], [0], [-3], [2.5]])('上限非法（%s）→ 兜底为 1，仍然起得动、不卡死也不超发', async (bad) => {
    const s = manualStarter();
    const q = createDownloadQueue({ limit: () => bad, start: s.start, markCancelled: noopCancel });
    q.enqueue(1); q.enqueue(2);
    await Promise.resolve();
    expect(s.started).toEqual([1]);         // 退化成串行，但没被非法上限卡死
    expect(q.runningIds()).toEqual([1]);
    expect(q.queuedIds()).toEqual([2]);
  });
});
