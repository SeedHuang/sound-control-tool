export interface DevPortInfo {
  port: number;
  pid: number;
  token: string;
}

/** server 侧写入契约:JSON {port, pid, token}(spec 0.3 / D12);垃圾/缺失一律 null,由回退链兜底 */
export function parsePortFile(content: string): DevPortInfo | null {
  try {
    const o = JSON.parse(content) as Record<string, unknown>;
    const port = o['port'];
    const pid = o['pid'];
    const token = o['token'];
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return null;
    if (typeof token !== 'string' || token.length === 0) return null;
    return { port, pid, token };
  } catch {
    return null;
  }
}
