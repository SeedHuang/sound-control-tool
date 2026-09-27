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
