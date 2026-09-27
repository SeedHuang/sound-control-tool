import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreePort } from './find-free-port.js';

function listen(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('findFreePort', () => {
  it('起始端口空闲时原样返回', async () => {
    const p = await findFreePort(7330);
    expect(p).toBe(7330);
  });

  it('被占时向后递增到下一个空闲端口', async () => {
    const srv = await listen(7341);
    const p = await findFreePort(7341);
    expect(p).toBeGreaterThan(7341);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});
