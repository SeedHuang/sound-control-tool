/**
 * @sct/server 的共享契约(手写):desktop 对 server 无静态类型依赖,这是唯一防漂移点。
 * createServer 签名变更只需在此更新一处。
 */
export interface ServerModule {
  bootstrap(opts: { dbPath: string; tempDir: string }): Promise<void>;
  createServer(opts: { port: number; dbPath: string; tempDir: string; portFile?: string }): Promise<{
    port: number;
    token: string;
    close: () => Promise<void>;
  }>;
}

/** 带超时的 health 探测;定时器一定清理(修 Low:fetch 拒绝时定时器泄漏) */
export async function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
