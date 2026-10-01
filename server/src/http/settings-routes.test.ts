import { describe, expect, it, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { createSettingsRepo } from '../db/repo/settings.js';
import { SETTINGS_KEYS } from '../settings-keys.js';
import { registerSettingsRoutes } from './settings-routes.js';

let app: FastifyInstance;
let db: ReturnType<typeof openDatabase>;
let defaultDir: string;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'sct-settings-'));
  defaultDir = join(root, 'audio');
  mkdirSync(defaultDir, { recursive: true });
  db = openDatabase(':memory:');
  initSchema(db);
  app = Fastify();
  registerSettingsRoutes(app, db, defaultDir);
  await app.ready();
});

describe('PUT /api/settings 的 output_dir 校验(spec D4/D5/D11)', () => {
  it('未配置时 GET 回 output_dir_resolved === defaultOutputDir', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().output_dir_resolved).toBe(defaultDir);
  });
  it('相对路径 → 400 且不落库', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: 'exports' } });
    expect(res.statusCode).toBe(400);
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.outputDir)).toBeNull();
  });
  it('合法绝对路径 → 200,GET 能读回', async () => {
    const custom = join(root, 'my-exports');
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: custom } });
    expect(res.statusCode).toBe(200);
    const g = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().output_dir_resolved).toBe(custom);
    expect(existsSync(custom)).toBe(true); // D5：保存时就建目录
  });
  it('不可写(拿已存在的文件当目录) → 400 且不落库', async () => {
    const fileAsDir = join(root, 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: fileAsDir } });
    expect(res.statusCode).toBe(400);
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.outputDir)).toBeNull();
  });
  it('留空 → 200 且 output_dir_resolved 回到 defaultOutputDir', async () => {
    createSettingsRepo(db).set(SETTINGS_KEYS.outputDir, join(root, 'x'));
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { output_dir: '' } });
    expect(res.statusCode).toBe(200);
    const g = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(g.json().output_dir_resolved).toBe(defaultDir);
  });
});

describe('PUT /api/settings 下载保护类三项校验（spec D2/D17）', () => {
  it.each([['0'], ['6'], ['abc'], ['1.5']])('并发数非法 %s → 400 且不落库', async (v) => {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { max_concurrent_downloads: v } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('BAD_REQUEST');
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.maxConcurrentDownloads)).toBeNull();
  });
  it.each([['1'], ['5']])('并发数合法 %s → 200 且落库', async (v) => {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { max_concurrent_downloads: v } });
    expect(r.statusCode).toBe(200);
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.maxConcurrentDownloads)).toBe(v);
  });
  it.each([['0'], ['10']])('间隔合法（闭区间端点）%s → 200', async (v) => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_sleep_seconds: v } })).statusCode).toBe(200);
  });
  it.each([['-1'], ['11'], ['x']])('间隔非法 %s → 400', async (v) => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_sleep_seconds: v } })).statusCode).toBe(400);
  });
  it.each([['500K'], ['1.5M'], ['']])('限速合法 %s → 200', async (v) => {
    expect((await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_limit_rate: v } })).statusCode).toBe(200);
  });
  it.each([['500 KB'], ['abc'], ['-1']])('限速非法 %s → 400', async (v) => {
    const r = await app.inject({ method: 'PUT', url: '/api/settings', payload: { download_limit_rate: v } });
    expect(r.statusCode).toBe(400);
    expect(createSettingsRepo(db).get(SETTINGS_KEYS.downloadLimitRate)).toBeNull();
  });
});

describe('并发数变更回调（spec D4）', () => {
  // 每例自建一个带第四参的 app（既有 app 是三参，不关心回调）
  const withCallback = async (): Promise<{ cb: ReturnType<typeof vi.fn>; a: FastifyInstance }> => {
    const cb = vi.fn();
    const a = Fastify();
    registerSettingsRoutes(a, db, defaultDir, cb);
    await a.ready();
    return { cb, a };
  };

  it('PUT 并发数成功 → 回调恰好被调用一次', async () => {
    const { cb, a } = await withCallback();
    const r = await a.inject({ method: 'PUT', url: '/api/settings', payload: { max_concurrent_downloads: '2' } });
    expect(r.statusCode).toBe(200);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('只改间隔/限速（无并发键）→ 不调用回调', async () => {
    const { cb, a } = await withCallback();
    await a.inject({ method: 'PUT', url: '/api/settings', payload: { download_sleep_seconds: '3' } });
    await a.inject({ method: 'PUT', url: '/api/settings', payload: { download_limit_rate: '500K' } });
    expect(cb).not.toHaveBeenCalled();
  });
  it('并发数非法（400）→ 不调用回调（先校验后写库，没落库就不该催队列）', async () => {
    const { cb, a } = await withCallback();
    const r = await a.inject({ method: 'PUT', url: '/api/settings', payload: { max_concurrent_downloads: '9' } });
    expect(r.statusCode).toBe(400);
    expect(cb).not.toHaveBeenCalled();
  });
});
