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

export async function apiGet<T>(path: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    const token = apiToken();
    if (token) headers['x-sct-token'] = token; // D12:受保护路由要求 token
    res = await fetch(`${API_BASE}${path}`, { headers, signal: ctl.signal });
  } catch {
    throw new ApiError(`无法连接本地服务(apiPort=${apiPort()})。请确认 server 进程已启动(pnpm dev:server)。`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError(`请求失败 ${res.status}:${path}`);
  // 非 JSON 响应(HTML 错误页/代理页)不再是裸 SyntaxError,统一包装为 ApiError
  try {
    return (await res.json()) as T;
  } catch {
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
      throw new ApiError(j?.error?.message ?? `请求失败 ${res.status}:${path}${j?.error?.next ? `。${j.error.next}` : ''}`);
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

export function parseUrl(url: string): Promise<ParseResponse> {
  return apiPost<ParseResponse>('/api/ytdlp/parse', { url });
}
export function startDownload(payload: DownloadPayload): Promise<{ ok: boolean; jobId: number }> {
  return apiPost<{ ok: boolean; jobId: number }>('/api/ytdlp/download', payload);
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
  es.onerror = () => { handlers.onError?.('连接中断'); es.close(); };
  return () => es.close();
}
