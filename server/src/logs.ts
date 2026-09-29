// server/src/logs.ts(2026-09-29 用户反馈:诊断日志——把后端各环节日志收进一个面板,跨进程问题可观测)
// 2026-09-29 增(用户拍板):①前端操作日志经 POST /api/logs 汇入同一缓冲(source='web');
// ②按 天/小时 落盘文件(<dir>/<YYYY-MM-DD>/<HH>.log,本地时区);③日志可删除(DELETE /api/logs[?day=])
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface LogRow {
  ts: string; // ISO 时间戳
  level: 'info' | 'error';
  source: 'server' | 'job' | 'http' | 'audio.delete' | 'web';
  message: string;
}

// 环形缓冲:容量 500,超出丢最旧——日志只作诊断用途,不能无界吃内存
const CAPACITY = 500;
const buffer: LogRow[] = [];

// ---- 文件落盘:pushLog 每条同步追加到 <dir>/<天>/<小时>.log;失败静默放弃,绝不影响业务主流程 ----
let fileLogDir: string | null = null;
let lastMkdirDir = '';

/** createServer 启动时调用一次:日志根目录(与 db 同级的 logs/)。不调用 → 只进内存缓冲(测试/未知场景安全) */
export function initFileLogging(dir: string): void {
  fileLogDir = dir;
  try { mkdirSync(dir, { recursive: true }); } catch { /* 初始化失败:保持内存日志可用 */ }
}

// 本地时区的 YYYY-MM-DD 与 HH——目录结构跟着用户直觉走(按天分夹、按小时分文件)
function localDayHour(d: Date): { day: string; hour: string } {
  const p = (n: number): string => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hour: p(d.getHours()) };
}

function appendToFile(entry: LogRow): void {
  if (fileLogDir === null) return;
  try {
    const { day, hour } = localDayHour(new Date(entry.ts));
    const dir = join(fileLogDir, day);
    if (dir !== lastMkdirDir) { mkdirSync(dir, { recursive: true }); lastMkdirDir = dir; } // 同一天内不重复 mkdir
    appendFileSync(join(dir, `${hour}.log`), `${entry.ts} [${entry.level}] ${entry.source}: ${entry.message}\n`, 'utf8');
  } catch { /* 磁盘/权限问题只丢本条,不抛出 */ }
}

export function pushLog(level: LogRow['level'], source: LogRow['source'], message: string): void {
  const entry: LogRow = { ts: new Date().toISOString(), level, source, message: message.slice(0, 2000) };
  buffer.push(entry);
  if (buffer.length > CAPACITY) buffer.splice(0, buffer.length - CAPACITY);
  appendToFile(entry);
  if (level === 'error') console.error(`[sct:${source}] ${message}`); // error 同步进 dev 终端;info 不打印防刷屏
}

export function getLogs(): LogRow[] {
  return [...buffer]; // newest last;返回拷贝,防调用方直接改动内部缓冲
}

/**
 * 清空日志(DELETE /api/logs):无 day 清空全部;有 day 只清该天(本地时区,与文件夹命名一致)。
 * 文件删除尽力而为:删不掉收集进 failedFiles 返回,接口仍 200(删除接口不让单点 IO 失败打穿主流程)。
 */
export function clearLogs(day?: string): { clearedEntries: number; deletedFiles: string[]; failedFiles: string[] } {
  const before = buffer.length;
  if (day === undefined) {
    buffer.length = 0;
  } else {
    for (let i = buffer.length - 1; i >= 0; i--) {
      const entry = buffer[i]!;
      if (localDayHour(new Date(entry.ts)).day === day) buffer.splice(i, 1);
    }
  }
  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];
  if (fileLogDir !== null) {
    const removeChildren = (dir: string, label: string): void => {
      let names: string[];
      try { names = readdirSync(dir); } catch { failedFiles.push(label); return; } // 目录不存在/读不到 → 记失败,不抛
      for (const name of names) {
        const rel = label === '' ? name : `${label}/${name}`;
        try { rmSync(join(dir, name), { recursive: true, force: true }); deletedFiles.push(rel); }
        catch { failedFiles.push(rel); }
      }
    };
    if (day === undefined) removeChildren(fileLogDir, '');
    else removeChildren(join(fileLogDir, day), day);
  }
  return { clearedEntries: before - buffer.length, deletedFiles, failedFiles };
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
