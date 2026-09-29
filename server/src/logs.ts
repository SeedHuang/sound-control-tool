// server/src/logs.ts(2026-09-29 用户反馈:诊断日志——把后端各环节日志收进一个面板,跨进程问题可观测)
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface LogRow {
  ts: string; // ISO 时间戳
  level: 'info' | 'error';
  source: 'server' | 'job' | 'http' | 'audio.delete';
  message: string;
}

// 环形缓冲:容量 500,超出丢最旧——日志只作诊断用途,不能无界吃内存
const CAPACITY = 500;
const buffer: LogRow[] = [];

export function pushLog(level: LogRow['level'], source: LogRow['source'], message: string): void {
  buffer.push({ ts: new Date().toISOString(), level, source, message });
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
  if (level === 'error') console.error(`[sct:${source}] ${message}`); // error 同步进 dev 终端;info 不打印防刷屏
}

export function getLogs(): LogRow[] {
  return [...buffer]; // newest last;返回拷贝,防调用方直接改动内部缓冲
}

/**
 * /api/* 请求日志钩子(index.ts createServer 与测试共用):
 * onRequest 把开始时间存 WeakMap(不污染请求对象),onResponse 落一行 `METHOD /path → status (ms)`。
 * 日志只落 pathname——query 里可能带 ?token=<API token>,进诊断面板会泄露凭据。
 */
export function registerRequestLogging(app: FastifyInstance): void {
  const startTimes = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', async (req: FastifyRequest) => {
    startTimes.set(req, Date.now());
  });
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return;
    // 自递归防护:LogsButton 抽屉开着每秒拉一次 /api/logs,若不排除,环形缓冲会刷满自反的 http 行,真正的诊断日志被挤出。
    // 只跳过 http 行的写入,onResponse 钩子本身仍然跑(否则 keep-alive 心跳等指标会缺失)。
    const pathname = req.url.split('?')[0] ?? req.url;
    if (pathname === '/api/logs') return;
    const t0 = startTimes.get(req);
    const ms = t0 === undefined ? 0 : Date.now() - t0;
    pushLog(reply.statusCode >= 500 ? 'error' : 'info', 'http', `${req.method} ${pathname} → ${reply.statusCode} (${ms}ms)`);
  });
}
