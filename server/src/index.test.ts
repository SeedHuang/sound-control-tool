import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from './index.js';
import { openDatabase } from './db/index.js';
import { initSchema } from './db/schema.js';
import { createImportsRepo } from './db/repo/imports.js';

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

  it('D3:GET /api/jobs/1/events 无 header token、无 Origin、query token 正确 → 到路由(404 job 不存在,非守卫 401)', async () => {
    const s = await createServer({ port: 7367, dbPath: ':memory:', tempDir: path.join(tmp(), 't17') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/jobs/1/events?token=${s.token}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
    await s.close();
  });

  it('D3:GET /api/audio/1/file 无 header token、无 Origin、query token 正确 → 到路由(404 音频不存在,非守卫 401)', async () => {
    const s = await createServer({ port: 7368, dbPath: ':memory:', tempDir: path.join(tmp(), 't18') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/audio/1/file?token=${s.token}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('NOT_FOUND');
    await s.close();
  });

  it('D3:query token 错误时 events/audio 由路由返回 401 UNAUTHORIZED(非守卫"缺少或无效的 API token")', async () => {
    const s = await createServer({ port: 7369, dbPath: ':memory:', tempDir: path.join(tmp(), 't19') });
    // 封面(2026-09-29 加):<img> 同样加不了 header —— 守卫必须豁免它,由路由内的 query token/Referer 判定接管。
    // 这条断言就是浏览器实测踩到的那个 401(守卫先拦,路由根本没跑)。
    for (const p of ['/api/jobs/1/events?token=wrong', '/api/audio/1/file?token=wrong', '/api/imports/1/cover?token=wrong']) {
      const res = await fetch(`http://127.0.0.1:${s.port}${p}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('UNAUTHORIZED');
      expect(body.error?.message).not.toBe('缺少或无效的 API token');
    }
    await s.close();
  });

  it('D3:豁免不扩散——/api/audio 列表无 header token、无 Origin 仍被守卫 401', async () => {
    const s = await createServer({ port: 7370, dbPath: ':memory:', tempDir: path.join(tmp(), 't20') });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/audio`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('缺少或无效的 API token');
    await s.close();
  });

  // 2026-09-29 浏览器实测后补的端到端用例:<img> 既没有 Origin 也加不了 header,只有 Referer。
  // 它要同时穿过「守卫豁免」+「路由内 Referer 判定」两道关——只挂路由的单测照不出守卫那一段,
  // 而这个缺口正是实测踩到的(封面全 401 → 卡片退纯色)。
  it('封面:本机页面 Referer 能穿过守卫取到本地图;外站 Referer 仍 401', async () => {
    const dir = tmp();
    const dbPath = path.join(dir, 'sct.db');
    const db = openDatabase(dbPath);
    initSchema(db);
    const importId = createImportsRepo(db).upsertByUrl({
      url: 'https://www.bilibili.com/bangumi/play/ss1', title: '凡人修仙传', site: 'bilibili',
      kind: 'playlist', duration_sec: null, entries: null, thumbnail: 'https://t/1.jpg',
    });
    db.close();
    // 封面目录 = dirname(audioDir)/covers = dir/covers(与 createServer 内部算法一致)
    mkdirSync(path.join(dir, 'covers'), { recursive: true });
    writeFileSync(path.join(dir, 'covers', `cover-${importId}.png`), 'PNGDATA');
    const s = await createServer({ port: 7371, dbPath, tempDir: path.join(dir, 'tmp') });
    const ok = await fetch(`http://127.0.0.1:${s.port}/api/imports/${importId}/cover`, { headers: { referer: 'http://localhost:8000/' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('image/png');
    expect(await ok.text()).toBe('PNGDATA');
    const evil = await fetch(`http://127.0.0.1:${s.port}/api/imports/${importId}/cover`, { headers: { referer: 'https://evil.example/x' } });
    expect(evil.status).toBe(401);
    await s.close();
  });
});
