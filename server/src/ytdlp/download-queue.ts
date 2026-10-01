// server/src/ytdlp/download-queue.ts
// 并发受限的下载队列（spec D1/D3/D4/D5/D6）。
// - 只服务 ytdlp_* 两类任务（ffmpeg 剪辑/导出不排队，D1）；
// - “排队中”复用 jobs.status='pending'，**零 schema 迁移**（D3）；
// - 槽位释放挂在唯一的 finally 上——任何终态/异常都覆盖，防“一个坏任务卡死整条队”（D6）。
export interface DownloadQueue {
  /** 入队并尽力启动（有空槽就立刻起） */
  enqueue(jobId: number): void;
  /** 取消“排队中”的任务：移出队列并置 cancelled（不杀进程）；返回是否命中队列 */
  cancelQueued(jobId: number): boolean;
  /** 设置里并发数变更后由调用方显式催一次（D4：在跑的不动，排队的按新上限立刻放行） */
  pump(): void;
  /** 当前运行中的 jobId（仅供断言，UI/测试不该依赖它做业务判断） */
  runningIds(): number[];
  /** 队列中的 jobId（按入队顺序） */
  queuedIds(): number[];
}

export interface QueueDeps {
  /** 每次调度都现读——这样“设置里改了上限”能立刻生效（D4）；实现方负责兜底非法值 */
  limit: () => number;
  /** 真正启动一个任务；**必须在任务进入终态时 resolve**（done/error/cancelled 都要） */
  start: (jobId: number) => Promise<void>;
  /** 终态兜底：把 job 置 cancelled（取消排队中的任务用） */
  markCancelled: (jobId: number) => void;
}

export function createDownloadQueue(deps: QueueDeps): DownloadQueue {
  const queued: number[] = [];
  const running = new Set<number>();

  // 上限现读 + 合法性兜底：NaN/小数/0/负数一律按 1 处理——
  // 宁可退化成串行，也不能让一个非法上限把队列彻底卡死（Math.max(1, NaN) === NaN 的坑）。
  const capacity = (): number => {
    const n = deps.limit();
    return Number.isInteger(n) && n >= 1 ? n : 1;
  };

  const pump = (): void => {
    while (running.size < capacity() && queued.length > 0) {
      const jobId = queued.shift()!;
      running.add(jobId);
      // 不在 pump 里 await：一个任务的耗时不能挡住同一轮里其它槽位的放行。
      // 槽位释放挂在 finally —— **这是唯一释放点**，任何终态/异常都覆盖（D6）。
      void deps
        .start(jobId)
        .catch(() => {
          // start 若在进终态前就 reject(装配层已兜底:置 error 终态 + 留日志,见 index.ts 的 .catch);
          // 这里只保证异常不冒泡、不卡住队列。槽位的释放始终由下面的 finally 负责。
        })
        .finally(() => {
          running.delete(jobId);
          pump();
        });
    }
  };

  return {
    enqueue: (jobId) => {
      queued.push(jobId);
      pump();
    },
    cancelQueued: (jobId) => {
      const i = queued.indexOf(jobId);
      if (i === -1) return false; // 不在队列里（可能已在跑或已结束）→ 交给调用方走既有 cancel 路径
      queued.splice(i, 1);
      deps.markCancelled(jobId);
      return true;
    },
    pump,
    runningIds: () => [...running],
    queuedIds: () => [...queued],
  };
}
