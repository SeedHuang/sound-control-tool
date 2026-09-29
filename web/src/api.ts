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

/** 业务错误:code 是后端 error.code(BAD_REQUEST/CONFLICT/INVALID_COOKIE/...),前端按 code 分支(如 CONFLICT → 覆盖确认弹窗) */
export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}

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

export async function cancelJob(jobId: number): Promise<{ ok: boolean }> {
  // 诊断日志:用户操作关键按钮也要落痕(否则面板只有后端 job cancelled,看不到"前端触发"那一下)
  logFe('info', `cancelJob jobId=${jobId}`);
  return apiPost<{ ok: boolean }>(`/api/jobs/${jobId}/cancel`, {});
}

export async function retryJob(jobId: number): Promise<{ ok: boolean; jobId: number }> {
  // 诊断日志:重试是「明知会失败仍提交」的高风险操作,前端必须留痕便于与后端对账
  logFe('info', `retryJob jobId=${jobId}`);
  const r = await apiPost<{ ok: boolean; jobId: number }>(`/api/jobs/${jobId}/retry`, {});
  logFe('info', `retryJob jobId=${jobId} → newJobId=${r.jobId}`);
  return r;
}

export async function listAudio(): Promise<AudioRow[]> {
  return apiGet<AudioRow[]>('/api/audio');
}
export interface AudioRow { id: number; title: string; source_type: string; format: string; duration_sec: number | null; created_at: string }

export function audioFileUrl(id: number): string {
  const token = apiToken();
  // 诊断日志:记下 audio 标签请求 URL(去 token 尾段,凭据不全打)+ token 来源(query/无),
  // CORS 排查时一眼看清「这次 audio 请求有没有带 token」「origin 该不该让服务器放行」
  const src = token ? 'query' : 'none';
  logFe('info', `audioFileUrl id=${id} token=${src}`);
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

// ---- B 站 Cookie(2026-09-29 用户拍板):设置页粘贴 → PUT /api/cookie → server 保存 → yt-dlp --cookies 注入 ----
// 2026-09-29 增:server 保存时双重校验(SESSDATA 结构 + B 站 nav 在线验登录);已有未过期登录信息 → 409 CONFLICT
export interface CookieStatus {
  ok: boolean; set: boolean; length: number;
  count: number;                 // 解析出的 cookie 条数
  sessdataExpiry: number | null; // SESSDATA 过期 unix 秒(无登录凭据 → null)
  expired: boolean | null;       // null = 无法判定(无 SESSDATA)
}
export interface CookieSaveResult { ok: boolean; count: number; verified: boolean; uname: string | null }

/** PUT 语义(与 apiPost 同款错误处理;/api/cookie 等写接口用) */
export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const res = await fetch(`${API_BASE}${path}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; next?: string } } | null;
    const msg = j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`;
    logFe('error', `请求失败 ${path}: ${msg}`); // 诊断日志:业务错误(400/409)也进前端面板
    throw new ApiError(msg, j?.error?.code);
  }
  return (await res.json()) as T;
}

/** GET /api/cookie:只回元数据(count/有效期);Cookie 内容永不回传 UI(server 端键不在 settings 白名单) */
export function getCookieStatus(): Promise<CookieStatus> {
  return apiGet<CookieStatus>('/api/cookie');
}

/** PUT /api/cookie:保存 Cookie(服务端结构+在线双重校验);409 CONFLICT = 已有未过期登录信息,需 force=true 覆盖 */
export async function saveCookie(content: string, force = false): Promise<CookieSaveResult> {
  // 诊断日志:Cookie 是凭据操作,记长度不记全文(凭据不出日志)
  logFe('info', `saveCookie length=${content.length}${force ? ' force' : ''}`);
  const r = await apiPut<CookieSaveResult>('/api/cookie', { content, force });
  logFe('info', `saveCookie ok count=${r.count} verified=${r.verified}`);
  return r;
}

// ---- 音频删除(2026-09-29 用户拍板):audio list 每行删除按钮 → DELETE /api/audio/:id ----
/** DELETE 语义:无 body(与 apiPut/apiPost 共用 ApiError + logFe) */
export async function apiDelete<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const token = apiToken();
  if (token) headers['x-sct-token'] = token;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers, signal: ctl.signal });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: { message?: string; next?: string } } | null;
      const msg = j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`;
      logFe('error', `请求失败 ${path}: ${msg}`);
      throw new ApiError(msg);
    }
    return (await res.json()) as T;
  } finally { clearTimeout(timer); }
}

/** 删除音频:返回后端 { ok, deleted } —— deleted 表示磁盘文件是否真删掉(缺文件时为 false,但接口仍 200) */
export async function deleteAudio(audioId: number): Promise<{ ok: boolean; deleted: boolean }> {
  // 诊断日志:删除是不可逆操作,前后端都要记。deleted=false 不是错误(后端会 log 说明文件缺失)
  logFe('info', `deleteAudio id=${audioId}`);
  const r = await apiDelete<{ ok: boolean; deleted: boolean }>(`/api/audio/${audioId}`);
  logFe('info', `deleteAudio id=${audioId} deleted=${r.deleted}`);
  return r;
}
