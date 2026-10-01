// server/src/media/formats-routes.test.ts
// 可用清晰度探测路由(spec §0.3 / D6/D7/D8/D9):单测注入 probe 桩,不打真实外网。
// 直接在裸 Fastify 上注册(token 校验属 index.ts 的 onRequest 钩子职责,不在这层)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase, type DB } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { registerFormatsRoutes } from './formats-routes.js';
import { FALLBACK_TIERS } from '../ytdlp/probe-formats.js';

let app: FastifyInstance;
let db: DB;

function makeApp(probe: (url: string, entry?: number) => Promise<number[]>): FastifyInstance {
  const a = Fastify();
  registerFormatsRoutes(a, {
    db, audioDir: join(mkdtempSync(join(tmpdir(), 'sct-fmt-')), 'audio'),
    binProvider: async () => ({ path: 'yt-dlp' }),
    probe,           // 注入:本路由单测不打真实外网
  });
  return a;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  initSchema(db);
  db.prepare('INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)').run('https://a/v', 't', 'bilibili', 'single');
  db.prepare('INSERT INTO imported_sources (url,title,site,kind) VALUES (?,?,?,?)').run('https://a/p', 'p', 'bilibili', 'playlist');
});
afterEach(async () => {
  await app.close();
});

describe('GET /api/imports/:id/formats', () => {
  it('单视频成功 → heights 降序、fallback:false', async () => {
    app = makeApp(async () => [2160, 1080, 720]);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, heights: [2160, 1080, 720], fallback: false });
  });
  it('合集缺 entry → 400', async () => {
    app = makeApp(async () => [720]);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/2/formats' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_REQUEST');
  });
  it('合集带 entry → 探测收到该 entry(透传)', async () => {
    let seen: number | undefined;
    app = makeApp(async (_url, entry) => { seen = entry; return [720]; });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/2/formats?entry=3' });
    expect(r.statusCode).toBe(200);
    expect(seen).toBe(3);
  });
  it('探测失败 → 200 + fallback 四档(不报错,spec D7)', async () => {
    app = makeApp(async () => { throw new Error('timeout'); });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, heights: FALLBACK_TIERS, fallback: true });
  });
  it('探测结果为空 → 也算降级', async () => {
    app = makeApp(async () => []);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(r.json()).toMatchObject({ fallback: true, heights: FALLBACK_TIERS });
  });
  it('id 不存在 → 404', async () => {
    app = makeApp(async () => [720]);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/imports/999/formats' });
    expect(r.statusCode).toBe(404);
  });
  it('缓存:同 url+entry 第二次不再探测(D9)', async () => {
    let calls = 0;
    app = makeApp(async () => { calls += 1; return [720]; });
    await app.ready();
    await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    await app.inject({ method: 'GET', url: '/api/imports/1/formats' });
    expect(calls).toBe(1);
  });
});
