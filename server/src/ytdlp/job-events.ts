// server/src/ytdlp/job-events.ts
// 2026-09-29 抽出:下载路由与媒体剪辑路由都要往同一个 job 推 SSE 事件,事件桥不能只活在 ytdlp-routes.ts。
// 所有"按 jobId 记的临时状态"都收在这里,避免同一份状态散在多个文件里各删一半。
import { pushLog } from '../logs.js';

export type SseConn = { write: (s: string) => void; end: () => void };

const sseConnections = new Map<number, Set<SseConn>>();
// 终态:done/error/cancelled 事件后断开连接(progress/running 不断开)
const TERMINAL_STATES = new Set(['done', 'error', 'cancelled']);
// 诊断日志:每个 job 只在 25/50/75/100 档位变化时记一行进度(逐条进度行会把日志面板刷成噪声)
const lastProgressBucket = new Map<number, number>();

export function addSseConnection(jobId: number, conn: SseConn): void {
  if (!sseConnections.has(jobId)) sseConnections.set(jobId, new Set());
  sseConnections.get(jobId)!.add(conn);
}

/** 注销连接并返回剩余数(调用方用它决定是否打印 close 日志) */
export function removeSseConnection(jobId: number, conn: SseConn): number {
  const set = sseConnections.get(jobId);
  if (!set) return 0;
  set.delete(conn);
  if (set.size === 0) sseConnections.delete(jobId);
  return set.size;
}

/** 进度日志节流:同一 job 只在跨 25% 档位时返回 true(档位状态在终态由 emit 清掉) */
export function progressBucketChanged(jobId: number, percent: number): boolean {
  const bucket = Math.floor(percent / 25);
  if (lastProgressBucket.get(jobId) === bucket) return false;
  lastProgressBucket.set(jobId, bucket);
  return true;
}

export function emit(jobId: number, ev: unknown): void {
  const set = sseConnections.get(jobId);
  if (!set) return;
  const type = (ev as { type: string }).type;
  const state = type === 'status' ? (ev as { state?: string }).state : type;
  for (const conn of set) conn.write(`event: ${type}\ndata: ${JSON.stringify(ev)}\n\n`);
  if (type === 'done' || (type === 'status' && state && TERMINAL_STATES.has(state))) {
    for (const conn of set) conn.end();
    sseConnections.delete(jobId);
    lastProgressBucket.delete(jobId); // 终态清理,防 Map 无界增长
  }
}

/** 只是给路由层复用的一句话日志(避免路由直接 import pushLog 两次写同一句式) */
export function logSseClose(jobId: number, remaining: number): void {
  pushLog('info', 'job', `SSE close job=${jobId} remaining=${remaining}`);
}
