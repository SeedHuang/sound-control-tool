import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './index.js';

const cleanup: Array<() => void> = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'sct-cs-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

describe('createServer(正式版)', () => {
  it('health 返回 ok 且包含实际端口', async () => {
    const s = await createServer({ port: 7350, dbPath: ':memory:', tempDir: path.join(tmp(), 'tmp') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    const body = (await res.json()) as { ok: boolean; port: number; sqlite: string | null };
    expect(body.ok).toBe(true);
    expect(body.port).toBe(s.port);
    expect(typeof body.sqlite).toBe('string');
    await s.close();
  });

  it('端口被占时自动递增', async () => {
    const s1 = await createServer({ port: 7351, dbPath: ':memory:', tempDir: path.join(tmp(), 't1') });
    const s2 = await createServer({ port: 7351, dbPath: ':memory:', tempDir: path.join(tmp(), 't2') });
    expect(s2.port).toBeGreaterThan(s1.port);
    await s1.close();
    await s2.close();
  });

  it('CORS:带 Origin 的请求被反射;preflight 返回 204', async () => {
    const s = await createServer({ port: 7352, dbPath: ':memory:', tempDir: path.join(tmp(), 't3') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`, {
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');

    const pre = await fetch(`http://127.0.0.1:${s.port}/api/health`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8000', 'access-control-request-method': 'GET' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:8000');
    await s.close();
  });

  it('portFile 写入 {port, pid, token}', async () => {
    const data = tmp();
    const file = path.join(data, 'dev-port');
    const s = await createServer({ port: 7353, dbPath: ':memory:', tempDir: path.join(data, 't4'), portFile: file });
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port: number; pid: number; token: string };
    expect(parsed.port).toBe(s.port);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.token).toBe(s.token);
    expect(typeof parsed.token).toBe('string');
    await s.close();
  });

  it('close 后端口释放(可复用)', async () => {
    const s = await createServer({ port: 7354, dbPath: ':memory:', tempDir: path.join(tmp(), 't5') });
    await s.close();
    const s2 = await createServer({ port: 7354, dbPath: ':memory:', tempDir: path.join(tmp(), 't6') });
    expect(s2.port).toBe(7354);
    await s2.close();
  });
});

describe('createServer(D12 API token)', () => {
  it('无 Origin、无 token 访问 /api/settings → 401', async () => {
    const s = await createServer({ port: 7360, dbPath: ':memory:', tempDir: path.join(tmp(), 't10') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`);
    expect(res.status).toBe(401);
    await s.close();
  });

  it('无 Origin、带正确 x-sct-token 访问 /api/settings → 200', async () => {
    const s = await createServer({ port: 7361, dbPath: ':memory:', tempDir: path.join(tmp(), 't11') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { 'x-sct-token': s.token },
    });
    expect(res.status).toBe(200);
    await s.close();
  });

  it('GET /api/health 无需 token → 200', async () => {
    const s = await createServer({ port: 7362, dbPath: ':memory:', tempDir: path.join(tmp(), 't12') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/health`);
    expect(res.status).toBe(200);
    await s.close();
  });

  it('Origin 属 localhost 白名单时豁免 token → 200', async () => {
    const s = await createServer({ port: 7363, dbPath: ':memory:', tempDir: path.join(tmp(), 't13') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { origin: 'http://localhost:8000' },
    });
    expect(res.status).toBe(200);
    await s.close();
  });

  it('Origin 非白名单时 401 且不下发 allow-origin', async () => {
    const s = await createServer({ port: 7364, dbPath: ':memory:', tempDir: path.join(tmp(), 't14') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await s.close();
  });

  it('GET /api/settings 不泄露内部键 health_stamp', async () => {
    const s = await createServer({ port: 7365, dbPath: ':memory:', tempDir: path.join(tmp(), 't15') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/settings`, {
      headers: { 'x-sct-token': s.token },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['health_stamp']).toBeUndefined();
    await s.close();
  });

  it('close 幂等:二次调用不抛', async () => {
    const s = await createServer({ port: 7366, dbPath: ':memory:', tempDir: path.join(tmp(), 't16') });
    await s.close();
    await expect(s.close()).resolves.toBeUndefined();
  });
});
