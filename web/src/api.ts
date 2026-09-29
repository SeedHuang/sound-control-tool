/** D3 唯一解析点:URL ?apiPort= 优先,非法或缺省回退 7310(浏览器独立开发场景) */
export function apiPort(): number {
  const raw = new URLSearchParams(window.location.search).get('apiPort');
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 7310;
}

/** D12:URL ?apiToken=;缺失返回 null(浏览器独立开发时从 .sct/dev-port 读取后手填) */
export function apiToken(): string | null {
  const raw = new URLSearchParams(window.location.search).get('apiToken');
  return raw && raw.length > 0 ? raw : null;
}

export const API_BASE = `http://127.0.0.1:${apiPort()}`;

export class ApiError extends Error {}

// ---- 诊断日志(2026-09-29 用户反馈:一个按钮看前后端日志) ----
// 前端环形缓冲(容量 200,丢最旧):api.ts 是唯一埋点点位,页面组件不感知。
export interface LogRow { ts: string; level: 'info' | 'error'; source: string; message: string }
const feLogs: LogRow[] = [];
const FE_LOG_CAP = 200;

export function logFe(level: LogRow['level'], message: string): void {
  feLogs.push({ ts: new Date().toISOString(), level, source: 'web', message });
  if (feLogs.length > FE_LOG_CAP) feLogs.splice(0, feLogs.length - FE_LOG_CAP);
}

export function getFeLogs(): LogRow[] {
  return [...feLogs]; // 拷贝,防调用方直接改内部缓冲
}

/** 拉取后端诊断日志(GET /api/logs,环形缓冲最近 500 条) */
export async function fetchLogs(): Promise<LogRow[]> {
  const j = await apiGet<{ ok: boolean; logs: LogRow[] }>('/api/logs');
  return j.logs;
}

export async function apiGet<T>(path: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    const token = apiToken();
    if (token) headers['x-sct-token'] = token; // D12:受保护路由要求 token
    res = await fetch(`${API_BASE}${path}`, { headers, signal: ctl.signal });
  } catch (err) {
    logFe('error', `请求失败 ${path}: ${err instanceof Error ? err.message : '网络错误'}`); // 诊断日志:连不上也要在面板可见
    throw new ApiError(`无法连接本地服务(apiPort=${apiPort()})。请确认 server 进程已启动(pnpm dev:server)。`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    logFe('error', `请求失败 ${path}: ${res.status}`); // 诊断日志:HTTP 非 2xx 留痕
    throw new ApiError(`请求失败 ${res.status}:${path}`);
  }
  // 非 JSON 响应(HTML 错误页/代理页)不再是裸 SyntaxError,统一包装为 ApiError
  try {
    return (await res.json()) as T;
  } catch {
    logFe('error', `请求失败 ${path}: 响应不是合法 JSON`); // 诊断日志:代理页/错误页留痕
    throw new ApiError(`响应不是合法 JSON:${path}`);
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string; next?: string } } | null;
      const msg = j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`;
      logFe('error', `请求失败 ${path}: ${msg}`); // 诊断日志:业务错误(400/409)也进前端面板
      throw new ApiError(msg);
    }
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

// spec §0.3 接口契约:parse 返回 kind/title/duration_sec/entries/existing
export interface ParseResponse {
  ok: boolean; kind: 'single' | 'playlist'; title: string; duration_sec?: number;
  entries?: { index: number; title: string }[];
  existing?: { audioId: number; title: string };
}
export interface DownloadPayload {
  url: string;
  title?: string;
  durationSec?: number;
  options: { entryIndices?: number[]; section?: { start: number; end: number }; format: 'mp3' | 'm4a' | 'wav'; quality?: string; force?: boolean };
}

export async function parseUrl(url: string): Promise<ParseResponse> {
  const r = await apiPost<ParseResponse>('/api/ytdlp/parse', { url });
  logFe('info', `解析成功 ${r.kind}`); // 诊断日志:解析结果留痕(合集条目数在 message 外,面板看 kind 即可定位)
  return r;
}

export async function startDownload(payload: DownloadPayload): Promise<{ ok: boolean; jobId: number }> {
  const r = await apiPost<{ ok: boolean; jobId: number }>('/api/ytdlp/download', payload);
  logFe('info', `下载已提交 jobId=${r.jobId}`); // 诊断日志:提交留痕,与后端 job created 行可对账
  return r;
}

export function cancelJob(jobId: number): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {});
}

export function retryJob(jobId: number): Promise<{ ok: boolean; jobId: number }> {
  return apiPost<{ ok: boolean; jobId: number }>(`/api/jobs/${jobId}/retry`, {});
}

export async function listAudio(): Promise<AudioRow[]> {
  return apiGet<AudioRow[]>('/api/audio');
}
export interface AudioRow { id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string }

export function audioFileUrl(id: number): string {
  const token = apiToken();
  return `${API_BASE}/api/audio/${id}/file?token=${encodeURIComponent(token ?? '')}`;
}

export function subscribeJob(jobId: number, handlers: {
  onProgress?: (p: { percent: number }) => void;
  onDone?: (d: { audioId: number; title: string; format: string }) => void;
  onStatus?: (s: { state: string; message?: string }) => void;
  onError?: (msg: string) => void;
}): () => void {
  const token = apiToken();
  const es = new EventSource(`${API_BASE}/api/jobs/${jobId}/events?token=${encodeURIComponent(token ?? '')}`);
  es.addEventListener('progress', (e) => handlers.onProgress?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('done', (e) => handlers.onDone?.(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('status', (e) => {
    const s = JSON.parse((e as MessageEvent).data) as { state: string; message?: string };
    handlers.onStatus?.(s);
    if (s.state === 'error' || s.state === 'cancelled') { handlers.onError?.(s.message ?? s.state); es.close(); }
    if (s.state === 'done') es.close();
  });
  es.onerror = () => {
    logFe('error', 'SSE 连接中断'); // 诊断日志:SSE 断连是跨进程问题高发点(CORS 缺头修复前也在这里现形)
    handlers.onError?.('连接中断');
    es.close();
  };
  return () => es.close();
}
